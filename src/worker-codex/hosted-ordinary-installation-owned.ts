import { trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertHostedActivationFence, readHostedActivationBytes, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedOrdinaryStart, HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import type { HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import { hostedFdLaunch, type HostedFdOriginalSpawnCustody } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { collectBootId, collectJobs, collectProcessBirth, collectProcessCgroup, collectUnitInvocation, collectUnitShow } from "./hosted-readonly-linux-collector";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, readonlySupervisorRoot } from "./hosted-readonly-custody";

type Reservation = Readonly<{ start: HostedOrdinaryStart; reservation: HostedOrdinaryReservation }>;
type Retained = { child: ChildProcess; reservation: Reservation; birth: string; parentBirth: string;
  executable: string; group: string; closed: boolean; failed: boolean; stdoutClosed: boolean;
  stderrClosed: boolean; stdinClosed: boolean; bound: boolean };
const returned = new Map<string, Retained>();
const reserved = new WeakSet<object>();
function denied(): never { throw new Error("hosted_ordinary_owned_unresolved"); }
function encoded(value: unknown): Buffer { return Buffer.from(JSON.stringify(value) + "\n"); }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** The Store-created reservation supplies this negative lifetime veto. Capture
 * uses the same returned map and raw streams before any child birth probe. */
export function ordinaryInstallationSpawnCustody(fence: HostedActivationFence, reservation: Reservation,
  inventory: HostedInventoryV5): HostedFdOriginalSpawnCustody {
  assertHostedActivationFence(fence); if (!reserved.has(reservation)) denied();
  const path = join(readonlySupervisorRoot, "ordinary-installations", inventory.supervisor.operationId, "operation.json");
  const bytes = readHostedPrivateBytes(path, 64 * 1024); if (!bytes) denied();
  const packet = JSON.parse(bytes.toString("utf8"));
  if (packet.schemaVersion !== 2 || packet.operationId !== inventory.supervisor.operationId ||
      packet.workEndEpochMs !== inventory.supervisor.workEndEpochMs || packet.cleanupEndEpochMs !== inventory.supervisor.cleanupEndEpochMs ||
      packet.node.path !== inventory.supervisor.executable.path || packet.node.sha256 !== inventory.supervisor.executable.sha256 ||
      packet.bootstrap.path !== inventory.supervisor.bootstrap.path || packet.bootstrap.sha256 !== inventory.supervisor.bootstrap.sha256) denied();
  return Object.freeze({
    assertOriginalWork() {
      assertHostedActivationFence(fence);
      if (returned.has(reservation.reservation.startId) || collectProcessBirth(String(process.pid)) !== inventory.supervisor.birth || !readHostedPrivateBytes(path, 64 * 1024)?.equals(bytes)) denied();
      const now = Date.now(), elapsed = Number((process.hrtime.bigint() - BigInt(packet.issuedMonotonicNs)) / 1_000_000n);
      if (!Number.isSafeInteger(elapsed) || elapsed < 0 || now < packet.issuedEpochMs || now < packet.issuedEpochMs + elapsed - 1000 ||
          Math.min(packet.workEndEpochMs - now, packet.workEndEpochMs - packet.issuedEpochMs - elapsed) < 1) denied();
    },
    retainOriginalChild(child: ChildProcess, streams: Readonly<Pick<ChildProcess, "stdin" | "stdout" | "stderr">>) {
      const retained: Retained = { child, reservation, birth: "", parentBirth: inventory.supervisor.birth, executable: "", group: "",
        closed: false, failed: false, stdoutClosed: false, stderrClosed: false, stdinClosed: false, bound: false };
      returned.set(reservation.reservation.startId, retained);
      const fail = () => { retained.failed = true; try { hostedFdLaunch(child).invalidate(); } catch { /* Setup is not yet admitted. */ } };
      child.once("error", fail);
      child.once("close", (code, signal) => { retained.closed = true; if (code !== 0 || signal !== null) retained.failed = true; });
      if (!streams.stdin || !streams.stdout || !streams.stderr) { retained.failed = true; return; }
      streams.stdin.once("finish", () => { retained.stdinClosed = true; });
      streams.stdout.once("end", () => { retained.stdoutClosed = true; });
      streams.stderr.once("end", () => { retained.stderrClosed = true; });
      for (const stream of [streams.stdin, streams.stdout, streams.stderr]) stream.once("error", fail);
    },
  });
}
/** Only Store's original reservation object can enter the private handle map. */
export function retainOrdinaryInstallationReservation(fence: HostedActivationFence, reservation: Reservation): void {
  assertHostedActivationFence(fence);
  const startBytes = readHostedActivationBytes(`ordinary-starts/${reservation.reservation.startId}.json`), activationBytes = readHostedActivationBytes("host-activation.json");
  if (!startBytes?.equals(encoded(reservation.start)) || !activationBytes) denied();
  const activation = JSON.parse(activationBytes.toString("utf8"));
  const row = Array.isArray(activation.ordinaryStarts) ? activation.ordinaryStarts.find((r: Record<string, unknown>) => r.startId === reservation.reservation.startId) : undefined;
  if (JSON.stringify(row) !== JSON.stringify(reservation.reservation) || row?.state !== "reserved" || activation.installationId !== reservation.start.installationId ||
      activation.supervisorId !== collectProcessBirth(String(process.pid)) || reservation.start.creatorPidBirth !== activation.supervisorId) denied();
  reserved.add(reservation);
}
/** Called at the fixed foreground spawn point, before observe/release/await.
 * Real FD-launch WeakMap membership is mandatory; PID/JSON cannot reconstruct it. */
export function retainOrdinaryInstallationChild(fence: HostedActivationFence, reservation: Reservation,
  child: ChildProcess, inventory: HostedInventoryV5, invocation: Readonly<{ command: string; args: readonly string[] }>): void {
  assertHostedActivationFence(fence);
  const guard = hostedFdLaunch(child);
  try {
  const prior = returned.get(reservation.reservation.startId);
  if (!reserved.has(reservation) || !child.pid || prior && (prior.child !== child || prior.reservation !== reservation || prior.birth !== "" || prior.failed) || guard.unit !== reservation.reservation.unit ||
      child.spawnfile !== invocation.command || JSON.stringify(child.spawnargs) !== JSON.stringify([invocation.command, ...invocation.args])) { guard.invalidate(); denied(); }
  const birth = collectProcessBirth(String(child.pid)), parentBirth = collectProcessBirth(String(process.pid));
  const group = collectProcessCgroup(String(child.pid));
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/);
  if (fields[1] !== String(process.pid) || parentBirth !== inventory.supervisor.birth || group !== `0::${inventory.units.find(u => u.name === inventory.supervisorUnit)!.controlGroup}`) { guard.invalidate(); denied(); }
  const retained: Retained = prior ?? { child, reservation, birth, parentBirth, executable: readlinkSync(`/proc/${child.pid}/exe`), group,
    closed: false, failed: false, stdoutClosed: false, stderrClosed: false, stdinClosed: false, bound: false };
  if (prior) { retained.birth = birth; retained.parentBirth = parentBirth; retained.group = group; retained.executable = readlinkSync(`/proc/${child.pid}/exe`); }
  returned.set(reservation.reservation.startId, retained);
  if (prior) return;
  child.once("error", () => { retained.failed = true; guard.invalidate(); });
  child.once("close", (code, signal) => { retained.closed = true; if (code !== 0 || signal !== null) retained.failed = true; });
  if (!child.stdin || !child.stdout || !child.stderr) { retained.failed = true; guard.invalidate(); denied(); }
  child.stdin.once("finish", () => { retained.stdinClosed = true; });
  child.stdout.once("end", () => { retained.stdoutClosed = true; });
  child.stderr.once("end", () => { retained.stderrClosed = true; });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.once("error", () => { retained.failed = true; guard.invalidate(); });
  } catch (error) { guard.invalidate(); throw error; }
}
/** A census may remove a proxy only after original close and all stream ends.
 * Failed tombstones remain retained and can never supply a successful terminal. */
