/* TEST-only stdin fixture: calls the same parser as the production holder.
 * No filesystem, quota, mount, process-child or root authority operation. */
#include "storage-mountinfo.h"
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end; errno = 0; uint64_t wanted = strtoull(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0') return 2;
  enum storage_mount_result result = storage_private_mount(stdin, wanted);
  const char *text = result == STORAGE_MOUNT_PRIVATE ? "private" :
    result == STORAGE_MOUNT_IDENTITY ? "identity" : "unsupported";
  /* Drain finite fixture input so an early parser decision cannot manufacture
   * a parent pipe EPIPE; this never changes the parser's observed result. */
  char remaining[8192]; size_t ignored = 0, length;
  while ((length = fread(remaining, 1, sizeof(remaining), stdin)) != 0) {
    if (length > 20U * 1024U * 1024U - ignored) return 2;
    ignored += length;
  }
  if (ferror(stdin)) return 2;
  puts(text); return 0;
}
