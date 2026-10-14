#define _GNU_SOURCE
#include "resources.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/magic.h>
#include <linux/nsfs.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>
static const char *const parents[] = { "subscription.slice", "subscription-runtime.slice", "subscription-runtime-hosted.slice" };
static int cgroup(int fd, struct stat *stat) {
  struct statfs fs;
  if (fstat(fd, stat) || fstatfs(fd, &fs)) return -1;
  if (!S_ISDIR(stat->st_mode) || stat->st_uid != 0 || (stat->st_mode & 0022) || fs.f_type != CGROUP2_SUPER_MAGIC) { errno = EPERM; return -1; }
  return 0;
}
static int content(int parent, const char *name, char *bytes, size_t capacity) {
  int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat held, named; struct statfs fs;
  int result = -1;
  if (fstat(fd, &held) || fstatfs(fd, &fs) || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW)) goto out;
  if (!S_ISREG(held.st_mode) || held.st_dev != named.st_dev || held.st_ino != named.st_ino || fs.f_type != CGROUP2_SUPER_MAGIC) { errno = ESTALE; goto out; }
  ssize_t n = read(fd, bytes, capacity);
  if (n < 0 || (size_t)n >= capacity) { errno = EOVERFLOW; goto out; }
  bytes[n] = 0; result = 0;