export function ordinaryInstallationSupervisorMembers(inventory: HostedInventoryV5): readonly string[] {
  const live = [inventory.supervisor.birth];
  for (const retained of returned.values()) {
    if (retained.closed && retained.stdinClosed && retained.stdoutClosed && retained.stderrClosed) continue;
    const pid = String(retained.child.pid);
    if (retained.closed || collectProcessBirth(pid) !== retained.birth || collectProcessCgroup(pid) !== retained.group ||
        readlinkSync(`/proc/${pid}/exe`) !== retained.executable || retained.parentBirth !== inventory.supervisor.birth) denied();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[1] !== inventory.supervisor.birth.split(":")[0]) denied();
    live.push(retained.birth);
  }
  return Object.freeze(live);
}
/** Once-only protected ordinary provenance. The actual FD guard has observed
 * the prelude before Store calls this inside the release fence. */
export function bindOrdinaryInstallationReady(fence: HostedActivationFence, reservation: Reservation,
  inventory: HostedInventoryV5): void {
  assertHostedActivationFence(fence);
  const retained = returned.get(reservation.reservation.startId);
  if (!retained || retained.reservation !== reservation || retained.failed || retained.closed) denied();
  ordinaryInstallationSupervisorMembers(inventory);
  const { start, reservation: row } = reservation, observed = collectUnitShow(row.unit), invocationId = collectUnitInvocation(row.unit);
  if (observed.Id !== row.unit || observed.ControlGroup !== start.controlGroup || observed.DropInPaths !== "" ||
      collectBootId() !== start.bootId || !/^[1-9][0-9]*$/.test(observed.MainPID ?? "")) denied();
  const node = lstatSync(`/sys/fs/cgroup${start.controlGroup}`);
  if (!node.isDirectory() || node.isSymbolicLink() || node.uid !== 0) denied();
  const bytes = encoded({ schemaVersion: 1, installationId: start.installationId, startId: row.startId,
    startSha256: hash(encoded(start)), parentStartId: null, unit: row.unit, bootId: start.bootId,
    supervisorBirth: inventory.supervisor.birth, creatorBirth: start.creatorPidBirth,
    invocationId, controlGroup: start.controlGroup, dev: String(node.dev), ino: String(node.ino),
    mainPidBirth: collectProcessBirth(observed.MainPID!), workEndEpochMs: inventory.supervisor.workEndEpochMs,
    cleanupEndEpochMs: inventory.supervisor.cleanupEndEpochMs });
  if (bytes.length > 4096) denied();
  createReadonlyPrivateRecord(join(readonlySupervisorRoot, "ordinary-starts", row.startId + ".identity.json"), bytes);
  retained.bound = true;
}
/** Strengthens Store's sole wait-receipt producer with the actual original
 * returned handle and FD result; this view never publishes completion itself. */
