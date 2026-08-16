import { join, resolve } from "node:path";
import {
  parseCodexGoalJobManifest,
  type CodexGoalJobManifest,
} from "../../codex-goal-jobs";

export type FrozenOutputRuntimeObservation = {
  readonly workspaceDirty: boolean;
  readonly workerAlive: boolean;
  readonly resultExists: boolean;
  readonly resultPath?: string;
};

export type FrozenOutputRuntimeObserver = (
  manifest: CodexGoalJobManifest,
) => Promise<FrozenOutputRuntimeObservation>;

export function effectiveResultPath(manifest: CodexGoalJobManifest): string {
  return resolve(manifest.outputPath ?? join(
    manifest.jobRootDir,
    `${manifest.taskId}.latest-result.json`,
  ));
}

export function parseJobManifest(bytes: Uint8Array): CodexGoalJobManifest {
  try {
    return parseCodexGoalJobManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    throw new Error("frozen_output_job_manifest_invalid", { cause: error });
  }
}

export function assertRegistryManifestIdentity(input: {
  readonly registryRootDir: string;
  readonly manifestPath: string;
  readonly manifest: CodexGoalJobManifest;
  readonly expectedJobId: string;
}): void {
  const expectedJobRoot = join(resolve(input.registryRootDir), input.expectedJobId);
  if (input.manifest.jobId !== input.expectedJobId ||
    resolve(input.manifestPath) !== join(expectedJobRoot, "job.json") ||
    resolve(input.manifest.jobRootDir) !== expectedJobRoot) {
    throw new Error("frozen_output_registry_identity_mismatch");
  }
}
