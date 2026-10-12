import { parseDependencyOwner, sameDependencyWorkspace } from "@vioxen/subscription-runtime/core";
import { decodeHostedActivationBytes, readHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { readOriginalHostedDependencyPinnedRecord } from "./hosted-dependency-original-record-reader";
import type { HostedDependencyBinding } from "./hosted-dependency-workspace";

function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }

/** Fixed owner fact only. Original private access precedes binding/path reads,
 * and the owner lock brackets the same independently pinned record read. */
export function readOriginalHostedDependencyRootOwner(binding: HostedDependencyBinding, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  const name = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(name + ".lock")) invalid();
  const bytes = readOriginalHostedDependencyPinnedRecord(
    access, `/var/lib/subscription-runtime-host-policy/${name}.json`, 16384,
  ).bytes;
  const owner = parseDependencyOwner(decodeHostedActivationBytes(bytes));
  if (readHostedActivationBytes(name + ".lock") || !sameDependencyWorkspace(owner.workspace, binding.workspace)) invalid();
  return owner;
}
