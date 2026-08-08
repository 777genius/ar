import type { ProjectAccessScope } from
  "@vioxen/subscription-runtime/worker-core";
import {
  resolveConsumedOutputLedgerEpochReceipt,
  resolvePendingConsumedOutputLedgerEpochPlan,
} from
  "./codex-goal-consumed-output-ledger-epoch";
import {
  readActiveLegacyAttemptQuarantine,
  type ActiveLegacyAttemptQuarantine,
} from "./codex-goal-legacy-attempt-quarantine";
import { readStableLegacyAttemptQuarantine } from
  "./codex-goal-legacy-attempt-quarantine-anchor";

export async function resolveLegacyAttemptQuarantine(input: {
  readonly controllerJobRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly deps?: {
    readonly resolveEpochReceipt?: typeof resolveConsumedOutputLedgerEpochReceipt;
    readonly resolvePendingEpochPlan?: typeof resolvePendingConsumedOutputLedgerEpochPlan;
    readonly readStable?: typeof readStableLegacyAttemptQuarantine;
    readonly readLive?: typeof readActiveLegacyAttemptQuarantine;
  };
}): Promise<ActiveLegacyAttemptQuarantine> {
  const anchored = await resolveEpochAnchoredLegacyAttemptQuarantine(input);
  if (anchored) return anchored;
  const readLive = input.deps?.readLive ?? readActiveLegacyAttemptQuarantine;
  return await readLive(input.controllerJobRootDir);
}

export async function resolveEpochAnchoredLegacyAttemptQuarantine(input: {
  readonly controllerJobRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly deps?: {
    readonly resolveEpochReceipt?: typeof resolveConsumedOutputLedgerEpochReceipt;
    readonly resolvePendingEpochPlan?: typeof resolvePendingConsumedOutputLedgerEpochPlan;
    readonly readStable?: typeof readStableLegacyAttemptQuarantine;
  };
}): Promise<ActiveLegacyAttemptQuarantine | undefined> {
  const resolveEpochReceipt = input.deps?.resolveEpochReceipt ??
    resolveConsumedOutputLedgerEpochReceipt;
  const readStable = input.deps?.readStable ?? readStableLegacyAttemptQuarantine;
  const resolvePendingEpochPlan = input.deps?.resolvePendingEpochPlan ??
    resolvePendingConsumedOutputLedgerEpochPlan;
  const roots = input.scope.consumedOutputLedgerRoots ?? [];
  if (roots.length === 1) {
    try {
      const receipt = await resolveEpochReceipt(roots[0]!);
      if (receipt.legacyAttemptQuarantine) {
        return await readStable(
          input.controllerJobRootDir,
          receipt.legacyAttemptQuarantine,
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const pending = await resolvePendingEpochPlan(roots[0]!, true);
      if (pending?.legacyAttemptQuarantine) {
        return await readStable(
          input.controllerJobRootDir,
          pending.legacyAttemptQuarantine,
        );
      }
    }
  }
  return undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
