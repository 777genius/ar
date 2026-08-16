import { createHash } from "node:crypto";

export type FrozenOutputSupersededSummary = {
  readonly jobId: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly workspacePath: string;
  readonly effectiveOutputPath: string;
  readonly observedResultExists: boolean;
};

export type FrozenOutputImportPlan = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly registryRootDir: string;
  readonly jobIdPrefixes: readonly string[];
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceLength: number;
  readonly sourceManifestPath: string;
  readonly sourceManifestSha256: string;
  readonly destinationEvidenceRoot: string;
  readonly destinationLedgerRoot: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly patchSha256: string;
  readonly retainedRegistrationJobId: string;
  readonly retainedJobRootDir: string;
  readonly retainedManifestPath: string;
  readonly retainedManifestSha256: string;
  readonly retainedOutputPath: string;
  readonly retainedOutputSha256: string;
  readonly authorizedRetainedOutputRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly supersededSummaries: readonly FrozenOutputSupersededSummary[];
};

export type FrozenOutputSourceManifest = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly patch: {
    readonly sha256: string;
    readonly length: number;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly changedPaths: readonly string[];
  };
  readonly retainedOutput: {
    readonly jobId: string;
    readonly manifestSha256: string;
    readonly outputSha256: string;
  };
};

export type FrozenOutputImportReceipt = FrozenOutputImportPlan & {
  readonly planSha256: string;
  readonly importedAt: string;
  readonly custodyOutputPath: string;
  readonly custodySourceManifestPath: string;
  readonly custodyRetainedManifestPath: string;
  readonly custodyRetainedOutputPath: string;
  readonly receiptPath: string;
  readonly ledgerRegistrationPath: string;
};

export function frozenOutputImportPlanSha256(plan: FrozenOutputImportPlan): string {
  const body = `${JSON.stringify(plan)}\n`;
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) {
    throw new Error("frozen_output_import_plan_too_large");
  }
  return createHash("sha256").update(body).digest("hex");
}

export function planFromFrozenOutputReceipt(
  receipt: FrozenOutputImportReceipt,
): FrozenOutputImportPlan {
  const { planSha256: _plan, importedAt: _at, custodyOutputPath: _out,
    custodySourceManifestPath: _manifest, receiptPath: _receipt,
    custodyRetainedManifestPath: _retainedManifest,
    custodyRetainedOutputPath: _retainedOutput,
    ledgerRegistrationPath: _ledger, ...plan } = receipt;
  return plan;
}

export function parseFrozenOutputReceipt(body: string): FrozenOutputImportReceipt {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    throw new Error("frozen_output_import_receipt_invalid", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { planSha256?: unknown }).planSha256 !== "string") {
    throw new Error("frozen_output_import_receipt_invalid");
  }
  const receipt = value as FrozenOutputImportReceipt;
  if (!/^[a-f0-9]{64}$/.test(receipt.planSha256) ||
    !Array.isArray(receipt.changedPaths) ||
    !Array.isArray(receipt.supersededSummaries) ||
    frozenOutputImportPlanSha256(planFromFrozenOutputReceipt(receipt)) !==
      receipt.planSha256) {
    throw new Error("frozen_output_import_receipt_invalid");
  }
  return receipt;
}
