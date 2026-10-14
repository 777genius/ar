import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertNoQueuedStart, assertPopulatedZero, assertTerminalUnit, custodyControlGroup,
  observedBootId } from "../../hosted-readonly-observations";
import { collectBootId, collectCustodyEvents, collectExactUnit, collectJobs, collectProcessBirth,
  collectProcessCgroup, collectUnitInvocation } from "../../hosted-readonly-linux-collector";

// TEST observations are live OS reads. Files select one externally owned unit;
// no file, PID, or observation grants launcher or creator authority.
const maxBytes = 4096;
function invalid(): never { throw new Error("test_custody_observation_invalid"); }
function owner(): number { const uid = process.getuid?.(); if (uid === undefined) invalid(); return uid; }
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) invalid();
  return value as Record<string, unknown>;
}
function same(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function sameRoot(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function rootStat(root: string): ReturnType<typeof fstatSync> {
  if (dirname(root) !== tmpdir() || !/^test-custody-observer-[A-Za-z0-9_-]{6,80}$/.test(basename(root)) ||
      realpathSync(root) !== root) invalid();
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd), path = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== owner() || (stat.mode & 0o077) || !same(stat, path)) invalid();
    return stat;
  } finally { closeSync(fd); }
}
type InputName = "identity.json" | "initial-evidence.json" | "terminal-evidence.json";
function readBounded(root: string, name: InputName): { text: string; stat: ReturnType<typeof fstatSync> } {
  const fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== owner() || before.nlink !== 1 || before.size > maxBytes || before.size < 1) invalid();
    const buffer = Buffer.alloc(maxBytes + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0), after = fstatSync(fd);
    if (count !== before.size || count > maxBytes || !same(before, after)) invalid();
    return { text: buffer.toString("utf8", 0, count), stat: before };
  } finally { closeSync(fd); }
}
function unchanged(root: string, name: InputName, prior: ReturnType<typeof readBounded>): void {
  const current = readBounded(root, name);
  if (!same(prior.stat, current.stat) || prior.text !== current.text) invalid();
}
function writeEvidence(root: string, name: "initial-evidence.json" | "terminal-evidence.json", value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > maxBytes) invalid();
  const fd = openSync(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600);
  let written: ReturnType<typeof fstatSync> | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== owner() || stat.nlink !== 1 || stat.size !== 0) invalid();
    if (writeSync(fd, bytes) !== bytes.length) invalid();
    written = fstatSync(fd);
    if (written.dev !== stat.dev || written.ino !== stat.ino || written.uid !== stat.uid || written.nlink !== 1 || written.size !== bytes.length) invalid();
  } finally { closeSync(fd); }
  const persisted = readBounded(root, name);
  if (!written || !same(written, persisted.stat) || persisted.text !== bytes.toString("utf8")) invalid();
}
function stableUnit(unit: string, bootId: string, initialInvocation: string): ReturnType<typeof collectExactUnit> {
  const show = collectExactUnit(unit);
  if (collectUnitInvocation(unit) !== initialInvocation || collectBootId() !== bootId) invalid();
  return show;
}
export function observeTestCustody(root: string, phase: "initial" | "terminal") {
  if (phase !== "initial" && phase !== "terminal") invalid();
  const firstRoot = rootStat(root);
  // The TEST orchestrator must own this 0700 root exclusively and prohibit
  // concurrent writers. This lock rejects cooperating simultaneous observers.
  const lock = join(root, ".observer-lock");
  const lockFd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600);
  try {
    const lockStat = fstatSync(lockFd);
    if (!lockStat.isFile() || lockStat.uid !== owner() || lockStat.nlink !== 1) invalid();
    const identity = readBounded(root, "identity.json");
    const input = record(JSON.parse(identity.text) as unknown, "bootId,creatorPid,startId");
    if (typeof input.startId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.startId) ||
        typeof input.bootId !== "string" || typeof input.creatorPid !== "string" ||
        !/^[1-9][0-9]{0,9}$/.test(input.creatorPid)) invalid();
    const bootId = observedBootId(input.bootId);
    const unit = `subscription-runtime-hosted-${input.startId}.service`;
    const controlGroup = custodyControlGroup(unit);
    if (collectBootId() !== bootId) invalid();
    const invocation = collectUnitInvocation(unit);
    if (phase === "initial") {
      const before = stableUnit(unit, bootId, invocation);
      if (!/^[1-9][0-9]{0,9}$/.test(before.MainPID ?? "")) invalid();
      const processBirth = collectProcessBirth(input.creatorPid);
      const creatorGroup = collectProcessCgroup(input.creatorPid);
      if (!creatorGroup.startsWith("0::/")) invalid();
      assertNoQueuedStart(collectJobs(), unit);
      const after = stableUnit(unit, bootId, invocation);
      if (JSON.stringify(before) !== JSON.stringify(after) || collectProcessBirth(input.creatorPid) !== processBirth ||
          collectProcessCgroup(input.creatorPid) !== creatorGroup) invalid();
      unchanged(root, "identity.json", identity);
      if (!sameRoot(firstRoot, rootStat(root))) invalid();
      const evidence = { kind: "live_observation_only" as const, phase, startId: input.startId,
        bootId, creatorPid: input.creatorPid, processBirth, creatorGroup, invocation, unit, controlGroup };
      writeEvidence(root, "initial-evidence.json", evidence);
      if (!sameRoot(firstRoot, rootStat(root))) invalid();
      return evidence;
    }
    const initial = readBounded(root, "initial-evidence.json");
    const birth = record(JSON.parse(initial.text) as unknown,
      "bootId,controlGroup,creatorGroup,creatorPid,invocation,kind,phase,processBirth,startId,unit");
    if (birth.kind !== "live_observation_only" || birth.phase !== "initial" || birth.startId !== input.startId ||
        birth.bootId !== bootId || birth.creatorPid !== input.creatorPid || birth.unit !== unit ||
        birth.controlGroup !== controlGroup || birth.invocation !== invocation ||
        typeof birth.processBirth !== "string" || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(birth.processBirth) ||
        typeof birth.creatorGroup !== "string" || !birth.creatorGroup.startsWith("0::/")) invalid();
    const before = stableUnit(unit, bootId, invocation);
    assertTerminalUnit(unit, before);
    assertNoQueuedStart(collectJobs(), unit);
    const events = collectCustodyEvents(unit);
    if (events.kind !== "present") invalid();
    assertPopulatedZero(events.text);
    const after = stableUnit(unit, bootId, invocation);
    if (JSON.stringify(before) !== JSON.stringify(after)) invalid();
    assertTerminalUnit(unit, after);
    unchanged(root, "identity.json", identity);
    unchanged(root, "initial-evidence.json", initial);
    if (!sameRoot(firstRoot, rootStat(root))) invalid();
    const evidence = { kind: "live_observation_only" as const, phase, startId: input.startId,
      bootId, processBirth: birth.processBirth, invocation, unit, controlGroup, populated: 0 as const };
    writeEvidence(root, "terminal-evidence.json", evidence);
    if (!sameRoot(firstRoot, rootStat(root))) invalid();
    return evidence;
  } finally { closeSync(lockFd); unlinkSync(lock); }
}
