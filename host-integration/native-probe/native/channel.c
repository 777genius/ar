#define _GNU_SOURCE
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
_Static_assert(sizeof(struct np_frame) == 32, "NativeProbe frame ABI");
int np_channel_create_v1(struct np_channel *channel, uint64_t generation) {
  memset(channel, 0, sizeof *channel); channel->owner = channel->helper = -1;
  channel->birth.pidfd = channel->birth.time = channel->birth.children = -1;
  if (!generation) { errno = EINVAL; return -1; }
  int pair[2], enabled = 1;
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair)) return -1;
  channel->owner = pair[0]; channel->helper = pair[1]; channel->generation = generation;
  if (setsockopt(channel->owner, SOL_SOCKET, SO_PASSCRED, &enabled, sizeof enabled)) { np_channel_release_v1(channel); return -1; }
  return 0;
}
int np_channel_parent_bind_v1(struct np_channel *channel, pid_t pid, uid_t uid, gid_t gid) {
  if (channel->bound || channel->helper < 0 || channel->owner < 0 || channel->lost) { errno = EALREADY; return -1; }
  close(channel->helper); channel->helper = -1;
  if (np_birth_pin_v1(&channel->birth, pid, uid, gid)) { channel->lost = true; return -1; }
  channel->bound = true; return 0;
}
int np_channel_child_inherit_v1(struct np_channel *channel) {
  if (channel->helper < 0 || channel->owner < 0) { errno = EINVAL; return -1; }
  close(channel->owner); channel->owner = -1;
  if (channel->helper != NP_ENDPOINT && dup3(channel->helper, NP_ENDPOINT, 0) < 0) return -1;
  if (channel->helper != NP_ENDPOINT) close(channel->helper);
  channel->helper = NP_ENDPOINT;
  if (fcntl(NP_ENDPOINT, F_SETFD, 0) || syscall(SYS_close_range, 4U, UINT_MAX, 0)) return -1;
  return 0;
}
static bool kind_allowed(uint16_t kind) { return kind >= NP_HELLO && kind <= NP_CLOSE; }
int np_channel_receive_v1(struct np_channel *channel, struct np_frame *frame) {
  if (!channel->bound || channel->lost || np_birth_live_v1(&channel->birth)) { channel->lost = true; errno = ESTALE; return -1; }
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(16 * sizeof(int))]; } control;
  memset(&control, 0, sizeof control); memset(frame, 0, sizeof *frame);
  struct iovec iov = { .iov_base = frame, .iov_len = sizeof *frame };
  struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  ssize_t length = recvmsg(channel->owner, &msg, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
  if (length < 0 && (errno == EAGAIN || errno == EINTR)) return -1;
  bool invalid = length != (ssize_t)sizeof *frame || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)); unsigned credentials = 0;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
      if (c->cmsg_len >= CMSG_LEN(0)) {
        size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *fds = (int *)CMSG_DATA(c);
        for (size_t i = 0; i < count; i++) close(fds[i]);
      }
      invalid = true;
    } else if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_CREDENTIALS && c->cmsg_len == CMSG_LEN(sizeof(struct ucred))) {
      struct ucred credential; memcpy(&credential, CMSG_DATA(c), sizeof credential); credentials++;
      if (credential.pid != channel->birth.pid || credential.uid != channel->birth.uid || credential.gid != channel->birth.gid) invalid = true;
    } else invalid = true;
  }
  if (credentials != 1 || frame->magic != NP_FRAME_MAGIC || frame->version != 1 || frame->generation != channel->generation || !kind_allowed(frame->kind) || channel->sequence == UINT64_MAX || frame->sequence != channel->sequence + 1 || np_birth_live_v1(&channel->birth)) invalid = true;
  if (invalid) { channel->lost = true; errno = EPROTO; return -1; }
  channel->sequence = frame->sequence; return 0;
}
int np_channel_send_pair_v1(struct np_channel *channel, const struct np_frame *frame, const int pair[2]) {
  if (!channel->bound || channel->lost || np_birth_live_v1(&channel->birth) || frame->kind != NP_RESOURCE_PAIR || frame->magic != NP_FRAME_MAGIC || frame->version != 1 || frame->generation != channel->generation || pair[0] < 0 || pair[1] < 0) { errno = ESTALE; return -1; }
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(2 * sizeof(int))]; } control;
  memset(&control, 0, sizeof control);
  struct iovec iov = { .iov_base = (void *)frame, .iov_len = sizeof *frame };
  struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(2 * sizeof(int)); memcpy(CMSG_DATA(c), pair, 2 * sizeof(int));
  ssize_t n = sendmsg(channel->owner, &msg, MSG_NOSIGNAL | MSG_DONTWAIT);
  if (n != (ssize_t)sizeof *frame) { channel->lost = true; return -1; } return 0;
}
void np_channel_release_v1(struct np_channel *channel) {
  if (channel->owner >= 0) close(channel->owner);
  if (channel->helper >= 0) close(channel->helper);
  channel->owner = channel->helper = -1; channel->lost = true; np_birth_release_v1(&channel->birth);
}
