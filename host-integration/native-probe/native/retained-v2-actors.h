#ifndef SR_RETAINED_V2_ACTORS_H
#define SR_RETAINED_V2_ACTORS_H
#include "retained-v2.h"
#include <sys/socket.h>
#include <signal.h>
#define NP_ACTOR_COUNT 2
#define NP_ACTOR_CENSUSES 8
#define NP_ACTOR_MESSAGES 64
/* These are native-private mechanism declarations, never an addon/FD importer.
 * Only retained-v2.c's original committed cell supplies this borrowed context. */
struct np_actor_context {
  struct np_root_origin *origin;
  struct np_v2_context original;
  struct np_resource_pair *resources;
  struct np_publication *fragment;
  struct np_stock_manager *resource_manager;
  struct np_managed_original *references;
  const struct np_birth *manager;
  char reservation[65], slice[128];
};
struct np_retained_v2_actors;
struct np_actor_manager;
enum np_actor_phase { NP_ACTOR_SETUP=1, NP_ACTOR_CHILD, NP_ACTOR_READY, NP_ACTOR_CLOSE };
struct np_actor_packet {
  uint64_t generation, sequence;
  uint32_t magic, version, role, slot, phase, reserved;
  int32_t child_pid; uint32_t padding;
};
struct np_actor_birth {
  pid_t pid;
  int pidfd, endpoint, raw[2];
  uint64_t ticks, receive_sequence;
  dev_t endpoint_device,raw_device[2];ino_t endpoint_inode,raw_inode[2];
  bool born, ready, wait, eof[2], channel_eof, signal_attempted;
  siginfo_t result;
};
struct np_actor_graph {
  struct np_directory cgroup;
  int events;
  dev_t device; ino_t directory_inode, events_inode;
  uint64_t ticks[NP_ACTOR_COUNT];
  unsigned observations;
  bool pinned, held, lost;
  char control_group[768];
};
/* DATA parser state only. This cannot create an actor or manager membership. */
enum np_actor_observer_note { NP_ACTOR_UNIT_NEW, NP_ACTOR_JOB_NEW, NP_ACTOR_JOB_REMOVED };
struct np_actor_event_debt {
  char unit[128],path[512],job[128];uint32_t job_id;
  bool unit_seen,job_seen,job_done;
};
int np_actor_observer_note(struct np_actor_event_debt *,enum np_actor_observer_note,const char *,const char *,uint32_t,const char *);
struct sd_bus_message;
int np_actor_notification_decode(struct sd_bus_message *,const struct np_actor_event_debt *);
int np_actor_manager_observer_check(const struct np_actor_manager *,const struct np_actor_event_debt *);
struct np_v2_actor_cleanup_data {
  bool waits[NP_ACTOR_COUNT], raw_eofs[NP_ACTOR_COUNT][2], channel_eofs[NP_ACTOR_COUNT];
  /* This is observational DATA. Scope/ref/resource/publication debt remains. */
  bool custody_settled, container_pending;
};
int np_retained_v2_actor_context(struct np_retained_v2 *, struct np_actor_context *);
int np_retained_v2_actor_begin(struct np_retained_v2 *, struct np_retained_v2_actors **);
int np_retained_v2_actor_hold(struct np_retained_v2_actors *);
int np_retained_v2_actor_release(struct np_retained_v2_actors *);
int np_retained_v2_actor_close(struct np_retained_v2_actors *, enum np_origin_loss);
int np_retained_v2_actor_join(struct np_retained_v2_actors *, struct np_v2_actor_cleanup_data *);
/* No publication API in B1a: no Correlation/ActorAdmission/PayloadGate claim. */
int np_origin_retained_cleanup_v2(struct np_root_origin *, uint64_t *);
pid_t np_origin_actor_creator_fork_v2(struct np_root_origin *, int *original_pidfd);
pid_t np_origin_actor_submitter_fork_v2(struct np_root_origin *, int *original_pidfd);
int np_origin_actor_setup_begin_v2(struct np_root_origin *);
int np_actor_manager_connect(struct np_actor_manager **, const struct np_actor_context *);
int np_actor_manager_enroll(struct np_actor_manager *, const struct np_actor_birth *);
int np_actor_manager_freeze(struct np_actor_manager *);
int np_actor_manager_current(struct np_actor_manager *);
const char *np_actor_manager_group(const struct np_actor_manager *);
void np_actor_manager_close(struct np_actor_manager *);
int np_actor_graph_pin(struct np_actor_graph *, const char *);
int np_actor_graph_observe(struct np_actor_graph *, const struct np_actor_birth[NP_ACTOR_COUNT], const struct np_actor_context *);
int np_actor_receive(int, const struct np_actor_birth *, uint64_t, unsigned, uint64_t, enum np_actor_phase, struct np_actor_packet *, int *);
int np_actor_seal(pid_t original_parent);
#endif
