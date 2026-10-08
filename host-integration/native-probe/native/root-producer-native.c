#define _GNU_SOURCE
#include "root-producer-native.h"
#include "root-managed-launch.h"
#include "original-owner.h"
#include "native-root-control.h"
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/nsfs.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#define ROW_BYTES 296
#define SNAP_BYTES 384
#define PHASE_HEADER 24
#define OBS (2 * NP_ORIGIN_SECOND)
#define JOIN_MARGIN (5 * NP_ORIGIN_SECOND)
struct np_admin_operation {
  unsigned char record[512 + NP_ORIGIN_FILES * ROW_BYTES];
  size_t length;
  unsigned files;
  pid_t observer;
  struct np_birth parent;
  struct np_directory directory;
  uint64_t enclosing_anchor, work, cleanup, cold;
  char job[33], machine[33], boot[37], operation[65], installation[65], profile[65], manifest[65];
}
;
struct shared_origin {
  pthread_mutex_t lock;
  struct np_origin_ends ends;
  _Atomic uint64_t high_water, attempt_end;
  _Atomic bool closed, broken;
   bool slots[NP_ORIGIN_EFFECTS];
}
;
struct np_origin_child {
  struct np_root_origin *origin;
  pid_t role;
  int parent_pidfd, endpoint, closure[3];
  struct np_clock clock;
}
;
struct np_root_origin {
  struct np_admin_operation *admin;
  struct shared_origin *shared;
  struct np_clock clock;
  int boot, self_pidfd, children_ns, pid_ns, channel[2], pipes[2][2], listener;
  pid_t principal, child;
  int child_pidfd, child_ns[4];
  struct np_origin_child branch;
  struct np_managed_original *managed;
  unsigned char snapshot[SNAP_BYTES];
  char digest[65], allocation[NP_ORIGIN_PHASE_MAX], unit[96];
  size_t allocation_size;
  uint64_t phase_end;
  bool snapshot_sent, frozen, intent, child_wait, eof[2], helper_wait, child_ready, stopped, namespace_changed;
  struct np_origin_ends cleanup_ends;
  uint64_t cleanup_high_water, cleanup_attempt_end;
  bool cleanup_started, cleanup_uncertain, cleanup_effect, cleanup_slots[NP_ORIGIN_EFFECTS];
  uint64_t sequence[2];
  unsigned child_state, journal_count;
  bool journal_failed;
}
;
static struct np_root_origin *sole;
static bool operation_consumed;
static uint64_t get64(const unsigned char *p) {
  uint64_t n = 0;
  for (unsigned i = 0; i < 8; i++) n = (n << 8) | p[i];
  return n;
}
static void put64(unsigned char *p, uint64_t n) {
  for (unsigned i = 0; i < 8; i++) p[7-i] = (unsigned char)(n >> (8*i));
}
static uint64_t minimum(uint64_t a, uint64_t b) {
  return a < b ? a : b;
}
static int monotonic(uint64_t *out) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t) || t.tv_sec < 0 || t.tv_nsec < 0 || t.tv_nsec >= 1000000000 || (uint64_t)t.tv_sec > (uint64_t)INT64_MAX / NP_ORIGIN_SECOND) {
    return -1;
  }
  *out = (uint64_t)t.tv_sec * NP_ORIGIN_SECOND + (uint64_t)t.tv_nsec;
  return *out > INT64_MAX ? -1 : 0;
}
static int same_fd(int a, int b) {
  struct stat x,y;
  return fstat(a,&x) || fstat(b,&y) || x.st_dev != y.st_dev || x.st_ino != y.st_ino ? -1 : 0;
}
static int live(int fd) {
  struct pollfd p = {
    .fd=fd,.events=POLLIN}
  ;
  return fd < 0 || poll(&p,1,0) != 0 ? -1 : 0;
}
static int current_ns(int held, const char *path, int type) {
  int fd = open(path,O_RDONLY|O_CLOEXEC);
  if (fd < 0) {
    return -1;
  }
  int result = ioctl(fd,NS_GET_NSTYPE) != type || same_fd(held,fd);
  close(fd);
  return result ? -1 : 0;
}
static int hex(const char *p, size_t n) {
  for (size_t i=0;i<n;i++) if (!((p[i]>='0'&&p[i]<='9')||(p[i]>='a'&&p[i]<='f'))) {
    return -1;
  }
  return 0;
}
static int text(char *to, size_t size, const unsigned char *from, size_t width) {
  size_t n = strnlen((const char *)from,width);
  if (!n || n >= size) {
    return -1;
  }
  memcpy(to,from,n);
  to[n]=0;
  for (size_t i=n;i<width;i++) if (from[i]) {
    return -1;
  }
  return 0;
}
static int protected_file(const char *path) {
  if (!path || *path != '/' || strstr(path,"//") || strlen(path)>=PATH_MAX) {
    return -1;
  }
  char copy[PATH_MAX];
  strcpy(copy,path);
  int directory=open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  if(directory<0){
    return -1;
  }
  char *save=NULL,*part=strtok_r(copy+1,"/",&save);
  while(part) {
    if(!strcmp(part,".")||!strcmp(part,"..")){
      close(directory);
      return -1;
    }
    char *next=strtok_r(NULL,"/",&save);
    int fd=openat(directory,part,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|(next?O_DIRECTORY:0));
    struct stat s;
    if(fd<0||fstat(fd,&s)||s.st_uid||(s.st_mode&0022)||(next?!S_ISDIR(s.st_mode):(!S_ISREG(s.st_mode)||s.st_nlink!=1))){
      if(fd>=0)close(fd);
      close(directory);
      return -1;
    }
    close(directory);
    directory=fd;
    part=next;
  }
  return directory;
}
int np_admin_operation_open_v1(struct np_admin_operation **out) {
  if(!out){
    return -1;
  }
  *out=NULL;
  if(operation_consumed||getuid()||geteuid()||getgid()||getegid()){
    return -1;
  }
  operation_consumed=true;
  DIR *tasks=opendir("/proc/self/task");
  if(!tasks)return -1;
  unsigned task_count=0;
  struct dirent *task;
  while((task=readdir(tasks)))if(task->d_name[0]!='.')task_count++;
  closedir(tasks);
  if(task_count!=1)return -1;
  struct np_admin_operation *a=calloc(1,sizeof *a);
  if(!a){
    return -1;
  }
  *out=a;
  a->parent.pidfd=a->parent.time=a->parent.children=-1;
  a->observer=getppid();
  struct stat s;
  int type;
  socklen_t size=sizeof type;
  struct ucred peer;
  size_t expected;
  if(a->observer<=1||getsockopt(3,SOL_SOCKET,SO_TYPE,&type,&size)||type!=SOCK_STREAM){
    return -1;
  }
  size=sizeof peer;
  if(getsockopt(3,SOL_SOCKET,SO_PEERCRED,&peer,&size)||peer.pid!=a->observer||peer.uid||peer.gid){
    return -1;
  }
  if(fstat(4,&s)||!S_ISREG(s.st_mode)||s.st_uid||s.st_gid||s.st_nlink!=1||(s.st_mode&0777)!=0600||s.st_size<512||s.st_size>(off_t)sizeof a->record){
    return -1;
  }
  a->length=(size_t)s.st_size;
  if(pread(4,a->record,a->length,0)!=(ssize_t)a->length||memcmp(a->record,"NPADM001",8)){
    return -1;
  }
  a->enclosing_anchor=get64(a->record+8);
  a->work=get64(a->record+16);
  a->cleanup=get64(a->record+24);
  a->cold=get64(a->record+32);
  if(get64(a->record+40)!=(uint64_t)a->observer||text(a->job,sizeof a->job,a->record+48,32)||text(a->machine,sizeof a->machine,a->record+80,32)||text(a->boot,sizeof a->boot,a->record+112,36)||text(a->operation,sizeof a->operation,a->record+148,64)||text(a->installation,sizeof a->installation,a->record+212,64)||text(a->profile,sizeof a->profile,a->record+276,64)||text(a->manifest,sizeof a->manifest,a->record+340,64)||hex(a->machine,32)||hex(a->operation,64)||hex(a->installation,64)||hex(a->profile,64)||hex(a->manifest,64)){
    return -1;
  }
  a->files=(unsigned)get64(a->record+424);
  expected=512+(size_t)a->files*ROW_BYTES;
  if(a->files<6||a->files>NP_ORIGIN_FILES||expected!=a->length||!a->enclosing_anchor||a->work<=a->enclosing_anchor||a->cleanup<=a->work||a->cleanup>INT64_MAX||a->work-a->enclosing_anchor>120*NP_ORIGIN_SECOND||a->cleanup-a->enclosing_anchor>180*NP_ORIGIN_SECOND||a->cold<=a->enclosing_anchor||a->cold>a->work||a->cold-a->enclosing_anchor>10*NP_ORIGIN_SECOND){
    return -1;
  }
  DIR *census=opendir("/proc/self/fd");
  if(!census){
    return -1;
  }
  struct dirent *entry;
  while((entry=readdir(census))){
    if(entry->d_name[0]=='.')continue;
    char *end;
    long fd=strtol(entry->d_name,&end,10);
    if(*end||fd<0||fd>INT_MAX||(fd>6+(long)a->files&&fd!=dirfd(census))){
      closedir(census);
      return -1;
    }
  }
  closedir(census);
  if(np_birth_pin_v1(&a->parent,a->observer,0,0)){
    return -1;
  }
  if(np_directory_pin_v1(&a->directory,NP_ORIGIN_ADMIN)||same_fd(6,np_directory_fd_v1(&a->directory))){
    return -1;
  }
  int record=openat(6,"bootstrap.bin",O_RDONLY|O_NOFOLLOW|O_CLOEXEC),manifest=protected_file(NP_ORIGIN_MANIFEST);
  if(record<0||manifest<0||same_fd(record,4)||same_fd(manifest,5)){
    return -1;
  }
  close(record);
  close(manifest);
  for(unsigned i=0;i<a->files;i++) {
    const unsigned char *r=a->record+512+i*ROW_BYTES;
    char path[257];
    if(text(path,sizeof path,r,256)){
      return -1;
    }
    static const char *roles[]={
      NP_ORIGIN_INSTALL "/root-producer-entry",NP_ORIGIN_IMAGE "/opt/native/node",NP_ORIGIN_IMAGE "/opt/native/original-owner-helper.mjs",NP_ORIGIN_IMAGE "/opt/native/original-owner-associated.node","/usr/bin/dbus-daemon",NP_ORIGIN_INSTALL "/admin/host-integration/native-probe/root-origin-operator.mjs"}
    ;
    if(i<6&&strcmp(path,roles[i])){
      return -1;
    }
    int named=protected_file(path);
    int fd=7+(int)i;
    if(named<0||same_fd(named,fd)||fstat(fd,&s)||!S_ISREG(s.st_mode)||s.st_uid||s.st_gid||s.st_nlink!=1||(s.st_mode&0022)||(uint64_t)s.st_dev!=get64(r+256)||(uint64_t)s.st_ino!=get64(r+264)||(uint64_t)s.st_size!=get64(r+272)||(uint64_t)(s.st_mode&07777)!=get64(r+280)){
      return -1;
    }
    close(named);
  }
  FILE *maps=fopen("/proc/self/maps","re");
  if(!maps){
    return -1;
  }
  char line[4096];
  while(fgets(line,sizeof line,maps)){
    char *path=strchr(line,'/');
    if(!path)continue;
    path[strcspn(path,"\n")]=0;
    bool admitted=false;
    for(unsigned i=0;i<a->files;i++)if(!strcmp(path,(const char *)a->record+512+i*ROW_BYTES))admitted=true;
    if(!admitted){
      fclose(maps);
      return -1;
    }
  }
  if(ferror(maps)){
    fclose(maps);
    return -1;
  }
  fclose(maps);
  /* Node stdio pipes and the declared installed files are the whole handoff. */
  int own=open("/proc/self/ns/time",O_RDONLY|O_CLOEXEC),children=open("/proc/self/ns/time_for_children",O_RDONLY|O_CLOEXEC);
  if(own<0||children<0||same_fd(own,a->parent.time)||same_fd(children,a->parent.children)||np_birth_live_v1(&a->parent)||getppid()!=a->observer){
    return -1;
  }
  close(own);
  close(children);
  uint64_t now;
  return monotonic(&now)||now<a->enclosing_anchor||now>=a->cold?-1:0;
}
int np_root_origin_begin_v1(struct np_admin_operation *a, struct np_root_origin **out) {
  uint64_t anchor;
  if(monotonic(&anchor)||!out||!a||sole){
    return -1;
  }
  *out=NULL;
  struct np_root_origin *o=calloc(1,sizeof *o);
  if(!o){
    return -1;
  }
  sole=o;
  *out=o;
  o->admin=a;
  o->principal=getpid();
  o->child=o->child_pidfd=o->listener=-1;
  o->clock.time=o->clock.children=o->clock.mount=o->boot=o->self_pidfd=o->children_ns=o->pid_ns=-1;
  for(unsigned i=0;i<2;i++){
    o->channel[i]=-1;
    for(unsigned j=0;j<2;j++)o->pipes[i][j]=-1;
  }
  for(unsigned i=0;i<4;i++)o->child_ns[i]=-1;
  if(np_birth_live_v1(&a->parent)||getppid()!=a->observer||a->cleanup<=JOIN_MARGIN){
    return -1;
  }
  o->shared=mmap(NULL,sizeof *o->shared,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  if(o->shared==MAP_FAILED){
    o->shared=NULL;
    return -1;
  }
  if(np_origin_mutex_init_v1(&o->shared->lock)){
    return -1;
  }
  struct np_origin_ends *e=&o->shared->ends;
  if(anchor>INT64_MAX-180*NP_ORIGIN_SECOND||getrandom(&e->generation,sizeof e->generation,0)!=(ssize_t)sizeof e->generation||!e->generation){
    return -1;
  }
  e->anchor=anchor;
  e->work=minimum(anchor+120*NP_ORIGIN_SECOND,a->work);
  e->cleanup=minimum(anchor+180*NP_ORIGIN_SECOND,a->cleanup-JOIN_MARGIN);
  e->cold=minimum(anchor+10*NP_ORIGIN_SECOND,minimum(a->cold,e->work));
  if(e->cold<=anchor||e->cleanup<=e->work){
    return -1;
  }
  o->cleanup_ends=*e;
  o->cleanup_high_water=anchor;
  o->shared->high_water=anchor;
  o->clock.anchor=anchor;
  o->clock.preparation_end=e->work;
  o->clock.cleanup_end=e->cleanup;
  o->clock.time=open("/proc/self/ns/time",O_RDONLY|O_CLOEXEC);
  o->clock.children=open("/proc/self/ns/time_for_children",O_RDONLY|O_CLOEXEC);
  o->clock.mount=open("/proc/self/ns/mnt",O_RDONLY|O_CLOEXEC);
  o->pid_ns=open("/proc/self/ns/pid",O_RDONLY|O_CLOEXEC);
  o->boot=open("/proc/sys/kernel/random/boot_id",O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  o->self_pidfd=(int)syscall(SYS_pidfd_open,getpid(),0);
  if(o->clock.time<0||o->clock.children<0||o->clock.mount<0||o->pid_ns<0||o->boot<0||o->self_pidfd<0){
    return -1;
  }
  int n=snprintf(o->unit,sizeof o->unit,"subscription-runtime-native-%s.scope",a->job);
  if(n<=0||(size_t)n>=sizeof o->unit){
    return -1;
  }
  uint64_t now;
  if(np_origin_now_v1(o,&now)||now>=e->cold){
    return -1;
  }
  o->phase_end=minimum(now+OBS,e->cold);
  return 0;
}
int np_origin_mutex_init_v1(pthread_mutex_t *mutex) {
  pthread_mutexattr_t attr;
  int result=pthread_mutexattr_init(&attr);
  if(result){
    return result;
  }
  result=pthread_mutexattr_setpshared(&attr,PTHREAD_PROCESS_SHARED);
  if(!result)result=pthread_mutexattr_setrobust(&attr,PTHREAD_MUTEX_ROBUST);
  if(!result)result=pthread_mutex_init(mutex,&attr);
  pthread_mutexattr_destroy(&attr);
  return result;
}
int np_origin_mutex_take_v1(pthread_mutex_t *mutex,uint64_t end) {
  uint64_t now;
  if(monotonic(&now)||now>INT64_MAX-OBS){
    return ESTALE;
  }
  uint64_t observation=minimum(end,now+OBS);
  for(;;){
    if(monotonic(&now)||now>=observation){
      return ETIMEDOUT;
    }
    int result=pthread_mutex_trylock(mutex);
    if(result!=EBUSY){
      return result;
    }
    struct timespec nap={
      .tv_nsec=1000000}
    ;
    (void)nanosleep(&nap,NULL);
  }
}
static void record_close(struct np_root_origin *o) {
  uint64_t now,observed=atomic_load(&o->shared->high_water);
  if(monotonic(&now)||now<observed)now=observed;
  uint64_t end=now<=INT64_MAX-60*NP_ORIGIN_SECOND?minimum(now+60*NP_ORIGIN_SECOND,o->cleanup_ends.cleanup):o->cleanup_ends.cleanup;
  uint64_t absent=0;
  (void)atomic_compare_exchange_strong(&o->shared->attempt_end,&absent,end);
  atomic_store(&o->shared->closed,true);
}
static int lock_origin(struct np_root_origin *o, uint64_t end) {
  if(!o||o!=sole||!o->shared){
    return -1;
  }
  int result=np_origin_mutex_take_v1(&o->shared->lock,end);
  if(!result){
    return 0;
  }
  if(result==EOWNERDEAD){
    record_close(o);
    o->shared->broken=true;
    pthread_mutex_unlock(&o->shared->lock);
  }
  else if(result!=ETIMEDOUT){record_close(o);
  o->shared->broken=true;
  }
  return -1;
}
static int held_context(struct np_root_origin *o, struct np_clock *clock) {
  char boot[37]={
    0}
  ;
  return live(o->admin->parent.pidfd)||pread(o->boot,boot,36,0)!=36||strcmp(boot,o->admin->boot)||current_ns(clock->time,"/proc/self/ns/time",CLONE_NEWTIME)||current_ns(clock->children,"/proc/self/ns/time_for_children",CLONE_NEWTIME)||current_ns(clock->mount,"/proc/self/ns/mnt",CLONE_NEWNS)?-1:0;
}
static int sample_locked(struct np_root_origin *o, struct np_clock *clock, uint64_t *out) {
  uint64_t now;
  if(o->shared->broken||held_context(o,clock)||monotonic(&now)||now<o->shared->high_water){
    record_close(o);
    o->shared->broken=true;
    return -1;
  }
  o->shared->high_water=now;
  if(getpid()==o->principal)o->cleanup_high_water=now;
  *out=now;
  return 0;
}
int np_cleanup_clock_sample_v1(const struct np_clock *clock,int boot,const char *boot_id,uint64_t end,uint64_t *high_water,uint64_t *out) {
  char actual[37]={0};
  uint64_t now;
  if(!clock||!boot_id||!high_water||!out||pread(boot,actual,36,0)!=36||strcmp(actual,boot_id)||current_ns(clock->time,"/proc/self/ns/time",CLONE_NEWTIME)||current_ns(clock->children,"/proc/self/ns/time_for_children",CLONE_NEWTIME)||current_ns(clock->mount,"/proc/self/ns/mnt",CLONE_NEWNS)||monotonic(&now)||now<*high_water||now>=end)return -1;
  *high_water=now;
  *out=now;
  return 0;
}
static int cleanup_now(struct np_root_origin *o,uint64_t *out) {
  if(!o||o!=sole||getpid()!=o->principal||o->cleanup_uncertain)return -1;
  if(np_cleanup_clock_sample_v1(&o->clock,o->boot,o->admin->boot,minimum(o->cleanup_ends.cleanup,o->cleanup_attempt_end?o->cleanup_attempt_end:o->cleanup_ends.cleanup),&o->cleanup_high_water,out)){
    o->cleanup_uncertain=true;
    return -1;
  }
  return 0;
}
int np_origin_now_v1(struct np_root_origin *o,uint64_t *out) {
  if(o&&o==sole&&getpid()==o->principal&&o->cleanup_started)return cleanup_now(o,out);
  if(!o||o!=sole||!out||lock_origin(o,o->shared?o->shared->ends.cleanup:0)){
    return -1;
  }
  int r=sample_locked(o,&o->clock,out);
  pthread_mutex_unlock(&o->shared->lock);
  return r;
}
int np_origin_boundary_v1(struct np_root_origin *o,bool cleanup) {
  uint64_t now;
  return np_origin_now_v1(o,&now)||now>=(cleanup?o->shared->ends.cleanup:o->shared->ends.work)||(!cleanup&&(o->shared->closed||o->cleanup_started))?-1:0;
}
int np_origin_effect_begin_v1(struct np_root_origin *o,enum np_origin_effect effect) {
  bool cleanup=effect==NP_ORIGIN_STOP||effect==NP_ORIGIN_UNREF;
  if(o&&o==sole&&getpid()==o->principal&&o->cleanup_started){
    uint64_t now;
    if(!cleanup||effect>=NP_ORIGIN_EFFECTS||cleanup_now(o,&now)||now>=o->cleanup_attempt_end||o->cleanup_slots[effect])return -1;
    o->cleanup_slots[effect]=true;
    o->cleanup_effect=true;
    return 0;
  }
  if(effect>=NP_ORIGIN_EFFECTS||lock_origin(o,o->shared->ends.cleanup)){
    return -1;
  }
  uint64_t now;
  if(sample_locked(o,&o->clock,&now)||now>=(cleanup?o->shared->ends.cleanup:o->shared->ends.work)||(!cleanup&&o->shared->closed)||o->shared->slots[effect]){
    pthread_mutex_unlock(&o->shared->lock);
    return -1;
  }
  o->shared->slots[effect]=true;
  if(getpid()==o->principal)o->cleanup_slots[effect]=true;
  return 0;
}
int np_origin_effect_check_v1(struct np_root_origin *o,bool cleanup,uint64_t end) {
  if(!o||o!=sole||getpid()!=o->principal)return -1;
  uint64_t now;
  if(o->cleanup_started)return !cleanup||cleanup_now(o,&now)||now>=end?-1:0;
  return sample_locked(o,&o->clock,&now)||o->shared->closed||now>=end||now>=o->cleanup_ends.work?-1:0;
}
void np_origin_effect_end_v1(struct np_root_origin *o){
  if(o&&o==sole&&o->cleanup_effect){o->cleanup_effect=false;
  return;
  }
  (void)pthread_mutex_unlock(&o->shared->lock);
}
const struct np_origin_ends *np_origin_ends_v1(struct np_root_origin *o){
  return o==sole&&o->shared?&o->shared->ends:NULL;
}
const char *np_origin_unit_v1(struct np_root_origin *o){
  return o==sole?o->unit:NULL;
}
const char *np_origin_job_v1(struct np_root_origin *o){
  return o==sole?o->admin->job:NULL;
}
int np_origin_daemon_fd_v1(struct np_root_origin *o){
  return o==sole?11:-1;
}
int np_origin_daemon_identity_v1(struct np_root_origin *o,uid_t *uid,gid_t *gid) {
  if(o!=sole||get64(o->admin->record+408)>UINT32_MAX||get64(o->admin->record+416)>UINT32_MAX){
    return -1;
  }
  *uid=(uid_t)get64(o->admin->record+408);
  *gid=(gid_t)get64(o->admin->record+416);
  return 0;
}
int np_origin_prefix_write_v1(int directory,unsigned index,uint64_t generation,uint64_t sample,const char *event,const char *prefix) {
  if(!event||!prefix||strlen(event)>32||strlen(prefix)>2048||index>=1024)return -1;
  size_t length=strlen(prefix);
  char escaped[4097];
  size_t at=0;
  for(size_t i=0;i<length;i++){
    unsigned char byte=(unsigned char)prefix[i];
    if(byte<32||byte>126)return -1;
    if(byte=='"'||byte==92)escaped[at++]=92;
    escaped[at++]=(char)byte;
  }
  escaped[at]=0;
  for(const char *p=event;*p;p++)if(!((*p>='a'&&*p<='z')||*p=='-'))return -1;
  char bytes[4608],name[64];
  int count=snprintf(bytes,sizeof bytes,"{\"event\":\"%s\",\"generation\":\"%llu\",\"index\":%u,\"monotonicNs\":\"%llu\",\"prefix\":\"%s\"}\n",event,(unsigned long long)generation,index,(unsigned long long)sample,escaped);
  if(count<=0||(size_t)count>=sizeof bytes)return -1;
  snprintf(name,sizeof name,"prefix-%04u.json",index);
  int fd=openat(directory,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd<0)return -1;
  bool failed=write(fd,bytes,(size_t)count)!=count||fsync(fd);
  close(fd);
  return failed||fsync(directory)?-1:0;
}
int np_origin_journal_v1(struct np_root_origin *o,const char *event,const char *prefix) {
  if(!o||o!=sole||getpid()!=o->principal||!event||!prefix)return -1;
  uint64_t now;
  unsigned limit=o->cleanup_started?1024:896;
  uint64_t end=o->cleanup_started?o->cleanup_attempt_end:o->cleanup_ends.cleanup;
  if(o->journal_count>=limit||monotonic(&now)||now<o->cleanup_high_water||now>=end)goto failed;
  end=minimum(end,now+OBS);
  o->cleanup_high_water=now;
  if(np_origin_prefix_write_v1(6,o->journal_count++,o->cleanup_ends.generation,now,event,prefix)||monotonic(&now)||now<o->cleanup_high_water||now>=end)goto failed;
  o->cleanup_high_water=now;
  return 0;
failed:
  o->journal_failed=true;
  record_close(o);
  return -1;
}
static int phase_io(struct np_root_origin *o,unsigned char *p,size_t n,bool writing) {
  size_t done=0;
  while(done<n){
    uint64_t now;
    if(np_origin_now_v1(o,&now)||now>=o->phase_end){
      return -1;
    }
    ssize_t k=writing?send(3,p+done,n-done,MSG_NOSIGNAL|MSG_DONTWAIT):recv(3,p+done,n-done,MSG_DONTWAIT);
    if(k>0){
      done+=(size_t)k;
      continue;
    }
    if(k==0||!(errno==EINTR||errno==EAGAIN||errno==EWOULDBLOCK)){
      return -1;
    }
    struct pollfd fd={
      .fd=3,.events=writing?POLLOUT:POLLIN}
    ;
    if(poll(&fd,1,10)<0&&errno!=EINTR){
      return -1;
    }
  }
  uint64_t now;
  return np_origin_now_v1(o,&now)||now>=o->phase_end?-1:0;
}
static int phase_send(struct np_root_origin *o,unsigned type,const unsigned char *p,size_t n) {
  unsigned char h[PHASE_HEADER]={
    0}
  ;
  memcpy(h,"NPA5",4);
  h[4]=(unsigned char)type;
  h[5]=1;
  put64(h+8,n);
  put64(h+16,o->shared->ends.generation);
  return phase_io(o,h,sizeof h,true)||phase_io(o,(unsigned char *)p,n,true)?-1:0;
}
int np_origin_snapshot_v1(struct np_root_origin *o) {
  if(o!=sole||o->snapshot_sent||np_origin_boundary_v1(o,false)){
    return -1;
  }
  o->snapshot_sent=true;
  unsigned char *s=o->snapshot;
  memcpy(s,"NPSNAP01",8);
  put64(s+8,o->shared->ends.generation);
  put64(s+16,o->shared->ends.anchor);
  put64(s+24,o->shared->ends.work);
  put64(s+32,o->shared->ends.cleanup);
  put64(s+40,o->shared->ends.cold);
  put64(s+48,o->admin->cleanup);
  memcpy(s+56,o->admin->operation,64);
  memcpy(s+120,o->admin->machine,32);
  memcpy(s+152,o->admin->job,strlen(o->admin->job));
  memcpy(s+184,o->admin->installation,64);
  memcpy(s+248,o->admin->profile,64);
  memcpy(s+312,o->admin->manifest,64);
  return phase_send(o,1,s,sizeof o->snapshot);
}
int np_origin_freeze_allocation_v1(struct np_root_origin *o) {
  unsigned char h[PHASE_HEADER],ack[NP_ORIGIN_PHASE_MAX];
  if(!o->snapshot_sent||o->frozen||phase_io(o,h,sizeof h,false)||memcmp(h,"NPA5",4)||h[4]!=2||h[5]!=1||h[6]||h[7]||get64(h+16)!=o->shared->ends.generation){
    return -1;
  }
  uint64_t n=get64(h+8);
  if(n<=SNAP_BYTES+64||n>sizeof ack||phase_io(o,ack,(size_t)n,false)||memcmp(ack,o->snapshot,SNAP_BYTES)||hex((char *)ack+SNAP_BYTES,64)||ack[n-1]!='\n'){
    return -1;
  }
  o->allocation_size=(size_t)n-SNAP_BYTES-64;
  memcpy(o->digest,ack+SNAP_BYTES,64);
  memcpy(o->allocation,ack+SNAP_BYTES+64,o->allocation_size);
  o->allocation[o->allocation_size]=0;
  o->frozen=true;
  if(phase_send(o,3,(unsigned char *)o->digest,64)){
    return -1;
  }
  int record=openat(6,"allocation.bin",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(record<0||write(record,ack,(size_t)n)!=(ssize_t)n||fsync(record)){
    return -1;
  }
  close(record);
  for(size_t i=0;i<o->admin->directory.count;i++){
    int fd=openat(o->admin->directory.fds[i],".",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    if(fd<0||fsync(fd)){
      return -1;
    }
    close(fd);
  }
  char prefix[256];
  snprintf(prefix,sizeof prefix,"allocation=%s principal=%ld work=%llu cleanup=%llu cold=%llu",o->digest,(long)o->principal,(unsigned long long)o->cleanup_ends.work,(unsigned long long)o->cleanup_ends.cleanup,(unsigned long long)o->cleanup_ends.cold);
  if(np_origin_journal_v1(o,"allocation-frozen",prefix))return -1;
  o->intent=true;
  return np_origin_boundary_v1(o,false);
}
struct origin_packet {
  uint64_t magic, generation, sequence;
  uint32_t kind, state;
  uint64_t value;
  char owner_prefix[768];
}
;
#define ORIGIN_PACKET UINT64_C(0x4e504f5249474135)
enum origin_packet_kind {
  ORIGIN_RELEASE=1, ORIGIN_NAMESPACED, ORIGIN_READY, ORIGIN_START, ORIGIN_STATUS, ORIGIN_STOP, ORIGIN_EXIT, ORIGIN_OWNER_PREFIX }
;
static volatile sig_atomic_t child_stop;
static void child_signal(int signal_number){
  (void)signal_number;
  child_stop=1;
}
static int packet_send(struct np_root_origin *o,int fd,unsigned kind,unsigned state,uint64_t value,bool child) {
  struct origin_packet p={
    .magic=ORIGIN_PACKET,.generation=o->shared->ends.generation,.sequence=++o->sequence[child?1:0],.kind=kind,.state=state,.value=value}
  ;
  return send(fd,&p,sizeof p,MSG_NOSIGNAL|MSG_DONTWAIT)==(ssize_t)sizeof p?0:-1;
}
static int packet_owner_prefix(struct np_root_origin *o,struct np_original_owner *owner) {
  struct origin_packet packet={.magic=ORIGIN_PACKET,.generation=o->shared->ends.generation,.sequence=++o->sequence[1],.kind=ORIGIN_OWNER_PREFIX};
  if(np_original_owner_prefix_v2(owner,packet.owner_prefix,sizeof packet.owner_prefix))return -1;
  return send(o->branch.endpoint,&packet,sizeof packet,MSG_NOSIGNAL|MSG_DONTWAIT)==(ssize_t)sizeof packet?0:-1;
}
static int packet_read(struct np_root_origin *o,int fd,struct origin_packet *p,bool child) {
  union {
    struct cmsghdr align;
    unsigned char bytes[CMSG_SPACE(sizeof(struct ucred))+CMSG_SPACE(16*sizeof(int))];
  }
  control;
  struct iovec iov={
    .iov_base=p,.iov_len=sizeof *p}
  ;
  struct msghdr msg={
    .msg_iov=&iov,.msg_iovlen=1,.msg_control=control.bytes,.msg_controllen=sizeof control.bytes}
  ;
  memset(&control,0,sizeof control);
  ssize_t n=recvmsg(fd,&msg,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
  if(n<0){
    return -1;
  }
  bool credentials=false,rights=false;
  struct ucred credential={
    0}
  ;
  for(struct cmsghdr *c=CMSG_FIRSTHDR(&msg);c;c=CMSG_NXTHDR(&msg,c)) {
    if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS){
      size_t count=(c->cmsg_len-CMSG_LEN(0))/sizeof(int);
      int *fds=(int *)CMSG_DATA(c);
      for(size_t i=0;i<count;i++)close(fds[i]);
      rights=true;
    }
    else if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_CREDENTIALS&&c->cmsg_len==CMSG_LEN(sizeof credential)&&!credentials){
      memcpy(&credential,CMSG_DATA(c),sizeof credential);
      credentials=true;
    }
    else rights=true;
  }
  /* The actual held parent is outside the new PID namespace and projects 0.
  * This private fork channel is never np_channel_receive_v1's helper peer. */
  if(n!=(ssize_t)sizeof *p||msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC)||rights||!credentials||credential.uid||credential.gid||credential.pid!=(child?0:o->child)||p->magic!=ORIGIN_PACKET||p->generation!=o->shared->ends.generation||p->sequence!=o->sequence[child?0:1]+1){
    errno=EPROTO;
    return -1;
  }
  o->sequence[child?0:1]=p->sequence;
  if(!child&&p->kind==ORIGIN_OWNER_PREFIX){
    if(!memchr(p->owner_prefix,0,sizeof p->owner_prefix)||p->state||p->value||np_origin_journal_v1(o,"helper-original-prefix",p->owner_prefix)){errno=EPROTO;
    return -1;
    }
    errno=EAGAIN;
    return -1;
  }
  for(size_t i=0;i<sizeof p->owner_prefix;i++)if(p->owner_prefix[i]){errno=EPROTO;
  return -1;
  }
  return 0;
}
static int child_member(struct np_origin_child *c) {
  if(!c||!sole||c!=&sole->branch||c->origin!=sole||c->role!=getpid()||getpid()!=1||live(c->parent_pidfd)){
    return -1;
  }
  struct pollfd p={
    .fd=c->endpoint,.events=POLLIN}
  ;
  return poll(&p,1,0)<0||(p.revents&(POLLHUP|POLLERR|POLLNVAL))?-1:0;
}
int np_origin_sample_v1(struct np_origin_child *c,uint64_t *out) {
  if(child_member(c)||lock_origin(c->origin,c->origin->shared->ends.cleanup)){
    return -1;
  }
  int result=sample_locked(c->origin,&c->clock,out);
  pthread_mutex_unlock(&c->origin->shared->lock);
  return result;
}
int np_origin_child_work_v1(struct np_origin_child *c) {
  if(child_member(c)||lock_origin(c->origin,c->origin->shared->ends.work))return -1;
  uint64_t now;
  int result=sample_locked(c->origin,&c->clock,&now)||c->origin->shared->closed||now>=c->origin->shared->ends.work?-1:0;
  pthread_mutex_unlock(&c->origin->shared->lock);
  return result;
}
int np_origin_child_commit_check_v1(struct np_origin_child *c) {
  uint64_t now;
  return child_member(c)||sample_locked(c->origin,&c->clock,&now)||c->origin->shared->closed||now>=c->origin->shared->ends.cold?-1:0;
}
int np_origin_child_commit_begin_v1(struct np_origin_child *c) {
  if(child_member(c)||lock_origin(c->origin,c->origin->shared->ends.cold))return -1;
  if(np_origin_child_commit_check_v1(c)){pthread_mutex_unlock(&c->origin->shared->lock);
  return -1;
  }
  return 0;
}
int np_origin_child_begin_v1(struct np_origin_child *c,enum np_origin_effect effect) {
  if(child_member(c)||effect!=NP_ORIGIN_HELPER||lock_origin(c->origin,c->origin->shared->ends.cold)){
    return -1;
  }
  uint64_t now;
  struct shared_origin *s=c->origin->shared;
  if(sample_locked(c->origin,&c->clock,&now)||s->closed||now>=s->ends.cold||s->slots[effect]){
    pthread_mutex_unlock(&s->lock);
    return -1;
  }
  s->slots[effect]=true;
  return 0;
}
void np_origin_child_end_v1(struct np_origin_child *c){
  pthread_mutex_unlock(&c->origin->shared->lock);
}
void np_origin_child_close_v1(struct np_origin_child *c){
  if(!child_member(c)&&!lock_origin(c->origin,c->origin->shared->ends.cleanup)){
    record_close(c->origin);
    pthread_mutex_unlock(&c->origin->shared->lock);
  }
}
int np_origin_child_clock_v1(struct np_origin_child *c,struct np_clock *clock,uint64_t *cold) {
  uint64_t now;
  if(child_member(c)||np_origin_sample_v1(c,&now)||now>=c->origin->shared->ends.cold){
    return -1;
  }
  *clock=c->clock;
  clock->time=fcntl(c->clock.time,F_DUPFD_CLOEXEC,4);
  clock->children=fcntl(c->clock.children,F_DUPFD_CLOEXEC,4);
  clock->mount=fcntl(c->clock.mount,F_DUPFD_CLOEXEC,4);
  clock->anchor=c->origin->shared->ends.anchor;
  clock->preparation_end=c->origin->shared->ends.work;
  clock->cleanup_end=c->origin->shared->ends.cleanup;
  *cold=c->origin->shared->ends.cold;
  return clock->time<0||clock->children<0||clock->mount<0?-1:0;
}
int np_origin_child_closure_v1(struct np_origin_child *c,int out[3]){
  if(child_member(c)){
    return -1;
  }
  for(unsigned i=0;i<3;i++){
    out[i]=fcntl(c->closure[i],F_DUPFD_CLOEXEC,4);
    if(out[i]<0){
      return -1;
    }
  }
  return 0;
}
static int child_namespace(struct np_root_origin *o) {
  struct np_origin_child *c=&o->branch;
  uint64_t now;
  if(lock_origin(o,o->shared->ends.cold)){
    return -1;
  }
  int failed=sample_locked(o,&o->clock,&now)||o->shared->closed||now>=o->shared->ends.cold||unshare(CLONE_NEWNS)||mount(NULL,"/",NULL,MS_REC|MS_PRIVATE,NULL)||mount(NP_ORIGIN_IMAGE,NP_ORIGIN_IMAGE,NULL,MS_BIND|MS_REC,NULL)||mount(NULL,NP_ORIGIN_IMAGE,NULL,MS_BIND|MS_REMOUNT|MS_RDONLY|MS_NOSUID|MS_NODEV,NULL)||chdir(NP_ORIGIN_IMAGE)||chroot(".")||chdir("/")||mount("tmpfs","/tmp","tmpfs",MS_NOSUID|MS_NODEV,"mode=1777,size=16777216")||mount("proc","/proc","proc",MS_NOSUID|MS_NODEV|MS_NOEXEC,NULL)||unshare(CLONE_NEWCGROUP);
  pthread_mutex_unlock(&o->shared->lock);
  if(failed){
    return -1;
  }
  c->clock=o->clock;
  c->clock.mount=open("/proc/self/ns/mnt",O_RDONLY|O_CLOEXEC);
  if(c->clock.mount<0||current_ns(c->clock.time,"/proc/self/ns/time",CLONE_NEWTIME)||current_ns(c->clock.children,"/proc/self/ns/time_for_children",CLONE_NEWTIME)){
    return -1;
  }
  /* Retain only original private channel, namespace/birth and fixed helper
  * files. No administrative record, bus or host filesystem descriptor. */
  for(int fd=3;fd<4096;fd++) {
    if(fd==c->endpoint||fd==c->parent_pidfd||fd==c->clock.time||fd==c->clock.children||fd==c->clock.mount||fd==o->boot||fd==o->admin->parent.pidfd||fd==c->closure[0]||fd==c->closure[1]||fd==c->closure[2])continue;
    close(fd);
  }
  return 0;
}
static int child_receive_wait(struct np_root_origin *o,struct origin_packet *p,uint64_t end) {
  for(;;){
    uint64_t now;
    if(np_origin_sample_v1(&o->branch,&now)||now>=end||child_stop){
      return -1;
    }
    if(!packet_read(o,o->branch.endpoint,p,true)){
      return 0;
    }
    if(errno!=EAGAIN&&errno!=EINTR){
      return -1;
    }
    struct pollfd f={
      .fd=o->branch.endpoint,.events=POLLIN|POLLHUP}
    ;
    if(poll(&f,1,10)<0&&errno!=EINTR){
      return -1;
    }
    if(f.revents&(POLLHUP|POLLERR|POLLNVAL)){
      return -1;
    }
  }
}
static void child_run(struct np_root_origin *o) {
  struct np_origin_child *c=&o->branch;
  c->origin=o;
  c->role=getpid();
  c->endpoint=o->channel[1];
  c->parent_pidfd=o->self_pidfd;
  c->clock=o->clock;
  for(unsigned i=0;i<3;i++)c->closure[i]=fcntl(8+(int)i,F_DUPFD_CLOEXEC,7+(int)o->admin->files);
  struct sigaction action={
    .sa_handler=child_signal}
  ;
  sigemptyset(&action.sa_mask);
  if(sigaction(SIGTERM,&action,NULL)||sigaction(SIGINT,&action,NULL))_exit(77);
  if(dup2(o->pipes[0][1],1)<0||dup2(o->pipes[1][1],2)<0)_exit(77);
  struct origin_packet p;
  if(child_receive_wait(o,&p,o->shared->ends.cold)||p.kind!=ORIGIN_RELEASE||child_namespace(o)||packet_send(o,c->endpoint,ORIGIN_NAMESPACED,0,0,true))_exit(77);
  if(child_receive_wait(o,&p,o->shared->ends.cold)||p.kind!=ORIGIN_RELEASE)_exit(77);
  struct np_original_owner *owner=NULL;
  if(np_original_owner_from_origin_fork_v2(c,&owner)||packet_owner_prefix(o,owner)||packet_send(o,c->endpoint,ORIGIN_READY,NP_OWNER_RESERVED,0,true))_exit(77);
  bool started=false,stop=false;
  struct np_owner_data data={
    0}
  ;
  while(!stop&&!child_stop){
    uint64_t current;
    if(np_origin_sample_v1(c,&current)||current>=o->shared->ends.work)break;
    if(packet_read(o,c->endpoint,&p,true)) {
      if(errno!=EAGAIN&&errno!=EINTR)break;
      if(started){
        int fd=np_original_owner_poll_fd_v2(owner);
        struct pollfd helper_poll={
          .fd=fd,.events=POLLIN|POLLHUP}
        ;
        if(fd<0||poll(&helper_poll,1,0)<0)break;
        if(helper_poll.revents&&np_original_owner_observe_v1(owner,&data))break;
      }
      struct pollfd control={
        .fd=c->endpoint,.events=POLLIN|POLLHUP}
      ;
      if(poll(&control,1,10)<0&&errno!=EINTR)break;
      if(control.revents&(POLLHUP|POLLERR|POLLNVAL))break;
      continue;
    }
    if(p.kind==ORIGIN_STOP){
      stop=true;
      break;
    }
    if(p.kind==ORIGIN_START&&!started){
      started=true;
      int launched=np_original_owner_launch_v1(owner);
      if(packet_owner_prefix(o,owner)||launched)break;
    }
    else if(p.kind!=ORIGIN_STATUS&&p.kind!=ORIGIN_START)break;
    if(started){int observed=np_original_owner_observe_v1(owner,&data);
    if(packet_owner_prefix(o,owner)||observed)break;
    }
    if(packet_send(o,c->endpoint,ORIGIN_STATUS,started?(unsigned)data.state:NP_OWNER_RESERVED,started&&data.committed,true))break;
  }
  np_original_owner_close_v1(owner);
  (void)packet_owner_prefix(o,owner);
  bool joined=false;
  for(;;){
    uint64_t now;
    if(np_origin_sample_v1(c,&now)||now>=o->shared->ends.cleanup)break;
    if(!np_original_owner_join_v1(owner)){
      joined=true;
      break;
    }
    if(errno!=EAGAIN)break;
    struct timespec nap={
      .tv_nsec=10000000}
    ;
    nanosleep(&nap,NULL);
  }
  (void)packet_owner_prefix(o,owner);
  if(joined&&np_original_owner_dispose_v1(owner)==0){
    (void)packet_send(o,c->endpoint,ORIGIN_EXIT,NP_OWNER_CLOSED,1,true);
    _exit(0);
  }
  (void)packet_send(o,c->endpoint,ORIGIN_EXIT,NP_OWNER_CLOSED,0,true);
  _exit(77);
}
static int child_ns_pin(struct np_root_origin *o,unsigned slot,const char *name,int type) {
  char path[128];
  int n=snprintf(path,sizeof path,"/proc/%ld/ns/%s",(long)o->child,name);
  if(n<=0||(size_t)n>=sizeof path||live(o->child_pidfd)){
    return -1;
  }
  int fd=open(path,O_RDONLY|O_CLOEXEC);
  if(fd<0||ioctl(fd,NS_GET_NSTYPE)!=type||live(o->child_pidfd)){
    return -1;
  }
  o->child_ns[slot]=fd;
  struct stat ns,pidfd;
  if(fstat(fd,&ns)||fstat(o->child_pidfd,&pidfd))return -1;
  char prefix[256];
  snprintf(prefix,sizeof prefix,"child=%ld pidfd=%llu:%llu namespace=%s nsfs=%llu:%llu type=%d",(long)o->child,(unsigned long long)pidfd.st_dev,(unsigned long long)pidfd.st_ino,name,(unsigned long long)ns.st_dev,(unsigned long long)ns.st_ino,type);
  if(np_origin_journal_v1(o,"child-original-namespace",prefix))return -1;
  return 0;
}
static int parent_receive(struct np_root_origin *o,struct origin_packet *p,uint64_t end) {
  for(;;){
    uint64_t now;
    if(np_origin_now_v1(o,&now)||now>=end){
      return -1;
    }
    if(!packet_read(o,o->channel[0],p,false)){
      return 0;
    }
    if(errno!=EAGAIN&&errno!=EINTR){
      return -1;
    }
    struct pollfd f={
      .fd=o->channel[0],.events=POLLIN|POLLHUP}
    ;
    if(poll(&f,1,10)<0&&errno!=EINTR){
      return -1;
    }
    if(f.revents&(POLLERR|POLLNVAL)){
      return -1;
    }
  }
}
int np_root_managed_launch_v1(struct np_root_origin *o) {
  if(o!=sole||!o->frozen||!o->intent||np_origin_boundary_v1(o,false)){
    return -1;
  }
  int credentials=1;
  struct sigaction action={
    .sa_handler=SIG_DFL}
  ;
  sigemptyset(&action.sa_mask);
  if(sigaction(SIGCHLD,&action,NULL)||socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC|SOCK_NONBLOCK,0,o->channel)||setsockopt(o->channel[0],SOL_SOCKET,SO_PASSCRED,&credentials,sizeof credentials)||setsockopt(o->channel[1],SOL_SOCKET,SO_PASSCRED,&credentials,sizeof credentials)||pipe2(o->pipes[0],O_CLOEXEC)||pipe2(o->pipes[1],O_CLOEXEC)){
    return -1;
  }
  if(np_origin_effect_begin_v1(o,NP_ORIGIN_FORK)){
    return -1;
  }
  if(unshare(CLONE_NEWPID)){
    np_origin_effect_end_v1(o);
    return -1;
  }
  o->namespace_changed=true;
  o->children_ns=open("/proc/self/ns/pid_for_children",O_RDONLY|O_CLOEXEC);
  pid_t child=o->children_ns<0?-1:fork();
  if(child==0){
    close(o->channel[0]);
    child_run(o);
    _exit(77);
  }
  np_origin_effect_end_v1(o);
  if(child<0){
    return -1;
  }
  o->child=child;
  close(o->channel[1]);
  o->channel[1]=-1;
  for(unsigned i=0;i<2;i++){
    close(o->pipes[i][1]);
    o->pipes[i][1]=-1;
    if(fcntl(o->pipes[i][0],F_SETFL,O_NONBLOCK)){
      return -1;
    }
  }
  /* No wait/reaper is allowed before pinning this actual unreaped fork child. */
  o->child_pidfd=(int)syscall(SYS_pidfd_open,child,0);
  if(live(o->child_pidfd)||child_ns_pin(o,0,"pid",CLONE_NEWPID)||same_fd(o->child_ns[0],o->children_ns)){
    return -1;
  }
  int ancestor=ioctl(o->child_ns[0],NS_GET_PARENT);
  if(ancestor<0||same_fd(ancestor,o->pid_ns)){
    return -1;
  }
  close(ancestor);
  if(child_ns_pin(o,1,"time",CLONE_NEWTIME)||same_fd(o->child_ns[1],o->clock.time)||np_managed_open_v1(o,&o->managed)||np_managed_launch_v1(o,o->managed,o->child_pidfd,o->child)||packet_send(o,o->channel[0],ORIGIN_RELEASE,0,0,false)){
    return -1;
  }
  struct origin_packet p;
  uint64_t now;
  if(np_origin_now_v1(o,&now)||parent_receive(o,&p,minimum(now+OBS,o->shared->ends.cold))||p.kind!=ORIGIN_NAMESPACED||child_ns_pin(o,2,"mnt",CLONE_NEWNS)||child_ns_pin(o,3,"cgroup",CLONE_NEWCGROUP)||same_fd(o->child_ns[2],o->clock.mount)==0){
    return -1;
  }
  if(packet_send(o,o->channel[0],ORIGIN_RELEASE,0,0,false)||np_origin_now_v1(o,&now)||parent_receive(o,&p,minimum(now+OBS,o->shared->ends.cold))||p.kind!=ORIGIN_READY){
    return -1;
  }
  o->child_ready=true;
  return 0;
}
int np_origin_output_v1(struct np_root_origin *o,int fd,const void *data,size_t size) {
  uint64_t now;
  if(np_origin_now_v1(o,&now))return -1;
  uint64_t end=minimum(now+OBS,o->shared->ends.cleanup);
  int flags=fcntl(fd,F_GETFL);
  if(flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK))return -1;
  const unsigned char *bytes=data;
  size_t done=0;
  while(done<size){
    if(np_origin_now_v1(o,&now)||now>=end)return -1;
    ssize_t count=write(fd,bytes+done,size-done);
    if(count>0){done+=(size_t)count;
    continue;
    }
    if(count==0||!(errno==EAGAIN||errno==EINTR))return -1;
    struct pollfd output={.fd=fd,.events=POLLOUT};
    if(poll(&output,1,1)<0&&errno!=EINTR)return -1;
  }
  return np_origin_now_v1(o,&now)||now>=end?-1:0;
}
static int streams_drain(struct np_root_origin *o) {
  unsigned char bytes[4096];
  for(unsigned i=0;i<2;i++){
    if(o->eof[i]||o->pipes[i][0]<0)continue;
    for(unsigned count=0;count<16;count++){
      ssize_t n=read(o->pipes[i][0],bytes,sizeof bytes);
      if(n==0){
        o->eof[i]=true;
        break;
      }
      if(n<0){
        if(errno==EAGAIN||errno==EINTR)break;
        return -1;
      }
      /* Raw bounded original stream prefix, forwarded to the independent observer. */if(np_origin_output_v1(o,i?2:1,bytes,(size_t)n)){
        return -1;
      }
    }
  }
  return 0;
}
static int data_listener(struct np_root_origin *o) {
  struct np_directory directory={
    0}
  ;
  if(np_directory_pin_v1(&directory,NP_ROOT_DIRECTORY)){
    return -1;
  }
  struct stat s;
  if(fstat(np_directory_fd_v1(&directory),&s)||s.st_uid||s.st_gid||(s.st_mode&0777)!=0700){
    return -1;
  }
  o->listener=socket(AF_UNIX,SOCK_SEQPACKET|SOCK_NONBLOCK|SOCK_CLOEXEC,0);
  struct sockaddr_un address={
    .sun_family=AF_UNIX}
  ;
  strcpy(address.sun_path,NP_ROOT_SOCKET);
  if(o->listener<0||bind(o->listener,(struct sockaddr *)&address,sizeof address)||chmod(NP_ROOT_SOCKET,0600)||listen(o->listener,4)){
    return -1;
  }
  np_directory_release_v1(&directory);
  return 0;
}
static int data_request(struct np_root_origin *o,int fd) {
  unsigned char bytes[NP_ROOT_WIRE_MAX];
  struct np_root_request_v3 request;
  uint64_t now;
  struct ucred peer;
  socklen_t size=sizeof peer;
  if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&peer,&size)||peer.uid||peer.gid||np_origin_now_v1(o,&now)){
    return -1;
  }
  uint64_t end=minimum(now+OBS,o->shared->ends.work);
  ssize_t count;
  for(;;){
    unsigned char ancillary[CMSG_SPACE(16*sizeof(int))];
    struct iovec iov={.iov_base=bytes,.iov_len=sizeof bytes};
    struct msghdr message={.msg_iov=&iov,.msg_iovlen=1,.msg_control=ancillary,.msg_controllen=sizeof ancillary};
    count=recvmsg(fd,&message,MSG_DONTWAIT|MSG_TRUNC|MSG_CMSG_CLOEXEC);
    if(count>=0){
      bool extra=false;
      for(struct cmsghdr *c=CMSG_FIRSTHDR(&message);c;c=CMSG_NXTHDR(&message,c)){
        extra=true;
        if(c->cmsg_level==SOL_SOCKET&&c->cmsg_type==SCM_RIGHTS&&c->cmsg_len>=CMSG_LEN(0)){
          size_t rights=(c->cmsg_len-CMSG_LEN(0))/sizeof(int);
          int *received=(int *)CMSG_DATA(c);
          for(size_t i=0;i<rights;i++)close(received[i]);
        }
      }
      if(extra||(message.msg_flags&(MSG_TRUNC|MSG_CTRUNC)))return -1;
    }
    if(count>=0)break;
    if(errno!=EAGAIN&&errno!=EINTR){
      return -1;
    }
    if(np_origin_now_v1(o,&now)||now>=end){
      return -1;
    }
    struct pollfd p={
      .fd=fd,.events=POLLIN}
    ;
    (void)poll(&p,1,10);
  }
  if(np_root_request_decode_v3(bytes,(size_t)count,&request)||strcmp(request.digest,o->digest)||strcmp(request.machine,o->admin->machine)||strcmp(request.job,o->admin->job)||np_origin_boundary_v1(o,false)){
    return -1;
  }
  unsigned kind=request.operation==NP_ROOT_START?ORIGIN_START:request.operation==NP_ROOT_STOP?ORIGIN_STOP:ORIGIN_STATUS;
  if(kind!=ORIGIN_STOP&&packet_send(o,o->channel[0],kind,0,0,false)){
    return -1;
  }
  if(kind==ORIGIN_STOP){
    o->stopped=true;
    (void)np_root_origin_close_v1(o,NP_ORIGIN_EXPLICIT_STOP);
  }
  else {
    struct origin_packet p;
    if(parent_receive(o,&p,end)||p.kind!=ORIGIN_STATUS){
      return -1;
    }
    o->child_state=p.state;
  }
  char payload[NP_ORIGIN_PHASE_MAX+512];
  int n=snprintf(payload,sizeof payload,"{\"allocation\":%.*s,\"childReady\":true,\"effectiveCleanupEndNs\":\"%llu\",\"effectiveWorkEndNs\":\"%llu\",\"helperCommitted\":%s,\"helperStarted\":%s,\"nativeClosed\":%s}",(int)(o->allocation_size-1),o->allocation,(unsigned long long)o->shared->ends.cleanup,(unsigned long long)o->shared->ends.work,o->child_state==NP_OWNER_COMMITTED?"true":"false",o->shared->slots[NP_ORIGIN_HELPER]?"true":"false",o->shared->closed?"true":"false");
  unsigned char response[NP_ROOT_WIRE_MAX];
  if(n<=0||(size_t)n>sizeof response-NP_ROOT_WIRE_HEADER||np_root_response_header_v3(response,&request,0,(size_t)n)){
    return -1;
  }
  memcpy(response+NP_ROOT_WIRE_HEADER,payload,(size_t)n);
  for(;;){
    if(np_origin_now_v1(o,&now)||now>=end){
      return -1;
    }
    ssize_t sent=send(fd,response,(size_t)n+NP_ROOT_WIRE_HEADER,MSG_NOSIGNAL|MSG_DONTWAIT);
    if(sent==(ssize_t)n+NP_ROOT_WIRE_HEADER){
      return np_origin_now_v1(o,&now)||now>=end?-1:0;
    }
    if(sent>=0||!(errno==EAGAIN||errno==EINTR)){
      return -1;
    }
    struct pollfd p={
      .fd=fd,.events=POLLOUT}
    ;
    (void)poll(&p,1,10);
  }
}
int np_root_origin_run_v1(struct np_root_origin *o) {
  if(!o->child_ready||data_listener(o)){
    return -1;
  }
  if(np_origin_output_v1(o,1,"{\"stage\":\"origin-ready\"}\n",25)){
    return -1;
  }
  while(!o->stopped){
    if(np_origin_boundary_v1(o,false)||np_managed_live_v1(o,o->managed)||streams_drain(o)){
      return -1;
    }
    int fd=accept4(o->listener,NULL,NULL,SOCK_NONBLOCK|SOCK_CLOEXEC);
    if(fd>=0){
      /* Temporary client EOF/refusal never closes the stable native owner. */(void)data_request(o,fd);
      close(fd);
      continue;
    }
    if(errno!=EAGAIN&&errno!=EINTR){
      return -1;
    }
    struct pollfd p[2]={
      {
        .fd=o->listener,.events=POLLIN}
      ,{
        .fd=o->channel[0],.events=POLLIN|POLLHUP}
    }
    ;
    if(poll(p,2,10)<0&&errno!=EINTR){
      return -1;
    }
    if(p[1].revents){
      return -1;
    }
  }
  return 0;
}
int np_root_origin_close_v1(struct np_root_origin *o,enum np_origin_loss loss) {
  (void)loss;
  if(o!=sole||!o->shared){
    return -1;
  }
  if(getpid()!=o->principal)return -1;
  if(!o->cleanup_started){
    /* Healthy close and associated commit serialize on the sole gate. On
     * unrecoverable ownership loss, atomic closure precedes independent cleanup. */
    if(!lock_origin(o,o->cleanup_ends.cleanup)){record_close(o);
    pthread_mutex_unlock(&o->shared->lock);
    }
    else record_close(o);
    o->cleanup_started=true;
    o->cleanup_attempt_end=minimum(atomic_load(&o->shared->attempt_end),o->cleanup_ends.cleanup);
  }
  if(o->child>0&&o->channel[0]>=0)(void)packet_send(o,o->channel[0],ORIGIN_STOP,0,0,false);
  return 0;
}
int np_root_origin_join_v1(struct np_root_origin *o,struct np_l0_native_data *data) {
  if(o!=sole||!data||!o->shared){
    return -1;
  }
  memset(data,0,sizeof *data);
  bool manager_ok=true;
  uint64_t now,signal_at=0;
  bool signalled=false;
  if(o->child>0){
    while(!o->child_wait||!o->eof[0]||!o->eof[1]||!o->helper_wait) {
      if(np_origin_now_v1(o,&now)||now>=o->cleanup_attempt_end)break;
      if(streams_drain(o))break;
      struct origin_packet p;
      if(!packet_read(o,o->channel[0],&p,false)&&p.kind==ORIGIN_EXIT)o->helper_wait=p.value==1;
      if(!o->child_wait){
        int status;
        pid_t pid=waitpid(o->child,&status,WNOHANG);
        if(pid==o->child)o->child_wait=true;
        else if(pid<0)break;
      }
      if(!signal_at)signal_at=minimum(now+2*NP_ORIGIN_SECOND,o->cleanup_attempt_end);
      if((!o->child_wait||!o->eof[0]||!o->eof[1]||!o->helper_wait)&&now>=signal_at){
        if(!signalled){
          if(o->managed&&np_managed_stop_v1(o,o->managed))manager_ok=false;
          if(!o->child_wait)(void)syscall(SYS_pidfd_send_signal,o->child_pidfd,SIGTERM,NULL,0);
          signalled=true;
          signal_at=minimum(now+2*NP_ORIGIN_SECOND,o->cleanup_attempt_end);
        }
        else if(!o->child_wait)(void)syscall(SYS_pidfd_send_signal,o->child_pidfd,SIGKILL,NULL,0);
      }
      struct timespec nap={
        .tv_nsec=10000000}
      ;
      nanosleep(&nap,NULL);
    }
  }
  else {
    o->child_wait=true;
    o->eof[0]=o->eof[1]=true;
    o->helper_wait=true;
  }
  if(o->managed&&np_managed_connections_settle_v1(o,o->managed))manager_ok=false;
  data->child_wait=o->child_wait;
  data->streams=o->eof[0]&&o->eof[1];
  data->helper_wait=o->helper_wait;
  data->manager=manager_ok;
  data->shared_unknown=np_managed_shared_unknown_v1(o->managed);
  data->closed=data->child_wait&&data->streams&&data->helper_wait&&data->manager&&!data->shared_unknown&&!o->shared->broken&&!o->cleanup_uncertain&&!o->journal_failed&&!np_origin_now_v1(o,&now)&&now<o->cleanup_attempt_end;
  /* Socket path and all original records are retained; collection or fd close
  * is never substituted for a manager/reference receipt. */
  return data->closed?0:-1;
}
