#ifndef SR_NATIVE_PROBE_RESOURCES_V1_H
#define SR_NATIVE_PROBE_RESOURCES_V1_H
#include "mechanisms.h"
/* Private native custody only; these objects never appear in JSON or JS.
 * The underlying delegated-root descriptor is received from the original native
 * launch observer. A pathname or matching device/inode DTO cannot supply it. */
enum np_acquisition { NP_NEVER_ACQUIRED, NP_RETAINED, NP_ACQUIRED_LOST };
struct np_resource_view {
  struct np_directory root;
  int original_delegation, mount_namespace, cgroup_namespace;
  dev_t device; ino_t inode;
  bool lost;
};
struct np_resource_pair {
  struct np_resource_view *view;
  int ancestors[3], directory, events;
  dev_t device; ino_t directory_inode, events_inode;
  enum np_acquisition directory_state, events_state;
  bool attempted, uncertain;
  char slice[128];
};
int np_resource_view_pin_v1(struct np_resource_view *, int original_delegation);
int np_resource_view_check_v1(struct np_resource_view *);
int np_resource_pair_init_v1(struct np_resource_pair *, struct np_resource_view *, const char locator[65]);
int np_resource_pair_acquire_v1(struct np_resource_pair *, struct np_gate *);
int np_resource_pair_check_v1(struct np_resource_pair *);
void np_resource_pair_release_v1(struct np_resource_pair *);
void np_resource_view_release_v1(struct np_resource_view *);
#endif
