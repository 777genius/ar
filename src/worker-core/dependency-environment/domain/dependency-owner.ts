// Shared provider-neutral parser; the worker public subpath stays compatible.
export { DependencyGenerationContinuityKind, assertDependencyGenerationBaselineTransition, dependencyGenerationContinuityRevision,
  DependencyOwnerPhase, DependencyOwnerKind, DependencyAdmissionFailure, DependencyAdmissionError,
  parseDependencyOwner, parseDependencyConsumerAttempt, sameDependencyAttempt, sameDependencyOwnerIdentity, sameDependencyMaintenanceAttempt, isDependencyConsumerOwner,
  isDependencyCustodyLaunch, DependencyConsumerLaunchKind, sameDependencyProtectedReference,
  type DependencyProtectedReference, type DependencyOrdinaryLaunchBinding, type DependencyCustodyLaunchBinding,
  type DependencyLaunchBinding, type DependencyAttempt, type DependencyOwnerRecord,
  type DependencyMaintenanceAttempt, type DependencyConsumerOwner, type DependencyMaintenanceOwner,
} from "@vioxen/subscription-runtime/core";
