import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { constants, closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { types } from "node:util";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyGenerationContinuityKind, DependencyOwnerKind, isDependencyConsumerOwner, isDependencyCustodyObject, parseDependencyOwner } from "@vioxen/subscription-runtime/core";
import { requiresCurrentHostedDependencyRootPurpose } from "./hosted-current-dependency-origin";
import { readHostedActivationBytes, decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { hostedDependencyJobsRoot, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";

function denied():never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }
const mountInfoLimit = 8 * 1024 * 1024;
function assertNoNestedMount(path:string):void {
  // Fixed actual mount table, bounded metadata only. A foreign cwd never makes
  // a nested bind mount of a governed root into an unmanaged writer scope.
  if(process.platform!=="linux")denied();
  const fd=openSync("/proc/self/mountinfo",constants.O_RDONLY|constants.O_NOFOLLOW),bytes=Buffer.alloc(mountInfoLimit+1);
  let length=0;
  try {while(length<bytes.length){const count=readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}}
  finally {closeSync(fd);}
  if(length>=bytes.length)denied();
  for(const line of new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,length)).trim().split("\n")) {
    const fields=line.split(" ");if(fields.length<10 || !fields.includes("-"))denied();
    const point=fields[4]!.replace(/\\([0-7]{3})/g,(_,code:string)=>String.fromCharCode(parseInt(code,8)));
    if(point===path || point.startsWith(path+sep))denied();
  }
}
function intersects(a:string,b:string):boolean { return a===b || a.startsWith(b+sep) || b.startsWith(a+sep); }
/** Denial only. No context, writer permit, callback or durable exclusion proof
 * is issued. Installed indirect-actor coverage remains a separate prerequisite.
 * Actual protected classification precedes ALL caller property evaluation. */
export function captureLegacyDependencyWriterInput<T extends {readonly workspacePath:string}>(input:T):T {
  if (requiresCurrentHostedDependencyRootPurpose()) denied();
  if (!input || typeof input!=="object" || types.isProxy(input)) denied();
  const prototype=Object.getPrototypeOf(input);
  if (prototype!==Object.prototype && prototype!==null) denied();
  const descriptors=Object.getOwnPropertyDescriptors(input), names=Reflect.ownKeys(descriptors);
  if (names.length>32 || names.some(name=>typeof name!=="string" || !("value" in descriptors[name]!))) denied();
  const snapshot=Object.create(null) as T;
  for (const name of names) Object.defineProperty(snapshot,name,{value:descriptors[name as string]!.value,enumerable:true});
  const workspace=Object.getOwnPropertyDescriptor(snapshot,"workspacePath");
  if (!workspace || typeof workspace.value!=="string") denied();
  assertLegacyDependencyWriterWorkspace(workspace.value);
  return Object.freeze(snapshot);
}
/** Bounded canonical metadata BEFORE project/Git/NM IO, repeated after awaits
 * before effects. Physical aliases cannot invent an unmanaged workspace. */
