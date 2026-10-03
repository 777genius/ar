import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { defaultProjectControlGitPort, type ProjectControlGitPort } from
  "./application/project-control/adapters/host-command-adapters";
import { assertProjectControlScopeRepairAllowed, projectScopeFieldFingerprint } from
  "./codex-goal-mcp-project-scope";
import { pathInsideOrEqual } from "./codex-goal-mcp-project-utils";

/** Replace one exact URL with its existing local origin alias, never a new remote. */
export async function assertProjectControlCanonicalScopeRepair(input: {
  readonly existing: ProjectAccessScope;
  readonly proposed: ProjectAccessScope;
  readonly workspacePath: string;
}, git: ProjectControlGitPort = defaultProjectControlGitPort): Promise<void> {
  if (projectScopeFieldFingerprint(input.existing.allowedGitRemotes) ===
    projectScopeFieldFingerprint(input.proposed.allowedGitRemotes)) {
    assertProjectControlScopeRepairAllowed(input);
    return;
  }
  const denied = "project_control_scope_allowedGitRemotes_repair_denied";
  const existing = input.existing.allowedGitRemotes ?? [];
  const proposed = input.proposed.allowedGitRemotes ?? [];
  const url = existing[0];
  if (existing.length !== 1 || !url ||
    !/^(?:https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url) ||
    proposed.length !== 1 || proposed[0] !== "origin") throw new Error(denied);
  // Keep every other repair invariant, including account append-only semantics.
  assertProjectControlScopeRepairAllowed({
    existing: input.existing,
    proposed: { ...input.proposed, allowedGitRemotes: existing },
  });
  const workspace = resolve(input.workspacePath);
  // A broad/multiple workspace scope cannot prove one canonical remote mapping.
  if (input.existing.workspaceRoots?.length !== 1 ||
    resolve(input.existing.workspaceRoots[0]!) !== workspace ||
    (input.existing.deniedRoots ?? []).some(root =>
      pathInsideOrEqual(workspace, resolve(root)) || pathInsideOrEqual(resolve(root), workspace)) ||
    await realpath(workspace) !== workspace) throw new Error(denied);
  try {
    const topLevel = await git.run({
      args: ["-C", workspace, "rev-parse", "--show-toplevel"],
      timeoutMs: 8_000, maxBuffer: 64 * 1024,
    });
    if (topLevel.stdout.trim() !== workspace) throw new Error(denied);
    for (const args of [
      ["remote", "get-url", "--all", "origin"],
      ["remote", "get-url", "--push", "--all", "origin"],
    ]) {
      const result = await git.run({
        args: ["-C", workspace, ...args], timeoutMs: 8_000, maxBuffer: 64 * 1024,
      });
      if (result.stdout.trim() !== url) throw new Error(denied);
    }
  } catch {
    // Do not expose a Git error containing a credential-bearing URL.
    throw new Error(denied);
  }
}
