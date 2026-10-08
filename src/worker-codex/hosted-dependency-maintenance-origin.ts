import { assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import type { DependencyMaintenanceAttempt } from "@vioxen/subscription-runtime/core";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { selectOriginalHostedDependencyMaintenanceRename, runOriginalHostedDependencyMaintenanceRename,
  assertOriginalHostedDependencyMaintenanceRenameDescriptors, type OriginalHostedDependencyMaintenanceRenameState } from "./hosted-dependency-maintenance-rename";

// Focused defining operator association. Every creator/reader requires the SAME
// lexical original access symbol; there is no registration, state argument or
// callback. Consumer-origin maps cannot contain this separate operator brand.
const brand: unique symbol = Symbol("hosted.original.dependency.maintenance");
export type OriginalHostedDependencyMaintenanceOrigin = Readonly<{ [brand]: true }>;
const contexts = new WeakMap<OriginalHostedDependencyMaintenanceOrigin, OriginalHostedDependencyMaintenanceRenameState>();
let current: OriginalHostedDependencyMaintenanceOrigin | undefined;
function held(): never { throw new Error("hosted_dependency_maintenance_origin_unresolved"); }
export async function renameOriginalHostedDependencyMaintenanceTree(jobId: string, attempt: DependencyMaintenanceAttempt, access: symbol) {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);
  const context = withHostedActivationFence(fence => {
    if (current) held(); const state = selectOriginalHostedDependencyMaintenanceRename(fence, jobId, attempt, access); if (!state) return undefined;
    const context = Object.freeze({ [brand]: true as const }); contexts.set(context, state); current = context; return context;
  });
  if (!context) return undefined;
  try { return await runOriginalHostedDependencyMaintenanceRename(context, access); }
  finally { contexts.delete(context); if (current === context) current = undefined; }
}
export function readOriginalHostedDependencyMaintenanceRenameState(context: OriginalHostedDependencyMaintenanceOrigin, access: symbol): OriginalHostedDependencyMaintenanceRenameState {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); const state = contexts.get(context);
  if (context !== current || !state) held(); return state;
}
export function assertOriginalHostedDependencyMaintenanceDescriptors(fence: HostedActivationFence, access: symbol): void {
  assertOriginalHostedDependencyPhysicalRecordAccess(access); assertHostedActivationFence(fence);
  if (current) assertOriginalHostedDependencyMaintenanceRenameDescriptors(current, fence, access); else assertHostedProcessDescriptors();
}
