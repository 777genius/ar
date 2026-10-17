import { resolve } from "node:path";
import {
  AccessBoundary,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  listCodexGoalJobs,
  readCodexGoalJob,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

export type ProjectControlGenericDenial = Readonly<{
  ok: false;
  reason: "project_control_broker_required";
  jobId?: string;
  controllerJobId?: string;
  projectId?: string;
  requiredTool: string;
  safeMessage: string;
}>;

export function projectControlGenericToolDenial(input: {
  readonly accessBoundary?: AccessBoundary | undefined;
  readonly projectAccessScope?: CodexGoalRunConfig["projectAccessScope"] | undefined;
  readonly jobId?: string | undefined;
  readonly requiredTool?: string | undefined;
}): ProjectControlGenericDenial | undefined {
  if (
    input.accessBoundary !== AccessBoundary.ProjectScopedControl &&
    input.projectAccessScope === undefined
  ) {
    return undefined;
  }
  const requiredTool = input.requiredTool ??
    (input.accessBoundary === AccessBoundary.ProjectScopedControl
      ? "codex_goal_project_controller_start"
      : "codex_goal_project_start");
  return {
    ok: false,
    reason: "project_control_broker_required",
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    requiredTool,
    safeMessage:
      "Project-owned jobs must be started through brokered project-control tools so admission debt, audit and controller adoption are enforced.",
  };
}

export async function projectControlGenericScopeDenial(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly workspacePath?: string | undefined;
  readonly accessBoundary?: AccessBoundary | undefined;
  readonly projectAccessScope?: CodexGoalRunConfig["projectAccessScope"] | undefined;
  readonly requiredTool: string;
  readonly allowProjectScopedControlBootstrap?: boolean;
  readonly skipDirectProjectManifestDenial?: boolean;
}): Promise<ProjectControlGenericDenial | undefined> {
  if (
    !input.skipDirectProjectManifestDenial &&
    (
      !input.allowProjectScopedControlBootstrap ||
      input.accessBoundary !== AccessBoundary.ProjectScopedControl
    )
  ) {
    const directDenial = projectControlGenericToolDenial(input);
    if (directDenial) return directDenial;
  }
  const controller = await matchingProjectControlController(input);
  if (!controller) return undefined;
  return {
    ok: false,
    reason: "project_control_broker_required",
    jobId: input.jobId,
    controllerJobId: controller.jobId,
    projectId: controller.projectId,
    requiredTool: input.requiredTool,
    safeMessage:
      "This job matches an existing ProjectScopedControl controller scope. Use brokered project-control tools so admission debt, audit and controller adoption are enforced.",
  };
}

async function matchingProjectControlController(input: {
  readonly registryRootDir: string;
  readonly jobId: string;
  readonly workspacePath?: string | undefined;
}): Promise<
  | {
      readonly jobId: string;
      readonly projectId: string;
    }
  | undefined
> {
  let summaries;
  try {
    summaries = await listCodexGoalJobs({ registryRootDir: input.registryRootDir });
  } catch {
    return undefined;
  }
  for (const summary of summaries) {
    let manifest: CodexGoalJobManifest;
    try {
      // A retired controller's scope still denies generic tools on its paths.
      manifest = await readCodexGoalJob({
        registryRootDir: input.registryRootDir,
        jobId: summary.jobId,
        includeRetired: true,
      });
    } catch {
      continue;
    }
    if (
      manifest.accessBoundary !== AccessBoundary.ProjectScopedControl ||
      !manifest.projectAccessScope
    ) {
      continue;
    }
    const scope = manifest.projectAccessScope;
    const registryMatches = scope.registryRoot === undefined ||
      resolve(scope.registryRoot) === resolve(input.registryRootDir);
    if (!registryMatches) continue;
    const prefixes = scope.jobIdPrefixes ?? [];
    const jobMatches = prefixes.length > 0 &&
      matchesProjectControlPrefix(input.jobId, prefixes);
    const workspaceMatches = input.workspacePath
      ? pathInsideAnyProjectRoot(
          input.workspacePath,
          projectControlWorkspaceRoots(scope),
        )
      : false;
    if (jobMatches || workspaceMatches) {
      return {
        jobId: manifest.jobId,
        projectId: scope.projectId,
      };
    }
  }
  return undefined;
}

function projectControlWorkspaceRoots(scope: ProjectAccessScope): readonly string[] {
  return uniqueStrings([
    ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []),
    ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
  ]);
}

function pathInsideAnyProjectRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathInsideOrEqual(path, root));
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`);
}

function matchesProjectControlPrefix(
  value: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.length === 0 ||
    prefixes.some((prefix) => value.startsWith(prefix));
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== "")));
}
