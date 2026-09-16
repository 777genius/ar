import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";

import { readRuntimeResultBrief } from "../codex-goal-runtime-result";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import type { CodexGoalStatus } from "../../codex-goal-ops";
import {
  captureCodexGoalContinuationWorkspaceFingerprint,
  captureCodexGoalHandoffPatchFingerprint,
} from "../../codex-goal-handoff-artifacts";
import { captureGitWorkspacePatch } from "../../codex-goal-runtime-result-io";
import { readControlledRuntimeInterruptionEvidence } from "../../codex-goal-runtime-control-evidence";
import {
  hasRelevantConsumedOutputDebt,
  readCodexGoalConsumedOutputLedgers,
  resolveRejectedUncapturedOutputPatchSha256,
} from "./codex-goal-consumed-output-ledger-io";
import { admissionWorkspacePathsMatch } from "./codex-goal-project-admission-paths";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  readLaunchAuthorizedWorkerLaunchAttestation,
} from "./codex-goal-project-pre-start-admission";
import type { ProjectPreStartContinuationDecision } from "./codex-goal-project-pre-start-continuation";
import { readControlledRuntimeInterruptionSnapshot } from "./codex-goal-project-verifier-handoff";

const MAX_RESULT_BYTES = 1024 * 1024;
type ProjectRuntimeCapacityFailureReason =
  | "account_unavailable"
  | "capacity_unavailable"
  | "quota_limited"
  | "reconnect_required";

type RuntimeContinuationDecision = Extract<
  ProjectPreStartContinuationDecision,
  { readonly kind: "capacity" | "controlled_runtime_interruption" }
>;

export type ProjectRuntimeContinuationCause =
  | {
      readonly kind: "capacity";
      readonly failureReason: ProjectRuntimeCapacityFailureReason;
    }
  | {
      readonly kind: "controlled_runtime_interruption";
      readonly signalId: string;
      readonly resultUpdatedAt: string;
    };

export type ProjectRuntimeContinuationEvidence =
  | {
      readonly kind: "capacity";
      readonly failureReason: ProjectRuntimeCapacityFailureReason;
      readonly resultSha256: string;
    }
  | {
      readonly kind: "controlled_runtime_interruption";
      readonly signalId: string;
      readonly resultUpdatedAt: string;
      readonly resultSha256: string;
    };

export type ProjectControlledRuntimeInPlaceContinuation = {
  readonly ownedPaths: readonly string[];
  readonly workspaceFingerprintSha256: string;
  readonly launchReceiptSha256: string;
  readonly evidence: ProjectRuntimeContinuationEvidence;
  readonly rejectedPatchSha256?: string;
};

export function projectRuntimeContinuationCause(
  decision: ProjectPreStartContinuationDecision | undefined,
  status: Pick<CodexGoalStatus, "resultReason" | "progressResultReason">,
): ProjectRuntimeContinuationCause | undefined {
  if (
    !decision ||
    decision.workspaceMode !== "admitted_input_patch_runtime_continuation"
  ) {
    return undefined;
  }
  const runtimeDecision = decision as RuntimeContinuationDecision;
  return runtimeDecision.kind === "controlled_runtime_interruption"
    ? {
        kind: runtimeDecision.kind,
        signalId: runtimeDecision.evidence.signalId,
        resultUpdatedAt: runtimeDecision.evidence.resultUpdatedAt,
      }
    : {
        kind: "capacity",
        failureReason: exactCapacityFailureReason(status),
      };
}

export async function assertProjectControlledRuntimeInPlaceContinuation(
  input: {
    readonly manifest: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
    readonly workspacePath: string;
    readonly expected: ProjectControlledRuntimeInPlaceContinuation;
  },
): Promise<void> {
  const current = await resolveProjectControlledRuntimeInPlaceContinuation({
    manifest: input.manifest,
    scope: input.scope,
    cause: input.expected.evidence,
    workspacePath: input.workspacePath,
  });
  if (!sameContinuationBinding(current, input.expected)) {
    throw new Error(
      "project_control_runtime_interruption_continuation_binding_mismatch",
    );
  }
}

/**
 * Derives continuation ownership only from the launch-authorized broker
 * attestation, then binds it to the exact durable result and dirty workspace
 * generation. These are admission facts, not restart policy.
 */
export async function resolveProjectControlledRuntimeInPlaceContinuation(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly cause: ProjectRuntimeContinuationCause;
  readonly workspacePath: string;
}): Promise<ProjectControlledRuntimeInPlaceContinuation> {
  if (
    !await admissionWorkspacePathsMatch(
      input.manifest.workspacePath,
      input.workspacePath,
    )
  ) {
    throw new Error(
      "project_control_runtime_interruption_workspace_identity_mismatch",
    );
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch_runtime_continuation",
  });
  const attestation = await readLaunchAuthorizedWorkerLaunchAttestation({
    manifest: input.manifest,
    scope: input.scope,
  });

  const snapshot = await readControlledRuntimeInterruptionSnapshot({
    producer: input.manifest,
  });
  if (!snapshot.resultPath) {
    throw new Error(
      "project_control_runtime_interruption_result_binding_required",
    );
  }
  const evidence = await readRuntimeContinuationEvidence({
    cause: input.cause,
    resultPath: snapshot.resultPath,
    taskId: input.manifest.taskId,
  });
  const fresh = snapshot.kind === "materialized_handoff"
    ? await captureCodexGoalHandoffPatchFingerprint({
        workspacePath: input.workspacePath,
        expectedBaseCommit: snapshot.baseCommit,
      })
    : await captureCodexGoalContinuationWorkspaceFingerprint({
        workspacePath: input.workspacePath,
        expectedBaseCommit: snapshot.baseCommit,
      });
  const freshSha256 = fresh && ("patchSha256" in fresh
    ? fresh.patchSha256
    : fresh.sha256);
  if (
    !fresh ||
    snapshot.baseCommit !== attestation.launch.phaseStartSha ||
    fresh.baseCommit !== snapshot.baseCommit ||
    freshSha256 !== snapshot.sha256 ||
    !sameStrings(fresh.changedPaths, snapshot.changedPaths)
  ) {
    throw new Error(
      "project_control_runtime_interruption_workspace_fingerprint_mismatch",
    );
  }

  const rejectedPatchSha256 = await resolveCurrentRejectedPatchSha256({
    scope: input.scope,
    manifest: input.manifest,
    workspacePath: input.workspacePath,
  });
  return {
    ownedPaths: attestation.launch.ownedPaths,
    workspaceFingerprintSha256: snapshot.sha256,
    launchReceiptSha256: attestation.receiptSha256,
    evidence,
    ...(rejectedPatchSha256 ? { rejectedPatchSha256 } : {}),
  };
}

