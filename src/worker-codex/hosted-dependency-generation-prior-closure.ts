import { HostedDependencySourceRuntimeClosureKind as ClosureKind } from "./hosted-dependency-generation-state";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { isDependencyCustodyObject, isDependencyProtectedReference, sameDependencyProtectedReference,
  parseScopedOrdinaryReaderFinalReceipt } from "@vioxen/subscription-runtime/core";
import { HostedCustodyReservationState, parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { readOriginalHostedDependencyGenerationNativeScope } from "./hosted-dependency-generation-native-scope";
import { assertOriginalHostedDependencyPhysicalRecordAccess, type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { HostedReadonlyHostKernel } from "./hosted-readonly-host-kernel";
import { readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedDependencyInstallerAttemptDrained } from "./hosted-dependency-installer";
import { collectUnitNotFound } from "./hosted-readonly-linux-collector";
import { spawnSync } from "node:child_process";
import { matchesManagedProviderProxyWait, parseHostedManagedProviderTerminalFacts, parseHostedOrdinaryReaderTerminalFacts } from "./hosted-managed-provider-terminal-facts";

const root="/var/lib/subscription-runtime-host-policy",encode=(v:unknown)=>Buffer.from(JSON.stringify(v)+"\n");
function invalid():never {throw new Error("hosted_dependency_prior_source_closure_unresolved");}
function boundary(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(context)readOriginalHostedDependencyGenerationNativeScope(context,fence,access);
  else {assertHostedActivationOperator();assertHostedProcessDescriptors();}
}
/** A listed historical unit is not excluded by Terminal/PID absence. Only the
 * original successful per-attempt discharge chain can establish this factual
 * classification. Fresh native queue/recursive checks are always repeated.
 * Absent pre-protocol closure withholds Active, preserving ordinary Usable.
 * Returned names are factual and lexical-access-only, never a scope permit. */
export function readOriginalHostedDependencyPriorCSourceClosure(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string,access:symbol):readonly string[]|undefined {
  return priorCSourceClosure(context,fence,unit,access);
}
/** Fixed operator branch for pre-spawn claim, never a fabricated Consumer. */
export function readOriginalHostedDependencyOperatorPriorCSourceClosure(fence:HostedActivationFence,unit:string,access:symbol):readonly string[]|undefined {
  return priorCSourceClosure(undefined,fence,unit,access);
}
function priorCSourceClosure(context:CurrentHostedDependencyOrigin|undefined,fence:HostedActivationFence,unit:string,access:symbol):readonly string[]|undefined {
  boundary(context,fence,access);
  const initial=readHostedInstallationActivation(),row=initial.activation.ordinaryStarts.find(v=>v.unit===unit);
  if(!row || row.state!==HostedCustodyReservationState.Terminal)return undefined;
  let parentId=row.startId;
  if(unit===`subscription-runtime-hosted-${row.startId}.service`) {
    const relation=readHostedPrivateBytes(`${root}/dependency-provider-attempts/${row.startId}.json`,4096);if(!relation)return undefined;
    const v:unknown=JSON.parse(relation.toString("utf8"));
    if(!isDependencyCustodyObject(v,"attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version") || v.version!==1 ||
        v.providerStartId!==row.startId || v.unit!==unit || typeof v.parentStartId!=="string")invalid();parentId=v.parentStartId;
  }else if(unit!==`subscription-runtime-ordinary-${row.startId}.service`)return undefined;
  if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(parentId)?.[0]!==parentId)invalid();
  const closurePath=`${root}/dependency-generation-source-closures/${parentId}.json`,exists=readHostedPrivateBytes(closurePath,65536);
  if(!exists)return undefined;
  const closure=pinReferenceFile(closurePath,65536),v:unknown=JSON.parse(closure.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(v,"attempt,barrier,baseline,binding,final,pending,retirement,version") || v.version!==1 || !closure.bytes.equals(encode(v)))invalid();
  const proof=parseScopedOrdinaryReaderFinalReceipt(v.final),parent=initial.activation.ordinaryStarts.find(r=>r.startId===parentId),kernel=new HostedReadonlyHostKernel();
  if(!parent || parent.state!==HostedCustodyReservationState.Terminal || proof.reader.startId!==parentId || proof.reader.unit!==parent.unit ||
      proof.reader.creatorId!==parent.creatorId || proof.reader.originSha256!==parent.originSha256 || proof.reader.generation!==parent.generation ||
      proof.identity.installationId!==initial.installation.installationId || proof.identity.runtimeSha!==initial.installation.runtimeSha ||
      proof.identity.hostId!==initial.activation.hostId || proof.identity.bootId!==initial.activation.bootId || proof.identity.supervisorId!==initial.activation.supervisorId)invalid();
  const pins=[closure];
  const reference=(value:unknown,path:string,maximum=16384)=>{
    if(!isDependencyProtectedReference(value) || value.path!==path)invalid();const pin=pinReferenceFile(path,maximum);
    if(!sameDependencyProtectedReference(pin.reference,value))invalid();pins.push(pin);return pin;
  };
  const start=reference(proof.reader.start,`${root}/ordinary-starts/${parentId}.json`),actual=parseHostedOrdinaryStart(JSON.parse(start.bytes.toString("utf8"))),binding=readHostedDependencyBinding(actual.jobId);
  if(!binding || binding.version!==2 || !encode(binding).equals(encode(v.binding)) || actual.unit!==parent.unit || actual.activationGeneration!==parent.generation ||
      actual.creatorId!==parent.creatorId || actual.originSha256!==parent.originSha256 || actual.bootId!==proof.identity.bootId || actual.supervisorId!==proof.identity.supervisorId ||
      binding.grantDigest!==proof.attempt.grantDigest || binding.installationId!==proof.identity.installationId || binding.runtimeSha!==proof.identity.runtimeSha ||
      binding.workspace.canonicalPath!==actual.workspacePath || binding.jobRootDir!==actual.jobRootDir ||
      !encode(v.attempt).equals(encode({attemptId:proof.attempt.attemptId,epoch:proof.attempt.epoch,launch:{installationId:binding.installationId,bootId:actual.bootId,
        runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId:parentId,unit:parent.unit}})))invalid();
  reference(proof.preclaim,`${root}/dependency-reader-starts/${parentId}.json`);
  const parentCompletion=reference(proof.completion,`${root}/dependency-ordinary-reader-completions/${parentId}.json`);
  const owned=[parent];
  const later=initial.activation.ordinaryStarts.filter(r=>r.unit.startsWith("subscription-runtime-hosted-") && r.creatorId===parent.creatorId &&
    r.originSha256===parent.originSha256 && r.generation>parent.generation);
  // Generation orders starts, not membership. Authenticate every original
  // relation before excluding a later provider belonging to another C epoch.
  const candidates=later.filter(current=>{
    const relation=pinReferenceFile(`${root}/dependency-provider-attempts/${current.startId}.json`,4096);
    pins.push(relation);const r:unknown=JSON.parse(relation.bytes.toString("utf8"));
    if(!isDependencyCustodyObject(r,"attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version") || r.version!==1 ||
        r.providerStartId!==current.startId || r.unit!==`subscription-runtime-hosted-${current.startId}.service` || r.unit!==current.unit ||
        typeof r.parentStartId!=="string" || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(r.parentStartId)?.[0]!==r.parentStartId ||
        typeof r.attemptId!=="string" || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(r.attemptId)?.[0]!==r.attemptId ||
        typeof r.epoch!=="number" || !Number.isSafeInteger(r.epoch) || r.epoch<1 || !relation.bytes.equals(encode(r)))invalid();
    const owner=initial.activation.ordinaryStarts.find(row=>row.startId===r.parentStartId);
    if(!owner || owner.unit!==`subscription-runtime-ordinary-${owner.startId}.service` || owner.creatorId!==current.creatorId ||
        owner.originSha256!==current.originSha256 || owner.generation>=current.generation)invalid();
    const birth=pinReferenceFile(`${root}/ordinary-starts/${current.startId}.json`,16384);pins.push(birth);
    const started=parseHostedOrdinaryStart(JSON.parse(birth.bytes.toString("utf8")));
    if(r.startDigest!==birth.reference.sha256 || started.unit!==current.unit || started.activationGeneration!==current.generation ||
        started.creatorId!==current.creatorId || started.originSha256!==current.originSha256)invalid();
    if(r.parentStartId!==parentId)return false;
    if(r.attemptId!==proof.attempt.attemptId || r.epoch!==proof.attempt.epoch)invalid();
    return true;
  });
  if(candidates.length!==proof.providers.length || candidates.length>128)invalid();
  for(const provider of proof.providers) {
    const member=provider.member,current=candidates.find(r=>r.startId===member.startId);
    if(!current || current.state!==HostedCustodyReservationState.Terminal || member.unit!==current.unit || member.generation!==current.generation ||
        member.creatorId!==current.creatorId || member.originSha256!==current.originSha256)invalid();
    reference(member.start,`${root}/ordinary-starts/${member.startId}.json`);
    const relation=reference(provider.relation,`${root}/dependency-provider-attempts/${member.startId}.json`,4096),r:unknown=JSON.parse(relation.bytes.toString("utf8"));
    if(!isDependencyCustodyObject(r,"attemptId,epoch,parentStartId,providerStartId,startDigest,unit,version") || r.version!==1 ||
        r.parentStartId!==parentId || r.providerStartId!==member.startId || r.unit!==member.unit || r.attemptId!==proof.attempt.attemptId || r.epoch!==proof.attempt.epoch ||
        r.startDigest!==member.start.sha256 || !relation.bytes.equals(encode(r)))invalid();
    const completion=reference(provider.completion,`${root}/dependency-ordinary-provider-completions/${member.startId}.json`);
    assertNativeCompletion(current.unit,completion.bytes,false);owned.push(current);
  }
  const retirement=reference(v.retirement,`${root}/dependency-generation-source-retirements/${parentId}.json`),retired:unknown=JSON.parse(retirement.bytes.toString("utf8"));
  if(!isDependencyCustodyObject(retired,"attempt,barrier,baseline,binding,lifecycle,pending,qualification,version") || retired.version!==1 ||
      !encode(retired.attempt).equals(encode(v.attempt)) || !encode(retired.binding).equals(encode(v.binding)) ||
      !encode(retired.pending).equals(encode(v.pending)) || !encode(retired.baseline).equals(encode(v.baseline)) || !encode(retired.barrier).equals(encode(v.barrier)) ||
      (retired.lifecycle!==ClosureKind.RuntimeNeverConfigured && retired.lifecycle!==ClosureKind.ConfiguredRuntimeDischarged) || !retirement.bytes.equals(encode(retired)))invalid();
  reference(retired.qualification,`${root}/${dependencyToolQualificationRecordName(parentId)}`);
  reference(v.pending,`${root}/dependency-generation-barriers/pending/${proof.attempt.attemptId}.json`);
  // These original historical baseline references preserve the factual chain;
  // they never attest current content or qualify a later owner by themselves.
  if(!isDependencyProtectedReference(v.barrier) || !/^\/var\/lib\/subscription-runtime-host-policy\/dependency-generation-barriers\/[a-f0-9-]{36}\.json$/.test(v.barrier.path) ||
      !isDependencyProtectedReference(v.baseline) || !/^\/var\/lib\/subscription-runtime-host-policy\/dependency-generation-baselines\/[a-f0-9-]{36}\.json$/.test(v.baseline.path))invalid();
  reference(v.barrier,v.barrier.path);reference(v.baseline,v.baseline.path,65536);
  const attemptFence=pinReferenceFile(`${root}/dependency-attempt-fences/${parentId}.json`,4096);pins.push(attemptFence);
  if(!attemptFence.bytes.equals(encode({version:1,startId:parentId,attemptId:proof.attempt.attemptId,epoch:proof.attempt.epoch})))invalid();
  assertNativeCompletion(parent.unit,parentCompletion.bytes,true);
  for(const selected of owned){kernel.drainOrdinaryQueue(selected);kernel.confirmOrdinaryDescendants(selected);}
  assertHostedDependencyInstallerAttemptDrained({attemptId:proof.attempt.attemptId,epoch:proof.attempt.epoch,
    launch:{installationId:binding.installationId,bootId:actual.bootId,runtimeSha:binding.runtimeSha,grantDigest:binding.grantDigest,startId:parentId,unit:parent.unit}});
  for(const pin of pins)if(!sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,pin.bytes.length).reference,pin.reference))invalid();
  if(!encode(readHostedInstallationActivation()).equals(encode(initial)))invalid();boundary(context,fence,access);
  return Object.freeze(owned.map(r=>r.unit));
}
function assertNativeCompletion(unit:string,bytes:Buffer,parent:boolean):void {
  const value:unknown=JSON.parse(bytes.toString("utf8"));
  if(!value || typeof value!=="object" || !("invocationId" in value) || !("waitStatus" in value) || !("terminal" in value) || !("unit" in value) ||
      value.unit!==unit || typeof value.invocationId!=="string" || /^[a-f0-9]{32}$/.exec(value.invocationId)?.[0]!==value.invocationId ||
      typeof value.waitStatus!=="number" || !Number.isInteger(value.waitStatus) || value.waitStatus<0 || value.waitStatus>255 || !bytes.equals(encode(value)))invalid();
  const parser=parent?parseHostedOrdinaryReaderTerminalFacts:parseHostedManagedProviderTerminalFacts;
  const t=value.terminal;
  if(t!==null) {
    if(!isDependencyCustodyObject(t,"invocationId,kind,result,status,unit"))invalid();
    const terminal=parser(unit,`Id=${t.unit}\nInvocationID=${t.invocationId}\nActiveState=failed\nSubState=failed\nMainPID=0\nControlPID=0\nJob=\nExecMainCode=${t.kind}\nExecMainStatus=${t.status}\nResult=${t.result}\n`);
    if(!encode(terminal).equals(encode(t)) || !matchesManagedProviderProxyWait(terminal,value.invocationId,value.waitStatus))invalid();
  }else if(value.waitStatus!==0)invalid();
  if(!collectUnitNotFound(unit)) {
    const result=spawnSync("/usr/bin/systemctl",["show","--property=Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result","--",unit],
      {encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:5000,maxBuffer:4096,env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C",SYSTEMD_COLORS:"0"}});
    if(result.error || result.status!==0 || !matchesManagedProviderProxyWait(parser(unit,result.stdout),value.invocationId,value.waitStatus) ||
        t!==null && !encode(parser(unit,result.stdout)).equals(encode(t)))invalid();
  }
}
