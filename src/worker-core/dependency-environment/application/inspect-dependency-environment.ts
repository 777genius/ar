import {
  DependencyReceiptState, DependencyUnverifiedReason, sameDependencyTree, sameDependencyWorkspace,
} from "../domain/dependency-receipt";
import { DependencyReceiptParseStatus, parseDependencyReceipt } from "../domain/parse-dependency-receipt";
import {
  DependencyAbsenceKind, DependencyConsumerState, DependencyInspectionOutcome as Outcome,
  DependencyInspectionReason as Reason, DependencyTreeObservationState as TreeState, DependencyTreeSafety,
  type DependencyInspectionDecision, type DependencyInspectionInput,
} from "../domain/dependency-inspection";

export function inspectDependencyEnvironment(input: DependencyInspectionInput): DependencyInspectionDecision {
  const result = (outcome: Outcome, reason: Reason): DependencyInspectionDecision => ({ outcome, reason });
  if (input.consumer.state === DependencyConsumerState.Running
    || input.consumer.state === DependencyConsumerState.ExclusiveMutation) return result(Outcome.Busy, Reason.ActiveOwner);
  if (input.consumer.state === DependencyConsumerState.Unknown) return result(Outcome.Unknown, Reason.UnknownConsumer);
  const parsed = input.receipt === null ? null : parseDependencyReceipt(input.receipt);
  if (parsed?.status === DependencyReceiptParseStatus.Invalid) return result(Outcome.Unknown, Reason.InvalidReceipt);
  const receipt = parsed?.status === DependencyReceiptParseStatus.Valid ? parsed.receipt : null;
  if (receipt && !sameDependencyWorkspace(receipt.workspace, input.workspace)) return result(Outcome.Conflict, Reason.WorkspaceChanged);
  if (receipt?.state === DependencyReceiptState.Installing || receipt?.state === DependencyReceiptState.Evicting) {
    return result(Outcome.Busy, Reason.UnresolvedOperation);
  }
  if (receipt?.state === DependencyReceiptState.Unverified && receipt.reason === DependencyUnverifiedReason.ExplicitOperatorReinstallation)
    return result(Outcome.Busy, Reason.UnresolvedOperation);
  if (input.tree.state === TreeState.Unknown) return result(Outcome.Unknown, Reason.UnknownTree);
  if (input.tree.state === TreeState.Absent) {
    if (receipt?.state === DependencyReceiptState.Absent) {
      if (receipt.coverageRevision !== input.coverageRevision) return result(Outcome.Unknown, Reason.CoverageChanged);
      return result(Outcome.NeedsInstall, Reason.CommittedAbsence);
    }
    if (receipt) return result(Outcome.Conflict, Reason.ReceiptTreeMissing);
    return input.tree.absence === DependencyAbsenceKind.KnownFresh
      ? result(Outcome.NeedsInstall, Reason.FreshAbsence) : result(Outcome.Unknown, Reason.UnprovenAbsence);
  }
  if (receipt?.state === DependencyReceiptState.Absent) return result(Outcome.Conflict, Reason.UnexpectedTree);
  if (input.tree.safety !== DependencyTreeSafety.Safe) return result(Outcome.RequiresPreservation, Reason.UnsafeTree);
  const availableCapabilities = input.tree.availableCapabilities;
  if (input.requiredCapabilities.some((capability) => !availableCapabilities.includes(capability))) {
    return result(Outcome.RequiresPreservation, Reason.MissingCapabilities);
  }
  if (!receipt) return result(Outcome.UnverifiedReuse, Reason.BaselineMissing);
  if (receipt.coverageRevision !== input.coverageRevision) return result(Outcome.UnverifiedReuse, Reason.CoverageChanged);
  if (!sameDependencyTree(receipt.tree, input.tree.tree)) return result(Outcome.UnverifiedReuse, Reason.TreeChanged);
  if (receipt.state === DependencyReceiptState.Unverified) {
    const reasons: Record<DependencyUnverifiedReason, Reason> = {
      [DependencyUnverifiedReason.BaselineMissing]: Reason.BaselineMissing,
      [DependencyUnverifiedReason.TreeChanged]: Reason.TreeChanged,
      [DependencyUnverifiedReason.InputsChanged]: Reason.InputsChanged,
      [DependencyUnverifiedReason.ExplicitOperatorReinstallation]: Reason.UnresolvedOperation,
    };
    return result(Outcome.UnverifiedReuse, reasons[receipt.reason]);
  }
  if (receipt.installKey !== input.currentInstallKey) return result(Outcome.UnverifiedReuse, Reason.InputsChanged);
  return result(Outcome.Reused, Reason.ReadyIdentityMatched);
}
