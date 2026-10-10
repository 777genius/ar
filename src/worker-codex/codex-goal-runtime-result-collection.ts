import { nativeWebFromSafeExecutionResult, nativeWebFromManagedError } from "./codex-goal-run-result";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { actionForRuntimeState } from "@vioxen/subscription-runtime/worker-core";
import { requireCodexWorkerReport, CodexWorkerReportValidationError } from "./codex-goal-report-schema";
import type { RuntimeResultEnvelopeInput, SafeExecutionRunResult } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import type { FileBackendCodexWorkerResult } from "./file-backend-codex-worker";
import { codexRunnerExceptionFailure, runtimeActionFromSafeExecutionResult,
  runtimeBlockersFromSafeExecutionResult, runtimeEvidenceFromSafeExecutionResult,
  runtimeResultDetails, runtimeStatusFromSafeExecutionResult, workerReportFromSafeExecutionResult } from "./codex-goal-run-result";
import { assertDirtyTerminalHandoffAvailable, terminalCodexGoalHandoffEvidence,
  terminalCodexGoalHandoffResultDetails, tryMaterializeTerminalCodexGoalHandoff,
  type TerminalHandoffPublicationAuthority } from "./codex-goal-terminal-handoff-materialization";
import { changedFilesFromSafeExecutionResult, changedFilesFromWorkspace, uniqueStrings } from "./codex-goal-workspace-changes";

// Collection availability is a diagnostic fact, never execution authority.
enum WorkspaceChangesCollectionState { Available = "available", Unknown = "unknown" }
type WorkspaceChangesCollection = Awaited<ReturnType<typeof changedFilesFromWorkspace>> & {
  readonly state: WorkspaceChangesCollectionState;
  readonly failure?: { readonly error: unknown };
};
async function collectWorkspaceChanges(workspacePath: string): Promise<WorkspaceChangesCollection> {
  try {
    const workspace = await changedFilesFromWorkspace(workspacePath);
    return { ...workspace, state: workspace.warning === undefined
      ? WorkspaceChangesCollectionState.Available : WorkspaceChangesCollectionState.Unknown };
  } catch (error) {
    // The unchanged guarded reader has refused. Never retry or materialize from
    // this Unknown observation; [] carries no claim that the workspace is clean.
    return { state: WorkspaceChangesCollectionState.Unknown, changedFiles: [],
      warning: "workspace_changed_files_unavailable", failure: { error } };
  }
}
function workspaceCollectionDetails(workspace: WorkspaceChangesCollection): Readonly<Record<string, string>> {
  return workspace.state === WorkspaceChangesCollectionState.Unknown ? {
    workspaceChangedFilesState: WorkspaceChangesCollectionState.Unknown,
    workspaceChangedFilesCollection: "unavailable",
    handoffArtifactError: "workspace_changed_files_unavailable",
  } : {};
}

