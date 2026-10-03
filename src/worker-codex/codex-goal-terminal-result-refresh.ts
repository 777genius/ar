import type {
  RunProgressClassification,
  RuntimeRecommendedAction,
  RuntimeResultArtifact,
  RuntimeResultEnvelope,
} from "@vioxen/subscription-runtime/worker-core";
import { captureCodexGoalHandoffPatchFingerprint } from "./codex-goal-handoff-artifacts";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { createCodexGoalResultRecorder } from "./codex-goal-runtime-result-io";
import {
  terminalCodexGoalHandoffResultDetails,
  tryMaterializeTerminalCodexGoalHandoff,
} from "./codex-goal-terminal-handoff-materialization";
import type { CodexGoalRunConfig } from "./codex-goal-runner";

export async function refreshCompletedCodexGoalResultArtifacts(input: {
  readonly config: Pick<
    CodexGoalRunConfig,
    "durableHandoffRootDir" | "jobRootDir" | "jobId" | "outputPath" |
      "taskId" | "workspacePath"
  >;
  readonly outputPath: string;
  readonly existingResult: RuntimeResultEnvelope;
  readonly changedFiles: readonly string[];
  readonly preservePatch: boolean;
}): Promise<{
  readonly wrote: true;
  readonly reason: string;
  readonly outputPath: string;
  readonly classification?: RunProgressClassification;
  readonly recommendedAction: RuntimeRecommendedAction;
  readonly result: RuntimeResultEnvelope;
}> {
  // This function is exported as well as called by the admitted reconciler.
  // Hold admission while creating referenced handoff files and replacing result.
  return new LocalTerminalCheckpointAdmission(input.config.jobRootDir).withWriter(
    () => refreshCompletedCodexGoalResultArtifactsAdmitted(input),
  );
}

async function refreshCompletedCodexGoalResultArtifactsAdmitted(input: Parameters<
  typeof refreshCompletedCodexGoalResultArtifacts
>[0]): ReturnType<typeof refreshCompletedCodexGoalResultArtifacts> {
  const handoff = input.changedFiles.length > 0
    ? await refreshedHandoffArtifacts(input)
    : null;
  const artifacts = handoff
    ? [...handoff.artifacts, ...await retainedVerifierArtifacts(input, handoff)]
    : input.existingResult.artifacts ?? [];
  const changedFiles = handoff?.changedPaths ?? input.existingResult.changedFiles;
  const result = await createCodexGoalResultRecorder({
    outputPath: input.outputPath,
    terminalCheckpointJobRootDir: input.config.jobRootDir,
  }).record({
    status: "done",
    provider: input.existingResult.provider,
    runId: input.existingResult.runId,
    taskId: input.existingResult.taskId,
    classification: input.existingResult.classification,
    reason: input.existingResult.reason,
    details: {
      ...(input.existingResult.details ?? {}),
      ...(handoff?.baseCommit === undefined
        ? {}
        : { baseCommit: handoff.baseCommit }),
      ...terminalCodexGoalHandoffResultDetails(handoff?.handoff ?? null),
    },
    changedFiles,
    evidence: [
      ...input.existingResult.evidence,
      "supervisor_refreshed_terminal_result_artifacts",
      ...artifacts.map((artifact) => `patch_preserved:${artifact.path ?? ""}`),
    ],
    blockers: [],
    nextAction: input.existingResult.nextAction,
    artifacts,
  });
  return {
    wrote: true,
    reason: "terminal_result_artifacts_refreshed",
    outputPath: input.outputPath,
    ...(input.existingResult.classification === undefined
      ? {}
      : { classification: input.existingResult.classification }),
    recommendedAction: input.existingResult.nextAction,
    result,
  };
}

async function refreshedHandoffArtifacts(input: {
  readonly config: Pick<
    CodexGoalRunConfig,
    "durableHandoffRootDir" | "jobRootDir" | "jobId" | "taskId" |
      "workspacePath"
  >;
  readonly existingResult: RuntimeResultEnvelope;
}): Promise<{
  readonly artifacts: readonly RuntimeResultArtifact[];
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly handoff: Awaited<ReturnType<
    typeof tryMaterializeTerminalCodexGoalHandoff
  >>;
} | null> {
  const expectedBaseCommit = runtimeResultBaseCommit(input.existingResult);
  const materialized = await tryMaterializeTerminalCodexGoalHandoff({
    ...input.config,
    ...(expectedBaseCommit === undefined ? {} : { expectedBaseCommit }),
  });
  if (!materialized.packetPath || !materialized.manifestSha256 ||
    !materialized.baseCommit ||
    materialized.artifacts.length === 0) {
    throw new Error(
      `dirty_terminal_handoff_unavailable:${materialized.errorCode ?? "unknown"}`,
    );
  }
  return {
    artifacts: materialized.artifacts,
    baseCommit: materialized.baseCommit,
    changedPaths: materialized.changedPaths ?? input.existingResult.changedFiles,
    handoff: materialized,
  };
}

function runtimeResultBaseCommit(
  result: RuntimeResultEnvelope,
): string | undefined {
  const value = result.details?.baseCommit;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function retainedVerifierArtifacts(
  input: Parameters<typeof refreshCompletedCodexGoalResultArtifacts>[0],
  handoff: NonNullable<Awaited<ReturnType<typeof refreshedHandoffArtifacts>>>,
): Promise<readonly RuntimeResultArtifact[]> {
  // The verifier consumes the immutable patch/manifest contract. Durable packet
  // descriptors supplement that evidence; they cannot replace its schema.
  const reviewArtifacts = (input.existingResult.artifacts ?? []).filter(
    (artifact) => ["patch", "summary", "manifest"].includes(artifact.kind),
  );
  const patch = reviewArtifacts.find((artifact) => artifact.kind === "patch");
  if (!patch?.sha256 || !reviewArtifacts.some((artifact) => artifact.kind === "manifest")) {
    return [];
  }
  let fingerprint;
  try {
    fingerprint = await captureCodexGoalHandoffPatchFingerprint({
      workspacePath: input.config.workspacePath,
      expectedBaseCommit: handoff.baseCommit,
    });
  } catch {
    // A previous review patch is not evidence of a changed or incompatible
    // workspace. Leave it unavailable so verifier admission fails closed.
    return [];
  }
  if (!fingerprint || fingerprint.patchSha256 !== patch.sha256) return [];
  // Bind the review fingerprint to the same verified packet, including staged
  // and untracked layers, rather than accepting a mutation between captures.
  const confirmed = await tryMaterializeTerminalCodexGoalHandoff({
    ...input.config,
    expectedBaseCommit: handoff.baseCommit,
  });
  if (confirmed.packetPath !== handoff.handoff.packetPath ||
    confirmed.manifestSha256 !== handoff.handoff.manifestSha256) {
    throw new Error("handoff_workspace_changed_during_materialization");
  }
  return reviewArtifacts;
}