out: { int error = errno; close(fd); errno = error; return result; }
}
static int cpu_enabled(int fd) {
  char bytes[4096];
  if (content(fd, "cgroup.type", bytes, sizeof bytes) || strcmp(bytes, "domain\n")) { errno = EPERM; return -1; }
  if (content(fd, "cgroup.procs", bytes, sizeof bytes) || *bytes) { errno = EBUSY; return -1; }
  if (content(fd, "cgroup.controllers", bytes, sizeof bytes)) return -1;
  bool cpu = false; char *save = NULL;
  for (char *p = strtok_r(bytes, " \n", &save); p; p = strtok_r(NULL, " \n", &save)) if (!strcmp(p, "cpu")) cpu = true;
  if (!cpu || content(fd, "cgroup.subtree_control", bytes, sizeof bytes)) { errno = ENODEV; return -1; }
  cpu = false; save = NULL;
  for (char *p = strtok_r(bytes, " \n", &save); p; p = strtok_r(NULL, " \n", &save)) if (!strcmp(p, "cpu")) cpu = true;
  if (!cpu) { errno = ENODEV; return -1; } return 0;
}
static int namespace_current(int retained, const char *path, int type) {
  int current = open(path, O_RDONLY | O_CLOEXEC); struct stat held, actual;
  if (current < 0) return -1;
  int result = fstat(retained, &held) || fstat(current, &actual) || ioctl(retained, NS_GET_NSTYPE) != type || ioctl(current, NS_GET_NSTYPE) != type || held.st_dev != actual.st_dev || held.st_ino != actual.st_ino ? -1 : 0;
  int error = errno; close(current); errno = error; return result;
}
int np_resource_view_pin_v1(struct np_resource_view *view, int original) {
  memset(view, 0, sizeof *view); view->original_delegation = view->mount_namespace = view->cgroup_namespace = -1;
  struct stat origin, local;
  if (original < 0 || cgroup(original, &origin) || np_directory_pin_v1(&view->root, "/sys/fs/cgroup")) return -1;
  if (cgroup(np_directory_fd_v1(&view->root), &local) || origin.st_dev != local.st_dev || origin.st_ino != local.st_ino) { view->lost = true; errno = EXDEV; return -1; }
  view->original_delegation = fcntl(original, F_DUPFD_CLOEXEC, 4);
  if (view->original_delegation < 0) { view->lost = true; return -1; }
  view->mount_namespace = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  view->cgroup_namespace = open("/proc/self/ns/cgroup", O_RDONLY | O_CLOEXEC);
  if (view->mount_namespace < 0 || view->cgroup_namespace < 0) { view->lost = true; return -1; }
  view->device = origin.st_dev; view->inode = origin.st_ino;
  return np_resource_view_check_v1(view);
}
int np_resource_view_check_v1(struct np_resource_view *view) {
  struct stat original, local;
  if (view->lost || namespace_current(view->mount_namespace, "/proc/self/ns/mnt", CLONE_NEWNS) || namespace_current(view->cgroup_namespace, "/proc/self/ns/cgroup", CLONE_NEWCGROUP) || np_directory_check_v1(&view->root) || cgroup(view->original_delegation, &original) || cgroup(np_directory_fd_v1(&view->root), &local) || original.st_dev != view->device || original.st_ino != view->inode || local.st_dev != view->device || local.st_ino != view->inode || cpu_enabled(np_directory_fd_v1(&view->root))) { view->lost = true; errno = ESTALE; return -1; }
  return 0;
}
int np_resource_pair_init_v1(struct np_resource_pair *pair, struct np_resource_view *view, const char locator[65]) {
  memset(pair, 0, sizeof *pair); pair->directory = pair->events = -1;
  for (size_t i = 0; i < 3; i++) pair->ancestors[i] = -1;
  pair->view = view;
  if (!locator || strlen(locator) != 64 || strspn(locator, "0123456789abcdef") != 64) { errno = EINVAL; return -1; }
  int n = snprintf(pair->slice, sizeof pair->slice, "subscription-runtime-hosted-%s.slice", locator);
  if (n < 0 || (size_t)n >= sizeof pair->slice) { errno = EOVERFLOW; return -1; } return 0;
}
static int named_directory(int parent, const char *name, int held, dev_t device, ino_t expected) {
  struct stat actual, named;
  if (cgroup(held, &actual) || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW)) return -1;
  if (!S_ISDIR(named.st_mode) || actual.st_dev != device || actual.st_dev != named.st_dev || actual.st_ino != named.st_ino || (expected && actual.st_ino != expected)) { errno = ESTALE; return -1; } return 0;
}
static int ancestors(struct np_resource_pair *pair) {
  if (np_resource_view_check_v1(pair->view)) return -1;
  int parent = np_directory_fd_v1(&pair->view->root);
  for (size_t i = 0; i < 3; i++) {
    if (pair->ancestors[i] < 0) break;
    if (named_directory(parent, parents[i], pair->ancestors[i], pair->view->device, 0) || cpu_enabled(pair->ancestors[i])) return -1;
    parent = pair->ancestors[i];
  }
  return 0;
}
int np_resource_pair_acquire_v1(struct np_resource_pair *pair, struct np_gate *gate) {
  if (pair->attempted) { errno = EALREADY; return -1; }
  pair->attempted = true;
  if (np_gate_check_v1(gate) || np_resource_view_check_v1(pair->view)) goto fail;
  int parent = np_directory_fd_v1(&pair->view->root);
  for (size_t i = 0; i < 3; i++) {
    if (np_gate_check_v1(gate) || ancestors(pair)) goto fail;
    pair->ancestors[i] = openat(parent, parents[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (pair->ancestors[i] < 0 || ancestors(pair) || np_gate_check_v1(gate)) goto fail;
    parent = pair->ancestors[i];
  }
  if (np_gate_check_v1(gate) || ancestors(pair)) goto fail;
  pair->directory = openat(parent, pair->slice, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (pair->directory < 0) goto fail;
  pair->directory_state = NP_RETAINED;
  struct stat directory;
  if (cgroup(pair->directory, &directory)) goto fail;
  pair->device = directory.st_dev; pair->directory_inode = directory.st_ino;
  if (named_directory(parent, pair->slice, pair->directory, pair->view->device, pair->directory_inode) || np_gate_check_v1(gate) || ancestors(pair)) goto fail;
  pair->events = openat(pair->directory, "cgroup.events", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (pair->events < 0) goto fail;
  pair->events_state = NP_RETAINED;
  struct stat events;
  if (fstat(pair->events, &events)) goto fail;
  pair->events_inode = events.st_ino;
  if (np_resource_pair_check_v1(pair) || np_gate_check_v1(gate)) goto fail;
  return 0;
fail: pair->uncertain = true; return -1;
}
int np_resource_pair_check_v1(struct np_resource_pair *pair) {
  char weight[32]; struct stat held, named; struct statfs fs;
  if (pair->directory_state != NP_RETAINED) { errno = ENODATA; return -1; }
  if (ancestors(pair) || named_directory(pair->ancestors[2], pair->slice, pair->directory, pair->device, pair->directory_inode)) {
    pair->directory_state = NP_ACQUIRED_LOST;
    if (pair->events_state == NP_RETAINED) pair->events_state = NP_ACQUIRED_LOST;
    pair->uncertain = true; errno = ESTALE; return -1;
  }
  if (content(pair->directory, "cpu.weight", weight, sizeof weight) || strcmp(weight, "100\n")) { pair->uncertain = true; errno = ESTALE; return -1; }
  /* A never-acquired companion never disposes the directory or changes its
   * retained identity. Companion loss is independent of directory loss. */
  if (pair->events_state != NP_RETAINED) { errno = ENODATA; return -1; }
  if (fstat(pair->events, &held) || fstatfs(pair->events, &fs) || fstatat(pair->directory, "cgroup.events", &named, AT_SYMLINK_NOFOLLOW) || !S_ISREG(held.st_mode) || held.st_dev != pair->device || held.st_ino != pair->events_inode || held.st_dev != named.st_dev || held.st_ino != named.st_ino || fs.f_type != CGROUP2_SUPER_MAGIC) {
    pair->events_state = NP_ACQUIRED_LOST; pair->uncertain = true; errno = ESTALE; return -1;
  }
  return 0;
}
void np_resource_pair_release_v1(struct np_resource_pair *pair) {
  for (size_t i = 0; i < 3; i++) if (pair->ancestors[i] >= 0) close(pair->ancestors[i]);
  if (pair->directory >= 0) { close(pair->directory); pair->directory_state = NP_ACQUIRED_LOST; }
  if (pair->events >= 0) { close(pair->events); pair->events_state = NP_ACQUIRED_LOST; }
  pair->directory = pair->events = -1;
  for (size_t i = 0; i < 3; i++) pair->ancestors[i] = -1;
}
void np_resource_view_release_v1(struct np_resource_view *view) {
  if (view->original_delegation >= 0) close(view->original_delegation);
  if (view->mount_namespace >= 0) close(view->mount_namespace);
  if (view->cgroup_namespace >= 0) close(view->cgroup_namespace);
  view->original_delegation = view->mount_namespace = view->cgroup_namespace = -1; np_directory_release_v1(&view->root); view->lost = true;
}
