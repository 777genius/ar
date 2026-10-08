#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/fs.h>
#include <linux/loop.h>
#include <linux/magic.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/quota.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>

/* Root-only installed backend. FDs3/4/5 are registered scratch/control/block;
 * FD6 is the authenticated executable. No payload CLI/path/cleanup endpoint.
 * One holder owns flock + ledger publication + physical operations. EOF closes
 * pins/lock but never removes image, mount, state, claims or interrupted intent. */
#define MAX_LEDGER (4U * 1024 * 1024)
#define MAINTENANCE_BYTES (64ULL * 1024 * 1024)
#define ROOT_FLOOR_BYTES UINT64_C(5368709120)
#define ROOT_PUBLICATION_BYTES UINT64_C(33554432)
#define SCRATCH 3
#define CONTROL 4
#define BLOCK 5
static int fence = -1;
static struct stat scratch_st, control_st, fence_st;
static uint64_t sequence;
static void fail(const char *kind);
static uint64_t multiply(uint64_t a, uint64_t b);
static int pins[4096];
static size_t pin_count;
static void pin(int fd) {
  if (pin_count >= sizeof(pins)/sizeof(pins[0])) { errno=EMFILE; fail("exhausted"); }
  pins[pin_count++]=fd;
}
static const char *phase = "startup";
static void fail(const char *kind) {
  int saved = errno; printf("ERROR1 %s %d\n", kind, saved); fflush(stdout);
  fprintf(stderr, "bounded-storage:%s:%s:%d\n", phase, kind, saved); exit(2);
}
static void require(bool yes, const char *kind) { if (!yes) { errno = EINVAL; fail(kind); } }
static void ok(int rc) { if (rc < 0) fail("uncertain"); }
static void all_write(int fd, const void *data, size_t length) {
  const unsigned char *p = data;
  while (length) { ssize_t n = write(fd, p, length); if (n < 0 && errno == EINTR) continue; require(n > 0, "uncertain"); p += n; length -= (size_t)n; }
}
static void all_read(int fd, void *data, size_t length) {
  unsigned char *p = data;
  while (length) { ssize_t n = read(fd, p, length); if (n < 0 && errno == EINTR) continue; require(n > 0, "uncertain"); p += n; length -= (size_t)n; }
}
static bool hex(const char *s, size_t length) {
  if (strlen(s) != length) return false;
  for (size_t i = 0; i < length; i++) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  return true;
}
static bool uuid(const char *s) {
  if (strlen(s) != 36) return false;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
    else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
  }
  return true;
}
static uint64_t number(const char *s) {
  require(*s >= '0' && *s <= '9' && (*s != '0' || s[1] == '\0'), "invalid");
  char *end = NULL; errno = 0; unsigned long long n = strtoull(s, &end, 10);
  require(errno == 0 && end && *end == '\0', "invalid"); return (uint64_t)n;
}
static void private_file(int fd, dev_t dev) {
  struct stat s; ok(fstat(fd, &s)); require(S_ISREG(s.st_mode) && s.st_uid == 0 && s.st_gid == 0 &&
    (s.st_mode & 07777) == 0600 && s.st_dev == dev && s.st_nlink == 1, "identity");
}
static void root_headroom(void) {
  struct statvfs v;ok(fstatvfs(CONTROL,&v));require(v.f_frsize>0 && v.f_frsize<=65536,"unsupported");
  require(multiply(v.f_bavail,v.f_frsize)>=ROOT_FLOOR_BYTES+ROOT_PUBLICATION_BYTES,"capacity");
}
static void held(void) {
  struct stat a, b, c; ok(fstat(fence, &a)); ok(fstatat(CONTROL, "bounded-storage.fence", &b, AT_SYMLINK_NOFOLLOW)); ok(fstat(CONTROL, &c));
  private_file(fence, control_st.st_dev);
  require(a.st_ino == fence_st.st_ino && b.st_ino == a.st_ino && b.st_dev == a.st_dev &&
    c.st_ino == control_st.st_ino && c.st_dev == control_st.st_dev && (c.st_mode & 07777) == 0700, "identity");
}
static char *read_leaf(const char *name, size_t *length, bool missing) {
  held(); int fd = openat(CONTROL, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 && errno == ENOENT && missing) { *length = 0; return NULL; } ok(fd); private_file(fd, control_st.st_dev);
  struct stat before, after; ok(fstat(fd, &before)); require(before.st_size > 0 && before.st_size <= MAX_LEDGER, "unsafe_control");
  *length = (size_t)before.st_size; char *data = malloc(*length); require(data != NULL, "uncertain"); all_read(fd, data, *length);
  char extra; require(read(fd, &extra, 1) == 0, "identity"); ok(fstat(fd, &after));
  require(before.st_ino == after.st_ino && before.st_size == after.st_size && before.st_mtim.tv_sec == after.st_mtim.tv_sec &&
    before.st_mtim.tv_nsec == after.st_mtim.tv_nsec && before.st_ctim.tv_sec == after.st_ctim.tv_sec && before.st_ctim.tv_nsec == after.st_ctim.tv_nsec, "identity");
  close(fd); return data;
}
static bool exists(int root, const char *name) {
  struct stat s; int rc = fstatat(root, name, &s, AT_SYMLINK_NOFOLLOW); if (rc == 0) return true;
  require(errno == ENOENT, "identity"); return false;
}
static void no_intent(void) { require(!exists(CONTROL, "bounded-storage.intent"), "uncertain"); }
static void registered_generations(void) {
  /* Bound only our registered root, never enumerate foreign scratch. A lost
   * ledger/new control root cannot turn old images into uncharged capacity. */
  if(!exists(SCRATCH,".bounded-storage"))return;
  int root=openat(SCRATCH,".bounded-storage",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(root);
  struct stat s;ok(fstat(root,&s));require(s.st_uid==0 && s.st_gid==0 && (s.st_mode&07777)==0700 && s.st_dev==scratch_st.st_dev,"identity");
  DIR *entries=fdopendir(root);require(entries!=NULL,"uncertain");size_t length,count=0;char *ledger=read_leaf("bounded-storage-ledger.json",&length,true);
  struct dirent *entry;errno=0;
  while((entry=readdir(entries))!=NULL){
    if(strcmp(entry->d_name,".")==0 || strcmp(entry->d_name,"..")==0)continue;
    require(++count<=1024 && uuid(entry->d_name) && ledger!=NULL,"uncertain");
    char marker[64];int n=snprintf(marker,sizeof(marker),"\"generationId\":\"%s\"",entry->d_name);
    require(n>0 && (size_t)n<sizeof(marker) && memmem(ledger,length,marker,(size_t)n)!=NULL,"uncertain");
    struct stat child;ok(fstatat(root,entry->d_name,&child,AT_SYMLINK_NOFOLLOW));require(S_ISDIR(child.st_mode) && child.st_uid==0 && child.st_gid==0 && (child.st_mode&07777)==0700 && child.st_dev==scratch_st.st_dev,"identity");
    errno=0;
  }
  require(errno==0,"uncertain");free(ledger);closedir(entries);
}
static void publish(size_t old_length, size_t new_length) {
  held(); no_intent(); require(old_length <= MAX_LEDGER && new_length > 0 && new_length <= MAX_LEDGER, "invalid");
  char *expected = malloc(old_length ? old_length : 1), *next = malloc(new_length); require(expected && next, "uncertain");
  all_read(STDIN_FILENO, expected, old_length); all_read(STDIN_FILENO, next, new_length);
  size_t actual_length; char *actual = read_leaf("bounded-storage-ledger.json", &actual_length, true);
  require(actual_length == old_length && (old_length == 0 || memcmp(actual, expected, old_length) == 0), "conflict"); free(actual); free(expected);
  root_headroom();
  char temporary[96]; int n = snprintf(temporary, sizeof(temporary), "bounded-ledger-%ld-%" PRIu64 ".pending", (long)getpid(), ++sequence);
  require(n > 0 && (size_t)n < sizeof(temporary), "invalid");
  int intent = openat(CONTROL, "bounded-storage.intent", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600); ok(intent);
  private_file(intent, control_st.st_dev); all_write(intent, temporary, strlen(temporary)); ok(fsync(intent)); close(intent); ok(fsync(CONTROL));
  int fd = openat(CONTROL, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600); ok(fd); private_file(fd, control_st.st_dev);
  all_write(fd, next, new_length); ok(fsync(fd)); close(fd); free(next); held();
  ok(renameat(CONTROL, temporary, CONTROL, "bounded-storage-ledger.json")); ok(fsync(CONTROL)); held();
  ok(unlinkat(CONTROL, "bounded-storage.intent", 0)); ok(fsync(CONTROL)); puts("OK1"); fflush(stdout);
}
static void text_file(const char *path, char *data, size_t size) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); ok(fd); ssize_t n = read(fd, data, size - 1); require(n > 0 && (size_t)n < size - 1, "identity");
  data[n] = '\0'; if (data[n - 1] == '\n') data[n - 1] = '\0'; close(fd);
}
static void uuid_text(const unsigned char *p, char *text) {
  snprintf(text, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", p[0],p[1],p[2],p[3],p[4],p[5],p[6],p[7],p[8],p[9],p[10],p[11],p[12],p[13],p[14],p[15]);
}
static void super_uuid(int fd, char *text, bool project) {
  unsigned char data[1024]; require(pread(fd, data, sizeof(data), 1024) == (ssize_t)sizeof(data), "identity");
  require(data[0x38] == 0x53 && data[0x39] == 0xef, "unsupported");
  if (project) { uint32_t ro=(uint32_t)data[0x64] | (uint32_t)data[0x65]<<8 | (uint32_t)data[0x66]<<16 | (uint32_t)data[0x67]<<24; require((ro & 0x2100U) == 0x2100U, "unsupported"); }
  uuid_text(data + 0x68, text);
}
static uint64_t multiply(uint64_t a, uint64_t b) { require(!a || b <= UINT64_MAX / a, "invalid"); return a * b; }
static void capacity(void) {
  held(); struct statvfs s, c; ok(fstatvfs(SCRATCH, &s)); ok(fstatvfs(CONTROL, &c));
  printf("CAP1 %" PRIu64 " %" PRIu64 " %" PRIu64 "\n", multiply(s.f_bavail,s.f_frsize), (uint64_t)s.f_favail, multiply(c.f_bavail,c.f_frsize)); fflush(stdout);
}
static void private_scratch_mount(void) {
  struct statx s;ok((int)syscall(SYS_statx,SCRATCH,"",AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,STATX_MNT_ID,&s));require(s.stx_mask & STATX_MNT_ID,"unsupported");
  FILE *info=fopen("/proc/self/mountinfo","re");require(info!=NULL,"unsupported");char line[4096];size_t total=0;bool found=false;
  while(fgets(line,sizeof(line),info)){size_t length=strlen(line);total+=length;require(total<=2U*1024*1024 && strchr(line,'\n')!=NULL,"unsupported");
    char *end;errno=0;uint64_t id=strtoull(line,&end,10);require(errno==0 && end!=line && *end==' ',"identity");
    if(id!=s.stx_mnt_id)continue;
    char *separator=strstr(line," - ");require(separator!=NULL,"identity");*separator='\0';
    require(strstr(line," shared:")==NULL && strstr(line," master:")==NULL && strstr(line," propagate_from:")==NULL,"unsupported");found=true;break;
  }
  require(!ferror(info) && found,"unsupported");fclose(info);
}

enum native_phase { N_INTENT = 1, N_IMAGE = 2, N_LOOP = 3, N_FORMAT = 4, N_MOUNT = 5, N_PREPARED = 6 };
struct image_state {
  uint64_t magic; uint32_t version, phase, project, loop;
  char generation[37], operation[37], request_digest[65], inner_uuid[37];
  uint64_t q_bytes, q_inodes, physical, backing_dev, backing_ino;
  uint64_t payload_dev, payload_ino, mount_id, namespace_ino;
};
#define STATE_MAGIC UINT64_C(0x31424e4154495645)
static void state_name(const char *generation, char *name) { require(uuid(generation), "invalid"); snprintf(name, 64, "%s.native", generation); }
static void state_write(const struct image_state *state, bool initial) {
  held();root_headroom();char name[64], temporary[80]; state_name(state->generation, name);
  snprintf(temporary, sizeof(temporary), "%s.pending", name);
  int fd = openat(CONTROL, initial ? name : temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600); ok(fd); private_file(fd,control_st.st_dev);
  all_write(fd, state, sizeof(*state)); ok(fsync(fd)); close(fd);
  if (!initial) { ok(renameat(CONTROL, temporary, CONTROL, name)); }
  ok(fsync(CONTROL));
}
static bool state_read(const char *generation, struct image_state *state) {
  char name[64]; state_name(generation, name); size_t length; char *data = read_leaf(name, &length, true);
  if (!data) { return false; }
  require(length == sizeof(*state), "identity"); memcpy(state,data,length);free(data);
  require(state->magic == STATE_MAGIC && state->version == 1 && memcmp(state->generation,generation,37) == 0 &&
    uuid(state->operation) && hex(state->request_digest,64) && uuid(state->inner_uuid) && state->phase >= N_INTENT && state->phase <= N_PREPARED, "identity"); return true;
}
static int private_dir(int parent, const char *name, bool create, dev_t device) {
  if (create) { ok(mkdirat(parent,name,0700)); }
  int fd = openat(parent,name,O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); ok(fd);
  struct stat s;ok(fstat(fd,&s));require(S_ISDIR(s.st_mode) && s.st_uid == 0 && s.st_gid == 0 && (s.st_mode & 07777) == 0700 && s.st_dev == device,"identity"); return fd;
}
static int generation_dir(const char *generation, bool create) {
  if (!exists(SCRATCH,".bounded-storage")) { require(create,"identity"); ok(mkdirat(SCRATCH,".bounded-storage",0700)); ok(fsync(SCRATCH)); }
  int root = private_dir(SCRATCH,".bounded-storage",false,scratch_st.st_dev), fd = private_dir(root,generation,create,scratch_st.st_dev);
  if (create) { ok(fsync(root)); }
  close(root); return fd;
}
static void image_check(int fd, const struct image_state *state) {
  private_file(fd,scratch_st.st_dev);struct stat s;ok(fstat(fd,&s));
  require((uint64_t)s.st_dev == state->backing_dev && (uint64_t)s.st_ino == state->backing_ino && (uint64_t)s.st_size == state->physical &&
    multiply((uint64_t)s.st_blocks,512) >= state->physical,"identity");
}
static int loop_open(uint32_t number_) {
  char name[64];snprintf(name,sizeof(name),"/dev/loop%u",number_);int fd = open(name,O_RDWR | O_NOFOLLOW | O_CLOEXEC);ok(fd);
  struct stat s;ok(fstat(fd,&s));require(S_ISBLK(s.st_mode) && major(s.st_rdev) == 7 && minor(s.st_rdev) == number_ && s.st_uid == 0,"identity");return fd;
}
static void loop_check(int fd,const struct image_state *state) {
  struct loop_info64 info = {0};ok(ioctl(fd,LOOP_GET_STATUS64,&info));uint64_t length = 0;ok(ioctl(fd,BLKGETSIZE64,&length));
  require(info.lo_device == state->backing_dev && info.lo_inode == state->backing_ino && info.lo_offset == 0 && info.lo_sizelimit == state->physical &&
    !(info.lo_flags & (LO_FLAGS_READ_ONLY | LO_FLAGS_AUTOCLEAR)) && length == state->physical,"identity");
}
static struct dqblk quota_get(int fd,uint32_t project) {
  struct dqblk q = {0};ok((int)syscall(SYS_quotactl_fd,fd,QCMD(Q_GETQUOTA,PRJQUOTA),project,&q));return q;
}
static struct fsxattr attributes(int fd) { struct fsxattr a = {0};ok(ioctl(fd,FS_IOC_FSGETXATTR,&a));return a; }
static void quota_check(int fs,const struct image_state *state,struct dqblk *q) {
  uint32_t format = 0;ok((int)syscall(SYS_quotactl_fd,fs,QCMD(Q_GETFMT,PRJQUOTA),0,&format));require(format != 0,"unsupported");
  *q = quota_get(fs,state->project);require(q->dqb_bhardlimit == state->q_bytes / 1024 && q->dqb_ihardlimit == state->q_inodes &&
    !q->dqb_bsoftlimit && !q->dqb_isoftlimit && q->dqb_curspace <= state->q_bytes && q->dqb_curinodes <= state->q_inodes,"identity");
}
static void root_identity(int payload,struct image_state *state,bool set) {
  struct stat s,ns;ok(fstat(payload,&s));ok(stat("/proc/self/ns/mnt",&ns));struct statx sx;
  ok((int)syscall(SYS_statx,payload,"",AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,STATX_MNT_ID,&sx));require(sx.stx_mask & STATX_MNT_ID,"unsupported");
  require(major(s.st_dev) == 7 && minor(s.st_dev) == state->loop,"identity");
  if (set) { state->payload_dev=s.st_dev;state->payload_ino=s.st_ino;state->mount_id=sx.stx_mnt_id;state->namespace_ino=ns.st_ino; }
  else require((uint64_t)s.st_dev==state->payload_dev && (uint64_t)s.st_ino==state->payload_ino && sx.stx_mnt_id==state->mount_id && (uint64_t)ns.st_ino==state->namespace_ino,"identity");
  struct fsxattr a=attributes(payload);require(a.fsx_projid==state->project && (a.fsx_xflags & FS_XFLAG_PROJINHERIT),"identity");
}
static void facts(int image,int fs,int payload,int loop,struct image_state *state,bool first) {
  held();image_check(image,state);loop_check(loop,state);char inner[37];super_uuid(loop,inner,true);require(strcmp(inner,state->inner_uuid)==0,"identity");
  root_identity(payload,state,first);struct dqblk q;quota_check(fs,state,&q);struct statvfs v;ok(fstatvfs(fs,&v));
  uint64_t free_bytes=multiply(v.f_bavail,v.f_frsize);require(free_bytes>=MAINTENANCE_BYTES && UINT64_MAX-q.dqb_curspace>=free_bytes,"identity");
  uint64_t reachable=free_bytes+q.dqb_curspace-MAINTENANCE_BYTES;require(reachable>=state->q_bytes && (uint64_t)v.f_favail+q.dqb_curinodes>=state->q_inodes,"geometry");
  struct stat s,loop_st;ok(fstat(image,&s));ok(fstat(loop,&loop_st));
  printf("FACT1 %s %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %s %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %u %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
    state->request_digest,state->backing_dev,state->backing_ino,state->physical,multiply((uint64_t)s.st_blocks,512),(uint64_t)loop_st.st_rdev,state->inner_uuid,
    state->payload_dev,state->payload_ino,state->mount_id,state->namespace_ino,state->project,state->q_bytes,state->q_inodes,
    (uint64_t)q.dqb_curspace,(uint64_t)q.dqb_curinodes,reachable,(uint64_t)v.f_favail+q.dqb_curinodes);fflush(stdout);
}
static int executable(const char *path) {
  char *canonical=realpath(path,NULL);require(canonical!=NULL,"unsupported");
  char current[PATH_MAX];require(strlen(canonical)<sizeof(current),"identity");strcpy(current,canonical);
  for (;;) { struct stat s;ok(lstat(current,&s));require(s.st_uid==0 && !(s.st_mode & 0022) && !S_ISLNK(s.st_mode),"identity");
    if(strcmp(current,"/")==0)break;
    char *slash=strrchr(current,'/');require(slash!=NULL,"identity");if(slash==current)current[1]='\0';else *slash='\0'; }
  int fd=open(canonical,O_RDONLY | O_NOFOLLOW | O_CLOEXEC);free(canonical);ok(fd);struct stat s;ok(fstat(fd,&s));
  require(S_ISREG(s.st_mode) && s.st_nlink==1 && !(s.st_mode & 06000),"identity");char magic[4];require(pread(fd,magic,4,0)==4 && memcmp(magic,"\177ELF",4)==0,"identity");return fd;
}
static void format(int generation,int loop,const struct image_state *state) {
  int tool=executable("/usr/sbin/mke2fs");char path[64],count[32],tmp[64];snprintf(path,sizeof(path),"/proc/self/fd/%d",loop);
  snprintf(count,sizeof(count),"%" PRIu64,state->q_inodes+1024);snprintf(tmp,sizeof(tmp),"TMPDIR=/proc/self/fd/%d",generation);
  char *const args[]={"mke2fs","-q","-t","ext4","-b","4096","-I","256","-N",count,"-m","0","-U",(char*)state->inner_uuid,
    "-O","quota,project","-E","quotatype=prjquota,nodiscard,lazy_itable_init=0,lazy_journal_init=0","-J","size=64",path,NULL};
  pid_t parent=getpid(), child=fork();ok(child);
  if(child==0) { ok(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0));require(getppid()==parent,"uncertain");ok(fchdir(generation));
    ok(fcntl(loop,F_SETFD,0));ok(fcntl(generation,F_SETFD,0));
    int null=open("/dev/null",O_RDONLY | O_NOFOLLOW | O_CLOEXEC);ok(null);struct stat null_st;ok(fstat(null,&null_st));require(S_ISCHR(null_st.st_mode) && null_st.st_rdev==makedev(1,3),"identity");ok(dup2(null,STDIN_FILENO));close(null);ok(dup2(STDERR_FILENO,STDOUT_FILENO));
    for(int fd=3;fd<4096;fd++)if(fd!=tool && fd!=loop && fd!=generation)close(fd);
    char *const environment[]={"PATH=/usr/sbin:/usr/bin:/bin","LC_ALL=C",tmp,"HOME=/nonexistent",NULL};fexecve(tool,args,environment);fail("unsupported"); }
  int status;require(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0,"uncertain");close(tool);
}
static void prepare(char **a,size_t n) {
  require(n==9 && uuid(a[1]) && uuid(a[2]) && hex(a[3],64),"invalid");held();no_intent();private_scratch_mount();phase="prepare";
  struct image_state state={.magic=STATE_MAGIC,.version=1,.phase=N_INTENT};strcpy(state.generation,a[1]);strcpy(state.operation,a[2]);strcpy(state.request_digest,a[3]);
  uint64_t project=number(a[4]);require(project>0 && project<=UINT32_MAX,"invalid");state.project=(uint32_t)project;
  state.q_bytes=number(a[5]);state.q_inodes=number(a[6]);state.physical=number(a[7]);require(number(a[8])==0,"unsupported");
  require(state.q_bytes>0 && state.q_bytes%1024==0 && state.q_inodes>8 && state.q_inodes<=0xffff0000U &&
    state.physical>state.q_bytes && state.physical%4096==0 && state.physical<=INT64_MAX,"invalid");
  size_t ledger_length;char *ledger=read_leaf("bounded-storage-ledger.json",&ledger_length,false);
  char marker[160];int marker_length=snprintf(marker,sizeof(marker),"\"requestSha256\":\"%s\",\"revision\":1,\"phase\":\"pending\",\"facts\":null",state.request_digest);
  require(marker_length>0 && (size_t)marker_length<sizeof(marker) && memmem(ledger,ledger_length,marker,(size_t)marker_length)!=NULL,"conflict");free(ledger);
  require(access("/sys/module/quota_v2",F_OK)==0,"unsupported");text_file("/proc/sys/kernel/random/uuid",state.inner_uuid,sizeof(state.inner_uuid));require(uuid(state.inner_uuid),"identity");
  struct image_state prior;require(!state_read(state.generation,&prior),"conflict");state_write(&state,true);
  int generation=generation_dir(state.generation,true);int image=openat(generation,"backing.ext4",O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);ok(image);
  private_file(image,scratch_st.st_dev);struct stat image_st;ok(fstat(image,&image_st));state.backing_dev=image_st.st_dev;state.backing_ino=image_st.st_ino;state.phase=N_IMAGE;state_write(&state,false);
  int allocation=posix_fallocate(image,0,(off_t)state.physical);if(allocation){errno=allocation;fail("uncertain");}ok(fsync(image));ok(fsync(generation));image_check(image,&state);
  int control=open("/dev/loop-control",O_RDWR | O_NOFOLLOW | O_CLOEXEC);ok(control);int number_=ioctl(control,LOOP_CTL_GET_FREE);ok(number_);close(control);
  state.loop=(uint32_t)number_;state.phase=N_LOOP;state_write(&state,false);int loop=loop_open(state.loop);
  struct loop_config config={.fd=(uint32_t)image,.block_size=4096};config.info.lo_sizelimit=state.physical;ok(ioctl(loop,LOOP_CONFIGURE,&config));loop_check(loop,&state);
  format(generation,loop,&state);allocation=posix_fallocate(image,0,(off_t)state.physical);if(allocation){errno=allocation;fail("uncertain");}ok(fsync(image));image_check(image,&state);state.phase=N_FORMAT;state_write(&state,false);
  int lower=private_dir(generation,"mount",true,scratch_st.st_dev);char loop_path[64],mount_path[64];snprintf(loop_path,sizeof(loop_path),"/proc/self/fd/%d",loop);snprintf(mount_path,sizeof(mount_path),"/proc/self/fd/%d",lower);
  ok(mount(loop_path,mount_path,"ext4",MS_NOSUID | MS_NODEV | MS_NOATIME,"prjquota,nodiscard"));close(lower);
  int fs=openat(generation,"mount",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(fs);state.phase=N_MOUNT;state_write(&state,false);
  struct dqblk initial=quota_get(fs,state.project);require(initial.dqb_curspace==0 && initial.dqb_curinodes==0,"identity");
  struct dqblk limits={.dqb_bhardlimit=state.q_bytes/1024,.dqb_ihardlimit=state.q_inodes,.dqb_valid=QIF_LIMITS};
  ok((int)syscall(SYS_quotactl_fd,fs,QCMD(Q_SETQUOTA,PRJQUOTA),state.project,&limits));quota_check(fs,&state,&limits);
  ok(mkdirat(fs,"payload",0700));int payload=openat(fs,"payload",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(payload);
  struct fsxattr attributes_=attributes(payload);attributes_.fsx_projid=state.project;attributes_.fsx_xflags|=FS_XFLAG_PROJINHERIT;ok(ioctl(payload,FS_IOC_FSSETXATTR,&attributes_));
  const char *leaves[]={"workspace","state","home","tmp","logs","output","evidence"};
  for(size_t i=0;i<sizeof(leaves)/sizeof(leaves[0]);i++){ok(mkdirat(payload,leaves[i],0700));int leaf=openat(payload,leaves[i],O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(leaf);
    struct fsxattr x=attributes(leaf);require(x.fsx_projid==state.project && (x.fsx_xflags & FS_XFLAG_PROJINHERIT),"identity");ok(fsync(leaf));close(leaf);}
  ok(fsync(payload));ok(fsync(fs));ok((int)syscall(SYS_quotactl_fd,fs,QCMD(Q_SYNC,PRJQUOTA),0,NULL));
  root_identity(payload,&state,true);state.phase=N_PREPARED;state_write(&state,false);facts(image,fs,payload,loop,&state,false);
  /* Own mounting superblock and backing are kernel-retained. Do not detach or
   * auto-clear on EOF; registered state survives for exact reconciliation. */
  close(generation);pin(image);pin(fs);pin(payload);pin(loop);
}
static void inspect(char **a,size_t n) {
  require(n==4 && uuid(a[1]) && uuid(a[2]) && hex(a[3],64),"invalid");held();phase="inspect";struct image_state state;
  if(!state_read(a[1],&state)){
    if(exists(SCRATCH,".bounded-storage")){int directory=private_dir(SCRATCH,".bounded-storage",false,scratch_st.st_dev);require(!exists(directory,a[1]),"identity");close(directory);}
    puts("ABSENT1");fflush(stdout);return;
  }
  require(strcmp(state.operation,a[2])==0 && strcmp(state.request_digest,a[3])==0,"conflict");
  if(state.phase!=N_PREPARED){puts("PARTIAL1");fflush(stdout);return;}
  int generation=generation_dir(state.generation,false),image=openat(generation,"backing.ext4",O_RDONLY | O_NOFOLLOW | O_CLOEXEC);ok(image);
  int loop=loop_open(state.loop),fs=openat(generation,"mount",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(fs);
  int payload=openat(fs,"payload",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(payload);facts(image,fs,payload,loop,&state,false);
  pin(payload);pin(fs);pin(loop);pin(image);close(generation);
}
int main(int argc,char **argv) {
  require(argc==4 && strcmp(argv[1],"--registered-fd-session-v1")==0 && hex(argv[2],32) && uuid(argv[3]),"invalid");
  require(getuid()==0 && geteuid()==0 && getgid()==0 && getegid()==0,"identity");umask(077);setvbuf(stdout,NULL,_IONBF,0);setvbuf(stdin,NULL,_IONBF,0);
  pid_t parent=getppid();ok(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0));require(getppid()==parent && parent>1,"identity");
  struct stat user;ok(stat("/proc/self/ns/user",&user));require(user.st_ino==4026531837ULL,"unsupported");
  ok(fstat(SCRATCH,&scratch_st));ok(fstat(CONTROL,&control_st));struct stat block;ok(fstat(BLOCK,&block));
  require(S_ISDIR(scratch_st.st_mode) && S_ISDIR(control_st.st_mode) && scratch_st.st_uid==0 && scratch_st.st_gid==0 && !(scratch_st.st_mode&0022) &&
    control_st.st_uid==0 && control_st.st_gid==0 && (control_st.st_mode&07777)==0700 && scratch_st.st_dev!=control_st.st_dev &&
    S_ISBLK(block.st_mode) && block.st_rdev==scratch_st.st_dev,"identity");
  struct stat root;ok(stat("/",&root));require(root.st_dev!=scratch_st.st_dev && root.st_dev==control_st.st_dev,"identity");struct statfs fs;ok(fstatfs(SCRATCH,&fs));require(fs.f_type==EXT4_SUPER_MAGIC,"unsupported");
  char machine[64],boot[64],filesystem[37];text_file("/etc/machine-id",machine,sizeof(machine));text_file("/proc/sys/kernel/random/boot_id",boot,sizeof(boot));super_uuid(BLOCK,filesystem,false);
  require(strcmp(machine,argv[2])==0 && strcmp(filesystem,argv[3])==0 && uuid(boot),"identity");
  require(!exists(CONTROL,"filesystem-exposure.json"),"conflict"); /* Never compete with prototype authority. */
  fence=openat(CONTROL,"bounded-storage.fence",O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  if(fence<0 && errno==ENOENT){root_headroom();fence=openat(CONTROL,"bounded-storage.fence",O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);
    if(fence<0 && errno==EEXIST)fence=openat(CONTROL,"bounded-storage.fence",O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    ok(fence);ok(fsync(CONTROL));}
  ok(fence);private_file(fence,control_st.st_dev);ok(fstat(fence,&fence_st));
  ok(flock(fence,LOCK_EX));held();no_intent();registered_generations();
  printf("READY1 %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %s %s %s\n",(uint64_t)fence_st.st_dev,(uint64_t)fence_st.st_ino,(uint64_t)scratch_st.st_dev,(uint64_t)control_st.st_dev,machine,filesystem,boot);
  char line[1024];
  while(fgets(line,sizeof(line),stdin)){require(strchr(line,'\n')!=NULL,"invalid");char *a[16],*save=NULL;size_t n=0;
    for(char *token=strtok_r(line," \n",&save);token;token=strtok_r(NULL," \n",&save)){require(n<16,"invalid");a[n++]=token;}
    require(n>0,"invalid");held();
    if(strcmp(a[0],"ASSERT")==0){require(n==1,"invalid");puts("OK1");}
    else if(strcmp(a[0],"CAPABILITY")==0){require(n==1,"invalid");private_scratch_mount();require(access("/sys/module/quota_v2",F_OK)==0 && access("/sys/module/loop",F_OK)==0,"unsupported");int tool=executable("/usr/sbin/mke2fs");close(tool);
      int loop_control=open("/dev/loop-control",O_RDWR | O_NOFOLLOW | O_CLOEXEC);ok(loop_control);struct stat s;ok(fstat(loop_control,&s));require(S_ISCHR(s.st_mode) && s.st_uid==0,"identity");close(loop_control);
      uint32_t format=0;errno=0;long rc=syscall(SYS_quotactl_fd,CONTROL,QCMD(Q_GETFMT,PRJQUOTA),0,&format);require(rc>=0 || (errno!=ENOSYS && errno!=EPERM),"unsupported");puts("CAPABLE1");}
    else if(strcmp(a[0],"CAPACITY")==0){require(n==1,"invalid");capacity();}
    else if(strcmp(a[0],"READ")==0){require(n==1,"invalid");no_intent();size_t length;char *bytes=read_leaf("bounded-storage-ledger.json",&length,true);printf("LEDGER1 %zu\n",length);if(bytes){all_write(STDOUT_FILENO,bytes,length);free(bytes);}all_write(STDOUT_FILENO,"\n",1);}
    else if(strcmp(a[0],"PUBLISH")==0){require(n==3,"invalid");publish((size_t)number(a[1]),(size_t)number(a[2]));}
    else if(strcmp(a[0],"PREPARE")==0)prepare(a,n);
    else if(strcmp(a[0],"INSPECT")==0)inspect(a,n);
    else require(false,"invalid");
    fflush(stdout);
  }
  require(feof(stdin),"uncertain");for(size_t i=0;i<pin_count;i++)close(pins[i]);return 0;
}
