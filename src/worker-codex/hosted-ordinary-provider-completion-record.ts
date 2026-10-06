import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { sameDependencyProtectedReference, ScopedTerminationExtent, parseScopedProviderOnlyReceipt, type ScopedProviderOnlyReceipt } from "@vioxen/subscription-runtime/core";
import { readHostedOrdinaryProviderFacts, HostedOrdinaryProviderReadPhase, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { CurrentHostedDependencyOriginKind, readOriginalHostedManagedProviderWaitFacts, readCurrentHostedManagedDependencyProviderParent,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { readOriginalHostedOrdinaryProviderBirthFacts } from "./hosted-ordinary-dependency-provider-facts";
import { collectHostedManagedProviderDrain } from "./hosted-managed-provider-drain-observation";
import { matchesManagedProviderProxyWait } from "./hosted-managed-provider-terminal-facts";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
const root="/var/lib/subscription-runtime-host-policy";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function invalid():never {throw new Error("hosted_dependency_current_origin_unresolved");}
function collected(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string,phase:HostedOrdinaryProviderReadPhase) {
  const selected=readOriginalHostedManagedProviderWaitFacts(context,fence,unit),parent=selected.parent;
  if (parent.facts.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
  const birth=readOriginalHostedOrdinaryProviderBirthFacts(context,fence,unit,phase);
  if (birth.version!==2) invalid();
  const start=pinReferenceFile(`${root}/dependency-managed-provider-starts/${birth.providerStartId}.json`,16384);
  if (!sameDependencyProtectedReference(start.reference,selected.reference) || !start.bytes.equals(encode(birth))) invalid();
  try {lstatSync(`/proc/${selected.pid}`);invalid();} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
  const terminal=collectHostedManagedProviderDrain(unit);
  if (!matchesManagedProviderProxyWait(terminal,selected.invocationId,selected.waitStatus)) invalid();
  const ordinary=readHostedOrdinaryProviderFacts(fence,birth.providerStartId,phase);
  const after=readOriginalHostedManagedProviderWaitFacts(context,fence,unit);
  if (!encode(selected).equals(encode(after))) invalid();
  return {selected,birth,ordinary,terminal};
}
/** Writes truthful C native completion only after the same privately captured
 * child/current origin/future fence/queue/cgroup/FD proof. A nonzero outcome may
 * discharge this child; unknown proof never becomes ordinary zero or a grant. */
export function publishOriginalHostedOrdinaryProviderCompletion(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string):ScopedProviderOnlyReceipt {
  const facts=collected(context,fence,unit,HostedOrdinaryProviderReadPhase.Reserved),{selected,birth,ordinary,terminal}=facts;
  const bytes=encode({schemaVersion:2,parentAttempt:selected.parent.attempt,unit,providerStartId:birth.providerStartId,
    providerReference:selected.reference,ordinaryProviderReference:birth.ordinaryProviderReference,parentReference:birth.originReference,
    relation:birth.ordinaryRelation,invocationId:selected.invocationId,proxyBirth:selected.birth,waitStatus:selected.waitStatus,
    home:selected.home,use:selected.use,terminal:terminal ?? null});
  const directory=`${root}/dependency-ordinary-provider-completions`;
  try {mkdirSync(directory,{mode:0o700});} catch(error) {if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;}
  const pin=readHostedDependencyRootDirectoryPin(directory),rootPin=readHostedDependencyRootDirectoryPin(root),stat=lstatSync(directory);
  if (stat.uid!==0 || stat.gid!==0 || (stat.mode & 0o7777)!==0o700 || pin.dev!==rootPin.dev || pin.mountId!==rootPin.mountId) invalid();
  const path=`${directory}/${birth.providerStartId}.json`;createReadonlyPrivateRecord(path,bytes);
  const completion=pinReferenceFile(path,16384);if (!completion.bytes.equals(bytes)) invalid();
  if (selected.waitStatus===0) createReadonlyPrivateRecord(`${root}/ordinary-completed/${birth.providerStartId}.json`,encode({schemaVersion:1,startId:birth.providerStartId,startSha256:birth.ordinaryProviderReference.sha256,waitStatus:0}));
  const parent=selected.parent.facts;if (parent.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
  const member=(row:Readonly<Record<string,unknown>>,start:ScopedProviderOnlyReceipt["parent"]["start"])=>({
    startId:String(row.startId),unit:String(row.unit),creatorId:String(row.creatorId),originSha256:String(row.originSha256),generation:Number(row.generation),start});
  const receipt=parseScopedProviderOnlyReceipt({schemaVersion:2,extent:ScopedTerminationExtent.ProviderOnly,publicationGeneration:Number(parent.ordinary.activation.generation)+1,
    identity:{installationId:birth.installationId,hostId:birth.hostId,bootId:birth.bootId,supervisorId:birth.supervisorId,runtimeSha:birth.runtimeSha},
    parent:member(parent.ordinary.reservation,birth.originReference),provider:member(ordinary.reservation,birth.ordinaryProviderReference),
    attempt:{attemptId:selected.parent.attempt.attemptId,epoch:selected.parent.attempt.epoch,grantDigest:selected.parent.attempt.launch.grantDigest},
    home:selected.home,use:selected.use,completion:completion.reference});
  assertOriginalHostedOrdinaryProviderCompletion(context,fence,unit,receipt,HostedOrdinaryProviderReadPhase.Reserved);return receipt;
}
/** Actual proof and exact durable completion rejoin for Reserved publication OR
 * its own Terminal readback. No saved receipt alone authorizes a transition. */
export function assertOriginalHostedOrdinaryProviderCompletion(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,unit:string,
  receipt:ScopedProviderOnlyReceipt,phase:HostedOrdinaryProviderReadPhase):void {
  const facts=collected(context,fence,unit,phase),{selected,birth,ordinary,terminal}=facts;
  const parent=selected.parent.facts; if (parent.kind!==CurrentHostedDependencyOriginKind.Ordinary) invalid();
  const exact=(row:Readonly<Record<string,unknown>>,member:ScopedProviderOnlyReceipt["parent"])=>
    row.startId===member.startId && row.unit===member.unit && row.creatorId===member.creatorId && row.originSha256===member.originSha256 && row.generation===member.generation;
  if (!exact(parent.ordinary.reservation,receipt.parent) || !exact(ordinary.reservation,receipt.provider) ||
      receipt.identity.installationId!==birth.installationId || receipt.identity.hostId!==birth.hostId || receipt.identity.bootId!==birth.bootId ||
      receipt.identity.supervisorId!==birth.supervisorId || receipt.identity.runtimeSha!==birth.runtimeSha || receipt.provider.unit!==unit ||
      receipt.attempt.grantDigest!==selected.parent.attempt.launch.grantDigest ||
      (phase===HostedOrdinaryProviderReadPhase.Reserved ? receipt.publicationGeneration!==parent.ordinary.activation.generation+1 :
        receipt.publicationGeneration>parent.ordinary.activation.generation)) invalid();
  const completion=pinReferenceFile(`${root}/dependency-ordinary-provider-completions/${birth.providerStartId}.json`,16384);
  if (!sameDependencyProtectedReference(completion.reference,receipt.completion) || !completion.bytes.equals(encode({schemaVersion:2,parentAttempt:selected.parent.attempt,
      unit,providerStartId:birth.providerStartId,providerReference:selected.reference,ordinaryProviderReference:birth.ordinaryProviderReference,parentReference:birth.originReference,
      relation:birth.ordinaryRelation,invocationId:selected.invocationId,proxyBirth:selected.birth,waitStatus:selected.waitStatus,home:selected.home,use:selected.use,terminal:terminal ?? null})) ||
      !encode(selected.home).equals(encode(receipt.home)) || !encode(selected.use).equals(encode(receipt.use)) ||
      !sameDependencyProtectedReference(birth.originReference,receipt.parent.start) || !sameDependencyProtectedReference(birth.ordinaryProviderReference,receipt.provider.start) ||
      birth.providerStartId!==receipt.provider.startId || birth.parentStartId!==receipt.parent.startId || birth.generation!==receipt.provider.generation ||
      selected.parent.attempt.attemptId!==receipt.attempt.attemptId || selected.parent.attempt.epoch!==receipt.attempt.epoch) invalid();
  readCurrentHostedManagedDependencyProviderParent(context,fence);
}