export function assertOrdinaryInstallationRuntimeWait(reservation: Reservation): void {
  const retained = returned.get(reservation.reservation.startId);
  if (!retained || retained.reservation !== reservation || !retained.closed || retained.failed || !retained.bound ||
      !retained.stdoutClosed || !retained.stderrClosed || !retained.stdinClosed || retained.child.exitCode !== 0 || retained.child.signalCode !== null) denied();
  const facts = hostedFdLaunch(retained.child).foregroundResult();
  if (facts.exitCode !== 0 || facts.unit !== reservation.reservation.unit || facts.startId !== reservation.reservation.startId) denied();
}
export function assertOrdinaryInstallationOriginalClose(): void {
  for (const retained of returned.values()) if (!retained.closed || retained.failed || !retained.bound ||
      !retained.stdinClosed || !retained.stdoutClosed || !retained.stderrClosed) denied();
}

export type OrdinaryInstallationOperation = Readonly<{ operationId: string; operationSha256: string; workEndEpochMs: number; cleanupEndEpochMs: number }>;
export type OriginalOrdinaryInstallationClosed = Readonly<{ operationId: string }>;
const fundedOperations = new WeakMap<OrdinaryInstallationOperation, Buffer>();
const originalClosures = new WeakMap<OriginalOrdinaryInstallationClosed, OrdinaryInstallationOperation>();
const originalOperators = new WeakMap<OrdinaryInstallationOperation, { child: ChildProcess; closed: boolean; code: number | null;
  signal: NodeJS.Signals | null; failed: boolean; stdoutEnded: boolean; stderrEnded: boolean; closure?: OriginalOrdinaryInstallationClosed; original?: Readonly<{ invocationId: string; group: string; birth: string; dev: number; ino: number; fd: number }> }>();
