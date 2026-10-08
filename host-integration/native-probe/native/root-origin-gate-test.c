#define _GNU_SOURCE
#include "root-producer-native.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static uint64_t now(void){
  struct timespec t;
  assert(!clock_gettime(CLOCK_MONOTONIC,&t));
  return (uint64_t)t.tv_sec*NP_ORIGIN_SECOND+(uint64_t)t.tv_nsec;
}
int main(void) {
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
  assert(read(pipefd[0],&byte,1)==1&&byte=='L');
  uint64_t start=now(),end=start+UINT64_C(50000000);
  assert(np_origin_mutex_take_v1(mutex,end)==ETIMEDOUT);
  assert(now()>=end&&now()-start<NP_ORIGIN_SECOND);
  assert(!kill(child,SIGKILL));
  int status;
  assert(waitpid(child,&status,0)==child&&WIFSIGNALED(status));
  assert(read(pipefd[0],&byte,1)==0);
  assert(np_origin_mutex_take_v1(mutex,now()+NP_ORIGIN_SECOND)==EOWNERDEAD);
  /* Deliberately omit consistent(): this original gate is never repaired. */
  assert(!pthread_mutex_unlock(mutex));
  assert(np_origin_mutex_take_v1(mutex,now()+NP_ORIGIN_SECOND)==ENOTRECOVERABLE);
  close(pipefd[0]);
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
  if(!child){close(pipefd[0]);
  pause();
  _exit(1);
  }
  close(pipefd[1]);
  int pidfd=(int)syscall(SYS_pidfd_open,child,0);
  assert(pidfd>=0);
  uint64_t high_water=now(),cutoff=high_water+NP_ORIGIN_SECOND,sample;
  assert(np_origin_mutex_take_v1(mutex,cutoff)==ENOTRECOVERABLE);
  assert(!np_cleanup_clock_sample_v1(&clock,boot,boot_id,cutoff,&high_water,&sample));
  assert(!syscall(SYS_pidfd_send_signal,pidfd,SIGKILL,NULL,0));
  assert(waitpid(child,&status,0)==child&&WIFSIGNALED(status));
  assert(read(pipefd[0],&byte,1)==0);
  assert(!np_cleanup_clock_sample_v1(&clock,boot,boot_id,cutoff,&high_water,&sample));
  uint64_t original_high_water=high_water;
  assert(np_cleanup_clock_sample_v1(&clock,boot,boot_id,sample,&high_water,&sample)==-1);
  assert(high_water==original_high_water);
  assert(np_origin_mutex_take_v1(mutex,cutoff)==ENOTRECOVERABLE);
  close(pidfd);
  close(pipefd[0]);
  close(boot);
  np_clock_release_v1(&clock);
  assert(!munmap(mutex,sizeof *mutex));
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
