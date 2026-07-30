import { ReviewDecisionStatus } from "@vioxen/subscription-runtime/worker-core";
import type {
  ReviewedWorkerOutputReviewAttestation,
  ReviewedWorkerOutputSnapshot,
  ReviewedWorkerOutputWorkspaceSnapshot,
} from "../domain/reviewed-worker-output";

export interface ReviewedWorkerOutputSnapshotterPort {
  capture(input: {
    readonly workspacePath: string;
    readonly allowEmptyPatch?: boolean;
    readonly rejectedCaptureBinding?: {
      readonly decision: ReviewDecisionStatus.Rejected;
      readonly expectedPatchSha256: string;
    };
  }): Promise<ReviewedWorkerOutputWorkspaceSnapshot>;
}

export interface ReviewedWorkerOutputStorePort {
  create(input: {
    readonly snapshot: Omit<ReviewedWorkerOutputSnapshot, "patchPath">;
    readonly patch: string;
  }): Promise<ReviewedWorkerOutputSnapshot>;

  commitReviewAttestation(input: {
    readonly attestation: ReviewedWorkerOutputReviewAttestation;
    readonly reviewMarkerContent: string;
  }): Promise<void>;

  get(reviewedOutputId: string): Promise<ReviewedWorkerOutputSnapshot | undefined>;
}

export interface ReviewedWorkerOutputReviewMarkerVerifierPort {
  verify(input: {
    readonly markerPath: string;
    readonly snapshot: ReviewedWorkerOutputSnapshot;
  }): Promise<{
    readonly markerSha256: string;
    readonly markerContent: string;
  }>;
}

export interface ReviewedWorkerContinuationEnvironmentPort {
  sanitizeDependencyRootLinks(input: {
    readonly workspacePath: string;
  }): Promise<{ readonly removedPaths: readonly string[] }>;

  assertDependencyRootsSafe(input: {
    readonly workspacePath: string;
  }): Promise<void>;
}
