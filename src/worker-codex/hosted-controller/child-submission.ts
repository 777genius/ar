import { ScopedTerminationKind, parseRetainedScopeIdentity, stableChildDigest } from "../../worker-core/hosted-custody/domain/scoped-termination";
import { HostedKeyedScopedStopAdapter } from "./scoped-termination-adapter";
import { ScopedTerminationRecords } from "./scoped-termination-records";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdir, rmdir } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assertHostedActivationFence, withHostedActivationFence, assertHostedScopedAdmission, retainHostedScopedSubmitter, readHostedActivationBytes, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../hosted-installation-activation";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "../hosted-readonly-host-kernel";
import { KeyedChildState as State, type ChildCorrelation, type ChildObservation, type ChildScope, type KeyedChildLedger } from "../../worker-core/project-control/domain/keyed-child-launch";
import { KeyedAuthorizationMode as Mode, type KeyedChildApplicationPort, type KeyedDispatchAcknowledgment, type KeyedScopedStopPort } from "../../worker-core/project-control/application/keyed-child-launch";
import { KeyedLaunchLedgerStore } from "./keyed-launch-ledger-store";
import { RetainedKeyedAuthority } from "./retained-authority";
import { SlotMaterialization, type PreparationMaterializationPort } from "./slot-materialization";
import { PreintentPreparationRecords } from "./preintent-preparation-records";
import { PreparationEffect, type OriginalPreparationOwner, type OriginalPreparationQuiescence } from "../../worker-core/hosted-custody/domain/preintent-preparation";
import type { OriginalPreparationCustodyPort } from "../../worker-core/hosted-custody/ports/preintent-preparation";
import { joinOriginalPreparation } from "../../worker-core/hosted-custody/application/preintent-preparation";
import { ScopedStopReason } from "../../worker-core/project-control/ports/keyed-child-application-ports";

/** Installed native owner must supply this exact original operation. There is
 * deliberately no execFile, shell, process scan or reconstructed-PID fallback. */
export interface OwnedPreparationGitCustody extends OriginalPreparationCustodyPort {
  /** Successful completion requires positive discharge of this original Git
   * operation's owned tasks. Exit/timeout alone must reject or remain pending. */
  startGit(effect: PreparationEffect, args: readonly string[], remainingMs: number):
    { readonly completion: Promise<{ readonly stdout: string }> };
}
export interface OwnedPreparationNativePort {
  retain(owner: OriginalPreparationOwner): OwnedPreparationGitCustody;
}

const permissions = new WeakSet<object>();
type PinnedDirectory = { readonly path: string; readonly dev: number; readonly ino: number };
/** Only a fresh successful intent publication creates this ephemeral object.
 * It is consumed before reservation, including on exceptions. Never serialized. */
export interface FreshKeyedSubmission { readonly binding: ChildObservation; readonly retained: RetainedKeyedAuthority }
export function consumeFreshKeyedSubmission(fence: HostedActivationFence, permission: FreshKeyedSubmission): void {
  assertHostedActivationFence(fence);
  if (!permissions.delete(permission)) throw new Error("keyed_submission_permission_required");
  permission.retained.assertCurrent();
  assertHostedScopedAdmission(fence, permission.binding.startId);
}
export interface KeyedHostSubmissionPort {
  submitFresh(fence: HostedActivationFence, permission: FreshKeyedSubmission): { readonly completion: Promise<void> };
}
/** Fixed PR3 command is executed by the existing ordinary bootstrap/parser.
 * No exposed environment, source/account override, detached process or restart. */
export class OrdinaryKeyedChildHost implements KeyedHostSubmissionPort {
  submitFresh(fence: HostedActivationFence, permission: FreshKeyedSubmission): { completion: Promise<void> } {
    consumeFreshKeyedSubmission(fence, permission);
    // PR1–5 retain the admission gate, including direct constructor callers.
    assertKeyedActivationQualified();
    return submitOrdinary(fence, permission);
  }
}
/** Dormant same-fence ordinary composition. Admission remains closed above;
 * this seam persists the ledger's predetermined reservation/start before spawn.
 * It owns a foreground promise, never promotes process exit into proof. */
