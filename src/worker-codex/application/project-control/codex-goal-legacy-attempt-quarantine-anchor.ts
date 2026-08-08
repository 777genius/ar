import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type {
  ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor,
} from "@vioxen/subscription-runtime/worker-core";
import {
  legacyAttemptQuarantineRoot,
  loadLegacyAttemptQuarantinePlan,
  readActiveLegacyAttemptQuarantine,
  validateLegacyAttemptQuarantineReceiptImmutable,
  type ActiveLegacyAttemptQuarantine,
  type LegacyAttemptQuarantineReceipt,
} from "./codex-goal-legacy-attempt-quarantine";
import { legacyAttemptQuarantineDispositionCounts } from
  "./codex-goal-legacy-attempt-quarantine-policy";
import {
  legacyAttemptQuarantineActivePlanPath,
  resolveLegacyAttemptQuarantineSingleUsePlan,
} from
  "./codex-goal-legacy-attempt-quarantine-single-use";

const MAX_ANCHORED_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ANCHORED_ROOT_BYTES = 96 * 1024 * 1024;

export async function buildLiveLegacyAttemptQuarantineEpochAnchor(
  controllerJobRootDir: string,
): Promise<ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor | undefined> {
  const claimedPlanSha256 = await resolveLegacyAttemptQuarantineSingleUsePlan({
    controllerJobRootDir,
    epochPlanSha256s: [],
  });
  const active = await readActiveLegacyAttemptQuarantine(controllerJobRootDir);
  if (active.debt.length === 0) {
    if (claimedPlanSha256) {
      throw new Error("legacy_attempt_quarantine_pending_claim_blocks_epoch");
    }
    return undefined;
  }
  const planShas = [...new Set(active.debt.map((item) => item.planSha256))];
  if (planShas.length !== 1 || claimedPlanSha256 !== planShas[0]) {
    throw new Error("legacy_attempt_quarantine_epoch_requires_single_plan");
  }
  return await anchorForPlan(controllerJobRootDir, planShas[0]!);
}

export async function readStableLegacyAttemptQuarantine(
  controllerJobRootDir: string,
  expected: ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor,
): Promise<ActiveLegacyAttemptQuarantine> {
  const actual = await anchorForPlan(controllerJobRootDir, expected.planSha256);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("legacy_attempt_quarantine_epoch_anchor_drift");
  }
  const plan = await loadLegacyAttemptQuarantinePlan({
    controllerJobRootDir,
    expectedPlanSha256: expected.planSha256,
  });
  return activeFromPlan(plan);
}

async function anchorForPlan(
  controllerJobRootDir: string,
  planSha256: string,
): Promise<ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor> {
  const root = legacyAttemptQuarantineRoot(controllerJobRootDir);
  const plan = await loadLegacyAttemptQuarantinePlan({
    controllerJobRootDir,
    expectedPlanSha256: planSha256,
  });
  const receiptPath = join(root, "receipts", `${planSha256}.json`);
  const receiptBytes = await boundedRead(receiptPath);
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as
    LegacyAttemptQuarantineReceipt;
  await validateLegacyAttemptQuarantineReceiptImmutable(plan, receipt);
  const paths = [
    legacyAttemptQuarantineActivePlanPath(plan.controllerJobRootDir),
    join(root, "plans", `${planSha256}.json`),
    receiptPath,
    ...receipt.entries.map((entry) => entry.preservationPath),
  ].sort();
  const bindings: Array<{
    readonly relativePath: string;
    readonly size: number;
    readonly sha256: string;
  }> = [];
  let aggregate = 0;
  for (const path of paths) {
    const bytes = await boundedRead(path);
    aggregate += bytes.length;
    if (aggregate > MAX_ANCHORED_ROOT_BYTES) {
      throw new Error("legacy_attempt_quarantine_anchor_too_large");
    }
    bindings.push({
      relativePath: relative(root, resolve(path)),
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const counts = legacyAttemptQuarantineDispositionCounts(
    plan.entries.map((entry) => entry.reconciliation),
  );
  return {
    schemaVersion: 1,
    planSha256,
    quarantineRootSha256: sha256Json(bindings),
    receiptSha256: sha256(receiptBytes),
    ...counts,
  };
}

function activeFromPlan(
  plan: Awaited<ReturnType<typeof loadLegacyAttemptQuarantinePlan>>,
): ActiveLegacyAttemptQuarantine {
  return {
    attemptIds: new Set(plan.entries.map((entry) => entry.attemptId)),
    debt: plan.entries.map((entry) => ({
      attemptId: entry.attemptId,
      status: entry.status,
      disposition: entry.disposition,
      ...(entry.refusalReason ? { refusalReason: entry.refusalReason } : {}),
      planSha256: plan.planSha256,
    })),
  };
}

async function boundedRead(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_ANCHORED_ARTIFACT_BYTES) {
    throw new Error("legacy_attempt_quarantine_anchor_artifact_too_large");
  }
  return bytes;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value)));
}
