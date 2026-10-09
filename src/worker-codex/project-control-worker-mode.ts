import { dirname, join } from "node:path";
import { AccessBoundary, WorkerMode, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { CodexModelBackend, requiresHostedProcessAdmission } from "@vioxen/subscription-runtime/provider-codex";
import { isHostedContainment } from "../provider-codex/app-server/adapters/hosted-host-policy";
import type { DependencyToolGuestConfig } from "../core/dependency-environment/dependency-tool-profile";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { CodexGoalJobManifestInput } from "./codex-goal-jobs";
import { codexGoalHostedExecutionBoundary } from "./codex-goal-access-plan";
import { inspectWorkerToolRoot, workerToolRootPath, WorkerToolRootBinding } from "./worker-tool-root";

/** Open-mode tool cache and temp keys, as paths relative to the tool root. The factory sets each of them, so
 * every key is also admitted through include_only and cannot arrive from the host environment. */
export const openWorkerToolCacheEnvironment = {
  XDG_CACHE_HOME: "home/.cache",
  npm_config_cache: "home/.npm",
  COREPACK_HOME: "home/.cache/node/corepack",
  YARN_CACHE_FOLDER: "home/.cache/yarn",
  PIP_CACHE_DIR: "home/.cache/pip",
  UV_CACHE_DIR: "home/.cache/uv",
  GOCACHE: "home/.cache/go-build",
  GOMODCACHE: "home/go/pkg/mod",
  GOTMPDIR: "tmp",
} as const satisfies Readonly<Record<string, string>>;
export function openWorkerToolCacheEnvironmentSet(toolRoot: string): Record<string, string> {
  return Object.fromEntries(Object.entries(openWorkerToolCacheEnvironment).map(([key, relative]) => [key, join(toolRoot, relative)]));
}

/** Mode for new refill children when the controller scope has no workerMode.
 * Staged: Strict until a green canary, then Open (owner decision P1-3). */
export const defaultWorkerModeWhenScopeUnset: WorkerMode = WorkerMode.Strict;
export function resolveNewChildWorkerMode(scope: ProjectAccessScope, defaultMode = defaultWorkerModeWhenScopeUnset): WorkerMode {
  return scope.workerMode ?? defaultMode;
}
export function projectControlNewChildWorkerMode(scope: ProjectAccessScope, defaultMode?: WorkerMode): { workerMode?: WorkerMode } {
  return resolveNewChildWorkerMode(scope, defaultMode) === WorkerMode.Open ? { workerMode: WorkerMode.Open } : {};
}
export function projectControlWorkerModeRepairAllowed(existing: WorkerMode | undefined, proposed: WorkerMode | undefined): boolean {
  return existing === proposed || proposed === WorkerMode.Strict;
}
export function optionalWorkerMode(value: unknown, fieldName = "workerMode"): WorkerMode | undefined {
  if (value === undefined || value === WorkerMode.Open || value === WorkerMode.Strict) return value;
  throw new Error(`${fieldName}_invalid`);
}
export enum OpenWorkerFallbackReason {
  NotLinux = "not_linux", NotRootBaseline = "not_root_baseline", Contained = "contained",
  ModelBackend = "model_backend", ExecutionEngine = "execution_engine", BoundedWorkspaceTools = "bounded_workspace_tools",
  DependencyTools = "dependency_tools", NoProjectReadBoundary = "no_project_read_boundary",
  ToolRootAbsent = "tool_root_absent", ToolRootForeign = "tool_root_foreign",
}
export type OpenWorkerProfileInput = {
  platform: NodeJS.Platform; rootBaseline: boolean; contained: boolean; modelBackend: CodexModelBackend;
  executionEngine: CodexGoalRunConfig["executionEngine"]; boundedWorkspaceTools: boolean;
  dependencyTools: boolean; projectReadBoundary: boolean;
};
export function openWorkerProfileApplies(input: OpenWorkerProfileInput): { applies: true } | { applies: false; reason: OpenWorkerFallbackReason } {
  const checks: readonly [boolean, OpenWorkerFallbackReason][] = [
    [input.platform === "linux", OpenWorkerFallbackReason.NotLinux], [input.rootBaseline, OpenWorkerFallbackReason.NotRootBaseline],
    [!input.contained, OpenWorkerFallbackReason.Contained], [input.modelBackend === CodexModelBackend.OpenAiChatGpt, OpenWorkerFallbackReason.ModelBackend],
    [input.executionEngine === "app-server" || input.executionEngine === "app-server-goal", OpenWorkerFallbackReason.ExecutionEngine],
    [!input.boundedWorkspaceTools, OpenWorkerFallbackReason.BoundedWorkspaceTools], [!input.dependencyTools, OpenWorkerFallbackReason.DependencyTools],
    [input.projectReadBoundary, OpenWorkerFallbackReason.NoProjectReadBoundary],
  ];
  const failed = checks.find(([passes]) => !passes);
  return failed ? { applies: false, reason: failed[1] } : { applies: true };
}
export type OpenWorkerLaunch = {
  toolRoot: string; commitAllowed: boolean; secretRoots: readonly string[]; deniedRoots: readonly string[];
};
export type OpenWorkerDecision = { requested: WorkerMode; effective: WorkerMode; reason?: OpenWorkerFallbackReason; launch?: OpenWorkerLaunch };
export async function resolveOpenWorkerLaunch(input: {
  config: CodexGoalRunConfig; dependencyToolConfig?: DependencyToolGuestConfig | undefined;
}): Promise<OpenWorkerDecision> {
  const { config } = input, requested = optionalWorkerMode(config.workerMode) ?? WorkerMode.Strict;
  if (requested === WorkerMode.Strict) return { requested, effective: WorkerMode.Strict };
  const sourceEnv = config.sourceEnv ?? process.env;
  const profile = openWorkerProfileApplies({ platform: process.platform,
    rootBaseline: process.getuid?.() === 0 && !requiresHostedProcessAdmission(sourceEnv), contained: isHostedContainment(sourceEnv),
    modelBackend: config.modelBackend ?? CodexModelBackend.OpenAiChatGpt, executionEngine: config.executionEngine ?? "app-server-goal",
    boundedWorkspaceTools: false, dependencyTools: !!input.dependencyToolConfig,
    projectReadBoundary: codexGoalHostedExecutionBoundary(config).enforceProjectReadBoundary });
  if (!profile.applies) return { requested, effective: WorkerMode.Strict, reason: profile.reason };
  const binding = await inspectWorkerToolRoot({ workspacePath: config.workspacePath, jobId: config.jobId ?? config.taskId });
  if (binding !== WorkerToolRootBinding.Owned) return { requested, effective: WorkerMode.Strict,
    reason: binding === WorkerToolRootBinding.Absent ? OpenWorkerFallbackReason.ToolRootAbsent : OpenWorkerFallbackReason.ToolRootForeign };
  const scope = config.projectAccessScope!;
  const privateRoots = [config.authRootDir, scope.authRoot, scope.registryRoot].filter((root): root is string => root !== undefined);
  return { requested, effective: WorkerMode.Open, launch: { toolRoot: workerToolRootPath(config.workspacePath),
    commitAllowed: config.accessBoundary === AccessBoundary.IsolatedWorkspaceWrite,
    secretRoots: [...privateRoots.flatMap(root => [root, dirname(root)]), config.jobRootDir], deniedRoots: scope.deniedRoots ?? [] } };
}
export function openWorkerEvidence(decision: OpenWorkerDecision) {
  return { workerModeRequested: decision.requested, workerModeEffective: decision.effective,
    ...(decision.requested === WorkerMode.Open && decision.effective === WorkerMode.Strict && decision.reason ? { workerModeReason: decision.reason } : {}) };
}
export function projectControlWorkerToolRootRequest(manifest: CodexGoalJobManifestInput, scope: ProjectAccessScope) {
  return manifest.workerMode === WorkerMode.Open ? { workerToolRoot: { jobId: manifest.jobId,
    commitAllowed: manifest.accessBoundary === AccessBoundary.IsolatedWorkspaceWrite,
    ...(scope.commitIdentity ? { commitIdentity: scope.commitIdentity } : {}) } } : {};
}
export function codexGoalOpenWorkerSystemPrompt(commitAllowed: boolean): string {
  return commitAllowed
    ? "Open worker mode: your workspace is a linked git worktree, and your own git repository is at $GIT_DIR (already " +
      "set, branch `work`). Commit there as often as you like. Push is not available. Keep your commits on top of the " +
      "commit that `work` started from: do not rebase, reset, merge, or check out other commits or branches, and never " +
      "move onto a newer origin. The handoff is the final workspace tree compared with that base commit, so committed " +
      "and uncommitted changes are both included. Use $TMPDIR for temporary files and fallback artifacts; /tmp is not " +
      "available. To run git in another repository, prefix the command with `env -u GIT_DIR -u GIT_WORK_TREE`."
    : "Open worker mode: the workspace is read-only. Use $TMPDIR for temporary files and fallback artifacts; /tmp is not available.";
}
