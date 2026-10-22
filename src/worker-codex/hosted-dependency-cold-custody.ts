import { DependencyGenerationContinuityKind } from "@vioxen/subscription-runtime/core";
import { selectOriginalHostedDependencyAbsentCustodyCandidate, readOriginalHostedDependencyAbsentCandidate } from "./hosted-dependency-absent-custody";
import { randomUUID } from "node:crypto";
import { DependencyCustodyEvidenceKind, DependencyOwnerKind, DependencyOwnerPhase, parseDependencyOwner,
  parseDependencyCustodyEvidence, sameDependencyProtectedReference, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, HostedCustodyPhase } from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { assertHostedActivationFence, assertHostedActivationOperator, readHostedActivationBytes,
  withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyOwnerRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readonlyDependencyAssociationName, hostedReadonlyDependencyAssociationRoot } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { selectOriginalHostedDependencyColdCustodyCandidate, reassertOriginalHostedDependencyColdCustodyCandidate } from "./hosted-dependency-cold-custody-selection";
import { captureHostedDependencyColdCustodyPolicy, parseHostedDependencyColdCustodyIntent, coldCustodyRoot,
  HostedDependencyColdCustodyIntentKind, type HostedDependencyColdCustodyIntent } from "./hosted-dependency-cold-custody-intent";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { readReadonlyReview, readonlyIdentityName } from "./hosted-readonly-authority";
import { inspectReadonlyInputs } from "./hosted-readonly-custody";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { parseHostedTestEgressGrant } from "./hosted-test-egress-contract";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { ensureHostedDependencyDirectory } from "./hosted-dependency-receipts";
import { encodeReference as encode, pinReferenceFile, writeReferenceOnce } from "./hosted-dependency-legacy-reference-records";
const root="/var/lib/subscription-runtime-host-policy",transport="/run/user/0/subscription-runtime-host-policy";
function held():never{throw new Error("hosted_dependency_cold_custody_held");}
function boundary(fence:HostedActivationFence,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();
}
function equal(a:unknown,b:unknown):boolean{return encode(a).equals(encode(b));}
function owner(workspace:DependencyOwnerRecord["workspace"]) {
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
  try{return store.read(workspace);}finally{store.close();}
}
/** No collector/owner read is executed under the publication mutex. Only the
 * captured predecessor and exact fixed successor are compared by the verifier. */
