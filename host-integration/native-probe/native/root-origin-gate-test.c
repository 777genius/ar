#define _GNU_SOURCE
#include "root-producer-native.h"
#include "root-managed-launch.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static uint64_t now(void){
  struct timespec t;
  assert(!clock_gettime(CLOCK_MONOTONIC,&t));
  return (uint64_t)t.tv_sec*NP_ORIGIN_SECOND+(uint64_t)t.tv_nsec;
}
static void expect_mutex(pthread_mutex_t *mutex,uint64_t end,int expected,const char *phase) {
  uint64_t before=now();
  int result=np_origin_mutex_take_v1(mutex,end);
  if(result!=expected)fprintf(stderr,"mutex-result: phase=%s rc=%d expected=%d before=%llu after=%llu end=%llu\n",phase,result,expected,(unsigned long long)before,(unsigned long long)now(),(unsigned long long)end);
  assert(result==expected);
}
static uint64_t fixture_end;
static void owned_child(pid_t parent) {
  /* An assertion in the original fixture parent cannot strand a pipe holder. */
  assert(!prctl(PR_SET_PDEATHSIG,SIGKILL));
  if(getppid()!=parent)_exit(78);
}
static ssize_t read_one(int fd,char *byte) {
  for(;;){
    if(now()>=fixture_end){errno=ETIMEDOUT;return -1;}
    struct pollfd p={.fd=fd,.events=POLLIN};
    int ready=poll(&p,1,10);
    if(ready>0)return read(fd,byte,1);
    if(ready<0&&errno!=EINTR)return -1;
  }
}
static pid_t wait_original(pid_t child,int *status) {
  for(;;){
    pid_t result=waitpid(child,status,WNOHANG);
    if(result==child||result<0)return result;
    if(now()>=fixture_end){errno=ETIMEDOUT;return -1;}
    struct timespec nap={.tv_nsec=1000000};
    (void)nanosleep(&nap,NULL);
  }
}
static int cgroup_data_read(const void *bytes,size_t length,const char *group) {
  int fd=memfd_create("scope-cgroup-DATA",MFD_CLOEXEC);
  assert(fd>=0&&write(fd,bytes,length)==(ssize_t)length&&lseek(fd,0,SEEK_SET)==0);
  int result=np_managed_cgroup_read_v1(fd,group);
  close(fd);
  return result;
}
static void cgroup_data_contract(void) {
  /* Red: the old whole-file comparison refuses a healthy mixed hierarchy,
   * or a prefix read/NUL accepts incomplete, ambiguous or foreign DATA.
   * These actual decoder/descriptor reads construct no Root success. */
  const char *group="/system.slice/native-original-data.scope";
  const char *valid[]={"0::/system.slice/native-original-data.scope\n",
    "1:name=systemd:/\n0::/system.slice/native-original-data.scope\n",
    "0::/system.slice/native-original-data.scope\n2:cpu,cpuacct:/\n1:name=systemd:/init.scope\n"};
  for(size_t i=0;i<sizeof valid/sizeof *valid;i++){
    assert(!np_managed_cgroup_bytes_v1(valid[i],strlen(valid[i]),group));
    assert(!cgroup_data_read(valid[i],strlen(valid[i]),group));
  }
  const char *invalid[]={"", "1:name=systemd:/system.slice/native-original-data.scope\n",
    "0::/system.slice/native-original-data.scope\n0::/system.slice/native-original-data.scope\n",
    "0::/system.slice/native-original-data.scope\n0::/\n",
    "0::/\n0::/system.slice/native-original-data.scope\n",
    "1:name=systemd:/system.slice/native-original-data.scope\n0::/foreign.scope\n",
    "0::/system.slice/native-original-data.scope/payload\n",
    "0::/system.slice/native-original-data.scope.other\n",
    "0::/system.slice/../system.slice/native-original-data.scope\n",
    "0:name=systemd:/system.slice/native-original-data.scope\n",
    "0::\n", "0::relative\n", "00::/system.slice/native-original-data.scope\n",
    "1::/\n0::/system.slice/native-original-data.scope\n",
    "1:cpu,,cpuacct:/\n0::/system.slice/native-original-data.scope\n",
    "1:cpu,:/\n0::/system.slice/native-original-data.scope\n",
    "1:name=:/\n0::/system.slice/native-original-data.scope\n",
    "1:name=systemd\n0::/system.slice/native-original-data.scope\n",
    "0::/system.slice/native-original-data.scope\n\n",
    "0::/system.slice/native-original-data.scope\r\n",
    "0::/system.slice/native-original-data.scope", /* Truncated final row. */
    "0::/system.slice/native-original-data.scope\n1:name=systemd"};
  for(size_t i=0;i<sizeof invalid/sizeof *invalid;i++){
    assert(np_managed_cgroup_bytes_v1(invalid[i],strlen(invalid[i]),group)==-1);
    assert(cgroup_data_read(invalid[i],strlen(invalid[i]),group)==-1);
  }
  const char nul[]="0::/system.slice/native-original-data.scope\n\0hidden\n";
  assert(np_managed_cgroup_bytes_v1(nul,sizeof nul-1,group)==-1);
  assert(cgroup_data_read(nul,sizeof nul-1,group)==-1);
  assert(np_managed_cgroup_bytes_v1(valid[0],strlen(valid[0]),"/system.slice/other.scope")==-1);
  assert(np_managed_cgroup_read_v1(-1,group)==-1);
  /* A full buffer is admissible only after the original descriptor EOF. */
  unsigned char capacity[NP_MANAGED_CGROUP_BYTES];
  size_t at=strlen(valid[0]);memcpy(capacity,valid[0],at);
  const char named[]="1:name=systemd:/";
  memcpy(capacity+at,named,sizeof named-1);at+=sizeof named-1;
  memset(capacity+at,'x',sizeof capacity-at);capacity[sizeof capacity-1]='\n';
  assert(!np_managed_cgroup_bytes_v1(capacity,sizeof capacity,group));
  assert(!cgroup_data_read(capacity,sizeof capacity,group));
  unsigned char large[NP_MANAGED_CGROUP_BYTES+64];
  size_t used=strlen(valid[0]);memcpy(large,valid[0],used);
  const char supplement[]="1:name=systemd:/\n";
  while(used<=NP_MANAGED_CGROUP_BYTES){
    memcpy(large+used,supplement,sizeof supplement-1);used+=sizeof supplement-1;
  }
  assert(np_managed_cgroup_bytes_v1(large,used,group)==-1);
  assert(cgroup_data_read(large,used,group)==-1);
}
int main(int argc,char **argv) {
  fixture_end=now()+4*NP_ORIGIN_SECOND;
  /* Test-only real orphaned pipe holder: the MTS runner must bound this
   * known failure without claiming any original Native closure. */
  if(argc==2&&!strcmp(argv[1],"orphan-pipe")){
    int ready[2];assert(!pipe(ready));
    pid_t holder=fork();assert(holder>=0);
    if(!holder){close(ready[0]);assert(write(ready[1],"R",1)==1);pause();_exit(1);}
    close(ready[1]);char byte;assert(read_one(ready[0],&byte)==1&&byte=='R');
    close(ready[0]);puts("orphan-pipe-holder-ready");fflush(stdout);_exit(77);
  }
  assert(argc==1);
  alarm(6);
  fputs("gate-stage: cgroup-membership-DATA\n",stderr);
  cgroup_data_contract();
  pid_t parent=getpid();
  fputs("gate-stage: robust-owner-death\n",stderr);
  /* Red if the selected actual fork path loses robust owner-death state or
  * retries a lock with a renewed allowance. This is no NativeRoot fixture. */
  pthread_mutex_t *mutex=mmap(NULL,sizeof *mutex,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  assert(mutex!=MAP_FAILED);
  assert(!np_origin_mutex_init_v1(mutex));
  int pipefd[2];
  assert(!pipe(pipefd));
  pid_t child=fork();
  assert(child>=0);
  if(!child){
    owned_child(parent);
    close(pipefd[0]);
    assert(!np_origin_mutex_take_v1(mutex,now()+NP_ORIGIN_SECOND));
    assert(write(pipefd[1],"L",1)==1);
    pause();
    _exit(1);
  }
  close(pipefd[1]);
  struct pollfd held={
    .fd=pipefd[0],.events=POLLIN}
  ;
  assert(poll(&held,1,2000)==1);
  char byte;
  assert(read_one(pipefd[0],&byte)==1&&byte=='L');
  uint64_t start=now(),end=start+UINT64_C(50000000);
  assert(np_origin_mutex_take_v1(mutex,end)==ETIMEDOUT);
  assert(now()>=end&&now()-start<NP_ORIGIN_SECOND);
  assert(!kill(child,SIGKILL));
  int status;
  assert(wait_original(child,&status)==child&&WIFSIGNALED(status));
  assert(read_one(pipefd[0],&byte)==0);
  assert(np_origin_mutex_take_v1(mutex,now()+NP_ORIGIN_SECOND)==EOWNERDEAD);
  /* Deliberately omit consistent(): this original gate is never repaired. */
  assert(!pthread_mutex_unlock(mutex));
  expect_mutex(mutex,now()+NP_ORIGIN_SECOND,ENOTRECOVERABLE,"initial-unrecoverable");
  close(pipefd[0]);
  fputs("gate-stage: independent-cleanup\n",stderr);
  /* Red on the previous gate-dependent cleanup: ENOTRECOVERABLE must not
   * prevent original-cutoff observation, exact child signal/wait and pipe EOF.
   * These kernel primitives construct no NativeRoot or privileged success. */
  struct np_clock clock={.time=open("/proc/self/ns/time",O_RDONLY|O_CLOEXEC),.children=open("/proc/self/ns/time_for_children",O_RDONLY|O_CLOEXEC),.mount=open("/proc/self/ns/mnt",O_RDONLY|O_CLOEXEC)};
  int boot=open("/proc/sys/kernel/random/boot_id",O_RDONLY|O_CLOEXEC);
  char boot_id[37]={0};
  assert(boot>=0&&pread(boot,boot_id,36,0)==36);
  assert(!pipe(pipefd));
  child=fork();
  assert(child>=0);
  if(!child){owned_child(parent);close(pipefd[0]);
  pause();
  _exit(1);
  }
  close(pipefd[1]);
  int pidfd=(int)syscall(SYS_pidfd_open,child,0);
  assert(pidfd>=0);
  uint64_t high_water=now(),cutoff=high_water+NP_ORIGIN_SECOND,sample;
  expect_mutex(mutex,cutoff,ENOTRECOVERABLE,"independent-cleanup-unrecoverable");
  assert(!np_cleanup_clock_sample_v1(&clock,boot,boot_id,cutoff,&high_water,&sample));
  assert(!syscall(SYS_pidfd_send_signal,pidfd,SIGKILL,NULL,0));
  assert(wait_original(child,&status)==child&&WIFSIGNALED(status));
  assert(read_one(pipefd[0],&byte)==0);
  assert(!np_cleanup_clock_sample_v1(&clock,boot,boot_id,cutoff,&high_water,&sample));
  uint64_t original_high_water=high_water;
  assert(np_cleanup_clock_sample_v1(&clock,boot,boot_id,sample,&high_water,&sample)==-1);
  assert(high_water==original_high_water);
  expect_mutex(mutex,cutoff,ENOTRECOVERABLE,"independent-cleanup-unrecoverable");
  close(pidfd);
  close(pipefd[0]);
  close(boot);
  np_clock_release_v1(&clock);
  assert(!munmap(mutex,sizeof *mutex));
  fputs("gate-stage: pending-admission-close\n",stderr);
  /* Red if emergency close can be overwritten by a pending associated commit.
   * Real fork/IPC exercises the production transition and independently checks
   * no effect file, original child wait and EOF. No Origin is constructed. */
  struct { pthread_mutex_t mutex; _Atomic unsigned admission; } *gate=mmap(NULL,sizeof *gate,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  assert(gate!=MAP_FAILED);
  assert(!np_origin_mutex_init_v1(&gate->mutex));
  atomic_init(&gate->admission,0);
  /* Red if GNU clocklock's immediate free-lock path accepts an expired
   * original end. Refusal must leave this actual mutex unacquired. */
  uint64_t expired=now();
  expect_mutex(&gate->mutex,expired,ETIMEDOUT,"expired-free-gate");
  assert(!pthread_mutex_trylock(&gate->mutex));
  assert(!pthread_mutex_unlock(&gate->mutex));
  int release[2];
  assert(!pipe(pipefd)&&!pipe(release));
  child=fork();
  assert(child>=0);
  if(!child){
    owned_child(parent);
    close(pipefd[0]);close(release[1]);
    assert(!np_origin_mutex_take_v1(&gate->mutex,now()+NP_ORIGIN_SECOND));
    assert(write(pipefd[1],"P",1)==1);
    assert(read_one(release[0],&byte)==1&&byte=='C');
    int claimed=np_origin_admission_claim_v1(&gate->admission);
    if(!claimed){int effect=open("late-commit-effect",O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,0600);assert(effect>=0);close(effect);}
    assert(!pthread_mutex_unlock(&gate->mutex));
    _exit(claimed?77:0);
  }
  close(pipefd[1]);close(release[0]);
  held.fd=pipefd[0];held.revents=0;
  assert(poll(&held,1,2000)==1&&read_one(pipefd[0],&byte)==1&&byte=='P');
  /* Red if a future original end replaces the single <=2s observation cap. */
  uint64_t observation_start=now(),wide_end=observation_start+3*NP_ORIGIN_SECOND;
  expect_mutex(&gate->mutex,wide_end,ETIMEDOUT,"observation-cap");
  assert(now()>=observation_start+2*NP_ORIGIN_SECOND&&now()<wide_end);
  np_origin_admission_close_v1(&gate->admission);
  assert(write(release[1],"C",1)==1);
  close(release[1]);
  assert(wait_original(child,&status)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==77);
  assert(read_one(pipefd[0],&byte)==0);
  errno=0;assert(access("late-commit-effect",F_OK)==-1&&errno==ENOENT);
  assert(np_origin_admission_claim_v1(&gate->admission)==-1);
  close(pipefd[0]);
  assert(!pthread_mutex_destroy(&gate->mutex));
  assert(!munmap(gate,sizeof *gate));
  fputs("gate-stage: durable-prefix\n",stderr);
  /* Actual bounded private DATA artifact boundary. No Origin is constructed. */
  int directory=open(".",O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  assert(directory>=0);
  assert(!np_origin_prefix_write_v1(directory,0,7,now(),"test-prefix","cookie=9 unknown=1 quoted=\"held\""));
  assert(np_origin_prefix_write_v1(directory,0,7,now(),"test-prefix","replay")==-1);
  assert(np_origin_prefix_write_v1(directory,1024,7,now(),"test-prefix","overflow")==-1);
  close(directory);
  puts("original shared gate: wait/EOF/death/unrecoverable PASS");
  return 0;
}
