/**
 * Retention only: executable, reviewed, imported and secret-scanner inputs retain
 * their smaller limits. Retention does not authorize execution or bypass scanning.
 * Epoch tree scans cover ledger JSON, never the external archive evidence roots;
 * external archive bindings use the bounded archive inspector instead.
 */
export const MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES = 32 * 1024 * 1024;

export function assertRetainedTerminalArchivePatchSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 ||
      bytes > MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES) {
    throw new Error("retained_terminal_archive_patch_too_large");
  }
}
