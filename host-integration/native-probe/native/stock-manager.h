#ifndef SR_NATIVE_PROBE_STOCK_MANAGER_V1_H
#define SR_NATIVE_PROBE_STOCK_MANAGER_V1_H
#include "resources.h"
/* Native-parent mechanism. No public FD/name/property or manager-control API.
 * The original owner composes installation/load-path/infrastructure/Source
 * admission with these final clock/connection and finite-dispatch checks.
 * This module alone supplies no Source or original-owner authority. */
struct np_stock_manager;
enum np_manager_step { NP_TARGET_ABSENT, NP_SUBSCRIBE, NP_SLICE_START, NP_SLICE_REF, NP_SLICE_FACTS, NP_SLICE_CPU_FACTS, NP_RELOAD, NP_SLICE_RELOAD_FACTS, NP_TARGET_LOAD, NP_TARGET_REF, NP_TARGET_PRESTART_FACTS, NP_TARGET_START, NP_TARGET_FACTS, NP_SLICE_FINAL_FACTS, NP_MANAGER_STEPS };
enum np_request_state { NP_REQUEST_UNSENT, NP_REQUEST_DISPATCHED, NP_REQUEST_REPLIED, NP_REQUEST_FAILED, NP_REQUEST_UNCERTAIN };
struct np_request_observation {
  enum np_request_state state;
  uint64_t serial, reply_serial, sent_ns, dispatched_after_ns, observed_ns;
  bool late, job_reply, job_done;
  uint32_t job_id; char job[128], outcome[32];
};
struct np_manager_observation {
  bool lost, closed, reload_started, reload_finished;
  uint64_t generation, events;
  struct np_request_observation requests[NP_MANAGER_STEPS];
  uint8_t slice_invocation[16], target_invocation[16];
};
int np_manager_connect_v1(struct np_stock_manager **, int original_connected_socket, const struct np_birth *original_manager, struct np_gate *, const char locator[65], uint64_t generation, size_t message_capacity);
int np_manager_dispatch_v1(struct np_stock_manager *, enum np_manager_step, struct np_publication *, struct np_resource_pair *);
int np_manager_join_v1(struct np_stock_manager *, uint64_t original_observation_end);
void np_manager_close_v1(struct np_stock_manager *);
void np_manager_snapshot_v1(const struct np_stock_manager *, struct np_manager_observation *);
void np_manager_release_v1(struct np_stock_manager *);
#endif
