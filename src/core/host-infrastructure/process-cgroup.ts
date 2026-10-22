function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }

/** Unified custody membership with the sole permitted legacy root hierarchy.
 * Callers still compare the returned unified membership with their owned group. */
export function observedProcessCgroup(raw: string): string {
  if (raw.length > 8192) invalid();
  const rows = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");
  if (rows.length < 1 || rows.length > 2) invalid();
  let unified: string | undefined, legacy = false;
  for (const row of rows) {
    if (row === "1:name=systemd:/" && !legacy) { legacy = true; continue; }
    if (unified !== undefined || !/^0::\/(?:[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*)?$/.test(row) ||
        row.slice(3).split("/").some(part => part === "." || part === "..")) invalid();
    unified = row;
  }
  if (unified === undefined) invalid();
  return unified;
}
