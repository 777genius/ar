import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { sameDependencyProtectedReference, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { assertHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { hostedDependencyRemovalOperations } from "./hosted-dependency-removal-ownership";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
function held():never{throw new Error("hosted_dependency_removal_lock_release_held");}
function negative(path:string):void{try{lstatSync(path);held();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
function release(fence:HostedActivationFence,reference:DependencyProtectedReference,access:symbol,unlink:boolean):void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const name=reference.path.slice(hostedDependencyRemovalOperations.length+1);
  if(reference.path!==`${hostedDependencyRemovalOperations}/${name}` || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.remove\.lock$/.exec(name)?.[0]!==name)held();
  const parent=openSync(hostedDependencyRemovalOperations,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(parent,{bigint:true}),named=lstatSync(hostedDependencyRemovalOperations,{bigint:true}),mount=readFileSync(`/proc/self/fdinfo/${parent}`,"utf8"),anchored=`/proc/self/fd/${parent}/${name}`;
    if(!before.isDirectory() || before.uid!==0n || (before.mode&0o7777n)!==0o700n || before.dev!==named.dev || before.ino!==named.ino)held();
    if(unlink) {
      const file=lstatSync(anchored,{bigint:true});
      if(!file.isFile() || file.uid!==0n || file.nlink!==1n || (file.mode&0o7777n)!==0o600n || String(file.dev)!==reference.identity.dev || String(file.ino)!==reference.identity.ino ||
        !sameDependencyProtectedReference(pinReferenceFile(reference.path,65536).reference,reference))held();
      unlinkSync(anchored);
    }else negative(anchored);
    fsyncSync(parent);negative(anchored);
    const after=lstatSync(hostedDependencyRemovalOperations,{bigint:true}),retained=fstatSync(parent,{bigint:true});
    if(after.dev!==before.dev || after.ino!==before.ino || after.mode!==before.mode || retained.dev!==before.dev || retained.ino!==before.ino ||
      readFileSync(`/proc/self/fdinfo/${parent}`,"utf8")!==mount)held();negative(anchored);assertHostedActivationFence(fence);
  }finally{closeSync(parent);}
}
/** Private fixed caller must separately authenticate exact retirement/completion
 * and owner stages. No absent-name observation alone supplies release authority. */
export function unlinkOriginalHostedDependencyRemovalLock(fence:HostedActivationFence,reference:DependencyProtectedReference,access:symbol):void {release(fence,reference,access,true);}
/** No delete capability: authentic release retry can fsync/reobserve a name
 * already removed before a crash or uncertain prior fsync/publication. */
export function confirmOriginalHostedDependencyRemovalLockReleased(fence:HostedActivationFence,reference:DependencyProtectedReference,access:symbol):void {release(fence,reference,access,false);}
