import type { HostedDependencyKeyInputs } from "./hosted-dependency-materialization-context";
import type { DependencyOwnerPhase, DependencyAttempt, DependencyGenerationBaseline, DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { DependencySourceExposure } from "../worker-local/dependency-environment/observe-dependency-tree";
import type { readHostedDependencyActiveActorFacts } from "./hosted-dependency-active-actor-facts";

export enum HostedDependencyGenerationBarrierPhase { Pending="pending", Unavailable="unavailable", Observing="observing", Published="published", Retired="retired", Retiring="retiring", Held="held" }
export enum HostedDependencySourceUsePhase { NeverCaptured="never_captured", Capturing="capturing", Live="live", Retiring="retiring", Closed="closed", Held="held" }
export enum HostedDependencyWarmLeafPhase { Preparing="preparing", Completed="completed", Held="held" }
export enum HostedDependencySourceRuntimeClosureKind { RuntimeNeverConfigured="runtime_never_configured", ConfiguredRuntimeDischarged="configured_runtime_discharged" }
/** Only the existing original contexts map owns this state. Shapes, file refs
 * and phases are not an issuer and are never accepted as registration input. */
export type HostedDependencyGenerationState = {
  phase:HostedDependencyGenerationBarrierPhase;
  binding:HostedDependencyBinding;attempt:DependencyAttempt;ownerPhase:DependencyOwnerPhase.ExclusiveMutation|DependencyOwnerPhase.Running;
  actors?:NonNullable<ReturnType<typeof readHostedDependencyActiveActorFacts>>;
  inputs?:HostedDependencyKeyInputs;
  warmLeaf?:{phase:HostedDependencyWarmLeafPhase};
  pending?:DependencyProtectedReference;barrier?:DependencyProtectedReference;baseline?:DependencyGenerationBaseline;
  sourceUse:{phase:HostedDependencySourceUsePhase;exposure?:DependencySourceExposure;qualification?:DependencyProtectedReference};
};
