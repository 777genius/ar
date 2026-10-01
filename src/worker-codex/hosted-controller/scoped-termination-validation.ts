import { readHostedActivationBytes, decodeHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import { HostedCustodyReservationState, parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { scopedDigest, stableChildDigest, type ScopedTerminationMember, type ScopedTerminationReceipt,
  ScopedTerminationKind, type RuntimeValidatedTermination, type RuntimeValidatedOrdinaryTermination } from "../../worker-core/hosted-custody/domain/scoped-termination";
import type { ChildCorrelation, ChildObservation } from "../../worker-core/project-control/domain/keyed-child-launch";
import { readHostedInstallationActivation, readHostedOrdinaryBirth } from "../hosted-installation-activation";
import { RetainedKeyedAuthority } from "./retained-authority";
import { ScopedTerminationRecords, scopedRecordDigest, scopedFenceIdentity } from "./scoped-termination-records";
const keyed = new WeakMap<object, { validator: ScopedTerminationValidator; binding: string; digest: string }>();
const ordinary = new WeakMap<object, { validator: ScopedTerminationValidator; digest: string }>();
/** The sole issuer reads authenticated fixed private records. No callbacks, paths,
 * DTO receipts or test issuers are accepted. Consumption revalidates fresh bytes. */
export class ScopedTerminationValidator {
  readonly records: ScopedTerminationRecords;
  constructor(private readonly retained: RetainedKeyedAuthority, private readonly target: ChildObservation) {
    if (new.target !== ScopedTerminationValidator) throw new Error("scoped_concrete_validator_required");
    this.#authenticate(); this.records = new ScopedTerminationRecords(() => this.#authenticate()); Object.freeze(this);
  }
  authenticate(): void { this.#authenticate(); }
  #authenticate(): void {
    RetainedKeyedAuthority.prototype.assertCleanup.call(this.retained);
    const allocation = this.retained.seed.snapshot().slots.find(s => s.slotId === this.target.slotId);
    if (!allocation || !this.target.dispatchIntent || this.target.authorityDigest !== this.retained.seed.authorityDigest ||
        Object.keys(allocation).some(k => allocation[k as keyof typeof allocation] !== this.target[k as keyof ChildObservation])) throw new Error("scoped_foreign_target");
  }
  runtime() {
    const correlation = this.records.correlation(this.target.startId), slot = RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, this.target.slotId);
    const { installation, activation } = readHostedInstallationActivation();
    if (!correlation || correlation.kind !== ScopedTerminationKind.Runtime || correlation.identity.scopeDigest !== stableChildDigest(this.target, this.target.dispatchIntent!.generation) ||
        correlation.identity.authorityDigest !== this.target.authorityDigest || correlation.identity.slotId !== slot.slotId ||
        correlation.identity.parentStartId !== this.target.startId || correlation.identity.accountId !== slot.lifetime.accountId ||
        correlation.identity.deadlineEpochMs !== slot.lifetime.deadlineEpochMs || correlation.identity.grantDigest !== slot.grantSha256 ||
        correlation.identity.sourceSha !== slot.sourceSha || correlation.identity.artifactSha !== slot.artifactSha ||
        correlation.identity.dispatchIntentGeneration !== this.target.dispatchIntent!.generation ||
        correlation.identity.installationId !== installation.installationId || correlation.identity.inventoryDigest !== installation.inventorySha256 ||
        correlation.identity.hostId !== activation.hostId || correlation.identity.bootId !== activation.bootId || correlation.identity.supervisorId !== activation.supervisorId) throw new Error("scoped_runtime_correlation_invalid");
    const host = this.retained.hostIdentity;
    if (correlation.identity.supervisorUnit !== host.supervisorUnit || correlation.identity.supervisorControlGroup !== host.supervisorControlGroup ||
        correlation.identity.installationId !== host.installationId || correlation.identity.hostId !== host.hostId || correlation.identity.bootId !== host.bootId ||
        correlation.identity.supervisorId !== host.supervisorId || correlation.identity.inventoryDigest !== host.inventoryDigest) throw new Error("scoped_admitted_host_invalid");
    return { correlation, activation };
  }
  members(): readonly ScopedTerminationMember[] {
    const { correlation: runtime, activation } = this.runtime();
    const runtimeRow = activation.ordinaryStarts.find(row => row.startId === this.target.startId);
    if (!runtimeRow || runtimeRow.creatorId !== RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, this.target.slotId).creatorId) throw new Error("scoped_runtime_missing");
    const slot = RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, this.target.slotId), origin = readHostedOrdinaryBirth(slot.jobId);
    if (origin.birth.jobRootDir !== slot.jobRootDir || origin.birth.workspacePath !== slot.workspacePath ||
        origin.installation.runtimeSha !== slot.artifactSha || runtimeRow.originSha256 !== origin.originSha256 ||
        runtime.creatorControlGroup !== runtime.identity.supervisorControlGroup) throw new Error("scoped_origin_invalid");
    // Discovery begins with reservations, including rows lacking companion bytes.
    return activation.ordinaryStarts.filter(row => row.creatorId === slot.creatorId || row.originSha256 === origin.originSha256 || row.startId === this.target.startId).map(row => {
      const bytes = readHostedActivationBytes(`ordinary-starts/${row.startId}.json`), companion = this.records.correlation(row.startId), invocation = this.records.invocation(row.startId);
      const submitter = this.records.submitter(row.startId), submitterBytes = this.records.read("ordinary-submitters", row.startId);
      if (!bytes || !companion || !invocation || !submitter || !submitterBytes) throw new Error("scoped_partial_correlation");
      const start = parseHostedOrdinaryStart(decodeHostedActivationBytes(bytes)), slot = RetainedKeyedAuthority.prototype.cleanupSlot.call(this.retained, this.target.slotId);
      if (companion.startDigest !== scopedRecordDigest(bytes) || companion.parentStartDigest !== runtime.startDigest ||
          scopedDigest(companion.identity) !== scopedDigest(runtime.identity) || companion.reservationGeneration !== row.generation ||
          companion.unit !== row.unit || start.unit !== row.unit || start.activationGeneration !== row.generation || start.creatorId !== row.creatorId ||
          start.creatorId !== slot.creatorId || start.originSha256 !== origin.originSha256 || start.originSha256 !== row.originSha256 || start.creatorPidBirth !== companion.creatorPidBirth || start.controlGroup !== companion.controlGroup ||
          start.installationId !== runtime.identity.installationId || start.bootId !== runtime.identity.bootId || start.supervisorId !== runtime.identity.supervisorId ||
          start.grantSha256 !== runtime.identity.grantDigest || start.jobId !== slot.jobId || start.jobRootDir !== slot.jobRootDir ||
          start.workspacePath !== slot.workspacePath ||
          (companion.kind === ScopedTerminationKind.Provider && companion.creatorControlGroup !== runtime.controlGroup) || invocation.correlationDigest !== scopedDigest(companion) || submitter.correlationDigest !== scopedDigest(companion)) throw new Error("scoped_companion_invalid");
      return Object.freeze({ ...companion, invocationId: invocation.invocationId, submitterDigest: scopedRecordDigest(submitterBytes) });
    });
  }
  validateReceipt(digest: string, requireTerminal: boolean): ScopedTerminationReceipt { return this.#validateReceipt(digest, requireTerminal); }
  #validateReceipt(digest: string, requireTerminal: boolean): ScopedTerminationReceipt {
    const receipt = this.records.receipt(this.target.startId), bytes = this.records.read("scoped-receipts", this.target.startId);
    const operation = this.records.operation(this.target.startId), marker = this.records.terminating(this.target.startId);
    if (!receipt || !bytes || !operation || !marker || scopedRecordDigest(bytes) !== digest ||
        scopedDigest(receipt.operation) !== scopedDigest(operation) || scopedDigest(marker.identity) !== scopedDigest(scopedFenceIdentity(operation.identity)) ||
        marker.operationGeneration !== operation.operationGeneration || scopedDigest(marker.reservationIds) !== scopedDigest(operation.members.map(m => m.startId)) ||
        scopedDigest(operation.members) !== scopedDigest(this.members())) throw new Error("scoped_receipt_invalid");
    this.records.validateObservations(receipt);
    const activation = readHostedInstallationActivation().activation;
    if (requireTerminal && operation.members.some(member => activation.ordinaryStarts.find(row => row.startId === member.startId)?.state !== HostedCustodyReservationState.Terminal)) throw new Error("scoped_ordinary_not_terminal");
    return receipt;
  }
  authorize(binding: ChildCorrelation, intent: number, digest: string): RuntimeValidatedTermination {
    this.#authenticate();
    if (stableChildDigest(binding, intent) !== stableChildDigest(this.target, this.target.dispatchIntent!.generation)) throw new Error("scoped_foreign_target");
    this.#validateReceipt(digest, true);
    const cap = Object.freeze({ receiptDigest: digest });
    keyed.set(cap, { validator: this, binding: stableChildDigest(binding, intent), digest });
    return cap as RuntimeValidatedTermination;
  }
  authorizeOrdinary(digest: string): RuntimeValidatedOrdinaryTermination {
    this.#authenticate(); this.#validateReceipt(digest, false);
    const cap = Object.freeze({}); ordinary.set(cap, { validator: this, digest });
    return cap as RuntimeValidatedOrdinaryTermination;
  }
}
export function assertRuntimeValidatedTermination(value: RuntimeValidatedTermination, binding: ChildCorrelation, intent: number): void {
  const entry = keyed.get(value);
  if (!entry || value.receiptDigest !== entry.digest || entry.binding !== stableChildDigest(binding, intent)) throw new Error("scoped_terminal_authority_required");
  entry.validator.authenticate(); entry.validator.validateReceipt(entry.digest, true);
}
export function scopedOrdinaryAuthority(value: RuntimeValidatedOrdinaryTermination): ScopedTerminationReceipt {
  const entry = ordinary.get(value);
  if (!entry) throw new Error("scoped_ordinary_authority_required");
  entry.validator.authenticate(); return entry.validator.validateReceipt(entry.digest, false);
}

Object.freeze(ScopedTerminationValidator.prototype);