export function assertLegacyDependencyWriterWorkspace(path:string):string {
  if (requiresCurrentHostedDependencyRootPurpose()) denied();
  if (typeof path!=="string" || !path || path.length>4096 || path.includes("\0")) denied();
  const requested=resolve(path), canonical=realpathSync(requested), target=lstatSync(canonical,{bigint:true});
  if (!target.isDirectory()) denied();
  const ancestors=[];
  for(let parent=canonical;;parent=dirname(parent)) {
    if(ancestors.length>=128)denied();
    const stat=lstatSync(parent,{bigint:true});if(!stat.isDirectory())denied();ancestors.push({path:parent,stat});
    if(parent===dirname(parent))break;
  }
  let root;
  try {root=lstatSync(hostedDependencyJobsRoot,{bigint:true});}
  catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT")return canonical;throw error;}
  if (!root.isDirectory() || root.uid!==0n || (root.mode&0o022n) || realpathSync(hostedDependencyJobsRoot)!==hostedDependencyJobsRoot) denied();
  const jobs=readdirSync(hostedDependencyJobsRoot,{withFileTypes:true});
  if(jobs.length>128)denied();
  // An unmanaged evaluator has no positive indirect-write exclusion. A
  // nominal unrelated cwd cannot preserve any enrolled Active generation.
  for (const job of jobs) {
    if (!job.isDirectory() || job.isSymbolicLink() || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(job.name)) denied();
    const binding=readHostedDependencyBinding(job.name);
    const physical=lstatSync(`${hostedDependencyJobsRoot}/${job.name}/workspace`,{bigint:true});
    if (!physical.isDirectory() || physical.isSymbolicLink() || physical.uid!==0n) denied();
    if (binding && (String(physical.dev)!==binding.workspace.dev || String(physical.ino)!==binding.workspace.ino)) denied();
    const name=`dependency-owners/${physical.dev}-${physical.ino}`;
    if (readHostedActivationBytes(name+".lock")) denied();
    const bytes=readHostedActivationBytes(name+".json");
    if (bytes) { const owner=parseDependencyOwner(decodeHostedActivationBytes(bytes));
      if(owner.owner?.kind===DependencyOwnerKind.Maintenance)denied();
      if (owner.version!==1 && owner.generationContinuity?.kind===DependencyGenerationContinuityKind.BaselineAuthenticatedV1) denied();
      if(owner.owner && isDependencyConsumerOwner(owner.owner)) {
        const pending=readHostedPrivateBytes(`/var/lib/subscription-runtime-host-policy/dependency-generation-barriers/pending/${owner.owner.attempt.attemptId}.json`,16384);
        if(pending) { const record=decodeHostedActivationBytes(pending);
          if(!isDependencyCustodyObject(record,"actors,attempt,bindingSha256,version") || record.version!==1 ||
              JSON.stringify(record.attempt)!==JSON.stringify(owner.owner.attempt))denied();
          // Exact durable per-attempt denial remains while its real owner is
          // held, even before a final observation/Active slot exists.
          denied();
        }
      }
    }
    if (readHostedActivationBytes(name+".lock")) denied();
  }
  let mountedScopeChecked=false;
  for(const job of jobs) {
    if(!job.isDirectory() || job.isSymbolicLink() || !/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(job.name))denied();
    const jobPath=hostedDependencyJobsRoot+"/"+job.name, workspace=jobPath+"/workspace";
    const binding=readHostedDependencyBinding(job.name);
    // Explicit legacy V1 is unchanged; missing/unknown enrolled state is not
    // evidence of unmanaged authority, including lexical ancestors/aliases.
    if(binding?.version===1)continue;
    if(!mountedScopeChecked){assertNoNestedMount(canonical);mountedScopeChecked=true;}
    if(intersects(requested,workspace) || intersects(canonical,workspace))denied();
    const physical=lstatSync(workspace,{bigint:true});
    if(!physical.isDirectory() || realpathSync(workspace)!==workspace || physical.uid!==0n ||
      (binding && (physical.dev.toString()!==binding.workspace.dev || physical.ino.toString()!==binding.workspace.ino)))denied();
    if(ancestors.some(entry=>entry.stat.dev===physical.dev && entry.stat.ino===physical.ino))denied();
  }
  for(const entry of ancestors) {const now=lstatSync(entry.path,{bigint:true});
    if(now.dev!==entry.stat.dev || now.ino!==entry.stat.ino || now.mode!==entry.stat.mode)denied();}
  const after=lstatSync(canonical,{bigint:true}),afterRoot=lstatSync(hostedDependencyJobsRoot,{bigint:true});
  if(realpathSync(requested)!==canonical || after.dev!==target.dev || after.ino!==target.ino ||
    afterRoot.dev!==root.dev || afterRoot.ino!==root.ino || afterRoot.mtimeNs!==root.mtimeNs || afterRoot.ctimeNs!==root.ctimeNs)denied();
  if(requiresCurrentHostedDependencyRootPurpose())denied();
  return canonical;
}
