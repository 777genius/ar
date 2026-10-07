import type { DependencyUnverifiedReason } from "../worker-core/dependency-environment/domain/dependency-receipt";
import type { DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { DependencyAttempt } from "@vioxen/subscription-runtime/core";
import type { DependencyCommittedReadyReceipt, DependencyCommittedUnverifiedReceipt } from "../worker-core/dependency-environment/ports/dependency-receipt-store";
export enum HostedDependencyWarmRetirementPhase { Captured="captured", Retired="retired", Held="held" }
/** Association lives ONLY as a field in the existing original contexts map.
 * Historical Ready is never a current generated execution/eviction grant. */
export type HostedDependencyWarmRetirementState={
  phase:HostedDependencyWarmRetirementPhase;
  readonly binding:HostedDependencyBinding;readonly attempt:DependencyAttempt;
  readonly owner:Extract<DependencyOwnerRecord,{version:2|3}>;
  readonly ready:DependencyCommittedReadyReceipt;
  readonly reason:DependencyUnverifiedReason.BaselineMissing|DependencyUnverifiedReason.InputsChanged;
  retired?:DependencyCommittedUnverifiedReceipt;
};
