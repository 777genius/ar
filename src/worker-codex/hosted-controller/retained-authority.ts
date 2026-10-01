import { ScopedTerminationRecords } from "./scoped-termination-records";
import { createHash } from "node:crypto";
import { parseImmutableChildSlot, ChildExecutionBudget, type ImmutableChildSlot } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationOperator, decodeHostedActivationBytes, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { assertHostedControllerOriginCapability, HostedControllerOriginCapability } from "../hosted-controller-origin-binding";
import { readHostedReadonlyHostInventory } from "../hosted-readonly-host-kernel";
import { readHostedChildSlot } from "../hosted-child-slot-files";
import { KeyedChildLedger, KeyedChildProfile, type ReviewedChildAuthority, type ChildSlotAllocation, type ChildScope } from "../../worker-core/project-control/domain/keyed-child-launch";
const retainedAuthorities = new WeakSet<object>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reviewed host composition binds PR3's actual finite snapshot. No model
 * identity or mutable target manifests take part in authentication. */
export class RetainedKeyedAuthority {
  static readonly #cleanupToken = Object.freeze({});
  readonly #cleanupOnly: boolean;
  readonly seed: KeyedChildLedger;
  readonly slots: readonly ImmutableChildSlot[];
  readonly #read: () => readonly ImmutableChildSlot[];
  readonly #budgets = new Map<string, ChildExecutionBudget>();
  constructor(readonly origin: HostedControllerOriginCapability, readonly authority: ReviewedChildAuthority,
    allocations: readonly ChildSlotAllocation[], cleanup?: { readonly token: object; readonly slots: readonly ImmutableChildSlot[] }) {
    assertHostedActivationOperator();
    this.#cleanupOnly = cleanup?.token === RetainedKeyedAuthority.#cleanupToken;
    if (cleanup && !this.#cleanupOnly) throw new Error("keyed_cleanup_certificate_required");
    if (!this.#cleanupOnly && !(origin instanceof HostedControllerOriginCapability)) throw new Error("keyed_origin_capability_required");
    if (!this.#cleanupOnly) assertHostedControllerOriginCapability(origin);
    this.authority = Object.freeze({ projectId: authority.projectId, workstreamId: authority.workstreamId, controllerId: authority.controllerId,
      grantDigest: authority.grantDigest, reviewedSnapshotDigest: authority.reviewedSnapshotDigest, accountId: authority.accountId,
      sourceSha: authority.sourceSha, artifactSha: authority.artifactSha, absoluteDeadline: authority.absoluteDeadline,
      maxGoalTurns: authority.maxGoalTurns, effectiveOptionDigest: authority.effectiveOptionDigest });
    allocations = KeyedChildLedger.create(this.authority, allocations).snapshot().slots;
    authority = this.authority;
    this.#read = this.#cleanupOnly ? () => { throw new Error("keyed_live_admission_required"); } : () => {
      const inventory = readHostedReadonlyHostInventory();
      return allocations.map(allocation => {
        const matches = inventory.ordinaryCreators.map(creator => readHostedChildSlot(creator))
          .filter((slot): slot is ImmutableChildSlot => slot?.slotId === allocation.slotId);
        if (matches.length !== 1) throw new Error("keyed_snapshot_invalid");
        return parseImmutableChildSlot(matches[0]);
      });
    };
    this.slots = Object.freeze(cleanup ? cleanup.slots.map(parseImmutableChildSlot) : this.#read());
    for (const field of ["slotId", "creatorId", "jobId", "jobRootDir", "workspacePath", "promptPath"] as const) {
      if (new Set(this.slots.map(slot => slot[field])).size !== this.slots.length) throw new Error("keyed_snapshot_duplicate_slot");
    }
    this.seed = KeyedChildLedger.create(authority, allocations);
    if (!this.#cleanupOnly) for (const slot of this.slots) this.#budgets.set(slot.slotId, new ChildExecutionBudget(slot.lifetime));
    if (origin.origin.jobId !== authority.controllerId || origin.grantDigest !== authority.grantDigest ||
        digest(this.slots) !== authority.reviewedSnapshotDigest ||
        digest(this.slots.map(s => s.lifetime)) !== authority.effectiveOptionDigest ||
        allocations.some((allocation, i) => {
          const s = this.slots[i]!;
          return s.jobId === authority.controllerId || s.lifetime.accountId !== authority.accountId ||
            s.sourceSha !== authority.sourceSha || s.artifactSha !== authority.artifactSha ||
            s.lifetime.deadlineEpochMs !== authority.absoluteDeadline || s.lifetime.maxGoalTurns !== authority.maxGoalTurns ||
            allocation.profile !== (s.lifetime.accessBoundary === "read_only" ? KeyedChildProfile.ReadOnly : KeyedChildProfile.IsolatedWrite) ||
            allocation.unitCorrelation !== `subscription-runtime-ordinary-${allocation.startId}.service`;
        })) throw new Error("keyed_snapshot_invalid");
    retainedAuthorities.add(this); Object.freeze(this);
  }
  assertCurrent(): void {
    if (this.#cleanupOnly) throw new Error("keyed_live_admission_required");
    assertHostedControllerOriginCapability(this.origin);
    if (digest(this.#read()) !== this.authority.reviewedSnapshotDigest) throw new Error("keyed_snapshot_changed");
  }
  /** Sealed ownership is published once before admission effects. Replay only
   * fsyncs identical bytes, never rereads live grant/inventory/channel authority. */
  retainCleanup(fence: HostedActivationFence): void {
    this.assertCleanup();
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, authority: this.authority,
      allocations: this.seed.snapshot().slots, slots: this.slots,
      origin: { installationId: this.origin.origin.installationId, startId: this.origin.origin.startId, jobId: this.origin.origin.jobId,
        originSha256: this.origin.origin.originSha256 }, grantDigest: this.origin.grantDigest }) + "\n");
    new ScopedTerminationRecords(() => this.assertCleanup()).write(fence, "keyed-child-owners", this.seed.authorityDigest, bytes);
  }
  /** Host composition supplies an already authenticated scope/digest; no caller
   * paths. Restored cleanup ownership ALWAYS refuses live work authentication. */
  static restoreCleanup(scope: ChildScope, authorityDigest: string): RetainedKeyedAuthority {
    assertHostedActivationOperator();
    if (!/^[a-f0-9]{64}$/.test(authorityDigest)) throw new Error("keyed_cleanup_scope_invalid");
    const bytes = new ScopedTerminationRecords(assertHostedActivationOperator).read("keyed-child-owners", authorityDigest);
    if (!bytes) throw new Error("keyed_cleanup_owner_required");
    const dto = decodeHostedActivationBytes(bytes) as { schemaVersion: number; authority: ReviewedChildAuthority;
      allocations: readonly ChildSlotAllocation[]; slots: readonly ImmutableChildSlot[]; origin: HostedControllerOriginCapability["origin"]; grantDigest: string };
    if (!dto || Object.keys(dto).sort().join(",") !== "allocations,authority,grantDigest,origin,schemaVersion,slots" || dto.schemaVersion !== 1 ||
        !Array.isArray(dto.slots) || dto.slots.length > 128 || dto.authority.projectId !== scope.projectId ||
        dto.authority.workstreamId !== scope.workstreamId || dto.authority.controllerId !== scope.controllerId ||
        KeyedChildLedger.create(dto.authority, dto.allocations).authorityDigest !== authorityDigest) throw new Error("keyed_cleanup_scope_invalid");
    const origin = Object.freeze({ origin: Object.freeze(dto.origin), grantDigest: dto.grantDigest }) as HostedControllerOriginCapability;
    const retained = new RetainedKeyedAuthority(origin, dto.authority, dto.allocations,
      { token: this.#cleanupToken, slots: dto.slots });
    const canonical = Buffer.from(JSON.stringify({ schemaVersion: 1, authority: retained.authority,
      allocations: retained.seed.snapshot().slots, slots: retained.slots, origin: { installationId: retained.origin.origin.installationId, startId: retained.origin.origin.startId,
        jobId: retained.origin.origin.jobId, originSha256: retained.origin.origin.originSha256 }, grantDigest: retained.origin.grantDigest }) + "\n");
    if (!canonical.equals(bytes)) throw new Error("keyed_cleanup_owner_invalid");
    return retained;
  }
  /** Original admitted immutable ownership survives live grant and channel loss.
   * This authenticates no work, reads no live inventory/grant and renews nothing. */
  assertCleanup(): void {
    assertHostedActivationOperator();
    if (!retainedAuthorities.has(this)) throw new Error("keyed_retained_cleanup_required");
  }
  cleanupSlot(slotId: string): ImmutableChildSlot {
    this.assertCleanup();
    const slot = this.slots.find(s => s.slotId === slotId);
    if (!slot) throw new Error("keyed_slot_foreign");
    return slot;
  }
  slot(slotId: string): ImmutableChildSlot {
    this.assertCurrent();
    const slot = this.slots.find(s => s.slotId === slotId);
    if (!slot) throw new Error("keyed_slot_foreign");
    return slot;
  }
  budget(slotId: string): ChildExecutionBudget { this.slot(slotId); return this.#budgets.get(slotId)!; }
}

export function assertRetainedKeyedAuthority(value: RetainedKeyedAuthority): void {
  if (!retainedAuthorities.has(value)) throw new Error("keyed_retained_authority_required");
  value.assertCurrent();
}
