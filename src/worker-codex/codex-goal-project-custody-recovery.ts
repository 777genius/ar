import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  ProjectControlRecoveryAuditPhase,
  ProjectControlRecoveryOperation,
  ProjectControlRecoveryOutcome,
  ProjectControlRecoveryPhase,
  type ProjectControlCustodyBootstrapCertification,
  type ProjectControlEvidenceCustodyPort,
  type ProjectControlRecoveryRecord,
  type ProjectControlRecoveryStore,
  type ProjectControlRecoveryDirectories,
  type ProjectControlRecoveryDirectoryIdentity,
} from "@vioxen/subscription-runtime/worker-core";
import {
  resolveInitialProjectControlCustodyPlan, parseCodexGoalJobManifest,
  type CodexGoalJobManifest,
} from "./codex-goal-jobs";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";

export enum ScopeRecoveryFaultPoint {
  AfterPrepared = "after_prepared",
  AfterMaterialization = "after_materialization",
  AfterMaterializedRecord = "after_materialized_record",
  AfterManifestPublication = "after_manifest_publication",
  AfterAppliedAudit = "after_applied_audit",
}

export function recoveryHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function configuredProjectControlCustodyDirectories(scope: ProjectAccessScope): readonly string[] {
  return [
    ...(scope.consumedOutputLedgerRoots ?? []).flatMap(root => [root, join(root, "items")]),
    ...(scope.consumedOutputEvidenceRoots ?? []),
  ];
}

/** Existing configured custody is state, never an implicit bootstrap request. */
export async function assertConfiguredProjectControlCustodyItemsPresent(
  scope: ProjectAccessScope,
  custody: ProjectControlEvidenceCustodyPort,
): Promise<void> {
  for (const path of configuredProjectControlCustodyDirectories(scope)) {
    if (await custody.pathKind(path) !== "directory" ||
        await custody.canonicalDirectory(path) !== path) {
      throw new Error("project_control_custody_missing_or_unsafe_state");
    }
  }
}

