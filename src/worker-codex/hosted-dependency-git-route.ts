import { DependencyOwnerPhase } from "@vioxen/subscription-runtime/core";
import { withHostedActivationFence, readHostedOrdinaryProcessOrigin, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { isHostedDependencyWorkspace, readHostedDependencyBinding } from "./hosted-dependency-workspace";
import { isHostedOrdinaryRuntime } from "./hosted-ordinary-writer-authority";
import { CurrentHostedDependencyOriginKind, requiresCurrentHostedDependencyRootPurpose,
  readCurrentHostedDependencyOrigin, assertCurrentHostedDependencyAttempt } from "./hosted-current-dependency-origin";

export enum HostedDependencyGitRoute { Unmanaged = "unmanaged", Purpose = "purpose", LegacyOrdinaryV1 = "legacy_ordinary_v1" }
function unsupported(): never { throw new Error("dependency_host_git_unsupported"); }

/** Fresh routing facts only. No purpose, descriptor exemption or retained grant
 * is issued. Every fixed legacy read rechecks the actual Running attempt. */
export function readHostedDependencyGitRoute(workspacePath?: string, heldFence?: HostedActivationFence) {
  if (requiresCurrentHostedDependencyRootPurpose(heldFence)) return { kind: HostedDependencyGitRoute.Purpose } as const;
  if (!isHostedOrdinaryRuntime()) {
    if (workspacePath !== undefined && isHostedDependencyWorkspace(workspacePath)) unsupported();
    return { kind: HostedDependencyGitRoute.Unmanaged } as const;
  }
  const read = (fence: HostedActivationFence) => {
    if (requiresCurrentHostedDependencyRootPurpose(fence)) return { kind: HostedDependencyGitRoute.Purpose } as const;
    const ordinary = readHostedOrdinaryProcessOrigin(fence), binding = readHostedDependencyBinding(String(ordinary.start.jobId));
    if (!binding) {
      if (isHostedDependencyWorkspace(String(ordinary.start.workspacePath)) ||
          workspacePath !== undefined && isHostedDependencyWorkspace(workspacePath)) unsupported();
      return { kind: HostedDependencyGitRoute.Unmanaged } as const;
    }
    const context = readCurrentHostedDependencyOrigin(fence);
    const actual = assertCurrentHostedDependencyAttempt(context, fence, DependencyOwnerPhase.Running);
    if (actual.facts.kind !== CurrentHostedDependencyOriginKind.Ordinary || actual.binding.version !== 1 ||
        workspacePath !== undefined && workspacePath !== actual.binding.workspace.canonicalPath) unsupported();
    return { kind: HostedDependencyGitRoute.LegacyOrdinaryV1, context, binding: actual.binding, attempt: actual.attempt } as const;
  };
  return heldFence === undefined ? withHostedActivationFence(read) : read(heldFence);
}
