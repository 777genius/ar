import { createHash } from "node:crypto";
import { parseImmutableChildSlot, ChildExecutionBudget, type ImmutableChildSlot } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationOperator } from "@vioxen/subscription-runtime/provider-codex";
import { assertHostedControllerOriginCapability, HostedControllerOriginCapability } from "../hosted-controller-origin-binding";
import { readHostedReadonlyHostInventory } from "../hosted-readonly-host-kernel";
import { readHostedChildSlot } from "../hosted-child-slot-files";
import { KeyedChildLedger, KeyedChildProfile, type ReviewedChildAuthority, type ChildSlotAllocation } from "../../worker-core/project-control/domain/keyed-child-launch";
const retainedAuthorities = new WeakSet<object>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reviewed host composition binds PR3's actual finite snapshot. No model
 * identity or mutable target manifests take part in authentication. */
export class RetainedKeyedAuthority {
  readonly seed: KeyedChildLedger;
  readonly slots: readonly ImmutableChildSlot[];
  readonly #read: () => readonly ImmutableChildSlot[];
  readonly #budgets = new Map<string, ChildExecutionBudget>();
  constructor(readonly origin: HostedControllerOriginCapability, readonly authority: ReviewedChildAuthority,
    allocations: readonly ChildSlotAllocation[]) {
    assertHostedActivationOperator();
    if (!(origin instanceof HostedControllerOriginCapability)) throw new Error("keyed_origin_capability_required");
    assertHostedControllerOriginCapability(origin);
    this.authority = Object.freeze({ ...authority });
    allocations = KeyedChildLedger.create(this.authority, allocations).snapshot().slots;
    authority = this.authority;
    this.#read = () => {
      const inventory = readHostedReadonlyHostInventory();
      return allocations.map(allocation => {
        const matches = inventory.ordinaryCreators.map(creator => readHostedChildSlot(creator))
          .filter((slot): slot is ImmutableChildSlot => slot?.slotId === allocation.slotId);
        if (matches.length !== 1) throw new Error("keyed_snapshot_invalid");
        return parseImmutableChildSlot(matches[0]);
      });
    };
    this.slots = Object.freeze(this.#read());
    for (const field of ["slotId", "creatorId", "jobId", "jobRootDir", "workspacePath", "promptPath"] as const) {
      if (new Set(this.slots.map(slot => slot[field])).size !== this.slots.length) throw new Error("keyed_snapshot_duplicate_slot");
    }
    this.seed = KeyedChildLedger.create(authority, allocations);
    for (const slot of this.slots) this.#budgets.set(slot.slotId, new ChildExecutionBudget(slot.lifetime));
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
    assertHostedControllerOriginCapability(this.origin);
    if (digest(this.#read()) !== this.authority.reviewedSnapshotDigest) throw new Error("keyed_snapshot_changed");
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
