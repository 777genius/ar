import { constants, openSync, closeSync, lstatSync, fstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { readOriginalHostedDependencyDescriptorOpening, readCurrentHostedManagedDependencyProvider,
  type CurrentHostedDependencyOrigin } from "./hosted-current-dependency-origin";
import { type HostedDependencyManagedGitScope, type HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { HostedDependencyRootDescriptorRecipe, type HostedDependencyRootDescriptorAnchor, type HostedDependencyRootDescriptorMaterial } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
import { sameRootDescriptorDirectory as sameDirectory, sameRootDescriptorFile as sameFile, rootDescriptorPhysicalInfo as info,
  readHostedDependencyRootDirectoryPin, assertHostedDependencyRootDescriptorMaterial } from "./hosted-dependency-root-physical-facts";
import { selectHostedDependencyRootDescriptorPath } from "./hosted-dependency-root-descriptor-selection";
import { dependencyToolGuestConfigPath } from "../core/dependency-environment/dependency-tool-profile";
/** No exported raw-scope opener. Current original purpose is selected before IO;
 * sole-map association and post-census remain at the original caller. */
export function openOriginalHostedDependencyRootDescriptorMaterial(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  recipe:HostedDependencyRootDescriptorRecipe,path:string,access:symbol):HostedDependencyRootDescriptorMaterial {
  const {scope}=readOriginalHostedDependencyDescriptorOpening(context,fence,access);
  return openHostedDependencyRootDescriptorMaterial(scope,recipe,path);
}
/** Fixed selected provider roster only. No caller root/maximum/FD is accepted. */
export function openOriginalHostedManagedProviderDescriptorMaterial(context:CurrentHostedDependencyOrigin,fence:HostedActivationFence,
  unit:string,path:string,access:symbol):HostedDependencyRootDescriptorMaterial {
  const selected=readOriginalHostedDependencyDescriptorOpening(context,fence,access);
  const provider=readCurrentHostedManagedDependencyProvider(context,fence,unit);
  const providerRoot=`/var/lib/subscription-runtime-host-policy/dependency-provider-roots/${provider.value.providerStartId}`;
  const capsule=providerRoot+dependencyToolGuestConfigPath;
  if(path!==selected.record.qualification.path && path!==capsule)denied();
  const root=readHostedDependencyRootDirectoryPin(path===capsule?providerRoot:dirname(selected.record.qualification.path));
  return openHostedDependencyRootDescriptorMaterial(selected.scope,HostedDependencyRootDescriptorRecipe.DurableFileV1,path,
    {directory:false,maximum:16384,root});
}
function denied(): never { throw new Error("hosted_dependency_root_descriptor_denied"); }
function openHostedDependencyRootDescriptorMaterial(scope: HostedDependencyManagedGitScope, recipe: HostedDependencyRootDescriptorRecipe, path: string,
  fixedSelection?: Readonly<{directory:false;maximum:number;root:HostedDependencyRootDirectoryPin}>): HostedDependencyRootDescriptorMaterial {
  const selection = fixedSelection ?? selectHostedDependencyRootDescriptorPath(scope,recipe,path), descriptors: number[] = [], ancestors: HostedDependencyRootDescriptorAnchor[] = [], dependencies: HostedDependencyRootDescriptorAnchor[] = [];
  let retained = false;
  try {
    let parent = openSync("/",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); descriptors.push(parent);
    let physical = "/", actual = fstatSync(parent,{bigint:true});
    if (!sameDirectory(actual,lstatSync("/",{bigint:true})) || actual.uid !== 0n || actual.gid !== 0n || (actual.mode & 0o022n)) denied();
    const segments = path === "/" ? [] : path.slice(1).split("/");
    for (let index = 0; index < segments.length; index++) {
      ancestors.push(Object.freeze({fd:parent,path:physical,stat:actual,...info(parent)}));
      const last = index === segments.length-1, directory = !last || selection.directory;
      const named = `/proc/self/fd/${parent}/${segments[index]!}`, before = lstatSync(named,{bigint:true});
      const fd = openSync(named,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(directory ? constants.O_DIRECTORY:0));
      descriptors.push(fd); physical = physical === "/" ? "/"+segments[index]! : physical+"/"+segments[index]!;
      actual = fstatSync(fd,{bigint:true});
      if (!(directory ? sameDirectory(actual,before):sameFile(actual,before)) || actual.uid !== 0n || actual.gid !== 0n ||
          (actual.mode & 0o022n) || realpathSync(`/proc/self/fd/${fd}`) !== physical ||
          !(directory ? sameDirectory(actual,lstatSync(named,{bigint:true})):sameFile(actual,lstatSync(named,{bigint:true})))) denied();
      parent = fd;
    }
    const fd = parent, openedInfo = info(fd);
    if (!selection.directory && (!actual.isFile() || actual.nlink !== 1n || actual.size < 0n || actual.size > BigInt(selection.maximum))) denied();
    if (selection.root) {
      const rootPath = recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1 ? scope.jobRootDir : selection.root.canonicalPath;
      const anchor = path === rootPath ? {stat:actual,mountId:openedInfo.mountId} : ancestors.find(pin => pin.path === rootPath);
      if (!anchor || anchor.stat.dev.toString() !== selection.root.dev ||
        anchor.mountId !== selection.root.mountId || actual.dev.toString() !== selection.root.dev || openedInfo.mountId !== selection.root.mountId) denied();
      if (recipe !== HostedDependencyRootDescriptorRecipe.TaskEventsV1 && anchor.stat.ino.toString() !== selection.root.ino) denied();
      if (selection.directory && ((path === scope.scratchParent.canonicalPath || path.startsWith(scope.scratchParent.canonicalPath+"/")) || (path === scope.durableHandoffRoot.canonicalPath || path.startsWith(scope.durableHandoffRoot.canonicalPath+"/"))) &&
          (actual.mode & 0o7777n) !== 0o700n) denied();
      if (recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1) {
        const child = openSync(`/proc/self/fd/${descriptors[ancestors.findIndex(pin => pin.path === rootPath)]!}/durable-handoffs`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        descriptors.push(child); const durable = fstatSync(child,{bigint:true}), childInfo = info(child);
        if (durable.dev.toString() !== selection.root.dev || durable.ino.toString() !== selection.root.ino || childInfo.mountId !== selection.root.mountId ||
            durable.uid !== 0n || durable.gid !== 0n || (durable.mode & 0o7777n) !== 0o700n ||
            !sameDirectory(durable,lstatSync(selection.root.canonicalPath,{bigint:true})) || realpathSync(`/proc/self/fd/${child}`) !== selection.root.canonicalPath) denied();
        dependencies.push(Object.freeze({fd:child,path:selection.root.canonicalPath,stat:durable,...childInfo}));
      }
    }
    const result = {fd,path,directory:selection.directory,stat:actual,...openedInfo,ancestors:Object.freeze(ancestors),dependencies:Object.freeze(dependencies),closed:false};
    assertHostedDependencyRootDescriptorMaterial(result); retained = true; return result;
  } finally { if (!retained) for (const fd of descriptors.reverse()) closeSync(fd); }
}
