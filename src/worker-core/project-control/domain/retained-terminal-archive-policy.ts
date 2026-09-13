/** Retention only: executable, reviewed and imported patches retain their smaller limits. */
export const MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES = 32 * 1024 * 1024;

export function assertRetainedTerminalArchivePatchSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 ||
      bytes > MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES) {
    throw new Error("retained_terminal_archive_patch_too_large");
  }
}
