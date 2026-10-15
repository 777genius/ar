import { HostedActivationPhase, HostedCustodyPhase, HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import type { parseHostedActivation, parseHostedInstallation, parseHostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { DependencyOwnerKind, DependencyOwnerPhase, sameDependencyWorkspace, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import type { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import type { readHostedReadonlyDependencyStart } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Pure equality checks on already collected facts. No origin, IO or permission. */
export function assertManagedReadonlyInstallationFacts(installation: ReturnType<typeof parseHostedInstallation>, activation: ReturnType<typeof parseHostedActivation>,
  epoch: ReturnType<typeof parseHostedCustodyEpoch>, enrollment: ReturnType<typeof parseHostedCustodyEpoch>,
  inventory: ReturnType<typeof parseHostedReadonlyHostInventory>, enrollmentDigest: string, inventoryDigest: string): void {
  if (activation.phase !== HostedActivationPhase.Exclusive || activation.installationId !== installation.installationId ||
      activation.hostId !== installation.hostId || activation.exclusiveEnrollmentSha256 !== enrollmentDigest ||
      activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal) ||
      inventory.schemaVersion !== 4 || !inventory.collectorProfile || !inventory.systemBusInfrastructure ||
      inventory.hostId !== installation.hostId || inventoryDigest !== installation.inventorySha256 ||
      epoch.phase !== HostedCustodyPhase.Ready || epoch.revoked || enrollment.phase !== HostedCustodyPhase.Closed || enrollment.revoked ||
      enrollment.generation !== 1 || enrollment.reservations.length !== 0 || enrollment.outerRuntime !== null ||
      epoch.hostId !== installation.hostId || enrollment.hostId !== epoch.hostId || JSON.stringify(enrollment.identity) !== JSON.stringify(epoch.identity) ||
      epoch.bootId !== activation.bootId || epoch.supervisorId !== activation.supervisorId ||
      epoch.identity.runtimeSha !== installation.runtimeSha || epoch.identity.runtimeManifestSha256 !== installation.runtimeManifestSha256) invalid();
}

export function assertManagedReadonlyStartFacts(start: ReturnType<typeof readHostedReadonlyDependencyStart>["value"], installation: ReturnType<typeof parseHostedInstallation>,
  epoch: ReturnType<typeof parseHostedCustodyEpoch>): void {
  if (start.installationId !== installation.installationId || start.runtimeSha !== installation.runtimeSha || start.inventoryDigest !== installation.inventorySha256 ||
      start.hostId !== epoch.hostId || start.bootId !== epoch.bootId || start.supervisorId !== epoch.supervisorId || start.generation !== epoch.generation ||
      start.readonlyJobId !== epoch.identity.jobId || start.jobRootDir !== epoch.identity.jobRootDir || start.workspace.canonicalPath !== epoch.identity.workspacePath ||
      start.grantDigest !== epoch.identity.grantSha256 || start.policyDigest !== epoch.identity.policySha256 || start.reviewDigest !== epoch.identity.reviewSha256 ||
      start.stageDigest !== epoch.identity.stageSha256) invalid();
}

export function assertManagedReadonlyBindingFacts(binding: HostedDependencyBinding | null, installation: ReturnType<typeof parseHostedInstallation>,
  start: ReturnType<typeof readHostedReadonlyDependencyStart>["value"]): void {
  if (!binding || binding.version !== 2 || binding.installationId !== installation.installationId || binding.runtimeSha !== installation.runtimeSha ||
      binding.jobRootDir !== start.jobRootDir || !sameDependencyWorkspace(binding.workspace,start.workspace)) invalid();
}

export function assertManagedReadonlyOwnerFacts(owner: ReturnType<typeof parseDependencyOwner>, binding: HostedDependencyBinding,
  associationReference: Parameters<typeof sameDependencyProtectedReference>[0], start: ReturnType<typeof readHostedReadonlyDependencyStart>["value"]): void {
  if (owner.version !== 3 || !sameDependencyWorkspace(owner.workspace,binding.workspace) || !sameDependencyProtectedReference(owner.custodyBinding,associationReference)) invalid();
  if (owner.owner !== null && (owner.owner.kind === DependencyOwnerKind.Maintenance || owner.owner.phase === DependencyOwnerPhase.Fenced ||
      owner.owner.attempt.launch.startId !== start.startId || owner.owner.attempt.launch.unit !== start.unit ||
      !("association" in owner.owner.attempt.launch) || !sameDependencyProtectedReference(owner.owner.attempt.launch.association,associationReference))) invalid();
}
