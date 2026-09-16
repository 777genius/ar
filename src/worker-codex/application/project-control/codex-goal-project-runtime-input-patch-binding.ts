import { createHash } from "node:crypto";

import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import {
  captureCodexGoalContinuationWorkspaceFingerprint,
  captureCodexGoalHandoffPatchFingerprint,
} from "../../codex-goal-handoff-artifacts";
import type {
  ProjectPreStartBinding,
  VerifiedInputPatchBinding,
} from "./codex-goal-project-pre-start-binding";
import { readControlledRuntimeInterruptionSnapshot } from "./codex-goal-project-verifier-handoff";
import {
  parseWorkerLaunchSpec,
  workerLaunchOwnsChangedPath,
} from "./worker-launch-spec";

type JsonObject = Readonly<Record<string, unknown>>;

export async function controlledRuntimeInputPatchBindingValid(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly builtin: boolean;
  readonly contract: JsonObject;
  readonly binding: ProjectPreStartBinding;
  readonly verifiedInputPatch: VerifiedInputPatchBinding | undefined;
}): Promise<boolean> {
  if (!input.builtin) return false;
  const launch = parseWorkerLaunchSpec(input.contract);
  const snapshot = await readControlledRuntimeInterruptionSnapshot({
    producer: input.manifest,
  });
  const fresh = snapshot.kind === "materialized_handoff"
    ? await captureCodexGoalHandoffPatchFingerprint({
        workspacePath: input.manifest.workspacePath,
        expectedBaseCommit: launch.phaseStartSha,
      })
    : await captureCodexGoalContinuationWorkspaceFingerprint({
        workspacePath: input.manifest.workspacePath,
        expectedBaseCommit: launch.phaseStartSha,
      });
  const freshSha = fresh && ("patchSha256" in fresh
    ? fresh.patchSha256
    : fresh.sha256);
  const handoffBindingValid = fresh !== null &&
    snapshot.baseCommit === launch.phaseStartSha &&
    fresh.baseCommit === snapshot.baseCommit &&
    freshSha === snapshot.sha256 &&
    snapshot.changedPaths.length > 0 &&
    samePaths(fresh.changedPaths, snapshot.changedPaths) &&
    snapshot.changedPaths.every((path) =>
      workerLaunchOwnsChangedPath(launch, path)
    );
  if (
    input.verifiedInputPatch &&
    verifiedRuntimeInputPatchBindingValid(
      input.binding,
      input.verifiedInputPatch,
    )
  ) {
    return handoffBindingValid;
  }
  if (launch.reviewKind === "review") return false;
  return handoffBindingValid;
}

function verifiedRuntimeInputPatchBindingValid(
  binding: ProjectPreStartBinding,
  verifiedInputPatch: VerifiedInputPatchBinding,
): boolean {
  const emptyPatchSha256 = createHash("sha256")
    .update(Buffer.alloc(0))
    .digest("hex");
  return /^[a-f0-9]{64}$/.test(verifiedInputPatch.artifactSha256) &&
    /^[a-f0-9]{64}$/.test(verifiedInputPatch.stagedPatchSha256) &&
    binding.workspaceStatus !== "" &&
    binding.workspacePatchSha256 === verifiedInputPatch.stagedPatchSha256 &&
    ((!binding.workspaceUnstagedDirty &&
      binding.workspaceStagedPatchSha256 ===
        verifiedInputPatch.stagedPatchSha256) ||
      (binding.workspaceUnstagedDirty &&
        binding.workspaceStagedPatchSha256 === emptyPatchSha256));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((path, index) => path === right[index]);
}
