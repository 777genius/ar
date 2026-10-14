#ifndef SR_NATIVE_PROBE_ORIGINAL_OWNER_V1_H
#define SR_NATIVE_PROBE_ORIGINAL_OWNER_V1_H
#include "mechanisms.h"
/* Private trusted-entry interface. No descriptor/PID/path import operation.
 * A snapshot is DATA, and cannot be submitted back to this registry. */
enum np_owner_state { NP_OWNER_RESERVED, NP_OWNER_HELD, NP_OWNER_COMMITTED, NP_OWNER_CLOSED };
enum np_owner_loss { NP_LOSS_NONE, NP_LOSS_SETUP, NP_LOSS_PROTOCOL, NP_LOSS_HELPER,
  NP_LOSS_ENVIRONMENT, NP_LOSS_CUTOFF, NP_LOSS_ORIGINAL, NP_LOSS_STOP };
struct np_original_owner;
struct np_owner_data {
  enum np_owner_state state;
  enum np_owner_loss loss;
  uint64_t anchor, preparation_end, cleanup_end, cold_end, observation_end, attempt_end;
  uint64_t generation, sequence;
  pid_t helper;
  bool committed, legacy_refused, live, retained, uncertain;
};
int np_original_owner_create_v1(struct np_original_owner **out);
int np_original_owner_launch_v1(struct np_original_owner *owner);
int np_original_owner_observe_v1(struct np_original_owner *owner, struct np_owner_data *out);
void np_original_owner_close_v1(struct np_original_owner *owner);
/* Disposal only after original waitpid completion. Closure alone is not empty. */
int np_original_owner_join_v1(struct np_original_owner *owner);
int np_original_owner_dispose_v1(struct np_original_owner *owner);
int np_original_helper_start_v1(uint64_t *generation);
int np_original_helper_message_v1(uint16_t kind);
void np_original_helper_loss_v1(void);
#ifdef NP_ASSOCIATED_ORIGIN_V2
struct np_origin_child;
int np_original_owner_prefix_v2(struct np_original_owner *, char *, size_t);
int np_original_owner_poll_fd_v2(struct np_original_owner *);
int np_original_owner_from_origin_fork_v2(struct np_origin_child *, struct np_original_owner **);
int np_original_helper_start_associated_v2(uint64_t *);
#endif
#endif
