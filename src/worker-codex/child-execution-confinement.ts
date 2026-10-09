import { CodexModelBackend, codexMimoDefaultModel, codexMimoApiKeyEnvVarDefault } from "@vioxen/subscription-runtime/provider-codex";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { ChildExecutionBudget, parseChildLifetime, type ChildLifetime } from "@vioxen/subscription-runtime/core";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { FileBackendCodexSafeExecutorOptions, FileBackendCodexSafeExecutorRunInput } from "./file-backend-codex-safe-executor";

export function assertChildGoalConfig(config: CodexGoalRunConfig): void {
  if (!config.childLifetime) return;
  const bound = parseChildLifetime(config.childLifetime);
  // This legacy option names child-local capacity metadata, never an auth/key locator.
  if (config.authRootDir !== config.jobRootDir + "/capacity" || config.accounts.length !== 1 || config.accounts[0]?.name !== bound.accountId ||
      config.maxAccountCycles !== 1 || config.safeExecutionPolicy?.maxAttempts !== 1 ||
      config.safeExecutionPolicy?.continuationMode !== "disabled" || config.prewarmOnStart === true ||
      config.executionEngine !== "app-server-goal" || config.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || config.model !== codexMimoDefaultModel || config.accessBoundary !== bound.accessBoundary ||
      config.maxGoalTurns !== bound.maxGoalTurns ||
      config.editMode !== (bound.accessBoundary === AccessBoundary.ReadOnly ? "read-only" : "allow-edits") ||
      config.providerSandboxMode !== (bound.accessBoundary === AccessBoundary.ReadOnly ? undefined : "workspace-write") ||
      !config.projectAccessScope || config.projectAccessScope.projectId !== (config.jobId ?? config.taskId) ||
      JSON.stringify(config.projectAccessScope.readRoots) !== JSON.stringify([config.workspacePath]) ||
      Object.keys(config.projectAccessScope).sort().join(",") !== (bound.accessBoundary === AccessBoundary.ReadOnly ? "projectId,readRoots" : "isolatedWorkspaceRoot,projectId,readRoots") ||
      (bound.accessBoundary === AccessBoundary.IsolatedWorkspaceWrite && config.projectAccessScope.isolatedWorkspaceRoot !== config.workspacePath) ||
      config.allowDangerFullAccess === true || config.allowDuplicateAccountIdentities === true ||
      config.accounts[0]?.authJsonPath !== undefined ||
      (config.accounts[0]?.envVarName ?? codexMimoApiKeyEnvVarDefault) !== codexMimoApiKeyEnvVarDefault ||
      (config.mimoAccounts && (config.mimoAccounts.length !== 1 || config.mimoAccounts[0]?.name !== bound.accountId || (config.mimoAccounts[0]?.envVarName ?? codexMimoApiKeyEnvVarDefault) !== codexMimoApiKeyEnvVarDefault))) invalid();
  new ChildExecutionBudget(bound).remainingMs();
}
export function assertChildExecutor(options: FileBackendCodexSafeExecutorOptions,
  input?: FileBackendCodexSafeExecutorRunInput): void {
  const budget = options.childBudget;
  if (!budget) return;
  const bound = budget.lifetime;
  const policy = { ...options.safeExecutionPolicy, ...input?.safeExecutionPolicy };
  if (options.accounts.length !== 1 || options.maxAccountCycles !== 1 ||
      (input?.maxAccountCycles !== undefined && input.maxAccountCycles !== 1) ||
      policy.maxAttempts !== 1 || policy.continuationMode !== "disabled" || options.prewarmOnStart === true ||
      (input?.controls?.editMode !== undefined && input.controls.editMode !== (bound.accessBoundary === AccessBoundary.ReadOnly ? "read-only" : "allow-edits")) ||
      (input?.controls?.providerSandboxMode !== undefined && input.controls.providerSandboxMode !== (bound.accessBoundary === AccessBoundary.ReadOnly ? undefined : "workspace-write")) ||
      input?.logicalThread !== undefined || input?.recoveryPacket !== undefined || options.controlInbox !== undefined) invalid();
  for (const { worker } of options.accounts) {
    if ((input?.controls?.model !== undefined && input.controls.model !== worker.model) ||
        (input?.controls?.maxTurns !== undefined && input.controls.maxTurns !== bound.maxGoalTurns) ||
        (input?.controls?.allowedTools !== undefined && !sameTools(input.controls.allowedTools, bound)) ||
        input?.controls?.disallowedTools !== undefined || input?.controls?.toolPolicy !== undefined ||
        input?.controls?.workspaceInstructionPolicy !== undefined || input?.controls?.allowDangerFullAccess === true ||
        input?.controls?.accessBoundary !== undefined ||
        worker.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || worker.model !== codexMimoDefaultModel ||
        worker.mimoApiKeyEnvVarName !== codexMimoApiKeyEnvVarDefault ||
        worker.capacityAccountId !== bound.accountId || worker.childBudget !== budget ||
        worker.executionEngine !== "app-server-goal" || worker.maxGoalTurns !== bound.maxGoalTurns ||
        worker.cleanThreadPrewarm !== false || !sameTools(worker.boundedWorkspaceTools?.allowedTools, bound) ||
        worker.boundedWorkspaceTools?.denyProjectInstructions !== true) invalid();
  }
  budget.remainingMs();
}
export function sameTools(tools: readonly string[] | undefined, bound: ChildLifetime): boolean {
  return tools !== undefined && [...tools].sort().join(",") === [...bound.allowedTools].sort().join(",");
}
function invalid(): never { throw new Error("child_effective_confinement_conflict"); }

