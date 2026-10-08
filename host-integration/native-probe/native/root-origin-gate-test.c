#define _GNU_SOURCE
#include "root-producer-native.h"
#include <assert.h>
#include <errno.h>
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
  assert(!munmap(mutex,sizeof *mutex));
  puts("original shared gate: wait/EOF/death/unrecoverable PASS");
  return 0;
}
