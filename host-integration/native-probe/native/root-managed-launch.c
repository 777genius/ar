#define _GNU_SOURCE
#include "root-managed-launch.h"
#include "stock-bus-abi.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif
#define MANAGER "org.freedesktop.systemd1"
#define MANAGER_PATH "/org/freedesktop/systemd1"
#define MANAGER_IFACE "org.freedesktop.systemd1.Manager"
#define DAEMON "org.freedesktop.DBus"
#define DAEMON_PATH "/org/freedesktop/DBus"
#define CALLS 1024
#define JOBS 32
#define MATCH "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.systemd1'"
struct original_call {
  struct np_root_origin *origin;
  unsigned index;
  char method[64],path[256],interface[128],destination[256],argument[256];
  sd_bus_message *request,*reply;
  sd_bus_slot *slot;
  uint64_t cookie,reply_cookie;
  bool sent,done,error,unknown;
  const char *sender;
}
;
struct original_job {
  sd_bus_message *message;
  char path[128],unit[96],outcome[32];
  uint32_t id;
}
;
struct np_managed_original {
  struct np_root_origin *origin;
  sd_bus *direct,*api,*collision;
  sd_bus_slot *direct_filter,*api_filter;
  struct np_birth manager,daemon;
  int listener_pidfd,daemon_exe,daemon_proc,collision_peer;
  struct np_directory socket_path,cgroup,collision_path;
  uint64_t last_check;
  char unit[96],daemon_path[256],scope_path[256],unique[256],sender[256],cgroup_name[1024],start_job[128],stop_job[128];
  unsigned char daemon_invocation[16],scope_invocation[16];
  pid_t daemon_pid,child;
  int child_pidfd,events;
  struct original_call calls[CALLS];
  unsigned call_count;
  struct original_job jobs[JOBS];
  unsigned job_count;
  enum {
    REF_UNSENT, REF_SENT_UNKNOWN, REF_ACK_HELD, REF_RELEASE_UNKNOWN, REF_RELEASE_ACKED }
  reference;
  const char *loss_reason;
  bool initialized,collision_unknown,connect_sent,shared_unknown,lost,subscribed,matched,start_sent,associated,stop_sent,closed;
}
;
static int live(int fd){
  struct pollfd p={
    .fd=fd,.events=POLLIN}
  ;
  return fd<0||poll(&p,1,0)!=0?-1:0;
}
static int copy(char *to,size_t capacity,const char *from){
  if(!from||strlen(from)>=capacity){
    return -1;
  }
  strcpy(to,from);
  return 0;
}
static bool cgroup_token_char(unsigned char c,bool named) {
  return (c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||(named&&c=='.');
}
static int cgroup_controllers(const unsigned char *bytes,size_t length) {
  if(!length)return -1;
  size_t at=0;
  while(at<length){
    size_t end=at;
    while(end<length&&bytes[end]!=',')end++;
    bool named=end-at>=5&&!memcmp(bytes+at,"name=",5);
    size_t start=at+(named?5:0);
    if(start==end)return -1;
    for(size_t i=start;i<end;i++)if(!cgroup_token_char(bytes[i],named))return -1;
    if(end==length)return 0;
    at=end+1;
  }
  return -1;
}
int np_managed_cgroup_bytes_v1(const void *data,size_t length,const char *expected) {
  if(!data||!length||length>NP_MANAGED_CGROUP_BYTES||!expected||expected[0]!='/')return -1;
  const unsigned char *bytes=data;
  if(bytes[length-1]!='\n'||memchr(bytes,0,length)||memchr(bytes,'\r',length))return -1;
  size_t expected_length=strnlen(expected,1024);
  if(expected_length>=1024)return -1;
  bool unified=false;
  size_t at=0;
  while(at<length){
    size_t end=at;
    while(end<length&&bytes[end]!='\n')end++;
    size_t first=at;
    while(first<end&&bytes[first]>='0'&&bytes[first]<='9')first++;
    if(first==at||first==end||bytes[first]!=':'||(bytes[at]=='0'&&first!=at+1))return -1;
    size_t second=first+1;
    while(second<end&&bytes[second]!=':')second++;
    if(second==end||second+1==end||bytes[second+1]!='/')return -1;
    if(bytes[at]=='0'){
      size_t path_length=end-second-1;
      if(unified||second!=first+1||path_length!=expected_length||memcmp(bytes+second+1,expected,path_length))return -1;
      unified=true;
    }else if(cgroup_controllers(bytes+first+1,second-first-1))return -1;
    at=end+1;
  }
  return unified?0:-1;
}
int np_managed_cgroup_read_v1(int fd,const char *expected) {
  unsigned char bytes[NP_MANAGED_CGROUP_BYTES],extra;
  size_t used=0;
  for(;;){
    ssize_t count=read(fd,used==sizeof bytes?&extra:bytes+used,used==sizeof bytes?1:sizeof bytes-used);
    if(count<0)return -1;
    if(!count)return np_managed_cgroup_bytes_v1(bytes,used,expected);
    if(used==sizeof bytes)return -1;
    used+=(size_t)count;
  }
}
static int same(int a,int b){
  struct stat x,y;
  return fstat(a,&x)||fstat(b,&y)||x.st_dev!=y.st_dev||x.st_ino!=y.st_ino?-1:0;
}
static void lose(struct np_managed_original *m,const char *reason) {
  m->lost=true;
  if(!m->loss_reason){m->loss_reason=reason;(void)np_origin_journal_v1(m->origin,"manager-loss",reason);}
}
static int boundary(struct np_root_origin *o,struct np_managed_original *m,bool cleanup) {
  if((m->lost&&!cleanup)||np_birth_live_v1(&m->manager)||np_origin_boundary_v1(o,cleanup)){
    return -1;
  }
  if(m->connect_sent&&(np_birth_live_v1(&m->daemon)||live(m->listener_pidfd))){
    m->shared_unknown=true;
    lose(m,"daemon-listener-death");
    return cleanup?0:-1;
  }
  return 0;
}
static int response(sd_bus_message *message,void *data,sd_bus_error *error) {
  (void)error;
  struct original_call *c=data;
  uint64_t cookie;
  const char *sender=sd_bus_message_get_sender(message);
  c->reply=sd_bus_message_ref(message);
  c->done=true;
  if(!c->sent||sd_bus_message_get_reply_cookie(message,&cookie)<0||cookie!=c->cookie||(c->sender&&(!sender||strcmp(sender,c->sender)))||sd_bus_message_get_cookie(message,&c->reply_cookie)<0||!c->reply_cookie)c->unknown=true;
  c->error=sd_bus_message_is_method_error(message,NULL)>0;
  const sd_bus_error *detail=sd_bus_message_get_error(message);
  char prefix[2048];
  snprintf(prefix,sizeof prefix,"call=%u method=%s requestCookie=%llu replyCookie=%llu sender=%s error=%s unknown=%u",c->index,c->method,(unsigned long long)c->cookie,(unsigned long long)c->reply_cookie,sender?sender:"absent",detail&&detail->name?detail->name:"none",c->unknown);
  if(np_origin_journal_v1(c->origin,"call-reply",prefix))c->unknown=true;
  return 0;
}
static int event(sd_bus_message *message,void *data,sd_bus_error *error) {
  (void)error;
  struct np_managed_original *m=data;
  if(sd_bus_message_get_bus(message)==m->api&&sd_bus_message_is_signal(message,DAEMON,"NameOwnerChanged")>0){
    const char *name,*before,*after;
    const char *sender=sd_bus_message_get_sender(message);
    if(!sender||strcmp(sender,DAEMON)||!sd_bus_message_get_path(message)||strcmp(sd_bus_message_get_path(message),DAEMON_PATH)||sd_bus_message_has_signature(message,"sss")<=0||sd_bus_message_read(message,"sss",&name,&before,&after)<=0){
      lose(m,"daemon-owner-signal-malformed");
      return 0;
    }
    (void)before;
    if(!strcmp(name,MANAGER)&&m->unique[0]&&strcmp(after,m->unique)){
      lose(m,"manager-owner-replaced");
      m->shared_unknown=true;
    }
    return 0;
  }
  if(sd_bus_message_get_bus(message)==m->direct&&sd_bus_message_get_path(message)&&!strcmp(sd_bus_message_get_path(message),MANAGER_PATH)&&sd_bus_message_is_signal(message,MANAGER_IFACE,"JobRemoved")>0){
    uint32_t id;
    const char *path,*unit,*outcome;
    if(sd_bus_message_has_signature(message,"uoss")<=0||sd_bus_message_read(message,"uoss",&id,&path,&unit,&outcome)<=0){
      lose(m,"direct-job-signal-malformed");
      return 0;
    }
    if(strcmp(unit,m->unit)){
      return 0;
    }
    if(m->job_count>=JOBS){
      lose(m,"direct-job-capacity-exhausted");
      return 0;
    }
    struct original_job *j=&m->jobs[m->job_count++];
    j->id=id;
    j->message=sd_bus_message_ref(message);
    if(copy(j->path,sizeof j->path,path)||copy(j->unit,sizeof j->unit,unit)||copy(j->outcome,sizeof j->outcome,outcome))lose(m,"direct-job-field-capacity");
    char prefix[512];
    snprintf(prefix,sizeof prefix,"id=%u path=%s unit=%s outcome=%s",id,path,unit,outcome);
    if(np_origin_journal_v1(m->origin,"job-removed",prefix))lose(m,"direct-job-journal-loss");
  }
  return 0;
}
static int pump(struct np_root_origin *o,struct np_managed_original *m,bool cleanup,uint64_t end) {
  uint64_t now;
  if(boundary(o,m,cleanup)||np_origin_now_v1(o,&now)||now>=end){
    return -1;
  }
  if(m->direct&&sd_bus_process(m->direct,NULL)<0){
    return -1;
  }
  if(m->api&&sd_bus_process(m->api,NULL)<0){
    return -1;
  }
  if(boundary(o,m,cleanup)||np_origin_now_v1(o,&now)||now>=end){
    return -1;
  }
  struct pollfd f[2]={
    {
      .fd=m->direct?sd_bus_get_fd(m->direct):-1,.events=POLLIN|POLLOUT}
    ,{
      .fd=m->api?sd_bus_get_fd(m->api):-1,.events=POLLIN|POLLOUT}
  }
  ;
  if(poll(f,2,1)<0&&errno!=EINTR){
    return -1;
  }
  return 0;
}
static struct original_call *message(struct np_managed_original *m,sd_bus *bus,const char *destination,const char *path,const char *interface,const char *method,const char *sender) {
  if(m->call_count>=CALLS){
    return NULL;
  }
  struct original_call *c=&m->calls[m->call_count++];
  c->sender=sender;
  c->origin=m->origin;
  c->index=m->call_count-1;
  if(copy(c->method,sizeof c->method,method)||copy(c->path,sizeof c->path,path)||copy(c->interface,sizeof c->interface,interface)||copy(c->destination,sizeof c->destination,destination))return NULL;
  if(sd_bus_message_new_method_call(bus,&c->request,destination,path,interface,method)<0||sd_bus_message_set_auto_start(c->request,0)<0||sd_bus_message_set_allow_interactive_authorization(c->request,0)<0){
    return NULL;
  }
  return c;
}
static int dispatch(struct np_root_origin *o,struct np_managed_original *m,sd_bus *bus,struct original_call *c,bool cleanup,int effect) {
  uint64_t now;
  if(!c||boundary(o,m,cleanup)||np_origin_now_v1(o,&now)){
    return -1;
  }
  uint64_t end=now+2*NP_ORIGIN_SECOND;
  const struct np_origin_ends *limits=np_origin_ends_v1(o);
  if(end>(cleanup?limits->cleanup:limits->work))end=cleanup?limits->cleanup:limits->work;
  if(effect>=0&&np_origin_effect_begin_v1(o,(enum np_origin_effect)effect)){
    return -1;
  }
  c->sent=true;
  c->unknown=true;
  char prefix[1536];
  snprintf(prefix,sizeof prefix,"call=%u method=%s destination=%s path=%s interface=%s argument=%s sent-unknown effect=%d",c->index,c->method,c->destination,c->path,c->interface,c->argument,effect);
  int journal=np_origin_journal_v1(o,"call-dispatch",prefix);
  if(journal&&!cleanup){if(effect>=0)np_origin_effect_end_v1(o);
  return -1;
  }
  if((effect>=0?np_origin_effect_check_v1(o,cleanup,end):np_origin_now_v1(o,&now))||(effect<0&&now>=end)){
    if(effect>=0)np_origin_effect_end_v1(o);
    return -1;
  }
  int result=sd_bus_call_async(bus,&c->slot,c->request,response,c,UINT64_C(2000000));
  if(effect>=0)np_origin_effect_end_v1(o);
  if(result<0||sd_bus_message_get_cookie(c->request,&c->cookie)<0||!c->cookie){
    return -1;
  }
  snprintf(prefix,sizeof prefix,"call=%u requestCookie=%llu",c->index,(unsigned long long)c->cookie);
  if(np_origin_journal_v1(o,"call-cookie",prefix)&&!cleanup)return -1;
  c->unknown=false;
  while(!c->done){
    if(pump(o,m,cleanup,end)){
      c->unknown=true;
      return -1;
    }
  }
  uint64_t queued;
  if(c->unknown||boundary(o,m,cleanup)||np_origin_now_v1(o,&now)||now>=end||sd_bus_get_n_queued_write(bus,&queued)<0||queued){
    return -1;
  }
  return c->error?1:0;
}
static int simple(struct np_root_origin *o,struct np_managed_original *m,sd_bus *bus,const char *destination,const char *path,const char *interface,const char *method,const char *argument,bool cleanup,int effect,const char *sender,struct original_call **out) {
  struct original_call *c=message(m,bus,destination,path,interface,method,sender);
  if(!c||(argument&&sd_bus_message_append(c->request,"s",argument)<0)){
    return -1;
  }
  if(argument&&copy(c->argument,sizeof c->argument,argument))return -1;
  if(out)*out=c;
  int result=dispatch(o,m,bus,c,cleanup,effect);
  if(result){
    return result;
  }
  const char *signature=!strcmp(method,"GetUnit")?"o":!strcmp(method,"GetAll")?"a{sv}":!strcmp(method,"GetNameOwner")?"s":(!strcmp(method,"GetConnectionUnixProcessID")||!strcmp(method,"GetConnectionUnixUser"))?"u":"";
  return sd_bus_message_has_signature(c->reply,signature)<=0?-1:0;
}
static int connect_fixed(const char *path,struct np_directory *directory,int *peerfd,struct ucred *peer) {
  char copy_path[256];
  if(copy(copy_path,sizeof copy_path,path)){
    return -1;
  }
  char *slash=strrchr(copy_path,'/');
  if(!slash||!slash[1]){
    return -1;
  }
  *slash=0;
  if(np_directory_pin_v1(directory,copy_path)){
    return -1;
  }
  struct stat before,after;
  int parent=np_directory_fd_v1(directory);
  if(fstatat(parent,slash+1,&before,AT_SYMLINK_NOFOLLOW)||!S_ISSOCK(before.st_mode)||before.st_uid){
    return -1;
  }
  int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
  struct sockaddr_un address={
    .sun_family=AF_UNIX}
  ;
  int n=snprintf(address.sun_path,sizeof address.sun_path,"/proc/self/fd/%d/%s",parent,slash+1);
  if(fd<0||n<=0||(size_t)n>=sizeof address.sun_path){
    return -1;
  }
  if(connect(fd,(struct sockaddr *)&address,sizeof address)&&errno!=EINPROGRESS){
    return -1;
  }
  socklen_t size=sizeof *peer;
  if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,peer,&size)||size!=sizeof *peer){
    return -1;
  }
  size=sizeof *peerfd;
  if(getsockopt(fd,SOL_SOCKET,SO_PEERPIDFD,peerfd,&size)||size!=sizeof *peerfd||live(*peerfd)||fstatat(parent,slash+1,&after,AT_SYMLINK_NOFOLLOW)||before.st_dev!=after.st_dev||before.st_ino!=after.st_ino){
    return -1;
  }
  return fd;
}
static int attach_bus(struct np_root_origin *o,struct np_managed_original *m,sd_bus **bus,int fd,bool api) {
  if(sd_bus_new(bus)<0||sd_bus_set_bus_client(*bus,api?1:0)<0||sd_bus_set_allow_interactive_authorization(*bus,0)<0||sd_bus_set_fd(*bus,fd,fd)<0||sd_bus_add_filter(*bus,api?&m->api_filter:&m->direct_filter,event,m)<0||sd_bus_start(*bus)<0){
    return -1;
  }
  uint64_t now;
  if(np_origin_now_v1(o,&now)){
    return -1;
  }
  uint64_t end=now+2*NP_ORIGIN_SECOND;
  if(end>np_origin_ends_v1(o)->work)end=np_origin_ends_v1(o)->work;
  while(sd_bus_is_ready(*bus)<=0)if(pump(o,m,false,end)){
    return -1;
  }
  return boundary(o,m,false);
}
struct unit_facts {
  char id[96],active[32],sub[32],group[1024];
  unsigned char invocation[16];
  uint32_t job;
  pid_t pid;
  unsigned seen;
}
;
static int property_facts(sd_bus_message *reply,struct unit_facts *out,bool service) {
  if(sd_bus_message_has_signature(reply,"a{sv}")<=0||sd_bus_message_enter_container(reply,'a',"{sv}")<=0){
    return -1;
  }
  int entry;
  while((entry=sd_bus_message_enter_container(reply,'e',"sv"))>0){
    const char *key,*type=NULL;
    unsigned bit=0;
    if(sd_bus_message_read(reply,"s",&key)<=0){
      return -1;
    }
    if(service&&!strcmp(key,"MainPID")){
      type="u";
      bit=64;
    }
    if(!service){
      if(!strcmp(key,"Id")){
        type="s";
        bit=1;
      }
      else if(!strcmp(key,"ActiveState")){
        type="s";
        bit=2;
      }
      else if(!strcmp(key,"SubState")){
        type="s";
        bit=4;
      }
      else if(!strcmp(key,"InvocationID")){
        type="ay";
        bit=8;
      }
      else if(!strcmp(key,"Job")){
        type="(uo)";
        bit=16;
      }
      else if(!strcmp(key,"ControlGroup")){
        type="s";
        bit=32;
      }
    }
    if(!type){
      if(sd_bus_message_skip(reply,"v")<=0){
        return -1;
      }
    }
    else {
      if((out->seen&bit)||sd_bus_message_enter_container(reply,'v',type)<=0){
        return -1;
      }
      out->seen|=bit;
      if(!strcmp(type,"s")){
        const char *value;
        if(sd_bus_message_read(reply,"s",&value)<=0||copy(bit==1?out->id:bit==2?out->active:bit==4?out->sub:out->group,bit==1?sizeof out->id:bit==2?sizeof out->active:bit==4?sizeof out->sub:sizeof out->group,value)){
          return -1;
        }
      }
      else if(bit==8){
        const void *bytes;
        size_t length;
        if(sd_bus_message_read_array(reply,'y',&bytes,&length)<=0||length!=16){
          return -1;
        }
        memcpy(out->invocation,bytes,16);
      }
      else if(bit==16){
        const char *path;
        if(sd_bus_message_enter_container(reply,'r',"uo")<=0||sd_bus_message_read(reply,"uo",&out->job,&path)<=0||sd_bus_message_exit_container(reply)<0){
          return -1;
        }
      }
      else {
        uint32_t pid;
        if(sd_bus_message_read(reply,"u",&pid)<=0||pid>INT32_MAX){
          return -1;
        }
        out->pid=(pid_t)pid;
      }
      if(sd_bus_message_exit_container(reply)<0){
        return -1;
      }
    }
    if(sd_bus_message_exit_container(reply)<0){
      return -1;
    }
  }
  return entry==0&&sd_bus_message_exit_container(reply)>=0?0:-1;
}
static int facts(struct np_root_origin *o,struct np_managed_original *m,const char *path,bool service,bool cleanup,struct unit_facts *f) {
  memset(f,0,sizeof *f);
  struct original_call *c;
  if(simple(o,m,m->direct,MANAGER,path,"org.freedesktop.DBus.Properties","GetAll","org.freedesktop.systemd1.Unit",cleanup,-1,NULL,&c)||property_facts(c->reply,f,false)||(f->seen&31)!=31){
    return -1;
  }
  if(service&&(simple(o,m,m->direct,MANAGER,path,"org.freedesktop.DBus.Properties","GetAll","org.freedesktop.systemd1.Service",cleanup,-1,NULL,&c)||property_facts(c->reply,f,true)||(f->seen&64)!=64)){
    return -1;
  }
  if(!service&&(simple(o,m,m->direct,MANAGER,path,"org.freedesktop.DBus.Properties","GetAll","org.freedesktop.systemd1.Scope",cleanup,-1,NULL,&c)||property_facts(c->reply,f,false)||!(f->seen&32))){
    return -1;
  }
  char invocation[33];
  for(unsigned i=0;i<16;i++)snprintf(invocation+2*i,3,"%02x",f->invocation[i]);
  char prefix[1536];
  snprintf(prefix,sizeof prefix,"path=%s id=%s active=%s sub=%s invocation=%s job=%u mainPid=%ld cgroup=%s",path,f->id,f->active,f->sub,invocation,f->job,(long)f->pid,f->group);
  if(np_origin_journal_v1(o,"unit-original-facts",prefix)&&!cleanup)return -1;
  return 0;
}
static int lookup(struct np_root_origin *o,struct np_managed_original *m,const char *name,char *path,size_t size) {
  struct original_call *c;
  if(simple(o,m,m->direct,MANAGER,MANAGER_PATH,MANAGER_IFACE,"GetUnit",name,false,-1,NULL,&c)){
    return -1;
  }
  const char *object;
  return sd_bus_message_has_signature(c->reply,"o")<=0||sd_bus_message_read(c->reply,"o",&object)<=0||copy(path,size,object)?-1:0;
}
static int by_pidfd(struct np_root_origin *o,struct np_managed_original *m,int fd,const char *name,const char *path,const unsigned char invocation[16],bool cleanup) {
  struct original_call *c=message(m,m->direct,MANAGER,MANAGER_PATH,MANAGER_IFACE,"GetUnitByPIDFD",NULL);
  if(!c||sd_bus_message_append(c->request,"h",fd)<0||dispatch(o,m,m->direct,c,cleanup,-1)){
    return -1;
  }
  const char *unit,*object;
  const void *identity;
  size_t size;
  return sd_bus_message_has_signature(c->reply,"osay")<=0||sd_bus_message_read(c->reply,"os",&object,&unit)<=0||sd_bus_message_read_array(c->reply,'y',&identity,&size)<=0||size!=16||strcmp(unit,name)||strcmp(object,path)||memcmp(identity,invocation,16)?-1:0;
}
static int daemon_same(struct np_root_origin *o,struct np_managed_original *m,bool cleanup) {
  if(boundary(o,m,cleanup)){
    return -1;
  }
  int current_exe=openat(m->daemon_proc,"exe",O_RDONLY|O_CLOEXEC);
  if(current_exe<0||same(current_exe,m->daemon_exe)){
    if(current_exe>=0)close(current_exe);
    if(m->connect_sent)m->shared_unknown=true;
    return -1;
  }
  close(current_exe);
  struct unit_facts f;
  unsigned char zero[16]={
    0}
  ;
  if(facts(o,m,m->daemon_path,true,cleanup,&f)||strcmp(f.id,"dbus.service")||strcmp(f.active,"active")||strcmp(f.sub,"running")||f.job||f.pid!=m->daemon_pid||!memcmp(f.invocation,zero,16)||memcmp(f.invocation,m->daemon_invocation,16)||np_birth_live_v1(&m->daemon)||by_pidfd(o,m,m->daemon.pidfd,"dbus.service",m->daemon_path,m->daemon_invocation,cleanup)||same(m->daemon_exe,np_origin_daemon_fd_v1(o))){
    if(m->connect_sent)m->shared_unknown=true;
    return -1;
  }
  return 0;
}
int np_managed_open_v1(struct np_root_origin *o,struct np_managed_original **out) {
  struct np_managed_original *m=calloc(1,sizeof *m);
  if(!m){
    return -1;
  }
  *out=m;
  m->origin=o;
  m->manager.pidfd=m->manager.time=m->manager.children=m->daemon.pidfd=m->daemon.time=m->daemon.children=-1;
  m->listener_pidfd=m->daemon_exe=m->daemon_proc=m->events=m->collision_peer=-1;
  if(copy(m->unit,sizeof m->unit,np_origin_unit_v1(o))){
    return -1;
  }
  struct ucred peer;
  int pidfd;
  struct np_directory directory={
    0}
  ;
  int fd=connect_fixed("/run/systemd/private",&directory,&pidfd,&peer);
  if(fd<0||peer.pid!=1||peer.uid||peer.gid||np_birth_pin_v1(&m->manager,peer.pid,0,0)||live(pidfd)){
    return -1;
  }
  close(pidfd);
  np_directory_release_v1(&directory);
  if(attach_bus(o,m,&m->direct,fd,false)||simple(o,m,m->direct,MANAGER,MANAGER_PATH,MANAGER_IFACE,"Subscribe",NULL,false,-1,NULL,NULL)){
    return -1;
  }
  m->subscribed=true;
  int result=np_managed_api_ref_open_v1(o,m);
  m->initialized=!result;
  return result;
}
int np_managed_api_ref_open_v1(struct np_root_origin *o,struct np_managed_original *m) {
  struct unit_facts f;
  unsigned char zero[16]={
    0}
  ;
  /* Critically, this original active/no-job pin precedes ANY API connect. */
  if(lookup(o,m,"dbus.service",m->daemon_path,sizeof m->daemon_path)||facts(o,m,m->daemon_path,true,false,&f)||strcmp(f.id,"dbus.service")||strcmp(f.active,"active")||strcmp(f.sub,"running")||f.job||f.pid<=1||!memcmp(f.invocation,zero,16)){
    return -1;
  }
  m->daemon_pid=f.pid;
  memcpy(m->daemon_invocation,f.invocation,16);
  char path[128];
  snprintf(path,sizeof path,"/proc/%ld",(long)f.pid);
  m->daemon_proc=open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  if(m->daemon_proc<0){
    return -1;
  }
  struct stat status;
  uid_t expected_uid;
  gid_t expected_gid;
  if(np_origin_daemon_identity_v1(o,&expected_uid,&expected_gid)||fstat(m->daemon_proc,&status)||status.st_uid!=expected_uid||status.st_gid!=expected_gid||np_birth_pin_v1(&m->daemon,f.pid,expected_uid,expected_gid)){
    return -1;
  }
  m->daemon_exe=openat(m->daemon_proc,"exe",O_RDONLY|O_CLOEXEC);
  if(m->daemon_exe<0||same(m->daemon_exe,np_origin_daemon_fd_v1(o))||same(m->manager.time,m->daemon.time)||same(m->manager.children,m->daemon.children)||daemon_same(o,m,false)){
    return -1;
  }
  struct stat exe,time_ns,children_ns;
  if(fstat(m->daemon_exe,&exe)||fstat(m->daemon.time,&time_ns)||fstat(m->daemon.children,&children_ns))return -1;
  char invocation[33];
  for(unsigned i=0;i<16;i++)snprintf(invocation+2*i,3,"%02x",m->daemon_invocation[i]);
  char original[768];
  snprintf(original,sizeof original,"managerPid=%ld daemonPid=%ld daemonUid=%u daemonGid=%u invocation=%s exe=%llu:%llu time=%llu:%llu children=%llu:%llu",(long)m->manager.pid,(long)m->daemon.pid,(unsigned)m->daemon.uid,(unsigned)m->daemon.gid,invocation,(unsigned long long)exe.st_dev,(unsigned long long)exe.st_ino,(unsigned long long)time_ns.st_dev,(unsigned long long)time_ns.st_ino,(unsigned long long)children_ns.st_dev,(unsigned long long)children_ns.st_ino);
  if(np_origin_journal_v1(o,"daemon-preconnect-pin",original))return -1;
  uint64_t connect_now;
  if(np_origin_now_v1(o,&connect_now))return -1;
  uint64_t connect_end=connect_now+2*NP_ORIGIN_SECOND;
  if(connect_end>np_origin_ends_v1(o)->work)connect_end=np_origin_ends_v1(o)->work;
  if(np_origin_effect_begin_v1(o,NP_ORIGIN_CONNECT)){
    return -1;
  }
  m->connect_sent=true;
  if(np_origin_journal_v1(o,"api-connect-armed",original)){np_origin_effect_end_v1(o);
  return -1;
  }
  if(np_origin_effect_check_v1(o,false,connect_end)){np_origin_effect_end_v1(o);return -1;}
  struct ucred peer;
  int fd=connect_fixed("/run/dbus/system_bus_socket",&m->socket_path,&m->listener_pidfd,&peer);
  np_origin_effect_end_v1(o);
  if(fd<0||!((peer.pid==m->daemon_pid&&peer.uid==m->daemon.uid&&peer.gid==m->daemon.gid)||(peer.pid==1&&!peer.uid&&!peer.gid))||daemon_same(o,m,false)){
    m->shared_unknown=true;
    return -1;
  }
  if(attach_bus(o,m,&m->api,fd,true)||daemon_same(o,m,false)){
    return -1;
  }
  const char *sender;
  if(sd_bus_get_unique_name(m->api,&sender)<0||copy(m->sender,sizeof m->sender,sender)||simple(o,m,m->api,DAEMON,DAEMON_PATH,DAEMON,"AddMatch",MATCH,false,-1,DAEMON,NULL)){
    return -1;
  }
  m->matched=true;
  struct original_call *c;
  const char *unique;
  if(simple(o,m,m->api,DAEMON,DAEMON_PATH,DAEMON,"GetNameOwner",MANAGER,false,-1,DAEMON,&c)||sd_bus_message_has_signature(c->reply,"s")<=0||sd_bus_message_read(c->reply,"s",&unique)<=0||*unique!=':'||copy(m->unique,sizeof m->unique,unique)){
    return -1;
  }
  return np_managed_live_v1(o,m);
}
static int api_owner(struct np_root_origin *o,struct np_managed_original *m,bool cleanup) {
  struct original_call *c;
  const char *unique;
  uint32_t pid,uid;
  if(simple(o,m,m->api,DAEMON,DAEMON_PATH,DAEMON,"GetNameOwner",MANAGER,cleanup,-1,DAEMON,&c)||sd_bus_message_read(c->reply,"s",&unique)<=0||strcmp(unique,m->unique)){
    return -1;
  }
  if(simple(o,m,m->api,DAEMON,DAEMON_PATH,DAEMON,"GetConnectionUnixProcessID",m->unique,cleanup,-1,DAEMON,&c)||sd_bus_message_read(c->reply,"u",&pid)<=0||pid!=1){
    return -1;
  }
  if(simple(o,m,m->api,DAEMON,DAEMON_PATH,DAEMON,"GetConnectionUnixUser",m->unique,cleanup,-1,DAEMON,&c)||sd_bus_message_read(c->reply,"u",&uid)<=0||uid){
    return -1;
  }
  const char *sender;
  if(sd_bus_get_unique_name(m->api,&sender)<0||strcmp(sender,m->sender)){
    return -1;
  }
  return daemon_same(o,m,cleanup);
}
int np_managed_live_v1(struct np_root_origin *o,struct np_managed_original *m) {
  uint64_t now;
  if(!m||m->closed||boundary(o,m,false)||np_origin_now_v1(o,&now)){
    return -1;
  }
  if(now-m->last_check<NP_ORIGIN_SECOND){
    return 0;
  }
  if(daemon_same(o,m,false)){
    return -1;
  }
  m->last_check=now;
  return 0;
}
static int property(sd_bus_message *message,const char *name,const char *type) {
  return sd_bus_message_open_container(message,'r',"sv")<0||sd_bus_message_append(message,"s",name)<0||sd_bus_message_open_container(message,'v',type)<0?-1:0;
}
static int property_end(sd_bus_message *message){
  return sd_bus_message_close_container(message)<0||sd_bus_message_close_container(message)<0?-1:0;
}
static int job_done(struct np_root_origin *o,struct np_managed_original *m,const char *path,bool cleanup) {
  uint64_t now;
  if(np_origin_now_v1(o,&now)){
    return -1;
  }
  uint64_t end=now+2*NP_ORIGIN_SECOND;
  if(end>(cleanup?np_origin_ends_v1(o)->cleanup:np_origin_ends_v1(o)->work))end=cleanup?np_origin_ends_v1(o)->cleanup:np_origin_ends_v1(o)->work;
  for(;;){
    for(unsigned i=0;i<m->job_count;i++)if(!strcmp(m->jobs[i].path,path)&&!strcmp(m->jobs[i].unit,np_origin_unit_v1(o))){
      return strcmp(m->jobs[i].outcome,"done")?-1:0;
    }
    if(pump(o,m,cleanup,end)){
      return -1;
    }
  }
}
static int absent(struct np_root_origin *o,struct np_managed_original *m,sd_bus *bus) {
  struct original_call *c;
  int result=simple(o,m,bus,MANAGER,MANAGER_PATH,MANAGER_IFACE,"GetUnit",np_origin_unit_v1(o),false,-1,NULL,&c);
  return result!=1||sd_bus_message_is_method_error(c->reply,"org.freedesktop.systemd1.NoSuchUnit")<=0?-1:0;
}
static int collisions(struct np_root_origin *o,struct np_managed_original *m) {
  if(absent(o,m,m->direct)){
    return -1;
  }
  struct ucred peer;
  m->collision_unknown=true;
  int fd=connect_fixed("/run/user/0/systemd/private",&m->collision_path,&m->collision_peer,&peer);
  if(fd<0||peer.uid||peer.gid){
    return -1;
  }
  if(sd_bus_new(&m->collision)<0||sd_bus_set_bus_client(m->collision,0)<0||sd_bus_set_allow_interactive_authorization(m->collision,0)<0||sd_bus_set_fd(m->collision,fd,fd)<0||sd_bus_start(m->collision)<0){
    return -1;
  }
  uint64_t now;
  if(np_origin_now_v1(o,&now)){
    return -1;
  }
  uint64_t end=now+2*NP_ORIGIN_SECOND;
  while(sd_bus_is_ready(m->collision)<=0){
    if(np_origin_now_v1(o,&now)||now>=end||live(m->collision_peer)||sd_bus_process(m->collision,NULL)<0){
      return -1;
    }
    struct pollfd p={
      .fd=sd_bus_get_fd(m->collision),.events=POLLIN|POLLOUT}
    ;
    (void)poll(&p,1,1);
  }
  /* Pump the one original collision query without selecting this manager. */
  struct original_call *c=message(m,m->collision,MANAGER,MANAGER_PATH,MANAGER_IFACE,"GetUnit",NULL);
  if(!c||sd_bus_message_append(c->request,"s",np_origin_unit_v1(o))<0){
    return -1;
  }
  c->sent=true;
  c->unknown=true;
  if(np_origin_journal_v1(o,"collision-query-unknown",np_origin_unit_v1(o)))return -1;
  if(sd_bus_call_async(m->collision,&c->slot,c->request,response,c,UINT64_C(2000000))<0||sd_bus_message_get_cookie(c->request,&c->cookie)<0){
    return -1;
  }
  c->unknown=false;
  while(!c->done){
    if(np_origin_now_v1(o,&now)||now>=end||live(m->collision_peer)||sd_bus_process(m->collision,NULL)<0){
      return -1;
    }
    struct pollfd p={
      .fd=sd_bus_get_fd(m->collision),.events=POLLIN|POLLOUT}
    ;
    (void)poll(&p,1,1);
  }
  uint64_t queued;
  if(c->unknown||!c->error||sd_bus_message_is_method_error(c->reply,"org.freedesktop.systemd1.NoSuchUnit")<=0||sd_bus_get_n_queued_write(m->collision,&queued)<0||queued||np_origin_boundary_v1(o,false)){
    return -1;
  }
  sd_bus_close_unref(m->collision);
  m->collision=NULL;
  close(m->collision_peer);
  m->collision_peer=-1;
  np_directory_release_v1(&m->collision_path);
  if(np_origin_journal_v1(o,"collision-query-absent",np_origin_unit_v1(o)))return -1;
  m->collision_unknown=false;
  return 0;
}
int np_managed_launch_v1(struct np_root_origin *o,struct np_managed_original *m,int pidfd,pid_t child) {
  if(m->start_sent||live(pidfd)||collisions(o,m)||api_owner(o,m,false)){
    return -1;
  }
  m->child=child;
  m->child_pidfd=pidfd;
  struct original_call *c=message(m,m->direct,MANAGER,MANAGER_PATH,MANAGER_IFACE,"StartTransientUnit",NULL);
  if(!c){
    return -1;
  }
  sd_bus_message *q=c->request;
  uint64_t now;
  if(np_origin_now_v1(o,&now)){
    return -1;
  }
  uint64_t runtime=(np_origin_ends_v1(o)->cleanup-now)/1000;
  if(sd_bus_message_append(q,"ss",np_origin_unit_v1(o),"fail")<0||sd_bus_message_open_container(q,'a',"(sv)")<0||property(q,"PIDFDs","ah")||sd_bus_message_open_container(q,'a',"h")<0||sd_bus_message_append(q,"h",pidfd)<0||sd_bus_message_close_container(q)<0||property_end(q)||property(q,"KillMode","s")||sd_bus_message_append(q,"s","control-group")<0||property_end(q)||property(q,"TimeoutStopUSec","t")||sd_bus_message_append(q,"t",UINT64_C(2000000))<0||property_end(q)||property(q,"RuntimeMaxUSec","t")||sd_bus_message_append(q,"t",runtime)<0||property_end(q)||sd_bus_message_close_container(q)<0||sd_bus_message_open_container(q,'a',"(sa(sv))")<0||sd_bus_message_close_container(q)<0){
    return -1;
  }
  char prefix[256];
  snprintf(prefix,sizeof prefix,"child=%ld originalPidfd=%d unit=%s runtimeUSec=%llu",(long)child,pidfd,np_origin_unit_v1(o),(unsigned long long)runtime);
  if(np_origin_journal_v1(o,"scope-start-intent",prefix))return -1;
  m->start_sent=true;
  if(dispatch(o,m,m->direct,c,false,NP_ORIGIN_START)){
    return -1;
  }
  const char *job;
  if(sd_bus_message_has_signature(c->reply,"o")<=0||sd_bus_message_read(c->reply,"o",&job)<=0||copy(m->start_job,sizeof m->start_job,job)||job_done(o,m,m->start_job,false)||lookup(o,m,np_origin_unit_v1(o),m->scope_path,sizeof m->scope_path)){
    return -1;
  }
  struct unit_facts f;
  unsigned char zero[16]={
    0}
  ;
  if(facts(o,m,m->scope_path,false,false,&f)||strcmp(f.id,np_origin_unit_v1(o))||strcmp(f.active,"active")||f.job||!memcmp(f.invocation,zero,16)||!(f.seen&32)||f.group[0]!='/'||copy(m->cgroup_name,sizeof m->cgroup_name,f.group)){
    return -1;
  }
  memcpy(m->scope_invocation,f.invocation,16);
  if(by_pidfd(o,m,pidfd,np_origin_unit_v1(o),m->scope_path,m->scope_invocation,false))return -1;
  m->associated=true;
  if(np_managed_ref_original_v1(o,m)){
    return -1;
  }
  char path[1200];
  int n=snprintf(path,sizeof path,"/sys/fs/cgroup%s",f.group);
  if(n<=0||(size_t)n>=sizeof path||np_directory_pin_v1(&m->cgroup,path)||live(pidfd)){
    return -1;
  }
  m->events=openat(np_directory_fd_v1(&m->cgroup),"cgroup.events",O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  snprintf(path,sizeof path,"/proc/%ld/cgroup",(long)child);
  int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  int membership=fd<0?-1:np_managed_cgroup_read_v1(fd,f.group);
  if(fd>=0)close(fd);
  return m->events<0||membership||live(pidfd)||by_pidfd(o,m,pidfd,np_origin_unit_v1(o),m->scope_path,m->scope_invocation,false)?-1:0;
}
static int scope_same(struct np_root_origin *o,struct np_managed_original *m,bool cleanup) {
  struct unit_facts f;
  if(!m->associated||facts(o,m,m->scope_path,false,cleanup,&f)||strcmp(f.id,np_origin_unit_v1(o))||memcmp(f.invocation,m->scope_invocation,16)||strcmp(f.group,m->cgroup_name)){
    return -1;
  }
  return 0;
}
int np_managed_ref_original_v1(struct np_root_origin *o,struct np_managed_original *m) {
  if(m->reference!=REF_UNSENT||api_owner(o,m,false)||scope_same(o,m,false)){
    return -1;
  }
  m->reference=REF_SENT_UNKNOWN;
  if(np_origin_journal_v1(o,"reference-sent-unknown",m->unit))return -1;
  if(simple(o,m,m->api,m->unique,MANAGER_PATH,MANAGER_IFACE,"RefUnit",np_origin_unit_v1(o),false,NP_ORIGIN_REF,m->unique,NULL)||api_owner(o,m,false)||scope_same(o,m,false)){
    return -1;
  }
  if(np_origin_journal_v1(o,"reference-ack-held",m->unit))return -1;
  m->reference=REF_ACK_HELD;
  return 0;
}
int np_managed_stop_v1(struct np_root_origin *o,struct np_managed_original *m) {
  if(!m->associated||m->stop_sent||scope_same(o,m,true)){
    return -1;
  }
  struct original_call *c=message(m,m->direct,MANAGER,MANAGER_PATH,MANAGER_IFACE,"StopUnit",NULL);
  if(!c||sd_bus_message_append(c->request,"ss",np_origin_unit_v1(o),"fail")<0){
    return -1;
  }
  m->stop_sent=true;
  if(dispatch(o,m,m->direct,c,true,NP_ORIGIN_STOP)){
    return -1;
  }
  const char *job;
  if(sd_bus_message_has_signature(c->reply,"o")<=0||sd_bus_message_read(c->reply,"o",&job)<=0||copy(m->stop_job,sizeof m->stop_job,job)){
    return -1;
  }
  return job_done(o,m,m->stop_job,true);
}
int np_managed_unref_original_v1(struct np_root_origin *o,struct np_managed_original *m) {
  if(m->reference!=REF_ACK_HELD||api_owner(o,m,true)||scope_same(o,m,true)){
    return -1;
  }
  m->reference=REF_RELEASE_UNKNOWN;
  (void)np_origin_journal_v1(o,"reference-release-unknown",m->unit);
  if(simple(o,m,m->api,m->unique,MANAGER_PATH,MANAGER_IFACE,"UnrefUnit",np_origin_unit_v1(o),true,NP_ORIGIN_UNREF,m->unique,NULL)||api_owner(o,m,true)){
    return -1;
  }
  (void)np_origin_journal_v1(o,"reference-release-acked",m->unit);
  m->reference=REF_RELEASE_ACKED;
  return 0;
}
int np_managed_connections_settle_v1(struct np_root_origin *o,struct np_managed_original *m) {
  if(!m){
    return 0;
  }
  if(m->closed){
    return m->lost||m->shared_unknown?-1:0;
  }
  if(!m->initialized||m->collision_unknown||m->collision||(m->start_sent&&!m->associated)){
    return -1;
  }
  if(m->associated){
    char events[256]={
      0}
    ;
    if(m->events<0||pread(m->events,events,sizeof events-1,0)<=0||!strstr(events,"populated 0\n")||job_done(o,m,m->start_job,true)||(m->stop_sent&&job_done(o,m,m->stop_job,true))||np_managed_unref_original_v1(o,m)){
      return -1;
    }
  }
  if(m->reference==REF_SENT_UNKNOWN||m->reference==REF_RELEASE_UNKNOWN){
    return -1;
  }
  if(m->matched&&simple(o,m,m->api,DAEMON,DAEMON_PATH,DAEMON,"RemoveMatch",MATCH,true,-1,DAEMON,NULL)){
    return -1;
  }
  if(m->subscribed&&simple(o,m,m->direct,MANAGER,MANAGER_PATH,MANAGER_IFACE,"Unsubscribe",NULL,true,-1,NULL,NULL)){
    return -1;
  }
  for(unsigned i=0;i<m->call_count;i++)if(m->calls[i].sent&&(!m->calls[i].done||m->calls[i].unknown)){
    return -1;
  }
  uint64_t queued;
  if((m->direct&&(sd_bus_get_n_queued_write(m->direct,&queued)<0||queued))||(m->api&&(sd_bus_get_n_queued_write(m->api,&queued)<0||queued))||np_origin_boundary_v1(o,true)){
    return -1;
  }
  sd_bus_close_unref(m->api);
  sd_bus_close_unref(m->direct);
  m->api=m->direct=NULL;
  m->closed=true;
  return m->lost||m->shared_unknown?-1:0;
}
bool np_managed_shared_unknown_v1(struct np_managed_original *m){
  return m&&m->shared_unknown;
}