/** Manifest/launch adapter validation; no default fills a missing child setting. */
export function childConfigFromRecord(value: Readonly<Record<string, unknown>>): Pick<CodexGoalRunConfig, "childLifetime" | "maxGoalTurns" | "safeExecutionPolicy"> {
  if (value.childLifetime === undefined) {
    // Registered native MiMo uses the existing fixed worker attempt contract.
    // Retain declared semantics and derive the fixed Worker defaults from its
    // existing provider/engine/report contract, including public tool input.
    // Other legacy executors keep their existing defaults.
    if (value.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) return {};
    const nativeWorker = value.executionEngine === "app-server" && value.workerReportMode === "structured-output";
    if (!nativeWorker && value.maxGoalTurns === undefined && value.safeExecutionPolicy === undefined) return {};
    const expected = { maxAttempts: 1, continuationMode: "disabled" as const,
      retryOnCapacity: false, retryOnAccountUnavailable: false, retryOnReconnectRequired: false };
    const turns = value.maxGoalTurns === undefined ? (nativeWorker ? 8 : undefined) : value.maxGoalTurns;
    const policy = value.safeExecutionPolicy === undefined ? (nativeWorker ? expected : undefined) : value.safeExecutionPolicy;
    if (turns !== 8 || !policy || typeof policy !== "object" || Array.isArray(policy)) invalid();
    const record = policy as Record<string, unknown>;
    if (Object.keys(record).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, item]) => record[key] !== item)) invalid();
    return { maxGoalTurns: 8, safeExecutionPolicy: expected };
  }
  const childLifetime = parseChildLifetime(value.childLifetime);
  if (value.maxGoalTurns !== childLifetime.maxGoalTurns || !value.safeExecutionPolicy ||
      typeof value.safeExecutionPolicy !== "object" || Array.isArray(value.safeExecutionPolicy)) invalid();
  const policy = value.safeExecutionPolicy as Record<string, unknown>;
  if (Object.keys(policy).sort().join(",") !== "continuationMode,maxAttempts" || policy.maxAttempts !== 1 || policy.continuationMode !== "disabled") invalid();
  return { childLifetime, maxGoalTurns: childLifetime.maxGoalTurns, safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled" } };
}
