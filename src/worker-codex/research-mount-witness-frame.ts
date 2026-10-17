import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { researchCustody, researchInvalid, researchPath, researchRecord } from "./research-launch-files";

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
/** Fresh cold queries within one finite synchronous assertion. Two targets
 * avoid UUID probing for every unrelated mount; larger frames retain the list. */
export function researchMountWitnessRows(targets?: readonly string[]): ReadonlyMap<number, Record<string, unknown>> {
  if (targets && (targets.length !== 2 || new Set(targets).size !== 2)) researchInvalid();
  for (const target of targets ?? []) researchPath(target);
  const rows = new Map<number, Record<string, unknown>>();
  const deadline = process.hrtime.bigint() + 15_000_000_000n;
  for (const target of targets ?? [undefined]) {
    researchCustody("/usr/bin/findmnt");
    const remaining = Number((deadline - process.hrtime.bigint()) / 1_000_000n);
    if (remaining < 1) researchInvalid();
    const result = spawnSync("/usr/bin/findmnt", ["--task", "1", ...(target === undefined ? ["--list"] : ["--target", target]), "--json", "--output", "ID,TARGET,UUID,FSROOT,MAJ:MIN"],
      { encoding: "utf8", timeout: Math.min(15000, remaining), maxBuffer: maximumBytes, env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    if (process.hrtime.bigint() >= deadline || result.error || result.status !== 0 || typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > maximumBytes) researchInvalid();
    const parsed = researchRecord(JSON.parse(result.stdout), "filesystems");
    if (!Array.isArray(parsed.filesystems) || parsed.filesystems.length < 1 || parsed.filesystems.length > 50000 ||
        (target !== undefined && parsed.filesystems.length !== 1)) researchInvalid();
    const queryIds = new Set<number>();
    for (const item of parsed.filesystems) {
      const row = researchRecord(item, "id,target,uuid,fsroot,maj:min"), id = Number(row.id);
      if (!Number.isSafeInteger(id) || id < 1 || queryIds.has(id)) researchInvalid();
      queryIds.add(id);
      const prior = rows.get(id);
      // Two distinct paths can share one mount. Fresh queries must agree on
      // every UUID/backing field; conflicting responses never replace evidence.
      if (prior && ["id", "target", "uuid", "fsroot", "maj:min"].some(key => prior[key] !== row[key])) researchInvalid();
      rows.set(id, row);
    }
  }
  return rows;
}