/** Invoked only under the controller lock, after confirmation and all repair validations. */
export async function applyConfirmedControllerScopeRecovery(input: {
  readonly confirmed: boolean;
  readonly controller: CodexGoalJobManifest;
  readonly proposed: ProjectAccessScope;
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly store: ProjectControlRecoveryStore;
  readonly directories: ProjectControlRecoveryDirectories;
  /** Configured custody pinned before the native locked reload and store opening. */
  readonly configuredIdentities?: readonly ProjectControlRecoveryDirectoryIdentity[];
  readonly publish: (at: Date, revalidate: () => Promise<void>) => Promise<CodexGoalJobManifest>;
  /** Syncs the expected manifest inode and its registry parent before commit. */
  readonly confirmManifestDurability: () => Promise<void>;
  readonly fault?: (point: ScopeRecoveryFaultPoint) => Promise<void>;
}): Promise<{
  readonly outcome: ProjectControlRecoveryOutcome;
  readonly operationId: string;
  readonly manifest?: CodexGoalJobManifest;
}> {
  if (!input.confirmed) throw new Error("confirm_update_required");
  const scope = input.controller.projectAccessScope;
  if (!scope) throw new Error("project_control_controller_scope_required");
  const configuredPaths = configuredProjectControlCustodyDirectories(scope);
  let plan = await resolveInitialProjectControlCustodyPlan(
    { ...input.controller, projectAccessScope: input.proposed }, input.custody);
  let proposedPaths = plan ? input.directories.paths({ ...plan, anchor: plan.approvedAnchor }) : [];
  const existingPlan = await resolveInitialProjectControlCustodyPlan(input.controller, input.custody);
  const existingPaths = existingPlan
    ? input.directories.paths({ ...existingPlan, anchor: existingPlan.approvedAnchor }) : [];
  const records = await input.store.records();
  const latest = records.at(-1);
  const beforeHash = recoveryHash(input.controller);
  const proposedHash = recoveryHash(input.proposed);
  let record: ProjectControlRecoveryRecord;
  if (latest && (latest.phase !== ProjectControlRecoveryPhase.Committed ||
      (latest.afterManifestSha256 === beforeHash && latest.proposedScopeSha256 === proposedHash))) {
    if (latest.controllerJobId !== input.controller.jobId || latest.proposedScopeSha256 !== proposedHash ||
        (latest.beforeManifestSha256 !== beforeHash && latest.afterManifestSha256 !== beforeHash)) {
      throw new Error("project_control_recovery_pending_conflict");
    }
    record = latest;
    if (record.approvedAnchor && plan) {
      plan = { ...plan, approvedAnchor: record.approvedAnchor };
      proposedPaths = input.directories.paths({ ...plan, anchor: plan.approvedAnchor });
    }
  } else {
    // Pin at the first safe observation, before later checks can lose custody.
    const configuredIdentities = input.configuredIdentities ?? await input.directories.identities(configuredPaths);
    if (configuredPaths.some(path => !configuredIdentities.some(identity => identity.path === path))) {
      throw new Error("project_control_recovery_journal_incomplete_identities");
    }
    // A missing ledger/items or evidence root is loss/unknown history.
    await assertConfiguredProjectControlCustodyItemsPresent(scope, input.custody);
    for (const root of input.proposed.consumedOutputLedgerRoots ?? []) {
      if (!(scope.consumedOutputLedgerRoots ?? []).includes(root) && await input.custody.pathKind(join(root, "items")) === "absent" &&
          await input.custody.pathKind(root) === "directory" && (await input.custody.listDirectory(root)).length > 0) {
        throw new Error("project_control_custody_missing_or_unsafe_state");
      }
    }
    const knownPaths: string[] = [];
    for (const path of existingPaths) {
      const kind = await input.custody.pathKind(path);
      if (kind === "directory") knownPaths.push(path);
      else if (kind !== "absent") throw new Error("project_control_custody_recovery_items_unsafe");
    }
    for (const path of proposedPaths) {
      const kind = await input.custody.pathKind(path);
      if (kind === "directory") knownPaths.push(path);
      else if (kind !== "absent") throw new Error("project_control_custody_recovery_items_unsafe");
    }
    for (const root of input.proposed.consumedOutputLedgerRoots ?? []) {
      if (!(scope.consumedOutputLedgerRoots ?? []).includes(root) &&
          await input.custody.pathKind(join(root, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER)) !== "absent") {
        throw new Error("project_control_custody_recovery_retired_ledger");
      }
    }
    const at = new Date().toISOString();
    const target = parseCodexGoalJobManifest({ ...input.controller,
      projectAccessScope: input.proposed, updatedAt: at });
    record = {
      operationId: randomUUID(), operation: ProjectControlRecoveryOperation.ControllerScope,
      phase: ProjectControlRecoveryPhase.Prepared, controllerJobId: input.controller.jobId,
      beforeManifestSha256: beforeHash, afterManifestSha256: recoveryHash(target),
      proposedScopeSha256: proposedHash, at,
      ...(plan ? { approvedAnchor: plan.approvedAnchor } : {}),
      identities: [...configuredIdentities, ...await input.directories.identities(
        knownPaths.filter(path => !configuredPaths.includes(path)))],
    };
    await input.directories.revalidate(record.identities);
    try { await input.store.save(record); }
    catch {
      return { outcome: ProjectControlRecoveryOutcome.PartialSuccess, operationId: record.operationId };
    }
  }
  let certification: ProjectControlCustodyBootstrapCertification | undefined;
  try {
    const revalidate = async () => {
      if (configuredPaths.some(path => !record.identities.some(identity => identity.path === path)) ||
          (record.phase !== ProjectControlRecoveryPhase.Prepared &&
           proposedPaths.some(path => !record.identities.some(identity => identity.path === path)))) {
        throw new Error("project_control_recovery_journal_incomplete_identities");
      }
      await input.store.revalidate();
      if (input.configuredIdentities) await input.directories.revalidate(input.configuredIdentities);
      await input.directories.revalidate(record.identities);
      await certification?.revalidate();
      await input.store.revalidate();
    };
    await revalidate();
    // Only known inodes or a write-ahead directory publication may be resumed.
    // An unrecorded final path is always an external/ambiguous substitution.
    if (record.phase === ProjectControlRecoveryPhase.Prepared) {
      const recorded = new Set(record.identities.map(identity => identity.path));
      for (const path of proposedPaths) {
        if (!recorded.has(path) && record.pendingDirectory?.path !== path &&
            await input.custody.pathKind(path) !== "absent") {
          throw new Error("project_control_recovery_unrecorded_directory_identity");
        }
      }
    }
    await input.store.audit(record, ProjectControlRecoveryAuditPhase.Requested);
    await input.fault?.(ScopeRecoveryFaultPoint.AfterPrepared);
    let manifest = input.controller;
    if (beforeHash !== record.afterManifestSha256) {
      if (record.phase === ProjectControlRecoveryPhase.Committed) {
        throw new Error("project_control_recovery_committed_manifest_lost");
      }
      await revalidate();
      if (record.pendingDirectory && (!proposedPaths.includes(record.pendingDirectory.path) ||
          record.phase !== ProjectControlRecoveryPhase.Prepared)) {
        throw new Error("project_control_recovery_journal_inconsistent");
      }
      certification = plan ? await input.custody.materializeApprovedProjectControlCustody({
        ...plan,
        recovery: {
          operationId: record.operationId,
          get identities() { return record.identities; },
          ...(record.pendingDirectory ? { pendingDirectory: record.pendingDirectory } : {}),
          revalidate,
          prepare: async pendingDirectory => {
            if (record.pendingDirectory) throw new Error("project_control_recovery_journal_inconsistent");
            const next = { ...record, pendingDirectory };
            await input.store.save(next);
            record = next;
          },
          applied: async identity => {
            if (record.pendingDirectory?.path !== identity.path ||
                record.pendingDirectory.device !== identity.device || record.pendingDirectory.inode !== identity.inode) {
              throw new Error("project_control_recovery_journal_inconsistent");
            }
            const { pendingDirectory: _, ...previous } = record;
            const next = { ...previous, identities: [...record.identities, identity] };
            await input.store.save(next);
            record = next;
          },
        },
      }) : undefined;
      await revalidate();
      // Persist the complete post-materialization identity set before the
      // crash boundary. A retry can then distinguish our durable creations
      // from an unrecorded substitution and safely converge.
      // Keep the original pins and write-ahead creations; never adopt new inodes.
      record = { ...record, phase: ProjectControlRecoveryPhase.Materialized };
      await revalidate();
      await input.store.save(record);
      await input.fault?.(ScopeRecoveryFaultPoint.AfterMaterialization);
      await revalidate();
      await input.fault?.(ScopeRecoveryFaultPoint.AfterMaterializedRecord);
      await revalidate();
      manifest = await input.publish(new Date(record.at), revalidate);
      if (recoveryHash(manifest) !== record.afterManifestSha256) {
        throw new Error("project_control_recovery_manifest_identity_drift");
      }
      await input.fault?.(ScopeRecoveryFaultPoint.AfterManifestPublication);
    } else if (record.phase === ProjectControlRecoveryPhase.Prepared) {
      // Publication is forbidden until the materialization checkpoint is durable.
      throw new Error("project_control_recovery_journal_inconsistent");
    }
    await revalidate();
    await input.confirmManifestDurability();
    await revalidate();
    await input.store.audit(record, ProjectControlRecoveryAuditPhase.Applied);
    await input.fault?.(ScopeRecoveryFaultPoint.AfterAppliedAudit);
    await revalidate();
    if (record.phase !== ProjectControlRecoveryPhase.Committed) {
      await input.store.save({ ...record, phase: ProjectControlRecoveryPhase.Committed });
    }
    await revalidate();
    return { outcome: ProjectControlRecoveryOutcome.Committed, operationId: record.operationId, manifest };
  } catch {
    // The durable intent remains authoritative. A confirmed retry reconciles it;
    // neither an extant directory nor an updated manifest counts as final success.
    return { outcome: ProjectControlRecoveryOutcome.PartialSuccess, operationId: record.operationId };
  } finally { await certification?.close(); }
}
