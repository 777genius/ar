#define _GNU_SOURCE
#include "retained-v2.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
/* Private singleton retained by the original native principal. No handle can
 * be constructed from a record, pathname, descriptor number or matching hash. */
struct np_retained_v2 {
  struct np_root_origin *origin;
  struct np_v2_context context;
  struct np_v2_record records[NP_V2_RECORDS];
  char intents[3][NP_V2_LIMIT]; size_t intent_lengths[3];
  struct np_resource_view view;
  struct np_resource_pair pair;
  struct np_birth manager_birth;
  struct np_stock_manager *manager;
  struct np_gate gate;
  struct np_directory staging, units, manager_socket_parent;
  int manager_socket;
  struct np_publication fragment;
  char target[65], resource[65], association[65], obligation[65];
  uint64_t sequence, epoch, creation_epoch;
  bool slots, dispatched, retained, adopted, closed, uncertain;
};
static struct np_retained_v2 *original;
static const char *const namespaces[NP_V2_RECORDS] = {
  "retained-v2-targets", "retained-v2-resource-obligations",
  "retained-v2-reservations", "retained-v2-resource-bindings"
};
static uint32_t get32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static int member(struct np_retained_v2 *v) {
  if (!v || v != original || v->closed || v->uncertain || !v->slots) { errno = ESTALE; return -1; }
  struct np_v2_context now;
  if (np_origin_retained_context_v2(v->origin, &now) || now.operation != v->context.operation || now.ends != v->context.ends || strcmp(now.allocation, v->context.allocation) || np_resource_view_check_v1(&v->view)) { v->uncertain = true; return -1; }
  return 0;
}
static int stamp(struct np_retained_v2 *v, struct np_v2_stamp *out) {
  struct timespec actual;
  if (member(v) || np_origin_retained_lock_v2(v->origin)) return -1;
  int result = -1;
  if (clock_gettime(CLOCK_REALTIME, &actual) || actual.tv_sec <= 0 || actual.tv_nsec < 0 || actual.tv_nsec >= 1000000000 || (uint64_t)actual.tv_sec > UINT64_C(9007199254740991) / 1000 || v->sequence >= UINT64_C(9007199254740991)) goto done;
  uint64_t epoch = (uint64_t)actual.tv_sec * 1000 + (uint64_t)actual.tv_nsec / 1000000;
  if (epoch < v->epoch || epoch >= v->context.work_epoch || np_origin_effect_check_v1(v->origin, false, v->context.ends->work)) goto done;
  v->epoch = epoch;
  *out = (struct np_v2_stamp) { .sequence = ++v->sequence, .epoch = epoch };
  result = 0;
done: np_origin_retained_unlock_v2(v->origin); if (result) v->uncertain = true; return result;
}
static int namespace_create(struct np_retained_v2 *v, const char *name) {
  if (np_origin_retained_lock_v2(v->origin)) return -1;
  /* These names belong to this fresh original operation. Existing directories
   * are not imported, even when they happen to have the expected mode. */
  int failed = mkdirat(np_directory_fd_v1(v->context.operation), name, 0700);
  if (!failed) for (size_t i = v->context.operation->count; i > 0; i--) {
    if (np_origin_effect_check_v1(v->origin, false, v->context.ends->work) || np_directory_check_v1(v->context.operation) || fsync(v->context.operation->fds[i-1])) { failed = -1; break; }
  }
  np_origin_retained_unlock_v2(v->origin); return failed;
}
static int reserve_record(struct np_retained_v2 *v, unsigned index, const char *bytes, size_t length) {
  if (index >= NP_V2_RECORDS || !length || length >= NP_V2_LIMIT || bytes[length-1] != '\n') { errno = EINVAL; return -1; }
  struct np_v2_record *r = &v->records[index];
  r->generation = index + 1;
  if (np_v2_hash(bytes, length, r->digest)) return -1;
  char path[256];
  int n = snprintf(path, sizeof path, "%s/%s", NP_ORIGIN_ADMIN, namespaces[index]);
  if (n <= 0 || (size_t)n >= sizeof path || np_v2_file_reserve(&r->body, path, r->digest, bytes, length)) return -1;
  return 0;
}
static int publish_record(struct np_retained_v2 *v, unsigned index) {
  struct np_v2_record *r = &v->records[index];
  if (member(v) || r->committed || !r->body.reserved || !r->admitted.sequence) return -1;
  if (np_v2_file_publish(&r->body, v->origin) || stamp(v, &r->durable) || np_v2_file_verify(&r->body) || stamp(v, &r->readback) || member(v) || (index == 3 && (np_manager_current_v2(v->manager) || np_resource_pair_check_v1(&v->pair) || np_fragment_verify_v1(&v->fragment))) || stamp(v, &r->final)) goto fail;
  char events[NP_V2_LIMIT], path[256];
  int n = snprintf(events, sizeof events,
    "{\"admitted\":{\"atEpochMs\":%llu,\"sequence\":%llu},\"durable\":{\"atEpochMs\":%llu,\"sequence\":%llu},\"finalValidated\":{\"atEpochMs\":%llu,\"sequence\":%llu},\"generation\":%llu,\"heldReread\":null,\"producerId\":\"%s\",\"readback\":{\"atEpochMs\":%llu,\"sequence\":%llu},\"recordDigest\":\"%s\"}\n",
    (unsigned long long)r->admitted.epoch, (unsigned long long)r->admitted.sequence,
    (unsigned long long)r->durable.epoch, (unsigned long long)r->durable.sequence,
    (unsigned long long)r->final.epoch, (unsigned long long)r->final.sequence,
    (unsigned long long)r->generation, v->context.operation_digest, (unsigned long long)r->readback.epoch, (unsigned long long)r->readback.sequence, r->digest);
  int p = snprintf(path, sizeof path, "%s/retained-v2-publication-events", NP_ORIGIN_ADMIN);
  if (n <= 0 || (size_t)n >= sizeof events || p <= 0 || (size_t)p >= sizeof path || np_v2_file_reserve(&r->events, path, r->digest, events, (size_t)n) || np_v2_file_publish(&r->events, v->origin) || np_v2_file_verify(&r->events)) goto fail;
  /* The immutable event file contains only events that happened before it was
   * encoded. Its own durability is checked by this private native commit tail. */
  if (np_origin_retained_lock_v2(v->origin)) goto fail;
  /* File reads do not retain resource/fragment/manager currentness. Recheck
   * those actual handles after the reads, inside this original interlock. */
  int failed = np_v2_file_verify(&r->body) || np_v2_file_verify(&r->events) ||
    (index == 3 && (np_resource_pair_check_v1(&v->pair) || np_fragment_verify_v1(&v->fragment) || np_birth_associate_v1(v->context.clock, &v->manager_birth) || np_manager_current_v2(v->manager))) ||
    np_origin_effect_check_v1(v->origin, false, v->context.ends->work);
  if (!failed) r->committed = true;
  np_origin_retained_unlock_v2(v->origin);
  if (failed) goto fail;
  return 0;
fail: v->uncertain = true; return -1;
}
int np_retained_v2_create(struct np_root_origin *origin, struct np_retained_v2 **out) {
  if (!out || original || !origin) { errno = EALREADY; return -1; }
  *out = NULL;
  struct np_retained_v2 *v = calloc(1, sizeof *v);
  if (!v) return -1;
  original = v; v->origin = origin;
  v->manager_birth.pidfd = v->manager_birth.time = v->manager_birth.children = -1;
  v->fragment.file = -1; v->manager_socket = -1;
  if (np_origin_retained_context_v2(origin, &v->context)) goto fail;
  const unsigned char *fund = (const unsigned char *)v->context.funded_bytes;
  if (v->context.funded_length < 276 || memcmp(fund, "NPV2FD01", 8)) goto fail;
  char *fields[] = { v->target, v->resource, v->association, v->obligation };
  for (unsigned i = 0; i < 4; i++) {
    memcpy(fields[i], fund + 20 + i*64, 64); fields[i][64] = 0;
    if (strspn(fields[i], "0123456789abcdef") != 64) goto fail;
  }
  size_t total = 276;
  for (unsigned i = 0; i < 3; i++) {
    size_t length = get32(fund + 8 + 4*i);
    if (!length || length >= NP_V2_LIMIT || length > v->context.funded_length - total) goto fail;
    total += length;
  }
  if (total != v->context.funded_length || np_resource_view_pin_v1(&v->view, v->context.delegation) || np_birth_pin_v1(&v->manager_birth, 1, 0, 0) || np_birth_associate_v1(v->context.clock, &v->manager_birth)) goto fail;
  int manager_mount = open("/proc/1/ns/mnt", O_RDONLY | O_CLOEXEC), manager_group = open("/proc/1/ns/cgroup", O_RDONLY | O_CLOEXEC);
  struct stat held_mount, actual_mount, held_group, actual_group;
  int foreign_namespace = manager_mount < 0 || manager_group < 0 || fstat(v->context.mount_namespace, &held_mount) || fstat(manager_mount, &actual_mount) || fstat(v->context.cgroup_namespace, &held_group) || fstat(manager_group, &actual_group) || held_mount.st_dev != actual_mount.st_dev || held_mount.st_ino != actual_mount.st_ino || held_group.st_dev != actual_group.st_dev || held_group.st_ino != actual_group.st_ino;
  if (manager_mount >= 0) close(manager_mount);
  if (manager_group >= 0) close(manager_group);
  if (foreign_namespace) goto fail;
  v->gate = (struct np_gate) { .clock = v->context.clock, .cutoff = v->context.ends->work };
  v->epoch = v->context.admitted_epoch; v->sequence = 0;
  /* Register all original slots before the first namespace/publication/manager
   * effect. A failure retains this cell and its prefix; no replacement attempt. */
  v->slots = true;
  for (unsigned i = 0; i < NP_V2_RECORDS; i++) if (namespace_create(v, namespaces[i])) goto fail;
  if (namespace_create(v, "retained-v2-publication-events")) goto fail;
  size_t offset = 276;
  for (unsigned i = 0; i < 3; i++) {
    size_t length = get32(fund + 8 + 4*i);
    if (fund[offset + length - 1] != '\n') goto fail;
    memcpy(v->intents[i], fund + offset, length); v->intent_lengths[i] = length;
    offset += length;
  }
  char target_data[65], obligation_data[65];
  if (np_v2_hash(v->intents[0], v->intent_lengths[0], target_data) || strcmp(target_data, v->target) ||
      np_v2_hash(v->intents[1], v->intent_lengths[1], obligation_data) || strcmp(obligation_data, v->obligation)) goto fail;
  if (np_resource_pair_init_v1(&v->pair, &v->view, v->resource)) goto fail;
  *out = v; return 0;
fail: v->uncertain = true; return -1;
}
static int manager_connect(struct np_retained_v2 *v) {
  struct np_directory *parent = &v->manager_socket_parent;
  struct stat named;
  if (member(v) || np_directory_pin_v1(parent, "/run/systemd") || fstatat(np_directory_fd_v1(parent), "private", &named, AT_SYMLINK_NOFOLLOW) || !S_ISSOCK(named.st_mode) || named.st_uid || named.st_gid) return -1;
  v->manager_socket = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  int socket_fd = v->manager_socket;
  if (socket_fd < 0) return -1;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  memcpy(address.sun_path, "/run/systemd/private", sizeof "/run/systemd/private");
  int result = -1;
  if (np_origin_retained_lock_v2(v->origin)) goto done;
  int connected = connect(socket_fd, (struct sockaddr *)&address, sizeof address);
  np_origin_retained_unlock_v2(v->origin);
  if (connected && errno != EINPROGRESS) goto done;
  while (connected) {
    if (member(v)) goto done;
    struct pollfd pending = { .fd = socket_fd, .events = POLLOUT };
    int ready = poll(&pending, 1, 1);
    if (ready < 0) goto done;
    if (ready) { int error; socklen_t size = sizeof error; if (getsockopt(socket_fd, SOL_SOCKET, SO_ERROR, &error, &size) || error) goto done; break; }
  }
  struct stat after;
  if (np_directory_check_v1(parent) || fstatat(np_directory_fd_v1(parent), "private", &after, AT_SYMLINK_NOFOLLOW) || after.st_dev != named.st_dev || after.st_ino != named.st_ino || member(v) || np_manager_connect_v1(&v->manager, socket_fd, &v->manager_birth, &v->gate, v->resource, v->context.ends->generation, 1024)) goto done;
  result = 0;
done: return result; /* Both original socket and all pinned parents remain owned. */
}
static int request(struct np_retained_v2 *v, enum np_manager_step step) {
  if (member(v) || np_origin_retained_lock_v2(v->origin)) return -1;
  /* The stock manager owns one original request slot for each fixed step. */
  v->dispatched = true;
  int failed = np_manager_dispatch_v1(v->manager, step, &v->fragment, &v->pair);
  np_origin_retained_unlock_v2(v->origin);
  if (failed) goto fail;
  for (;;) {
    if (member(v)) goto fail;
    struct np_manager_observation observation;
    np_manager_snapshot_v1(v->manager, &observation);
    struct np_request_observation *row = &observation.requests[step];
    if (row->state == NP_REQUEST_REPLIED && !row->late && (step != NP_SLICE_START && step != NP_TARGET_START ? true : row->job_reply && row->job_done && !strcmp(row->outcome, "done"))) return 0;
    if (row->state == NP_REQUEST_FAILED || row->state == NP_REQUEST_UNCERTAIN || observation.lost) goto fail;
    uint64_t now;
    if (np_origin_now_v1(v->origin, &now)) goto fail;
    uint64_t end = now + UINT64_C(1000000);
    if (end > v->context.ends->work) end = v->context.ends->work;
    if (np_manager_join_v1(v->manager, end)) goto fail;
    struct pollfd wait = { .fd = -1 };
    if (poll(&wait, 0, 1) < 0) goto fail;
  }
fail: v->uncertain = true; return -1;
}
static int binding(struct np_retained_v2 *v) {
  struct np_manager_observation observation;
  np_manager_snapshot_v1(v->manager, &observation);
  if (observation.lost || np_resource_pair_check_v1(&v->pair) || np_fragment_verify_v1(&v->fragment)) return -1;
  char slice_invocation[33], target_invocation[33], directory[65], events[65], identity[256], bytes[NP_V2_LIMIT];
  for (unsigned i = 0; i < 16; i++) {
    (void)snprintf(slice_invocation+2*i, 3, "%02x", observation.slice_invocation[i]);
    (void)snprintf(target_invocation+2*i, 3, "%02x", observation.target_invocation[i]);
  }
  struct stat event_stat;
  if (fstat(v->pair.events, &event_stat) || !v->pair.directory_inode || (uint64_t)v->pair.device > UINT64_C(9007199254740991) || (uint64_t)v->pair.directory_inode > UINT64_C(9007199254740991) || !event_stat.st_ino || (uint64_t)event_stat.st_dev > UINT64_C(9007199254740991) || (uint64_t)event_stat.st_ino > UINT64_C(9007199254740991)) return -1;
  int n = snprintf(identity, sizeof identity, "{\"device\":%llu,\"inode\":%llu,\"producerId\":\"%s\"}\n", (unsigned long long)v->pair.device, (unsigned long long)v->pair.directory_inode, v->context.operation_digest);
  if (n <= 0 || (size_t)n >= sizeof identity || np_v2_hash(identity, (size_t)n, directory)) return -1;
  n = snprintf(identity, sizeof identity, "{\"device\":%llu,\"inode\":%llu,\"producerId\":\"%s\"}\n", (unsigned long long)event_stat.st_dev, (unsigned long long)event_stat.st_ino, v->context.operation_digest);
  if (n <= 0 || (size_t)n >= sizeof identity || np_v2_hash(identity, (size_t)n, events)) return -1;
  struct np_v2_stamp admitted;
  if (stamp(v, &admitted)) return -1;
  n = snprintf(bytes, sizeof bytes,
    "{\"data\":{\"cpuWeight\":100,\"creationStartedAtEpochMs\":%llu,\"directoryCustodyDigest\":\"%s\",\"eventsCustodyDigest\":\"%s\",\"identity\":{\"controlGroup\":\"/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/%s\",\"invocationId\":\"%s\",\"kernel\":{\"device\":%llu,\"inode\":%llu},\"sliceUnit\":\"%s\"},\"installationAssociationDigest\":\"%s\",\"obligationDigest\":\"%s\",\"pinnedBeforeAdmissionAtEpochMs\":%llu,\"retentionTarget\":{\"active\":\"active\",\"after\":[\"%s\"],\"invocationId\":\"%s\",\"nonExecuting\":true,\"requires\":[\"%s\"],\"unit\":\"subscription-runtime-retain-%s.target\"}},\"kind\":\"resource_binding\",\"publication\":{\"admitted\":{\"atEpochMs\":%llu,\"sequence\":%llu},\"generation\":4,\"producerId\":\"%s\"},\"schemaVersion\":2,\"targetDigest\":\"%s\"}\n",
    (unsigned long long)v->creation_epoch, directory, events, v->pair.slice, slice_invocation,
    (unsigned long long)v->pair.device, (unsigned long long)v->pair.directory_inode, v->pair.slice,
    v->association, v->obligation, (unsigned long long)admitted.epoch, v->pair.slice, target_invocation, v->pair.slice, v->resource,
    (unsigned long long)admitted.epoch, (unsigned long long)admitted.sequence, v->context.operation_digest, v->target);
  if (n <= 0 || (size_t)n >= sizeof bytes || reserve_record(v, 3, bytes, (size_t)n)) return -1;
  v->records[3].admitted = admitted;
  return publish_record(v, 3);
}
int np_retained_v2_prepare(struct np_retained_v2 *v) {
  if (member(v) || v->dispatched || v->retained) return -1;
  const char *kinds[] = { "target", "resource_obligation", "reservation" };
  for (unsigned i = 0; i < 3; i++) {
    if (i == 2) {
      /* Funded intent names the immutable obligation DATA digest. Only this
       * one derived reference changes when the actual obligation BODY exists;
       * no future admission time or BODY hash was forecast in the intent. */
      char expected[96];
      (void)snprintf(expected, sizeof expected, "\"obligationDigest\":\"%s\"", v->obligation);
      char *field = strstr(v->intents[2], expected);
      if (!field || strstr(field + strlen(expected), expected)) goto fail;
      memcpy(field + strlen("\"obligationDigest\":\""), v->records[1].digest, 64);
      memcpy(v->obligation, v->records[1].digest, 65);
    }
    struct np_v2_stamp admitted;
    if (stamp(v, &admitted)) goto fail;
    char body[NP_V2_LIMIT];
    int n = snprintf(body, sizeof body,
      "{\"data\":%.*s,\"kind\":\"%s\",\"publication\":{\"admitted\":{\"atEpochMs\":%llu,\"sequence\":%llu},\"generation\":%u,\"producerId\":\"%s\"},\"schemaVersion\":2,\"targetDigest\":\"%s\"}\n",
      (int)v->intent_lengths[i]-1, v->intents[i], kinds[i], (unsigned long long)admitted.epoch,
      (unsigned long long)admitted.sequence, i+1, v->context.operation_digest, v->target);
    if (n <= 0 || (size_t)n >= sizeof body || reserve_record(v, i, body, (size_t)n)) goto fail;
    v->records[i].admitted = admitted;
    if (publish_record(v, i)) return -1;
  }
  if (manager_connect(v)) goto fail;
  for (enum np_manager_step step = NP_TARGET_ABSENT; step <= NP_SLICE_CPU_FACTS; step++) {
    if (step == NP_SLICE_START) { struct np_v2_stamp actual; if (stamp(v, &actual)) goto fail; v->creation_epoch = actual.epoch; }
    if (request(v, step)) goto fail;
  }
  if (member(v) || np_resource_pair_acquire_v1(&v->pair, &v->gate) || np_directory_pin_v1(&v->staging, NP_ORIGIN_ADMIN) || np_directory_pin_v1(&v->units, "/run/systemd/system") || np_fragment_init_v1(&v->fragment, &v->staging, &v->units, v->resource) || np_origin_retained_lock_v2(v->origin)) goto fail;
  int failed = np_fragment_publish_v1(&v->fragment, &v->gate);
  np_origin_retained_unlock_v2(v->origin);
  if (failed) goto fail;
  for (enum np_manager_step step = NP_RELOAD; step < NP_MANAGER_STEPS; step++) if (request(v, step)) goto fail;
  if (binding(v)) goto fail;
  v->retained = true; return 0;
fail: v->uncertain = true; return -1;
}
int np_retained_v2_adopt(struct np_retained_v2 *v) {
  if (member(v) || !v->retained || v->adopted || !v->manager || np_manager_current_v2(v->manager) || np_resource_pair_check_v1(&v->pair) || np_fragment_verify_v1(&v->fragment) || np_birth_associate_v1(v->context.clock, &v->manager_birth)) return -1;
  struct np_manager_observation observation;
  np_manager_snapshot_v1(v->manager, &observation);
  if (observation.lost || observation.closed) return -1;
  if (np_origin_retained_lock_v2(v->origin)) return -1;
  int failed = 0;
  for (unsigned i = 0; i < NP_V2_RECORDS; i++) if (!v->records[i].committed || np_v2_file_verify(&v->records[i].body) || np_v2_file_verify(&v->records[i].events)) failed = -1;
  /* All eight immutable file reads precede this final physical tail. The
   * interlock does not freeze external PID1, fragment or kernel changes. */
  if (!failed && !np_resource_pair_check_v1(&v->pair) && !np_fragment_verify_v1(&v->fragment) &&
      !np_birth_associate_v1(v->context.clock, &v->manager_birth) && !np_manager_current_v2(v->manager) &&
      !np_origin_effect_check_v1(v->origin, false, v->context.ends->work)) v->adopted = true;
  else failed = -1;
  np_origin_retained_unlock_v2(v->origin);
  return failed;
}
void np_retained_v2_close(struct np_retained_v2 *v) {
  if (!v || v != original) return;
  v->closed = true;
  if (v->manager) np_manager_close_v1(v->manager);
  /* A1 has no retirement authority. All acquired/partial descriptors and
   * request slots remain in the original cell. No terminal or NeverCreated. */
}
