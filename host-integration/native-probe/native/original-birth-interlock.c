#define _GNU_SOURCE
#include "original-birth-interlock.h"
#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
/* Linux robust futex ABI. Use the calling kernel thread's actual robust head,
 * never glibc's inherited pthread tid. A raw clone child has no registered head:
 * install its own process-local head. Existing principal pthread entries remain
 * registered on its existing head. No cross-process robust-list repair. */
static struct robust_list_head child_head;
static struct robust_list_head *head(void) {
  struct robust_list_head *h=NULL;size_t size=0;
  if(syscall(SYS_get_robust_list,0,&h,&size))return NULL;
  if(!h){
    child_head.list.next=&child_head.list;
    child_head.futex_offset=-(long)sizeof(struct robust_list);
    child_head.list_op_pending=NULL;
    if(syscall(SYS_set_robust_list,&child_head,sizeof child_head))return NULL;
    h=&child_head;size=sizeof child_head;
  }
  if(size!=sizeof *h || h->futex_offset < -48 || h->futex_offset > 48 || h->futex_offset%(long)_Alignof(uint32_t) || h->list_op_pending){errno=ENOTSUP;return NULL;}
  return h;
}
static _Atomic uint32_t *word(const struct np_birth_interlock *g){return (_Atomic uint32_t *)(void *)(g->storage+64);}
static struct robust_list *node(struct np_birth_interlock *g,struct robust_list_head *h){
  struct robust_list *n=(struct robust_list *)(void *)((unsigned char *)word(g)-h->futex_offset);
  if((uintptr_t)n%_Alignof(struct robust_list) || (unsigned char *)n < g->storage || (unsigned char *)(n+1)>g->storage+sizeof g->storage ||
     ((unsigned char *)n < (unsigned char *)(word(g)+1) && (unsigned char *)(n+1)>(unsigned char *)word(g))){errno=ENOTSUP;return NULL;}
  return n;
}
void np_birth_interlock_init(struct np_birth_interlock *g){memset(g,0,sizeof *g);atomic_init(word(g),0);}
int np_birth_interlock_owned(const struct np_birth_interlock *g){return (atomic_load(word(g))&FUTEX_TID_MASK)==(uint32_t)syscall(SYS_gettid);}
int np_birth_interlock_take(struct np_birth_interlock *g,uint64_t end){
  struct robust_list_head *h=head();if(!g || !h)return ENOTSUP;
  struct robust_list *n=node(g,h);if(!n)return ENOTSUP;
  uint32_t tid=(uint32_t)syscall(SYS_gettid);if(!tid || tid>FUTEX_TID_MASK)return ENOTSUP;
  h->list_op_pending=n;atomic_thread_fence(memory_order_seq_cst);
  for(;;){
    struct timespec now;if(clock_gettime(CLOCK_MONOTONIC,&now)){h->list_op_pending=NULL;return ESTALE;}
    uint64_t stamp=(uint64_t)now.tv_sec*UINT64_C(1000000000)+(uint64_t)now.tv_nsec;
    if(stamp>=end){h->list_op_pending=NULL;return ETIMEDOUT;}
    uint32_t prior=atomic_load(word(g));
    if(!(prior&FUTEX_TID_MASK)){
      uint32_t desired=tid|FUTEX_WAITERS;
      if(atomic_compare_exchange_weak(word(g),&prior,desired)){
        n->next=h->list.next;h->list.next=n;atomic_thread_fence(memory_order_seq_cst);h->list_op_pending=NULL;
        return prior&FUTEX_OWNER_DIED?EOWNERDEAD:0;
      }
      continue;
    }
    if((prior&FUTEX_TID_MASK)==tid){h->list_op_pending=NULL;return EDEADLK;}
    struct timespec absolute={.tv_sec=(time_t)(end/UINT64_C(1000000000)),.tv_nsec=(long)(end%UINT64_C(1000000000))};
    int r=(int)syscall(SYS_futex,word(g),FUTEX_WAIT_BITSET,prior,&absolute,NULL,FUTEX_BITSET_MATCH_ANY);
    if(r<0 && errno!=EAGAIN && errno!=EINTR){int e=errno;h->list_op_pending=NULL;return e;}
  }
}
int np_birth_interlock_drop(struct np_birth_interlock *g){
  struct robust_list_head *h=head();if(!g || !h || !np_birth_interlock_owned(g))return -1;
  struct robust_list *n=node(g,h);if(!n || h->list.next!=n)return -1;
  h->list_op_pending=n;atomic_thread_fence(memory_order_seq_cst);
  h->list.next=n->next;atomic_store(word(g),0);
  (void)syscall(SYS_futex,word(g),FUTEX_WAKE,1,NULL,NULL,0);
  atomic_thread_fence(memory_order_seq_cst);h->list_op_pending=NULL;return 0;
}
