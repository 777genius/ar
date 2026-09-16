import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertHostedProcessDescriptors } from "@vioxen/subscription-runtime/provider-codex";
import { HostedCustodyPhase, HostedCustodyReservationState, type HostedCustodyEpoch, type HostedCustodyReservation, type HostedOrdinaryReservation, type HostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { assertReadonlyHostOperator, decodePrivateJson } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedReadonlyEpochStore, readonlyEpochPath } from "./hosted-readonly-epoch-store";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
import { TrustedCustodyLaunchRole, trustedCustodySystemdLaunch } from "./trusted-custody-systemd-launch";

export enum HostedReadonlyRuntimeRole { Supervisor = "supervisor", Runtime = "runtime" }

export type HostedReadonlyHostInventory = {
  readonly schemaVersion: 1 | 2;
  readonly hostId: string;
  readonly supervisorUnit: string;
  readonly units: readonly { readonly name: string; readonly controlGroup: string; readonly fragmentSha256: string }[];
  readonly ordinaryCreators: readonly HostedOrdinaryCreator[];
  readonly disabledCreators: readonly string[];
  readonly runtimeLaunch: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
};
export type HostedOrdinaryCreator = {
  readonly creatorId: string; readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string;
  readonly launch: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
};
const unitPattern = /^[A-Za-z0-9_@.-]+\.(service|scope)$/;
const pathPattern = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Finite independent root inventory. It does not authorize a launch by itself:
 * actual service identities/cgroups, supervisor birth and queued jobs are checked
 * below under the common fence. Unknown scopes/services keep the epoch CLOSED. */
export function readHostedReadonlyHostInventory(): HostedReadonlyHostInventory {
  assertReadonlyHostOperator();
  const bytes = readHostedPrivateBytes(join(readonlySupervisorRoot, "readonly-inventory.json"), 64 * 1024);
  if (!bytes) invalid();
  const decoded = decodePrivateJson(bytes);
  const v2 = !!decoded && typeof decoded === "object" && "schemaVersion" in decoded && decoded.schemaVersion === 2;
  const value = object(decoded, v2 ? "disabledCreators,hostId,ordinaryCreators,runtimeLaunch,schemaVersion,supervisorUnit,units" :
    "hostId,runtimeLaunch,schemaVersion,supervisorUnit,units");
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || typeof value.hostId !== "string" || !/^[a-f0-9]{32}$/.test(value.hostId) ||
      !unit(value.supervisorUnit) || !Array.isArray(value.units) || value.units.length < 1 || value.units.length > 128) invalid();
  const units = value.units.map(entry => {
    const row = object(entry, "controlGroup,fragmentSha256,name");
    if (!unit(row.name) || !path(row.controlGroup) || row.name.startsWith("subscription-runtime-hosted-") ||
        typeof row.fragmentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.fragmentSha256)) invalid();
    return Object.freeze({ name: row.name, controlGroup: row.controlGroup, fragmentSha256: row.fragmentSha256 });
  });
  if (new Set(units.map(row => row.name)).size !== units.length ||
      new Set(units.map(row => row.controlGroup)).size !== units.length ||
      !units.some(row => row.name === value.supervisorUnit)) invalid();
  const launch = parseLaunch(value.runtimeLaunch);
  let ordinaryCreators: HostedOrdinaryCreator[] = [], disabledCreators: string[] = [];
  if (v2) {
    if (!Array.isArray(value.ordinaryCreators) || value.ordinaryCreators.length > 128 ||
        !Array.isArray(value.disabledCreators) || value.disabledCreators.length > 128) invalid();
    ordinaryCreators = value.ordinaryCreators.map(entry => {
      const row = object(entry, "creatorId,jobId,jobRootDir,launch,workspacePath");
      if (!identity(row.creatorId) || !identity(row.jobId) || !path(row.jobRootDir) || !path(row.workspacePath)) invalid();
      return Object.freeze({ creatorId: row.creatorId, jobId: row.jobId, jobRootDir: row.jobRootDir,
        workspacePath: row.workspacePath, launch: parseLaunch(row.launch) });
    });
    disabledCreators = value.disabledCreators.map(name => {
      if (typeof name !== "string" || name.length > 200 || !/^[A-Za-z0-9_@.-]+\.(service|socket|timer)$/.test(name) ||
          units.some(row => row.name === name)) invalid();
      return name;
    });
    if (new Set(ordinaryCreators.map(row => row.creatorId)).size !== ordinaryCreators.length ||
        new Set(disabledCreators).size !== disabledCreators.length) invalid();
    // Multiple finite launch tuples may describe one job, but never conflicting
    // root/workspace provenance or two identities sharing a mutable job scope.
    for (const left of ordinaryCreators) for (const right of ordinaryCreators) {
      if (left.jobId === right.jobId ? left.jobRootDir !== right.jobRootDir || left.workspacePath !== right.workspacePath :
          left.jobRootDir === right.jobRootDir || left.workspacePath === right.workspacePath) invalid();
    }
  }
  return Object.freeze({ schemaVersion: v2 ? 2 : 1, hostId: value.hostId, supervisorUnit: value.supervisorUnit,
    units: Object.freeze(units), runtimeLaunch: launch,
    ordinaryCreators: Object.freeze(ordinaryCreators), disabledCreators: Object.freeze(disabledCreators) });
}

