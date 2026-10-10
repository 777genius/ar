#define _GNU_SOURCE
#include "retained-v2-actors.h"
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <unistd.h>
#define ACTOR_MAGIC UINT32_C(0x4e504231)
struct np_retained_v2_actors {
  struct np_actor_context context;
  struct np_actor_birth births[NP_ACTOR_COUNT];
  struct np_actor_graph graph;
  struct np_actor_manager *manager;
  int channels[NP_ACTOR_COUNT][2], pipes[NP_ACTOR_COUNT][2][2];
  pid_t principal;
  bool started, closed, held, unknown, cleanup_entered;
};
static struct np_retained_v2_actors *original_actors;
static int live(int fd) {
  struct pollfd p={.fd=fd,.events=POLLIN};
  return fd<0 || poll(&p,1,0)!=0 ? -1 : 0;
}
/* Finite raw framing; a credentials mismatch or any unexpected rights is loss,
* never a request to resolve/import a different process. */
int np_actor_receive(int fd,const struct np_actor_birth *sender,uint64_t generation,unsigned role,uint64_t sequence,enum np_actor_phase phase,struct np_actor_packet *packet,int *child) {
  unsigned char control[CMSG_SPACE(sizeof(struct ucred))+CMSG_SPACE(4*sizeof(int))];
  struct iovec iov={.iov_base=packet,.iov_len=sizeof *packet};
  struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control,.msg_controllen=sizeof control};
  ssize_t n=recvmsg(fd,&msg,MSG_DONTWAIT|MSG_CMSG_CLOEXEC);
  if(n<0)return -1;
  struct ucred cred={0};
  unsigned credentials=0,rights=0;
  int received=-1;
  bool malformed=false;
  for(struct cmsghdr *c=CMSG_FIRSTHDR(&msg);c;c=CMSG_NXTHDR(&msg,c)) {
    if(c->cmsg_level!=SOL_SOCKET){malformed=true;
      continue;
    }
    if(c->cmsg_type==SCM_CREDENTIALS && c->cmsg_len==CMSG_LEN(sizeof cred)){memcpy(&cred,CMSG_DATA(c),sizeof cred);
      credentials++;
    }
    else if(c->cmsg_type==SCM_RIGHTS && c->cmsg_len>=CMSG_LEN(0)) {
      size_t bytes=c->cmsg_len-CMSG_LEN(0);
      if(bytes%sizeof(int))malformed=true;
      for(size_t i=0;i<bytes/sizeof(int);i++){int value;
        memcpy(&value,(char *)CMSG_DATA(c)+i*sizeof(int),sizeof value);
        if(!rights)received=value;
        else close(value);
        rights++;
      }
    }else malformed=true;
  }
  uid_t uid=phase==NP_ACTOR_READY?NP_UID:0;
  gid_t gid=phase==NP_ACTOR_READY?NP_GID:0;
  bool invalid=malformed || n!=(ssize_t)sizeof *packet || (msg.msg_flags&(MSG_TRUNC|MSG_CTRUNC)) || credentials!=1 || !sender || live(sender->pidfd) || cred.pid!=sender->pid || cred.uid!=uid || cred.gid!=gid ||
  packet->magic!=ACTOR_MAGIC || packet->version!=1 || packet->generation!=generation || packet->sequence!=sequence || packet->role!=role || packet->slot!=role || packet->phase!=(unsigned)phase || packet->reserved || packet->padding ||
  rights!=(phase==NP_ACTOR_CHILD?1u:0u) || (phase==NP_ACTOR_CHILD ? packet->child_pid<=0 : packet->child_pid!=0);
  if(invalid){if(received>=0)close(received);
    errno=EPROTO;
    return -1;
  }
  if(child)*child=received;
  else if(received>=0){close(received);
    errno=EPROTO;
    return -1;
  }
  return 0;
}
static int send_packet(int fd,uint64_t generation,unsigned role,uint64_t sequence,enum np_actor_phase phase,pid_t child,int pidfd) {
  struct np_actor_packet packet={.magic=ACTOR_MAGIC,.version=1,.generation=generation,.sequence=sequence,.role=role,.slot=role,.phase=phase,.child_pid=child};
  struct iovec iov={.iov_base=&packet,.iov_len=sizeof packet};
  char control[CMSG_SPACE(sizeof(int))];
  struct msghdr msg={.msg_iov=&iov,.msg_iovlen=1};
  if(pidfd>=0){memset(control,0,sizeof control);
    msg.msg_control=control;
    msg.msg_controllen=sizeof control;
    struct cmsghdr *c=CMSG_FIRSTHDR(&msg);
    c->cmsg_level=SOL_SOCKET;
    c->cmsg_type=SCM_RIGHTS;
    c->cmsg_len=CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c),&pidfd,sizeof pidfd);
  }
  return sendmsg(fd,&msg,MSG_NOSIGNAL|MSG_DONTWAIT)==(ssize_t)sizeof packet?0:-1;
}
/* No path opens, exec, clone, migration, ioctl, manager send or cgroup writes
* survive the seal. Raw endpoints are the only surviving descriptors. */
int np_actor_seal(pid_t original_parent) {
#if defined(__x86_64__)
  const unsigned arch=AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const unsigned arch=AUDIT_ARCH_AARCH64;
#else
  errno=ENOTSUP;
  return -1;
#endif
#if defined(__x86_64__) || defined(__aarch64__)
  struct sock_filter filter[]={
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,arch,1,0), BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
#define ALLOW(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_##n,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    ALLOW(read),ALLOW(write),ALLOW(recvmsg),ALLOW(sendmsg),ALLOW(close),ALLOW(ppoll),ALLOW(waitid),ALLOW(exit),ALLOW(exit_group),ALLOW(rt_sigreturn),
#undef ALLOW
    BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM)
  };
  struct sock_fprog program={.len=(unsigned short)(sizeof filter/sizeof filter[0]),.filter=filter};
  struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};
  struct __user_cap_data_struct caps[2]={{0},{0}};
  if(original_parent<=0 || prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0) || prctl(PR_CAP_AMBIENT,PR_CAP_AMBIENT_CLEAR_ALL,0,0,0) || setgroups(0,NULL) || setresgid(NP_GID,NP_GID,NP_GID) || setresuid(NP_UID,NP_UID,NP_UID) || syscall(SYS_capset,&header,caps) || prctl(PR_SET_DUMPABLE,0,0,0,0) || prctl(PR_SET_PDEATHSIG,SIGKILL) || getppid()!=original_parent)return -1;
  return prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&program);
