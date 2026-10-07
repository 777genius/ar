import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { DependencyGenerationContinuityKind, DependencyOwnerKind, isDependencyConsumerOwner, isDependencyCustodyObject,
  parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedDependencyQualifiedInventory, hostedDependencyJobsRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedDependencyParentRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readHostedOrdinaryBirth } from "./hosted-installation-activation";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)+"\n");
function held():never{throw new Error("hosted_dependency_parent_writer_ingress_held");}
/** Fixed installed operator ingress, BEFORE reservation/bootstrap effects. This
 * is denial/selection only: same-root Active still needs the genuine idle claim
 * and once-entry before submission. A nominal foreign cwd is not exclusion. */
export function assertOriginalHostedDependencyParentWriterIngress(fence:HostedActivationFence,jobId:string,access:symbol):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  if(typeof jobId!=="string" || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(jobId))held();
  const actual=readHostedOrdinaryBirth(jobId),kernel=new HostedReadonlyHostKernel(),session=kernel.operatorSession(),inventory=readHostedReadonlyHostInventory();
  if(session.bootId!==actual.activation.bootId || session.supervisorId!==actual.activation.supervisorId)held();
  const creator=inventory.ordinaryCreators.filter(value=>value.jobId===actual.birth.jobId && value.jobRootDir===actual.birth.jobRootDir && value.workspacePath===actual.birth.workspacePath);
  if(creator.length!==1)held();
  const selected=readHostedDependencyBinding(actual.birth.jobId);
  if(selected?.version===2) {
    assertHostedDependencyQualifiedInventory();
    if(selected.installationId!==actual.installation.installationId || selected.runtimeSha!==actual.installation.runtimeSha ||
      selected.workspace.canonicalPath!==actual.birth.workspacePath || selected.jobRootDir!==actual.birth.jobRootDir || creator[0]!.childSlotSha256!==undefined)held();
    assertHostedDependencyParentRecipe(creator[0]!.launch.args,selected.jobRootDir,selected.workspace.canonicalPath);
  }
  let root;try{root=lstatSync(hostedDependencyJobsRoot,{bigint:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  if(!root.isDirectory() || root.uid!==0n || root.gid!==0n || (root.mode&0o022n) || realpathSync(hostedDependencyJobsRoot)!==hostedDependencyJobsRoot)held();
  const jobs=readdirSync(hostedDependencyJobsRoot,{withFileTypes:true});if(jobs.length>128)held();
  for(const job of jobs) {
    if(!job.isDirectory() || job.isSymbolicLink() || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(job.name))held();
    const path=hostedDependencyJobsRoot+"/"+job.name+"/workspace",physical=lstatSync(path,{bigint:true}),binding=readHostedDependencyBinding(job.name);
    if(!physical.isDirectory() || physical.isSymbolicLink() || physical.uid!==0n || physical.gid!==0n || realpathSync(path)!==path ||
      binding && (physical.dev.toString()!==binding.workspace.dev || physical.ino.toString()!==binding.workspace.ino))held();
    const name=`dependency-owners/${physical.dev}-${physical.ino}`;
    if(readHostedActivationBytes(name+".lock"))held();
    const bytes=readHostedActivationBytes(name+".json");if(!bytes)continue;
    const owner=parseDependencyOwner(decodeHostedActivationBytes(bytes));
    if(owner.workspace.canonicalPath!==path || owner.workspace.dev!==physical.dev.toString() || owner.workspace.ino!==physical.ino.toString())held();
    // A retiring operator can retain rename anchors across an await. A new
    // privileged parent has no positive exclusion from that writer footprint.
    if(owner.owner?.kind===DependencyOwnerKind.Maintenance)held();
    if(owner.owner && isDependencyConsumerOwner(owner.owner)) {
      const pending=readHostedPrivateBytes(`/var/lib/subscription-runtime-host-policy/dependency-generation-barriers/pending/${owner.owner.attempt.attemptId}.json`,16384);
      if(pending) {
        const record=decodeHostedActivationBytes(pending);
        if(!isDependencyCustodyObject(record,"actors,attempt,bindingSha256,version") || record.version!==1 || !encode(record.attempt).equals(encode(owner.owner.attempt)))held();
        held(); // A live/pending source use cannot be replaced by a new creator.
      }
    }
    if(owner.version!==1 && owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1) {
      // Only this exact closed C producer may proceed to its actual idle-claim
      // verifier. Foreign/unclassified creators have no indirect-write proof.
      if(!selected || selected.version!==2 || !binding || binding.version!==2 || selected.jobId!==binding.jobId ||
        selected.workspace.dev!==owner.workspace.dev || selected.workspace.ino!==owner.workspace.ino || owner.owner!==null)held();
    }
    if(readHostedActivationBytes(name+".lock") || !readHostedActivationBytes(name+".json")?.equals(bytes))held();
  }
  const afterRoot=lstatSync(hostedDependencyJobsRoot,{bigint:true});
  if(afterRoot.dev!==root.dev || afterRoot.ino!==root.ino || afterRoot.mtimeNs!==root.mtimeNs || afterRoot.ctimeNs!==root.ctimeNs ||
    !encode(readHostedOrdinaryBirth(jobId)).equals(encode(actual)))held();
  assertHostedActivationFence(fence);
}
