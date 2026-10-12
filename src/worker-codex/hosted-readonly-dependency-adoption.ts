import { randomUUID } from "node:crypto";
import { DependencyCustodyEvidenceKind, parseDependencyCustodyEvidence, isDependencyCustodyObject,
  isDependencyProtectedReference, sameDependencyProtectedReference, sameDependencyWorkspace,
  type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, DependencyReceiptState, HostedCustodyPhase,
  DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner, sameDependencyMaintenanceAttempt, claimDependencyMaintenance, assertDependencyMaintenance,
  releaseDependencyMaintenance, type DependencyMaintenanceAttempt } from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { hostedDependencyBindingName, hostedDependencyOwnerRoot, readHostedDependencyBinding,
  assertHostedDependencyPhysicalWorkspace, assertHostedDependencyQualifiedInventory } from "./hosted-dependency-workspace";
import { readHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedReadonlyDependencyAssociationRoot, readonlyDependencyAssociationName, readHostedReadonlyDependencyAssociation } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "./hosted-installation-activation";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { parseHostedReadonlyPolicy, readHostedPrivateBytes, type HostedReadonlyPolicy } from "./hosted-readonly-inputs";
import { readReadonlyReview, readonlyIdentityName } from "./hosted-readonly-authority";
import { inspectReadonlyInputs } from "./hosted-readonly-custody";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { parseHostedTestEgressGrant } from "./hosted-test-egress-contract";
import { readHostedDependencyCommittedReady, readHostedDependencyEstablishedReceipt, ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { assertHostedDependencyLegacyComparedReady } from "./hosted-dependency-legacy-comparison-record";
import { encodeReference, readFixedReference, pinReferenceFile, writeReferenceOnce } from "./hosted-dependency-legacy-reference-records";

const root = "/var/lib/subscription-runtime-host-policy";
const transportRoot = "/run/user/0/subscription-runtime-host-policy";
const adoptionRoot = `${root}/readonly-dependency-adoptions`;
function invalid(): never { throw new Error("hosted_readonly_dependency_adoption_held"); }
function privatePin(path: string, maxBytes = 16384) {
  if (!readHostedPrivateBytes(path,maxBytes)) invalid(); return pinReferenceFile(path,maxBytes);
}
function id(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v); }
type AdoptionIntent = {
  readonly version: 1; readonly operationId: string; readonly candidateJobId: string;
  readonly candidateReady: DependencyProtectedReference; readonly policyInput: DependencyProtectedReference;
  readonly maintenance: DependencyMaintenanceAttempt;
};
/** Data-only intent syntax. The effect methods independently select the fixed
 * leaf, actual owner, deployment, material and drained preparation each time. */
export function parseHostedReadonlyDependencyAdoptionIntent(value: unknown): AdoptionIntent {
  if (!isDependencyCustodyObject(value,"candidateJobId,candidateReady,maintenance,operationId,policyInput,version") || value.version !== 1 ||
      !id(value.operationId) || typeof value.candidateJobId !== "string" || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(value.candidateJobId) ||
      !isDependencyProtectedReference(value.candidateReady) || !isDependencyProtectedReference(value.policyInput) ||
      value.policyInput.path !== `${adoptionRoot}/${value.operationId}.policy.json` ||
      !isDependencyCustodyObject(value.maintenance,"epoch,host,operationId") || value.maintenance.operationId !== value.operationId) invalid();
  const m = value.maintenance;
  if (!Number.isSafeInteger(m.epoch) || Number(m.epoch) < 1 ||
      !isDependencyCustodyObject(m.host,"bootId,grantDigest,installationId,inventoryDigest,runtimeSha,supervisorId") ||
      typeof m.host.installationId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.host.installationId) ||
      typeof m.host.bootId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.host.bootId) ||
      typeof m.host.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(m.host.runtimeSha) ||
      typeof m.host.supervisorId !== "string" || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(m.host.supervisorId) ||
      ![m.host.inventoryDigest,m.host.grantDigest].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) invalid();
  // The real workspace is selected from the original protected binding below;
  // the parser cannot manufacture it or grant a Maintenance ownership claim.
  if (Buffer.byteLength(JSON.stringify(value)) > 16384) invalid();
  return JSON.parse(JSON.stringify(value)) as AdoptionIntent;
}
function policyScope(value: unknown) {
  const policy = parseHostedReadonlyPolicy(value);
  const candidateJobId = policy.jobRootDir.slice(policy.jobRootDir.lastIndexOf("/") + 1);
  const binding = readHostedDependencyBinding(candidateJobId);
  if (!binding || binding.version !== 2 || policy.jobId === binding.jobId || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(policy.jobId) ||
      policy.jobRootDir !== binding.jobRootDir || policy.workspacePath !== binding.workspace.canonicalPath || policy.runtimeSha !== binding.runtimeSha) invalid();
  const stable = ["packages/live","packages/packed","TEST-readonly-local-custody"].map(p => `${policy.workspacePath}/${p}`).sort();
  if (JSON.stringify([...policy.readonlyPaths].sort()) !== JSON.stringify(stable)) invalid();
  assertHostedDependencyPhysicalWorkspace(binding); assertHostedDependencyQualifiedInventory();
  const review = readReadonlyReview(policy); inspectReadonlyInputs(policy,review.corepackShim);
  return { policy, binding, review };
}
function currentOriginal(candidateJobId: string) {
  const binding = readHostedDependencyBinding(candidateJobId);
  if (!binding || binding.version !== 2) invalid();
  const ready = readHostedDependencyEstablishedReceipt(binding);
  if (!ready || ready.state !== DependencyReceiptState.Ready || ready.provenance.kind !== DependencyInstallProofKind.LegacyCompared) invalid();
  const comparison = assertHostedDependencyLegacyComparedReady({ ...ready, provenance: ready.provenance });
  if (comparison.version !== 2) invalid();
  const committed = readHostedDependencyCommittedReady(binding,ready.revision);
  if (!encodeReference(committed.receipt).equals(encodeReference(ready))) invalid();
  return { binding, ready, comparison, committed };
}
/** Initial trusted supervisor only, real exclusive-preparation/drain gate.
 * Exported input is reviewed configuration, never authority. No CLI/fixture
 * invokes this in B1; full B-C-D deployment is required before adoption. */