export async function codexRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly result: SafeExecutionRunResult<FileBackendCodexWorkerResult>;
  readonly executionGeneration: string;
  readonly baseCommit?: string;
  readonly deferHandoff?: boolean;
  readonly publicationAuthority?: TerminalHandoffPublicationAuthority;
}): Promise<RuntimeResultEnvelopeInput> {
  const reportedChangedFiles = changedFilesFromSafeExecutionResult(input.result);
  const workspace = await collectWorkspaceChanges(input.config.workspacePath);
  if (workspace.failure && input.result.status === "completed") throw workspace.failure.error;
  const changedFiles = uniqueStrings([
    ...reportedChangedFiles,
    ...workspace.changedFiles,
  ]);
  const ownedMimoCompleted = input.deferHandoff === true &&
    input.config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && input.result.status === "completed";
  const workerReport = ownedMimoCompleted
    ? requireCodexWorkerReport("result" in input.result ? input.result.result?.structuredOutput : undefined)
    : workerReportFromSafeExecutionResult(input.result);
  const reason = "reason" in input.result ? input.result.reason : undefined;
  const status = (ownedMimoCompleted ? workerReport?.outcome : undefined) ?? runtimeStatusFromSafeExecutionResult({
    resultStatus: input.result.status,
    changedFilesCount: changedFiles.length,
  });
  const handoff = input.deferHandoff || workspace.state === WorkspaceChangesCollectionState.Unknown || workspace.changedFiles.length === 0
    ? null
    : await tryMaterializeTerminalCodexGoalHandoff({
        ...input.config,
        ...(input.baseCommit === undefined
          ? {}
          : { expectedBaseCommit: input.baseCommit }),
      }, input.publicationAuthority);
  const artifacts = handoff?.artifacts ?? [];
  if (!input.deferHandoff && workspace.state === WorkspaceChangesCollectionState.Available) assertDirtyTerminalHandoffAvailable(workspace.changedFiles, handoff, artifacts);
  const exactChangedFiles = handoff?.changedPaths ?? changedFiles;
  const nativeWeb = nativeWebFromSafeExecutionResult(input.result);
  const nativeWebDetails = nativeWeb === undefined ? {} : { nativeWeb };
  const details = runtimeResultDetails({
    ...("failureDetails" in input.result && input.result.failureDetails
      ? { failureDetails: input.result.failureDetails }
      : {}),
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    handoffDetails: { ...terminalCodexGoalHandoffResultDetails(handoff), ...workspaceCollectionDetails(workspace) },
    ...nativeWebDetails,
  });
  return {
    status,
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason,
    changedFiles: exactChangedFiles,
    evidence: [
      ...runtimeEvidenceFromSafeExecutionResult(input.result),
      ...(workspace.warning ? [workspace.warning] : []),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...terminalCodexGoalHandoffEvidence(handoff),
      ...(workspace.state === WorkspaceChangesCollectionState.Unknown || changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: runtimeBlockersFromSafeExecutionResult(input.result),
    nextAction: ownedMimoCompleted ? actionForRuntimeState({ status, reason, changedFilesCount: changedFiles.length }) : runtimeActionFromSafeExecutionResult({
      status,
      resultStatus: input.result.status,
      reason,
      changedFilesCount: changedFiles.length,
    }),
    ...(workerReport === undefined ? {} : { workerReport }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    details: { ...(details ?? {}), executionGeneration: input.executionGeneration,
      attemptNumber: String(input.result.attempts.at(-1)?.attemptNumber ?? 0) },
  };
}

export async function codexExceptionRuntimeResultInput(input: {
  readonly config: CodexGoalRunConfig;
  readonly error: unknown;
  readonly executionGeneration: string;
  readonly baseCommit?: string;
  readonly deferHandoff?: boolean;
  readonly publicationAuthority?: TerminalHandoffPublicationAuthority;
}): Promise<RuntimeResultEnvelopeInput> {
  const failure = codexRunnerExceptionFailure(input.error);
  const workspace = await collectWorkspaceChanges(input.config.workspacePath);
  const changedFiles = workspace.changedFiles;
  const handoff = input.deferHandoff || workspace.state === WorkspaceChangesCollectionState.Unknown || changedFiles.length === 0
    ? null
    : await tryMaterializeTerminalCodexGoalHandoff({
        ...input.config,
        ...(input.baseCommit === undefined
          ? {}
          : { expectedBaseCommit: input.baseCommit }),
      }, input.publicationAuthority);
  const artifacts = handoff?.artifacts ?? [];
  if (!input.deferHandoff && workspace.state === WorkspaceChangesCollectionState.Available) assertDirtyTerminalHandoffAvailable(changedFiles, handoff, artifacts);
  const exactChangedFiles = handoff?.changedPaths ?? changedFiles;
  const nativeWeb = nativeWebFromManagedError(input.error);
  const nativeWebDetails = nativeWeb === undefined ? {} : { nativeWeb };
  const details = runtimeResultDetails({
    failureDetails: {
      errorName: input.error instanceof Error ? input.error.name : "unknown",
      ...(failure.errorCode === undefined
        ? {}
        : { errorCode: failure.errorCode }),
    },
    ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }),
    handoffDetails: { ...terminalCodexGoalHandoffResultDetails(handoff), ...workspaceCollectionDetails(workspace) },
    ...nativeWebDetails,
  });
  return {
    status: input.deferHandoff && input.config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan && input.error instanceof CodexWorkerReportValidationError
      ? "failed" : changedFiles.length > 0 ? "partial" : "failed",
    provider: "codex",
    runId: input.config.jobId ?? input.config.taskId,
    taskId: input.config.taskId,
    reason: failure.reason,
    changedFiles: exactChangedFiles,
    evidence: [
      failure.evidence,
      ...(workspace.warning ? [workspace.warning] : []),
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
      ...terminalCodexGoalHandoffEvidence(handoff),
      ...(workspace.state === WorkspaceChangesCollectionState.Unknown || changedFiles.length > 0 && artifacts.length === 0
        ? ["patch_preserve_unavailable"]
        : []),
    ],
    blockers: [failure.reason],
    nextAction: changedFiles.length > 0 ? "preserve_patch" : "recover",
    ...(artifacts.length === 0 ? {} : { artifacts }),
    details: { ...(details ?? {}), executionGeneration: input.executionGeneration },
  };
}
