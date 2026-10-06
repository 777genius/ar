import { lstatSync } from "node:fs";
import type { HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { isHostedDependencySignedTaskId, type HostedDependencyRootPreparationRecord, type HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import type { parseHostedReadonlyHostInventory } from "../worker-core/hosted-custody/domain/hosted-readonly-inventory";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
const root = "/var/lib/subscription-runtime-host-policy";
const encode = (value:unknown) => Buffer.from(JSON.stringify(value)+"\n");
function assertDirectory(pin:HostedDependencyRootDirectoryPin):void {
  if (!pin || Object.keys(pin).sort().join(",") !== "canonicalPath,dev,ino,mountId" ||
      !encode(readHostedDependencyRootDirectoryPin(pin.canonicalPath)).equals(encode(pin))) invalid();
}
/** Facts only: no origin, registration, FD opener, callback or grant. */
export function selectHostedDependencyRootTaskFacts(inventory:ReturnType<typeof parseHostedReadonlyHostInventory>,
  binding:HostedDependencyBinding, executionJobId:string, durableEnvironment:string|undefined) {
  const creators = inventory.ordinaryCreators.filter(row => row.jobId === binding.jobId && row.jobRootDir === binding.jobRootDir && row.workspacePath === binding.workspace.canonicalPath);
  if (creators.length !== 1) invalid();
  return selectHostedDependencyRootTaskArgumentFacts(creators[0]!.launch.args,binding,executionJobId,durableEnvironment);
}
/** Pure closed argv projection. The actual C/R original-origin reader selects
 * its authenticated signed recipe; argv is never a launch/root permit. */
export function selectHostedDependencyRootTaskArgumentFacts(args:readonly string[],binding:HostedDependencyBinding,
  executionJobId:string,durableEnvironment:string|undefined) {
  const value = (flag: string, optional = false): string | undefined => {
    const positions = args.flatMap((arg,i) => arg === flag ? [i] : []);
    if (positions.length !== (optional && positions.length === 0 ? 0 : 1)) invalid();
    if (!positions.length) return undefined; const text = args[positions[0]!+1];
    if (!text || text.startsWith("--") || text.includes("\0")) invalid(); return text;
  };
  const logicalTaskId = value("--task-id");
  if (!isHostedDependencySignedTaskId(logicalTaskId) || value("--job-root") !== binding.jobRootDir || value("--workspace") !== binding.workspace.canonicalPath) invalid();
  const durable = value("--durable-handoff-root",true), fixedDurable = binding.jobRootDir+"/durable-handoffs";
  if ((durable !== undefined && durable !== fixedDurable) ||
      (durableEnvironment !== undefined && durableEnvironment !== fixedDurable)) invalid();
  return {logicalTaskId,durable:fixedDurable,executionJobId};
}
export function assertHostedDependencyRootDirectoryFacts(record:HostedDependencyRootPreparationRecord,
  binding:HostedDependencyBinding, durable:string, startId:string):void {
  if (record.durableHandoffRoot.canonicalPath !== durable || record.scratchParent.canonicalPath !== `${root}/dependency-root-scratch/${startId}` ||
      record.durableHandoffRoot.dev !== binding.workspace.dev || record.durableHandoffRoot.mountId !== record.authoredRoots[0]?.mountId) invalid();
  for (const privateParent of [record.durableHandoffRoot,record.scratchParent]) {
    assertDirectory(privateParent); const actual = lstatSync(privateParent.canonicalPath);
    if (actual.uid !== 0 || actual.gid !== 0 || (actual.mode & 0o7777) !== 0o700) invalid();
  }
  const scratchRoot = readHostedDependencyRootDirectoryPin(`${root}/dependency-root-scratch`), protectedRoot = readHostedDependencyRootDirectoryPin(root);
  const parentStat = lstatSync(scratchRoot.canonicalPath);
  if (parentStat.uid !== 0 || parentStat.gid !== 0 || (parentStat.mode & 0o7777) !== 0o700 ||
      scratchRoot.dev !== protectedRoot.dev || scratchRoot.mountId !== protectedRoot.mountId ||
      record.scratchParent.dev !== scratchRoot.dev || record.scratchParent.mountId !== scratchRoot.mountId) invalid();
  if (!Array.isArray(record.authoredRoots) || record.authoredRoots.length < 1 || record.authoredRoots.length > 129 ||
      !Array.isArray(record.generatedRoots) || record.generatedRoots.length !== 1 || !Array.isArray(record.sourceLookupAncestors) || record.sourceLookupAncestors.length > 16384 ||
      record.authoredRoots[0]?.canonicalPath !== binding.workspace.canonicalPath || record.authoredRoots[0]?.dev !== binding.workspace.dev ||
      record.authoredRoots[0]?.ino !== binding.workspace.ino || record.generatedRoots[0]?.canonicalPath !== binding.workspace.canonicalPath+"/node_modules") invalid();
  for (const pin of [...record.authoredRoots,...record.generatedRoots,...record.sourceLookupAncestors]) {
    if (pin.canonicalPath !== binding.workspace.canonicalPath && !pin.canonicalPath.startsWith(binding.workspace.canonicalPath+"/")) invalid();
    assertDirectory(pin);
  }

}