export function prepareHostedReadonlyDependencyAdoption(value: HostedReadonlyPolicy): Readonly<{ operationId: string; policyPath: string }> {
  return new HostedInstallationActivationStore().withExclusivePreparation(fence => {
    const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
    const selected = policyScope(value), { binding, committed } = currentOriginal(selected.binding.jobId);
    const { installation } = readHostedInstallationActivation();
    if (selected.policy.runtimeManifestSha256 !== installation.runtimeManifestSha256 || readHostedActivationBytes("readonly-enrollment.json") ||
        readHostedReadonlyDependencyAssociation(fence,binding.workspace)) invalid();
    const name = readonlyIdentityName(selected.policy.jobId);
    for (const path of [`${hostedTestEgressGrantRoot}/${name}`,`${transportRoot}/codex-readonly/${name}`,
      `${root}/codex-readonly-custody/${name}`,`${root}/codex-readonly-revoked/${name}`]) if (readHostedPrivateBytes(path,16384)) invalid();
    ensureHostedDependencyDirectory(adoptionRoot); ensureHostedDependencyDirectory(hostedReadonlyDependencyAssociationRoot);
    ensureHostedDependencyDirectory(`${root}/readonly-dependency-starts`);
    const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
    try {
      const old = store.read(binding.workspace); if (!old || old.version !== 2 || old.owner !== null) invalid();
      const operationId = randomUUID();
      const maintenance = claimDependencyMaintenance(store,binding.workspace,{ installationId: installation.installationId,
        bootId: session.bootId, runtimeSha: installation.runtimeSha, inventoryDigest: installation.inventorySha256,
        grantDigest: binding.grantDigest, supervisorId: session.supervisorId },operationId);
      // All post-claim failures retain the actual owner/partial immutable leaves.
      const policyInput = writeReferenceOnce(`${adoptionRoot}/${operationId}.policy.json`,selected.policy);
      const intent = parseHostedReadonlyDependencyAdoptionIntent({ version: 1, operationId, candidateJobId: binding.jobId,
        candidateReady: committed.reference, policyInput, maintenance });
      writeReferenceOnce(`${adoptionRoot}/${binding.workspace.dev}-${binding.workspace.ino}.intent.json`,intent);
      const grant = parseHostedTestEgressGrant({ schemaVersion: 1, jobId: selected.policy.jobId, jobRootDir: binding.jobRootDir,
        workspacePath: binding.workspace.canonicalPath, profileId: CodexProviderEgressProfileId.TestManagedQualification });
      // Narrow actual effect, not a relaxation of the generic grant writer.
      writeReferenceOnce(`${hostedTestEgressGrantRoot}/${name}`,grant);
      assertDependencyMaintenance(store,binding.workspace,maintenance);
      return Object.freeze({ operationId, policyPath: policyInput.path });
    } finally { store.close(); }
  });
}
/** Call only after real existing enroll/admit obtained the immutable lease and
 * CLOSED epoch. Completion selects an actual fixed intent, never a Prepared
 * handle/boolean; release and incrementing migration share the same real fence. */