export class HostedReadonlyHostKernel {
  session(): { hostId: string; bootId: string; supervisorId: string } {
    assertReadonlyHostOperator();
    const inventory = readHostedReadonlyHostInventory();
    const hostId = readFileSync("/etc/machine-id", "utf8").trim();
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (hostId !== inventory.hostId || !/^[a-f0-9-]{36}$/.test(bootId)) invalid();
    const supervisor = this.show(inventory.supervisorUnit);
    const expected = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (supervisor.ControlGroup !== expected.controlGroup || !/^[1-9]\d*$/.test(supervisor.MainPID ?? "")) invalid();
    const callerGroup = readFileSync("/proc/self/cgroup", "utf8").trim();
    // Initial namespace + real cgroup membership, not an inherited env marker.
    if (callerGroup !== `0::${expected.controlGroup}`) {
      const epoch = this.enrolledEpoch(), outer = epoch?.outerRuntime;
      if (!epoch || !outer || outer.state !== HostedCustodyReservationState.Reserved || epoch.bootId !== bootId ||
          callerGroup !== `0::${unitGroup(outer.unit)}`) invalid();
    }
    const stat = readFileSync(`/proc/${supervisor.MainPID}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    if (tail.length < 20 || !/^\d+$/.test(tail[19] ?? "")) invalid();
    return { hostId, bootId, supervisorId: `${supervisor.MainPID}:${tail[19]}` };
  }

  verifyExclusiveInventory(): void {
    const inventory = readHostedReadonlyHostInventory();
    this.session();
    if (inventory.schemaVersion === 2) this.verifyFutureCreators(inventory);
    const outer = this.enrolledEpoch()?.outerRuntime;
    const observed = this.systemctl(["list-units", "--all", "--type=service,scope",
      "--state=active,activating,reloading,deactivating,failed", "--no-legend", "--plain", "--no-pager"]);
    for (const line of lines(observed)) {
      const name = line.trim().split(/\s+/)[0];
      // PID 1's kernel-owned scope has no service fragment. Its only allowed
      // process is checked independently in the cgroup walk below; it is not
      // an operator-supplied wildcard for scopes or hosted descendants.
      if (name === "init.scope") continue;
      if (!unit(name) || !inventory.units.some(row => row.name === name) && !(outer?.state === HostedCustodyReservationState.Reserved && name === outer.unit)) invalid();
    }
    if (outer?.state === HostedCustodyReservationState.Reserved) {
      assertUnitReservation(outer);
      const current = this.show(outer.unit);
      if (current.Id !== outer.unit || current.DropInPaths !== "" || (current.ControlGroup && current.ControlGroup !== unitGroup(outer.unit))) invalid();
    }
    for (const row of inventory.units) {
      const current = this.show(row.name);
      if (current.Id !== row.name || current.ControlGroup !== row.controlGroup || !path(current.FragmentPath) ||
          current.DropInPaths !== "" ||
          hash(readTrustedFragment(current.FragmentPath)) !== row.fragmentSha256) invalid();
    }
    // Cover live userspace processes, including scopes absent from the service
    // listing. Only the exact finite trusted cgroups may contain processes;
    // empty slice ancestors are traversed, never accepted as broad allowlists.
    let groups = 0;
    const inspectGroup = (relative: string): void => {
      if (++groups > 4096) invalid();
      const absolute = "/sys/fs/cgroup" + relative;
      const pids = lines(readFileSync(absolute + "/cgroup.procs", "utf8"));
      if (pids.some(pid => !/^[1-9]\d*$/.test(pid))) invalid();
      if (pids.length && !inventory.units.some(row => row.controlGroup === relative) &&
          !(outer?.state === HostedCustodyReservationState.Reserved && relative === unitGroup(outer.unit)) &&
          !(relative === "/init.scope" && pids.length === 1 && pids[0] === "1")) invalid();
      for (const child of readdirSync(absolute, { withFileTypes: true })) {
        if (child.isDirectory()) inspectGroup(relative + "/" + child.name);
      }
    };
    inspectGroup("");
    for (const line of lines(this.systemctl(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"]))) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || !/^\d+$/.test(fields[0] ?? "") ||
          (!inventory.units.some(row => row.name === fields[1]) && !(outer?.state === HostedCustodyReservationState.Reserved && fields[1] === outer.unit))) invalid();
    }
  }

  /** Exact initial-host supervisor only, before installation or origin creation.
   * Runtime children cannot migrate identities using their CLI arguments. */
  operatorSession(): { hostId: string; bootId: string; supervisorId: string } {
    const inventory = readHostedReadonlyHostInventory();
    const supervisor = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (readFileSync("/proc/self/cgroup", "utf8").trim() !== `0::${supervisor.controlGroup}`) invalid();
    return this.session();
  }

  /** Facts for the actual ordinary runtime, never a caller-provided job/env
   * selection. The store independently binds this start to retained authority. */
  ordinaryRuntimeSession(start: HostedOrdinaryStart): { hostId: string; bootId: string; supervisorId: string } {
    assertReadonlyHostOperator();
    const inventory = readHostedReadonlyHostInventory();
    const owner = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    const supervisor = this.show(inventory.supervisorUnit), current = this.show(start.unit);
    const hostId = readFileSync("/etc/machine-id", "utf8").trim();
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (hostId !== inventory.hostId || bootId !== start.bootId || supervisor.Id !== owner.name ||
        supervisor.ControlGroup !== owner.controlGroup || supervisor.DropInPaths !== "" ||
        !path(supervisor.FragmentPath) || hash(readTrustedFragment(supervisor.FragmentPath)) !== owner.fragmentSha256 ||
        current.Id !== start.unit || current.ControlGroup !== start.controlGroup || current.DropInPaths !== "" ||
        !/^[1-9]\d*$/.test(current.MainPID ?? "") ||
        readFileSync("/proc/self/cgroup", "utf8").trim() !== `0::${start.controlGroup}`) invalid();
    const supervisorId = processBirth(supervisor.MainPID ?? "");
    const creatorPid = start.creatorPidBirth.split(":")[0]!;
    if (supervisorId !== start.supervisorId || processBirth(creatorPid) !== start.creatorPidBirth ||
        readFileSync(`/proc/${creatorPid}/cgroup`, "utf8").trim() !== `0::${owner.controlGroup}`) invalid();
    return { hostId, bootId, supervisorId };
  }

  ordinaryCreatorBirth(): string {
    this.operatorSession();
    return processBirth(String(process.pid));
  }

  /** Explicitly masked legacy creators plus the finite installed service set.
   * Timers/sockets and enabled foreign services cannot queue future competitors.
   * Trusted host root remains outside this threat model. */
  private verifyFutureCreators(inventory: HostedReadonlyHostInventory): void {
    for (const name of inventory.disabledCreators) {
      const result = this.systemctl(["show", "--property=Id,LoadState,ActiveState,UnitFileState,Job", "--", name]);
      const values = new Map(lines(result).map(line => {
        const at = line.indexOf("=");
        if (at < 1) invalid();
        return [line.slice(0, at), line.slice(at + 1)];
      }));
      if (values.size !== 5 || lines(result).length !== 5 || values.get("Id") !== name ||
          values.get("LoadState") !== "masked" || values.get("ActiveState") !== "inactive" ||
          values.get("UnitFileState") !== "masked" || values.get("Job") !== "") invalid();
    }
    const enabled = this.systemctl(["list-unit-files", "--type=service,socket,timer", "--state=enabled,enabled-runtime,linked,linked-runtime,alias",
      "--no-legend", "--no-pager"]);
    for (const line of lines(enabled)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 2 || fields.length > 3 || !inventory.units.some(row => row.name === fields[0])) invalid();
    }
    if (lines(this.systemctl(["list-units", "--all", "--type=socket,timer",
      "--state=active,activating,reloading,deactivating", "--no-legend", "--plain", "--no-pager"])).length) invalid();
    for (const line of lines(this.systemctl(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"]))) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || !/^\d+$/.test(fields[0] ?? "") || inventory.disabledCreators.includes(fields[1] ?? "")) invalid();
    }
  }

  verifyDescriptorBoundary(): void { assertHostedProcessDescriptors(); }

  /** A same-boot reservation needs the trusted --wait completion receipt. PID
   * absence or a killed proxy is deliberately insufficient. Failed/ambiguous
   * starts stay held; this adapter does not fabricate a terminal receipt. */
  fenceCreator(reservation: HostedCustodyReservation, recordedBootId: string): void {
    if (recordedBootId !== this.session().bootId) return;
    const bytes = readHostedPrivateBytes(completionPath(reservation), 4096);
    if (!bytes || !bytes.equals(completionBytes(reservation, 0))) {
      throw new Error("hosted_custody_creator_not_fenced");
    }
  }
  drainQueuedStart(reservation: HostedCustodyReservation): void {
    assertUnitReservation(reservation);
    this.drainUnitQueue(reservation.unit);
  }
  private drainUnitQueue(unit: string): void {
    // No cancellation/absence is promoted into proof. After the creator has
    // been fenced, any remaining manager job keeps the reservation held.
    for (const line of lines(this.systemctl(["list-jobs", "--all", "--no-legend", "--plain", "--no-pager"]))) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || !/^\d+$/.test(fields[0] ?? "")) invalid();
      if (fields[1] === unit) throw new Error("hosted_custody_start_still_queued");
    }
  }
  confirmTerminalDescendants(reservation: HostedCustodyReservation): void {
    assertUnitReservation(reservation);
    this.confirmUnitDescendants(reservation.unit);
  }
  private confirmUnitDescendants(unit: string): void {
    let current: Record<string, string>;
    try { current = this.show(unit); }
    catch {
      // Only after creator and queue fencing may an explicitly unloaded unit
      // combine with an empty/absent cgroup as terminal evidence. Bus failure
      // and arbitrary nonzero systemctl status remain failures.
      if (this.systemctl(["show", "--property=LoadState", "--", unit], true).trim() !== "LoadState=not-found") invalid();
      current = { MainPID: "0", ControlGroup: "" };
    }
    if (current.MainPID !== "0" || (current.ControlGroup && current.ControlGroup !== unitGroup(unit))) invalid();
    const events = `/sys/fs/cgroup${unitGroup(unit)}/cgroup.events`;
    try {
      const text = readFileSync(events, "utf8");
      if (text.split("\n").filter(line => line.startsWith("populated ")).join("\n") !== "populated 0") {
        throw new Error("hosted_custody_descendants_not_terminal");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Absence is useful only after independent creator and queue fencing; the
      // application calls those operations first, under the same host mutex.
    }
  }
  requestStop(reservation: HostedCustodyReservation): void {
    assertUnitReservation(reservation);
    this.requestUnitStop(reservation.unit);
  }
  private requestUnitStop(unit: string): void {
    let failed = false;
    for (const args of [["kill", "--signal=SIGTERM", "--kill-whom=all", unit],
      ["stop", "--no-block", unit]]) {
      try { this.systemctl(args); } catch { failed = true; }
    }
    if (failed) throw new Error("hosted_custody_stop_incomplete");
  }
  fenceOrdinaryCreator(reservation: HostedOrdinaryReservation, recordedBoot: string, startSha256: string): void {
    assertOrdinaryReservation(reservation);
    if (recordedBoot !== this.operatorSession().bootId) return;
    const bytes = readHostedPrivateBytes(ordinaryCompletionPath(reservation.startId), 4096);
    if (!bytes || !bytes.equals(ordinaryCompletionBytes(reservation.startId, startSha256))) {
      throw new Error("hosted_custody_creator_not_fenced");
    }
  }
  drainOrdinaryQueue(reservation: HostedOrdinaryReservation): void {
    assertOrdinaryReservation(reservation); this.drainUnitQueue(reservation.unit);
  }
  confirmOrdinaryDescendants(reservation: HostedOrdinaryReservation): void {
    assertOrdinaryReservation(reservation); this.confirmUnitDescendants(reservation.unit);
  }
  stopOrdinary(reservation: HostedOrdinaryReservation): void {
    assertOrdinaryReservation(reservation); this.requestUnitStop(reservation.unit);
  }

  assertRuntimeLaunch(epoch: HostedCustodyEpoch, command: string, args: readonly string[], cwd: string): void {
    const inventory = readHostedReadonlyHostInventory();
    const actual = this.session();
    const owner = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (readFileSync("/proc/self/cgroup", "utf8").trim() !== `0::${owner.controlGroup}`) invalid();
    if (epoch.hostId !== actual.hostId || epoch.bootId !== actual.bootId || epoch.supervisorId !== actual.supervisorId ||
        command !== inventory.runtimeLaunch.command || cwd !== inventory.runtimeLaunch.cwd ||
        JSON.stringify(args) !== JSON.stringify(inventory.runtimeLaunch.args)) {
      throw new Error("hosted_custody_runtime_launch_denied");
    }
  }
  runtimeRole(): HostedReadonlyRuntimeRole {
    const inventory = readHostedReadonlyHostInventory();
    const owner = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (readFileSync("/proc/self/cgroup", "utf8").trim() === `0::${owner.controlGroup}`) {
      const epoch = this.enrolledEpoch();
      if (!epoch) invalid();
      this.assertRuntimeLaunch(epoch, inventory.runtimeLaunch.command, inventory.runtimeLaunch.args, inventory.runtimeLaunch.cwd);
      return HostedReadonlyRuntimeRole.Supervisor;
    }
    this.verifyRuntimeOwner();
    return HostedReadonlyRuntimeRole.Runtime;
  }
  verifyRuntimeOwner(): void {
    const epoch = this.enrolledEpoch(), outer = epoch?.outerRuntime;
    if (!epoch || epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || !outer || outer.state !== HostedCustodyReservationState.Reserved ||
        outer.generation !== epoch.generation ||
        readFileSync("/proc/self/cgroup", "utf8").trim() !== `0::${unitGroup(outer.unit)}`) invalid();
    const actual = this.session();
    if (epoch.hostId !== actual.hostId || epoch.bootId !== actual.bootId || epoch.supervisorId !== actual.supervisorId) invalid();
    const current = this.show(outer.unit);
    if (current.ControlGroup !== unitGroup(outer.unit) || !/^[1-9]\d*$/.test(current.MainPID ?? "")) invalid();
  }
  runtimeInvocation(record: Pick<HostedCustodyReservation, "startId" | "unit" | "creatorId">,
    command: string, args: readonly string[], cwd: string): { command: string; args: readonly string[] } {
    assertUnitReservation(record);
    if (!record.unit.startsWith("subscription-runtime-outer-")) invalid();
    return trustedCustodySystemdLaunch(TrustedCustodyLaunchRole.Outer, record.startId, cwd);
  }
  ordinaryRuntimeInvocation(record: HostedOrdinaryReservation, cwd: string): { command: string; args: readonly string[] } {
    assertOrdinaryReservation(record);
    if (record.unit !== `subscription-runtime-ordinary-${record.startId}.service` || !path(cwd)) invalid();
    return trustedCustodySystemdLaunch(TrustedCustodyLaunchRole.Ordinary, record.startId, cwd);
  }
  private enrolledEpoch(): HostedCustodyEpoch | null {
    if (!readHostedPrivateBytes(readonlyEpochPath, 64 * 1024)) return null;
    const epoch = new HostedReadonlyEpochStore().readEpoch();
    if (epoch.outerRuntime) {
      assertUnitReservation(epoch.outerRuntime);
      if (!epoch.outerRuntime.unit.startsWith("subscription-runtime-outer-")) invalid();
    }
    return epoch;
  }
  private show(name: string): Record<string, string> {
    if (!unit(name)) invalid();
    const result: Record<string, string> = {};
    for (const line of lines(this.systemctl(["show", "--property=Id,FragmentPath,DropInPaths,ControlGroup,MainPID", "--", name]))) {
      const split = line.indexOf("=");
      const key = line.slice(0, split);
      if (split < 1 || !["Id", "FragmentPath", "DropInPaths", "ControlGroup", "MainPID"].includes(key) || key in result) invalid();
      result[key] = line.slice(split + 1);
    }
    if (Object.keys(result).length !== 5) invalid();
    return result;
  }
  private systemctl(args: readonly string[], allowNotFound = false): string {
    const result = spawnSync("/usr/bin/systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000, maxBuffer: 256 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
    if (result.error || (result.status !== 0 && !(allowNotFound && result.status === 4 && result.stdout.trim() === "LoadState=not-found"))) invalid();
    return result.stdout;
  }
}

export function completionPath(reservation: Pick<HostedCustodyReservation, "startId" | "unit" | "creatorId">): string {
  assertUnitReservation(reservation);
  return join(readonlySupervisorRoot, "readonly-completed-" + reservation.startId + ".json");
}
export type HostedWaitStatus = 0;
export function completionBytes(reservation: Pick<HostedCustodyReservation, "startId" | "unit" | "creatorId">, waitStatus: HostedWaitStatus = 0): Buffer {
  assertUnitReservation(reservation);
  return Buffer.from(JSON.stringify({ schemaVersion: 1, startId: reservation.startId,
    unit: reservation.unit, creatorId: reservation.creatorId, waitCompleted: true, waitStatus }) + "\n");
}
function assertUnitReservation(value: Pick<HostedCustodyReservation, "startId" | "unit" | "creatorId">): void {
  if (!/^[a-f0-9-]{36}$/.test(value.startId) || value.creatorId !== value.startId ||
      ![`subscription-runtime-hosted-${value.startId}.service`, `subscription-runtime-outer-${value.startId}.service`].includes(value.unit)) invalid();
}
function unitGroup(name: string): string {
  if (!/^subscription-runtime-(?:hosted|outer|ordinary)-[a-f0-9-]{36}\.service$/.test(name)) invalid();
  // systemd slice names encode their hierarchy at each dash.
  return `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${name}`;
}
function readTrustedFragment(input: string): Buffer {
  const file = realpathSync(input);
  if (!path(file)) invalid();
  for (let parent = dirname(file);; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) invalid();
    if (parent === "/") break;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) || before.size > 65536) invalid();
    const bytes = Buffer.alloc(65537), length = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
    if (length !== before.size || length > 65536 || before.ctimeMs !== after.ctimeMs || before.size !== after.size) invalid();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) invalid();
  return value as Record<string, unknown>;
}
function unit(value: unknown): value is string { return typeof value === "string" && value.length <= 200 && unitPattern.test(value); }
function path(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && pathPattern.test(value) && !value.split("/").some(part => part === "." || part === ".."); }
function lines(value: string): string[] { return value.split("\n").filter(line => line.trim()); }
function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }

function identity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(value);
}
function parseLaunch(value: unknown): HostedOrdinaryCreator["launch"] {
  const launch = object(value, "args,command,cwd");
  if (!path(launch.command) || !path(launch.cwd) || !Array.isArray(launch.args) || launch.args.length > 128 ||
      !launch.args.every(arg => typeof arg === "string" && arg.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(arg))) invalid();
  return Object.freeze({ command: launch.command, cwd: launch.cwd, args: Object.freeze([...launch.args]) as readonly string[] });
}

function assertOrdinaryReservation(value: HostedOrdinaryReservation): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.startId) ||
      ![`subscription-runtime-ordinary-${value.startId}.service`, `subscription-runtime-hosted-${value.startId}.service`].includes(value.unit)) invalid();
}
function processBirth(pid: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) invalid();
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  if (!stat.startsWith(pid + " (") || stat.lastIndexOf(") ") < 0) invalid();
  const birth = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  if (!birth || !/^[1-9][0-9]{0,19}$/.test(birth)) invalid();
  return `${pid}:${birth}`;
}
export function ordinaryCompletionPath(startId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(startId)) invalid();
  return join(readonlySupervisorRoot, "ordinary-completed", startId + ".json");
}
export function ordinaryCompletionBytes(startId: string, startSha256: string): Buffer {
  ordinaryCompletionPath(startId);
  if (!/^[a-f0-9]{64}$/.test(startSha256)) invalid();
  return Buffer.from(JSON.stringify({ schemaVersion: 1, startId, startSha256, waitStatus: 0 }) + "\n");
}
