#include "root-producer-native.h"
#include <stdio.h>
int main(int argc, char **argv) {
  (void)argv;
  struct np_admin_operation *operation = NULL;
  struct np_root_origin *origin = NULL;
  struct np_l0_native_data data = {
    0}
  ;
  if (argc != 1 || np_admin_operation_open_v1(&operation) || np_root_origin_begin_v1(operation, &origin)) {
    fputs("{\"status\":\"UNKNOWN_HELD\"}\n", stdout);
    return 77;
  }
  const char *stage="snapshot";
  int failed=np_origin_snapshot_v1(origin);
  if(!failed){stage="allocation";
  failed=np_origin_freeze_allocation_v1(origin);
  }
  if(!failed){stage="managed";
  failed=np_root_managed_launch_v1(origin);
  }
  if(!failed){stage="control";
  failed=np_root_origin_run_v1(origin);
  }
  if(failed)(void)np_origin_journal_v1(origin,"native-failure",stage);
  (void)np_root_origin_close_v1(origin, failed ? NP_ORIGIN_SETUP : NP_ORIGIN_EXPLICIT_STOP);
  int joined = np_root_origin_join_v1(origin, &data);
  char result[512];
  int length=snprintf(result,sizeof result,"{\"childWait\":%s,\"helperWait\":%s,\"manager\":%s,\"sharedInfrastructureUnknown\":%s,\"status\":\"%s\",\"streams\":%s}\n",
  data.child_wait ? "true" : "false", data.helper_wait ? "true" : "false", data.manager ? "true" : "false", data.shared_unknown ? "true" : "false",
  !joined && data.closed ? "NATIVE_DEBTS_CLOSED_PRINCIPAL_TERMINAL_PENDING" : "UNKNOWN_HELD", data.streams ? "true" : "false");
  if(length<=0||(size_t)length>=sizeof result||np_origin_output_v1(origin,1,result,(size_t)length))return 77;
  return failed || joined || !data.closed ? 77 : 0;
}
