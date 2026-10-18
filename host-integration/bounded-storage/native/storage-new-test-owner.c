/* Included only by storage-native.c: original TEST creation and holder broker.
 * Never an installed service, adoption path, production grant, or cleanup API. */
#include <poll.h>
#include <sched.h>
#include <sys/socket.h>
#include <time.h>

#define TEST_MAGIC UINT64_C(0x315453455457454e)
#define TEST_POLICY "NEW_TEST_storage_b1_dedicated_ext4_no_real_projects"
static int test_tool = -1, test_current_fd = -1, test_outer_image = -1, test_backing_parent = -1, test_control_parent = -1, test_policy_fd = -1, test_namespace_fd = -1;
static struct test_issue test_issued[16];
static size_t test_issued_count;
static char test_origin_name[80];
static struct stat test_backing_dir_st;
static struct stat test_current_st;
static void test_fd_hash(int fd,char digest[65]);
static int test_format_tool(void) {
  if (test_tool < 0) return executable("/usr/sbin/mke2fs");
  char digest[65];test_fd_hash(test_tool,digest);require(!strcmp(digest,test_claim.tool_digest),"identity");
  int copy=fcntl(test_tool,F_DUPFD_CLOEXEC,20);ok(copy);return copy;
}
static struct stat test_claim_st;
static uint64_t test_max_generations, test_outer_bytes;
static pid_t test_owner_pid;
static bool test_initial_published;
static char test_pending_row[4096];

/* SHA-256 over exact bounded bytes; no provider/signing key or kernel crypto
 * module autoload. Native issuance digests remain correlations, never grants. */
