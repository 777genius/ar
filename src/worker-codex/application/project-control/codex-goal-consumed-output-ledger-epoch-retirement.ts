import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  type ConsumedOutputLedgerEpochPlan,
} from "@vioxen/subscription-runtime/worker-core";
import {
  durablePublishJsonFile,
  DurableJsonPublishStatus,
} from "../../project-control-operation-file-store";

export async function publishConsumedOutputLedgerRetiredMarker(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<void> {
  const path = join(plan.oldRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER);
  const marker = {
    schemaVersion: 1,
    status: "retired" as const,
    successorRoot: plan.newRoot,
    planSha256: plan.planSha256,
  };
  const bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
  const status = await durablePublishJsonFile({ path, value: marker });
  if (status === DurableJsonPublishStatus.AlreadyExists) {
    if (!(await readFile(path)).equals(bytes)) {
      throw new Error("ledger_epoch_retired_marker_conflict");
    }
  }
}

export async function assertConsumedOutputLedgerRetiredMarkerIfPresent(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<void> {
  try {
    await assertConsumedOutputLedgerRetiredMarker(plan);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
}

export async function assertConsumedOutputLedgerRetiredMarker(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<void> {
  const bytes = await readFile(
    join(plan.oldRoot, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER),
  );
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const expected = {
    schemaVersion: 1,
    status: "retired",
    successorRoot: plan.newRoot,
    planSha256: plan.planSha256,
  };
  if (!isRecord(value) || value.schemaVersion !== 1 || value.status !== "retired" ||
    value.successorRoot !== plan.newRoot || value.planSha256 !== plan.planSha256 ||
    !bytes.equals(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`))
  ) throw new Error("ledger_epoch_retired_marker_conflict");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
