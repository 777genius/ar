#define _GNU_SOURCE
#include "retained-v2-actors.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/syscall.h>
static int text(int directory,const char *name,char *out,size_t capacity) {
  int fd=openat(directory,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)return -1;
  ssize_t n=read(fd,out,capacity);
  close(fd);
  if(n<0 || (size_t)n>=capacity || memchr(out,0,(size_t)n))return -1;
  out[n]=0;
  return 0;
}
static int ids(const char *bytes,const pid_t *expected,unsigned count) {
  unsigned seen=0;
  const char *p=bytes;
  while(*p){while(*p==' ' || *p=='\n' || *p=='\t')p++;
    if(!*p)break;
    if(*p<'1' || *p>'9')return -1;
    errno=0;
    char *end;
    unsigned long value=strtoul(p,&end,10);
    if(errno || value>INT_MAX || (*end && *end!=' ' && *end!='\n' && *end!='\t'))return -1;
    unsigned i;
    for(i=0;i<count;i++)if(value==(unsigned long)expected[i])break;
    if(i==count || (seen&(1u<<i)))return -1;
    seen|=1u<<i;
    p=end;
  }
  return seen==((1u<<count)-1)?0:-1;
}
static int process_identity(int proc,pid_t pid,pid_t parent,uint64_t *ticks) {
  char bytes[4096];
  if(text(proc,"stat",bytes,sizeof bytes))return -1;
  char *end;
  long actual=strtol(bytes,&end,10);
  char *comm=strrchr(bytes,')');
  if(actual!=pid || *end!=' ' || end[1]!='(' || !comm || comm[1]!=' ')return -1;
  char *cursor=comm+2,*save=NULL;
  uint64_t birth=0;
  for(unsigned field=3;field<=22;field++){
    char *word=strtok_r(field==3?cursor:NULL," \n",&save);
    if(!word)return -1;
    if(field==4){errno=0;
      long value=strtol(word,&end,10);
      if(errno || *end || value!=parent)return -1;
    }
    if(field==22){errno=0;
      birth=strtoull(word,&end,10);
      if(errno || *end || !birth || birth>UINT64_C(9007199254740991))return -1;
    }
  }
  if(*ticks && *ticks!=birth)return -1;
  *ticks=birth;
  return 0;
}
static int status(int proc) {
  char bytes[8192];
  if(text(proc,"status",bytes,sizeof bytes))return -1;
  const char *keys[]={"Uid:","Gid:","CapInh:","CapPrm:","CapEff:","CapAmb:","NoNewPrivs:","Seccomp:","Threads:"};
  unsigned seen=0;
  char *save=NULL;
  for(char *line=strtok_r(bytes,"\n",&save);line;line=strtok_r(NULL,"\n",&save)){
    for(unsigned i=0;i<sizeof keys/sizeof keys[0];i++)if(!strncmp(line,keys[i],strlen(keys[i]))){
      if(seen&(1u<<i))return -1;
      seen|=1u<<i;
      char *cursor=line+strlen(keys[i]),*end;
      unsigned count=i<2?4:1;
      for(unsigned j=0;j<count;j++){
        while(*cursor==' ' || *cursor=='\t')cursor++;
        errno=0;
        unsigned long value=strtoul(cursor,&end,i>=2 && i<=5?16:10);
        unsigned long expected=i==0?NP_UID:i==1?NP_GID:i==6?1:i==7?2:i==8?1:0;
        if(errno || end==cursor || value!=expected)return -1;
        cursor=end;
      }
      while(*cursor==' ' || *cursor=='\t')cursor++;
      if(*cursor)return -1;
    }
  }
  return seen==511u?0:-1;
}
static int same_ns(int proc,const char *name,int held) {
  char path[64];
  int n=snprintf(path,sizeof path,"ns/%s",name);
  if(n<=0 || (size_t)n>=sizeof path)return -1;
  int fd=openat(proc,path,O_RDONLY|O_CLOEXEC);
  struct stat actual,expected;
  int failed=fd<0 || fstat(fd,&actual) || fstat(held,&expected) || actual.st_dev!=expected.st_dev || actual.st_ino!=expected.st_ino;
  if(fd>=0)close(fd);
  return failed?-1:0;
}
static int group(int proc,const char *expected) {
  char bytes[4096];
  if(text(proc,"cgroup",bytes,sizeof bytes))return -1;
  char *save=NULL;
  unsigned unified=0;
  for(char *line=strtok_r(bytes,"\n",&save);line;line=strtok_r(NULL,"\n",&save)){
    if(!strncmp(line,"0::",3)){if(unified++ || strcmp(line+3,expected))return -1;
    }
    else {char *first=strchr(line,':');
      if(!first || first==line || !strchr(first+1,':'))return -1;
    }
  }
  return unified==1?0:-1;
}
static int one_task(int proc,pid_t pid,pid_t child) {
  int fd=openat(proc,"task",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)return -1;
  DIR *directory=fdopendir(fd);
  if(!directory){close(fd);
    return -1;
  }
  char expected[32];
  snprintf(expected,sizeof expected,"%ld",(long)pid);
  unsigned seen=0;
  int failed=0;
  struct dirent *entry;
  errno=0;
  while((entry=readdir(directory))){if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
    if(strcmp(entry->d_name,expected) || seen++){failed=1;
      break;
    }}
  if(errno || seen!=1)failed=1;
  char path[80],bytes[256];
  snprintf(path,sizeof path,"%s/children",expected);
  if(text(fd,path,bytes,sizeof bytes) || ids(bytes,child>0?&child:NULL,child>0?1:0))failed=1;
  closedir(directory);
  return failed?-1:0;
}
static int original_pidfd(int pidfd,pid_t pid) {
  struct pollfd p={.fd=pidfd,.events=POLLIN};
  if(pidfd<0 || poll(&p,1,0)!=0)return -1;
  char path[80],bytes[1024];
  snprintf(path,sizeof path,"/proc/self/fdinfo/%d",pidfd);
  int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if(fd<0)return -1;
  ssize_t n=read(fd,bytes,sizeof bytes-1);
  close(fd);
  if(n<=0 || (size_t)n>=sizeof bytes-1)return -1;
  bytes[n]=0;
  char *save=NULL;
  unsigned seen=0;
  for(char *line=strtok_r(bytes,"\n",&save);line;line=strtok_r(NULL,"\n",&save))if(!strncmp(line,"Pid:",4)){
    char *end;
    long actual=strtol(line+4,&end,10);
    if(seen++ || *end || actual!=pid)return -1;
  }return seen==1?0:-1;
}
static int descriptors(int proc,const struct np_actor_birth *birth,pid_t original_child) {
  int scan=openat(proc,"fd",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
  DIR *directory=scan<0?NULL:fdopendir(scan);
  if(!directory){if(scan>=0)close(scan);
    return -1;
  }
  unsigned seen=0;
  int failed=0;
  struct dirent *entry;
  errno=0;
  while((entry=readdir(directory))){
    if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
    char *end;
    long slot=strtol(entry->d_name,&end,10);
    if(*end || slot<0 || slot>INT_MAX){failed=1;
      break;
    }
    int fd=(int)syscall(SYS_pidfd_getfd,birth->pidfd,(int)slot,0);
    struct stat s;
    if(fd<0 || fstat(fd,&s)){if(fd>=0)close(fd);
      failed=1;
      break;
    }
    unsigned bit=0;
    int flags=fcntl(fd,F_GETFL);
    if(s.st_dev==birth->endpoint_device && s.st_ino==birth->endpoint_inode && S_ISSOCK(s.st_mode)){
      int type;
      socklen_t length=sizeof type;
      if(getsockopt(fd,SOL_SOCKET,SO_TYPE,&type,&length) || length!=sizeof type || type!=SOCK_SEQPACKET || (flags&O_ACCMODE)!=O_RDWR)failed=1;
      bit=1;
    }else if(S_ISFIFO(s.st_mode)){
      for(unsigned j=0;j<2;j++)if(s.st_dev==birth->raw_device[j] && s.st_ino==birth->raw_inode[j])bit=2u<<j;
      if(!bit || (flags&O_ACCMODE)!=O_WRONLY)failed=1;
    }else if(original_child>0 && !original_pidfd(fd,original_child))bit=8;
    else failed=1;
    if(!bit || (seen&bit))failed=1;
    seen|=bit;
    close(fd);
    if(failed)break;
  }
  if(errno || seen!=(original_child>0?15u:7u))failed=1;
  closedir(directory);
  return failed?-1:0;
}
int np_actor_graph_pin(struct np_actor_graph *g,const char *control_group) {
  if(!g || g->pinned || !control_group || control_group[0]!='/' || strlen(control_group)>=sizeof g->control_group)return -1;
  char path[1024];
  int n=snprintf(path,sizeof path,"/sys/fs/cgroup%s",control_group);
  if(n<=0 || (size_t)n>=sizeof path)return -1;
  if(np_directory_pin_v1(&g->cgroup,path))return -1;
  struct stat directory,event;
  g->events=openat(np_directory_fd_v1(&g->cgroup),"cgroup.events",O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
  if(g->events<0 || fstat(np_directory_fd_v1(&g->cgroup),&directory) || fstat(g->events,&event) || directory.st_dev!=event.st_dev)return -1;
  g->device=directory.st_dev;
  g->directory_inode=directory.st_ino;
  g->events_inode=event.st_ino;
  memcpy(g->control_group,control_group,strlen(control_group)+1);
  g->pinned=true;
  return 0;
}
int np_actor_graph_observe(struct np_actor_graph *g,const struct np_actor_birth births[NP_ACTOR_COUNT],const struct np_actor_context *context) {
  if(!g || !g->pinned || g->lost || g->observations==NP_ACTOR_CENSUSES || !context)return -1;
  struct stat named,held;
  if(np_directory_check_v1(&g->cgroup) || fstat(g->events,&held) || fstatat(np_directory_fd_v1(&g->cgroup),"cgroup.events",&named,AT_SYMLINK_NOFOLLOW) || held.st_dev!=g->device || held.st_ino!=g->events_inode || named.st_dev!=held.st_dev || named.st_ino!=held.st_ino)goto lost;
  char events[128];
  ssize_t length=pread(g->events,events,sizeof events-1,0);
  if(length<=0 || (size_t)length>=sizeof events-1)goto lost;
  events[length]=0;
  if(!strcmp(events,"populated 1\nfrozen 0\n")){errno=EAGAIN;
    return -1;
  }
  if(strcmp(events,"populated 1\nfrozen 1\n"))goto lost;
  g->observations++;
  char bytes[4096];
  pid_t expected[2]={births[0].pid,births[1].pid};
  int root=np_directory_fd_v1(&g->cgroup);
  if(expected[0]<=0 || expected[1]<=0 || expected[0]==expected[1] || text(root,"cgroup.procs",bytes,sizeof bytes) || ids(bytes,expected,2) || text(root,"cgroup.threads",bytes,sizeof bytes) || ids(bytes,expected,2))goto lost;
  int scan=openat(root,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
  DIR *directory=scan<0?NULL:fdopendir(scan);
  if(!directory){if(scan>=0)close(scan);
    goto lost;
  }
  bool subgroups=false;
  struct dirent *entry;
  errno=0;
  while((entry=readdir(directory))){if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,".."))continue;
    struct stat s;
    if(fstatat(scan,entry->d_name,&s,AT_SYMLINK_NOFOLLOW) || S_ISDIR(s.st_mode) || S_ISLNK(s.st_mode)){subgroups=true;
      break;
    }}
  if(errno)subgroups=true;
  closedir(directory);
  if(subgroups)goto lost;
  for(unsigned i=0;i<NP_ACTOR_COUNT;i++){
    char path[80];
    snprintf(path,sizeof path,"/proc/%ld",(long)births[i].pid);
    int proc=open(path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(proc<0)goto lost;
    int failed=original_pidfd(births[i].pidfd,births[i].pid) || process_identity(proc,births[i].pid,i?births[0].pid:getpid(),&g->ticks[i]) || status(proc) || group(proc,g->control_group) || one_task(proc,births[i].pid,i?0:births[1].pid) ||
    same_ns(proc,"mnt",context->original.mount_namespace) || same_ns(proc,"cgroup",context->original.cgroup_namespace) || same_ns(proc,"pid",context->original.pid_namespace) || same_ns(proc,"pid_for_children",context->original.pid_namespace) || same_ns(proc,"time",context->original.clock->time) || same_ns(proc,"time_for_children",context->original.clock->children) || descriptors(proc,&births[i],i?0:births[1].pid);
    close(proc);
    if(failed)goto lost;
  }
  if(np_resource_pair_check_v1(context->resources) || np_fragment_verify_v1(context->fragment) || np_birth_associate_v1(context->original.clock,context->manager))goto lost;
  /* A second exact held reread closes read-time changes. Exclusive sealed roles
  * and manager-only enrollment establish continuous hold, not snapshots. */
  length=pread(g->events,events,sizeof events-1,0);
  if(length<=0 || (size_t)length>=sizeof events-1)goto lost;
  events[length]=0;
  if(strcmp(events,"populated 1\nfrozen 1\n") || text(root,"cgroup.procs",bytes,sizeof bytes) || ids(bytes,expected,2) || text(root,"cgroup.threads",bytes,sizeof bytes) || ids(bytes,expected,2) || np_directory_check_v1(&g->cgroup))goto lost;
  g->held=true;
  return 0;
  lost:g->lost=true;
  errno=ESTALE;
  return -1;
}
