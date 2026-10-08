#ifndef SR_NATIVE_PROBE_MECHANISMS_V1_H
#define SR_NATIVE_PROBE_MECHANISMS_V1_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#define NP_UID 65532
#define NP_GID 65532
#define NP_ENDPOINT 3
#define NP_FRAME_MAGIC UINT32_C(0x4e505631)
enum np_message { NP_HELLO = 1, NP_REGISTER = 2, NP_PREPARE = 3, NP_JOIN = 4, NP_CLOSE = 5, NP_SNAPSHOT = 6, NP_RESOURCE_PAIR = 7 };
struct np_frame { uint32_t magic; uint16_t version, kind; uint64_t generation, sequence; uint32_t slot, result; };
struct np_clock { int time, children, mount; uint64_t anchor, preparation_end, cleanup_end, high_water; bool lost; };
struct np_birth { pid_t pid; int pidfd, time, children; uid_t uid; gid_t gid; };
struct np_channel { int owner, helper; struct np_birth birth; uint64_t generation, sequence; bool bound, lost; };
struct np_gate { struct np_clock *clock; uint64_t cutoff; bool closed; };
int np_clock_pin_v1(struct np_clock *clock);
int np_clock_sample_v1(struct np_clock *clock, uint64_t *out);
int np_clock_check_v1(struct np_clock *clock);
void np_clock_release_v1(struct np_clock *clock);
int np_birth_pin_v1(struct np_birth *birth, pid_t pid, uid_t uid, gid_t gid);
int np_birth_live_v1(const struct np_birth *birth);
int np_birth_associate_v1(const struct np_clock *clock, const struct np_birth *birth);
void np_birth_release_v1(struct np_birth *birth);
int np_gate_check_v1(struct np_gate *gate);
int np_channel_create_v1(struct np_channel *channel, uint64_t generation);
int np_channel_parent_bind_v1(struct np_channel *channel, pid_t pid, uid_t uid, gid_t gid);
int np_channel_child_inherit_v1(struct np_channel *channel);
int np_channel_receive_v1(struct np_channel *channel, struct np_frame *frame);
int np_channel_send_pair_v1(struct np_channel *channel, const struct np_frame *frame, const int pair[2]);
void np_channel_release_v1(struct np_channel *channel);
int np_helper_reduce_v1(void);
int np_helper_verify_v1(void);
/* The original single-threaded helper must install this after namespace,
 * privilege and descriptor setup, before its sole fixed Node bootstrap exec.
 * This restriction grants no exec/Source authority and does not replace the
 * required full post-exec synchronized helper seal. */
int np_helper_preexec_filter_v1(void);
int np_helper_filter_v1(void);
int np_helper_seal_v1(void);
#define NP_ANCESTORS 64
struct np_directory { int fds[NP_ANCESTORS]; char names[NP_ANCESTORS][256]; size_t count; };
enum np_publication_stage { NP_FILE_ABSENT, NP_FILE_CREATED, NP_FILE_WRITTEN, NP_FILE_SYNCED, NP_STAGE_SYNCED, NP_RENAMED, NP_FINAL_SYNCED, NP_PARENTS_SYNCED, NP_FILE_VERIFIED };
struct np_publication {
  struct np_directory *staging, *final;
  int file;
  enum np_publication_stage stage;
  bool attempted, uncertain;
  char staged_name[128], final_name[128];
  char bytes[512]; size_t length;
  dev_t device; ino_t inode;
};
int np_directory_pin_v1(struct np_directory *directory, const char *absolute_path);
int np_directory_check_v1(const struct np_directory *directory);
int np_directory_fd_v1(const struct np_directory *directory);
void np_directory_release_v1(struct np_directory *directory);
int np_fragment_init_v1(struct np_publication *publication, struct np_directory *staging, struct np_directory *final, const char locator[65]);
int np_fragment_publish_v1(struct np_publication *publication, struct np_gate *gate);
int np_fragment_verify_v1(struct np_publication *publication);
void np_publication_release_v1(struct np_publication *publication);
#endif
