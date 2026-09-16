import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ConsumedOutputLedgerEpochPlan,
  ConsumedOutputLedgerEpochReceipt,
  ConsumedOutputLedgerEpochState,
} from "@vioxen/subscription-runtime/worker-core";
import {
  durablePublishJsonFile,
  DurableJsonPublishStatus,
} from "../../project-control-operation-file-store";
import { isEpochReceipt } from "./codex-goal-consumed-output-ledger-epoch-validation";
import { assertConsumedOutputLedgerRetiredMarker } from
  "./codex-goal-consumed-output-ledger-epoch-retirement";

export const LEDGER_EPOCH_RECEIPT_NAME = "ledger-epoch-receipt.json";

export function ledgerEpochReceiptSha256(
  receipt: ConsumedOutputLedgerEpochReceipt,
): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

export function assertLedgerEpochReceiptMatchesPlan(
  receipt: ConsumedOutputLedgerEpochReceipt,
  plan: ConsumedOutputLedgerEpochPlan,
): void {
  if (
    receipt.controllerJobId !== plan.controllerJobId ||
    receipt.projectId !== plan.projectId || receipt.oldRoot !== plan.oldRoot ||
    receipt.newRoot !== plan.newRoot || receipt.cutoff !== plan.cutoff ||
    receipt.oldRootHash !== plan.oldRootHash ||
    receipt.oldRootFileCount !== plan.oldRootFileCount ||
    receipt.epochNumber !== plan.epochNumber ||
    receipt.genesisOldRootHash !== plan.genesisOldRootHash ||
    receipt.previousEpochPlanSha256 !== plan.previousEpochPlanSha256 ||
    receipt.migratedCount !== plan.migratedCount ||
    receipt.quarantinedCount !== plan.quarantinedCount ||
    receipt.inheritedQuarantinedCount !== plan.inheritedQuarantinedCount ||
    JSON.stringify(receipt.deniedRoots) !== JSON.stringify(plan.deniedRoots) ||
    JSON.stringify(receipt.orphanWorkspaceBindings) !==
      JSON.stringify(plan.orphanWorkspaceBindings) ||
    JSON.stringify(receipt.legacyAttemptQuarantine) !==
      JSON.stringify(plan.legacyAttemptQuarantine) ||
    ((plan.transactionVersion === 2 ||
      receipt.transactionUpgradeSha256 === undefined) &&
      JSON.stringify(receipt.legacyAdmission) !==
        JSON.stringify(plan.legacyAdmission)) ||
    (plan.transactionVersion === 2) !==
      (receipt.transactionUpgradeSha256 === undefined) ||
    receipt.planSha256 !== plan.planSha256 ||
    (plan.planSha256 ===
      "e8d9c821ddf973b11796b2780f2adb1b22760291650998dfb7b0f41ce7c1ea99" &&
      !/^[a-f0-9]{64}$/.test(receipt.proposedAdmissionAnchorSha256 ?? ""))
  ) throw new Error("ledger_epoch_receipt_plan_mismatch");
}

export function ledgerEpochStateReceipt(
  state: ConsumedOutputLedgerEpochState,
  plan: ConsumedOutputLedgerEpochPlan,
): ConsumedOutputLedgerEpochReceipt {
  if (!state.receipt || !state.receiptSha256 ||
    state.receiptSha256 !== ledgerEpochReceiptSha256(state.receipt) ||
    JSON.stringify(state.receipt.admissionBefore) !==
      JSON.stringify(state.admissionBefore)
  ) throw new Error("ledger_epoch_receipt_state_mismatch");
  assertLedgerEpochReceiptMatchesPlan(state.receipt, plan);
  return state.receipt;
}

export async function publishLedgerEpochReceipt(
  root: string,
  receipt: ConsumedOutputLedgerEpochReceipt,
): Promise<void> {
  const path = join(root, LEDGER_EPOCH_RECEIPT_NAME);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const status = await durablePublishJsonFile({ path, value: receipt });
  if (status === DurableJsonPublishStatus.AlreadyExists) {
    if (!(await readFile(path)).equals(bytes)) {
      throw new Error("ledger_epoch_receipt_conflict");
    }
  }
}

export async function readLedgerEpochReceiptTuple(input: {
  readonly root: string;
  readonly state: ConsumedOutputLedgerEpochState;
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly requireRetirementMarker: boolean;
}): Promise<ConsumedOutputLedgerEpochReceipt> {
  const bytes = await readFile(join(resolve(input.root), LEDGER_EPOCH_RECEIPT_NAME));
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isEpochReceipt(value) || resolve(value.newRoot) !== resolve(input.root) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
  ) throw new Error("ledger_epoch_receipt_invalid");
  assertLedgerEpochReceiptMatchesPlan(value, input.plan);
  if (input.state.phase !== "active" ||
    input.state.receiptSha256 !== ledgerEpochReceiptSha256(value) ||
    JSON.stringify(input.state.receipt) !== JSON.stringify(value)
  ) throw new Error("ledger_epoch_receipt_state_mismatch");
  if (input.requireRetirementMarker) {
    await assertConsumedOutputLedgerRetiredMarker(input.plan);
  }
  return value;
}
