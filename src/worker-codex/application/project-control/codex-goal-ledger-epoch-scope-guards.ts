import type { ProjectAccessScope } from
  "@vioxen/subscription-runtime/worker-core";
import { canonicalConsumedOutputLedgerRoot } from
  "./codex-goal-consumed-output-ledger-epoch";

export async function assertControllerLedgerRootState(
  scope: ProjectAccessScope,
  oldRoot: string,
  newRoot: string,
): Promise<void> {
  const roots = await Promise.all((scope.consumedOutputLedgerRoots ?? []).map(
    async (root) => await canonicalConsumedOutputLedgerRoot(root, true),
  ));
  if (roots.length !== 1 || (roots[0] !== oldRoot && roots[0] !== newRoot)) {
    throw new Error("ledger_epoch_controller_scope_drift");
  }
}

export async function assertPreparedStateForActiveRoot(
  scope: ProjectAccessScope,
  newRoot: string,
  hasPersistedPlan: boolean,
): Promise<void> {
  const configured = scope.consumedOutputLedgerRoots ?? [];
  if (configured.length !== 1) {
    throw new Error("ledger_epoch_controller_scope_drift");
  }
  const active = await canonicalConsumedOutputLedgerRoot(configured[0]!, true);
  if (active === newRoot && !hasPersistedPlan) {
    throw new Error("ledger_epoch_prepared_state_required");
  }
}
