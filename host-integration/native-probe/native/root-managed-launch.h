#ifndef SR_ROOT_MANAGED_LAUNCH_H
#define SR_ROOT_MANAGED_LAUNCH_H
#include "root-producer-native.h"
/* Private bounded proc DATA only; these functions confer no Origin authority. */
#define NP_MANAGED_CGROUP_BYTES 4096
int np_managed_cgroup_bytes_v1(const void *, size_t, const char *);
int np_managed_cgroup_read_v1(int, const char *);
int np_managed_open_v1(struct np_root_origin *, struct np_managed_original **);
int np_managed_launch_v1(struct np_root_origin *, struct np_managed_original *, int child_pidfd, pid_t child);
int np_managed_api_ref_open_v1(struct np_root_origin *, struct np_managed_original *);
int np_managed_ref_original_v1(struct np_root_origin *, struct np_managed_original *);
int np_managed_unref_original_v1(struct np_root_origin *, struct np_managed_original *);
int np_managed_stop_v1(struct np_root_origin *, struct np_managed_original *);
int np_managed_connections_settle_v1(struct np_root_origin *, struct np_managed_original *);
int np_managed_live_v1(struct np_root_origin *, struct np_managed_original *);
bool np_managed_shared_unknown_v1(struct np_managed_original *);
#endif