#endif
}
static int close_except(int *keep,size_t count) {
  for(size_t i=0;i<count;i++)for(size_t j=i+1;j<count;j++)if(keep[j]<keep[i]){int t=keep[i];
    keep[i]=keep[j];
    keep[j]=t;
  }
  unsigned first=0;
  for(size_t i=0;i<count;i++){if(keep[i]<0 || (i && keep[i]==keep[i-1]))return -1;
    unsigned fd=(unsigned)keep[i];
    if(first<fd && syscall(SYS_close_range,first,fd-1,0))return -1;
    first=fd+1;
  }
  return syscall(SYS_close_range,first,~0U,0);
}
static void parked(int endpoint) {
  /* No work token exists in this profile. A CLOSE/EOF can only exit. */
  char bytes[sizeof(struct np_actor_packet)+1];
  for(;;){ssize_t n=read(endpoint,bytes,sizeof bytes);
    if(n>=0 || (errno!=EAGAIN&&errno!=EINTR))break;
    struct pollfd p={.fd=endpoint,.events=POLLIN};
    (void)syscall(SYS_ppoll,&p,1,NULL,NULL,0);
  }
  _exit(77);
}
static void creator(struct np_retained_v2_actors *a) {
  if(prctl(PR_SET_PDEATHSIG,SIGKILL) || getppid()!=a->principal)_exit(77);
  int keep[]={a->channels[0][1],a->channels[1][1],a->pipes[0][0][1],a->pipes[0][1][1],a->pipes[1][0][1],a->pipes[1][1][1],a->context.original.clock->time,a->context.original.clock->children,a->context.original.clock->mount,a->context.original.boot_fd,a->context.original.observer_pidfd,a->context.original.principal_pidfd};
  if(close_except(keep,sizeof keep/sizeof keep[0]))_exit(77);
  int endpoint=a->channels[0][1];
  /* Parent identity comes from this original fork, not a caller PID DTO. */
  int parent_fd=(int)syscall(SYS_pidfd_open,a->principal,0);
  struct np_actor_birth parent={.pid=a->principal,.pidfd=parent_fd};
  struct np_actor_packet packet;
  for(;;){if(!np_actor_receive(endpoint,&parent,a->context.original.ends->generation,0,1,NP_ACTOR_SETUP,&packet,NULL))break;
    if(errno!=EAGAIN)_exit(77);
    struct pollfd p={.fd=endpoint,.events=POLLIN};
    if(poll(&p,1,1)<0)_exit(77);
  }
  close(parent_fd);
  int child_fd=-1;
  pid_t creator_pid=getpid();
  pid_t pid=np_origin_actor_submitter_fork_v2(a->context.origin,&child_fd);
  if(pid<0)_exit(77);
  if(!pid){
    int submitter[]={a->channels[1][1],a->pipes[1][0][1],a->pipes[1][1][1]};
    if(prctl(PR_SET_PDEATHSIG,SIGKILL) || getppid()!=creator_pid || close_except(submitter,3) || np_actor_seal(creator_pid) || send_packet(a->channels[1][1],a->context.original.ends->generation,1,1,NP_ACTOR_READY,0,-1))_exit(77);
    parked(a->channels[1][1]);
  }
  close(a->channels[1][1]);
  close(a->pipes[1][0][1]);
  close(a->pipes[1][1][1]);
  if(send_packet(endpoint,a->context.original.ends->generation,0,1,NP_ACTOR_CHILD,pid,child_fd))_exit(77);
  int creator_fds[]={endpoint,a->pipes[0][0][1],a->pipes[0][1][1],child_fd};
  if(close_except(creator_fds,4))_exit(77);
  /* Original child pidfd remains with Creator as well as its SCM_RIGHTS
  * transfer. No wait/reap before the custodian's held observation. */
  if(np_actor_seal(a->principal) || send_packet(endpoint,a->context.original.ends->generation,0,2,NP_ACTOR_READY,0,-1))_exit(77);
  parked(endpoint);
}
static int membership(struct np_retained_v2_actors *a,bool cleanup) {
  if(!a || a!=original_actors || getpid()!=a->principal)return -1;
  if(cleanup){uint64_t now;
    return !a->closed || np_origin_retained_cleanup_v2(a->context.origin,&now)?-1:0;
  }
  if(a->closed || a->unknown)return -1;
  struct np_v2_context current;
  return np_origin_retained_context_v2(a->context.origin,&current) || current.ends!=a->context.original.ends || current.operation!=a->context.original.operation || np_resource_pair_check_v1(a->context.resources) || np_fragment_verify_v1(a->context.fragment) || np_manager_current_v2(a->context.resource_manager)?-1:0;
}
static int receive_until_locked(struct np_retained_v2_actors *a,unsigned role,enum np_actor_phase phase,int *child) {
  struct np_actor_birth *b=&a->births[role];
  struct np_actor_packet packet;
  for(;;){
    if(a->closed || a->unknown || np_origin_effect_check_v1(a->context.origin,false,a->context.original.ends->work))return -1;
    if(!np_actor_receive(b->endpoint,b,a->context.original.ends->generation,role,b->receive_sequence+1,phase,&packet,child)){
      b->receive_sequence++;
      if(phase==NP_ACTOR_CHILD)a->births[1].pid=packet.child_pid;
      return 0;
    }
    if(errno!=EAGAIN)return -1;
    struct pollfd p={.fd=b->endpoint,.events=POLLIN};
    if(poll(&p,1,1)<0)return -1;
  }
}
int np_retained_v2_actor_begin(struct np_retained_v2 *cell,struct np_retained_v2_actors **out) {
  if(!out || original_actors){errno=EALREADY;
    return -1;
  }
  *out=NULL;
  struct np_retained_v2_actors *a=calloc(1,sizeof *a);
  if(!a)return -1;
  original_actors=a;
  a->principal=getpid();
  a->graph.events=-1;
  for(unsigned i=0;i<NP_ACTOR_COUNT;i++){a->births[i].pidfd=a->births[i].endpoint=-1;
    for(unsigned j=0;j<2;j++){a->channels[i][j]=-1;
      a->births[i].raw[j]=-1;
      for(unsigned k=0;k<2;k++)a->pipes[i][j][k]=-1;
    }}
  *out=a;
  if(np_retained_v2_actor_context(cell,&a->context))goto fail;
  /* Register the entire finite debt before first clone or scope effect. */
  a->started=true;
  for(unsigned i=0;i<NP_ACTOR_COUNT;i++){
    if(socketpair(AF_UNIX,SOCK_SEQPACKET|SOCK_CLOEXEC|SOCK_NONBLOCK,0,a->channels[i]))goto fail;
    int one=1;
    for(unsigned j=0;j<2;j++)if(setsockopt(a->channels[i][j],SOL_SOCKET,SO_PASSCRED,&one,sizeof one))goto fail;
    for(unsigned j=0;j<2;j++)if(pipe2(a->pipes[i][j],O_CLOEXEC|O_NONBLOCK))goto fail;
    a->births[i].endpoint=a->channels[i][0];
    for(unsigned j=0;j<2;j++)a->births[i].raw[j]=a->pipes[i][j][0];
    struct stat actual;
    if(fstat(a->channels[i][1],&actual))goto fail;
    a->births[i].endpoint_device=actual.st_dev;
    a->births[i].endpoint_inode=actual.st_ino;
    for(unsigned j=0;j<2;j++){if(fstat(a->pipes[i][j][1],&actual))goto fail;
      a->births[i].raw_device[j]=actual.st_dev;
      a->births[i].raw_inode[j]=actual.st_ino;
    }
  }
  if(np_actor_manager_connect(&a->manager,&a->context) || np_manager_actor_observer_bind_v2(a->context.resource_manager,a->manager) || np_origin_retained_lock_v2(a->context.origin))goto fail;
  int subreaper=0;
  int failed=prctl(PR_GET_CHILD_SUBREAPER,&subreaper) || subreaper || prctl(PR_SET_CHILD_SUBREAPER,1);
  pid_t pid=failed?-1:np_origin_actor_creator_fork_v2(a->context.origin,&a->births[0].pidfd);
  if(!pid)creator(a);
  a->births[0].pid=pid;
  a->births[0].born=pid>0;
  np_origin_retained_unlock_v2(a->context.origin);
  if(pid<=0)goto fail;
  for(unsigned i=0;i<NP_ACTOR_COUNT;i++){close(a->channels[i][1]);
    a->channels[i][1]=-1;
    for(unsigned j=0;j<2;j++){close(a->pipes[i][j][1]);
      a->pipes[i][j][1]=-1;
    }}
  if(np_actor_manager_enroll(a->manager,&a->births[0]) || membership(a,false) || np_origin_retained_lock_v2(a->context.origin))goto fail;
  failed=np_origin_actor_setup_begin_v2(a->context.origin) || send_packet(a->births[0].endpoint,a->context.original.ends->generation,0,1,NP_ACTOR_SETUP,0,-1);
  if(!failed){failed=receive_until_locked(a,0,NP_ACTOR_CHILD,&a->births[1].pidfd);
    if(!failed)a->births[1].born=true;
  }
  if(!failed)failed=receive_until_locked(a,0,NP_ACTOR_READY,NULL) || receive_until_locked(a,1,NP_ACTOR_READY,NULL);
  np_origin_retained_unlock_v2(a->context.origin);
  if(failed)goto fail;
  a->births[0].ready=a->births[1].ready=true;
  return 0;
  fail:a->unknown=true;
  (void)np_retained_v2_actor_close(a,NP_ORIGIN_SETUP);
  return -1;
}
int np_retained_v2_actor_hold(struct np_retained_v2_actors *a) {
  if(membership(a,false) || a->held || !a->births[0].ready || !a->births[1].ready || np_actor_manager_freeze(a->manager) || np_actor_graph_pin(&a->graph,np_actor_manager_group(a->manager)))goto fail;
  for(;;){
    if(membership(a,false))goto fail;
    if(!np_actor_graph_observe(&a->graph,a->births,&a->context))break;
    if(errno!=EAGAIN)goto fail;
    struct pollfd p={.fd=a->graph.events,.events=POLLPRI};
    (void)poll(&p,1,1);
  }
  if(np_actor_manager_current(a->manager) || membership(a,false) || np_origin_retained_lock_v2(a->context.origin))goto fail;
  int invalid=np_manager_current_v2(a->context.resource_manager) || np_actor_graph_observe(&a->graph,a->births,&a->context) || np_origin_effect_check_v1(a->context.origin,false,a->context.original.ends->work);
  np_origin_retained_unlock_v2(a->context.origin);
  if(invalid)goto fail;
  a->held=true;
  return 0;
  fail:if(a && a==original_actors){a->unknown=true;
    (void)np_retained_v2_actor_close(a,NP_ORIGIN_CUSTODY);
  }return -1;
}
int np_retained_v2_actor_release(struct np_retained_v2_actors *a) {
  (void)a;
  /* B1a has no B2 runtime/payload admission, claim, Thaw or ENQUEUE. */
  errno=ENOTSUP;
  return -1;
}
int np_retained_v2_actor_close(struct np_retained_v2_actors *a,enum np_origin_loss loss) {
  if(!a || a!=original_actors || getpid()!=a->principal)return -1;
  a->closed=true;
  np_actor_manager_close(a->manager);
  return a->context.origin?np_root_origin_close_v1(a->context.origin,loss):-1;
}
int np_retained_v2_actor_join(struct np_retained_v2_actors *a,struct np_v2_actor_cleanup_data *out) {
  if(!out || membership(a,true))return -1;
  memset(out,0,sizeof *out);
  out->container_pending=true;
  a->cleanup_entered=true;
  /* Preestablished subreaper custody: retain/reap Creator first. Its original
  * Submitter then belongs to this custodian, without a PID lookup/import. */
  for(unsigned i=0;i<NP_ACTOR_COUNT;i++){
    struct np_actor_birth *b=&a->births[i];
    if(b->born && !b->signal_attempted){b->signal_attempted=true;
      if(membership(a,true) || syscall(SYS_pidfd_send_signal,b->pidfd,SIGKILL,NULL,0))a->unknown=true;
    }
  }
  for(;;){
    if(membership(a,true))return -1;
    bool settled=true;
    for(unsigned i=0;i<NP_ACTOR_COUNT;i++){
      struct np_actor_birth *b=&a->births[i];
      if(b->born && !b->wait && (!i || a->births[0].wait)){
        siginfo_t info={0};
        if(!waitid(P_PIDFD,(id_t)b->pidfd,&info,WEXITED|WNOHANG) && info.si_pid==b->pid){b->result=info;
          b->wait=true;
        }
      }
      for(unsigned j=0;j<2;j++)if(b->raw[j]>=0 && !b->eof[j]){char byte;
        ssize_t n=read(b->raw[j],&byte,1);
        if(!n)b->eof[j]=true;
        else if(n>0)a->unknown=true;
      }
      if(b->endpoint>=0 && !b->channel_eof){char bytes[sizeof(struct np_actor_packet)+1];
        ssize_t n=recv(b->endpoint,bytes,sizeof bytes,MSG_DONTWAIT);
        if(!n)b->channel_eof=true;
        else if(n>0)a->unknown=true;
      }
      out->waits[i]=b->wait;
      out->channel_eofs[i]=b->channel_eof;
      for(unsigned j=0;j<2;j++)out->raw_eofs[i][j]=b->eof[j];
      if(!b->born || !b->wait || !b->eof[0] || !b->eof[1] || !b->channel_eof)settled=false;
    }
    if(settled){out->custody_settled=true;
      return 0;
    }
    (void)poll(NULL,0,1);
  }
}