static uint32_t test_rotate(uint32_t value,unsigned bits) { return (value>>bits) | (value<<(32-bits)); }
static void test_sha(const void *data,size_t length,char digest[65]) {
  static const uint32_t k[64]={
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
  uint32_t h[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  require(length<=16U*1024*1024,"exhausted");size_t padded=(length+9+63)/64*64;
  unsigned char *bytes=calloc(1,padded);require(bytes,"uncertain");if(length)memcpy(bytes,data,length);bytes[length]=0x80;
  uint64_t bits=(uint64_t)length*8;for(unsigned i=0;i<8;i++)bytes[padded-1-i]=(unsigned char)(bits>>(i*8));
  for(size_t offset=0;offset<padded;offset+=64) {
    uint32_t w[64];for(unsigned i=0;i<16;i++){const unsigned char *p=bytes+offset+i*4;w[i]=(uint32_t)p[0]<<24 | (uint32_t)p[1]<<16 | (uint32_t)p[2]<<8 | p[3];}
    for(unsigned i=16;i<64;i++){uint32_t x=w[i-15],y=w[i-2];w[i]=w[i-16]+(test_rotate(x,7)^test_rotate(x,18)^(x>>3))+w[i-7]+(test_rotate(y,17)^test_rotate(y,19)^(y>>10));}
    uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],j=h[7];
    for(unsigned i=0;i<64;i++){uint32_t t1=j+(test_rotate(e,6)^test_rotate(e,11)^test_rotate(e,25))+((e&f)^((~e)&g))+k[i]+w[i];
      uint32_t t2=(test_rotate(a,2)^test_rotate(a,13)^test_rotate(a,22))+((a&b)^(a&c)^(b&c));j=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
    h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=j;
  }
  free(bytes);for(unsigned i=0;i<8;i++)snprintf(digest+i*8,9,"%08" PRIx32,h[i]);
}
static void test_fd_hash(int fd,char digest[65]) {
  struct stat before,after;ok(fstat(fd,&before));require(S_ISREG(before.st_mode) && before.st_nlink==1 && before.st_uid==0 &&
    before.st_gid==0 && !(before.st_mode&0022) && !(before.st_mode&06000) && before.st_size>=4 && before.st_size<=16*1024*1024,"identity");
  char *bytes=malloc((size_t)before.st_size);require(bytes!=NULL,"uncertain");
  require(pread(fd,bytes,(size_t)before.st_size,0)==before.st_size && memcmp(bytes,"\177ELF",4)==0,"identity");
  test_sha(bytes,(size_t)before.st_size,digest);free(bytes);ok(fstat(fd,&after));
  require(before.st_dev==after.st_dev && before.st_ino==after.st_ino && before.st_size==after.st_size &&
    before.st_mtim.tv_sec==after.st_mtim.tv_sec && before.st_mtim.tv_nsec==after.st_mtim.tv_nsec &&
    before.st_ctim.tv_sec==after.st_ctim.tv_sec && before.st_ctim.tv_nsec==after.st_ctim.tv_nsec,"identity");
}
static uint64_t test_mount_id(int fd) {
  struct statx s;ok((int)syscall(SYS_statx,fd,"",AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,STATX_MNT_ID,&s));
  require(s.stx_mask & STATX_MNT_ID,"unsupported");return s.stx_mnt_id;
}
static void test_whole_root(void) {
  struct stat root;ok(fstat(SCRATCH,&root));require(S_ISDIR(root.st_mode) && root.st_uid==0 && root.st_gid==0 && !(root.st_mode&0022) && root.st_ino==2 && root.st_dev==test_claim.root_dev &&
    root.st_ino==test_claim.root_ino && test_mount_id(SCRATCH)==test_claim.root_mount,"identity");
  FILE *info=fopen("/proc/self/mountinfo","re");require(info!=NULL,"unsupported");
  char line[4096];size_t bytes=0,rows=0;bool found=false;
  while(fgets(line,sizeof(line),info)) {
    size_t n=strlen(line);require(++rows<=65536 && n<=16U*1024*1024-bytes && strchr(line,'\n'),"exhausted");bytes+=n;
    uint64_t id;unsigned major_,minor_;char mount_root[256];
    if(sscanf(line,"%" SCNu64 " %*u %u:%u %255s",&id,&major_,&minor_,mount_root)!=4)fail("identity");
    if(id!=test_claim.root_mount)continue;
    require(!strcmp(mount_root,"/") && major_==major(root.st_dev) && minor_==minor(root.st_dev) &&
      strstr(line," - ext4 ") && !strstr(line," shared:") && !strstr(line," master:") && !strstr(line," propagate_from:"),"identity");found=true;break;
  }
  require(!ferror(info) && found,"identity");fclose(info);
}
static void test_claim_check(void) {
  struct stat claim,visible,ns,control,helper,tool,block,backing,backing_dir,control_dir;ok(fstat(test_claim_fd,&claim));
  ok(fstatat(SCRATCH,TEST_CLAIM,&visible,AT_SYMLINK_NOFOLLOW));ok(stat("/proc/self/ns/mnt",&ns));struct stat retained_ns;ok(fstat(test_namespace_fd,&retained_ns));require(ns.st_ino==retained_ns.st_ino,"identity");ok(fstat(CONTROL,&control));
  ok(fstat(test_outer_image,&backing));ok(fstatat(test_backing_parent,test_origin_name,&backing_dir,AT_SYMLINK_NOFOLLOW));
  ok(fstatat(test_control_parent,test_origin_name,&control_dir,AT_SYMLINK_NOFOLLOW));
  require(backing.st_dev==test_claim.backing_dev && backing.st_ino==test_claim.backing_ino && (uint64_t)backing.st_size==test_claim.backing_bytes &&
    multiply(backing.st_blocks,512)>=test_claim.backing_bytes && backing_dir.st_dev==test_backing_dir_st.st_dev && backing_dir.st_ino==test_backing_dir_st.st_ino &&
    control_dir.st_dev==control.st_dev && control_dir.st_ino==control.st_ino,"identity");
  ok(fstat(6,&helper));ok(fstat(test_tool,&tool));ok(fstat(BLOCK,&block));
  require(test_claim.complete==1 && claim.st_dev==test_claim_st.st_dev && claim.st_ino==test_claim_st.st_ino &&
    visible.st_dev==claim.st_dev && visible.st_ino==claim.st_ino && claim.st_nlink==1 && claim.st_uid==0 && claim.st_gid==0 &&
    (claim.st_mode&07777)==0600 && claim.st_size==(off_t)sizeof(test_claim) && ns.st_ino==test_claim.namespace_ino &&
    control.st_dev==test_claim.control_dev && control.st_ino==test_claim.control_ino &&
    helper.st_dev==test_claim.helper_dev && helper.st_ino==test_claim.helper_ino &&
    tool.st_dev==test_claim.tool_dev && tool.st_ino==test_claim.tool_ino && block.st_rdev==test_claim.loop_dev,"identity");
  struct test_claim actual;require(pread(test_claim_fd,&actual,sizeof(actual),0)==sizeof(actual) && !memcmp(&actual,&test_claim,sizeof(actual)),"identity");
  struct stat policy;ok(fstat(test_policy_fd,&policy));char policy_bytes[TEST_POLICY_MAX];
  require(policy.st_dev==test_claim.policy_dev && policy.st_ino==test_claim.policy_ino && policy.st_size>0 && policy.st_size<TEST_POLICY_MAX &&
    policy.st_uid==0 && policy.st_gid==0 && policy.st_nlink==1 && (policy.st_mode&07777)==0400 &&
    pread(test_policy_fd,policy_bytes,(size_t)policy.st_size,0)==policy.st_size,"identity");
  char digest[65];test_sha(policy_bytes,(size_t)policy.st_size,digest);require(!strcmp(digest,test_claim.policy_digest),"identity");
  test_fd_hash(6,digest);require(!strcmp(digest,test_claim.helper_digest),"identity");
  test_fd_hash(test_tool,digest);require(!strcmp(digest,test_claim.tool_digest),"identity");
  char boot[37],filesystem[37],machine[33];text_file("/etc/machine-id",machine,sizeof(machine));text_file("/proc/sys/kernel/random/boot_id",boot,sizeof(boot));super_uuid(BLOCK,filesystem,true);
  require(!strcmp(machine,test_claim.machine) && !strcmp(boot,test_claim.boot) && !strcmp(filesystem,test_claim.filesystem),"identity");test_whole_root();
  struct loop_info64 loop;ok(ioctl(BLOCK,LOOP_GET_STATUS64,&loop));
  require(loop.lo_device==test_claim.backing_dev && loop.lo_inode==test_claim.backing_ino && loop.lo_offset==0 &&
    loop.lo_sizelimit==test_claim.backing_bytes && !(loop.lo_flags&(LO_FLAGS_AUTOCLEAR | LO_FLAGS_READ_ONLY)),"identity");
  struct stat visible_fence;ok(fstatat(CONTROL,"bounded-storage.fence",&visible_fence,AT_SYMLINK_NOFOLLOW));
  require(visible_fence.st_dev==test_claim.fence_dev && visible_fence.st_ino==test_claim.fence_ino,"identity");
}
static void test_live(void) {
  test_claim_check();
  if(test_owner_channel>=0) {
    require(getppid()==test_owner_pid,"uncertain");char ping='L';
    require(send(test_owner_channel,&ping,1,MSG_NOSIGNAL)==1,"uncertain");
    struct pollfd p={.fd=test_owner_channel,.events=POLLIN};require(poll(&p,1,2000)==1 && (p.revents&POLLIN),"uncertain");
    require(recv(test_owner_channel,&ping,1,0)==1 && ping=='L',"uncertain");
  }
}
static char test_owner_exchange(char message) {
  require(test_owner_channel>=0 && getppid()==test_owner_pid,"uncertain");
  require(send(test_owner_channel,&message,1,MSG_NOSIGNAL)==1,"uncertain");
  struct pollfd p={.fd=test_owner_channel,.events=POLLIN};require(poll(&p,1,2000)==1 && (p.revents&POLLIN),"uncertain");
  require(recv(test_owner_channel,&message,1,0)==1,"uncertain");return message;
}
static void test_issue_name(const char *generation,char name[80]) {
  require(uuid(generation),"invalid");snprintf(name,80,"test-issuance-%s",generation);
}
static void test_issue_read(const char *generation,struct test_issue *issue) {
  char name[80];test_issue_name(generation,name);size_t n;char *bytes=read_leaf(name,&n,false);
  require(n==sizeof(*issue),"identity");memcpy(issue,bytes,n);free(bytes);
  require(memchr(issue->generation,0,sizeof(issue->generation)) && memchr(issue->operation,0,sizeof(issue->operation)) && memchr(issue->job,0,sizeof(issue->job)) &&
    memchr(issue->receipt,0,sizeof(issue->receipt)) && memchr(issue->digest,0,sizeof(issue->digest)),"identity");
  require(!strcmp(issue->generation,generation) && issue->revision>0 && issue->revision<=test_max_generations &&
    memchr(issue->request,0,sizeof(issue->request)) && hex(issue->receipt,64) && hex(issue->digest,64),"identity");
  require(issue->revision<=test_issued_count && !memcmp(issue,&test_issued[issue->revision-1],sizeof(*issue)),"identity");
  char digest[65];test_sha(issue->request,strlen(issue->request),digest);require(!strcmp(digest,issue->digest),"identity");
  snprintf(name,sizeof(name),"test-canonical-%s",generation);bytes=read_leaf(name,&n,false);test_sha(bytes,n,digest);free(bytes);require(!strcmp(digest,issue->receipt),"identity");
}
static void require_test_owner_current(const struct test_issue *issue) {
  require(!memcmp(issue,&test_current,sizeof(*issue)),"conflict");
  held();struct stat visible,retained;ok(fstat(test_current_fd,&retained));ok(fstatat(CONTROL,"test-current-v1",&visible,AT_SYMLINK_NOFOLLOW));
  require(visible.st_dev==retained.st_dev && visible.st_ino==retained.st_ino && retained.st_dev==test_current_st.st_dev && retained.st_ino==test_current_st.st_ino,"identity");
  size_t n;char *bytes=read_leaf("test-current-v1",&n,false);
  require(n==sizeof(*issue) && !memcmp(bytes,issue,n),"conflict");free(bytes);
  struct test_issue historical;test_issue_read(issue->generation,&historical);require(!memcmp(&historical,issue,sizeof(historical)),"identity");
}
static void test_frame(size_t length,const char *digest) {
  require(test_mode && test_current_fd>=0 && length>0 && length<TEST_REQUEST_MAX && hex(digest,64),"invalid");
  char bytes[TEST_REQUEST_MAX];all_read(STDIN_FILENO,bytes,length);bytes[length]=0;
  size_t n;char *current=read_leaf("test-current-v1",&n,false);require(n==sizeof(test_authorized),"identity");memcpy(&test_authorized,current,n);free(current);
  require_test_owner_current(&test_authorized);
  require(strlen(test_authorized.request)==length && !memcmp(bytes,test_authorized.request,length) && !strcmp(digest,test_authorized.digest),"conflict");
  test_capability=true;
}
/* Canonical ledger decoder: no permissive JSON, escaping, extra keys or digest
 * substring search. Every request must equal an actual native issuance record. */
struct test_row { struct test_issue issue; uint64_t revision; unsigned phase; const char *facts; size_t facts_length; };
struct test_ledger { uint64_t revision; size_t count; struct test_row rows[16]; };
struct test_cursor { const char *at,*end; };
static void test_take(struct test_cursor *c,const char *literal) {
  size_t n=strlen(literal);require((size_t)(c->end-c->at)>=n && !memcmp(c->at,literal,n),"invalid");c->at+=n;
}
static uint64_t test_decimal(struct test_cursor *c) {
  char text[32];size_t n=0;while(c->at<c->end && *c->at>='0' && *c->at<='9') { require(n<sizeof(text)-1,"invalid");text[n++]=*c->at++; }
  text[n]=0;return number(text);
}
static const char *test_object_end(const char *start,const char *end) {
  require(start<end && *start=='{',"invalid");unsigned depth=0;bool quote=false;
  for(const char *p=start;p<end;p++) {
    require((unsigned char)*p>=32 && *p!='\\',"invalid");
    if(*p=='"')quote=!quote;
    if(quote)continue;
    if(*p=='{')require(++depth<=8,"invalid");
    if(*p=='}') { require(depth>0,"invalid");if(--depth==0)return p+1; }
  }
  fail("invalid");return NULL;
}
static void test_filesystem_json(char *bytes,size_t n) {
  int rc=snprintf(bytes,n,"{\"machineId\":\"%s\",\"uuid\":\"%s\",\"device\":\"%" PRIu64 "\"}",test_claim.machine,test_claim.filesystem,test_claim.root_dev);
  require(rc>0 && (size_t)rc<n,"exhausted");
}
static void test_decode_ledger(const char *bytes,size_t n,struct test_ledger *ledger) {
  memset(ledger,0,sizeof(*ledger));struct test_cursor c={bytes,bytes+n};char filesystem[256];test_filesystem_json(filesystem,sizeof(filesystem));
  test_take(&c,"{\"version\":1,\"filesystem\":");test_take(&c,filesystem);test_take(&c,",\"revision\":");ledger->revision=test_decimal(&c);
  test_take(&c,",\"reservations\":[");
  while(c.at<c.end && *c.at!=']') {
    require(ledger->count<test_max_generations && ledger->count<16,"exhausted");struct test_row *row=&ledger->rows[ledger->count++];
    test_take(&c,"{\"request\":");const char *start=c.at,*end=test_object_end(start,c.end);
    /* Request generation extraction only locates the native record. Exact full
     * byte comparison below supplies validation, including job/Q/P/E/binding. */
    const char *key="\"generationId\":\"";const char *g=memmem(start,(size_t)(end-start),key,strlen(key));require(g!=NULL,"invalid");
    g+=strlen(key);require(end-g>=37 && g[36]=='"',"invalid");char generation[37];memcpy(generation,g,36);generation[36]=0;
    test_issue_read(generation,&row->issue);require(strlen(row->issue.request)==(size_t)(end-start) && !memcmp(row->issue.request,start,(size_t)(end-start)),"conflict");c.at=end;
    test_take(&c,",\"requestSha256\":\"");test_take(&c,row->issue.digest);test_take(&c,"\",\"revision\":");row->revision=test_decimal(&c);
    test_take(&c,",\"phase\":\"");const char *phases[]={"pending","prepared","unknown","blocked"};bool matched=false;
    for(unsigned i=0;i<4;i++) {size_t l=strlen(phases[i]);if((size_t)(c.end-c.at)>l && !memcmp(c.at,phases[i],l) && c.at[l]=='"'){row->phase=i;c.at+=l;matched=true;break;}}
    require(matched && row->revision>0,"invalid");test_take(&c,"\",\"facts\":");row->facts=c.at;
    if(c.end-c.at>=4 && !memcmp(c.at,"null",4))c.at+=4;else c.at=test_object_end(c.at,c.end);
    row->facts_length=(size_t)(c.at-row->facts);require(row->phase!=0 || (row->revision==1 && row->facts_length==4 && !memcmp(row->facts,"null",4)),"invalid");
    test_take(&c,"}");for(size_t i=0;i+1<ledger->count;i++)require(strcmp(ledger->rows[i].issue.generation,row->issue.generation)!=0,"conflict");
    if(c.at<c.end && *c.at==','){c.at++;require(c.at<c.end && *c.at=='{',"invalid");}else break;
  }
  test_take(&c,"]}\n");require(c.at==c.end && ledger->revision>0,"invalid");
}
static void test_prepared_facts(const struct test_row *row,struct image_state *state) {
  int generation=generation_dir(state->generation,false),image=openat(generation,"backing.ext4",O_RDONLY | O_NOFOLLOW | O_CLOEXEC);ok(image);
  int loop=loop_open(state->loop),fs=openat(generation,"mount",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(fs);
  int payload=openat(fs,"payload",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(payload);
  image_check(image,state);loop_check(loop,state);root_identity(payload,state,false);struct dqblk q;quota_check(fs,state,&q);
  char inner[37];super_uuid(loop,inner,true);require(!strcmp(inner,state->inner_uuid),"identity");
  struct statvfs v;ok(fstatvfs(fs,&v));uint64_t free_bytes=multiply(v.f_bavail,v.f_frsize);require(free_bytes>=MAINTENANCE_BYTES && UINT64_MAX-q.dqb_curspace>=free_bytes,"identity");
  struct stat backing,block;ok(fstat(image,&backing));ok(fstat(loop,&block));char json[2048];
  int n=snprintf(json,sizeof(json),"{\"requestSha256\":\"%s\",\"backingDevice\":\"%" PRIu64 "\",\"backingInode\":\"%" PRIu64 "\",\"backingBytes\":\"%" PRIu64 "\",\"allocatedBytes\":\"%" PRIu64 "\",\"loopDevice\":\"%" PRIu64 "\",\"innerUuid\":\"%s\",\"payloadDevice\":\"%" PRIu64 "\",\"payloadInode\":\"%" PRIu64 "\",\"payloadMountId\":\"%" PRIu64 "\",\"nativeNamespaceInode\":\"%" PRIu64 "\",\"projectId\":%u,\"hardLimit\":{\"bytes\":\"%" PRIu64 "\",\"inodes\":\"%" PRIu64 "\"},\"usage\":{\"bytes\":\"%" PRIu64 "\",\"inodes\":\"%" PRIu64 "\"},\"reachable\":{\"bytes\":\"%" PRIu64 "\",\"inodes\":\"%" PRIu64 "\"}}",
    state->request_digest,state->backing_dev,state->backing_ino,state->physical,multiply(backing.st_blocks,512),(uint64_t)block.st_rdev,state->inner_uuid,state->payload_dev,state->payload_ino,state->mount_id,state->namespace_ino,state->project,state->q_bytes,state->q_inodes,(uint64_t)q.dqb_curspace,(uint64_t)q.dqb_curinodes,(uint64_t)(free_bytes+q.dqb_curspace-MAINTENANCE_BYTES),(uint64_t)v.f_favail+q.dqb_curinodes);
  require(n>0 && (size_t)n<sizeof(json) && row->facts_length==(size_t)n && !memcmp(row->facts,json,(size_t)n),"conflict");
  close(payload);close(fs);close(loop);close(image);close(generation);
}
static void test_publication(const char *old,size_t old_length,const char *next,size_t next_length) {
  struct test_ledger *before=calloc(1,sizeof(*before)),*after=calloc(1,sizeof(*after));require(before && after,"uncertain");
  if(old_length){test_decode_ledger(old,old_length,before);}
  test_decode_ledger(next,next_length,after);
  if(!old_length)require(!test_initial_published && !exists(CONTROL,"test-ledger-initialized") && after->count==0 && after->revision==1,"conflict");
  else require(after->revision==before->revision+1 && after->count>=before->count && after->count<=before->count+1,"conflict");
  uint64_t ebytes=0,einodes=0;test_pending_row[0]=0;
  for(size_t i=0;i<after->count;i++) {
    struct test_row *row=&after->rows[i];require(UINT64_MAX-ebytes>=row->issue.e_bytes && UINT64_MAX-einodes>=row->issue.e_inodes,"invalid");
    ebytes+=row->issue.e_bytes;einodes+=row->issue.e_inodes;
    if(i<before->count) {
      struct test_row *prior=&before->rows[i];require(!memcmp(&prior->issue,&row->issue,sizeof(row->issue)),"conflict");
      if(prior->revision==row->revision)require(prior->phase==row->phase && prior->facts_length==row->facts_length && !memcmp(prior->facts,row->facts,row->facts_length),"conflict");
      else {
        require(row->revision==prior->revision+1 && row->phase!=0,"conflict");
        struct image_state state;bool present=state_read(row->issue.generation,&state);
        if(row->phase==1)require(present && state.phase==N_PREPARED && state.test_revision==row->issue.revision && !strcmp(state.test_receipt,row->issue.receipt) && row->facts_length>4,"conflict");
        else require(row->facts_length==4 || (present && state.phase==N_PREPARED),"conflict");
        if(row->facts_length>4){require(present && state.phase==N_PREPARED,"conflict");test_prepared_facts(row,&state);}
      }
    } else {
      require(test_capability && !test_pending && row->phase==0 && !memcmp(&row->issue,&test_authorized,sizeof(row->issue)),"conflict");
      require_test_owner_current(&row->issue);
      snprintf(test_pending_row,sizeof(test_pending_row),"{\"request\":%s,\"requestSha256\":\"%s\",\"revision\":1,\"phase\":\"pending\",\"facts\":null}",row->issue.request,row->issue.digest);
    }
  }
  struct statvfs outer;ok(fstatvfs(SCRATCH,&outer));uint64_t available=multiply(outer.f_bavail,outer.f_frsize);
  require(available>=ebytes && available-ebytes>=ROOT_FLOOR_BYTES && outer.f_favail>=einodes && outer.f_favail-einodes>=50000,"capacity");root_headroom();
  free(before);free(after);
}
static void test_after_publication(void) {
  held();if(test_pending_row[0]) {require_test_owner_current(&test_authorized);test_pending=true;}
  if(!test_initial_published) {
    int fd=openat(CONTROL,"test-ledger-initialized",O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);ok(fd);
    all_write(fd,"1",1);ok(fsync(fd));close(fd);ok(fsync(CONTROL));require(test_owner_exchange('I')=='I',"uncertain");test_initial_published=true;
  }
}
static void test_prepare_current(const char *generation,const char *operation,const char *digest) {
  require(test_capability && test_pending && !strcmp(generation,test_authorized.generation) && !strcmp(operation,test_authorized.operation) &&
    !strcmp(digest,test_authorized.digest),"conflict");require_test_owner_current(&test_authorized);
  size_t n;char *bytes=read_leaf("bounded-storage-ledger.json",&n,false);struct test_ledger *ledger=malloc(sizeof(*ledger));require(ledger,"uncertain");
  test_decode_ledger(bytes,n,ledger);bool found=false;
  for(size_t i=0;i<ledger->count;i++)if(!strcmp(ledger->rows[i].issue.generation,generation)) {
    require(ledger->rows[i].phase==0 && !memcmp(&ledger->rows[i].issue,&test_authorized,sizeof(test_authorized)),"conflict");found=true;
  }
  require(found,"conflict");free(ledger);free(bytes);test_pending=false; /* once, before any effect */
}
static void test_empty_parent(int fd,struct stat *s) {
  ok(fstat(fd,s));require(S_ISDIR(s->st_mode) && s->st_uid==0 && s->st_gid==0 && (s->st_mode&07777)==0700,"identity");
  int copy=openat(fd,".",O_RDONLY | O_DIRECTORY | O_CLOEXEC);ok(copy);DIR *d=fdopendir(copy);require(d,"uncertain");struct dirent *entry;errno=0;
  while((entry=readdir(d)))require(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."),"conflict");
  require(errno==0,"uncertain");closedir(d);
}
static void test_write_new(const char *name,const void *data,size_t n) {
  root_headroom();int fd=openat(CONTROL,name,O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);ok(fd);private_file(fd,control_st.st_dev);
  all_write(fd,data,n);ok(fsync(fd));close(fd);ok(fsync(CONTROL));
}
static void test_issue_current(void) {
  held();no_intent();
  if(test_initial_published)require(exists(CONTROL,"test-ledger-initialized") && exists(CONTROL,"bounded-storage-ledger.json"),"uncertain");
  size_t n;char *prior=read_leaf("test-current-v1",&n,true);
  uint64_t revision=test_current.revision+1;
  if(test_current.revision){require(prior && n==sizeof(test_current) && !memcmp(prior,&test_current,n),"identity");require_test_owner_current(&test_current);}
  else require(!prior && !exists(CONTROL,"test-current.intent"),"identity");
  free(prior);
  require(revision<=test_max_generations,"exhausted");struct test_issue issue={.revision=revision,.project=500000+revision,
    .q_bytes=test_current.q_bytes,.q_inodes=test_current.q_inodes,.physical=test_current.physical,.e_bytes=test_current.e_bytes,.e_inodes=test_current.e_inodes};
  text_file("/proc/sys/kernel/random/uuid",issue.generation,sizeof(issue.generation));text_file("/proc/sys/kernel/random/uuid",issue.operation,sizeof(issue.operation));
  char job[37];text_file("/proc/sys/kernel/random/uuid",job,sizeof(job));require(uuid(job) && uuid(issue.generation) && uuid(issue.operation),"identity");snprintf(issue.job,sizeof(issue.job),"test-storage-b1-%s",job);
  require(test_issued_count==revision-1 && test_issued_count<16,"identity");
  for(size_t i=0;i<test_issued_count;i++)require(strcmp(test_issued[i].generation,issue.generation) && strcmp(test_issued[i].operation,issue.operation) && strcmp(test_issued[i].job,issue.job) && test_issued[i].project!=issue.project,"conflict");
  char filesystem[256],issuance[1024];test_filesystem_json(filesystem,sizeof(filesystem));
  int length=snprintf(issuance,sizeof(issuance),"TEST1\n%s\n%s\n%s\n%" PRIu64 "\n%s\n%s\n%" PRIu64 "\n%s\n%" PRIu64 "\n%s\n%" PRIu64 "\n%" PRIu64 "\n%" PRIu64 "\n%" PRIu64 "\n%" PRIu64 "\n",
    filesystem,test_claim.boot,test_claim.policy_digest,issue.revision,issue.job,issue.generation,issue.project,issue.operation,test_claim.namespace_ino,
    test_claim.helper_digest,issue.q_bytes,issue.q_inodes,issue.physical,issue.e_bytes,issue.e_inodes);
  require(length>0 && (size_t)length<sizeof(issuance),"exhausted");test_sha(issuance,(size_t)length,issue.receipt);
  length=snprintf(issue.request,sizeof(issue.request),"{\"backend\":\"ext4_project_image\",\"binding\":{\"filesystem\":%s,\"bootId\":\"%s\",\"policySha256\":\"%s\",\"admissionReceiptSha256\":\"%s\",\"admissionRevision\":%" PRIu64 "},\"generation\":{\"jobId\":\"%s\",\"generationId\":\"%s\",\"projectId\":%" PRIu64 "},\"operationId\":\"%s\",\"baseline\":{\"bytes\":\"0\",\"inodes\":\"0\"},\"growth\":{\"bytes\":\"%" PRIu64 "\",\"inodes\":\"%" PRIu64 "\"},\"cap\":{\"bytes\":\"%" PRIu64 "\",\"inodes\":\"%" PRIu64 "\"},\"physicalBytes\":\"%" PRIu64 "\",\"exposure\":{\"bytes\":\"%" PRIu64 "\",\"inodes\":\"%" PRIu64 "\"}}",
    filesystem,test_claim.boot,test_claim.policy_digest,issue.receipt,issue.revision,issue.job,issue.generation,issue.project,issue.operation,issue.q_bytes,issue.q_inodes,issue.q_bytes,issue.q_inodes,issue.physical,issue.e_bytes,issue.e_inodes);
  require(length>0 && (size_t)length<sizeof(issue.request),"exhausted");test_sha(issue.request,(size_t)length,issue.digest);
  char name[80];test_issue_name(issue.generation,name);test_write_new(name,&issue,sizeof(issue));
  snprintf(name,sizeof(name),"test-canonical-%s",issue.generation);test_write_new(name,issuance,strlen(issuance));
  test_write_new("test-current.intent",&issue,sizeof(issue));
  ok(renameat(CONTROL,"test-current.intent",CONTROL,"test-current-v1"));ok(fsync(CONTROL));test_current=issue;test_issued[test_issued_count++]=issue;
  if(test_current_fd>=0)close(test_current_fd);
  test_current_fd=openat(CONTROL,"test-current-v1",O_RDONLY | O_NOFOLLOW | O_CLOEXEC);ok(test_current_fd);ok(fstat(test_current_fd,&test_current_st));
  printf("CURRENT1 %d\n",length);all_write(STDOUT_FILENO,issue.request,(size_t)length);all_write(STDOUT_FILENO,"\n",1);
}
static void test_request_command(bool preparing,size_t length,const char *digest) {
  require(length>0 && length<TEST_REQUEST_MAX && hex(digest,64),"invalid");
  char bytes[TEST_REQUEST_MAX];all_read(STDIN_FILENO,bytes,length);bytes[length]=0;
  const char *key="\"generationId\":\"";char *g=memmem(bytes,length,key,strlen(key));require(g!=NULL,"invalid");g+=strlen(key);
  require(bytes+length-g>=37 && g[36]=='"',"invalid");char generation[37];memcpy(generation,g,36);generation[36]=0;
  struct test_issue issue;test_issue_read(generation,&issue);
  require(strlen(issue.request)==length && !memcmp(bytes,issue.request,length) && !strcmp(digest,issue.digest),"conflict");
  if(preparing) {
    require(!memcmp(&issue,&test_authorized,sizeof(issue)),"conflict");require_test_owner_current(&issue);
    char project[32],qbytes[32],qinodes[32],physical[32];snprintf(project,sizeof(project),"%" PRIu64,issue.project);
    snprintf(qbytes,sizeof(qbytes),"%" PRIu64,issue.q_bytes);snprintf(qinodes,sizeof(qinodes),"%" PRIu64,issue.q_inodes);snprintf(physical,sizeof(physical),"%" PRIu64,issue.physical);
    char *args[]={"PREPARE",issue.generation,issue.operation,issue.digest,project,qbytes,qinodes,physical,"0"};prepare(args,9);
  } else {
    size_t n;char *ledger=read_leaf("bounded-storage-ledger.json",&n,false);struct test_ledger *decoded=malloc(sizeof(*decoded));require(decoded,"uncertain");test_decode_ledger(ledger,n,decoded);
    bool found=false;for(size_t i=0;i<decoded->count;i++)if(!memcmp(&decoded->rows[i].issue,&issue,sizeof(issue)))found=true;
    require(found,"conflict");free(decoded);free(ledger);
    struct image_state state;if(state_read(issue.generation,&state))require(state.test_revision==issue.revision && !strcmp(state.test_receipt,issue.receipt),"identity");
    char *args[]={"INSPECT",issue.generation,issue.operation,issue.digest};inspect(args,4);
  }
}
static void test_acquire_fence(void) {
  /* Each fork opens a NEW description for flock; inherited owner description
   * would share the lock and make the contention assertion meaningless. */
  fence=openat(CONTROL,"bounded-storage.fence",O_RDWR | O_NOFOLLOW | O_CLOEXEC);ok(fence);ok(fstat(fence,&fence_st));
  printf("WAIT1 %ld %" PRIu64 " %" PRIu64 "\n",(long)getpid(),(uint64_t)fence_st.st_dev,(uint64_t)fence_st.st_ino);
  ok(flock(fence,LOCK_EX));
}
static int test_holder(void) {
  test_acquire_fence();held();no_intent();require(!exists(CONTROL,"test-current.intent"),"uncertain");registered_generations();
  char initialized=test_owner_exchange('S');require(initialized=='0' || initialized=='1',"identity");test_initial_published=initialized=='1';
  require(exists(CONTROL,"test-ledger-initialized")==test_initial_published && exists(CONTROL,"bounded-storage-ledger.json")==test_initial_published,"uncertain");
  printf("HELD1 %" PRIu64 " %" PRIu64 "\n",(uint64_t)fence_st.st_dev,(uint64_t)fence_st.st_ino);
  char line[1024];
  while(fgets(line,sizeof(line),stdin)) {
    require(strchr(line,'\n'),"invalid");char *a[16],*save;size_t n=0;
    for(char *token=strtok_r(line," \n",&save);token;token=strtok_r(NULL," \n",&save)){require(n<16,"invalid");a[n++]=token;}
    require(n>0,"invalid");held();
    if(!strcmp(a[0],"END")){require(n==1,"invalid");return 0;}
    if(!strcmp(a[0],"ASSERT")){require(n==1,"invalid");puts("OK1");}
    else if(!strcmp(a[0],"CAPABILITY")){require(n==3,"invalid");test_frame((size_t)number(a[1]),a[2]);private_scratch_mount();puts("CAPABLE1");}
    else if(!strcmp(a[0],"CAPACITY")){require(n==1,"invalid");capacity();}
    else if(!strcmp(a[0],"READ")){require(n==1,"invalid");no_intent();size_t length;char *bytes=read_leaf("bounded-storage-ledger.json",&length,true);printf("LEDGER1 %zu\n",length);if(bytes){all_write(STDOUT_FILENO,bytes,length);free(bytes);}all_write(STDOUT_FILENO,"\n",1);}
    else if(!strcmp(a[0],"PUBLISH")){require(n==3,"invalid");publish((size_t)number(a[1]),(size_t)number(a[2]));}
    else if(!strcmp(a[0],"PREPARE_TEST")){require(n==3,"invalid");test_request_command(true,(size_t)number(a[1]),a[2]);}
    else if(!strcmp(a[0],"INSPECT_TEST")){require(n==3,"invalid");test_request_command(false,(size_t)number(a[1]),a[2]);}
    else fail("invalid");
  }
  fail("uncertain");return 2;
}
int main(int argc,char **argv);
static int new_test_owner(int argc,char **argv) {
  require(argc==2 && !strcmp(argv[1],"--new-test-owner-fd-session-v1"),"invalid");
  require(getuid()==0 && geteuid()==0 && getgid()==0 && getegid()==0,"identity");umask(077);setvbuf(stdout,NULL,_IONBF,0);setvbuf(stdin,NULL,_IONBF,0);
  test_owner_pid=getpid();pid_t parent=getppid();ok(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0));require(parent>1 && getppid()==parent,"uncertain");
  struct stat user,old_ns;ok(stat("/proc/self/ns/user",&user));ok(stat("/proc/self/ns/mnt",&old_ns));require(user.st_ino==4026531837ULL,"unsupported");
  /* Validate finite closed policy BEFORE any physical effect. */
  struct stat policy;ok(fstat(5,&policy));require(S_ISREG(policy.st_mode) && policy.st_uid==0 && policy.st_gid==0 && policy.st_nlink==1 &&
    (policy.st_mode&07777)==0400 && policy.st_size>0 && policy.st_size<TEST_POLICY_MAX,"identity");
  test_policy_fd=fcntl(5,F_DUPFD_CLOEXEC,20);ok(test_policy_fd);test_claim.policy_dev=policy.st_dev;test_claim.policy_ino=policy.st_ino;
  char policy_bytes[TEST_POLICY_MAX];require(pread(5,policy_bytes,(size_t)policy.st_size,0)==policy.st_size,"identity");policy_bytes[policy.st_size]=0;
  uint64_t qbytes,qinodes;int consumed=0;
  require(sscanf(policy_bytes,"{\"purpose\":\"" TEST_POLICY "\",\"maxGenerations\":%" SCNu64 ",\"qBytes\":\"%" SCNu64 "\",\"qInodes\":\"%" SCNu64 "\",\"outerBytes\":\"%" SCNu64 "\"}%n",
    &test_max_generations,&qbytes,&qinodes,&test_outer_bytes,&consumed)==4 && consumed==policy.st_size,"invalid");
  require(test_max_generations>0 && test_max_generations<=16 && qbytes>0 && qbytes<=1073741824 && qbytes%1024==0 &&
    qinodes>8 && qinodes<=65536 && test_outer_bytes%4096==0 && test_outer_bytes<=UINT64_C(68719476736),"invalid");
  char canonical_policy[TEST_POLICY_MAX];int policy_length=snprintf(canonical_policy,sizeof(canonical_policy),"{\"purpose\":\"" TEST_POLICY "\",\"maxGenerations\":%" PRIu64 ",\"qBytes\":\"%" PRIu64 "\",\"qInodes\":\"%" PRIu64 "\",\"outerBytes\":\"%" PRIu64 "\"}",test_max_generations,qbytes,qinodes,test_outer_bytes);
  require(policy_length==policy.st_size && !memcmp(canonical_policy,policy_bytes,(size_t)policy_length),"invalid");
  uint64_t physical=(qbytes+qbytes/64+qinodes*512+335544320+4095)/4096*4096;
  test_current.q_bytes=qbytes;test_current.q_inodes=qinodes;test_current.physical=physical;test_current.e_bytes=physical+1048576;test_current.e_inodes=qinodes+16;
  require(test_outer_bytes>=ROOT_FLOOR_BYTES+multiply(test_max_generations,physical+test_current.e_bytes)+UINT64_C(1073741824),"capacity");
  test_sha(policy_bytes,(size_t)policy.st_size,test_claim.policy_digest);
  int backing_parent=fcntl(3,F_DUPFD_CLOEXEC,20),control_parent=fcntl(4,F_DUPFD_CLOEXEC,20);ok(backing_parent);ok(control_parent);
  test_backing_parent=backing_parent;test_control_parent=control_parent;
  struct stat bp,cp;test_empty_parent(backing_parent,&bp);test_empty_parent(control_parent,&cp);require(bp.st_dev!=cp.st_dev,"identity");
  struct statfs backing_fs;ok(fstatfs(backing_parent,&backing_fs));require(backing_fs.f_type==EXT4_SUPER_MAGIC,"unsupported");
  struct statvfs hosting,control_v;ok(fstatvfs(backing_parent,&hosting));ok(fstatvfs(control_parent,&control_v));
  require(multiply(hosting.f_bavail,hosting.f_frsize)>=test_outer_bytes+ROOT_FLOOR_BYTES && hosting.f_favail>=50016 &&
    multiply(control_v.f_bavail,control_v.f_frsize)>=ROOT_FLOOR_BYTES+ROOT_PUBLICATION_BYTES && control_v.f_favail>=50000+test_max_generations*8+16,"capacity");
  test_fd_hash(6,test_claim.helper_digest);struct stat helper;ok(fstat(6,&helper));test_claim.helper_dev=helper.st_dev;test_claim.helper_ino=helper.st_ino;
  test_tool=executable("/usr/sbin/mke2fs");test_fd_hash(test_tool,test_claim.tool_digest);struct stat tool;ok(fstat(test_tool,&tool));test_claim.tool_dev=tool.st_dev;test_claim.tool_ino=tool.st_ino;
  require(access("/sys/module/loop",F_OK)==0 && access("/sys/module/quota_v2",F_OK)==0,"unsupported");
  int loop_control=open("/dev/loop-control",O_RDWR | O_NOFOLLOW | O_CLOEXEC);ok(loop_control);struct stat lc;ok(fstat(loop_control,&lc));require(S_ISCHR(lc.st_mode) && lc.st_uid==0 && lc.st_rdev==makedev(10,237),"identity");
  uint32_t quota_format=0;errno=0;long quota_rc=syscall(SYS_quotactl_fd,control_parent,QCMD(Q_GETFMT,PRJQUOTA),0,&quota_format);
  require(quota_rc>=0 || (errno!=ENOSYS && errno!=EPERM),"unsupported");
  text_file("/etc/machine-id",test_claim.machine,sizeof(test_claim.machine));text_file("/proc/sys/kernel/random/boot_id",test_claim.boot,sizeof(test_claim.boot));require(hex(test_claim.machine,32) && uuid(test_claim.boot),"identity");
  ok(unshare(CLONE_NEWNS));ok(mount(NULL,"/",NULL,MS_REC | MS_PRIVATE,NULL));struct stat ns;ok(stat("/proc/self/ns/mnt",&ns));require(ns.st_ino!=old_ns.st_ino,"identity");test_claim.namespace_ino=ns.st_ino;test_namespace_fd=open("/proc/self/ns/mnt",O_RDONLY | O_CLOEXEC);ok(test_namespace_fd);
  char origin[37],name[80];text_file("/proc/sys/kernel/random/uuid",origin,sizeof(origin));require(uuid(origin),"identity");snprintf(name,sizeof(name),"test-storage-b1-%s",origin);
  strcpy(test_origin_name,name);
  int backing_dir=private_dir(backing_parent,name,true,bp.st_dev),control_dir=private_dir(control_parent,name,true,cp.st_dev);ok(fsync(backing_parent));ok(fsync(control_parent));
  ok(fstat(backing_dir,&test_backing_dir_st));
  ok(dup2(control_dir,CONTROL));close(control_dir);ok(fstat(CONTROL,&control_st));
  /* Retained, durable incomplete creation intent precedes backing and loop. */
  test_claim.magic=TEST_MAGIC;test_claim.control_dev=control_st.st_dev;test_claim.control_ino=control_st.st_ino;
  test_write_new("test-origin.intent",&test_claim,sizeof(test_claim));
  int image=openat(backing_dir,"outer.ext4",O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);ok(image);test_outer_image=image;private_file(image,bp.st_dev);
  int rc=posix_fallocate(image,0,(off_t)test_outer_bytes);if(rc){errno=rc;fail("uncertain");}ok(fsync(image));ok(fsync(backing_dir));
  struct stat image_st;ok(fstat(image,&image_st));require((uint64_t)image_st.st_size==test_outer_bytes && multiply(image_st.st_blocks,512)>=test_outer_bytes,"identity");
  ok(fstatvfs(backing_parent,&hosting));require(multiply(hosting.f_bavail,hosting.f_frsize)>=ROOT_FLOOR_BYTES && hosting.f_favail>=50000,"capacity");
  int loop_number=ioctl(loop_control,LOOP_CTL_GET_FREE);ok(loop_number);close(loop_control);int loop=loop_open((uint32_t)loop_number);
  struct loop_config config={.fd=(uint32_t)image,.block_size=4096};config.info.lo_sizelimit=test_outer_bytes;ok(ioctl(loop,LOOP_CONFIGURE,&config));
  struct image_state outer={.loop=(uint32_t)loop_number,.physical=test_outer_bytes,.backing_dev=image_st.st_dev,.backing_ino=image_st.st_ino,
    .q_inodes=50000+test_max_generations*(qinodes+32)};
  text_file("/proc/sys/kernel/random/uuid",outer.inner_uuid,sizeof(outer.inner_uuid));loop_check(loop,&outer);format(backing_dir,loop,&outer);
  rc=posix_fallocate(image,0,(off_t)test_outer_bytes);if(rc){errno=rc;fail("uncertain");}ok(fsync(image));ok(fstat(image,&image_st));require(multiply(image_st.st_blocks,512)>=test_outer_bytes,"identity");
  int lower=private_dir(backing_dir,"outer",true,bp.st_dev);char source[64],target[64];snprintf(source,sizeof(source),"/proc/self/fd/%d",loop);snprintf(target,sizeof(target),"/proc/self/fd/%d",lower);
  ok(mount(source,target,"ext4",MS_NOSUID | MS_NODEV | MS_NOATIME,"prjquota,nodiscard"));close(lower);
  int root=openat(backing_dir,"outer",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(root);ok(dup2(root,SCRATCH));close(root);ok(dup2(loop,BLOCK));
  ok(fstat(SCRATCH,&scratch_st));struct stat block;ok(fstat(BLOCK,&block));struct stat root_st;ok(stat("/",&root_st));
  require(scratch_st.st_dev==block.st_rdev && scratch_st.st_dev!=bp.st_dev && scratch_st.st_dev!=cp.st_dev && scratch_st.st_dev!=root_st.st_dev,"identity");
  test_claim.root_dev=scratch_st.st_dev;test_claim.root_ino=scratch_st.st_ino;test_claim.root_mount=test_mount_id(SCRATCH);
  test_claim.backing_dev=image_st.st_dev;test_claim.backing_ino=image_st.st_ino;test_claim.backing_bytes=test_outer_bytes;test_claim.loop_dev=block.st_rdev;
  super_uuid(BLOCK,test_claim.filesystem,true);require(!strcmp(test_claim.filesystem,outer.inner_uuid),"identity");test_whole_root();private_scratch_mount();
  struct statvfs geometry;ok(fstatvfs(SCRATCH,&geometry));
  require(multiply(geometry.f_bavail,geometry.f_frsize)>=ROOT_FLOOR_BYTES+multiply(test_max_generations,physical+test_current.e_bytes) &&
    geometry.f_favail>=50000+multiply(test_max_generations,test_current.e_inodes+8)+16,"geometry");
  ok(fstatvfs(backing_parent,&hosting));require(multiply(hosting.f_bavail,hosting.f_frsize)>=ROOT_FLOOR_BYTES && hosting.f_favail>=50000,"capacity");
  require(!exists(SCRATCH,".bounded-storage") && !exists(SCRATCH,"filesystem-exposure.json") && !exists(CONTROL,"filesystem-exposure.json"),"conflict");
  test_claim_fd=openat(SCRATCH,TEST_CLAIM,O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);ok(test_claim_fd);private_file(test_claim_fd,scratch_st.st_dev);
  all_write(test_claim_fd,&test_claim,sizeof(test_claim));ok(fsync(test_claim_fd));ok(fsync(SCRATCH)); /* incomplete claim is already durable */
  fence=openat(CONTROL,"bounded-storage.fence",O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);ok(fence);private_file(fence,control_st.st_dev);
  ok(fsync(fence));ok(fsync(CONTROL));ok(fstat(fence,&fence_st));test_claim.fence_dev=fence_st.st_dev;test_claim.fence_ino=fence_st.st_ino;
  test_claim.complete=1;require(pwrite(test_claim_fd,&test_claim,sizeof(test_claim),0)==sizeof(test_claim),"uncertain");ok(fsync(test_claim_fd));ok(fsync(SCRATCH));ok(fstat(test_claim_fd,&test_claim_st));
  test_write_new("test-origin-complete",&test_claim,sizeof(test_claim)); /* retain incomplete intent as evidence, never adoption */
  int competing=private_dir(CONTROL,"test-competing-control",true,control_st.st_dev);close(competing);ok(fsync(CONTROL));
  test_mode=true;test_claim_check();
  printf("OWNER1 %s %s %" PRIu64 " %s %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",test_claim.machine,test_claim.filesystem,test_claim.root_dev,test_claim.boot,test_claim.namespace_ino,test_claim.fence_dev,test_claim.fence_ino,(uint64_t)test_claim_st.st_ino);
  /* Poll only invocation-owned inherited ingress and owner-created socketpairs.
   * No named/listening socket, registry, PID lease, TTL or replacement process. */
  pid_t completed[256]={0};size_t completed_count=0;
  pid_t children[TEST_CHANNELS]={0};int owners[TEST_CHANNELS];for(size_t i=0;i<TEST_CHANNELS;i++)owners[i]=-1;
  struct timespec started;ok(clock_gettime(CLOCK_MONOTONIC,&started));unsigned holder_count=0;
  for(;;) {
    struct timespec now;ok(clock_gettime(CLOCK_MONOTONIC,&now));require(now.tv_sec-started.tv_sec<3600,"exhausted");struct pollfd polls[1+TEST_CHANNELS*2];polls[0]=(struct pollfd){.fd=STDIN_FILENO,.events=POLLIN};
    for(size_t i=0;i<TEST_CHANNELS;i++){polls[1+i]=(struct pollfd){.fd=children[i]? -1:7+(int)i,.events=POLLIN};polls[1+TEST_CHANNELS+i]=(struct pollfd){.fd=owners[i],.events=POLLIN};}
    int ready=poll(polls,1+TEST_CHANNELS*2,1000);if(ready<0 && errno==EINTR)continue;ok(ready);
    for(size_t i=0;i<TEST_CHANNELS;i++)if(owners[i]>=0 && (polls[1+TEST_CHANNELS+i].revents&POLLIN)) {
      char ping;ssize_t got=recv(owners[i],&ping,1,0);if(got==1){require(ping=='L' || ping=='I' || ping=='S',"identity");test_claim_check();
        if(ping=='I') {
          require(!test_initial_published && exists(CONTROL,"test-ledger-initialized") && exists(CONTROL,"bounded-storage-ledger.json") && !exists(CONTROL,"bounded-storage.intent"),"uncertain");
          int marker=openat(CONTROL,"test-ledger-initialized",O_RDONLY | O_NOFOLLOW | O_CLOEXEC);ok(marker);private_file(marker,control_st.st_dev);char byte;require(read(marker,&byte,1)==1 && byte=='1' && read(marker,&byte,1)==0,"identity");close(marker);
          test_initial_published=true;
        } else if(ping=='S')ping=test_initial_published?'1':'0';
        require(send(owners[i],&ping,1,MSG_NOSIGNAL)==1,"uncertain");}
    }
    for(size_t i=0;i<TEST_CHANNELS;i++)if(children[i]) {
      int status;pid_t done=waitpid(children[i],&status,WNOHANG);if(done==children[i]) {
        char exit_line[64];int n=snprintf(exit_line,sizeof(exit_line),"EXIT1 %d\n",WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status));all_write(7+(int)i,exit_line,(size_t)n);
        require(completed_count<256,"exhausted");completed[completed_count++]=children[i];
        close(owners[i]);owners[i]=-1;children[i]=0;
      }
    }
    if(polls[0].revents&(POLLIN | POLLHUP)) {
      char line[80];if(!fgets(line,sizeof(line),stdin))break;
      require(strchr(line,'\n'),"invalid");
      if(!strcmp(line,"ADMIT\n")) {
        for(size_t i=0;i<TEST_CHANNELS;i++){require(!children[i],"conflict");}
        ok(flock(fence,LOCK_EX));test_issue_current();ok(flock(fence,LOCK_UN));
      } else if(!strcmp(line,"CLOSE\n"))break;
      else if(!strncmp(line,"KILL ",5)) {
        char *end=strchr(line+5,'\n');*end=0;pid_t pid=(pid_t)number(line+5);bool found=false;
        for(size_t i=0;i<TEST_CHANNELS;i++)if(children[i]==pid){ok(kill(pid,SIGKILL));found=true;}
        if(found)puts("OK1");else {
          for(size_t i=0;i<completed_count;i++)if(completed[i]==pid)found=true;
          require(found,"identity");puts("DONE1");
        }
      } else fail("invalid");
    }
    for(size_t i=0;i<TEST_CHANNELS;i++)if(!children[i] && (polls[1+i].revents&POLLIN)) {
      char begin[6];all_read(7+(int)i,begin,sizeof(begin));bool alternate_control=!memcmp(begin,"ROOT2\n",6),subtree=!memcmp(begin,"SUBFS\n",6),legacy=!memcmp(begin,"LEGAC\n",6);
      require((!memcmp(begin,"BEGIN\n",6) || alternate_control || subtree || legacy) && ++holder_count<=256,"exhausted");
      int pair[2];ok(socketpair(AF_UNIX,SOCK_SEQPACKET | SOCK_CLOEXEC,0,pair));pid_t child=fork();ok(child);
      if(!child) {
        close(pair[0]);test_owner_channel=pair[1];ok(prctl(PR_SET_PDEATHSIG,SIGKILL,0,0,0));require(getppid()==test_owner_pid,"uncertain");
        ok(dup2(7+(int)i,STDIN_FILENO));ok(dup2(7+(int)i,STDOUT_FILENO));
        for(size_t j=0;j<TEST_CHANNELS;j++){close(7+(int)j);if(owners[j]>=0)close(owners[j]);}
        printf("START1 %ld\n",(long)getpid());
        if(legacy){close(test_owner_channel);test_owner_channel=-1;test_mode=false;char *args[]={"storage-native","--registered-fd-session-v1",test_claim.machine,test_claim.filesystem};exit(main(4,args));}
        if(alternate_control){int candidate=openat(CONTROL,"test-competing-control",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(candidate);ok(dup2(candidate,CONTROL));close(candidate);}
        if(subtree){int candidate=openat(SCRATCH,"lost+found",O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);ok(candidate);ok(dup2(candidate,SCRATCH));close(candidate);}
        test_claim_check(); /* before any fence creation/acquisition */
        close(fence);fence=-1;exit(test_holder());
      }
      close(pair[1]);owners[i]=pair[0];children[i]=child;
    }
  }
  /* End only our proven fork children. Keep every physical/control object. */
  for(size_t i=0;i<TEST_CHANNELS;i++)if(children[i]){ok(kill(children[i],SIGKILL));int status;require(waitpid(children[i],&status,0)==children[i],"uncertain");}
  puts("CLOSED1");close(backing_parent);close(control_parent);close(backing_dir);close(image);close(loop);return 0;
}
