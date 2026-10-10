#define _GNU_SOURCE
#include "retained-v2-actors.h"
#include <poll.h>
int main(int argc,char **argv) {
  (void)argv;
  struct np_admin_operation *operation=NULL;struct np_root_origin *origin=NULL;
  struct np_retained_v2 *retained=NULL;struct np_retained_v2_actors *actors=NULL;
  if(argc!=1 || np_admin_operation_open_v1(&operation) || np_root_origin_begin_v1(operation,&origin))return 77;
  int failed=np_origin_snapshot_v1(origin) || np_origin_freeze_allocation_v1(origin) || np_retained_v2_create(origin,&retained) || np_retained_v2_prepare(retained) || np_retained_v2_adopt(retained) || np_retained_v2_actor_begin(retained,&actors) || np_retained_v2_actor_hold(actors);
  if(!failed){
    const char held[]="{\"stage\":\"native-b1a-actors-held\",\"actorAdmission\":false,\"enqueue\":false,\"terminal\":false}\n";
    failed=np_origin_output_v1(origin,1,held,sizeof held-1);
    /* Actual release attempt refuses before any claim/Thaw/token/service birth.
     * The result is not translated into privileged successful admission. */
    if(!np_retained_v2_actor_release(actors))failed=1;
  }
  while(!failed && !np_origin_boundary_v1(origin,false))(void)poll(NULL,0,1);
  if(actors)(void)np_retained_v2_actor_close(actors,failed?NP_ORIGIN_CUSTODY:NP_ORIGIN_CUTOFF);
  (void)np_root_origin_close_v1(origin,failed?NP_ORIGIN_SETUP:NP_ORIGIN_CUTOFF);
  if(actors){struct np_v2_actor_cleanup_data observed;(void)np_retained_v2_actor_join(actors,&observed);}
  np_retained_v2_close(retained);
  const char debt[]="{\"status\":\"UNKNOWN_HELD\",\"actorAdmission\":false,\"enqueue\":false,\"terminal\":false}\n";
  (void)np_origin_output_v1(origin,1,debt,sizeof debt-1);return 77;
}
