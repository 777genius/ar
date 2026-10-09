#define _GNU_SOURCE
#include "retained-v2-actors.h"
#include "stock-bus-abi.h"
#include "original-birth-interlock.h"
#include <sys/mman.h>
#include <time.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
/* Real syscall/IPC contract fixture, no Root constructor or manager success.
* Every child is born here, retained by its original pidfd and bounded by this
* disposable TEST parent. It grants no NativeHeldActors capability. */
static pid_t clone_child(int *pidfd) {
  struct clone_args args={.flags=CLONE_PIDFD,.pidfd=(uint64_t)(uintptr_t)pidfd,.exit_signal=SIGCHLD};
  pid_t parent=getpid();
  pid_t pid=(pid_t)syscall(SYS_clone3,&args,sizeof args);
  assert(pid>=0);
  if(!pid){assert(!prctl(PR_SET_PDEATHSIG,SIGKILL));
    if(getppid()!=parent)_exit(78);
  }
  return pid;
}
static void wait_original(int pidfd,pid_t pid,int exit_code) {
  siginfo_t result={0};
  assert(!waitid(P_PIDFD,(id_t)pidfd,&result,WEXITED));
  assert(result.si_pid==pid && result.si_code==CLD_EXITED && result.si_status==exit_code);
  close(pidfd);
}
static void frame_send(int endpoint,unsigned mutation,int original_fd,pid_t original_child) {
  struct np_actor_packet packet={.generation=9,.sequence=1,.magic=UINT32_C(0x4e504231),.version=1,.role=0,.slot=0,.phase=NP_ACTOR_CHILD,.child_pid=original_child};
  if(mutation==1)packet.generation++;
  if(mutation==2)packet.sequence++;
  struct iovec iov={.iov_base=&packet,.iov_len=mutation==3?sizeof packet-1:sizeof packet};
  int rights[2]={original_fd,original_fd};
  char control[CMSG_SPACE(sizeof rights)];
  memset(control,0,sizeof control);
  struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control,.msg_controllen=mutation==4?sizeof control:CMSG_SPACE(sizeof(int))};
  struct cmsghdr *c=CMSG_FIRSTHDR(&msg);
  c->cmsg_level=SOL_SOCKET;
  c->cmsg_type=SCM_RIGHTS;
  c->cmsg_len=CMSG_LEN(mutation==4?sizeof rights:sizeof(int));
  memcpy(CMSG_DATA(c),rights,mutation==4?sizeof rights:sizeof(int));
  assert(sendmsg(endpoint,&msg,MSG_NOSIGNAL)==(ssize_t)iov.iov_len);
}
static void protocol(unsigned mutation) {
  int channel[2],ready[2],release[2];
  assert(!socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC,0,channel));
  assert(!pipe(ready));
  assert(!pipe(release));
  int pass=1;
  assert(!setsockopt(channel[0],SOL_SOCKET,SO_PASSCRED,&pass,sizeof pass));
  int pidfd=-1;
  pid_t sender=clone_child(&pidfd);
  if(!sender){
    close(channel[0]);
    close(ready[0]);
    close(release[1]);
    int self=(int)syscall(SYS_pidfd_open,getpid(),0);
    assert(self>=0);
    frame_send(channel[1],mutation,self,getpid());
    assert(write(ready[1],"R",1)==1);
    char byte;
    assert(read(release[0],&byte,1)==1);
    close(self);
    _exit(0);
  }
  close(channel[1]);
  close(ready[1]);
  close(release[0]);
  char byte;
  assert(read(ready[0],&byte,1)==1);
  struct np_actor_birth original={.pid=mutation==5?getpid():sender,.pidfd=pidfd};
  struct np_actor_packet packet;
  int received=-1;
  int result=np_actor_receive(channel[0],&original,9,0,1,NP_ACTOR_CHILD,&packet,&received);
  if(!mutation && getuid()==0 && getgid()==0){assert(!result && received>=0);
    close(received);
  }
  else assert(result==-1 && received==-1);
  assert(write(release[1],"C",1)==1);
  close(release[1]);
  wait_original(pidfd,sender,0);
  assert(read(ready[0],&byte,1)==0);
  close(ready[0]);
  close(channel[0]);
}
static void confinement(void) {
  assert(getuid()==0 && getgid()==0);
  int pipes[2];
  assert(!pipe(pipes));
  pid_t parent=getpid();
  int pidfd=-1;
  pid_t child=clone_child(&pidfd);
  if(!child){
    close(pipes[0]);
    assert(!np_actor_seal(parent));
    /* These effects were possible before the actual seal. No production test
    * hook is required to exercise its denied syscall boundary. */
    errno=0;
    long forked=syscall(SYS_clone3,NULL,0);
    int clone_error=errno;
    errno=0;
    long opened=syscall(SYS_openat,AT_FDCWD,"/proc/self/status",O_RDONLY,0);
    int open_error=errno;
    errno=0;
    long executed=syscall(SYS_execve,"/bin/true",NULL,NULL);
    int exec_error=errno;
    if(forked!=-1 || clone_error!=EPERM || opened!=-1 || open_error!=EPERM || executed!=-1 || exec_error!=EPERM)_exit(79);
    if(write(pipes[1],"S",1)!=1)_exit(79);
    _exit(0);
  }
  close(pipes[1]);
  char byte;
  assert(read(pipes[0],&byte,1)==1 && byte=='S');
  wait_original(pidfd,child,0);
  assert(read(pipes[0],&byte,1)==0);
  close(pipes[0]);
}
struct thread_data { int ready,release;
};
static void *last_task(void *argument) {
  struct thread_data *data=argument;
  assert(write(data->ready,"T",1)==1);
  char byte;
  assert(read(data->release,&byte,1)==1);
  return NULL;
}
static void whole_group(void) {
  int ready[2],release[2];
  assert(!pipe(ready));
  assert(!pipe(release));
  int pidfd=-1;
  pid_t child=clone_child(&pidfd);
  if(!child){
    close(ready[0]);
    close(release[1]);
    struct thread_data data={.ready=ready[1],.release=release[0]};
    pthread_t worker;
    assert(!pthread_create(&worker,NULL,last_task,&data));
    /* Kernel exit of only the leader; the retained original worker lives. */
    (void)syscall(SYS_exit,0);
    _exit(79);
  }
  close(ready[1]);
  close(release[0]);
  char byte;
  assert(read(ready[0],&byte,1)==1 && byte=='T');
  struct pollfd p={.fd=pidfd,.events=POLLIN};
  assert(poll(&p,1,100)==0);
  assert(write(release[1],"E",1)==1);
  close(release[1]);
  assert(poll(&p,1,2000)==1 && (p.revents&POLLIN));
  wait_original(pidfd,child,0);
  assert(read(ready[0],&byte,1)==0);
  close(ready[0]);
}
static void observer(void) {
  /* Independent DATA contract only: these strings create no manager/actor
  * membership. Red if the finite observer accepts a different unit, job,
  * duplicate lifecycle or non-done result, or erases the retained first job. */
  struct np_actor_event_debt debt={.unit="subscription-runtime-actors-TEST.scope",.path="/org/freedesktop/systemd1/unit/ownedTEST"};
  const char *job="/org/freedesktop/systemd1/job/7";
  assert(np_actor_observer_note(&debt,NP_ACTOR_UNIT_NEW,"foreign.scope",debt.path,0,NULL)==-1);
  assert(np_actor_observer_note(&debt,NP_ACTOR_JOB_REMOVED,debt.unit,job,7,"done")==-1);
  assert(!np_actor_observer_note(&debt,NP_ACTOR_UNIT_NEW,debt.unit,debt.path,0,NULL));
  assert(np_actor_observer_note(&debt,NP_ACTOR_UNIT_NEW,debt.unit,debt.path,0,NULL)==-1);
  assert(np_actor_observer_note(&debt,NP_ACTOR_JOB_NEW,debt.unit,"/org/freedesktop/systemd1/job/007",7,NULL)==-1);
  assert(!np_actor_observer_note(&debt,NP_ACTOR_JOB_NEW,debt.unit,job,7,NULL));
  assert(np_actor_observer_note(&debt,NP_ACTOR_JOB_NEW,debt.unit,"/org/freedesktop/systemd1/job/8",8,NULL)==-1);
  assert(np_actor_observer_note(&debt,NP_ACTOR_JOB_REMOVED,debt.unit,job,7,"failed")==-1);
  assert(np_actor_observer_note(&debt,NP_ACTOR_JOB_REMOVED,debt.unit,"/org/freedesktop/systemd1/job/8",8,"done")==-1);
  assert(!np_actor_observer_note(&debt,NP_ACTOR_JOB_REMOVED,debt.unit,job,7,"done"));
  assert(np_actor_observer_note(&debt,NP_ACTOR_JOB_REMOVED,debt.unit,job,7,"done")==-1);
  assert(debt.unit_seen && debt.job_seen && debt.job_done && debt.job_id==7 && !strcmp(debt.job,job));
}
static uint64_t actual_now(void){struct timespec t;assert(!clock_gettime(CLOCK_MONOTONIC,&t));return (uint64_t)t.tv_sec*UINT64_C(1000000000)+(uint64_t)t.tv_nsec;}
struct transaction_fixture {struct np_birth_interlock lock;_Atomic bool closed;_Atomic unsigned births;};
static void birth_close_transaction(void){
  struct transaction_fixture *f=mmap(NULL,sizeof *f,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);assert(f!=MAP_FAILED);
  np_birth_interlock_init(&f->lock);atomic_init(&f->closed,false);atomic_init(&f->births,0);
  uint64_t end=actual_now()+UINT64_C(2000000000);
  int entered[2],resume[2];assert(!pipe2(entered,O_CLOEXEC));assert(!pipe2(resume,O_CLOEXEC));
  /* Parent's real robust pthread node must survive native gate registration.
   * Raw clone roles use only the kernel robust futex mechanism. */
  pthread_mutex_t outer;assert(!np_origin_mutex_init_v1(&outer));assert(!pthread_mutex_lock(&outer));
  int creator_fd=-1;pid_t creator_pid=clone_child(&creator_fd);
  if(!creator_pid){
    assert(!np_birth_interlock_take(&f->lock,end));char byte=1;assert(write(entered[1],&byte,1)==1);
    assert(read(resume[0],&byte,1)==1);assert(!atomic_load(&f->closed));
    int child_fd=-1;pid_t child=clone_child(&child_fd);
    if(!child)_exit(0);
    atomic_fetch_add(&f->births,1);wait_original(child_fd,child,0);assert(!np_birth_interlock_drop(&f->lock));_exit(0);
  }
  char byte;assert(read(entered[0],&byte,1)==1);
  /* Expired work observation cannot steal/drop Creator's transaction. */
  assert(np_birth_interlock_take(&f->lock,actual_now()+UINT64_C(10000000))==ETIMEDOUT);
  int closer_fd=-1;pid_t closer_pid=clone_child(&closer_fd);
  if(!closer_pid){assert(!np_birth_interlock_take(&f->lock,end));atomic_store(&f->closed,true);assert(!np_birth_interlock_drop(&f->lock));_exit(0);}
  struct pollfd pending={.fd=closer_fd,.events=POLLIN};assert(poll(&pending,1,30)==0);assert(!atomic_load(&f->closed));
  assert(write(resume[1],&byte,1)==1);wait_original(creator_fd,creator_pid,0);wait_original(closer_fd,closer_pid,0);
  assert(atomic_load(&f->closed));assert(atomic_load(&f->births)==1);assert(!pthread_mutex_unlock(&outer));assert(!pthread_mutex_destroy(&outer));
  /* Actual owner death must be surfaced as negative, never positive admission. */
  atomic_store(&f->closed,false);int lost_fd=-1;pid_t lost_pid=clone_child(&lost_fd);
  if(!lost_pid){assert(!np_birth_interlock_take(&f->lock,end));_exit(0);}
  wait_original(lost_fd,lost_pid,0);assert(np_birth_interlock_take(&f->lock,end)==EOWNERDEAD);assert(!np_birth_interlock_drop(&f->lock));
  close(entered[0]);close(entered[1]);close(resume[0]);close(resume[1]);assert(!munmap(f,sizeof *f));
}
static void notification_property(sd_bus_message *m,const char *key,const char *signature){assert(sd_bus_message_open_container(m,'e',"sv")>=0);assert(sd_bus_message_append(m,"s",key)>=0);assert(sd_bus_message_open_container(m,'v',signature)>=0);}
static void notification_end(sd_bus_message *m){assert(sd_bus_message_close_container(m)>=0);assert(sd_bus_message_close_container(m)>=0);}
static void notification_string(sd_bus_message *m,const char *key,const char *value){notification_property(m,key,"s");assert(sd_bus_message_append(m,"s",value)>=0);notification_end(m);}
static void notifications(unsigned mutation){
  /* Real fixture-local socket, no manager/address/env discovery. Starting the
   * configured peer bus moves out of BUS_UNSET for v255 message creation.
   * This exercises serialization/decoding, not authenticated transport. */
  int endpoints[2];assert(!socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0,endpoints));
  sd_bus *bus=NULL;sd_bus_message *m=NULL;assert(sd_bus_new(&bus)>=0);
  assert(sd_bus_set_fd(bus,endpoints[0],endpoints[0])>=0);
  assert(sd_bus_set_bus_client(bus,0)>=0);
  assert(sd_bus_set_allow_interactive_authorization(bus,0)>=0);
  assert(sd_bus_start(bus)>=0);
  struct np_actor_event_debt debt={0};strcpy(debt.unit,"subscription-runtime-actors-TEST.scope");strcpy(debt.path,"/org/freedesktop/systemd1/unit/subscription_2druntime_2dactors_2dTEST_2escope");
  bool scope=mutation==8 || mutation==9;
  assert(sd_bus_message_new_signal(bus,&m,mutation==6?"/foreign":debt.path,"org.freedesktop.DBus.Properties","PropertiesChanged")>=0);
  assert(sd_bus_message_append(m,"s",scope?"org.freedesktop.systemd1.Scope":"org.freedesktop.systemd1.Unit")>=0);assert(sd_bus_message_open_container(m,'a',"{sv}")>=0);
  if(scope){notification_string(m,"Controller","");notification_string(m,"Result","success");if(mutation==9)notification_string(m,"Result","success");}
  else{
    /* Independent exact v255 Unit table contract: full NULL-name projection,
     * including fields/invalidations that made A1 reject healthy messages. */
    notification_string(m,"ActiveState","active");notification_string(m,"SubState","running");notification_string(m,"FreezerState","frozen");
    static const char *const names[]={"StateChangeTimestamp","StateChangeTimestampMonotonic","InactiveExitTimestamp","InactiveExitTimestampMonotonic","ActiveEnterTimestamp","ActiveEnterTimestampMonotonic","ActiveExitTimestamp","ActiveExitTimestampMonotonic","InactiveEnterTimestamp","InactiveEnterTimestampMonotonic","ConditionTimestamp","ConditionTimestampMonotonic","AssertTimestamp","AssertTimestampMonotonic"};
    for(unsigned i=0;i<14;i++){
      notification_property(m,names[i],mutation==1&&i==2?"s":"t");
      if(mutation==1&&i==2)assert(sd_bus_message_append(m,"s","wrong-type")>=0);else assert(sd_bus_message_append(m,"t",UINT64_C(1234567)+i)>=0);
      notification_end(m);
    }
    notification_property(m,"Job","(uo)");assert(sd_bus_message_append(m,"(uo)",mutation==7?UINT32_C(9):UINT32_C(0),mutation==7?"/org/freedesktop/systemd1/job/9":"/")>=0);notification_end(m);
    notification_property(m,"ConditionResult","b");assert(sd_bus_message_append(m,"b",1)>=0);notification_end(m);notification_property(m,"AssertResult","b");assert(sd_bus_message_append(m,"b",1)>=0);notification_end(m);
    unsigned char id[16]={1};notification_property(m,"InvocationID","ay");assert(sd_bus_message_open_container(m,'a',"y")>=0);for(unsigned i=0;i<16;i++)assert(sd_bus_message_append(m,"y",id[i])>=0);assert(sd_bus_message_close_container(m)>=0);notification_end(m);
    notification_property(m,"ActivationDetails","a(ss)");assert(sd_bus_message_open_container(m,'a',"(ss)")>=0);assert(sd_bus_message_close_container(m)>=0);notification_end(m);
    if(mutation==2)notification_string(m,"ActiveState","active");
    if(mutation==3){notification_property(m,"Delegate","b");assert(sd_bus_message_append(m,"b",0)>=0);notification_end(m);}
    if(mutation==10)notification_string(m,"ControlGroup","/foreign");
  }
  assert(sd_bus_message_close_container(m)>=0);assert(sd_bus_message_open_container(m,'a',"s")>=0);
  if(!scope){assert(sd_bus_message_append(m,"s","Conditions")>=0);assert(sd_bus_message_append(m,"s","Asserts")>=0);if(mutation==4)assert(sd_bus_message_append(m,"s","Conditions")>=0);if(mutation==5)assert(sd_bus_message_append(m,"s","ControlGroup")>=0);}
  assert(sd_bus_message_close_container(m)>=0);assert(sd_bus_message_seal(m,1,0)>=0);assert(sd_bus_message_rewind(m,1)>=0);
  int result=np_actor_notification_decode(m,&debt);assert((mutation==0||mutation==8)?result==0:result<0);
  sd_bus_message_unref(m);sd_bus_close_unref(bus);
  /* sd_bus owns endpoint0; the fixture owns endpoint1. No process was born,
   * no send/flush/drain or indefinite handshake/wait is needed for this DATA. */
  errno=0;assert(fcntl(endpoints[0],F_GETFD)==-1 && errno==EBADF);
  assert(!close(endpoints[1]));
}
int main(int argc,char **argv) {
  alarm(5);
  assert(argc==2);
  if(!strcmp(argv[1],"whole-group"))whole_group();
  else if(!strcmp(argv[1],"seal"))confinement();
  else if(!strcmp(argv[1],"birth-close"))birth_close_transaction();
  else if(!strcmp(argv[1],"notifications")){for(unsigned i=0;i<=10;i++)notifications(i);}
  else if(!strcmp(argv[1],"protocol"))for(unsigned i=0;i<=5;i++)protocol(i);
  else if(!strcmp(argv[1],"observer"))observer();
  else if(!strcmp(argv[1],"refuse")){
    errno=0;
    assert(np_retained_v2_actor_release(NULL)==-1 && errno==ENOTSUP);
    struct np_retained_v2_actors *actors=NULL;
    assert(np_retained_v2_actor_begin(NULL,&actors)==-1);
    assert(actors!=NULL);
    /* retained partial cell is not discarded */
    assert(np_retained_v2_actor_hold(actors)==-1);
  }else return 79;
  puts("native actor syscall contract PASS; no Native admission");
  return 0;
}
