#ifndef SR_NATIVE_RETAINED_V2_A1_H
#define SR_NATIVE_RETAINED_V2_A1_H
#include "root-producer-native.h"
#include "resources.h"
#include "stock-manager.h"
#define NP_V2_POLICY "{\"kind\":\"NativeRetainedV2ExpectedLeafV1\",\"postExec\":\"np_helper_filter_v1\",\"preExec\":\"np_helper_preexec_filter_v1\",\"source\":false,\"work\":false}\n"
#define NP_V2_LIMIT 8192
#define NP_V2_RECORDS 4
/* Internal C-only original association. No NAPI/JSON/descriptor importer. */
struct np_retained_v2;
struct np_v2_context {
  struct np_clock *clock;
  const struct np_origin_ends *ends;
  const struct np_directory *operation;
  const char *boot, *machine, *operation_digest, *installation, *profile, *manifest, *allocation;
  int delegation, mount_namespace, cgroup_namespace;
  const char *funded_bytes; size_t funded_length; uint64_t admitted_epoch, work_epoch;
};
struct np_v2_stamp { uint64_t sequence, epoch; };
struct np_v2_file {
  struct np_directory parents;
  int fd;
  dev_t device; ino_t inode;
  size_t length, written;
  char bytes[NP_V2_LIMIT], name[70], stage[77];
  bool reserved, uncertain, renamed, durable, verified;
};
struct np_v2_record {
  struct np_v2_file body, events;
  char digest[65];
  struct np_v2_stamp admitted, durable, readback, final;
  uint64_t generation;
  bool observed, committed;
};
int np_origin_retained_context_v2(struct np_root_origin *, struct np_v2_context *);
/* One original, finite publication/effect interlock. These are not exported. */
int np_origin_retained_lock_v2(struct np_root_origin *);
void np_origin_retained_unlock_v2(struct np_root_origin *);
int np_retained_v2_create(struct np_root_origin *, struct np_retained_v2 **);
int np_retained_v2_prepare(struct np_retained_v2 *);
int np_retained_v2_adopt(struct np_retained_v2 *);
void np_retained_v2_close(struct np_retained_v2 *);
/* Narrow mechanism helpers only; they do not create original membership. */
int np_v2_hash(const void *, size_t, char[65]);
int np_v2_file_reserve(struct np_v2_file *, const char *, const char *, const char *, size_t);
int np_v2_file_publish(struct np_v2_file *, struct np_root_origin *);
int np_v2_file_verify(struct np_v2_file *);
#endif