function submitOrdinary(fence: HostedActivationFence, permission: FreshKeyedSubmission): { completion: Promise<void> } {
  assertHostedActivationFence(fence);
  const slot = permission.retained.slot(permission.binding.slotId), store = new HostedInstallationActivationStore();
  const { installation, activation } = readHostedInstallationActivation(), binding = permission.binding;
  if (!binding.dispatchIntent) throw new Error("scoped_dispatch_intent_required");
  const inventory = readHostedReadonlyHostInventory(), supervisor = inventory.units.find(u => u.name === inventory.supervisorUnit)!;
  const identity = parseRetainedScopeIdentity({ scopeDigest: stableChildDigest(binding, binding.dispatchIntent.generation),
    installationId: installation.installationId, hostId: activation.hostId, bootId: activation.bootId, supervisorId: activation.supervisorId, supervisorUnit: supervisor.name, supervisorControlGroup: supervisor.controlGroup,
    accountId: slot.lifetime.accountId, grantDigest: slot.grantSha256, inventoryDigest: installation.inventorySha256,
    sourceSha: slot.sourceSha, artifactSha: slot.artifactSha, deadlineEpochMs: slot.lifetime.deadlineEpochMs,
    authorityDigest: binding.authorityDigest, slotId: binding.slotId, parentStartId: binding.startId, dispatchIntentGeneration: binding.dispatchIntent.generation });
  const launch = store.reserveOrdinaryRuntime(fence, slot.launch.command, slot.launch.args, slot.launch.cwd,
    { startId: permission.binding.startId, unit: permission.binding.unitCorrelation, identity });
  const invocation = new HostedReadonlyHostKernel().ordinaryRuntimeInvocation(launch.reservation, slot.launch.cwd);
  permission.retained.budget(slot.slotId).remainingMs();
  assertHostedScopedAdmission(fence, permission.binding.startId);
  const child = spawn(invocation.command, [...invocation.args], { cwd: slot.launch.cwd,
    env: {}, stdio: ["pipe", "ignore", "ignore"] });
  // No credentials are read/serialized here. Private provider custody resolves
  // its own credentials; the ordinary bootstrap gets only fixed empty env.
  const completion = new Promise<void>((resolve, reject) => {
    child.stdin.once("error", () => reject(new Error("keyed_submission_uncertain")));
    child.once("error", () => reject(new Error("keyed_submission_uncertain")));
    child.once("exit", () => resolve());
  });
  const records = new ScopedTerminationRecords(() => permission.retained.assertCleanup());
  const companion = records.correlation(binding.startId);
  if (!companion || companion.kind !== ScopedTerminationKind.Runtime) throw new Error("scoped_runtime_companion_required");
  retainHostedScopedSubmitter(fence, companion, child);
  child.stdin.end(Buffer.from(JSON.stringify({ schemaVersion: 1, env: {} })));
  return { completion };
}
function assertKeyedActivationQualified(): void { throw new Error("hosted_mimo_activation_closed"); }

/** Short controller/workspace coordination precedes the common sync host fence.
 * Preparation has separate per-slot ownership, never holds the control queue.
 * On a crash, lock directories persist: no PID takeover or recovery. */
