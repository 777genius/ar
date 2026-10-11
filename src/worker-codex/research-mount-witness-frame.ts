import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { researchCustody, researchInvalid, researchRecord } from "./research-launch-files";

const maximumBytes = 16 * 1024 * 1024;
export function readResearchColdMountTable(): string {
  const fd = openSync("/proc/1/mountinfo", constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = [], chunk = Buffer.alloc(65536); let length = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      length += count; if (length > 8 * 1024 * 1024) researchInvalid();
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { closeSync(fd); }
}
/** One finite cold query, owned exclusively by one synchronous assertion. */
export function researchMountWitnessRows(): ReadonlyMap<number, Record<string, unknown>> {
  researchCustody("/usr/bin/findmnt");
  const result = spawnSync("/usr/bin/findmnt", ["--task", "1", "--list", "--json", "--output", "ID,TARGET,UUID,FSROOT,MAJ:MIN"],
    { encoding: "utf8", timeout: 15000, maxBuffer: maximumBytes, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > maximumBytes) researchInvalid();
  const parsed = researchRecord(JSON.parse(result.stdout), "filesystems");
  if (!Array.isArray(parsed.filesystems) || parsed.filesystems.length < 1 || parsed.filesystems.length > 50000) researchInvalid();
  const rows = new Map<number, Record<string, unknown>>();
  for (const item of parsed.filesystems) {
    const row = researchRecord(item, "id,target,uuid,fsroot,maj:min"), id = Number(row.id);
    if (!Number.isSafeInteger(id) || id < 1 || rows.has(id)) researchInvalid();
    rows.set(id, row);
  }
  return rows;
}
