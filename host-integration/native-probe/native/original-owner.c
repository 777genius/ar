#define _GNU_SOURCE
#include "original-owner.h"
#ifdef NP_ASSOCIATED_ORIGIN_V2
#include "root-producer-native.h"
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/memfd.h>
#include <linux/nsfs.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
/* These are build-bound closure inputs, not runtime selectors. The installed
 * N1b issuer must qualify their entire emitted/loader/library closure. */
#ifndef NP_OWNER_NODE
#define NP_OWNER_NODE "/opt/subscription-runtime/native-probe/node"
#endif
#ifndef NP_OWNER_SCRIPT
#define NP_OWNER_SCRIPT "/opt/subscription-runtime/native-probe/original-owner-helper.mjs"
#endif
#ifndef NP_OWNER_ADDON
#define NP_OWNER_ADDON "/opt/subscription-runtime/native-probe/original-owner.node"
#endif
#define NP_COLD UINT64_C(10000000000)
#define NP_OBSERVATION UINT64_C(2000000000)
#define NP_ATTEMPT UINT64_C(60000000000)
#define NP_SEAL UINT32_C(0x5345414c)
#define NP_ENV_LOSS UINT32_C(0x454e564c)
#define NP_OWNER_LIMIT 128
struct np_startup_memo { uint64_t magic, generation, anchor, cold_end; int64_t issuer; };
#define NP_STARTUP_MAGIC UINT64_C(0x4e504f5249473031)
#define NP_STARTUP_SEALS (F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE)
struct np_original_owner {
  struct np_clock clock;
  struct np_channel channel;
  struct np_original_owner *membership;
  pid_t issuer;
  int issuer_pidfd, boot, closure[4];
  char boot_id[37];
  struct np_owner_data data;
  bool launched, reaped;
#ifdef NP_ASSOCIATED_ORIGIN_V2
  struct np_origin_child *origin;
#endif
};
/* One native lifetime per original issuer. Even disposal cannot reserve again. */
static struct np_original_owner *registry;
static bool issued;
static pid_t original_issuer;
static struct { pid_t pid, parent; uint64_t generation, sequence; bool sealed, lost; } helper;
static int owner_sample(struct np_original_owner *o, uint64_t *out) {
#ifdef NP_ASSOCIATED_ORIGIN_V2
  if (o->origin) return np_origin_sample_v1(o->origin, out);
#endif
  return np_clock_sample_v1(&o->clock, out);
}
static int fail(struct np_original_owner *o, enum np_owner_loss loss, int error) {
  if (o->data.state != NP_OWNER_CLOSED) {
    o->data.state = NP_OWNER_CLOSED; o->data.loss = loss;
    o->data.uncertain = loss != NP_LOSS_STOP;
    uint64_t now;
    if (!owner_sample(o, &now) && now <= INT64_MAX - NP_ATTEMPT)
      o->data.attempt_end = now + NP_ATTEMPT < o->clock.cleanup_end ? now + NP_ATTEMPT : o->clock.cleanup_end;
  }
#ifdef NP_ASSOCIATED_ORIGIN_V2
  if (o->origin) np_origin_child_close_v1(o->origin);
#endif
  errno = error; return -1;
}
static int member(struct np_original_owner *o) {
  /* Compare membership before dereferencing caller memory. */
  if (!o || o != registry || getpid() != original_issuer) { errno = ESTALE; return -1; }
  if (o->membership != o || o->issuer != getpid()) return fail(o, NP_LOSS_ORIGINAL, ESTALE);
  return 0;
}
static int boot_read(int fd, char out[37]) {
  char text[38]; ssize_t n = pread(fd, text, sizeof text, 0);
  if (n != 37 || text[36] != '\n') { errno = ESTALE; return -1; }
  for (size_t i = 0; i < 36; i++) {
    bool hyphen = i == 8 || i == 13 || i == 18 || i == 23;
    if (hyphen ? text[i] != '-' : !((text[i] >= '0' && text[i] <= '9') || (text[i] >= 'a' && text[i] <= 'f'))) { errno = ESTALE; return -1; }
  }
  memcpy(out, text, 36); out[36] = 0; return 0;
}
static int retained_ns(int a, int b) {
  struct stat x, y;
  if (fstat(a, &x) || fstat(b, &y) || ioctl(a, NS_GET_NSTYPE) != CLONE_NEWTIME || ioctl(b, NS_GET_NSTYPE) != CLONE_NEWTIME) return -1;
  if (x.st_dev != y.st_dev || x.st_ino != y.st_ino) { errno = EXDEV; return -1; }
  return 0;
}
static int original(struct np_original_owner *o, uint64_t cutoff) {
  char boot[37]; uint64_t now;
  struct pollfd issuer = { .fd = o->issuer_pidfd, .events = POLLIN };
  if (poll(&issuer, 1, 0) != 0 || boot_read(o->boot, boot) || strcmp(boot, o->boot_id) || owner_sample(o, &now)) return fail(o, NP_LOSS_ORIGINAL, ESTALE);
  if (now >= cutoff) return fail(o, NP_LOSS_CUTOFF, ETIMEDOUT);
  return 0;
}
static int committed(struct np_original_owner *o) {
  if (!o->data.committed || o->data.state != NP_OWNER_COMMITTED || o->channel.lost) { errno = ESTALE; return -1; }
#ifdef NP_ASSOCIATED_ORIGIN_V2
  if (o->origin && np_origin_child_work_v1(o->origin)) return fail(o, NP_LOSS_ORIGINAL, ESTALE);
#endif
  if (original(o, o->clock.preparation_end)) return -1;
  /* No helper proc reopen here. These are the actual descriptors collected
   * while the fixed child was held, with live birth checks on both sides. */
  if (np_birth_live_v1(&o->channel.birth) || retained_ns(o->clock.time, o->channel.birth.time) || retained_ns(o->clock.children, o->channel.birth.children) || np_birth_live_v1(&o->channel.birth)) return fail(o, NP_LOSS_HELPER, ESRCH);
  return 0;
}
static int closure_pin(const char *path, bool executable) {
  if (!path || path[0] != '/' || strlen(path) >= PATH_MAX) { errno = EINVAL; return -1; }
  char copy[PATH_MAX]; strcpy(copy, path);
  int directory = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC); if (directory < 0) return -1;
  char *save = NULL, *part = strtok_r(copy + 1, "/", &save);
  while (part) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(directory); errno = EINVAL; return -1; }
    char *next = strtok_r(NULL, "/", &save);
    int fd = openat(directory, part, (next ? O_PATH | O_DIRECTORY : O_RDONLY) | O_CLOEXEC | O_NOFOLLOW);
    struct stat s;
    if (fd < 0 || fstat(fd, &s) || s.st_uid != 0 || (s.st_mode & 0022) || (next ? !S_ISDIR(s.st_mode) : (!S_ISREG(s.st_mode) || s.st_nlink != 1 || !(s.st_mode & 0004) || (executable && !(s.st_mode & 0001))))) {
      if (fd >= 0) close(fd);
      close(directory); errno = EPERM; return -1;
    }
    close(directory); directory = fd; part = next;
  }
  return directory;
}
int np_original_owner_create_v1(struct np_original_owner **out) {
  if (!out) { errno = EINVAL; return -1; } *out = NULL;
  if (issued || getuid() || geteuid() || getgid() || getegid()) { errno = EPERM; return -1; }
  /* Trusted entry runs before any threads/Source. A second native caller cannot
   * gain a fresh allowance after a failed setup or a disposed registry. */
  issued = true; original_issuer = getpid();
  struct np_original_owner *o = calloc(1, sizeof *o); if (!o) return -1;
  o->clock.time = o->clock.children = o->clock.mount = -1;
  o->channel.owner = o->channel.helper = -1;
  o->channel.birth.pidfd = o->channel.birth.time = o->channel.birth.children = -1;
  o->issuer_pidfd = o->boot = -1; for (unsigned i = 0; i < 4; i++) o->closure[i] = -1;
  o->membership = o; o->issuer = getpid(); registry = o; *out = o;
  o->data.state = NP_OWNER_RESERVED;
  o->issuer_pidfd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  o->boot = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (o->issuer_pidfd < 0 || o->boot < 0 || boot_read(o->boot, o->boot_id) || np_clock_pin_v1(&o->clock)) return fail(o, NP_LOSS_SETUP, ESTALE);
  o->data.anchor = o->clock.anchor; o->data.preparation_end = o->clock.preparation_end; o->data.cleanup_end = o->clock.cleanup_end;
  o->data.cold_end = o->clock.anchor + NP_COLD;
  uint64_t generation = 0;
  if (getrandom(&generation, sizeof generation, 0) != (ssize_t)sizeof generation || !generation || np_channel_create_v1(&o->channel, generation)) return fail(o, NP_LOSS_SETUP, ESTALE);
  o->data.generation = generation;
  const char *paths[] = { NP_OWNER_NODE, NP_OWNER_SCRIPT, NP_OWNER_ADDON };
  for (unsigned i = 0; i < 3; i++) {
    o->closure[i] = closure_pin(paths[i], i == 0);
    if (o->closure[i] < 0) return fail(o, NP_LOSS_SETUP, EPERM);
  }
  /* Sealed native startup-only memo: the fixed child carries the original
   * cold authority across exec before either startup packet can be delayed.
   * It is never an owner import API or a JS-selectable descriptor. */
  struct np_startup_memo memo = { .magic = NP_STARTUP_MAGIC, .generation = generation, .anchor = o->clock.anchor, .cold_end = o->data.cold_end, .issuer = getpid() };
  o->closure[3] = (int)syscall(SYS_memfd_create, "np-original-startup", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (o->closure[3] < 0 || write(o->closure[3], &memo, sizeof memo) != (ssize_t)sizeof memo || fcntl(o->closure[3], F_ADD_SEALS, NP_STARTUP_SEALS)) return fail(o, NP_LOSS_SETUP, ESTALE);
  return original(o, o->data.cold_end);
}
static int send_launch(struct np_original_owner *o) {
  struct np_frame frame = { .magic = NP_FRAME_MAGIC, .version = 1, .kind = NP_HELLO, .generation = o->channel.generation };
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(4 * sizeof(int))]; } control;
  memset(&control, 0, sizeof control);
  struct iovec iov = { .iov_base = &frame, .iov_len = sizeof frame };
  struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
  c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(4 * sizeof(int)); memcpy(CMSG_DATA(c), o->closure, sizeof o->closure);
  if (original(o, o->data.cold_end) || sendmsg(o->channel.owner, &msg, MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof frame) return -1;
  /* Second parent-to-child packet is consumed only by protected postexec C. */
  if (original(o, o->data.cold_end)) return -1;
  return send(o->channel.owner, &frame, sizeof frame, MSG_NOSIGNAL | MSG_DONTWAIT) == (ssize_t)sizeof frame ? 0 : -1;
}
static void fixed_child(struct np_channel *channel) {
  if (np_channel_child_inherit_v1(channel)) _exit(120);
  struct np_frame frame;
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(4 * sizeof(int))]; } control;
  memset(&control, 0, sizeof control);
  struct iovec iov = { .iov_base = &frame, .iov_len = sizeof frame };
  struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  if (recvmsg(NP_ENDPOINT, &msg, MSG_CMSG_CLOEXEC) != (ssize_t)sizeof frame || msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC) || frame.magic != NP_FRAME_MAGIC || frame.version != 1 || frame.kind != NP_HELLO || frame.generation != channel->generation || frame.sequence || frame.slot || frame.result) _exit(121);
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
  if (!c || c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS || c->cmsg_len != CMSG_LEN(4 * sizeof(int)) || CMSG_NXTHDR(&msg, c)) _exit(122);
  int incoming[4], held[4]; memcpy(incoming, CMSG_DATA(c), sizeof incoming);
  for (unsigned i = 0; i < 4; i++) { held[i] = fcntl(incoming[i], F_DUPFD_CLOEXEC, 8); if (held[i] < 0) _exit(123); }
  for (unsigned i = 0; i < 4; i++) if (dup3(held[i], (int)i + 4, i == 0 ? O_CLOEXEC : 0) < 0) _exit(124);
  if (syscall(SYS_close_range, 8U, UINT_MAX, 0) || np_helper_reduce_v1() || np_helper_preexec_filter_v1()) _exit(125);
  char *const args[] = { "node", "/proc/self/fd/5", NULL };
  char *const env[] = { "PATH=/usr/bin:/bin", "UV_USE_IO_URING=0", NULL };
  (void)syscall(SYS_execveat, 4, "", args, env, AT_EMPTY_PATH); _exit(126);
}
int np_original_owner_launch_v1(struct np_original_owner *o) {
  if (member(o)) return -1;
  if (o->launched || o->data.state != NP_OWNER_RESERVED) return fail(o, NP_LOSS_PROTOCOL, EALREADY);
  if (original(o, o->data.cold_end)) return -1;
  o->launched = true; /* consume before fork; even failure cannot retry */
#ifdef NP_ASSOCIATED_ORIGIN_V2
  if (o->origin && np_origin_child_begin_v1(o->origin, NP_ORIGIN_HELPER)) return fail(o, NP_LOSS_ORIGINAL, ESTALE);
#endif
  pid_t pid = fork();
  if (pid == 0) fixed_child(&o->channel);
#ifdef NP_ASSOCIATED_ORIGIN_V2
  if (o->origin) np_origin_child_end_v1(o->origin);
#endif
  if (pid < 0) return fail(o, NP_LOSS_SETUP, errno);
  o->data.helper = pid; o->data.state = NP_OWNER_HELD;
  if (np_channel_parent_bind_v1(&o->channel, pid, NP_UID, NP_GID) || np_birth_associate_v1(&o->clock, &o->channel.birth) || original(o, o->data.cold_end) || send_launch(o)) {
    /* Closing the original endpoint releases a held child, never an adopted
     * process. Keep birth/nsfs and the exact wait obligation in the registry. */
    (void)shutdown(o->channel.owner, SHUT_RDWR); return fail(o, NP_LOSS_SETUP, ESTALE);
  }
  return 0;
}
static int receive(struct np_original_owner *o) {
  struct np_frame frame;
  if (np_channel_receive_v1(&o->channel, &frame)) {
    if (errno == EAGAIN || errno == EINTR) return 1;
    return fail(o, np_birth_live_v1(&o->channel.birth) ? NP_LOSS_HELPER : NP_LOSS_PROTOCOL, ESTALE);
  }
  if (frame.slot || o->channel.sequence > NP_OWNER_LIMIT) return fail(o, NP_LOSS_PROTOCOL, EPROTO);
  o->data.sequence = o->channel.sequence;
  if (o->data.state == NP_OWNER_HELD) {
    if (frame.kind != NP_HELLO || frame.sequence != 1 || frame.result != NP_SEAL || original(o, o->data.cold_end) || np_birth_live_v1(&o->channel.birth) || retained_ns(o->clock.time, o->channel.birth.time) || retained_ns(o->clock.children, o->channel.birth.children) || np_birth_live_v1(&o->channel.birth)) return fail(o, NP_LOSS_PROTOCOL, EPROTO);
    /* v1 refusal remains observable, but is not turned into authority. The
     * distinct commit consumed the fixed native seal producer's HELLO above. */
    o->data.legacy_refused = np_birth_associate_v1(&o->clock, &o->channel.birth) != 0;
#ifdef NP_ASSOCIATED_ORIGIN_V2
    if (o->origin) {
      if (np_origin_child_commit_begin_v1(o->origin)) return fail(o, NP_LOSS_ORIGINAL, ESTALE);
      if (np_birth_live_v1(&o->channel.birth) || retained_ns(o->clock.time, o->channel.birth.time) || retained_ns(o->clock.children, o->channel.birth.children) || np_origin_child_commit_check_v1(o->origin)) {
        np_origin_child_end_v1(o->origin); return fail(o, NP_LOSS_ORIGINAL, ESTALE);
      }
      o->data.committed = true; o->data.state = NP_OWNER_COMMITTED;
      np_origin_child_end_v1(o->origin);
    } else
#endif
    { o->data.committed = true; o->data.state = NP_OWNER_COMMITTED; }
    return committed(o);
  }
  if (frame.kind == NP_CLOSE && (frame.result == 0 || frame.result == NP_ENV_LOSS)) {
    int result = fail(o, frame.result == NP_ENV_LOSS ? NP_LOSS_ENVIRONMENT : NP_LOSS_STOP, ESTALE);
    /* Native disposal stays alive until the original parent retains this
     * loss prefix. This ACK is observation only, and grants no admission. */
    const unsigned char ack = 0x43;
    (void)send(o->channel.owner, &ack, sizeof ack, MSG_NOSIGNAL | MSG_DONTWAIT);
    return result;
  }
  if (frame.kind != NP_JOIN || frame.result || committed(o)) return fail(o, NP_LOSS_PROTOCOL, EPROTO);
  return 0;
}
static void snapshot(struct np_original_owner *o, struct np_owner_data *out) {
  o->data.live = o->channel.birth.pidfd >= 0 && !np_birth_live_v1(&o->channel.birth);
  o->data.retained = o->channel.birth.pidfd >= 0 && o->channel.birth.time >= 0 && o->channel.birth.children >= 0 && o->clock.time >= 0 && o->clock.children >= 0;
  *out = o->data;
}
int np_original_owner_observe_v1(struct np_original_owner *o, struct np_owner_data *out) {
  if (member(o) || !out) { errno = EINVAL; return -1; }
  if (o->data.state == NP_OWNER_CLOSED) { snapshot(o, out); return 0; }
  uint64_t now;
  if (owner_sample(o, &now) || now > INT64_MAX - NP_OBSERVATION) { fail(o, NP_LOSS_ORIGINAL, ESTALE); snapshot(o, out); return -1; }
  uint64_t cutoff = o->data.state == NP_OWNER_HELD ? o->data.cold_end : o->clock.preparation_end;
  o->data.observation_end = now + NP_OBSERVATION < cutoff ? now + NP_OBSERVATION : cutoff;
  for (unsigned count = 0; count < NP_OWNER_LIMIT; count++) {
    if (original(o, o->data.observation_end)) break;
    int result = receive(o);
    if (result <= 0) break;
    struct pollfd p = { .fd = o->channel.owner, .events = POLLIN | POLLHUP };
    int ready = poll(&p, 1, 10);
    if (ready < 0 && errno != EINTR) { fail(o, NP_LOSS_PROTOCOL, errno); break; }
  }
  snapshot(o, out); return o->data.state == NP_OWNER_CLOSED ? -1 : 0;
}
void np_original_owner_close_v1(struct np_original_owner *o) {
  if (member(o)) return;
  (void)fail(o, NP_LOSS_STOP, ESTALE);
  if (o->channel.owner >= 0) (void)shutdown(o->channel.owner, SHUT_RDWR);
}
int np_original_owner_join_v1(struct np_original_owner *o) {
  if (member(o)) return -1;
  if (!o->launched || o->data.helper <= 0) { o->reaped = true; return 0; }
  if (o->reaped) return 0;
  /* Observation only; the wait consumes the exact original child, no kill,
   * repair, fresh channel, relative timeout or terminal/empty certificate. */
  if (original(o, o->data.attempt_end ? o->data.attempt_end : o->clock.cleanup_end)) return -1;
  int status; pid_t pid = waitpid(o->data.helper, &status, WNOHANG);
  if (pid == o->data.helper) { o->reaped = true; return 0; }
  errno = pid == 0 ? EAGAIN : ESTALE; return -1;
}
int np_original_owner_dispose_v1(struct np_original_owner *o) {
  if (member(o)) return -1;
  if (o->launched && !o->reaped) { errno = EBUSY; return -1; }
  np_original_owner_close_v1(o); np_channel_release_v1(&o->channel); np_clock_release_v1(&o->clock);
  for (unsigned i = 0; i < 4; i++) if (o->closure[i] >= 0) close(o->closure[i]);
  if (o->boot >= 0) close(o->boot);
  if (o->issuer_pidfd >= 0) close(o->issuer_pidfd);
  registry = NULL; free(o); return 0;
}
static int startup_receive(struct np_frame *initial) {
  int type, domain; socklen_t size = sizeof type;
  struct ucred peer; socklen_t peer_size = sizeof peer;
  /* Reject a silent foreign endpoint before touching its payload. Stored
   * peer credentials authenticate this original parent-side channel creation;
   * they never substitute for later child SCM_CREDENTIALS. */
  if (getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_TYPE, &type, &size) || size != sizeof type || type != SOCK_SEQPACKET) return -1;
  size = sizeof domain;
  if (getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_DOMAIN, &domain, &size) || size != sizeof domain || domain != AF_UNIX || getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) || peer_size != sizeof peer || peer.pid != getppid() || peer.uid != 0 || peer.gid != 0) { errno = EPERM; return -1; }
  struct np_startup_memo memo; struct stat s;
  if (fstat(7, &s) || !S_ISREG(s.st_mode) || s.st_uid != 0 || s.st_gid != 0 || s.st_nlink != 0 || s.st_size != (off_t)sizeof memo || fcntl(7, F_GET_SEALS) != NP_STARTUP_SEALS || pread(7, &memo, sizeof memo, 0) != (ssize_t)sizeof memo || memo.magic != NP_STARTUP_MAGIC || !memo.generation || memo.issuer != peer.pid || memo.anchor > INT64_MAX - NP_COLD || memo.cold_end != memo.anchor + NP_COLD) { errno = ESTALE; return -1; }
  uint64_t high_water = memo.anchor;
  for (;;) {
    struct timespec ts;
    if (getppid() != peer.pid || clock_gettime(CLOCK_MONOTONIC, &ts) || ts.tv_sec < 0 || ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000L || (uint64_t)ts.tv_sec > INT64_MAX / UINT64_C(1000000000)) { errno = ESTALE; return -1; }
    uint64_t now = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
    if (now < high_water || now >= memo.cold_end) { errno = ETIMEDOUT; return -1; }
    high_water = now;
    ssize_t n = recv(NP_ENDPOINT, initial, sizeof *initial, MSG_DONTWAIT | MSG_TRUNC);
    if (n >= 0) {
      /* A successful receipt is checked again against the same absolute end;
       * no relative retry/receipt origin is created. */
      if (n != (ssize_t)sizeof *initial || initial->generation != memo.generation || clock_gettime(CLOCK_MONOTONIC, &ts) || ts.tv_sec < 0 || ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000L || (uint64_t)ts.tv_sec > INT64_MAX / UINT64_C(1000000000)) return -1;
      now = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
      if (now < high_water || now >= memo.cold_end || getppid() != peer.pid) { errno = ETIMEDOUT; return -1; }
      return 0;
    }
    if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return -1;
    struct pollfd p = { .fd = NP_ENDPOINT, .events = POLLIN | POLLHUP };
    uint64_t remaining = memo.cold_end - now;
    int milliseconds = (int)((remaining + UINT64_C(999999)) / UINT64_C(1000000));
    if (poll(&p, 1, milliseconds) < 0 && errno != EINTR) return -1;
    if (p.revents & (POLLHUP | POLLERR | POLLNVAL)) { errno = ESTALE; return -1; }
    /* EAGAIN, EINTR and scheduling delay return to the original cold check. */
  }
}
int np_original_helper_start_v1(uint64_t *generation) {
  if (!generation || helper.sealed || helper.lost) { errno = ESTALE; return -1; }
  helper.lost = true; /* startup can never be retried */
  struct np_frame initial;
  if (startup_receive(&initial) || initial.magic != NP_FRAME_MAGIC || initial.version != 1 || initial.kind != NP_HELLO || !initial.generation || initial.sequence || initial.slot || initial.result) return -1;
  helper.pid = getpid(); helper.parent = getppid(); helper.generation = initial.generation;
  /* Loaded script/addon bytes have been consumed from original held files.
   * They are startup-only, never capabilities exposed to Source. */
  if (close(5) || close(6) || close(7) || np_helper_seal_v1()) return -1;
  helper.sealed = true; helper.lost = false;
  if (np_original_helper_message_v1(NP_HELLO)) return -1;
  *generation = helper.generation; return 0;
}
int np_original_helper_message_v1(uint16_t kind) {
  if (!helper.sealed || helper.lost || getpid() != helper.pid || getppid() != helper.parent || helper.sequence >= NP_OWNER_LIMIT || (kind != NP_HELLO && kind != NP_JOIN && kind != NP_CLOSE) || (kind == NP_HELLO && helper.sequence)) { np_original_helper_loss_v1(); errno = ESTALE; return -1; }
  struct np_frame frame = { .magic = NP_FRAME_MAGIC, .version = 1, .kind = kind, .generation = helper.generation, .sequence = ++helper.sequence, .result = kind == NP_HELLO ? NP_SEAL : 0 };
  if (send(NP_ENDPOINT, &frame, sizeof frame, MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)sizeof frame) { np_original_helper_loss_v1(); return -1; }
  if (kind == NP_CLOSE) helper.lost = true;
  return 0;
}
void np_original_helper_loss_v1(void) {
  if (helper.sealed && !helper.lost && helper.sequence < NP_OWNER_LIMIT) {
    struct np_frame frame = { .magic = NP_FRAME_MAGIC, .version = 1, .kind = NP_CLOSE, .generation = helper.generation, .sequence = ++helper.sequence, .result = NP_ENV_LOSS };
    helper.lost = true;
    if (send(NP_ENDPOINT, &frame, sizeof frame, MSG_NOSIGNAL | MSG_DONTWAIT) == (ssize_t)sizeof frame) {
      struct pollfd p = { .fd = NP_ENDPOINT, .events = POLLIN | POLLHUP };
      if (poll(&p, 1, 2000) > 0 && (p.revents & POLLIN)) {
        unsigned char ack; (void)recv(NP_ENDPOINT, &ack, sizeof ack, MSG_DONTWAIT);
      }
    }
  }
  helper.lost = true; (void)shutdown(NP_ENDPOINT, SHUT_RDWR);
}

