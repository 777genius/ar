#define _GNU_SOURCE
#include "native-root-control.h"
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
_Static_assert(sizeof NP_ROOT_SOCKET <= sizeof ((struct sockaddr_un *)0)->sun_path, "fixed DATA socket path exceeds AF_UNIX capacity");
static uint64_t high_water, end;
static int remaining(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t) || t.tv_sec < 0 || t.tv_nsec < 0 || t.tv_nsec >= 1000000000L || (uint64_t)t.tv_sec > INT64_MAX / UINT64_C(1000000000)) return -1;
  uint64_t now = (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
  if (now < high_water || now >= end) { errno = ETIMEDOUT; return -1; }
  high_water = now; return (int)((end - now + UINT64_C(999999)) / UINT64_C(1000000));
}
static int ready(int fd, short events) {
  for (;;) {
    int timeout = remaining(); if (timeout < 0) return -1;
    struct pollfd p = { .fd = fd, .events = events }; int result = poll(&p, 1, timeout);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0 || (p.revents & (POLLERR | POLLNVAL)) || !(p.revents & (events | (events == POLLIN ? POLLHUP : 0))) || remaining() < 0) return -1;
    return 0;
  }
}
int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1 || getuid() || geteuid() || getgid() || getegid()) return 77;
  for (int stream = 0; stream <= 1; stream++) { int flags = fcntl(stream, F_GETFL); if (flags < 0 || fcntl(stream, F_SETFL, flags | O_NONBLOCK)) return 77; }
  struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t) || t.tv_sec < 0 || (uint64_t)t.tv_sec > (INT64_MAX - UINT64_C(2000000000)) / UINT64_C(1000000000)) return 77;
  high_water = (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
  if (t.tv_nsec < 0 || t.tv_nsec >= 1000000000L || high_water > INT64_MAX - UINT64_C(2000000000)) return 77;
  end = high_water + UINT64_C(2000000000);
  unsigned char request[150], response[NP_ROOT_WIRE_MAX]; size_t used = 0;
  for (;;) {
    if (used == sizeof request || ready(STDIN_FILENO, POLLIN)) return 77;
    ssize_t n = read(STDIN_FILENO, request + used, sizeof request - used);
    if (n < 0) { if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) continue; return 77; }
    if (!n) break;
    used += (size_t)n;
  }
  struct np_root_request_v3 decoded; if (np_root_request_decode_v3(request, used, &decoded)) return 77;
  struct np_directory directory; if (np_directory_pin_v1(&directory, NP_ROOT_DIRECTORY)) return 77;
  int parent = np_directory_fd_v1(&directory); struct stat before, after;
  if (fstatat(parent, "control.sock", &before, AT_SYMLINK_NOFOLLOW) || !S_ISSOCK(before.st_mode) || before.st_uid || before.st_gid || (before.st_mode & 0777) != 0600) return 77;
  int fd = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_NONBLOCK | SOCK_CLOEXEC, 0); if (fd < 0) return 77;
  struct sockaddr_un address = { .sun_family = AF_UNIX }; memcpy(address.sun_path, NP_ROOT_SOCKET, sizeof NP_ROOT_SOCKET);
  int pass = 1;
  if (setsockopt(fd, SOL_SOCKET, SO_PASSCRED, &pass, sizeof pass) || np_directory_check_v1(&directory) || remaining() < 0 || connect(fd, (struct sockaddr *)&address, sizeof address)) return 77;
  struct ucred peer; socklen_t size = sizeof peer;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof peer || peer.uid || peer.gid || peer.pid <= 0 || fstatat(parent, "control.sock", &after, AT_SYMLINK_NOFOLLOW) || before.st_dev != after.st_dev || before.st_ino != after.st_ino || !S_ISSOCK(after.st_mode) || after.st_uid || after.st_gid || (after.st_mode & 0777) != 0600 || np_directory_check_v1(&directory) || remaining() < 0 || send(fd, request, used, MSG_NOSIGNAL | MSG_DONTWAIT) != (ssize_t)used || remaining() < 0 || ready(fd, POLLIN)) return 77;
  union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(sizeof(int))]; } control;
  memset(&control, 0, sizeof control); struct iovec iov = { .iov_base = response, .iov_len = sizeof response };
  struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  ssize_t n = recvmsg(fd, &message, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
  bool authenticated = false, foreign = false;
  for (struct cmsghdr *c = CMSG_FIRSTHDR(&message); c; c = CMSG_NXTHDR(&message, c)) {
    if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS && c->cmsg_len >= CMSG_LEN(0)) { size_t count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int); int *rights = (int *)CMSG_DATA(c); for (size_t i = 0; i < count; i++) close(rights[i]); foreign = true; }
    else if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_CREDENTIALS && c->cmsg_len == CMSG_LEN(sizeof(struct ucred)) && !authenticated) { struct ucred actual; memcpy(&actual, CMSG_DATA(c), sizeof actual); authenticated = actual.pid == peer.pid && !actual.uid && !actual.gid; if (!authenticated) foreign = true; }
    else foreign = true;
  }
  if (n < 0 || message.msg_flags & (MSG_TRUNC | MSG_CTRUNC) || !authenticated || foreign || remaining() < 0 || np_root_response_check_v3(response, (size_t)n, &decoded)) return 77;
  // Normal client EOF releases DATA transport only, never the helper NP_CLOSE.
  close(fd); np_directory_release_v1(&directory);
  size_t sent = 0; while (sent < (size_t)n) { if (remaining() < 0 || ready(STDOUT_FILENO, POLLOUT)) return 77; ssize_t count = write(STDOUT_FILENO, response + sent, (size_t)n - sent); if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue; if (count <= 0) return 77; sent += (size_t)count; if (remaining() < 0) return 77; }
  return remaining() < 0 ? 77 : 0;
}
