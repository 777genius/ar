import { readHostedOrdinaryReaderParentCompletion } from "./hosted-ordinary-reader-parent-completion";
import { assertHostedOrdinaryProviderFailureCreator } from "./hosted-ordinary-provider-failure-recovery";
import { assertHostedManagedProviderFailureCreator } from "./hosted-managed-provider-failure-recovery";
import { parseHostedReadonlyHostInventory, type HostedReadonlyHostInventory as LegacyHostedReadonlyHostInventory } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedForegroundRequestDescriptors, type HostedForegroundRequest } from "./hosted-foreground-request-custody";
import { verifyOrdinaryInstallationInventory } from "./hosted-ordinary-installation-census";
import { type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { decodeHostedInventoryBytes, hostedInventoryMaximumBytes, type HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import { ScopedTerminationRecords, scopedFenceIdentity } from "./hosted-controller/scoped-termination-records";
import { assertHostedActivationOperator, observeHostedScopedActorChildren } from "@vioxen/subscription-runtime/provider-codex";
import { scopedDigest, ScopedActorDischargeMethod, parseScopedActorDischarge, type ScopedActorChain, type ScopedActorDischarge, type ScopedCollectedEvidence, type ScopedIdentityEvidence, type ScopedTerminationMember, type ScopedTerminationObservation, type ScopedSignal } from "../worker-core/hosted-custody/domain/scoped-termination";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertHostedProcessDescriptors } from "@vioxen/subscription-runtime/provider-codex";
import { verifySystemBusInfrastructure, verifyPinnedFdCollectorProfile } from "@vioxen/subscription-runtime/provider-codex";
import { readSystemBusInfrastructureField, readFdCollectorProfileField, type FdCollectorProfilePin, type SystemBusInfrastructure } from "@vioxen/subscription-runtime/core";
import { HostedCustodyPhase, HostedCustodyReservationState, type HostedCustodyEpoch, type HostedCustodyReservation, type HostedOrdinaryReservation, type HostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { assertReadonlyHostOperator, decodePrivateJson } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { HostedReadonlyEpochStore, readonlyEpochPath } from "./hosted-readonly-epoch-store";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
import { TrustedCustodyLaunchRole, hostedFdCustodySystemdLaunch } from "./trusted-custody-systemd-launch";
import { assertExactUnitGroup, assertNoQueuedStart, assertPopulatedZero, assertTerminalUnit,
  custodyControlGroup, observedJobUnits, parseScopedManagerJobs } from "./hosted-readonly-observations";
import { collectBootId, collectCgroupProcesses, collectCustodyEvents, collectFutureCreatorShow, collectJobs,
  collectProcessBirth, collectScopedInvocationAnchor, collectScopedRecursiveEmpty, collectUnitInvocation, fenceScopedSubmitter, withScopedCollectionBudget, requestScopedManagerEffect, collectProcessCgroup, collectSelfCgroup, collectUnitNotFound, collectUnitShow } from "./hosted-readonly-linux-collector";

export enum HostedReadonlyRuntimeRole { Supervisor = "supervisor", Runtime = "runtime" }

export type HostedReadonlyHostInventory = LegacyHostedReadonlyHostInventory |
  (Omit<HostedInventoryV5, "systemBusInfrastructure" | "collectorProfile"> & {
    readonly systemBusInfrastructure: SystemBusInfrastructure;
    readonly collectorProfile: FdCollectorProfilePin;
  });
export type { HostedOrdinaryCreator } from "@vioxen/subscription-runtime/worker-core";
const unitPattern = /^[A-Za-z0-9_@.-]+\.(service|scope)$/;
const pathPattern = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Finite independent root inventory. It does not authorize a launch by itself:
 * actual service identities/cgroups, supervisor birth and queued jobs are checked
 * below under the common fence. Unknown scopes/services keep the epoch CLOSED. */
export function readHostedReadonlyHostInventory(): HostedReadonlyHostInventory {
  assertReadonlyHostOperator();
  const bytes = readHostedPrivateBytes(join(readonlySupervisorRoot, "readonly-inventory.json"), hostedInventoryMaximumBytes);
  if (!bytes) invalid();
  const decoded = decodeHostedInventoryBytes(bytes);
  if (decoded && typeof decoded === "object" && "schemaVersion" in decoded && decoded.schemaVersion === 5) {
    const inventory = decoded as HostedInventoryV5;
    const systemBusInfrastructure = readSystemBusInfrastructureField(inventory as unknown as Record<string, unknown>)!, collectorProfile = readFdCollectorProfileField(inventory as unknown as Record<string, unknown>)!;
    if (inventory.supervisorUnit === "dbus.service" || !inventory.units.some(u => u.name === "dbus.service" && u.category === "borrowed" &&
        u.controlGroup === systemBusInfrastructure.service.controlGroup && u.fragmentSha256 === systemBusInfrastructure.service.fragmentSha256)) invalid();
    return Object.freeze({ ...inventory, systemBusInfrastructure, collectorProfile });
  }
  return parseHostedReadonlyHostInventory(decoded);
}

export class HostedReadonlyHostKernel {
  session(): { hostId: string; bootId: string; supervisorId: string } {
    assertReadonlyHostOperator();
    const inventory = readHostedReadonlyHostInventory();
    const hostId = readFileSync("/etc/machine-id", "utf8").trim();
    const bootId = collectBootId();
    if (hostId !== inventory.hostId) invalid();
    const supervisor = this.show(inventory.supervisorUnit);
    const expected = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    assertExactUnitGroup(inventory.supervisorUnit, supervisor, expected.controlGroup);
    if (!/^[1-9]\d*$/.test(supervisor.MainPID ?? "")) invalid();
    if (inventory.schemaVersion === 5 && (bootId !== (inventory as unknown as HostedInventoryV5).bootId ||
        processBirth(supervisor.MainPID!) !== (inventory as unknown as HostedInventoryV5).supervisor.birth)) invalid();
    const callerGroup = collectSelfCgroup();
    // Initial namespace + real cgroup membership, not an inherited env marker.
    if (callerGroup !== `0::${expected.controlGroup}`) {
      const epoch = this.enrolledEpoch(), outer = epoch?.outerRuntime;
      if (!epoch || !outer || outer.state !== HostedCustodyReservationState.Reserved || epoch.bootId !== bootId ||
          callerGroup !== `0::${custodyControlGroup(outer.unit)}`) invalid();
    }
    return { hostId, bootId, supervisorId: processBirth(supervisor.MainPID ?? "") };
  }

  verifyExclusiveInventory(fence?: HostedActivationFence, cleanup = false): void {
    const inventory = readHostedReadonlyHostInventory();
    this.session();
    if (inventory.collectorProfile) verifyPinnedFdCollectorProfile(inventory.collectorProfile);
    if (inventory.systemBusInfrastructure) verifySystemBusInfrastructure(inventory.systemBusInfrastructure);
    if (inventory.schemaVersion === 5) {
      if (!fence) invalid();
      verifyOrdinaryInstallationInventory(inventory as unknown as HostedInventoryV5, fence, cleanup); return;
    }
    if (inventory.schemaVersion !== 1) this.verifyFutureCreators(inventory);
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
      if (current.Id !== outer.unit || current.DropInPaths !== "" || (current.ControlGroup && current.ControlGroup !== custodyControlGroup(outer.unit))) invalid();
    }
    for (const row of inventory.units) {
      const current = this.show(row.name);
      assertExactUnitGroup(row.name, current, row.controlGroup);
      if (!path(current.FragmentPath) ||
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
      const pids = lines(collectCgroupProcesses(relative));
      if (pids.some(pid => !/^[1-9]\d*$/.test(pid))) invalid();
      if (pids.length && !inventory.units.some(row => row.controlGroup === relative) &&
          !(outer?.state === HostedCustodyReservationState.Reserved && relative === custodyControlGroup(outer.unit)) &&
          !(relative === "/init.scope" && pids.length === 1 && pids[0] === "1")) invalid();
      for (const child of readdirSync(absolute, { withFileTypes: true })) {
        if (child.isDirectory()) inspectGroup(relative + "/" + child.name);
      }
    };
    inspectGroup("");
    for (const name of observedJobUnits(collectJobs())) {
      if (!inventory.units.some(row => row.name === name) && !(outer?.state === HostedCustodyReservationState.Reserved && name === outer.unit)) invalid();
    }
  }

  /** Exact initial-host supervisor only, before installation or origin creation.
   * Runtime children cannot migrate identities using their CLI arguments. */
  operatorSession(): { hostId: string; bootId: string; supervisorId: string } {
    const inventory = readHostedReadonlyHostInventory();
    const supervisor = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (collectSelfCgroup() !== `0::${supervisor.controlGroup}` || inventory.schemaVersion === 5 && collectProcessBirth(String(process.pid)) !== (inventory as unknown as HostedInventoryV5).supervisor.birth) invalid();
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
    const bootId = collectBootId();
    assertExactUnitGroup(owner.name, supervisor, owner.controlGroup);
    assertExactUnitGroup(start.unit, current, start.controlGroup);
    const modern = inventory.schemaVersion === 5 ? inventory as unknown as HostedInventoryV5 : undefined;
    const expectedDropIns = modern?.units.find(u => u.name === modern.supervisorUnit)!.dropIns;
    if (expectedDropIns) for (const pin of expectedDropIns) if (hash(readTrustedFragment(pin.path)) !== pin.sha256) invalid();
    if (hostId !== inventory.hostId || bootId !== start.bootId || supervisor.DropInPaths !== (expectedDropIns?.map(p => p.path).join(" ") ?? "") ||
        !path(supervisor.FragmentPath) || hash(readTrustedFragment(supervisor.FragmentPath)) !== owner.fragmentSha256 ||
        current.DropInPaths !== "" ||
        !/^[1-9]\d*$/.test(current.MainPID ?? "") ||
        collectSelfCgroup() !== `0::${start.controlGroup}`) invalid();
    const supervisorId = processBirth(supervisor.MainPID ?? "");
    const creatorPid = start.creatorPidBirth.split(":")[0]!;
    if (supervisorId !== start.supervisorId || processBirth(creatorPid) !== start.creatorPidBirth ||
        collectProcessCgroup(creatorPid) !== `0::${owner.controlGroup}`) invalid();
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
      const result = collectFutureCreatorShow(name);
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
      if (fields.length < 2 || fields.length > 3 || (!inventory.units.some(row => row.name === fields[0]) &&
          !(inventory.systemBusInfrastructure && fields[0] === "dbus.socket"))) invalid();
    }
    for (const line of lines(this.systemctl(["list-units", "--all", "--type=socket,timer",
      "--state=active,activating,reloading,deactivating", "--no-legend", "--plain", "--no-pager"]))) {
      if (!inventory.systemBusInfrastructure || line.trim().split(/\s+/)[0] !== "dbus.socket") invalid();
    }
    for (const name of observedJobUnits(collectJobs())) {
      if (inventory.disabledCreators.includes(name)) invalid();
    }
  }

  verifyDescriptorBoundary(original?: Readonly<{ request: HostedForegroundRequest; fence: HostedActivationFence;
    command: string; args: readonly string[]; cwd: string }>): void {
    if (original) assertHostedForegroundRequestDescriptors(original.request, original.fence, original);
    else assertHostedProcessDescriptors();
  }

  /** A same-boot reservation needs the trusted --wait completion receipt. PID
   * absence or a killed proxy is deliberately insufficient. Failed/ambiguous
   * starts stay held; this adapter does not fabricate a terminal receipt. */
  fenceCreator(reservation: HostedCustodyReservation, recordedBootId: string, recoveryFence?: HostedActivationFence): void {
    if (recordedBootId !== this.session().bootId) return;
    const bytes = readHostedPrivateBytes(completionPath(reservation), 4096);
    if (bytes?.equals(completionBytes(reservation, 0))) return;
    // Outer remains status0-only. A token-less legacy call still fails closed;
    // only the trusted recovery owner can pass its already-held genuine fence.
    assertUnitReservation(reservation);
    if (!recoveryFence || reservation.unit !== `subscription-runtime-hosted-${reservation.startId}.service`) {
      throw new Error("hosted_custody_creator_not_fenced");
    }
    assertHostedManagedProviderFailureCreator(recoveryFence,reservation.startId);
  }
  drainQueuedStart(reservation: HostedCustodyReservation): void {
    assertUnitReservation(reservation);
    this.drainUnitQueue(reservation.unit);
  }
  private drainUnitQueue(unit: string): void {
    // No cancellation/absence is promoted into proof. After the creator has
    // been fenced, any remaining manager job keeps the reservation held.
    assertNoQueuedStart(collectJobs(), unit);
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
      if (!collectUnitNotFound(unit)) invalid();
      current = { MainPID: "0", ControlGroup: "" };
    }
    assertTerminalUnit(unit, current);
    const events = collectCustodyEvents(unit);
    if (events.kind === "present") assertPopulatedZero(events.text);
    // Absence is useful only after independent creator and queue fencing; the
    // application calls those operations first, under the same host mutex.
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
  fenceOrdinaryCreator(reservation: HostedOrdinaryReservation, recordedBoot: string, startSha256: string, fence?: HostedActivationFence): void {
    assertOrdinaryReservation(reservation);
    if (recordedBoot !== this.operatorSession().bootId) return;
    const bytes = readHostedPrivateBytes(ordinaryCompletionPath(reservation.startId), 4096);
    if (!bytes || !bytes.equals(ordinaryCompletionBytes(reservation.startId, startSha256))) {
      if (!bytes && fence && reservation.unit === `subscription-runtime-hosted-${reservation.startId}.service`) {
        assertHostedOrdinaryProviderFailureCreator(fence,reservation.startId,startSha256); return;
      }
      if (!bytes && fence && reservation.unit===`subscription-runtime-ordinary-${reservation.startId}.service`) {
        readHostedOrdinaryReaderParentCompletion(fence,reservation.startId,startSha256);return;
      }
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

  #scopedIdentity(member: ScopedTerminationMember, fencing = false): ScopedIdentityEvidence {
    assertReadonlyHostOperator();
    const identity = member.identity, supervisor = collectUnitShow(identity.supervisorUnit);
    const evidence: ScopedIdentityEvidence = { hostId: readFileSync("/etc/machine-id", "utf8").trim(), bootId: collectBootId(),
      supervisorBirth: collectProcessBirth(supervisor.MainPID!), supervisorGroup: collectProcessCgroup(supervisor.MainPID!).replace(/^0::/, ""),
      invocationId: collectUnitInvocation(member.unit), invocationAnchor: collectScopedInvocationAnchor(member.unit), unitGroup: collectUnitShow(member.unit).ControlGroup!,
      creatorBirth: null, creatorGroup: null };
    if (evidence.hostId !== identity.hostId || evidence.bootId !== identity.bootId || evidence.supervisorBirth !== identity.supervisorId ||
        evidence.supervisorGroup !== identity.supervisorControlGroup || supervisor.ControlGroup !== identity.supervisorControlGroup || evidence.invocationId !== member.invocationId || evidence.invocationAnchor.invocationId !== member.invocationId || evidence.unitGroup !== member.controlGroup) invalid();
    const pid = member.creatorPidBirth.split(":")[0]!;
    try {
      const creatorBirth = collectProcessBirth(pid), creatorGroup = collectProcessCgroup(pid).replace(/^0::/, "");
      if (creatorBirth !== member.creatorPidBirth || creatorGroup !== member.creatorControlGroup) invalid();
      return { ...evidence, creatorBirth, creatorGroup };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // An absent creator is usable ONLY with retained positive discharge of the
      // complete authenticated chain, including that exact original creator.
      const records = new ScopedTerminationRecords(assertHostedActivationOperator), marker = records.terminating(member.identity.parentStartId);
      if (!records.discharge(member) && !(fencing && marker && scopedDigest(marker.identity) === scopedDigest(scopedFenceIdentity(member.identity)) && records.actorChain(member))) throw e;
      return evidence;
    }
  }
  assertScopedIdentity(member: ScopedTerminationMember, remainingMs = 1000): void {
    withScopedCollectionBudget(remainingMs, () => { this.#scopedIdentity(member); });
  }
  fenceScopedSubmitter(member: ScopedTerminationMember, chain: ScopedActorChain, remainingMs: number): ScopedActorDischarge {
    return withScopedCollectionBudget(remainingMs, () => {
      const end = performance.now() + remainingMs;
      const records = new ScopedTerminationRecords(assertHostedActivationOperator), retained = records.actorChain(member);
      if (scopedDigest(chain) !== scopedDigest(retained)) invalid();
      this.#scopedIdentity(member, true);
      const marker = records.terminating(member.identity.parentStartId);
      if (!marker || scopedDigest(marker.identity) !== scopedDigest(scopedFenceIdentity(member.identity))) invalid();
      // Reobserve every live admitted submitter, including all nonleader tasks.
      // Absence supplies no discharge: the pidfd collector below still owes an
      // independent positive exit for every retained noncreator.
      const observeMembership = () => {
        const live = chain.actors.slice(1).filter(actor => {
          try { if (collectProcessBirth(actor.pidBirth.split(":")[0]!) !== actor.pidBirth) invalid(); return true; }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return false; }
        });
        return live.map(actor => {
          const snapshot = observeHostedScopedActorChildren(actor, end);
          const expected = live.filter(a => a.parentPidBirth === actor.pidBirth).map(a => a.pidBirth.split(":")[0]!).sort();
          if (JSON.stringify(snapshot.children) !== JSON.stringify(expected)) invalid();
          const parent = chain.actors.find(a => a.pidBirth === actor.parentPidBirth)!;
          let parentLive = false;
          try { parentLive = collectProcessBirth(parent.pidBirth.split(":")[0]!) === parent.pidBirth; }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          // An exited original parent permits reparenting; never substitute that
          // parent's birth or skip observing the actual surviving actor.
          if (parentLive && snapshot.tasks.some(t => t.parent !== parent.pidBirth.split(":")[0])) invalid();
          return { birth: actor.pidBirth, snapshot };
        });
      };
      const membership = observeMembership();
      if (scopedDigest(membership) !== scopedDigest(observeMembership())) invalid();
      // Every enqueue-capable task is pinned independently; wrapper exit alone
      // cannot discharge a surviving systemd-run or original scoped creator.
      for (const actor of chain.actors.slice(1).reverse()) fenceScopedSubmitter(actor.pidBirth, actor.controlGroup, Math.floor(end - performance.now()));
      return parseScopedActorDischarge({ schemaVersion: 2, chainDigest: scopedDigest(chain), fenceDigest: scopedDigest(marker),
        actors: chain.actors.map((a, i) => ({ ...a, method: i === 0 ? ScopedActorDischargeMethod.ScopedAdmissionFence : ScopedActorDischargeMethod.PidfdExit })) }, chain);
    });
  }
  drainScopedQueue(member: ScopedTerminationMember, remainingMs: number): void {
    return withScopedCollectionBudget(remainingMs, () => {
      const end = performance.now() + remainingMs;
      for (const job of parseScopedManagerJobs(collectJobs()).filter(job => job.unit === member.unit)) {
        this.assertScopedIdentity(member, Math.max(1, Math.floor(end - performance.now())));
        const fresh = parseScopedManagerJobs(collectJobs()).find(row => row.id === job.id);
        if (!fresh || fresh.unit !== job.unit || fresh.type !== job.type) invalid();
        const left = Math.floor(end - performance.now()); if (left < 1) invalid();
        requestScopedManagerEffect(["cancel", job.id], left);
      }
      if (parseScopedManagerJobs(collectJobs()).some(job => job.unit === member.unit)) invalid();
    });
  }
  signalScoped(member: ScopedTerminationMember, signal: ScopedSignal, remainingMs: number): void {
    return withScopedCollectionBudget(remainingMs, () => {
      const end = performance.now() + remainingMs;
      this.assertScopedIdentity(member, Math.max(1, Math.floor(end - performance.now())));
      requestScopedManagerEffect(["kill", `--signal=${signal}`, "--kill-whom=all", "--", member.unit], Math.floor(end - performance.now()));
      this.assertScopedIdentity(member, Math.max(1, Math.floor(end - performance.now())));
      requestScopedManagerEffect(["stop", "--no-block", "--", member.unit], Math.floor(end - performance.now()));
    });
  }
  /** Nonblocking checks of retained capabilities and pinned birth identities.
   * Manager queries and waits remain exclusively in lock-free collection. */
  validateScopedPublication(member: ScopedTerminationMember, evidence: ScopedCollectedEvidence): void {
    assertReadonlyHostOperator();
    const records = new ScopedTerminationRecords(assertHostedActivationOperator), discharge = records.discharge(member);
    if (!discharge || scopedDigest(discharge) !== scopedDigest(evidence.discharge) || scopedDigest(records.actorChain(member)) !== scopedDigest(evidence.chain) ||
        readFileSync("/etc/machine-id", "utf8").trim() !== member.identity.hostId || collectBootId() !== member.identity.bootId ||
        collectProcessBirth(member.identity.supervisorId.split(":")[0]!) !== member.identity.supervisorId ||
        collectProcessCgroup(member.identity.supervisorId.split(":")[0]!) !== `0::${member.identity.supervisorControlGroup}`) invalid();
    if (scopedDigest(collectScopedInvocationAnchor(member.unit)) !== scopedDigest(evidence.identityAfter.invocationAnchor)) invalid();
    for (const node of evidence.cgroups) {
      const current = lstatSync("/sys/fs/cgroup" + node.path);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== node.device || current.ino !== node.inode) invalid();
    }
    for (const actor of evidence.chain.actors.slice(1)) {
      try { if (collectProcessBirth(actor.pidBirth.split(":")[0]!) === actor.pidBirth) invalid(); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  }
  collectScoped(member: ScopedTerminationMember, remainingMs: number): ScopedTerminationObservation {
    return withScopedCollectionBudget(remainingMs, () => {
      const end = performance.now() + remainingMs, records = new ScopedTerminationRecords(assertHostedActivationOperator);
      const chain = records.actorChain(member), discharge = records.discharge(member);
      if (!discharge) throw new Error("scoped_creator_discharge_required");
      const identityBefore = this.#scopedIdentity(member), queueBefore = collectJobs();
      const queue = parseScopedManagerJobs(queueBefore), tree = collectScopedRecursiveEmpty(member.controlGroup, Math.floor(end - performance.now()));
      const identityAfter = this.#scopedIdentity(member), queueAfter = collectJobs(); parseScopedManagerJobs(queueAfter);
      if (queueBefore !== queueAfter || scopedDigest(identityBefore) !== scopedDigest(identityAfter)) invalid();
      const evidence = { schemaVersion: 1 as const, memberDigest: scopedDigest(member), chain, discharge, identityBefore, identityAfter, queueBefore, queueAfter, cgroups: tree.nodes };
      return Object.freeze({ startId: member.startId, identityUnchanged: true, creatorFenced: true,
        queueEmpty: !queue.some(row => row.unit === member.unit), recursiveEmpty: tree.empty, digest: scopedDigest(evidence), evidence });
    });
  }

  assertRuntimeLaunch(epoch: HostedCustodyEpoch, command: string, args: readonly string[], cwd: string): void {
    const inventory = readHostedReadonlyHostInventory();
    const actual = this.session();
    const owner = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (collectSelfCgroup() !== `0::${owner.controlGroup}`) invalid();
    if (epoch.hostId !== actual.hostId || epoch.bootId !== actual.bootId || epoch.supervisorId !== actual.supervisorId ||
        command !== inventory.runtimeLaunch.command || cwd !== inventory.runtimeLaunch.cwd ||
        JSON.stringify(args) !== JSON.stringify(inventory.runtimeLaunch.args)) {
      throw new Error("hosted_custody_runtime_launch_denied");
    }
  }
  runtimeRole(): HostedReadonlyRuntimeRole {
    const inventory = readHostedReadonlyHostInventory();
    const owner = inventory.units.find(row => row.name === inventory.supervisorUnit)!;
    if (collectSelfCgroup() === `0::${owner.controlGroup}`) {
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
        collectSelfCgroup() !== `0::${custodyControlGroup(outer.unit)}`) invalid();
    const actual = this.session();
    if (epoch.hostId !== actual.hostId || epoch.bootId !== actual.bootId || epoch.supervisorId !== actual.supervisorId) invalid();
    const current = this.show(outer.unit);
    assertExactUnitGroup(outer.unit, current, custodyControlGroup(outer.unit));
    if (!/^[1-9]\d*$/.test(current.MainPID ?? "")) invalid();
  }
  runtimeInvocation(record: Pick<HostedCustodyReservation, "startId" | "unit" | "creatorId">,
    command: string, args: readonly string[], cwd: string): { command: string; args: readonly string[] } {
    assertUnitReservation(record);
    if (!record.unit.startsWith("subscription-runtime-outer-")) invalid();
    return hostedFdCustodySystemdLaunch(TrustedCustodyLaunchRole.Outer, record.startId, cwd);
  }
  ordinaryRuntimeInvocation(record: HostedOrdinaryReservation, cwd: string): { command: string; args: readonly string[] } {
    assertOrdinaryReservation(record);
    if (record.unit !== `subscription-runtime-ordinary-${record.startId}.service` || !path(cwd)) invalid();
    return hostedFdCustodySystemdLaunch(TrustedCustodyLaunchRole.Ordinary, record.startId, cwd);
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
    return collectUnitShow(name);
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
export function readTrustedFragment(input: string, maximum = 65536): Buffer {
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
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) || before.size > maximum) invalid();
    const bytes = Buffer.alloc(maximum + 1), length = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
    if (length !== before.size || length > maximum || before.ctimeMs !== after.ctimeMs || before.size !== after.size) invalid();
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function unit(value: unknown): value is string { return typeof value === "string" && value.length <= 200 && unitPattern.test(value); }
function path(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && pathPattern.test(value) && !value.split("/").some(part => part === "." || part === ".."); }
function lines(value: string): string[] { return value.split("\n").filter(line => line.trim()); }
function invalid(): never { throw new Error("hosted_custody_kernel_evidence_invalid"); }

function assertOrdinaryReservation(value: HostedOrdinaryReservation): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.startId) ||
      ![`subscription-runtime-ordinary-${value.startId}.service`, `subscription-runtime-hosted-${value.startId}.service`].includes(value.unit)) invalid();
}
function processBirth(pid: string): string {
  return collectProcessBirth(pid);
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
