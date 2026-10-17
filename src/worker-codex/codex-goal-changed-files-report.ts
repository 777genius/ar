// Leaf module: no imports, so status readers and result builders can share it without pulling in Git or runtime code.
/** Closed vocabulary: it reaches finalization failures and results, so it never carries paths or Git text. */
export enum WorkspaceChangedFilesWarning {
  OutputLimit = "workspace_changed_files_output_limit",
  Timeout = "workspace_changed_files_timeout",
  Unavailable = "workspace_changed_files_unavailable",
}
/** A result envelope is read back through a 1 MiB limit, so it carries a bounded sample of the changed
 * paths, not the whole list: the paths are sorted and cut by count and by serialized bytes. The exact
 * list stays in the preserved workspace and the handoff packet. */
export const reportedChangedFilesLimit = Object.freeze({ paths: 2_000, bytes: 256 * 1024 });
export const changedFilesTruncatedEvidence = "changed_files_truncated";
export type ReportedChangedFiles = Readonly<{ changedFiles: readonly string[]; count: number; truncated: boolean }>;
export function boundedChangedFiles(files: readonly string[]): ReportedChangedFiles {
  const sorted = [...new Set(files.filter((value) => value.trim()))].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const kept: string[] = [];
  let bytes = 0;
  for (const path of sorted) {
    bytes += Buffer.byteLength(JSON.stringify(path)) + 1;
    // The first path always stays: an empty list would read as a clean workspace.
    if (kept.length > 0 && (kept.length >= reportedChangedFilesLimit.paths || bytes > reportedChangedFilesLimit.bytes)) break;
    kept.push(path);
  }
  return { changedFiles: kept, count: sorted.length, truncated: kept.length < sorted.length };
}
/** Count and truncation marker for the envelope details and evidence; empty when the list is complete. */
export function boundedChangedFilesNotes(reported: ReportedChangedFiles): Readonly<{ details: Readonly<Record<string, string>>; evidence: readonly string[] }> {
  return reported.truncated ? { details: { changedFilesCount: String(reported.count) }, evidence: [changedFilesTruncatedEvidence] } : { details: {}, evidence: [] };
}
