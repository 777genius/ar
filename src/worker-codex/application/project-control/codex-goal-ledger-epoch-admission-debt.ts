import { join } from "node:path";
import {
  type ConsumedOutputLedger,
  ProjectDebtReason,
  type ConsumedOutputLedgerEpochPlan,
  type ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  type ConsumedOutputLedgerEpochReceipt,
  type ProjectAccessScope,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalConsumedOutputLedgers } from "./codex-goal-consumed-output-ledger-io";
import { resolveConsumedOutputMaintenanceLedgerRoot } from "./codex-goal-consumed-output-ledger-epoch";

export async function readLedgerEpochAdmissionState(input: {
  readonly scope: ProjectAccessScope;
  readonly allowPendingOrphanQuarantine?: boolean;
}): Promise<{
  readonly consumedOutput: ConsumedOutputLedger;
  readonly quarantineDebt: readonly ProjectDebtItem[];
  readonly orphanWorkspaceBindings:
    readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
}> {
  const configured = input.scope.consumedOutputLedgerRoots ?? [];
  const active = configured.length === 1
    ? await resolveConsumedOutputMaintenanceLedgerRoot(input.scope)
    : undefined;
  return {
    consumedOutput: await readCodexGoalConsumedOutputLedgers({
      roots: active ? [active.ledgerRoot] : configured,
      evidenceRoots: input.scope.consumedOutputEvidenceRoots ?? configured,
    }),
    quarantineDebt: ledgerEpochQuarantineDebt(
      active?.epochReceipt ?? active?.pendingEpochPlan,
    ),
    orphanWorkspaceBindings: active?.epochReceipt?.orphanWorkspaceBindings ??
      (input.allowPendingOrphanQuarantine
        ? active?.pendingEpochPlan?.orphanWorkspaceBindings ?? []
        : []),
  };
}

export function ledgerEpochQuarantineDebt(
  receipt: ConsumedOutputLedgerEpochReceipt | ConsumedOutputLedgerEpochPlan | undefined,
): readonly ProjectDebtItem[] {
  if (!receipt) return [];
  const total = receipt.inheritedQuarantinedCount + receipt.quarantinedCount;
  return Array.from({ length: total }, (_, index) => ({
    reason: ProjectDebtReason.LegacyOutputQuarantineRequired,
    subject: join(receipt.newRoot, "quarantine", String(index)),
    severity: "info" as const,
    evidence: [
      `immutable ledger epoch ${receipt.epochNumber}`,
      `plan sha256 ${receipt.planSha256}`,
      `cutoff ${receipt.cutoff}`,
      `quarantined ${receipt.quarantinedCount}`,
      `inherited quarantined ${receipt.inheritedQuarantinedCount}`,
      "record remains invalid and unrepaired",
    ],
  }));
}