export function completeHostedReadonlyDependencyAdoption(candidateJobId: string): void {
  new HostedInstallationActivationStore().withExclusivePreparation(fence => {
    const kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
    const original = currentOriginal(candidateJobId), binding = original.binding;
    const path = `${adoptionRoot}/${binding.workspace.dev}-${binding.workspace.ino}.intent.json`;
    const intentPin = privatePin(path,16384);
    const intent = readFixedReference(intentPin.reference,path,parseHostedReadonlyDependencyAdoptionIntent);
    if (intent.candidateJobId !== binding.jobId || !sameDependencyProtectedReference(intent.candidateReady,original.committed.reference)) invalid();
    const selected = policyScope(readFixedReference(intent.policyInput,`${adoptionRoot}/${intent.operationId}.policy.json`,parseHostedReadonlyPolicy));
    if (!sameDependencyWorkspace(selected.binding.workspace,binding.workspace)) invalid();
    const { installation } = readHostedInstallationActivation(), epoch = new HostedReadonlyEpochStore().readEpoch();
    if (epoch.phase !== HostedCustodyPhase.Closed || epoch.revoked || epoch.outerRuntime !== null || epoch.reservations.length ||
        epoch.hostId !== session.hostId || epoch.bootId !== session.bootId || epoch.supervisorId !== session.supervisorId ||
        epoch.identity.jobId !== selected.policy.jobId || epoch.identity.jobRootDir !== binding.jobRootDir ||
        epoch.identity.workspacePath !== binding.workspace.canonicalPath || epoch.identity.runtimeSha !== installation.runtimeSha) invalid();
    new HostedReadonlySupervisorHost().verifyReadonlyMaterial(epoch.identity);
    const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
    try {
      // Closed grammar plus actual owner match authenticate the retained intent.
      const parsed = parseDependencyOwner({ version: 2, workspace: binding.workspace, revision: 1, epoch: intent.maintenance.epoch,
        owner: { kind: DependencyOwnerKind.Maintenance, phase: DependencyOwnerPhase.ExclusiveMutation, attempt: intent.maintenance } });
      if (parsed.owner?.kind !== DependencyOwnerKind.Maintenance || !sameDependencyMaintenanceAttempt(parsed.owner.attempt,intent.maintenance) ||
          intent.maintenance.host.installationId !== installation.installationId || intent.maintenance.host.bootId !== session.bootId ||
          intent.maintenance.host.runtimeSha !== installation.runtimeSha || intent.maintenance.host.inventoryDigest !== installation.inventorySha256 ||
          intent.maintenance.host.grantDigest !== binding.grantDigest || intent.maintenance.host.supervisorId !== session.supervisorId) invalid();
      assertDependencyMaintenance(store,binding.workspace,intent.maintenance);
      const name = readonlyIdentityName(epoch.identity.jobId);
      const evidence = parseDependencyCustodyEvidence({ version: 1, kind: DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1,
        operationId: intent.operationId, workspace: binding.workspace,
        candidate: { jobId: binding.jobId, binding: privatePin(`${root}/${hostedDependencyBindingName(binding.jobId)}`,16384).reference,
          comparison: privatePin(`${root}/dependency-transactions/${original.comparison.operationId}.comparison.json`,16384).reference,
          sourceMapping: original.comparison.candidateSourceBinding },
        readonlyCustody: { jobId: epoch.identity.jobId, jobRootDir: binding.jobRootDir, workspacePath: binding.workspace.canonicalPath,
          grant: privatePin(`${hostedTestEgressGrantRoot}/${name}`,16384).reference,
          policy: privatePin(`${transportRoot}/codex-readonly/${name}`,16384).reference,
          review: privatePin(`${transportRoot}/codex-readonly-reviewed/${name}`,16384).reference,
          stage: privatePin(`${transportRoot}/codex-readonly-stages/${readonlyIdentityName(installation.runtimeDirectory)}`,16384).reference,
          lease: privatePin(`${root}/codex-readonly-custody/${name}`,16384).reference },
        installation: { installationId: installation.installationId, runtimeSha: installation.runtimeSha, inventoryDigest: installation.inventorySha256 } });
      if (evidence.kind !== DependencyCustodyEvidenceKind.ReadonlyLocalAdoptionV1) invalid();
      const association = writeReferenceOnce(`${root}/${readonlyDependencyAssociationName(binding.workspace)}`,evidence);
      // No await or open admission between null release and v3 migration.
      releaseDependencyMaintenance(store,binding.workspace,intent.maintenance);
      const idle = store.read(binding.workspace); if (!idle || idle.version !== 2 || idle.owner !== null) invalid();
      store.compareAndSwap(binding.workspace,idle.revision,{ ...idle, version: 3, revision: idle.revision + 1, custodyBinding: association });
      const current = store.read(binding.workspace);
      if (!current || current.version !== 3 || current.revision !== idle.revision + 1 || current.epoch !== idle.epoch || current.owner !== null ||
          !sameDependencyProtectedReference(current.custodyBinding,association)) invalid();
    } finally { store.close(); }
  });
}
