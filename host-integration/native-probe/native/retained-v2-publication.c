#define _GNU_SOURCE
#include "retained-v2.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/if_alg.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
/* Fixed local kernel hash operation, not a network or external crypto command.
 * This newly pinned profile requires AF_ALG sha256 in its physical qualification. */
int np_v2_hash(const void *bytes, size_t length, char out[65]) {
  if (!bytes || !length || length > NP_ORIGIN_PHASE_MAX) { errno = EINVAL; return -1; }
  int algorithm = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0), operation = -1;
  struct sockaddr_alg address = { .salg_family = AF_ALG };
  memcpy(address.salg_type, "hash", 5); memcpy(address.salg_name, "sha256", 7);
  int result = -1;
  unsigned char digest[32];
  if (algorithm < 0 || bind(algorithm, (struct sockaddr *)&address, sizeof address)) goto done;
  operation = accept4(algorithm, NULL, NULL, SOCK_CLOEXEC);
  if (operation < 0 || send(operation, bytes, length, MSG_NOSIGNAL) != (ssize_t)length || read(operation, digest, sizeof digest) != (ssize_t)sizeof digest) goto done;
  for (size_t i = 0; i < sizeof digest; i++) (void)snprintf(out + 2*i, 3, "%02x", digest[i]);
  out[64] = 0; result = 0;
done: { int error = errno; if (operation >= 0) close(operation); if (algorithm >= 0) close(algorithm); errno = error; return result; }
}
static int private_parents(const struct np_directory *parents) {
  struct stat leaf;
  if (np_directory_check_v1(parents) || fstat(np_directory_fd_v1(parents), &leaf) || leaf.st_uid || leaf.st_gid || (leaf.st_mode & 07777) != 0700) { errno = EPERM; return -1; }
  return 0;
}
int np_v2_file_reserve(struct np_v2_file *file, const char *parent, const char *digest, const char *bytes, size_t length) {
  if (!file || file->reserved || !parent || !digest || strlen(digest) != 64 || strspn(digest, "0123456789abcdef") != 64 || !bytes || !length || length >= sizeof file->bytes) { errno = EINVAL; return -1; }
  file->reserved = true; file->fd = -1; file->length = length;
  memcpy(file->bytes, bytes, length);
  (void)snprintf(file->name, sizeof file->name, "%s.json", digest);
  (void)snprintf(file->stage, sizeof file->stage, ".%s.stage", digest);
  /* Caller is the private supplier's fixed namespace switch, never a public path. */
  if (np_directory_pin_v1(&file->parents, parent) || private_parents(&file->parents)) { file->uncertain = true; return -1; }
  struct stat existing;
  if (!fstatat(np_directory_fd_v1(&file->parents), file->name, &existing, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) { file->uncertain = true; errno = EEXIST; return -1; }
  if (!fstatat(np_directory_fd_v1(&file->parents), file->stage, &existing, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) { file->uncertain = true; errno = EEXIST; return -1; }
  return 0;
}
int np_v2_file_verify(struct np_v2_file *file) {
  struct stat before, after, named;
  char bytes[NP_V2_LIMIT];
  if (!file->reserved || !file->renamed || !file->durable || file->fd < 0 || private_parents(&file->parents) || fstat(file->fd, &before) || fstatat(np_directory_fd_v1(&file->parents), file->name, &named, AT_SYMLINK_NOFOLLOW)) goto fail;
  if (!S_ISREG(before.st_mode) || !S_ISREG(named.st_mode) || before.st_uid || before.st_gid || before.st_nlink != 1 || named.st_nlink != 1 || (before.st_mode & 07777) != 0600 || before.st_dev != file->device || before.st_ino != file->inode || named.st_dev != before.st_dev || named.st_ino != before.st_ino || before.st_size != (off_t)file->length) goto fail;
  if (pread(file->fd, bytes, file->length + 1, 0) != (ssize_t)file->length || memcmp(bytes, file->bytes, file->length) || fstat(file->fd, &after) || before.st_size != after.st_size || before.st_mode != after.st_mode || before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec || before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec || private_parents(&file->parents)) goto fail;
  file->verified = true; return 0;
fail: file->uncertain = true; errno = ESTALE; return -1;
}
int np_v2_file_publish(struct np_v2_file *file, struct np_root_origin *origin) {
  if (!file->reserved || !origin || private_parents(&file->parents) || np_origin_retained_lock_v2(origin)) return -1;
  int result = -1;
  if (file->durable) { errno = EALREADY; goto done; }
  if (file->fd < 0) {
    file->fd = openat(np_directory_fd_v1(&file->parents), file->stage, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file->fd < 0) goto done;
    struct stat inode;
    if (fstat(file->fd, &inode)) goto done;
    file->device = inode.st_dev; file->inode = inode.st_ino;
  }
  /* A retained original partial inode is repaired only from the original bytes.
   * No truncate, replacement inode, restored-by-name custody or new generation. */
  struct stat held, named;
  if (fstat(file->fd, &held) || fstatat(np_directory_fd_v1(&file->parents), file->renamed ? file->name : file->stage, &named, AT_SYMLINK_NOFOLLOW) || held.st_dev != file->device || held.st_ino != file->inode || named.st_dev != held.st_dev || named.st_ino != held.st_ino || held.st_size != (off_t)file->written) goto done;
  if (file->written) {
    char actual[NP_V2_LIMIT];
    if (pread(file->fd, actual, file->written, 0) != (ssize_t)file->written || memcmp(actual, file->bytes, file->written)) goto done;
  }
  while (file->written < file->length) {
    if (np_origin_effect_check_v1(origin, false, np_origin_ends_v1(origin)->work) || private_parents(&file->parents)) goto done;
    ssize_t n = pwrite(file->fd, file->bytes + file->written, file->length - file->written, (off_t)file->written);
    if (n <= 0) goto done;
    file->written += (size_t)n;
  }
  if (np_origin_effect_check_v1(origin, false, np_origin_ends_v1(origin)->work) || fsync(file->fd)) goto done;
  for (size_t i = file->parents.count; i > 0; i--) {
    if (np_origin_effect_check_v1(origin, false, np_origin_ends_v1(origin)->work) || private_parents(&file->parents) || fsync(file->parents.fds[i-1])) goto done;
  }
  if (!file->renamed) {
    struct stat current;
    if (fstatat(np_directory_fd_v1(&file->parents), file->stage, &current, AT_SYMLINK_NOFOLLOW) || !S_ISREG(current.st_mode) || current.st_dev != file->device || current.st_ino != file->inode || current.st_uid || current.st_gid || current.st_nlink != 1 || (current.st_mode & 07777) != 0600 || current.st_size != (off_t)file->length) goto done;
    if (np_origin_effect_check_v1(origin, false, np_origin_ends_v1(origin)->work) || private_parents(&file->parents) || syscall(SYS_renameat2, np_directory_fd_v1(&file->parents), file->stage, np_directory_fd_v1(&file->parents), file->name, RENAME_NOREPLACE)) goto done;
    file->renamed = true;
  }
  for (size_t i = file->parents.count; i > 0; i--) {
    if (np_origin_effect_check_v1(origin, false, np_origin_ends_v1(origin)->work) || private_parents(&file->parents) || fsync(file->parents.fds[i-1])) goto done;
  }
  /* Durability precedes a separate final-name readback. The caller records D
   * now and records R only after np_v2_file_verify actually returns. */
  file->durable = true;
  result = 0;
done: if (result) file->uncertain = true; np_origin_retained_unlock_v2(origin); return result;
}
