#define _GNU_SOURCE
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
static int protected_directory(int fd) {
  struct stat s;
  if (fstat(fd, &s)) return -1;
  if (!S_ISDIR(s.st_mode) || s.st_uid != 0 || (s.st_mode & 0022)) { errno = EPERM; return -1; } return 0;
}
int np_directory_fd_v1(const struct np_directory *directory) {
  if (!directory->count) { errno = EBADF; return -1; } return directory->fds[directory->count - 1];
}
int np_directory_pin_v1(struct np_directory *directory, const char *path) {
  memset(directory, 0, sizeof *directory);
  if (!path || path[0] != '/' || strlen(path) >= 4096) { errno = EINVAL; return -1; }
  int root = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root < 0) return -1;
  directory->fds[directory->count++] = root;
  if (protected_directory(root)) goto fail;
  const char *p = path + 1;
  while (*p) {
    const char *slash = strchr(p, '/'); size_t length = slash ? (size_t)(slash - p) : strlen(p);
    if (!length || length > 255 || directory->count == NP_ANCESTORS || (length == 1 && p[0] == '.') || (length == 2 && p[0] == '.' && p[1] == '.')) { errno = EINVAL; goto fail; }
    size_t index = directory->count; memcpy(directory->names[index], p, length); directory->names[index][length] = 0;
    int fd = openat(np_directory_fd_v1(directory), directory->names[index], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) goto fail;
    directory->fds[directory->count++] = fd;
    if (protected_directory(fd)) goto fail;
    if (!slash) break;
    p = slash + 1;
  if (!*p) { errno = EINVAL; goto fail; }
  }
  return np_directory_check_v1(directory);
