#define _GNU_SOURCE
#include "retained-v2-actors.h"
#include "stock-bus-abi.h"
#include "root-managed-launch.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#define MP "/org/freedesktop/systemd1"
#define MI "org.freedesktop.systemd1.Manager"
#define UI "org.freedesktop.systemd1.Unit"
#define SI "org.freedesktop.systemd1.Scope"
enum actor_call { ABSENT, SUBSCRIBE, START, LOOKUP, UNIT, SCOPE, BY_PIDFD, REFERENCE, FREEZE, FINAL_UNIT, FINAL_SCOPE, ACTOR_CALLS };
struct actor_request {
  sd_bus_message *request,*reply;
  sd_bus_slot *slot;
  uint64_t serial;
  bool attempted,done,failed;
};
struct np_actor_manager {
  const struct np_actor_context *context;
  struct np_directory socket_parent;
  sd_bus *bus;
  sd_bus_slot *filter;
  struct actor_request requests[ACTOR_CALLS];
  sd_bus_message *incoming[NP_ACTOR_MESSAGES];
  unsigned messages;
  char unit[128],path[512],group[768],job[128];
  struct np_actor_event_debt notifications;
  unsigned char invocation[16];
  uint32_t job_id;
  bool job_done,referenced,frozen,closed,lost;
};
static const char *const methods[ACTOR_CALLS]={"GetUnit","Subscribe","StartTransientUnit","GetUnit","GetAll","GetAll","GetUnitByPIDFD","RefUnit","Freeze","GetAll","GetAll"};
static int lost(struct np_actor_manager *m){m->lost=true;
  errno=ESTALE;
  return -1;
}
static int copy(char *to,size_t capacity,const char *from){if(!from || strlen(from)>=capacity)return -1;
  memcpy(to,from,strlen(from)+1);
  return 0;
}
static int current(struct np_actor_manager *m) {
  if(!m || m->lost || m->closed || np_origin_boundary_v1(m->context->origin,false) || np_directory_check_v1(&m->socket_parent) || np_birth_associate_v1(m->context->original.clock,m->context->manager))return m?lost(m):-1;
  struct ucred peer;
  socklen_t n=sizeof peer;
  if(getsockopt(sd_bus_get_fd(m->bus),SOL_SOCKET,SO_PEERCRED,&peer,&n) || n!=sizeof peer || peer.pid!=1 || peer.uid || peer.gid)return lost(m);
  return 0;
}
static int signal_message(sd_bus_message *message,void *data,sd_bus_error *error) {
  (void)error;
  struct np_actor_manager *m=data;
  uint8_t type;
  if(sd_bus_message_get_type(message,&type)<0 || m->messages==NP_ACTOR_MESSAGES)return lost(m);
  m->incoming[m->messages++]=sd_bus_message_ref(message);
  if(type==1){(void)lost(m);
    return 1;
  }
  if(type!=4)return 0;
  if(sd_bus_message_is_signal(message,MI,"JobRemoved")>0){
    const char *job,*unit,*result;
    uint32_t id;
    if(!sd_bus_message_get_path(message) || strcmp(sd_bus_message_get_path(message),MP) || sd_bus_message_has_signature(message,"uoss")<=0 || sd_bus_message_read(message,"uoss",&id,&job,&unit,&result)<=0 || np_actor_observer_note(&m->notifications,NP_ACTOR_JOB_REMOVED,unit,job,id,result) || strcmp(unit,m->unit) || strcmp(result,"done") || m->job_done)return lost(m);
    if(m->job[0] && (strcmp(job,m->job) || id!=m->job_id))return lost(m);
    if(copy(m->job,sizeof m->job,job))return lost(m);
    m->job_id=id;
    m->job_done=true;
    return 0;
  }
  if(sd_bus_message_is_signal(message,"org.freedesktop.DBus.Properties","PropertiesChanged")>0){
    const char *path=sd_bus_message_get_path(message);
    return !path || strcmp(path,m->path) || np_actor_notification_decode(message,&m->notifications)?lost(m):0;
  }
  if(sd_bus_message_is_signal(message,MI,"UnitNew")>0 || sd_bus_message_is_signal(message,MI,"JobNew")>0){
    const char *unit,*path;
    uint32_t id=0;bool job=sd_bus_message_is_signal(message,MI,"JobNew")>0;
    if(!sd_bus_message_get_path(message) || strcmp(sd_bus_message_get_path(message),MP) || sd_bus_message_has_signature(message,job?"uos":"so")<=0)return lost(m);
    int r=job?sd_bus_message_read(message,"uos",&id,&path,&unit):sd_bus_message_read(message,"so",&unit,&path);
    return r<=0 || np_actor_observer_note(&m->notifications,job?NP_ACTOR_JOB_NEW:NP_ACTOR_UNIT_NEW,unit,path,id,NULL)?lost(m):0;
  }
  return lost(m);
}
static int reply(sd_bus_message *message,void *data,sd_bus_error *error) {
  (void)error;
  struct actor_request *r=data;
  uint64_t serial;
  if(r->done || sd_bus_message_get_reply_cookie(message,&serial)<0 || serial!=r->serial){r->failed=true;
    return 1;
  }
  r->reply=sd_bus_message_ref(message);
  r->done=true;
  return 1;
}
static int pump(struct np_actor_manager *m) {
  if(current(m) || sd_bus_process(m->bus,NULL)<0)return lost(m);
  struct pollfd p={.fd=sd_bus_get_fd(m->bus),.events=POLLIN|POLLOUT};
  if(poll(&p,1,1)<0 || current(m))return lost(m);
  return 0;
}
static int request(struct np_actor_manager *m,enum actor_call index) {
  struct actor_request *r=&m->requests[index];
  if(index==REFERENCE || current(m) || r->attempted)return lost(m);
  bool properties=index==UNIT || index==SCOPE || index==FINAL_UNIT || index==FINAL_SCOPE;
  const char *path=properties || index==FREEZE?m->path:MP;
  const char *interface=properties?"org.freedesktop.DBus.Properties":index==FREEZE?UI:MI;
  if(sd_bus_message_new_method_call(m->bus,&r->request,"org.freedesktop.systemd1",path,interface,methods[index])<0 || sd_bus_message_set_auto_start(r->request,0)<0 || sd_bus_message_set_allow_interactive_authorization(r->request,0)<0)return lost(m);
  return 0;
}
static int dispatch(struct np_actor_manager *m,enum actor_call index) {
  struct actor_request *r=&m->requests[index];
  if(current(m) || !r->request || r->attempted || np_origin_retained_lock_v2(m->context->origin))return lost(m);
  /* The once-only slot is consumed before libsystemd can buffer any bytes. */
  r->attempted=true;
  int result=sd_bus_call_async(m->bus,&r->slot,r->request,reply,r,UINT64_C(2000000))<0 || sd_bus_message_get_cookie(r->request,&r->serial)<0 || !r->serial;
  np_origin_retained_unlock_v2(m->context->origin);
  if(result)return lost(m);
  while(!r->done){if(pump(m))return -1;
  }
  uint64_t queued=0;
  if(current(m) || r->failed || sd_bus_get_n_queued_write(m->bus,&queued)<0 || queued)return lost(m);
  const sd_bus_error *error=sd_bus_message_get_error(r->reply);
  if(index==ABSENT)return !error || sd_bus_message_is_method_error(r->reply,"org.freedesktop.systemd1.NoSuchUnit")<=0?lost(m):0;
  return error?lost(m):0;
}
static int property(sd_bus_message *q,const char *name,const char *signature) {
  return sd_bus_message_open_container(q,'r',"sv")<0 || sd_bus_message_append(q,"s",name)<0 || sd_bus_message_open_container(q,'v',signature)<0?-1:0;
}
static int end_property(sd_bus_message *q){return sd_bus_message_close_container(q)<0 || sd_bus_message_close_container(q)<0?-1:0;
}
static int string_property(sd_bus_message *q,const char *name,const char *value){return property(q,name,"s") || sd_bus_message_append(q,"s",value)<0 || end_property(q)?-1:0;
}
static int unit_path(char *out,size_t capacity,const char *unit) {
  size_t at=strlen(MP "/unit/");
  if(at>=capacity)return -1;
  memcpy(out,MP "/unit/",at);
  for(const unsigned char *p=(const unsigned char *)unit;*p;p++){
    if((*p>='a'&&*p<='z') || (*p>='0'&&*p<='9')){if(at+1>=capacity)return -1;
      out[at++]=(char)*p;
    }
    else {if(at+3>=capacity || snprintf(out+at,capacity-at,"_%02x",*p)!=3)return -1;
      at+=3;
    }
  }out[at]=0;
  return 0;
}
static int job_id(const char *path,uint32_t *id) {
  if(!path || !id)return -1;
  unsigned value;
  int end=0;
  if(sscanf(path,MP "/job/%u%n",&value,&end)!=1 || path[end] || !value)return -1;
  char canonical[128];
  int n=snprintf(canonical,sizeof canonical,MP "/job/%u",value);
  if(n<=0 || (size_t)n>=sizeof canonical || strcmp(path,canonical))return -1;
  *id=value;
  return 0;
}
/* Exact stock-v255 change/invalidation projection. This decodes DATA only:
 * no notification supplies identity/hold/reference authority. Final original
 * Unit/Scope facts and kernel graph remain independent required observations. */
