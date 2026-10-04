// Shared provider-neutral parser; the worker public subpath stays compatible.
export { DependencyOwnerPhase, DependencyAdmissionFailure, DependencyAdmissionError,
  parseDependencyOwner, sameDependencyAttempt,
  type DependencyLaunchBinding, type DependencyAttempt, type DependencyOwnerRecord,
} from "@vioxen/subscription-runtime/core";
