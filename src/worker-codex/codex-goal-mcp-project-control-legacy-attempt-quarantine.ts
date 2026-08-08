import { resolve } from "node:path";
import type { ProjectAccessScope } from
  "@vioxen/subscription-runtime/worker-core";
import {
  applyLegacyAttemptQuarantine,
  loadLegacyAttemptQuarantinePlan,
  previewLegacyAttemptQuarantinePlan,
  type LegacyAttemptQuarantinePlan,
} from "./application/project-control/codex-goal-legacy-attempt-quarantine";
import { captureLegacyAttemptProcessEvidence } from
  "./application/project-control/codex-goal-legacy-attempt-process-evidence";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import {
  staleReconciliationControllerFingerprint,
  staleReconciliationControllerScopeEpoch,
  type CodexGoalMcpProjectControlAdminDeps,
  type LoadedProjectControlController,
} from "./codex-goal-mcp-project-control-admin";
import { controllerScopeLockIdentity } from
  "./codex-goal-mcp-project-control-ledger-epoch";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "./codex-goal-project-workspace-lock";
import { booleanValue, stringValue } from "./codex-goal-mcp-values";

type JsonObject = Readonly<Record<string, unknown>>;

export type LegacyAttemptQuarantineDeps = CodexGoalMcpProjectControlAdminDeps & {
  readonly captureProcessEvidence?: typeof captureLegacyAttemptProcessEvidence;
};

export async function projectControlLegacyAttemptQuarantineView(
  args: ProjectControlMcpArgs,
  deps: LegacyAttemptQuarantineDeps,
): Promise<JsonObject> {
  const loaded = await deps.loadProjectControlController(args);
  const capture = async (custodyPaths: readonly string[]) => await (
    deps.captureProcessEvidence ?? captureLegacyAttemptProcessEvidence
  )({ custodyPaths });
  if (booleanValue(args.confirmLegacyAttemptQuarantine) !== true) {
    const plan = await previewLegacyAttemptQuarantinePlan({
      ...quarantineScope(loaded),
      sourceStaleIntegrationPlanSha256: requiredSha(
        args.sourceStaleIntegrationPlanSha256,
        "sourceStaleIntegrationPlanSha256",
      ),
      cutoff: requiredString(args.legacyAttemptQuarantineCutoff, "legacyAttemptQuarantineCutoff"),
      captureProcessEvidence: capture,
    });
    return {
      ok: false,
      reason: "confirm_legacy_attempt_quarantine_required",
      mode: "project_control_legacy_attempt_quarantine",
      planSha256: plan.planSha256,
      attemptCount: plan.entries.length,
      entries: plan.entries.map((entry) => ({
        attemptId: entry.attemptId,
        status: entry.status,
        disposition: entry.disposition,
        refusalReason: entry.refusalReason,
        attemptSha256: entry.attemptSha256,
      })),
    };
  }
  const expected = stringValue(args.expectedLegacyAttemptQuarantinePlanSha256);
  if (!expected) throw new Error("legacy_attempt_quarantine_plan_sha_required");
  const plan = await loadLegacyAttemptQuarantinePlan({
    controllerJobRootDir: loaded.controller.jobRootDir,
    expectedPlanSha256: expected,
  });
  if (plan.sourceStaleIntegrationPlanSha256 !== requiredSha(
    args.sourceStaleIntegrationPlanSha256,
    "sourceStaleIntegrationPlanSha256",
  ) || plan.cutoff !== normalizedCutoff(args.legacyAttemptQuarantineCutoff)) {
    throw new Error("legacy_attempt_quarantine_confirmation_binding_mismatch");
  }
  assertLegacyAttemptQuarantinePlanOwned(plan, loaded);
  const locks = projectControlWorkspaceLocks(loaded.registryRootDir);
  const controllerLease = await locks.acquire({
    workspacePath: controllerScopeLockIdentity(
      loaded.registryRootDir,
      loaded.controller.jobId,
    ),
    owner: `legacy-attempt-quarantine-scope:${expected}`,
  });
  try {
    const presentWorkspaces = [...new Set(plan.entries.flatMap((entry) => [
      entry.sourceWorkspace,
      entry.targetWorkspace,
    ]).filter((binding) => binding.state === "present")
      .map((binding) => binding.declaredPath))].sort();
    return await applyLegacyAttemptQuarantine({
      controllerJobRootDir: loaded.controller.jobRootDir,
      expectedPlanSha256: expected,
      captureProcessEvidence: capture,
      runAfterControllerScopeRevalidation: async (persisted, effect) => {
        const locked = await deps.loadProjectControlController(args);
        assertLegacyAttemptQuarantinePlanOwned(persisted, locked);
        return await withWorkspaceLocks({
          locks,
          scope: locked.scope,
          workspacePaths: presentWorkspaces,
          owner: `legacy-attempt-quarantine:${expected}`,
          effect,
        });
      },
    });
  } finally {
    await locks.release(controllerLease);
  }
}