/** Minted only after the issuer has durably funded its create-only operation. */
export function retainOriginalOrdinaryInstallationOperation(operation: OrdinaryInstallationOperation, bytes: Buffer): void {
  const record = readHostedPrivateBytes(join(readonlySupervisorRoot, "ordinary-installations", operation.operationId, "operation.json"), 64 * 1024);
  if (fundedOperations.has(operation) || hash(bytes) !== operation.operationSha256 || !record?.equals(bytes)) denied();
  const value = JSON.parse(bytes.toString("utf8"));
  if (value.operationId !== operation.operationId || value.workEndEpochMs !== operation.workEndEpochMs || value.cleanupEndEpochMs !== operation.cleanupEndEpochMs) denied();
  fundedOperations.set(operation, Buffer.from(bytes));
}
export function assertOriginalOrdinaryInstallationOperation(operation: OrdinaryInstallationOperation, work = false): void {
  const bytes = fundedOperations.get(operation);
  if (!bytes || hash(bytes) !== operation.operationSha256) denied();
  const packet = JSON.parse(bytes.toString("utf8")), now = Date.now();
  const elapsed = Number((process.hrtime.bigint() - BigInt(packet.issuedMonotonicNs)) / 1_000_000n);
  const end = work ? operation.workEndEpochMs : operation.cleanupEndEpochMs;
  if (!Number.isSafeInteger(elapsed) || elapsed < 0 || now < packet.issuedEpochMs || now < packet.issuedEpochMs + elapsed - 1000 ||
      Math.min(end - now, end - packet.issuedEpochMs - elapsed) < 1) denied();
  const record = readHostedPrivateBytes(join(readonlySupervisorRoot, "ordinary-installations", operation.operationId, "operation.json"), 64 * 1024);
  if (!record?.equals(bytes)) denied();
}
export function retainOriginalOrdinaryInstallationOperator(operation: OrdinaryInstallationOperation, child: ChildProcess): void {
  assertOriginalOrdinaryInstallationOperation(operation);
  if (originalOperators.has(operation) || child.spawnfile !== trustedCustodySystemdRunExecutable ||
      !child.spawnargs.includes(`--unit=subscription-runtime-installation-${operation.operationId}.service`) || !child.stdin || !child.stdout || !child.stderr) denied();
  const cell = { child, closed: false, code: null as number | null, signal: null as NodeJS.Signals | null, failed: false, stdoutEnded: false, stderrEnded: false };
  originalOperators.set(operation, cell);
  child.once("error", () => { cell.failed = true; });
  child.once("close", (code, signal) => { cell.closed = true; cell.code = code; cell.signal = signal; });
  child.stdout.once("end", () => { cell.stdoutEnded = true; }); child.stderr.once("end", () => { cell.stderrEnded = true; });
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.once("error", () => { cell.failed = true; });
}
/** Readiness only triggers a fresh physical bind of the sole original fixed
 * supervisor. The returned proxy/operation cell owns this observation. */
export function bindOriginalOrdinaryInstallationSupervisor(operation: OrdinaryInstallationOperation): void {
  assertOriginalOrdinaryInstallationOperation(operation);
  const cell = originalOperators.get(operation), packet = JSON.parse(fundedOperations.get(operation)!.toString("utf8"));
  if (!cell || cell.closed || cell.failed || cell.original) denied();
  const unit = `subscription-runtime-installation-${operation.operationId}.service`, current = collectUnitShow(unit);
  const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
  if (current.Id !== unit || current.ControlGroup !== group || !/^[1-9][0-9]*$/.test(current.MainPID ?? "")) denied();
  const pid = current.MainPID!, argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0");
  if (argv.pop() !== "" || JSON.stringify(argv) !== JSON.stringify([packet.node.path, packet.bootstrap.path, "--operation", operation.operationId]) ||
      readlinkSync(`/proc/${pid}/exe`) !== packet.node.path || collectProcessCgroup(pid) !== `0::${group}`) denied();
  const path = "/sys/fs/cgroup" + group, before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const node = fstatSync(fd), after = lstatSync(path);
    if (!node.isDirectory() || node.uid !== 0 || before.dev !== node.dev || before.ino !== node.ino || after.dev !== node.dev || after.ino !== node.ino) denied();
    cell.original = Object.freeze({ invocationId: collectUnitInvocation(unit), group, birth: collectProcessBirth(pid), dev: node.dev, ino: node.ino, fd });
  } catch (error) { closeSync(fd); throw error; }
}
/** Issuer calls this only after its independently retained original unit/group
 * and queue checks. It cannot manufacture a close from a stored JSON state. */