int np_actor_notification_decode(sd_bus_message *message,const struct np_actor_event_debt *debt){
  static const char *const timestamps[]={"StateChangeTimestamp","StateChangeTimestampMonotonic","InactiveExitTimestamp","InactiveExitTimestampMonotonic","ActiveEnterTimestamp","ActiveEnterTimestampMonotonic","ActiveExitTimestamp","ActiveExitTimestampMonotonic","InactiveEnterTimestamp","InactiveEnterTimestampMonotonic","ConditionTimestamp","ConditionTimestampMonotonic","AssertTimestamp","AssertTimestampMonotonic"};
  static const char *const strings[]={"ActiveState","SubState","FreezerState","Controller","Result"};
  const char *interface,*path=sd_bus_message_get_path(message);
  if(!debt || !path || strcmp(path,debt->path) || sd_bus_message_is_signal(message,"org.freedesktop.DBus.Properties","PropertiesChanged")<=0 || sd_bus_message_has_signature(message,"sa{sv}as")<=0 || sd_bus_message_read(message,"s",&interface)<=0)return -1;
  bool scope=!strcmp(interface,SI);if(!scope && strcmp(interface,UI))return -1;
  if(sd_bus_message_enter_container(message,'a',"{sv}")<=0)return -1;
  uint64_t seen=0;int entry;unsigned fields=0;
  while((entry=sd_bus_message_enter_container(message,'e',"sv"))>0){
    const char *key;int index=-1;const char *signature=NULL;
    if(++fields>24 || sd_bus_message_read(message,"s",&key)<=0)return -1;
    for(unsigned i=0;i<5;i++)if(!strcmp(key,strings[i])){if(scope!=(i>=3))return -1;index=(int)i;signature="s";}
    if(!scope)for(unsigned i=0;i<14;i++)if(!strcmp(key,timestamps[i])){index=5+(int)i;signature="t";}
    if(!scope && !strcmp(key,"Job")){index=19;signature="(uo)";}
    if(!scope && !strcmp(key,"ConditionResult")){index=20;signature="b";}
    if(!scope && !strcmp(key,"AssertResult")){index=21;signature="b";}
    if(!scope && !strcmp(key,"InvocationID")){index=22;signature="ay";}
    if(!scope && !strcmp(key,"ActivationDetails")){index=23;signature="a(ss)";}
    if(index<0 || (seen&(UINT64_C(1)<<index)) || sd_bus_message_enter_container(message,'v',signature)<=0)return -1;
    seen|=UINT64_C(1)<<index;
    if(index<5){
      const char *value;if(sd_bus_message_read(message,"s",&value)<=0)return -1;
      if(index==0 && strcmp(value,"active") && strcmp(value,"activating") && strcmp(value,"inactive") && strcmp(value,"deactivating"))return -1;
      if(index==1 && strcmp(value,"running") && strcmp(value,"dead") && strcmp(value,"start-chown") && strcmp(value,"stop-sigterm") && strcmp(value,"stop-sigkill"))return -1;
      if(index==2 && strcmp(value,"running") && strcmp(value,"freezing") && strcmp(value,"frozen") && strcmp(value,"thawing"))return -1;
      if(index==3 && value[0])return -1;
      if(index==4 && strcmp(value,"success"))return -1;
    }else if(index<19){uint64_t value;if(sd_bus_message_read(message,"t",&value)<=0 || value>INT64_MAX)return -1;
    }else if(index==19){
      uint32_t id,parsed;const char *job;
      if(sd_bus_message_enter_container(message,'r',"uo")<=0 || sd_bus_message_read(message,"uo",&id,&job)<=0 || sd_bus_message_exit_container(message)<0)return -1;
      if(!id){if(strcmp(job,"/"))return -1;}
      else if(job_id(job,&parsed) || parsed!=id || !debt->job_seen || debt->job_done || debt->job_id!=id || strcmp(debt->job,job))return -1;
    }else if(index<22){int value;if(sd_bus_message_read(message,"b",&value)<=0 || (value!=0 && value!=1))return -1;
    }else if(index==22){const void *identity;size_t length;if(sd_bus_message_read_array(message,'y',&identity,&length)<=0 || length!=16)return -1;
    }else{
      /* No activation triggers in this fixed directly requested scope. */
      if(sd_bus_message_enter_container(message,'a',"(ss)")<=0 || sd_bus_message_at_end(message,0)<=0 || sd_bus_message_exit_container(message)<0)return -1;
    }
    if(sd_bus_message_at_end(message,0)<=0 || sd_bus_message_exit_container(message)<0 || sd_bus_message_exit_container(message)<0)return -1;
  }
  if(entry<0 || sd_bus_message_exit_container(message)<0 || sd_bus_message_enter_container(message,'a',"s")<=0)return -1;
  unsigned invalidations=0;const char *invalid;
  while((entry=sd_bus_message_read(message,"s",&invalid))>0){
    unsigned bit=!strcmp(invalid,"Conditions")?1:!strcmp(invalid,"Asserts")?2:0;
    if(scope || !bit || (invalidations&bit))return -1;
    invalidations|=bit;
  }
  if(entry<0 || sd_bus_message_exit_container(message)<0 || sd_bus_message_at_end(message,1)<=0 || (!fields&&!invalidations))return -1;
  return 0;
}
int np_actor_observer_note(struct np_actor_event_debt *debt,enum np_actor_observer_note note,const char *unit,const char *object,uint32_t id,const char *outcome) {
  if(!debt || !unit || !object || strcmp(unit,debt->unit))return -1;
  if(note==NP_ACTOR_UNIT_NEW){
    if(debt->unit_seen || strcmp(object,debt->path) || id || outcome)return -1;
    debt->unit_seen=true;
    return 0;
  }
  uint32_t observed;
  if(job_id(object,&observed) || observed!=id)return -1;
  if(note==NP_ACTOR_JOB_NEW){
    if(debt->job_seen || debt->job_done || outcome || copy(debt->job,sizeof debt->job,object))return -1;
    debt->job_seen=true;
    debt->job_id=id;
    return 0;
  }
  if(note!=NP_ACTOR_JOB_REMOVED || !debt->job_seen || debt->job_done || debt->job_id!=id || strcmp(debt->job,object) || !outcome || strcmp(outcome,"done"))return -1;
  debt->job_done=true;
  return 0;
}
int np_actor_manager_observer_check(const struct np_actor_manager *m,const struct np_actor_event_debt *debt) {
  if(!m || !debt || m->closed || m->lost || strcmp(m->unit,debt->unit) || strcmp(m->path,debt->path))return -1;
  bool events=debt->unit_seen || debt->job_seen || debt->job_done;
  if(!m->requests[START].attempted)return events?-1:0;
  if(!m->requests[START].done || m->requests[START].failed || !m->referenced || !m->job_done || !debt->unit_seen || !debt->job_seen || !debt->job_done || m->job_id!=debt->job_id || strcmp(m->job,debt->job))return -1;
  return 0;
}
static int facts(struct np_actor_manager *m,enum actor_call index,bool held) {
  bool scope=index==SCOPE || index==FINAL_SCOPE;
  if(request(m,index) || sd_bus_message_append(m->requests[index].request,"s",scope?SI:UI)<0 || dispatch(m,index))return lost(m);
  sd_bus_message *r=m->requests[index].reply;
  if(sd_bus_message_has_signature(r,"a{sv}")<=0 || sd_bus_message_enter_container(r,'a',"{sv}")<=0)return lost(m);
  unsigned seen=0;
  int entry;
  while((entry=sd_bus_message_enter_container(r,'e',"sv"))>0){
    const char *key,*value=NULL;
    unsigned bit=0;
    if(sd_bus_message_read(r,"s",&key)<=0)return lost(m);
    if(scope && !strcmp(key,"ControlGroup"))bit=1;
    else if(scope && !strcmp(key,"Delegate"))bit=2;
    else if(!scope && !strcmp(key,"Id"))bit=1;
    else if(!scope && !strcmp(key,"ActiveState"))bit=2;
    else if(!scope && !strcmp(key,"InvocationID"))bit=4;
    else if(!scope && !strcmp(key,"Job"))bit=8;
    else if(!scope && !strcmp(key,"FreezerState"))bit=16;
    if(bit && (seen&bit))return lost(m);
    if(scope && bit==2){int delegate;
      if(sd_bus_message_enter_container(r,'v',"b")<=0 || sd_bus_message_read(r,"b",&delegate)<=0 || delegate || sd_bus_message_exit_container(r)<0)return lost(m);
    }
    else if(!scope && bit==4){const void *bytes;
      size_t length;
      unsigned char zero[16]={0};
      if(sd_bus_message_enter_container(r,'v',"ay")<=0 || sd_bus_message_read_array(r,'y',&bytes,&length)<=0 || length!=16 || !memcmp(bytes,zero,16) || sd_bus_message_exit_container(r)<0)return lost(m);
      if(held && memcmp(bytes,m->invocation,16))return lost(m);
      memcpy(m->invocation,bytes,16);
    }
    else if(!scope && bit==8){uint32_t id;
      const char *path;
      if(sd_bus_message_enter_container(r,'v',"(uo)")<=0 || sd_bus_message_read(r,"(uo)",&id,&path)<=0 || id || strcmp(path,"/") || sd_bus_message_exit_container(r)<0)return lost(m);
    }
    else if(bit){if(sd_bus_message_enter_container(r,'v',"s")<=0 || sd_bus_message_read(r,"s",&value)<=0 || sd_bus_message_exit_container(r)<0)return lost(m);
      if(scope){char expected[768];
        int n=snprintf(expected,sizeof expected,"/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/%s/%s",m->context->slice,m->unit);
        if(n<=0 || (size_t)n>=sizeof expected || strcmp(value,expected) || (held && strcmp(value,m->group)) || copy(m->group,sizeof m->group,value))return lost(m);
      }
      else if((bit==1 && strcmp(value,m->unit)) || (bit==2 && strcmp(value,"active")) || (bit==16 && strcmp(value,held?"frozen":"running")))return lost(m);
    }else if(sd_bus_message_skip(r,"v")<0)return lost(m);
    seen|=bit;
    if(sd_bus_message_exit_container(r)<0)return lost(m);
  }
  if(entry<0 || seen!=(scope?3u:31u) || sd_bus_message_exit_container(r)<0)return lost(m);
  return 0;
}
int np_actor_manager_connect(struct np_actor_manager **out,const struct np_actor_context *context) {
  if(!out || !context || !context->origin)return -1;
  *out=NULL;
  struct np_actor_manager *m=calloc(1,sizeof *m);
  if(!m)return -1;
  *out=m;
  m->context=context;
  int n=snprintf(m->unit,sizeof m->unit,"subscription-runtime-actors-%s.scope",context->reservation);
  if(n<=0 || (size_t)n>=sizeof m->unit || unit_path(m->path,sizeof m->path,m->unit) || np_directory_pin_v1(&m->socket_parent,"/run/systemd"))return lost(m);
  memcpy(m->notifications.unit,m->unit,sizeof m->notifications.unit);
  memcpy(m->notifications.path,m->path,sizeof m->notifications.path);
  struct stat before,after;
  if(fstatat(np_directory_fd_v1(&m->socket_parent),"private",&before,AT_SYMLINK_NOFOLLOW) || !S_ISSOCK(before.st_mode) || before.st_uid || before.st_gid)return lost(m);
  int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);
  if(fd<0)return lost(m);
  struct sockaddr_un address={.sun_family=AF_UNIX};
  memcpy(address.sun_path,"/run/systemd/private",sizeof "/run/systemd/private");
  if(np_origin_retained_lock_v2(context->origin)){close(fd);
    return lost(m);
  }
  int result=connect(fd,(struct sockaddr *)&address,sizeof address);
  int saved=errno;
  np_origin_retained_unlock_v2(context->origin);
  if(result && saved!=EINPROGRESS){close(fd);
    return lost(m);
  }
  if(fstatat(np_directory_fd_v1(&m->socket_parent),"private",&after,AT_SYMLINK_NOFOLLOW) || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino || sd_bus_new(&m->bus)<0 || sd_bus_set_fd(m->bus,fd,fd)<0 || sd_bus_set_bus_client(m->bus,0)<0 || sd_bus_set_allow_interactive_authorization(m->bus,0)<0 || sd_bus_start(m->bus)<0)return lost(m);
  while(sd_bus_is_ready(m->bus)<=0)if(pump(m))return -1;
  if(sd_bus_add_filter(m->bus,&m->filter,signal_message,m)<0 || request(m,ABSENT) || sd_bus_message_append(m->requests[ABSENT].request,"s",m->unit)<0 || dispatch(m,ABSENT) || request(m,SUBSCRIBE) || dispatch(m,SUBSCRIBE))return lost(m);
  return 0;
}
int np_actor_manager_enroll(struct np_actor_manager *m,const struct np_actor_birth *creator) {
  if(!creator || creator->pidfd<0 || request(m,START))return lost(m);
  sd_bus_message *q=m->requests[START].request;
  uint64_t now;
  if(np_origin_now_v1(m->context->origin,&now))return lost(m);
  uint64_t remaining=(m->context->original.ends->cleanup-now)/1000;
  if(sd_bus_message_append(q,"ss",m->unit,"fail")<0 || sd_bus_message_open_container(q,'a',"(sv)")<0 || property(q,"PIDFDs","ah") || sd_bus_message_open_container(q,'a',"h")<0 || sd_bus_message_append(q,"h",creator->pidfd)<0 || sd_bus_message_close_container(q)<0 || end_property(q) || string_property(q,"Slice",m->context->slice) || string_property(q,"KillMode","control-group") || property(q,"Delegate","b") || sd_bus_message_append(q,"b",0)<0 || end_property(q) || property(q,"RuntimeMaxUSec","t") || sd_bus_message_append(q,"t",remaining)<0 || end_property(q) || property(q,"TimeoutStopUSec","t") || sd_bus_message_append(q,"t",UINT64_C(2000000))<0 || end_property(q) || sd_bus_message_close_container(q)<0 || sd_bus_message_open_container(q,'a',"(sa(sv))")<0 || sd_bus_message_close_container(q)<0 || dispatch(m,START))return lost(m);
  const char *job;
  uint32_t id;
  if(sd_bus_message_has_signature(m->requests[START].reply,"o")<=0 || sd_bus_message_read(m->requests[START].reply,"o",&job)<=0 || job_id(job,&id) || (m->job[0] && (strcmp(m->job,job) || (m->job_id && m->job_id!=id))) || copy(m->job,sizeof m->job,job))return lost(m);
  m->job_id=id;
  while(!m->job_done)if(pump(m))return -1;
  if(request(m,LOOKUP) || sd_bus_message_append(m->requests[LOOKUP].request,"s",m->unit)<0 || dispatch(m,LOOKUP))return lost(m);
  const char *path;
  if(sd_bus_message_has_signature(m->requests[LOOKUP].reply,"o")<=0 || sd_bus_message_read(m->requests[LOOKUP].reply,"o",&path)<=0 || strcmp(path,m->path) || facts(m,UNIT,false) || facts(m,SCOPE,false))return lost(m);
  if(request(m,BY_PIDFD) || sd_bus_message_append(m->requests[BY_PIDFD].request,"h",creator->pidfd)<0 || dispatch(m,BY_PIDFD))return lost(m);
  const char *unit;
  const void *invocation;
  size_t length;
  sd_bus_message *r=m->requests[BY_PIDFD].reply;
  if(sd_bus_message_has_signature(r,"osay")<=0 || sd_bus_message_read(r,"os",&path,&unit)<=0 || sd_bus_message_read_array(r,'y',&invocation,&length)<=0 || strcmp(path,m->path) || strcmp(unit,m->unit) || length!=16 || memcmp(invocation,m->invocation,16))return lost(m);
  struct actor_request *ref=&m->requests[REFERENCE];
  if(ref->attempted || !m->context->references || current(m))return lost(m);
  ref->attempted=true;uint64_t cookies[2];
  if(np_managed_retained_ref_v2(m->context->origin,m->context->references,2,m->context->reservation,cookies) || current(m))return lost(m);
  ref->serial=cookies[0];ref->done=true;
  m->referenced=true;
  return 0;
}
int np_actor_manager_freeze(struct np_actor_manager *m) {
  if(!m || !m->referenced || request(m,FREEZE) || dispatch(m,FREEZE))return m?lost(m):-1;
  m->frozen=true;
  return 0;
}
int np_actor_manager_current(struct np_actor_manager *m) {
  if(!m || !m->frozen || facts(m,FINAL_UNIT,true) || facts(m,FINAL_SCOPE,true))return m?lost(m):-1;
  uint64_t queued;
  return current(m) || sd_bus_get_n_queued_write(m->bus,&queued)<0 || queued?lost(m):0;
}
const char *np_actor_manager_group(const struct np_actor_manager *m){return m && !m->lost?m->group:NULL;
}
void np_actor_manager_close(struct np_actor_manager *m) {
  if(!m)return;
  m->closed=true;
  /* Do not flush queued work in cleanup, and do not release original refs.
  * Actual manager/stop/queue/ref discharge belongs to C2. */
  /* The connection itself owns PID1 refs. Retain it with its queued/raw debt;
  * closing it here would silently drop those refs. No pump/flush follows. */
}
