import { assertHostedActivationFence, withHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedCustodyReservationState, parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { TerminateOwnedScope } from "../../worker-core/hosted-custody/application/terminate-owned-scope";
import { ScopedTerminationKind, ScopedTerminationCause, ScopedTerminationOutcome, ScopedTerminationReason, OrdinaryTerminationValidator, ScopedTerminationValidator,
  parseScopedOperation, parseScopedReceipt, scopedDigest, stableChildDigest, type ScopedSignal,
  type ScopedTerminationMember, type ScopedTerminationObservation, type ScopedTerminationOperation, type ScopedTerminationReceipt } from "../../worker-core/hosted-custody/domain/scoped-termination";
import { KeyedAuthorizationMode as Mode, ScopedStopResult, type KeyedChildApplicationPort, type KeyedScopedStopPort, ScopedStopReason, type ScopedStopResponse } from "../../worker-core/project-control/ports/keyed-child-application-ports";
import { type ChildCorrelation, type ChildObservation } from "../../worker-core/project-control/domain/keyed-child-launch";
import { ScopedTerminationProofKind, type KeyedChildTerminationReceiptValidationPort } from "../../worker-core/project-control/ports/keyed-child-launch-ports";
import type { ScopedTerminationPort } from "../../worker-core/hosted-custody/ports/scoped-termination-port";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../hosted-installation-activation";
import { HostedReadonlyHostKernel } from "../hosted-readonly-host-kernel";
import { RetainedKeyedAuthority } from "./retained-authority";
import { ScopedTerminationRecords, scopedRecordDigest } from "./scoped-termination-records";

/** Installed host implementation only. Tests supply an independent manager graph;
 * stop returns do not mutate its queue, creator or descendant observations. */
export interface ScopedTerminationKernelPort {
  assertScopedIdentity(member: ScopedTerminationMember, remainingMs?: number): void;
  fenceScopedSubmitter(member: ScopedTerminationMember, submitter: import("../../worker-core/hosted-custody/domain/scoped-termination").ScopedSubmitter, remainingMs: number): void;
  drainScopedQueue(member: ScopedTerminationMember, remainingMs: number): void;
  signalScoped(member: ScopedTerminationMember, signal: ScopedSignal, remainingMs: number): void;
  collectScoped(member: ScopedTerminationMember, remainingMs: number, creatorFenced: boolean): ScopedTerminationObservation;
}
type Coordination = Pick<KeyedChildApplicationPort, "coordinate" | "read" | "transact" | "scope" | "authorityDigest">;
function sameChild(a: ChildCorrelation, b: ChildCorrelation): boolean {
  return stableChildDigest(a, 1) === stableChildDigest(b, 1);
}
/** No live grant or dispatcher is consulted for retained cleanup. Authentication
 * and stable target validation precede correlation, termination or receipt reads. */
export class HostedKeyedScopedStopAdapter implements KeyedScopedStopPort {
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly app: Coordination,
    private readonly kernel: ScopedTerminationKernelPort = new HostedReadonlyHostKernel(), private readonly cleanupBudgetMs = 10_000) {
    retained.assertCleanup();
    if (app.authorityDigest !== retained.seed.authorityDigest || scopedDigest(app.scope) !== scopedDigest({ projectId: retained.authority.projectId,
      workstreamId: retained.authority.workstreamId, controllerId: retained.authority.controllerId })) throw new Error("scoped_foreign_owner");
  }
  async request(binding: ChildCorrelation, reason: ScopedStopReason): Promise<ScopedStopResponse> {
    try {
      this.retained.assertCleanup();
      const target = await this.app.coordinate(async () => {
        const latest = this.app.read(Mode.Cleanup).observe(this.app.scope, binding.childHandle);
        if (!sameChild(latest, binding) || !latest.dispatchIntent) throw new Error("scoped_foreign_target");
        return latest;
      }, Mode.Cleanup);
      const reasons = new Map([[ScopedStopReason.Requested, ScopedTerminationReason.Requested], [ScopedStopReason.Deadline, ScopedTerminationReason.Deadline],
        [ScopedStopReason.Budget, ScopedTerminationReason.Budget], [ScopedStopReason.Completion, ScopedTerminationReason.Completion]]);
      const terminationReason = reasons.get(reason); if (!terminationReason) throw new Error("scoped_reason_invalid");
      const owned = new OwnedScopeProofAdapter(this.retained, this.app, target, this.kernel);
      // A retained strict receipt is replayed exactly. No new IDs/observations or
      // submit permission are reconstructed, even if sibling generations advance.
      if (!(await owned.replay())) {
        const result = await new TerminateOwnedScope(owned, this.cleanupBudgetMs).execute(terminationReason);
        if (result.outcome !== ScopedTerminationOutcome.ReceiptBacked) return { outcome: ScopedStopResult.Unresolved, cause: result.cause };
      }
      await owned.finalize(); return { outcome: ScopedStopResult.ReceiptBacked, proof: await owned.references() };
    } catch { return { outcome: ScopedStopResult.Unresolved, cause: ScopedTerminationCause.Publication }; }
  }
}
class OwnedScopeProofAdapter implements ScopedTerminationPort, KeyedChildTerminationReceiptValidationPort {
  readonly #records: ScopedTerminationRecords;
  readonly #activation = new HostedInstallationActivationStore();
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly app: Coordination,
    private readonly target: ChildObservation, private readonly kernel: ScopedTerminationKernelPort) {
    this.authenticate(); this.#records = new ScopedTerminationRecords(() => this.authenticate());
  }
  authenticate(): void {
    this.retained.assertCleanup();
    const allocation = this.retained.seed.snapshot().slots.find(s => s.slotId === this.target.slotId);
    if (!allocation || !this.target.dispatchIntent || this.target.authorityDigest !== this.retained.seed.authorityDigest ||
        Object.keys(allocation).some(k => allocation[k as keyof typeof allocation] !== this.target[k as keyof ChildObservation])) throw new Error("scoped_foreign_target");
  }
  #fresh(): ChildObservation {
    this.authenticate();
    const latest = this.app.read(Mode.Cleanup).observe(this.app.scope, this.target.childHandle);
    if (!sameChild(latest, this.target) || latest.dispatchIntent?.generation !== this.target.dispatchIntent!.generation) throw new Error("scoped_changed_target");
    return latest;
  }
  #coordinate<T>(action: (f: HostedActivationFence, latest: ChildObservation) => T): Promise<T> {
    return this.app.coordinate(async () => {
      const latest = this.#fresh(); return withHostedActivationFence(f => action(f, latest));
    }, Mode.Cleanup);
  }
  #runtime() {
    const correlation = this.#records.correlation(this.target.startId), slot = this.retained.cleanupSlot(this.target.slotId);
    const { installation, activation } = readHostedInstallationActivation();
    if (!correlation || correlation.kind !== ScopedTerminationKind.Runtime || correlation.identity.scopeDigest !== stableChildDigest(this.target, this.target.dispatchIntent!.generation) ||
        correlation.identity.authorityDigest !== this.target.authorityDigest || correlation.identity.slotId !== slot.slotId ||
        correlation.identity.parentStartId !== this.target.startId || correlation.identity.accountId !== slot.lifetime.accountId ||
        correlation.identity.deadlineEpochMs !== slot.lifetime.deadlineEpochMs || correlation.identity.grantDigest !== slot.grantSha256 ||
        correlation.identity.sourceSha !== slot.sourceSha || correlation.identity.artifactSha !== slot.artifactSha ||
        correlation.identity.dispatchIntentGeneration !== this.target.dispatchIntent!.generation ||
        correlation.identity.installationId !== installation.installationId || correlation.identity.inventoryDigest !== installation.inventorySha256 ||
        correlation.identity.hostId !== activation.hostId || correlation.identity.bootId !== activation.bootId || correlation.identity.supervisorId !== activation.supervisorId) throw new Error("scoped_runtime_correlation_invalid");
    return { correlation, activation };
  }
  #members(): readonly ScopedTerminationMember[] {
    const { correlation: runtime, activation } = this.#runtime();
    const runtimeRow = activation.ordinaryStarts.find(row => row.startId === this.target.startId);
    if (!runtimeRow) throw new Error("scoped_runtime_missing");
    // Discovery begins with reservations, including rows lacking companion bytes.
    return activation.ordinaryStarts.filter(row => row.creatorId === runtimeRow.creatorId && row.originSha256 === runtimeRow.originSha256).map(row => {
      const bytes = readHostedActivationBytes(`ordinary-starts/${row.startId}.json`), companion = this.#records.correlation(row.startId), invocation = this.#records.invocation(row.startId);
      const submitter = this.#records.submitter(row.startId), submitterBytes = this.#records.read("ordinary-submitters", row.startId);
      if (!bytes || !companion || !invocation || !submitter || !submitterBytes) throw new Error("scoped_partial_correlation");
      const start = parseHostedOrdinaryStart(decodeHostedActivationBytes(bytes)), slot = this.retained.cleanupSlot(this.target.slotId);
      if (companion.startDigest !== scopedRecordDigest(bytes) || companion.parentStartDigest !== runtime.startDigest ||
          scopedDigest(companion.identity) !== scopedDigest(runtime.identity) || companion.reservationGeneration !== row.generation ||
          companion.unit !== row.unit || start.unit !== row.unit || start.activationGeneration !== row.generation || start.creatorId !== row.creatorId ||
          start.originSha256 !== row.originSha256 || start.creatorPidBirth !== companion.creatorPidBirth || start.controlGroup !== companion.controlGroup ||
          start.installationId !== runtime.identity.installationId || start.bootId !== runtime.identity.bootId || start.supervisorId !== runtime.identity.supervisorId ||
          start.grantSha256 !== runtime.identity.grantDigest || start.jobId !== slot.jobId || start.jobRootDir !== slot.jobRootDir ||
          start.workspacePath !== slot.workspacePath || invocation.correlationDigest !== scopedDigest(companion) || submitter.correlationDigest !== scopedDigest(companion)) throw new Error("scoped_companion_invalid");
      return Object.freeze({ ...companion, invocationId: invocation.invocationId, submitterDigest: scopedRecordDigest(submitterBytes) });
    });
  }
  async begin(_reason: ScopedTerminationReason): Promise<ScopedTerminationOperation> {
    return this.#coordinate(f => {
      const { correlation, activation } = this.#runtime(), row = activation.ordinaryStarts.find(r => r.startId === this.target.startId);
      if (!row) throw new Error("scoped_runtime_missing");
      const ids = activation.ordinaryStarts.filter(r => r.creatorId === row.creatorId && r.originSha256 === row.originSha256).map(r => r.startId);
      const prior = this.#records.terminating(this.target.startId);
      const marker = prior ?? { schemaVersion: 1 as const, identity: correlation.identity, operationGeneration: activation.generation, reservationIds: ids };
      if (scopedDigest(marker.identity) !== scopedDigest(correlation.identity) || scopedDigest(marker.reservationIds) !== scopedDigest(ids)) throw new Error("scoped_marker_conflict");
      // Durable marker FIRST, even when incomplete rows make discovery fail.
      this.#records.retainMarker(f, marker);
      const operation = parseScopedOperation({ schemaVersion: 1, identity: correlation.identity, operationGeneration: marker.operationGeneration, members: this.#members() });
      this.#records.retainOperation(f, operation); return operation;
    });
  }
  async fenceCreator(member: ScopedTerminationMember, remainingMs: number): Promise<void> {
    this.authenticate(); this.kernel.assertScopedIdentity(member, remainingMs);
    const submitter = this.#records.submitter(member.startId);
    if (!submitter || !this.#records.terminating(this.target.startId)) throw new Error("scoped_creator_unfenced");
    if (this.#records.submitterExited(member.startId, member.submitterDigest)) return;
    // pidfd observation and bounded waiting occur outside coordination/fence.
    this.kernel.fenceScopedSubmitter(member, submitter, remainingMs);
    await this.#coordinate(f => {
      if (scopedDigest(this.#members()) !== scopedDigest(this.#records.operation(this.target.startId)!.members)) throw new Error("scoped_snapshot_changed");
      this.#records.retainSubmitterExit(f, member.startId, member.submitterDigest);
    });
  }
  async drainQueue(member: ScopedTerminationMember, remainingMs: number): Promise<void> { this.authenticate(); this.kernel.drainScopedQueue(member, remainingMs); }
  async signal(member: ScopedTerminationMember, signal: ScopedSignal, remainingMs: number): Promise<void> { this.authenticate(); this.kernel.signalScoped(member, signal, remainingMs); }
  async collect(member: ScopedTerminationMember, remainingMs: number): Promise<ScopedTerminationObservation> {
    this.authenticate(); return this.kernel.collectScoped(member, remainingMs, this.#records.submitterExited(member.startId, member.submitterDigest));
  }
  #validateReceipt(digest: string, requireTerminal: boolean): ScopedTerminationReceipt {
    const receipt = this.#records.receipt(this.target.startId), bytes = this.#records.read("scoped-receipts", this.target.startId);
    const operation = this.#records.operation(this.target.startId), marker = this.#records.terminating(this.target.startId);
    if (!receipt || !bytes || !operation || !marker || scopedRecordDigest(bytes) !== digest ||
        scopedDigest(receipt.operation) !== scopedDigest(operation) || scopedDigest(marker.identity) !== scopedDigest(operation.identity) ||
        marker.operationGeneration !== operation.operationGeneration || scopedDigest(marker.reservationIds) !== scopedDigest(operation.members.map(m => m.startId)) ||
        scopedDigest(operation.members) !== scopedDigest(this.#members())) throw new Error("scoped_receipt_invalid");
    this.#records.validateObservations(receipt);
    const activation = this.#activation.read();
    if (requireTerminal && operation.members.some(member => activation.ordinaryStarts.find(row => row.startId === member.startId)?.state !== HostedCustodyReservationState.Terminal)) throw new Error("scoped_ordinary_not_terminal");
    return receipt;
  }
  async publish(operation: ScopedTerminationOperation, observations: readonly ScopedTerminationObservation[], remainingMs: number): Promise<ScopedTerminationReceipt> {
    const end = performance.now() + remainingMs;
    // Fresh independent collection after lock-free observation. No long waits or
    // collectors under coordination; every identity is checked again under fence.
    const fresh = [];
    for (const member of operation.members) fresh.push(await this.collect(member, Math.floor(end - performance.now())));
    const receiptObservations = fresh.map((o, i) => {
      if (o.digest !== observations[i]?.digest) throw new Error("scoped_observation_changed"); return o;
    });
    return this.#coordinate(f => {
      if (scopedDigest(operation) !== scopedDigest(this.#records.operation(this.target.startId)) || scopedDigest(operation.members) !== scopedDigest(this.#members())) throw new Error("scoped_snapshot_changed");
      for (const member of operation.members) this.kernel.assertScopedIdentity(member, Math.floor(end - performance.now()));
      const receipt = parseScopedReceipt({ schemaVersion: 1, outcome: ScopedTerminationOutcome.ReceiptBacked, operation,
        publicationGeneration: this.#activation.read().generation, observations: receiptObservations });
      this.#records.retainObservations(f, receipt);
      const digest = this.#records.retainReceipt(f, receipt); // file + ALL parents fsync first
      this.#activation.publishScopedTerminal(f, new OrdinaryTerminationValidator(d => this.#validateReceipt(d, false)).authorize(digest)); return receipt;
    });
  }
  async replay(): Promise<boolean> {
    return this.#coordinate(f => {
      const receipt = this.#records.receipt(this.target.startId); if (!receipt) return false;
      const bytes = this.#records.read("scoped-receipts", this.target.startId)!;
      const digest = scopedRecordDigest(bytes); this.#validateReceipt(digest, false);
      this.#records.retainReceipt(f, receipt); // repair exact interrupted durability only
      this.#activation.publishScopedTerminal(f, new OrdinaryTerminationValidator(d => this.#validateReceipt(d, false)).authorize(digest)); return true;
    });
  }
  async references() {
    return this.#coordinate((_f, latest) => {
      const bytes = this.#records.read("scoped-receipts", this.target.startId)!;
      const receipt = this.#validateReceipt(scopedRecordDigest(bytes), true);
      return Object.freeze({ kind: ScopedTerminationProofKind.ReceiptBacked, scope: this.app.scope, correlation: latest,
        receiptDigest: scopedRecordDigest(bytes), activationGeneration: receipt.publicationGeneration,
        runtimeProofDigest: scopedDigest(receipt.observations.filter(o => o.startId === this.target.startId)),
        providerProofDigest: scopedDigest(receipt.observations.filter(o => o.startId !== this.target.startId)) });
    });
  }
  validate(scope: import("../../worker-core/project-control/domain/keyed-child-launch").ChildScope,
    binding: ChildCorrelation, receiptDigest: string) {
    this.authenticate();
    if (scope.projectId !== this.app.scope.projectId || scope.workstreamId !== this.app.scope.workstreamId ||
        scope.controllerId !== this.app.scope.controllerId || !sameChild(binding, this.target)) throw new Error("scoped_foreign_target");
    return new ScopedTerminationValidator((_binding, _intent, digest) => { this.#validateReceipt(digest, true); })
      .authorize(binding, this.target.dispatchIntent!.generation, receiptDigest);
  }
  async finalize(): Promise<void> {
    await this.app.coordinate(async () => {
      this.#fresh();
      // Validate/mint and create the successor in the store's fresh CAS callback.
      const current = this.app.read(Mode.Cleanup);
      await this.app.transact(this.app.scope, this.app.authorityDigest, current.generation, ledger => {
        const binding = ledger.observe(this.app.scope, this.target.childHandle), bytes = this.#records.read("scoped-receipts", this.target.startId);
        if (!bytes || !sameChild(binding, this.target) || binding.dispatchIntent?.generation !== this.target.dispatchIntent!.generation) throw new Error("scoped_terminal_changed");
        return ledger.terminalizeAfterIntent(binding, this.validate(this.app.scope, binding, scopedRecordDigest(bytes)));
      }, Mode.Cleanup);
    }, Mode.Cleanup);
  }
}
