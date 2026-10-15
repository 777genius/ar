import { HostedDependencyRootDescriptorRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-root-descriptor-material";
import { isHostedDependencySignedTaskId, type HostedDependencyManagedGitScope } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
function denied(): never { throw new Error("hosted_dependency_root_descriptor_denied"); }
/** Pure selected-name policy. Returned path facts cannot open or associate a FD. */
function beneath(path: string, root: string) { return path === root || path.startsWith(root+"/"); }
function full(pattern: RegExp, value: string) { return pattern.exec(value)?.[0] === value; }
function excluded(path: string, scope: HostedDependencyManagedGitScope) {
  return path.split("/").some(segment => segment === "node_modules" || segment === ".git") ||
    scope.generatedRoots.some(root => beneath(path,root.canonicalPath));
}
function packetName(name: string, task: string): boolean {
  if (name.startsWith(task+".")) return full(/^[a-f0-9]{64}\.packet$/,name.slice(task.length+1));
  if (!name.startsWith("."+task+".")) return false;
  return full(new RegExp(`^[a-f0-9]{64}\\.packet\\.${process.pid}\\.[a-f0-9]{16}\\.tmp$`),name.slice(task.length+2));
}
function durableLeaf(relative: string, task: string): boolean {
  const parts = relative.split("/");
  if (parts.length === 1 && parts[0]!.startsWith(task+"."))
    return full(/^[a-f0-9]{64}\.handoff\.(?:patch|summary\.json|manifest\.json)$/,parts[0]!.slice(task.length+1));
  return parts.length === 2 && packetName(parts[0]!,task) &&
    new Set(["status.porcelain-v2.z","index.patch","worktree.patch","head-relative.patch","untracked.tar","untracked.paths.z","quarantine.json","manifest.json"]).has(parts[1]!);
}
export function selectHostedDependencyRootDescriptorPath(scope: HostedDependencyManagedGitScope, recipe: HostedDependencyRootDescriptorRecipe, path: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 16384 || path.includes("\0") ||
      path !== "/" && path.split("/").slice(1).some(segment => !segment || segment === "." || segment === "..") ||
      path.split("/").length > 512 || path === "/proc" || path.startsWith("/proc/")) denied();
  const workspace = scope.workspace.canonicalPath, durable = scope.durableHandoffRoot.canonicalPath, scratch = scope.scratchParent.canonicalPath;
  if (!isHostedDependencySignedTaskId(scope.logicalTaskId) || durable !== scope.jobRootDir+"/durable-handoffs") denied();
  if (recipe === HostedDependencyRootDescriptorRecipe.DirectoryV1) {
    const authored = scope.authoredRoots.some(pin => beneath(path,pin.canonicalPath)) && !excluded(path,scope);
    const scratchChild = path.startsWith(scratch+"/") && full(/^git-[A-Za-z0-9]{6}(?:\/objects)?$/,path.slice(scratch.length+1));
    const durableChild = path.startsWith(durable+"/") && packetName(path.slice(durable.length+1),scope.logicalTaskId);
    if (path !== scratch && path !== durable && !authored && !scratchChild && !durableChild || excluded(path,scope) || path === "/") denied();
    const pin = [...scope.authoredRoots,scope.durableHandoffRoot,scope.scratchParent].find(candidate => beneath(path,candidate.canonicalPath));
    return {directory:true,maximum:0,root:pin};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.AuthoredFileV1) {
    const root = scope.authoredRoots.find(pin => path.startsWith(pin.canonicalPath+"/"));
    if (!root || excluded(path,scope)) denied(); return {directory:false,maximum:64*1024*1024,root};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.GitIndexV1) {
    const relative = path.slice((workspace+"/.git/").length);
    if (!path.startsWith(workspace+"/.git/") || relative !== "index" && !full(/^sharedindex\.[a-f0-9]{40}(?:[a-f0-9]{24})?$/,relative)) denied();
    return {directory:false,maximum:32*1024*1024,root:scope.authoredRoots[0]};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.DurableFileV1) {
    if (!path.startsWith(durable+"/") || !durableLeaf(path.slice(durable.length+1),scope.logicalTaskId)) denied();
    return {directory:false,maximum:path.endsWith(".handoff.patch") ? 16*1024*1024 : 256*1024*1024,root:scope.durableHandoffRoot};
  }
  if (recipe === HostedDependencyRootDescriptorRecipe.TaskEventsV1) {
    if (path !== scope.jobRootDir+"/"+scope.logicalTaskId+".events.jsonl") denied();
    return {directory:false,maximum:16*1024*1024,root:scope.durableHandoffRoot};
  }
  denied();
}
