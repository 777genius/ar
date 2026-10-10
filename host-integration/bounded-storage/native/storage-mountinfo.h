#ifndef STORAGE_MOUNTINFO_H
#define STORAGE_MOUNTINFO_H
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum storage_mount_result { STORAGE_MOUNT_PRIVATE, STORAGE_MOUNT_UNSUPPORTED, STORAGE_MOUNT_IDENTITY };
/* Bounded observation of this namespace only. Stop at the retained statx mount
 * identity; later unrelated records cannot change that selected mount's flags.
 * 16MiB/65536 accommodates measured tables (~10.27MiB/29k), not unbounded input. */
static enum storage_mount_result storage_private_mount(FILE *info, uint64_t wanted) {
  const size_t byte_limit = 16U * 1024U * 1024U, row_limit = 65536U;
  char line[4096]; size_t total = 0, rows = 0;
  while (fgets(line, sizeof(line), info)) {
    size_t length = strlen(line);
    if (rows == row_limit || length > byte_limit - total || strchr(line, '\n') == NULL)
      return STORAGE_MOUNT_UNSUPPORTED;
    rows++; total += length;
    char *end; errno = 0; uint64_t id = strtoull(line, &end, 10);
    if (errno != 0 || end == line || *end != ' ') return STORAGE_MOUNT_IDENTITY;
    if (id != wanted) continue;
    char *separator = strstr(line, " - ");
    if (separator == NULL) return STORAGE_MOUNT_IDENTITY;
    *separator = '\0';
    if (strstr(line, " shared:") || strstr(line, " master:") || strstr(line, " propagate_from:"))
      return STORAGE_MOUNT_UNSUPPORTED;
    return ferror(info) ? STORAGE_MOUNT_UNSUPPORTED : STORAGE_MOUNT_PRIVATE;
  }
  return STORAGE_MOUNT_UNSUPPORTED;
}
#endif
