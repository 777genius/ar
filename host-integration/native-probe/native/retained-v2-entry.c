#include "retained-v2.h"
#include <stdio.h>
#include <poll.h>
int main(int argc, char **argv) {
  (void)argv;
  struct np_admin_operation *operation = NULL;
  struct np_root_origin *origin = NULL;
  struct np_retained_v2 *retained = NULL;
  if (argc != 1 || np_admin_operation_open_v1(&operation) || np_root_origin_begin_v1(operation, &origin)) return 77;
  int failed = np_origin_snapshot_v1(origin) || np_origin_freeze_allocation_v1(origin) || np_retained_v2_create(origin, &retained) || np_retained_v2_prepare(retained) || np_retained_v2_adopt(retained);
  if (!failed) {
    const char ready[] = "{\"stage\":\"retained-v2-resource-bound\"}\n";
    if (np_origin_output_v1(origin, 1, ready, sizeof ready - 1)) failed = 1;
  }
  /* No actor/enqueue/WORK path in A1. Preserve original custody until the
   * original finite boundary or original observer loss; do not renew it. */
  while (!failed && !np_origin_boundary_v1(origin, false)) {
    if (poll(NULL, 0, 1) < 0) break;
  }
  np_retained_v2_close(retained);
  (void)np_origin_journal_v1(origin, "retained-v2-held", failed ? "partial-original-prefix" : "resource-bound-obligations-pending");
  const char held[] = "{\"status\":\"UNKNOWN_HELD\",\"terminal\":false}\n";
  (void)np_origin_output_v1(origin, 1, held, sizeof held - 1);
  return 77;
}