export function retainOriginalOrdinaryInstallationClosed(operation: OrdinaryInstallationOperation): OriginalOrdinaryInstallationClosed {
  assertOriginalOrdinaryInstallationOperation(operation);
  const cell = originalOperators.get(operation);
  if (!cell || cell.closure || !cell.closed || cell.failed || cell.code === null || cell.signal !== null || !cell.stdoutEnded || !cell.stderrEnded || !cell.child.stdin?.writableFinished) denied();
  const original = cell.original; if (!original) denied();
  const unit = `subscription-runtime-installation-${operation.operationId}.service`, current = collectUnitShow(unit);
  if (current.Id !== unit || current.ControlGroup !== original.group || current.MainPID !== "0" || collectUnitInvocation(unit) !== original.invocationId || collectJobs().includes(unit)) denied();
  const activationBytes = readHostedActivationBytes("host-activation.json"), terminalBytes = readHostedPrivateBytes(join(readonlySupervisorRoot, "ordinary-installations", operation.operationId + ".closed.json"), 4096);
  if (!activationBytes || !terminalBytes) denied();
  const activation = JSON.parse(activationBytes.toString("utf8")), terminal = JSON.parse(terminalBytes.toString("utf8"));
  if (activation.phase !== "CLOSED" || activation.supervisorId !== original.birth || terminal.operationId !== operation.operationId || terminal.sourceExitCode !== cell.code ||
      terminal.generation !== activation.generation || !Array.isArray(activation.ordinaryStarts) || activation.ordinaryStarts.some((r: Record<string, unknown>) => r.state !== "terminal")) denied();
  let nodes = 0;
  const walk = (path: string): void => {
    if (++nodes > 256 || Date.now() >= operation.cleanupEndEpochMs) denied();
    const root = path === "/sys/fs/cgroup" + original.group;
    const before = lstatSync(path), fd = root ? original.fd : openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const node = fstatSync(fd); if (!node.isDirectory() || node.uid !== 0 || before.dev !== node.dev || before.ino !== node.ino ||
          root && (node.dev !== original.dev || node.ino !== original.ino)) denied();
      const anchored = `/proc/self/fd/${fd}`, events = readFileSync(anchored + "/cgroup.events", "utf8");
      if (readFileSync(anchored + "/cgroup.procs", "utf8") !== "" || !/^populated 0$/m.test(events) || /^populated 1$/m.test(events)) denied();
      for (const child of readdirSync(anchored, { withFileTypes: true })) if (child.isDirectory()) walk(path + "/" + child.name);
      const after = lstatSync(path); if (after.dev !== node.dev || after.ino !== node.ino) denied();
    } finally { if (!root) closeSync(fd); }
  };
  walk("/sys/fs/cgroup" + original.group);
  if (collectJobs().includes(unit) || collectUnitInvocation(unit) !== original.invocationId) denied();
  const closure = Object.freeze({ operationId: operation.operationId });
  closeSync(original.fd); cell.closure = closure; originalClosures.set(closure, operation); return closure;
}
export function assertOriginalOrdinaryInstallationClosed(closure: OriginalOrdinaryInstallationClosed, operation: OrdinaryInstallationOperation): void {
  assertOriginalOrdinaryInstallationOperation(operation);
  if (originalClosures.get(closure) !== operation) denied();
}
