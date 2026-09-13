import type {
  IntegrationAttempt,
  ReviewedOutputIntegrityPort,
} from "@vioxen/subscription-runtime/worker-core";
import { resolveReviewedWorkerOutput } from "../application/reviewed-worker-output-use-cases";
import { LocalReviewedWorkerOutputStore } from "./local-reviewed-worker-output-adapters";

export class LocalReviewedOutputIntegrationIntegrity implements ReviewedOutputIntegrityPort {
  constructor(private readonly options: {
    readonly rootDir: string;
    readonly projectId: string;
  }) {}

  async verify(attempt: IntegrationAttempt): Promise<void> {
    const output = attempt.workerOutput;
    if (!output.reviewedOutputId) throw new Error("reviewed_output_identity_required");
    const { snapshot } = await resolveReviewedWorkerOutput({
      store: new LocalReviewedWorkerOutputStore({ rootDir: this.options.rootDir }),
      projectId: this.options.projectId,
      reviewedOutputId: output.reviewedOutputId,
      expectedWorkerJobId: output.workerJobId,
    });
    if (
      snapshot.reviewedOutputFileByteAllowance !== output.reviewedOutputFileByteAllowance ||
      snapshot.patchSha256 !== output.patchSha256 ||
      snapshot.patchPath !== (output.sourcePatchPath ?? output.patchPath) ||
      snapshot.sourceWorkspacePath !== output.workspacePath ||
      snapshot.baseCommit !== output.baseCommit ||
      JSON.stringify(snapshot.changedFiles) !== JSON.stringify(output.changedFiles)
    ) {
      throw new Error("reviewed_output_integration_identity_mismatch");
    }
  }
}
