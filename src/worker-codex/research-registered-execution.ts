import { join } from "node:path";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import { CodexModelBackend, codexMimoApiKeyEnvVarDefault } from "@vioxen/subscription-runtime/provider-codex";
import { defaultStartupTimeoutMs } from "../provider-codex/app-server/domain/app-server-types";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { bindProjectChildCheckpointPublisher } from "./codex-goal-mcp-project-broker";
import { codexProjectReservationValueSha256, type CodexProjectReservedLaunchAuthority } from "./application/project-control/codex-goal-project-account-reservation";
import { parseResearchRegisteredExecution, researchExecutionOptions, type ResearchOperatorRequest, type ResearchRegisteredExecution } from "./research-launch-contract";

export class RegisteredResearchExecutionUnsupported extends Error {
  constructor() { super("hosted_research_registered_execution_unsupported"); }
}
const unsupported = (): never => { throw new RegisteredResearchExecutionUnsupported(); };

/** Source-owned finite compatibility gate. Run before sink preparation; an
 * operator adapter's earlier preflight cannot replace this effect boundary. */
type RegisteredExecutionInput = {
  readonly registryRootDir: string; readonly manifest: CodexGoalJobManifest; readonly controller: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput; readonly request: ResearchOperatorRequest;
  readonly execution: ResearchRegisteredExecution | undefined;
};
export function assertRegisteredResearchExecutionSupported(input: RegisteredExecutionInput): void {
  assertProjectResearchExecutionSupported(input, CodexModelBackend.OpenAiChatGpt);
}
/** Native MiMo has a fixed single-attempt worker contract and no durable sink.
 * Reuse identity checks without weakening the existing OpenAI route. */
