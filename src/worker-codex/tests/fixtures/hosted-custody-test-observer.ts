import { constants, lstatSync, openSync, readFileSync, realpathSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertExactUnitGroup, assertNoQueuedStart, assertPopulatedZero, assertTerminalUnit,
  custodyControlGroup, observedBootId, observedJobUnits, observedProcessBirth, parseUnitShow } from "../../hosted-readonly-observations";

// TEST snapshots are operator supplied. This module never reads /proc, cgroupfs,
// systemd, or production authority. It cannot issue a custody receipt.
function invalid(): never { throw new Error("test_custody_observation_invalid"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 65536): string {
  if (typeof value !== "string" || value.length > limit) invalid();
  return value;
}
function ownerUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) invalid();
  return uid;
}
function input(root: string, name: "identity.json" | "observations.json"): unknown {
  const file = join(root, name), stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ownerUid() || stat.size > 65536) invalid();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, "utf8")) as unknown; }
  finally { closeSync(fd); }
}

export function observeTestCustody(root: string): Readonly<{ kind: "synthetic_observation_only"; startId: string;
  bootId: string; processBirth: string; unit: string; controlGroup: string; populated: 0 }> {
  if (!/^\/tmp\/test-custody-observer-[A-Za-z0-9_-]{6,80}$/.test(root) || realpathSync(root) !== root) invalid();
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.uid !== ownerUid() || (directory.mode & 0o077)) invalid();
  const identity = object(input(root, "identity.json"), "bootId,pid,processBirth,startId");
  const startId = text(identity.startId, 36), bootId = observedBootId(text(identity.bootId, 36));
  const pid = text(identity.pid, 10), expectedBirth = text(identity.processBirth, 32);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(startId) ||
      expectedBirth.split(":")[0] !== pid) invalid();
  const unit = `subscription-runtime-hosted-${startId}.service`, controlGroup = custodyControlGroup(unit);
  const observed = object(input(root, "observations.json"), "bootId,cgroupEvents,jobs,processStat,unitShow");
  if (observedBootId(text(observed.bootId, 36)) !== bootId ||
      observedProcessBirth(pid, text(observed.processStat)) !== expectedBirth) invalid();
  const show = parseUnitShow(unit, text(observed.unitShow));
  assertExactUnitGroup(unit, show, controlGroup);
  assertTerminalUnit(unit, show);
  const jobs = text(observed.jobs);
  assertNoQueuedStart(jobs, unit);
  if (observedJobUnits(jobs).length) invalid();
  // Unlike the production post-fence path, a missing snapshot is never proof.
  assertPopulatedZero(text(observed.cgroupEvents));
  const evidence = Object.freeze({ kind: "synthetic_observation_only" as const, startId, bootId,
    processBirth: expectedBirth, unit, controlGroup, populated: 0 as const });
  writeFileSync(join(root, "observation-evidence.json"), JSON.stringify(evidence) + "\n", { flag: "wx", mode: 0o600 });
  return evidence;
}
