import { join, relative, resolve, sep } from "node:path";
import {
  ProjectDebtReason,
  summarizeProjectAdmissionDebt,
  type ConsumedOutputLedgerEpochAdmissionSummary,
  type ProjectAccessScope,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import {
  buildCodexProjectAdmissionSnapshot,
  type CodexProjectAdmissionDeps,
} from "./codex-goal-project-admission";
import { canonicalConsumedOutputLedgerRoot } from
  "./codex-goal-consumed-output-ledger-epoch";
import {
  normalizeAnchoredProposedAdmission,
  type LedgerEpochProposedAdmissionAnchor,
} from "./codex-goal-ledger-epoch-proposed-admission";

export type LedgerEpochAdmissionSnapshotBuilder = (input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly controllerJobId: string;
  readonly allowPendingEpochOrphanQuarantine?: boolean;
  readonly skipActiveProposedAdmissionNormalization?: boolean;
}) => Promise<ProjectAdmissionSnapshot>;

export async function ledgerEpochAdmissionSummary(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly controllerJobId: string;
  readonly deps: CodexProjectAdmissionDeps;
  readonly snapshotBuilder?: LedgerEpochAdmissionSnapshotBuilder | undefined;
  readonly rejectBlocking?: boolean;
  readonly allowPendingEpochOrphanQuarantine?: boolean | undefined;
  readonly proposedAdmissionAnchor?: LedgerEpochProposedAdmissionAnchor;
  readonly revalidateBeforeNormalization?: (
    snapshot: ProjectAdmissionSnapshot,
  ) => Promise<void>;
  readonly unpublishedLedgerRoot?: string;
}): Promise<ConsumedOutputLedgerEpochAdmissionSummary> {
  let snapshot = await buildRawLedgerEpochAdmissionSnapshot({
    registryRootDir: input.registryRootDir,
    scope: input.scope,
    controllerJobId: input.controllerJobId,
    admissionDeps: input.deps,
    snapshotBuilder: input.snapshotBuilder,
    allowPendingEpochOrphanQuarantine: input.allowPendingEpochOrphanQuarantine,
  });
  if (input.proposedAdmissionAnchor) {
    await input.revalidateBeforeNormalization?.(snapshot);
    snapshot = normalizeAnchoredProposedAdmission({
      anchor: input.proposedAdmissionAnchor,
      snapshot,
    });
  }
  if (input.unpublishedLedgerRoot) {
    snapshot = withoutCurrentUnpublishedLedgerDebt(
      snapshot,
      input.unpublishedLedgerRoot,
    );
  }
  if (input.rejectBlocking && snapshot.debt.some((item) =>
    item.severity !== "info" && item.severity !== "warning"
  )) throw new Error("ledger_epoch_proposed_admission_blocked");
  return {
    debtCount: snapshot.debt.length,
    counts: snapshot.counts ?? summarizeProjectAdmissionDebt(snapshot.debt).counts,
  };
}

function withoutCurrentUnpublishedLedgerDebt(
  snapshot: ProjectAdmissionSnapshot,
  ledgerRoot: string,
): ProjectAdmissionSnapshot {
  const expectedSubject = resolve(join(ledgerRoot, "items"));
  const expectedEvidence =
    `consumed output ledger unreadable: ENOENT: no such file or directory, scandir '${expectedSubject}'`;
  const debt = snapshot.debt.filter((item) => !(
    item.reason === ProjectDebtReason.UnreadableRoot &&
    resolve(item.subject) === expectedSubject &&
    item.severity === "blocking" &&
    item.evidence.length === 1 &&
    item.evidence[0] === expectedEvidence
  ));
  if (debt.length === snapshot.debt.length) return snapshot;
  return {
    ...snapshot,
    debt,
    counts: summarizeProjectAdmissionDebt(debt).counts,
  };
}

export async function buildRawLedgerEpochAdmissionSnapshot(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly controllerJobId: string;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly snapshotBuilder?: LedgerEpochAdmissionSnapshotBuilder | undefined;
  readonly allowPendingEpochOrphanQuarantine?: boolean | undefined;
}): Promise<ProjectAdmissionSnapshot> {
  const common = {
    registryRootDir: input.registryRootDir,
    scope: input.scope,
    controllerJobId: input.controllerJobId,
    ...(input.allowPendingEpochOrphanQuarantine === undefined ? {} : {
      allowPendingEpochOrphanQuarantine: input.allowPendingEpochOrphanQuarantine,
    }),
    skipActiveProposedAdmissionNormalization: true,
  };
  return input.snapshotBuilder
    ? await input.snapshotBuilder(common)
    : await buildCodexProjectAdmissionSnapshot({
        ...common,
        deps: input.admissionDeps,
      });
}

export async function assertCanonicalLedgerRootsAllowed(
  scope: ProjectAccessScope,
  oldRoot: string,
  newRoot: string,
): Promise<void> {
  const allowed = await Promise.all([
    ...(scope.readRoots ?? []), ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []), ...(scope.observedWorkspaceRoots ?? []),
    ...(scope.registryRoot ? [scope.registryRoot] : []),
  ].map(async (root) => await canonicalConsumedOutputLedgerRoot(root, true)));
  const denied = await Promise.all((scope.deniedRoots ?? []).map(
    async (root) => await canonicalConsumedOutputLedgerRoot(root, false),
  ));
  if (!allowed.some((root) => pathInside(oldRoot, root)) ||
    !allowed.some((root) => pathInside(newRoot, root)) ||
    denied.some((root) => pathInside(oldRoot, root) ||
      pathInside(newRoot, root) || pathInside(root, oldRoot) ||
      pathInside(root, newRoot))) {
    throw new Error("ledger_epoch_root_outside_canonical_scope");
  }
}

function pathInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}