async function readRuntimeContinuationEvidence(input: {
  readonly cause: ProjectRuntimeContinuationCause;
  readonly resultPath: string;
  readonly taskId: string;
}): Promise<ProjectRuntimeContinuationEvidence> {
  const resultBytes = await readFile(input.resultPath);
  if (resultBytes.byteLength > MAX_RESULT_BYTES) {
    throw new Error("project_control_runtime_interruption_result_size_limit");
  }
  const resultSha256 = createHash("sha256").update(resultBytes).digest("hex");
  if (input.cause.kind === "controlled_runtime_interruption") {
    const evidence = await readControlledRuntimeInterruptionEvidence({
      resultPath: input.resultPath,
      taskId: input.taskId,
    });
    if (
      !evidence ||
      evidence.signalId !== input.cause.signalId ||
      evidence.resultUpdatedAt !== input.cause.resultUpdatedAt
    ) {
      throw new Error(
        "project_control_runtime_interruption_signal_evidence_mismatch",
      );
    }
    return { ...input.cause, resultSha256 };
  }
  const result = await readRuntimeResultBrief(input.resultPath);
  if (
    result.strict !== true ||
    result.status !== "partial" ||
    result.lastFailureReason !== input.cause.failureReason
  ) {
    throw new Error(
      "project_control_runtime_interruption_capacity_evidence_mismatch",
    );
  }
  return {
    kind: "capacity",
    failureReason: input.cause.failureReason,
    resultSha256,
  };
}

function exactCapacityFailureReason(
  status: Pick<CodexGoalStatus, "resultReason" | "progressResultReason">,
): ProjectRuntimeCapacityFailureReason {
  if (
    status.resultReason &&
    status.progressResultReason &&
    status.resultReason !== status.progressResultReason
  ) {
    throw new Error(
      "project_control_runtime_interruption_capacity_evidence_mismatch",
    );
  }
  const reason = status.resultReason ?? status.progressResultReason;
  if (!isProjectRuntimeCapacityFailureReason(reason)) {
    throw new Error(
      "project_control_runtime_interruption_capacity_evidence_mismatch",
    );
  }
  return reason;
}

function isProjectRuntimeCapacityFailureReason(
  value: string | undefined,
): value is ProjectRuntimeCapacityFailureReason {
  return value === "account_unavailable" ||
    value === "capacity_unavailable" ||
    value === "quota_limited" ||
    value === "reconnect_required";
}

async function resolveCurrentRejectedPatchSha256(input: {
  readonly scope: ProjectAccessScope;
  readonly manifest: CodexGoalJobManifest;
  readonly workspacePath: string;
}): Promise<string | undefined> {
  const roots = input.scope.consumedOutputLedgerRoots ?? [];
  if (roots.length !== 1) return undefined;
  const ledger = await readCodexGoalConsumedOutputLedgers({
    roots,
    evidenceRoots: input.scope.consumedOutputEvidenceRoots ?? [],
  });
  if (hasRelevantConsumedOutputDebt(ledger, input.manifest.jobId)) {
    throw new Error(
      "project_control_runtime_interruption_rejected_ledger_evidence_invalid",
    );
  }
  const rejectedPatchSha256 = resolveRejectedUncapturedOutputPatchSha256({
    ledger,
    jobId: input.manifest.jobId,
    workspacePath: input.workspacePath,
  });
  if (!rejectedPatchSha256) return undefined;

  const patch = await captureGitWorkspacePatch({
    workspacePath: input.workspacePath,
  });
  const currentPatchSha256 = createHash("sha256").update(patch).digest("hex");
  if (currentPatchSha256 !== rejectedPatchSha256) {
    throw new Error(
      "project_control_runtime_interruption_rejected_patch_mismatch",
    );
  }
  return rejectedPatchSha256;
}

function sameContinuationBinding(
  left: ProjectControlledRuntimeInPlaceContinuation,
  right: ProjectControlledRuntimeInPlaceContinuation,
): boolean {
  return sameStrings(left.ownedPaths, right.ownedPaths) &&
    left.workspaceFingerprintSha256 === right.workspaceFingerprintSha256 &&
    left.launchReceiptSha256 === right.launchReceiptSha256 &&
    JSON.stringify(left.evidence) === JSON.stringify(right.evidence) &&
    left.rejectedPatchSha256 === right.rejectedPatchSha256;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