export class KeyedChildDispatchAdapter implements KeyedChildApplicationPort {
  readonly scope: ChildScope;
  readonly authorityDigest: string;
  readonly deadlineEpochMs: number;
  readonly maxGoalTurns: number;
  readonly #parents: readonly PinnedDirectory[];
  #tail: Promise<void> = Promise.resolve();
  readonly #coordination = new AsyncLocalStorage<object>();
  readonly #leases = new WeakSet<object>();
  readonly stopPort: KeyedScopedStopPort;
  readonly #foreground = new Map<string, Promise<void>>();
  readonly #preparation: PreintentPreparationRecords;
  readonly #originalCustody = new Map<string, OwnedPreparationGitCustody>();
  readonly #writers = new Map<string, Promise<void>>();
  readonly #joins = new Map<string, Promise<OriginalPreparationQuiescence | null>>();
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly ledger: KeyedLaunchLedgerStore,
    private readonly materialization: SlotMaterialization | null, private readonly host: KeyedHostSubmissionPort | null,
    stopPort?: KeyedScopedStopPort, private readonly preparationNative?: OwnedPreparationNativePort) {
    retained.assertCleanup();
    withHostedActivationFence(f => retained.retainCleanup(f));
    this.scope = Object.freeze({ projectId: retained.authority.projectId, workstreamId: retained.authority.workstreamId,
      controllerId: retained.authority.controllerId });
    this.authorityDigest = retained.seed.authorityDigest;
    this.deadlineEpochMs = retained.authority.absoluteDeadline; this.maxGoalTurns = retained.authority.maxGoalTurns;
    this.#parents = ["/var/lib/subscription-runtime-host-policy/keyed-child-ledgers",
      ...retained.slots.map(s => s.jobRootDir)].map(path => ({ path, ...lstatSync(path) }));
    this.#preparation = new PreintentPreparationRecords(retained);
    this.stopPort = stopPort ?? new HostedKeyedScopedStopAdapter(retained, this);
  }
  static cleanup(retained: RetainedKeyedAuthority, ledger: KeyedLaunchLedgerStore): KeyedChildDispatchAdapter {
    return new KeyedChildDispatchAdapter(retained, ledger, null, null);
  }
  authenticate(mode = Mode.Work): void { mode === Mode.Cleanup ? this.retained.assertCleanup() : this.retained.assertCurrent(); }
  beforeFreshClaim(slotId: string): void {
    this.retained.budget(slotId).remainingMs();
    const allocation = this.retained.seed.snapshot().slots.find(s => s.slotId === slotId);
    if (!allocation || readHostedActivationBytes(`scoped-terminating/${allocation.startId}.json`)) throw new Error("scoped_termination_fenced");
  }
  async coordinate<T>(action: () => Promise<T>, mode = Mode.Work): Promise<T> {
    const previous = this.#tail; let release!: () => void;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const held: { path: string; dev: number; ino: number }[] = [];
    const lease = Object.freeze({});
    try {
      this.authenticate(mode);
      for (const [i, parent] of this.#parents.entries()) {
        const current = lstatSync(parent.path);
        if (!current.isDirectory() || current.uid !== 0 || (current.mode & 0o022) ||
            current.dev !== parent.dev || current.ino !== parent.ino) throw new Error("keyed_coordination_parent_changed");
        const path = join(parent.path, i === 0 ? `.controller-${this.authorityDigest}.lock` : ".keyed-workspace.lock");
        await mkdir(path, { mode: 0o700 });
        const lock = lstatSync(path); held.push({ path, dev: lock.dev, ino: lock.ino });
      }
      this.#leases.add(lease);
      return await this.#coordination.run(lease, action);
    } finally {
      this.#leases.delete(lease);
      try {
        for (const lock of held.reverse()) {
          const current = lstatSync(lock.path);
          if (!current.isDirectory() || current.dev !== lock.dev || current.ino !== lock.ino) throw new Error("keyed_coordination_changed");
          await rmdir(lock.path);
        }
      } finally { release(); }
    }
  }
  read(mode = Mode.Work): KeyedChildLedger {
    this.#assertCoordination(); this.authenticate(mode);
    return withHostedActivationFence(f => this.ledger.readHeld(f, this.scope, this.authorityDigest));
  }
  transact(scope: ChildScope, authorityDigest: string, generation: number, successor: (l: KeyedChildLedger) => KeyedChildLedger, mode = Mode.Work): Promise<KeyedChildLedger> {
    this.#assertCoordination(); this.authenticate(mode); return this.ledger.transact(scope, authorityDigest, generation, successor);
  }
  transactPreparation(binding: ChildCorrelation, successor: (current: KeyedChildLedger) => KeyedChildLedger): KeyedChildLedger {
    this.#assertCoordination(); this.authenticate();
    return withHostedActivationFence(fence => this.ledger.transactHeld(fence, this.scope, this.authorityDigest,
      binding.generation, current => {
        // Original native admission can close between separate acquisitions
        // without changing ledger generation. Authenticate it in this CAS.
        this.#admissionHeld(fence, binding);
        return successor(current);
      }));
  }
  retainPreparation(binding: ChildCorrelation): void {
    this.#assertCoordination(); this.authenticate();
    withHostedActivationFence(fence => {
      const latest = this.ledger.readHeld(fence, this.scope, this.authorityDigest).observe(this.scope, binding.childHandle);
      if (latest.state !== State.Claimed || latest.generation !== binding.generation) throw new Error("keyed_preparation_ineligible");
      if (!this.materialization) throw new Error("keyed_live_admission_required");
      const owner = this.#preparation.retain(fence, binding, this.materialization.preparationPlanDigest(binding));
      if (!this.preparationNative) throw new Error("preparation_original_native_custody_required");
      const custody = this.preparationNative.retain(owner);
      if (custody.owner.ownershipDigest !== owner.ownershipDigest ||
          custody.owner.preparationGeneration !== owner.preparationGeneration ||
          custody.owner.preparationPlanDigest !== owner.preparationPlanDigest ||
          stableChildDigest(custody.owner.correlation, 0) !== stableChildDigest(binding, 0) ||
          custody.owner.deadlineEpochMs !== owner.deadlineEpochMs || custody.owner.maxGoalTurns !== owner.maxGoalTurns) {
        throw new Error("preparation_original_native_custody_mismatch");
      }
      // Retain the validated original handle even if its admission check fails:
      // cleanup still owns this same operation and must be able to close it.
      this.#originalCustody.set(binding.startId, custody); custody.assertAdmission(binding);
    });
  }
  assertPreparationAdmission(binding: ChildCorrelation): void {
    this.#assertCoordination(); this.authenticate();
    withHostedActivationFence(fence => this.#admissionHeld(fence, binding));
  }
  #admissionHeld(fence: HostedActivationFence, binding: ChildCorrelation): void {
    const latest = this.ledger.readHeld(fence, this.scope, this.authorityDigest).observe(this.scope, binding.childHandle);
    if (latest.generation !== binding.generation || latest.dispatchIntent ||
        ![State.Claimed, State.Materializing, State.Prepared].includes(latest.state)) throw new Error("keyed_preparation_ineligible");
    this.#preparation.assertOpen(fence, binding);
    const custody = this.#originalCustody.get(binding.startId);
    if (!custody) throw new Error("preparation_original_native_custody_required");
    custody.assertAdmission(binding); this.retained.budget(binding.slotId).remainingMs();
  }
  closePreparation(binding: ChildCorrelation, reason: ScopedStopReason): void {
    this.#assertCoordination(); this.authenticate(Mode.Cleanup);
    withHostedActivationFence(fence => {
      const latest = this.ledger.readHeld(fence, this.scope, this.authorityDigest).observe(this.scope, binding.childHandle);
      if (latest.generation !== binding.generation || latest.state !== State.StopRequested || latest.dispatchIntent) {
        throw new Error("keyed_preparation_stop_ineligible");
      }
      try { this.#preparation.close(fence, binding, reason); }
      finally {
        // Durable StopRequested already forbids further admission. A record
        // publication failure must still request closure of original custody;
        // it never proves closure or releases occupancy.
        this.#originalCustody.get(binding.startId)?.requestStop();
      }
    });
    const custody = this.#originalCustody.get(binding.startId);
    if (custody && !this.#joins.has(binding.startId)) {
      // Schedule the exact original join outside this coordination's lease.
      const join = this.#tail.then(() => joinOriginalPreparation(custody,
        this.#writers.get(binding.startId) ?? Promise.resolve(), () => this.materialization?.rereadPartial(binding)));
      this.#joins.set(binding.startId, join);
      void join.catch(() => {}); // Loss/uncertainty remains held; never retry custody.
    }
  }
  #effects(): PreparationMaterializationPort {
    return {
      effect: <T>(binding: ChildCorrelation, effect: PreparationEffect, start: () => T): Promise<T> =>
        this.coordinate(async () => withHostedActivationFence(fence => {
          this.#admissionHeld(fence, binding);
          this.#preparation.prefix(fence, binding, effect);
          // Recheck after durable prefix publication immediately before effect.
          this.#admissionHeld(fence, binding);
          const result = start();
          if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
            throw new Error("preparation_synchronous_effect_required");
          }
          return result;
        })),
      git: async (binding, effect, args, remainingMs) => {
        const original = await this.#effects().effect(binding, effect, () => {
          const started = this.#originalCustody.get(binding.startId)!.startGit(effect, args,
            Math.min(remainingMs, this.retained.budget(binding.slotId).remainingMs()));
          // A synchronous native failure can reject before asynchronous lock
          // release. Observe it immediately, while preserving the original
          // rejected promise for the foreground join and cancellation policy.
          void started.completion.catch(() => {});
          return started;
        });
        // This original foreground operation is joined outside coordination.
        return original.completion;
      },
    };
  }
  async materialize(binding: ChildCorrelation, task: string): Promise<void> {
    if (!this.materialization) throw new Error("keyed_live_admission_required");
    let ownership: PinnedDirectory & { readonly parent: PinnedDirectory } | undefined;
    let settleWriter!: () => void;
    let rejectWriter!: (error: Error) => void;
    let writer: Promise<void> | undefined;
    try {
      await this.coordinate(async () => {
        const latest = this.read().observe(this.scope, binding.childHandle);
        if (latest.state !== State.Materializing || latest.generation !== binding.generation ||
            (["authorityDigest", "keyDigest", "requestDigest", "promptDigest", "slotId", "requestId",
              "operationId", "childHandle", "startId", "unitCorrelation", "profile"] as const)
              .some(field => latest[field] !== binding[field])) throw new Error("keyed_materialization_ineligible");
        // Coordination validates every pinned parent before acquiring ownership.
        // This distinct lock excludes other preparation owners without excluding control.
        const parent = this.#parents.find(p => p.path === this.retained.slot(binding.slotId).jobRootDir)!;
        const path = join(parent.path, ".keyed-materialization.lock");
        await mkdir(path, { mode: 0o700 });
        const lock = lstatSync(path); ownership = { path, dev: lock.dev, ino: lock.ino, parent };
        writer = new Promise<void>((resolve, reject) => { settleWriter = resolve; rejectWriter = reject; });
        void writer.catch(() => {}); // Retain loss as unresolved original ownership.
        this.#writers.set(binding.startId, writer);
      });
      this.authenticate();
      await this.materialization.materialize(binding, task, this.#effects());
    } finally {
      try { if (ownership) {
        const parent = lstatSync(ownership.parent.path), lock = lstatSync(ownership.path);
        if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) ||
            parent.dev !== ownership.parent.dev || parent.ino !== ownership.parent.ino ||
            !lock.isDirectory() || lock.dev !== ownership.dev || lock.ino !== ownership.ino) {
          throw new Error("keyed_materialization_ownership_changed");
        }
        await rmdir(ownership.path);
      } } catch (error) {
        if (writer) rejectWriter(new Error("preparation_original_writer_custody_lost"));
        throw error;
      }
      if (writer) settleWriter();
    }
  }
  dispatchPrepared(binding: ChildCorrelation): KeyedDispatchAcknowledgment {
    this.#assertCoordination(); this.authenticate();
    if (!this.host || !this.materialization) throw new Error("keyed_live_admission_required");
    const host = this.host, materialization = this.materialization;
    return withHostedActivationFence(fence => {
      this.#admissionHeld(fence, binding);
      this.authenticate(); assertHostedScopedAdmission(fence, binding.startId); materialization.verify(binding);
      const current = this.ledger.readHeld(fence, this.scope, this.authorityDigest);
      const latest = current.observe(this.scope, binding.childHandle);
      // Stored intent/absence NEVER mints fresh permission; changed generation fails.
      if (latest.generation !== binding.generation || latest.dispatchIntent || latest.state !== State.Prepared) throw new Error("keyed_dispatch_ineligible");
      const intent = this.ledger.transactHeld(fence, this.scope, this.authorityDigest,
        current.generation, l => l.advance(binding, State.DispatchIntent, Date.now()));
      const permission = Object.freeze({ binding: intent.observe(this.scope, binding.childHandle), retained: this.retained });
      permissions.add(permission);
      try {
        const submitted = host.submitFresh(fence, permission);
        // Retain ownership even if acknowledgment publication fails afterwards.
        const observed = submitted.completion.catch(() => {});
        this.#foreground.set(binding.startId, observed);
        void observed.finally(() => this.#foreground.delete(binding.startId));
        const accepted = this.ledger.transactHeld(fence, this.scope, this.authorityDigest,
          intent.generation, l => l.advance(permission.binding, State.Submitted, Date.now()));
        return { observation: accepted.observe(this.scope, binding.childHandle), completion: submitted.completion };
      } finally { permissions.delete(permission); }
    });
  }
  #assertCoordination(): void {
    const lease = this.#coordination.getStore();
    if (!lease || !this.#leases.has(lease)) throw new Error("keyed_coordination_required");
  }
}