export function assertMimoProjectResearchExecutionSupported(input: RegisteredExecutionInput): void {
  assertProjectResearchExecutionSupported(input, CodexModelBackend.XiaomiMimoTokenPlan);
}
function assertProjectResearchExecutionSupported(input: RegisteredExecutionInput, backend: CodexModelBackend): void {
  const mimo = backend === CodexModelBackend.XiaomiMimoTokenPlan;
  const { config: c } = input.launch, r = input.request;
  if (!input.execution || r.projectId === undefined || r.maxAccountCycles === undefined || r.prewarmOnStart === undefined || r.appServerStartupTimeoutMs === undefined) return unsupported();
  const e = input.execution;
  let checkpoint: CodexGoalLaunchInput;
  try { checkpoint = bindProjectChildCheckpointPublisher({ launch: input.launch,
    controllerCheckpointRequired: input.controller.checkpointRequired === true,
    childCheckpointRequired: input.manifest.checkpointRequired === true, hostEnv: process.env }); }
  catch { return unsupported(); }
  if (checkpoint.config.checkpointRequired || checkpoint.config.checkpointPublisherSocketPath || c.checkpointPublisherSocketPath) unsupported();
  if (c.accessBoundary !== AccessBoundary.IsolatedWorkspaceWrite || c.networkAccess !== NetworkAccessMode.Unrestricted ||
      c.executionEngine !== (mimo ? "app-server" : "app-server-goal") ||
      (c.modelBackend ?? CodexModelBackend.OpenAiChatGpt) !== backend ||
      (r.modelBackend ?? CodexModelBackend.OpenAiChatGpt) !== backend ||
      c.allowDangerFullAccess === true || c.allowDuplicateAccountIdentities === true || c.requireGitWorkspace !== true ||
      c.outputPath !== join(c.jobRootDir, `${c.taskId}.latest-result.json`) ||
      c.progressPath !== join(c.jobRootDir, `${c.taskId}.progress.json`) || c.progressHeartbeatMs !== 60_000 ||
      c.editMode !== "allow-edits" || (c.providerSandboxMode !== undefined && c.providerSandboxMode !== "workspace-write") ||
      (c.stateRootDir !== undefined && c.stateRootDir !== join(c.jobRootDir, "state")) ||
      (c.runtimeHomeRootDir !== undefined && c.runtimeHomeRootDir !== join(c.jobRootDir, "home")) ||
      !c.projectAccessScope || c.projectAccessScope.projectId !== e.projectId || c.projectAccessScope.isolatedWorkspaceRoot !== c.workspacePath || c.projectAccessScope.authRoot !== c.authRootDir ||
      (c.projectAccessScope.deniedRoots?.length ?? 0) > 0 ||
      (c.projectAccessScope.registryRoot !== undefined && (c.projectAccessScope.registryRoot !== input.registryRootDir ||
        c.workspacePath === input.registryRootDir || c.workspacePath.startsWith(input.registryRootDir + "/") ||
        input.registryRootDir.startsWith(c.workspacePath + "/"))) ||
      c.accounts.some(account => Object.entries(account).some(([key, value]) => value !== undefined && key !== "name" &&
        !(mimo && key === "envVarName" && value === codexMimoApiKeyEnvVarDefault))) ||
      (!mimo && (input.manifest.maxGoalTurns !== undefined || input.manifest.safeExecutionPolicy !== undefined)) || input.manifest.childLifetime !== undefined) unsupported();
  const mimoPolicy = { maxAttempts: 1, continuationMode: "disabled", retryOnCapacity: false,
    retryOnAccountUnavailable: false, retryOnReconnectRequired: false };
  if (mimo && (input.manifest.maxGoalTurns !== 8 ||
      Object.keys(input.manifest.safeExecutionPolicy ?? {}).length !== Object.keys(mimoPolicy).length ||
      Object.entries(mimoPolicy).some(([key, value]) => input.manifest.safeExecutionPolicy?.[key as keyof typeof mimoPolicy] !== value) ||
      r.durableHandoffRootDir !== undefined || input.manifest.durableHandoffRootDir !== undefined ||
      c.durableHandoffRootDir !== join(input.registryRootDir, "durable-handoffs") ||
      c.maxAccountCycles !== 1 || c.prewarmOnStart !== false || r.accounts[0] !== "account-q" ||
      c.workerReportMode !== "structured-output" ||
      (c.mimoAccounts !== undefined && (c.mimoAccounts.length !== 1 || c.mimoAccounts[0]?.name !== "account-q" ||
        (c.mimoAccounts[0]?.envVarName ?? codexMimoApiKeyEnvVarDefault) !== codexMimoApiKeyEnvVarDefault)))) unsupported();
  const accepted = new Set(["jobId", "jobRootDir", "durableHandoffRootDir", "stateRootDir", "runtimeHomeRootDir", "authRootDir",
    "workspacePath", "promptPath", "taskId", "accounts", "outputPath", "progressPath", "progressHeartbeatMs", "codexBinaryPath",
    "model", "reasoningEffort", "serviceTier", "executionEngine", "modelBackend", "taskTimeoutMs", "appServerStartupTimeoutMs",
    "maxAccountCycles", "editMode", "providerSandboxMode", "accessBoundary", "projectAccessScope", "allowDangerFullAccess",
    "networkAccess", "allowDuplicateAccountIdentities", "requireGitWorkspace", "prewarmOnStart"]);
  if (mimo) { accepted.add("workerReportMode"); accepted.add("mimoAccounts"); accepted.add("maxGoalTurns"); accepted.add("safeExecutionPolicy"); }
  for (const [key, value] of Object.entries(c)) if (value !== undefined && !accepted.has(key)) unsupported();
  const account = c.accounts.find(account => account.name === e.accountId);
  const reserved = { ...c, accounts: account ? [account] : [], maxAccountCycles: 1 };
  const options = researchExecutionOptions(r);
  if (r.accounts.length !== 1 || r.accounts[0] !== e.accountId || r.projectId !== e.projectId || !account ||
      codexProjectReservationValueSha256(c) !== e.sourceConfigSha256 ||
      codexProjectReservationValueSha256(reserved) !== e.reservedConfigSha256 ||
      codexProjectReservationValueSha256(account) !== e.selectedAccountSha256 ||
      options.maxAccountCycles !== e.maxAccountCycles || options.prewarmOnStart !== e.prewarmOnStart ||
      options.appServerStartupTimeoutMs !== e.appServerStartupTimeoutMs ||
      e.prewarmOnStart !== (c.prewarmOnStart ?? false) ||
      e.appServerStartupTimeoutMs !== (c.appServerStartupTimeoutMs ?? defaultStartupTimeoutMs)) unsupported();
}
export function researchRegisteredExecutionFromReservation(authority: CodexProjectReservedLaunchAuthority,
  launch: CodexGoalLaunchInput): ResearchRegisteredExecution {
  // Capacity/reconnect continuations carry journal/invocation semantics which
  // this fresh registered route does not yet support. Never relabel them fresh.
  if (!authority.fresh || authority.maxAccountCycles !== 1 || !launch.config.projectAccessScope?.projectId) unsupported();
  return parseResearchRegisteredExecution({ sourceConfigSha256: authority.sourceConfigSha256,
    reservedConfigSha256: authority.reservedConfigSha256, selectedAccountSha256: authority.selectedAccountSha256,
    accountId: authority.accountId, projectId: launch.config.projectAccessScope!.projectId, maxAccountCycles: authority.maxAccountCycles,
    prewarmOnStart: launch.config.prewarmOnStart ?? false,
    appServerStartupTimeoutMs: launch.config.appServerStartupTimeoutMs ?? defaultStartupTimeoutMs });
}
