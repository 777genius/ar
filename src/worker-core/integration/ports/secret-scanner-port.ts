import type { SecretScanStatus } from "../domain/integration-attempt";

export type SecretScanResult = {
  readonly status: SecretScanStatus;
  readonly scannedReviewedTree?: string;
  readonly scannedReviewedParent?: string;
  readonly safeMessage?: string;
};

export interface SecretScannerPort {
  scanFiles(input: {
    readonly workspacePath: string;
    /** Scan immutable candidate blobs instead of mutable worktree files. */
    readonly reviewedTree?: string;
    readonly reviewedParent?: string;
    readonly reviewedOutputFileByteAllowance?: number;
    readonly files: readonly string[];
  }): Promise<SecretScanResult> | SecretScanResult;
}

/** Revalidates persisted review authority before using an exceptional byte bound. */
export interface ReviewedOutputIntegrityPort {
  verify(attempt: import("../domain/integration-attempt").IntegrationAttempt): Promise<void>;
}
