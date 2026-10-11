#ifndef SR_ROOT_PRODUCER_NATIVE_H
#define SR_ROOT_PRODUCER_NATIVE_H
#include "mechanisms.h"
#include <stddef.h>
#include <stdint.h>
#include <pthread.h>
#include <stdatomic.h>
#define NP_ORIGIN_SECOND UINT64_C(1000000000)
#define NP_ORIGIN_FILES 128
#define NP_ORIGIN_PHASE_MAX 16384
#ifdef NP_RETAINED_V2_B1A
#define NP_ORIGIN_ADMIN "/run/subscription-runtime/native-retained-v2-b1a/original"
#define NP_ORIGIN_INSTALL "/opt/subscription-runtime/native-retained-v2-b1a"
#define NP_ORIGIN_FRAME "NPB1"
#define NP_ORIGIN_BOOTSTRAP "NPADB101"
#define NP_ORIGIN_SNAPSHOT "NPB1SN01"
#define NP_ORIGIN_ENTRY "/retained-v2-actor-entry"
#define NP_ORIGIN_OPERATOR "/admin/host-integration/native-probe/retained-v2-actor-operator.mjs"
#elif defined(NP_RETAINED_V2_A1)
#define NP_ORIGIN_ADMIN "/run/subscription-runtime/native-retained-v2/original"
#define NP_ORIGIN_INSTALL "/opt/subscription-runtime/native-retained-v2"
#define NP_ORIGIN_FRAME "NPV2"
#define NP_ORIGIN_BOOTSTRAP "NPADV201"
#define NP_ORIGIN_SNAPSHOT "NPV2SN01"
#define NP_ORIGIN_ENTRY "/retained-v2-entry"
#define NP_ORIGIN_OPERATOR "/admin/host-integration/native-probe/retained-v2-operator.mjs"
#else
#define NP_ORIGIN_ADMIN "/run/subscription-runtime/native-probe/original"
#define NP_ORIGIN_INSTALL "/opt/subscription-runtime/native-probe"
#define NP_ORIGIN_FRAME "NPA5"
#define NP_ORIGIN_BOOTSTRAP "NPADM001"
#define NP_ORIGIN_SNAPSHOT "NPSNAP01"
#define NP_ORIGIN_ENTRY "/root-producer-entry"
#define NP_ORIGIN_OPERATOR "/admin/host-integration/native-probe/root-origin-operator.mjs"
#endif
#define NP_ORIGIN_IMAGE NP_ORIGIN_INSTALL "/test-root"
#define NP_ORIGIN_MANIFEST NP_ORIGIN_INSTALL "/root-installation.json"
/* Private native build only: none of these types is a DATA/NAPI importer. */
/* Shared-state primitives grant no Origin membership. */
/* Cleanup clock observation grants no Origin membership or work effects. */
int np_cleanup_clock_sample_v1(const struct np_clock *, int boot, const char *boot_id, uint64_t end, uint64_t *high_water, uint64_t *out);
/* One irreversible admission transition, DATA primitive only. */
int np_origin_admission_claim_v1(_Atomic unsigned *);
void np_origin_admission_close_v1(_Atomic unsigned *);
int np_origin_mutex_init_v1(pthread_mutex_t *);
int np_origin_mutex_take_v1(pthread_mutex_t *, uint64_t absolute_end);
struct np_admin_operation;
struct np_root_origin;
struct np_origin_child;
struct np_managed_original;
enum np_origin_effect { NP_ORIGIN_NAMESPACE, NP_ORIGIN_FORK, NP_ORIGIN_HELPER, NP_ORIGIN_CONNECT, NP_ORIGIN_START, NP_ORIGIN_REF, NP_ORIGIN_STOP, NP_ORIGIN_UNREF,
#ifdef NP_RETAINED_V2_B1A
NP_ORIGIN_SLICE_RETAINED_REF,NP_ORIGIN_TARGET_RETAINED_REF,NP_ORIGIN_ACTOR_RETAINED_REF,
#endif
NP_ORIGIN_EFFECTS };
enum np_origin_loss { NP_ORIGIN_EXPLICIT_STOP, NP_ORIGIN_CUTOFF, NP_ORIGIN_CUSTODY, NP_ORIGIN_PROTOCOL, NP_ORIGIN_SETUP };
struct np_origin_ends { uint64_t generation, anchor, work, cleanup, cold; };
struct np_l0_native_data { bool closed, child_wait, streams, helper_wait, manager, shared_unknown; };
int np_admin_operation_open_v1(struct np_admin_operation **out);
int np_root_origin_begin_v1(struct np_admin_operation *, struct np_root_origin **out);
int np_root_managed_launch_v1(struct np_root_origin *);
int np_root_origin_run_v1(struct np_root_origin *);
int np_root_origin_close_v1(struct np_root_origin *, enum np_origin_loss);
int np_root_origin_join_v1(struct np_root_origin *, struct np_l0_native_data *);
/* Nonexecuting raw prefix writer: no Root membership or effect authority. */
int np_origin_prefix_write_v1(int directory, unsigned index, uint64_t generation, uint64_t sample, const char *event, const char *prefix);
int np_origin_journal_v1(struct np_root_origin *, const char *event, const char *prefix);
int np_origin_child_work_v1(struct np_origin_child *);
int np_origin_snapshot_v1(struct np_root_origin *);
int np_origin_freeze_allocation_v1(struct np_root_origin *);
int np_origin_output_v1(struct np_root_origin *, int, const void *, size_t);
int np_origin_now_v1(struct np_root_origin *, uint64_t *);
int np_origin_boundary_v1(struct np_root_origin *, bool cleanup);
int np_origin_effect_begin_v1(struct np_root_origin *, enum np_origin_effect);
int np_origin_effect_check_v1(struct np_root_origin *, bool cleanup, uint64_t observation_end);
void np_origin_effect_end_v1(struct np_root_origin *);
const struct np_origin_ends *np_origin_ends_v1(struct np_root_origin *);
const char *np_origin_unit_v1(struct np_root_origin *);
const char *np_origin_job_v1(struct np_root_origin *);
#ifdef NP_RETAINED_V2_B1A
int np_origin_retained_reference_open_v2(struct np_root_origin *,struct np_managed_original **,const struct np_birth *);
int np_origin_retained_boundary_v2(struct np_root_origin *);
#endif
int np_origin_daemon_fd_v1(struct np_root_origin *);
int np_origin_daemon_identity_v1(struct np_root_origin *, uid_t *, gid_t *);
int np_origin_sample_v1(struct np_origin_child *, uint64_t *);
int np_origin_child_commit_claim_v1(struct np_origin_child *);
int np_origin_child_commit_begin_v1(struct np_origin_child *);
int np_origin_child_commit_check_v1(struct np_origin_child *);
int np_origin_child_begin_v1(struct np_origin_child *, enum np_origin_effect);
void np_origin_child_end_v1(struct np_origin_child *);
int np_origin_child_clock_v1(struct np_origin_child *, struct np_clock *, uint64_t *cold);
int np_origin_child_closure_v1(struct np_origin_child *, int out[3]);
void np_origin_child_close_v1(struct np_origin_child *);
#endif