#ifdef NP_ASSOCIATED_ORIGIN_V2
/* Only the native fixed fork branch can supply this opaque original child. */
int np_original_owner_prefix_v2(struct np_original_owner *o,char *bytes,size_t capacity) {
  if(member(o)||!bytes)return -1;
  struct stat time={0},children={0};
  bool held=o->channel.birth.time>=0&&o->channel.birth.children>=0&&!fstat(o->channel.birth.time,&time)&&!fstat(o->channel.birth.children,&children);
  int count=snprintf(bytes,capacity,"helper=%ld generation=%llu sequence=%llu state=%u loss=%u committed=%u reaped=%u nsHeld=%u time=%llu:%llu children=%llu:%llu anchor=%llu work=%llu cleanup=%llu cold=%llu attempt=%llu",(long)o->data.helper,(unsigned long long)o->data.generation,(unsigned long long)o->data.sequence,(unsigned)o->data.state,(unsigned)o->data.loss,o->data.committed,o->reaped,held,(unsigned long long)time.st_dev,(unsigned long long)time.st_ino,(unsigned long long)children.st_dev,(unsigned long long)children.st_ino,(unsigned long long)o->clock.anchor,(unsigned long long)o->clock.preparation_end,(unsigned long long)o->clock.cleanup_end,(unsigned long long)o->data.cold_end,(unsigned long long)o->data.attempt_end);
  return count<=0||(size_t)count>=capacity?-1:0;
}
int np_original_owner_poll_fd_v2(struct np_original_owner *o) { return member(o) ? -1 : o->channel.owner; }
struct np_startup_associated { uint64_t magic, generation, anchor, cold_end, preparation_end, cleanup_end; int64_t issuer; };
#define NP_ASSOCIATED_MAGIC UINT64_C(0x4e504f5249473032)
int np_original_owner_from_origin_fork_v2(struct np_origin_child *origin, struct np_original_owner **out) {
  if (!out || issued || getuid() || geteuid() || getgid() || getegid()) return -1;
  *out = NULL;
  struct np_clock clock; uint64_t cold;
  if (np_origin_child_clock_v1(origin, &clock, &cold)) return -1;
  issued = true; original_issuer = getpid();
  struct np_original_owner *o = calloc(1, sizeof *o); if (!o) return -1;
  o->clock = clock; o->origin = origin; o->issuer = getpid(); o->membership = o; registry = o; *out = o;
  o->issuer_pidfd = o->boot = -1; o->channel.owner = o->channel.helper = -1;
  o->channel.birth.pidfd = o->channel.birth.time = o->channel.birth.children = -1;
  for (unsigned i = 0; i < 4; i++) o->closure[i] = -1;
  o->data.state = NP_OWNER_RESERVED; o->data.anchor = clock.anchor; o->data.preparation_end = clock.preparation_end; o->data.cleanup_end = clock.cleanup_end; o->data.cold_end = cold;
  o->issuer_pidfd = (int)syscall(SYS_pidfd_open, getpid(), 0);
  o->boot = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  uint64_t generation = 0;
  if (o->issuer_pidfd < 0 || o->boot < 0 || boot_read(o->boot, o->boot_id) || getrandom(&generation, sizeof generation, 0) != (ssize_t)sizeof generation || !generation || np_channel_create_v1(&o->channel, generation) || np_origin_child_closure_v1(origin, o->closure)) return fail(o, NP_LOSS_SETUP, ESTALE);
  o->data.generation = generation;
  struct np_startup_associated memo = { .magic = NP_ASSOCIATED_MAGIC, .generation = generation, .anchor = clock.anchor, .cold_end = cold, .preparation_end = clock.preparation_end, .cleanup_end = clock.cleanup_end, .issuer = getpid() };
  o->closure[3] = (int)syscall(SYS_memfd_create, "np-associated-startup", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (o->closure[3] < 0 || write(o->closure[3], &memo, sizeof memo) != (ssize_t)sizeof memo || fcntl(o->closure[3], F_ADD_SEALS, NP_STARTUP_SEALS)) return fail(o, NP_LOSS_SETUP, ESTALE);
  return original(o, cold);
}
static int associated_sample(uint64_t cold, uint64_t *high_water) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) || ts.tv_sec < 0 || ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000L || (uint64_t)ts.tv_sec > INT64_MAX / UINT64_C(1000000000)) return -1;
  uint64_t now = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
  if (now > INT64_MAX || now < *high_water || now >= cold) return -1;
  *high_water = now; return 0;
}
static int startup_receive_associated_v2(struct np_frame *initial, uint64_t *cold, uint64_t *last) {
  struct np_startup_associated memo; struct stat s; struct ucred peer; socklen_t size = sizeof peer; int type, domain;
  socklen_t length = sizeof type;
  if (getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_SEQPACKET) return -1;
  length = sizeof domain;
  if (getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_DOMAIN, &domain, &length) || domain != AF_UNIX || getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof peer || peer.pid != getppid() || peer.uid || peer.gid) return -1;
  if (fstat(7, &s) || !S_ISREG(s.st_mode) || s.st_uid || s.st_gid || s.st_nlink || s.st_size != (off_t)sizeof memo || fcntl(7, F_GET_SEALS) != NP_STARTUP_SEALS || pread(7, &memo, sizeof memo, 0) != (ssize_t)sizeof memo || memo.magic != NP_ASSOCIATED_MAGIC || !memo.generation || memo.issuer != peer.pid || memo.anchor > INT64_MAX - 180 * UINT64_C(1000000000) || memo.cold_end <= memo.anchor || memo.cold_end > memo.anchor + NP_COLD || memo.cold_end > memo.preparation_end || memo.preparation_end < memo.anchor || memo.preparation_end > memo.anchor + 120 * UINT64_C(1000000000) || memo.preparation_end > memo.cleanup_end || memo.cleanup_end > memo.anchor + 180 * UINT64_C(1000000000)) return -1;
  uint64_t high_water = memo.anchor;
  for (;;) {
    struct timespec ts; if (clock_gettime(CLOCK_MONOTONIC, &ts) || ts.tv_sec < 0 || ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000L || (uint64_t)ts.tv_sec > INT64_MAX / UINT64_C(1000000000)) return -1;
    uint64_t now = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
    if (now < high_water || now >= memo.cold_end || getppid() != peer.pid) return -1;
    high_water = now;
    ssize_t n = recv(NP_ENDPOINT, initial, sizeof *initial, MSG_DONTWAIT | MSG_TRUNC);
    if (n >= 0) { if (n != (ssize_t)sizeof *initial || initial->generation != memo.generation) return -1; break; }
    if (errno != EAGAIN && errno != EINTR && errno != EWOULDBLOCK) return -1;
    struct pollfd p = { .fd = NP_ENDPOINT, .events = POLLIN | POLLHUP };
    if (poll(&p, 1, (int)((memo.cold_end-now+999999)/1000000)) < 0 && errno != EINTR) return -1;
    if (p.revents & (POLLHUP | POLLERR | POLLNVAL)) return -1;
  }
  if (associated_sample(memo.cold_end, &high_water) || getppid() != peer.pid) return -1;
  *cold = memo.cold_end; *last = high_water; return 0;
}
int np_original_helper_start_associated_v2(uint64_t *generation) {
  if (!generation || helper.sealed || helper.lost) return -1;
  helper.lost = true;
  struct np_frame initial; uint64_t cold, high_water;
  if (startup_receive_associated_v2(&initial, &cold, &high_water) || initial.magic != NP_FRAME_MAGIC || initial.version != 1 || initial.kind != NP_HELLO || initial.sequence || initial.slot || initial.result) return -1;
  helper.pid = getpid(); helper.parent = getppid(); helper.generation = initial.generation;
  if (close(5) || close(6) || close(7) || associated_sample(cold, &high_water) || getppid() != helper.parent || np_helper_seal_v1() || associated_sample(cold, &high_water) || getppid() != helper.parent) return -1;
  helper.sealed = true; helper.lost = false;
  if (np_original_helper_message_v1(NP_HELLO)) return -1;
  *generation = helper.generation; return 0;
}
#endif