function publishOwner(fence:HostedActivationFence,previous:DependencyOwnerRecord,next:DependencyOwnerRecord,access:symbol):void {
  boundary(fence,access);
  const store=LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384,generationBaselineVerifier:{
    assertGenerationBaselineTransition({previousOwner,proposedOwner}) {
      assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
      if(!equal(previousOwner,previous) || !equal(proposedOwner,next))held();
    },
  }});
  try{if(!equal(store.compareAndSwap(previous.workspace,previous.revision,next),next) || !equal(store.read(previous.workspace),next))held();}
  finally{store.close();}boundary(fence,access);
}
function policyScope(input:unknown) {
  const policy=captureHostedDependencyColdCustodyPolicy(input),jobId=policy.jobRootDir.slice(policy.jobRootDir.lastIndexOf("/")+1),
    binding=readHostedDependencyBinding(jobId),actual=readHostedInstallationActivation();
  if(!binding || binding.version!==2 || policy.jobId===jobId || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(policy.jobId) ||
      policy.jobRootDir!==binding.jobRootDir || policy.workspacePath!==binding.workspace.canonicalPath || policy.runtimeSha!==binding.runtimeSha ||
      policy.runtimeManifestSha256!==actual.installation.runtimeManifestSha256 ||
      !equal([...policy.readonlyPaths].sort(),["packages/live","packages/packed","TEST-readonly-local-custody"].map(p=>`${policy.workspacePath}/${p}`).sort()))held();
  const review=readReadonlyReview(policy);inspectReadonlyInputs(policy,review.corepackShim);
  return {policy,binding,actual};
}
function intentPath(workspace:DependencyOwnerRecord["workspace"]):string{return `${coldCustodyRoot}/${workspace.dev}-${workspace.ino}.intent.json`;}
function readIntent(workspace:DependencyOwnerRecord["workspace"]) {
  const pin=pinReferenceFile(intentPath(workspace),65536),intent=parseHostedDependencyColdCustodyIntent(JSON.parse(pin.bytes.toString("utf8")));
  if(!pin.bytes.equals(encode(intent)) || !equal(intent.originalIdle.workspace,workspace))held();return {pin,intent};
}
function reassert(fence:HostedActivationFence,intent:HostedDependencyColdCustodyIntent,access:symbol) {
  boundary(fence,access);const selected=intent.version===2 ? readOriginalHostedDependencyAbsentCandidate(fence,intent.removalRelease,access) :
    reassertOriginalHostedDependencyColdCustodyCandidate(fence,intent.candidate,access),
    session=new HostedReadonlyHostKernel().operatorSession(),installation=readHostedInstallationActivation().installation,claimed=intent.claimedOwner;
  if(claimed.version!==2 || claimed.owner?.kind!==DependencyOwnerKind.Maintenance || claimed.owner.phase!==DependencyOwnerPhase.ExclusiveMutation)held();
  const host=claimed.owner.attempt.host;
  if(host.bootId!==session.bootId || host.supervisorId!==session.supervisorId || host.installationId!==installation.installationId ||
      host.runtimeSha!==installation.runtimeSha || host.inventoryDigest!==installation.inventorySha256 || host.grantDigest!==selected.binding.grantDigest)held();
  if(intent.version===2 && (!("candidate" in selected) || !equal(selected.candidate,intent.candidate) || !("priorAbsent" in selected) || !equal(selected.priorAbsent,intent.priorAbsent) ||
    !("previous" in selected) || !equal(selected.previous,intent.originalIdle)))held();
  const policyPin=pinReferenceFile(intent.policyInput.path,16384);
  if(!sameDependencyProtectedReference(policyPin.reference,intent.policyInput))held();
  const configured=policyScope(JSON.parse(policyPin.bytes.toString("utf8")));
  if(!equal(configured.binding,selected.binding))held();boundary(fence,access);return {...selected,...configured};
}
/** Fixed original operator preparation while C is still ORDINARY. Enrollment
 * happens through the existing real supervisor AFTER the own Maintenance claim.
 * Returned policy configuration contains no owner/capability token. */
