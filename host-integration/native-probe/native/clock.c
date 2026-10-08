#define _GNU_SOURCE
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/nsfs.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
static int ns_open(pid_t pid, const char *kind) {
  char path[96]; int n = snprintf(path, sizeof path, "/proc/%ld/ns/%s", (long)pid, kind);
  if (n <= 0 || (size_t)n >= sizeof path) { errno = EINVAL; return -1; }
  return open(path, O_RDONLY | O_CLOEXEC);
}
static int ns_equal(int a, int b, int type) {
  struct stat x, y;
  if (a < 0 || b < 0 || fstat(a, &x) || fstat(b, &y) || ioctl(a, NS_GET_NSTYPE) != type || ioctl(b, NS_GET_NSTYPE) != type) return -1;
  if (x.st_dev != y.st_dev || x.st_ino != y.st_ino) { errno = EXDEV; return -1; }
  return 0;
}
static int native_now(uint64_t *out) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) || ts.tv_sec < 0 || ts.tv_nsec < 0 || ts.tv_nsec >= 1000000000L || (uint64_t)ts.tv_sec > INT64_MAX / UINT64_C(1000000000)) { errno = EOVERFLOW; return -1; }
  *out = (uint64_t)ts.tv_sec * UINT64_C(1000000000) + (uint64_t)ts.tv_nsec;
  if (*out > INT64_MAX) { errno = EOVERFLOW; return -1; }
  return 0;
}
int np_clock_pin_v1(struct np_clock *clock) {
  memset(clock, 0, sizeof *clock); clock->time = clock->children = clock->mount = -1;
  clock->time = ns_open(getpid(), "time"); clock->children = ns_open(getpid(), "time_for_children"); clock->mount = ns_open(getpid(), "mnt");
  if (ns_equal(clock->time, clock->children, CLONE_NEWTIME) || clock->mount < 0 || native_now(&clock->anchor) || clock->anchor > INT64_MAX - UINT64_C(180000000000)) { clock->lost = true; np_clock_release_v1(clock); return -1; }
  clock->preparation_end = clock->anchor + UINT64_C(120000000000); clock->cleanup_end = clock->anchor + UINT64_C(180000000000); clock->high_water = clock->anchor; return 0;
}
int np_clock_check_v1(struct np_clock *clock) {
  if (clock->lost) { errno = ESTALE; return -1; }
  int a = ns_open(getpid(), "time"), b = ns_open(getpid(), "time_for_children"), m = ns_open(getpid(), "mnt");
  int result = ns_equal(a, clock->time, CLONE_NEWTIME) || ns_equal(b, clock->time, CLONE_NEWTIME) || ns_equal(m, clock->mount, CLONE_NEWNS) ? -1 : 0;
  if (a >= 0) close(a);
  if (b >= 0) close(b);
  if (m >= 0) close(m);
  if (result) clock->lost = true;
  return result;
}
int np_clock_sample_v1(struct np_clock *clock, uint64_t *out) {
  uint64_t now;
  if (np_clock_check_v1(clock) || native_now(&now) || now < clock->high_water) { clock->lost = true; errno = ESTALE; return -1; }
  clock->high_water = now; *out = now; return 0;
}
void np_clock_release_v1(struct np_clock *clock) {
  if (clock->time >= 0) close(clock->time);
  if (clock->children >= 0) close(clock->children);
  if (clock->mount >= 0) close(clock->mount);
  clock->time = clock->children = clock->mount = -1; clock->lost = true;
}
int np_birth_live_v1(const struct np_birth *birth) {
  struct pollfd p = { .fd = birth->pidfd, .events = POLLIN };
  if (birth->pidfd < 0 || poll(&p, 1, 0) != 0) { errno = ESRCH; return -1; } return 0;
}
int np_birth_pin_v1(struct np_birth *birth, pid_t pid, uid_t uid, gid_t gid) {
  memset(birth, 0, sizeof *birth); birth->pidfd = birth->time = birth->children = -1;
  if (pid <= 0) { errno = EINVAL; return -1; }
  birth->pid = pid; birth->uid = uid; birth->gid = gid;
  birth->pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
  birth->time = ns_open(pid, "time"); birth->children = ns_open(pid, "time_for_children");
  if (np_birth_live_v1(birth) || ns_equal(birth->time, birth->children, CLONE_NEWTIME)) { np_birth_release_v1(birth); return -1; }
  return 0;
}
int np_birth_associate_v1(const struct np_clock *clock, const struct np_birth *birth) {
  if (clock->lost || np_birth_live_v1(birth) || ns_equal(clock->time, birth->time, CLONE_NEWTIME) || ns_equal(clock->time, birth->children, CLONE_NEWTIME)) { errno = ESTALE; return -1; }
  int a = ns_open(birth->pid, "time"), b = ns_open(birth->pid, "time_for_children");
  int result = ns_equal(a, birth->time, CLONE_NEWTIME) || ns_equal(b, birth->children, CLONE_NEWTIME) || np_birth_live_v1(birth) ? -1 : 0;
  if (a >= 0) close(a);
  if (b >= 0) close(b);
  return result;
}
void np_birth_release_v1(struct np_birth *birth) {
  if (birth->pidfd >= 0) close(birth->pidfd);
  if (birth->time >= 0) close(birth->time);
  if (birth->children >= 0) close(birth->children);
  birth->pidfd = birth->time = birth->children = -1;
}
int np_gate_check_v1(struct np_gate *gate) {
  uint64_t now;
  if (!gate || !gate->clock || gate->closed || np_clock_sample_v1(gate->clock, &now) || gate->cutoff > gate->clock->preparation_end || now >= gate->cutoff) { if (gate) gate->closed = true; errno = ETIMEDOUT; return -1; }
  return 0;
}
