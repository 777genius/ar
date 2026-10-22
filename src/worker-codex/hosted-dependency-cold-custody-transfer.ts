import { readOriginalHostedDependencyAbsentCandidate } from "./hosted-dependency-absent-custody";
import { HostedDependencyColdCustodyIntentKind } from "./hosted-dependency-cold-custody-intent";
import { DependencyCustodyEvidenceKind, DependencyOwnerKind, DependencyOwnerPhase, isDependencyCustodyObject,
  isDependencyProtectedReference, parseDependencyOwner, sameDependencyProtectedReference, type DependencyOwnerRecord } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import type { HostedReadonlyDependencyAssociation } from "../provider-codex/app-server/adapters/hosted-dependency-origin";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { coldCustodyRoot, parseHostedDependencyColdCustodyIntent } from "./hosted-dependency-cold-custody-intent";
import { reassertOriginalHostedDependencyColdCustodyCandidate } from "./hosted-dependency-cold-custody-selection";
function held():never{throw new Error("hosted_dependency_cold_custody_transfer_held");}
/** Only the once-sealed actual migration can supply FIRST R's predecessor.
 * Later owner revisions must consume their own R discharge; no historical
 * adoption, Terminal boolean or old C idle can be reused as a fresh permit. */
export function readOriginalHostedDependencyColdCustodyTransfer(fence:HostedActivationFence,
  material:HostedReadonlyDependencyAssociation,previous:DependencyOwnerRecord,access:symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);assertHostedActivationOperator();assertHostedProcessDescriptors();
  const a=material.evidence;
  if(a.kind!==DependencyCustodyEvidenceKind.ReadonlyColdBaselineAdoptionV2)return undefined;
  const pin=pinReferenceFile(`${coldCustodyRoot}/${a.operationId}.transfer.json`,65536),v:unknown=JSON.parse(pin.bytes.toString("utf8"));
  const absent=isDependencyCustodyObject(v,"association,candidate,claimedOwner,fencedOwner,intent,kind,migratedOwner,originalIdle,priorAbsent,releasedOwner,removalRelease,version") &&
    v.version===2 && v.kind===HostedDependencyColdCustodyIntentKind.AbsentRestoration;
  if(!(absent || isDependencyCustodyObject(v,"association,candidate,claimedOwner,fencedOwner,intent,migratedOwner,originalIdle,releasedOwner,version") && v.version===1) || !pin.bytes.equals(encode(v)) || !encode(v.association).equals(encode(material.reference)) ||
      !encode(v.candidate).equals(encode(a.candidate)) || !isDependencyProtectedReference(v.intent) ||
      v.intent.path!==`${coldCustodyRoot}/${a.workspace.dev}-${a.workspace.ino}.intent.json`)held();
  const intentPin=pinReferenceFile(v.intent.path,65536),intent=parseHostedDependencyColdCustodyIntent(JSON.parse(intentPin.bytes.toString("utf8")));
  if(!sameDependencyProtectedReference(intentPin.reference,v.intent) || !intentPin.bytes.equals(encode(intent)) || intent.operationId!==a.operationId ||
      !encode(intent.candidate).equals(encode(a.candidate)) || !encode(intent.originalIdle).equals(encode(v.originalIdle)) ||
      !encode(intent.claimedOwner).equals(encode(v.claimedOwner)))held();
  if(absent!== (intent.version===2) || intent.version===2 && (!encode(v.removalRelease).equals(encode(intent.removalRelease)) || !encode(v.priorAbsent).equals(encode(intent.priorAbsent))))held();
  const claimed=intent.claimedOwner;
  if(claimed.owner?.kind!==DependencyOwnerKind.Maintenance)held();
  const fenced=parseDependencyOwner({...claimed,revision:claimed.revision+1,owner:{...claimed.owner,phase:DependencyOwnerPhase.Fenced}}),
    released=parseDependencyOwner({...fenced,revision:fenced.revision+1,owner:null}),
    migrated=parseDependencyOwner({...released,version:3,revision:released.revision+1,custodyBinding:material.reference});
  if(!encode(fenced).equals(encode(v.fencedOwner)) || !encode(released).equals(encode(v.releasedOwner)) || !encode(migrated).equals(encode(v.migratedOwner)))held();
  // A later R idle revision is not this first-use transfer. Its separate exact
  // R idle reader is selected by the caller, not by relabeling this proof.
  if(!encode(previous).equals(encode(migrated)))return undefined;
  if(intent.version===2) {
    const proof=readOriginalHostedDependencyAbsentCandidate(fence,intent.removalRelease,access);
    if(!encode(proof.candidate).equals(encode(a.candidate)) || !encode(proof.previous).equals(encode(intent.originalIdle)) || !encode(proof.priorAbsent).equals(encode(intent.priorAbsent)))held();
  }else reassertOriginalHostedDependencyColdCustodyCandidate(fence,a.candidate,access);
  if(!sameDependencyProtectedReference(pinReferenceFile(pin.reference.path,65536).reference,pin.reference) ||
      !sameDependencyProtectedReference(pinReferenceFile(intentPin.reference.path,65536).reference,intentPin.reference))held();
  assertHostedProcessDescriptors();assertHostedActivationFence(fence);return Object.freeze({previous:migrated,reference:pin.reference});
}
