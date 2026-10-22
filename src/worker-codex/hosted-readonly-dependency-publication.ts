import { releaseCurrentHostedReadonlyDependencySourceOwner } from "./hosted-current-dependency-origin";
import { sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, parseHostedActivation, type HostedCustodyEpoch } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertHostedActivationFence, readHostedActivationBytes, decodeHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot, isHostedDependencyWorkspace } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedReadonlyDependencyMaterial } from "./hosted-readonly-dependency-records";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
function invalid(): never { throw new Error("hosted_readonly_dependency_ready_held"); }
/** Actual store calls this BEFORE every protected-root Closed->Ready write,
 * including retained .next recovery. No callback/post-core check can substitute
 * for it. B1 exports trusted preparation effects but wires no operator/runtime
 * route. Partial adoption cannot manufacture this complete protected tuple. */
export function assertHostedReadonlyDependencyReadyPublication(fence: HostedActivationFence, next: HostedCustodyEpoch): void {
  if (!isHostedDependencyWorkspace(next.identity.workspacePath)) return;
  assertHostedActivationFence(fence);
  const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
  if (next.revoked || next.hostId !== session.hostId || next.bootId !== session.bootId || next.supervisorId !== session.supervisorId) invalid();
  const activationBytes = readHostedActivationBytes("host-activation.json"); if (!activationBytes) invalid();
  const activation = parseHostedActivation(decodeHostedActivationBytes(activationBytes));
  if ((activation.phase !== HostedActivationPhase.EnteringExclusive && activation.phase !== HostedActivationPhase.Exclusive) ||
      activation.hostId !== session.hostId || activation.bootId !== session.bootId || activation.supervisorId !== session.supervisorId) invalid();
  const material = readHostedReadonlyDependencyMaterial(fence,next.identity);
  // Replay reaches this gate before core recovery: authenticate current authored
  // root/ancestor lease identities now, not only immutable lease bytes/history.
  new HostedReadonlySupervisorHost().verifyReadonlyMaterial(next.identity);
  if (activation.installationId !== material.evidence.installation.installationId || !material.ready.receipt.installKey) invalid();
  // The old exact R attempt closes before any Ready publication or owner-store
  // descriptors. Enrolled structural custody is preserved, never reissued.
  releaseCurrentHostedReadonlyDependencySourceOwner(fence);
  const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
  try {
    const owner = store.read(material.evidence.workspace);
    if (!owner || owner.version !== 3 || owner.owner !== null || !sameDependencyProtectedReference(owner.custodyBinding,material.reference)) invalid();
    // A second protected read catches drift; it is not an asynchronous input
    // capture, hot tree scan, fabricated Ready, or same-store recursive CAS.
    const current = store.read(material.evidence.workspace);
    if (!current || current.revision !== owner.revision || current.epoch !== owner.epoch || current.owner !== null ||
        current.version !== 3 || !sameDependencyProtectedReference(current.custodyBinding,owner.custodyBinding)) invalid();
  } finally { store.close(); }
}