export function prepareOriginalHostedDependencyColdCustody(input:unknown,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  return withHostedActivationFence(fence=>{
    boundary(fence,access);const configured=policyScope(input),{binding,policy,actual}=configured;
    if(actual.activation.phase!==HostedActivationPhase.Ordinary || readHostedActivationBytes("readonly-enrollment.json"))held();
    const existing=readHostedPrivateBytes(intentPath(binding.workspace),65536);
    let intent:HostedDependencyColdCustodyIntent;
    if(existing) {
      intent=readIntent(binding.workspace).intent;const selected=reassert(fence,intent,access);
      if(!equal(selected.policy,policy) || ![intent.originalIdle,intent.claimedOwner].some(v=>equal(owner(binding.workspace),v)))held();
    }else {
      const actualOwner=owner(binding.workspace),selected=actualOwner?.version!==1 && actualOwner?.generationContinuity?.kind===DependencyGenerationContinuityKind.RetiredEvictingV1 ?
        selectOriginalHostedDependencyAbsentCustodyCandidate(fence,binding.jobId,access) : selectOriginalHostedDependencyColdCustodyCandidate(fence,binding.jobId,access),previous=selected.previous,
        session=new HostedReadonlyHostKernel().operatorSession(),operationId=randomUUID(),maintenance={operationId,epoch:previous.epoch+1,
          host:{installationId:actual.installation.installationId,bootId:session.bootId,runtimeSha:actual.installation.runtimeSha,
            inventoryDigest:actual.installation.inventorySha256,grantDigest:binding.grantDigest,supervisorId:session.supervisorId}},
        claimedOwner=parseDependencyOwner({...previous,revision:previous.revision+1,epoch:maintenance.epoch,
          owner:{kind:DependencyOwnerKind.Maintenance,phase:DependencyOwnerPhase.ExclusiveMutation,attempt:maintenance}});
      const name=readonlyIdentityName(policy.jobId);
      for(const path of [`${hostedTestEgressGrantRoot}/${name}`,`${transport}/codex-readonly/${name}`,`${root}/codex-readonly-custody/${name}`])
        if(readHostedPrivateBytes(path,16384))held();
      ensureHostedDependencyDirectory(coldCustodyRoot);
      const policyInput=writeReferenceOnce(`${coldCustodyRoot}/${operationId}.policy.json`,policy);
      intent=parseHostedDependencyColdCustodyIntent({operationId,candidate:selected.candidate,originalIdle:previous,claimedOwner,policyInput,
        ...("removalRelease" in selected ? {version:2,kind:HostedDependencyColdCustodyIntentKind.AbsentRestoration,removalRelease:selected.removalRelease,priorAbsent:selected.priorAbsent} : {version:1})});
      writeReferenceOnce(intentPath(binding.workspace),intent);
    }
    reassert(fence,intent,access);
    if(equal(owner(binding.workspace),intent.originalIdle))publishOwner(fence,intent.originalIdle,intent.claimedOwner,access);
    if(!equal(owner(binding.workspace),intent.claimedOwner))held();
    const grant=parseHostedTestEgressGrant({schemaVersion:1,jobId:policy.jobId,jobRootDir:binding.jobRootDir,
      workspacePath:binding.workspace.canonicalPath,profileId:CodexProviderEgressProfileId.TestManagedQualification});
    writeReferenceOnce(`${hostedTestEgressGrantRoot}/${readonlyIdentityName(policy.jobId)}`,grant);
    reassert(fence,intent,access);if(!equal(owner(binding.workspace),intent.claimedOwner))held();
    return Object.freeze({operationId:intent.operationId,policyPath:intent.policyInput.path});
  });
}
/** Completes only the actual enrolled Closed epoch and own retained intent.
 * Exact stage successors are deterministic, so retries cannot invent time,
 * UUID or a fresh operation to skip an unresolved transfer. */