export function assertLegacyAttemptQuarantinePlanOwned(
  plan: LegacyAttemptQuarantinePlan,
  loaded: LoadedProjectControlController,
): void {
  const scope = quarantineScope(loaded);
  if (plan.controllerJobId !== scope.controllerJobId ||
    plan.projectId !== scope.projectId ||
    plan.registryRootDir !== scope.registryRootDir ||
    plan.controllerJobRootDir !== scope.controllerJobRootDir ||
    plan.controllerManifestSha256 !== scope.controllerManifestSha256 ||
    plan.controllerScopeEpochSha256 !== scope.controllerScopeEpochSha256 ||
    JSON.stringify(plan.targetWorkspaceRoots) !==
      JSON.stringify(scope.targetWorkspaceRoots) ||
    JSON.stringify(plan.deniedRoots) !== JSON.stringify(scope.deniedRoots) ||
    JSON.stringify(plan.allowedGitRemotes) !==
      JSON.stringify(scope.allowedGitRemotes) ||
    JSON.stringify(plan.allowedBranches) !== JSON.stringify(scope.allowedBranches)) {
    throw new Error("legacy_attempt_quarantine_controller_scope_drift");
  }
}

function quarantineScope(loaded: LoadedProjectControlController) {
  return {
    controllerJobId: loaded.controller.jobId,
    projectId: loaded.scope.projectId,
    registryRootDir: resolve(loaded.registryRootDir),
    controllerJobRootDir: resolve(loaded.controller.jobRootDir),
    controllerManifestSha256:
      staleReconciliationControllerFingerprint(loaded.controller),
    controllerScopeEpochSha256: staleReconciliationControllerScopeEpoch(loaded),
    targetWorkspaceRoots: exactPaths([
      ...(loaded.scope.workspaceRoots ?? []),
      ...(loaded.scope.worktreeRoots ?? []),
    ]),
    deniedRoots: exactPaths(loaded.scope.deniedRoots ?? []),
    allowedGitRemotes: exactStrings(loaded.scope.allowedGitRemotes ?? []),
    allowedBranches: exactStrings(loaded.scope.allowedBranches ?? []),
  };
}

async function withWorkspaceLocks<T>(input: {
  readonly locks: ReturnType<typeof projectControlWorkspaceLocks>;
  readonly scope: ProjectAccessScope;
  readonly workspacePaths: readonly string[];
  readonly owner: string;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  const next = async (index: number): Promise<T> => {
    const workspacePath = input.workspacePaths[index];
    if (!workspacePath) return await input.effect();
    return await withValidatedProjectWorkspaceLock({
      locks: input.locks,
      scope: input.scope,
      requestedWorkspacePath: workspacePath,
      owner: input.owner,
      effect: async () => await next(index + 1),
    });
  };
  return await next(0);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function requiredSha(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function normalizedCutoff(value: unknown): string {
  const cutoff = requiredString(value, "legacyAttemptQuarantineCutoff");
  if (!Number.isFinite(Date.parse(cutoff))) {
    throw new Error("legacyAttemptQuarantineCutoff is invalid");
  }
  return new Date(Date.parse(cutoff)).toISOString();
}

function exactPaths(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function exactStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