fail: { int saved = errno; np_directory_release_v1(directory); errno = saved; return -1; }
}
int np_directory_check_v1(const struct np_directory *directory) {
  if (!directory->count) { errno = EBADF; return -1; }
  for (size_t i = 0; i < directory->count; i++) {
    struct stat held, named;
    if (protected_directory(directory->fds[i]) || fstat(directory->fds[i], &held)) return -1;
    if (i && (fstatat(directory->fds[i - 1], directory->names[i], &named, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(named.st_mode) || named.st_dev != held.st_dev || named.st_ino != held.st_ino)) { errno = ESTALE; return -1; }
  }
  return 0;
}
void np_directory_release_v1(struct np_directory *directory) {
  for (size_t i = 0; i < directory->count; i++) close(directory->fds[i]);
  directory->count = 0;
}
static int same_identity(struct np_publication *publication, int parent, const char *name) {
  struct stat held, named;
  if (publication->file < 0 || fstat(publication->file, &held) || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW)) return -1;
  if (!S_ISREG(held.st_mode) || !S_ISREG(named.st_mode) || held.st_nlink != 1 || named.st_nlink != 1 || held.st_dev != publication->device || held.st_ino != publication->inode || held.st_dev != named.st_dev || held.st_ino != named.st_ino || held.st_uid != 0 || held.st_gid != 0 || (held.st_mode & 07777) != 0644 || held.st_size != (off_t)publication->length) { errno = ESTALE; return -1; }
  char actual[513]; ssize_t n = pread(publication->file, actual, sizeof actual, 0);
  if (n != (ssize_t)publication->length || memcmp(actual, publication->bytes, publication->length)) { errno = ESTALE; return -1; } return 0;
}
int np_fragment_init_v1(struct np_publication *publication, struct np_directory *staging, struct np_directory *final, const char locator[65]) {
  memset(publication, 0, sizeof *publication); publication->file = -1;
  if (!locator || strlen(locator) != 64 || strspn(locator, "0123456789abcdef") != 64 || np_directory_check_v1(staging) || np_directory_check_v1(final)) { errno = EINVAL; return -1; }
  struct stat s, f;
  if (fstat(np_directory_fd_v1(staging), &s) || fstat(np_directory_fd_v1(final), &f)) return -1;
  if (s.st_dev != f.st_dev || s.st_ino == f.st_ino) { errno = EXDEV; return -1; }
  publication->staging = staging; publication->final = final;
  int a = snprintf(publication->staged_name, sizeof publication->staged_name, ".native-probe-%s.stage", locator);
  int b = snprintf(publication->final_name, sizeof publication->final_name, "subscription-runtime-retain-%s.target", locator);
  int n = snprintf(publication->bytes, sizeof publication->bytes, "[Unit]\nDescription=Subscription Runtime retained resource\nDefaultDependencies=no\nRequires=subscription-runtime-hosted-%s.slice\nAfter=subscription-runtime-hosted-%s.slice\nStopWhenUnneeded=no\n", locator, locator);
  if (a < 0 || (size_t)a >= sizeof publication->staged_name || b < 0 || (size_t)b >= sizeof publication->final_name || n < 0 || (size_t)n >= sizeof publication->bytes) { errno = EOVERFLOW; return -1; }
  publication->length = (size_t)n; return 0;
}
static int check(struct np_publication *publication, struct np_gate *gate) {
  return np_gate_check_v1(gate) || np_directory_check_v1(publication->staging) || np_directory_check_v1(publication->final) ? -1 : 0;
}
static int sync_ancestors(const struct np_directory *directory, struct np_gate *gate) {
  for (size_t i = directory->count; i > 0; i--) if (np_gate_check_v1(gate) || np_directory_check_v1(directory) || fsync(directory->fds[i - 1])) return -1;
  return 0;
}
int np_fragment_publish_v1(struct np_publication *publication, struct np_gate *gate) {
  if (publication->attempted || publication->file >= 0) { errno = EALREADY; return -1; }
  publication->attempted = true;
  if (check(publication, gate)) goto fail;
  int source = np_directory_fd_v1(publication->staging), destination = np_directory_fd_v1(publication->final);
  struct stat final;
  if (fstatat(destination, publication->final_name, &final, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) { errno = EEXIST; goto fail; }
  if (check(publication, gate)) goto fail;
  publication->file = openat(source, publication->staged_name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (publication->file < 0) goto fail;
  publication->stage = NP_FILE_CREATED;
  struct stat inode;
  if (fstat(publication->file, &inode)) goto fail;
  publication->device = inode.st_dev; publication->inode = inode.st_ino;
  size_t written = 0;
  while (written < publication->length) {
    if (check(publication, gate)) goto fail;
    ssize_t n = write(publication->file, publication->bytes + written, publication->length - written);
    if (n <= 0) goto fail;
    written += (size_t)n;
  }
  publication->stage = NP_FILE_WRITTEN;
  if (check(publication, gate) || fchown(publication->file, 0, 0) || check(publication, gate) || fchmod(publication->file, 0644) || check(publication, gate) || fsync(publication->file)) goto fail;
  publication->stage = NP_FILE_SYNCED;
  if (sync_ancestors(publication->staging, gate)) goto fail;
  publication->stage = NP_STAGE_SYNCED;
  if (same_identity(publication, source, publication->staged_name) || check(publication, gate)) goto fail;
  if (syscall(SYS_renameat2, source, publication->staged_name, destination, publication->final_name, RENAME_NOREPLACE)) goto fail;
  publication->stage = NP_RENAMED;
  if (sync_ancestors(publication->final, gate)) goto fail;
  publication->stage = NP_FINAL_SYNCED;
  if (sync_ancestors(publication->staging, gate)) goto fail;
  publication->stage = NP_PARENTS_SYNCED;
  if (check(publication, gate) || np_fragment_verify_v1(publication) || np_gate_check_v1(gate)) goto fail;
  publication->stage = NP_FILE_VERIFIED; return 0;
fail: publication->uncertain = true; return -1;
}
int np_fragment_verify_v1(struct np_publication *publication) {
  if (np_directory_check_v1(publication->staging) || np_directory_check_v1(publication->final) || same_identity(publication, np_directory_fd_v1(publication->final), publication->final_name)) { publication->uncertain = true; return -1; } return 0;
}
void np_publication_release_v1(struct np_publication *publication) {
  // Release is owner disposal only. Failed constructors and helper cleanup never
  // call this to hide an already acquired original inode or its prefix.
  if (publication->file >= 0) close(publication->file);
  publication->file = -1;
}