export function completeOriginalHostedDependencyColdCustody(jobId:string,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  new HostedInstallationActivationStore().withExclusivePreparation(fence=>{
    boundary(fence,access);const binding=readHostedDependencyBinding(jobId);if(!binding || binding.version!==2)held();
    const {intent,pin:intentPin}=readIntent(binding.workspace),selected=reassert(fence,intent,access),
      epoch=new HostedReadonlyEpochStore().readEpoch(),session=new HostedReadonlyHostKernel().operatorSession();
    if(intent.candidate.jobId!==jobId || epoch.phase!==HostedCustodyPhase.Closed || epoch.revoked || epoch.outerRuntime || epoch.reservations.length ||
        epoch.hostId!==session.hostId || epoch.bootId!==session.bootId || epoch.supervisorId!==session.supervisorId ||
        epoch.identity.jobId!==selected.policy.jobId || epoch.identity.jobRootDir!==binding.jobRootDir ||
        epoch.identity.workspacePath!==binding.workspace.canonicalPath || epoch.identity.runtimeSha!==binding.runtimeSha)held();
    new HostedReadonlySupervisorHost().verifyReadonlyMaterial(epoch.identity);
    const name=readonlyIdentityName(epoch.identity.jobId),installation=selected.actual.installation;
    const evidence=parseDependencyCustodyEvidence({version:2,kind:DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2,
      operationId:intent.operationId,workspace:binding.workspace,candidate:intent.candidate,
      installation:{installationId:installation.installationId,runtimeSha:installation.runtimeSha,inventoryDigest:installation.inventorySha256},
      readonlyCustody:{jobId:epoch.identity.jobId,jobRootDir:binding.jobRootDir,workspacePath:binding.workspace.canonicalPath,
        grant:pinReferenceFile(`${hostedTestEgressGrantRoot}/${name}`,16384).reference,policy:pinReferenceFile(`${transport}/codex-readonly/${name}`,16384).reference,
        review:pinReferenceFile(`${transport}/codex-readonly-reviewed/${name}`,16384).reference,
        stage:pinReferenceFile(`${transport}/codex-readonly-stages/${readonlyIdentityName(installation.runtimeDirectory)}`,16384).reference,
        lease:pinReferenceFile(`${root}/codex-readonly-custody/${name}`,16384).reference}});
    if(evidence.kind!==DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2)held();
    const claimed=intent.claimedOwner;
    if(claimed.owner?.kind!==DependencyOwnerKind.Maintenance)held();
    const fenced=parseDependencyOwner({...claimed,revision:claimed.revision+1,owner:{...claimed.owner,phase:DependencyOwnerPhase.Fenced}}),
      idle=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null});
    // Association publication is itself fenced by the actual own retained
    // Maintenance (or exact own release retry), never a foreign live Consumer.
    const existingAssociation=readHostedPrivateBytes(`${root}/${readonlyDependencyAssociationName(binding.workspace)}`,16384);
    let association:ReturnType<typeof writeReferenceOnce>;
    if(existingAssociation) {
      if(!existingAssociation.equals(encode(evidence)))held();
      association=pinReferenceFile(`${root}/${readonlyDependencyAssociationName(binding.workspace)}`,16384).reference;
    }else {
      if(!equal(owner(binding.workspace),claimed) && !equal(owner(binding.workspace),fenced))held();
      ensureHostedDependencyDirectory(hostedReadonlyDependencyAssociationRoot);
      association=writeReferenceOnce(`${root}/${readonlyDependencyAssociationName(binding.workspace)}`,evidence);
    }
    const migrated=parseDependencyOwner({...idle,version:3,revision:idle.revision+1,custodyBinding:association});
    if(![claimed,fenced,idle,migrated].some(v=>equal(owner(binding.workspace),v)))held();
    const stages:readonly (readonly [DependencyOwnerRecord,DependencyOwnerRecord])[]=[[claimed,fenced],[fenced,idle],[idle,migrated]];
    for(const [previous,next] of stages) {
      reassert(fence,intent,access);
      const current=owner(binding.workspace);
      if(equal(current,previous))publishOwner(fence,previous,next,access);
      else if(![next,idle,migrated].some(v=>equal(current,v)))held();
    }
    reassert(fence,intent,access);if(!equal(owner(binding.workspace),migrated) ||
        !sameDependencyProtectedReference(pinReferenceFile(intentPin.reference.path,65536).reference,intentPin.reference) ||
        !sameDependencyProtectedReference(pinReferenceFile(association.path,16384).reference,association) ||
        !equal(new HostedReadonlyEpochStore().readEpoch(),epoch))held();
    writeReferenceOnce(`${coldCustodyRoot}/${intent.operationId}.transfer.json`,{intent:intentPin.reference,association,
      ...(intent.version===2 ? {version:2,kind:HostedDependencyColdCustodyIntentKind.AbsentRestoration,removalRelease:intent.removalRelease,priorAbsent:intent.priorAbsent} : {version:1}),
      candidate:intent.candidate,originalIdle:intent.originalIdle,claimedOwner:claimed,fencedOwner:fenced,releasedOwner:idle,migratedOwner:migrated});
    reassert(fence,intent,access);if(!equal(owner(binding.workspace),migrated))held();
  });
}
