import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  acquireLocalControllerMaintenanceFence,
  releaseLocalControllerMaintenanceFence,
} from "@vioxen/subscription-runtime/store-local-file";
import {
  durablePublishJsonFile,
  durableReplaceJsonFile,
} from "../../project-control-operation-file-store";
import { codexGoalJobManifestPath } from "../../codex-goal-jobs";
import {
  buildStaleIntegrationReconciliationPlan,
  loadStaleIntegrationReconciliationPlan,
  type StaleIntegrationReconciliationEntry,
} from "./codex-goal-stale-integration-reconciliation";
import type { LegacyAttemptProcessEvidence } from
  "./codex-goal-legacy-attempt-process-evidence";

const execFileAsync = promisify(execFile);

export type LegacyAttemptPathBinding = {
  readonly declaredPath: string;
  readonly state: "present" | "missing";
  readonly canonicalPath?: string;
  readonly device?: number;
  readonly inode?: number;
  readonly mode?: number;
  readonly size?: number;
  readonly sha256?: string;
};

export type LegacyAttemptQuarantineEntry = {
  readonly attemptId: string;
  readonly attemptPath: string;
  readonly attemptSha256: string;
  readonly originalAttemptBase64: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly disposition:
    | "reconciliation_evidence_bound"
    | "unresolved_evidence_quarantine";
  readonly refusalReason?: string;
  readonly priorRejectOutcome: "failed_without_terminalization";
  readonly events: LegacyAttemptPathBinding;
  readonly originalEventsBase64?: string;
  readonly sourceWorkspace: LegacyAttemptPathBinding;
  readonly targetWorkspace: LegacyAttemptPathBinding;
  readonly targetGit: LegacyAttemptTargetGitBinding;
  readonly workerManifest: LegacyAttemptPathBinding;
  readonly reconciliation: StaleIntegrationReconciliationEntry;
};

export type LegacyAttemptTargetGitBinding = {
  readonly state: "observed" | "workspace_missing";
  readonly head?: string;
  readonly statusBase64?: string;
  readonly statusSha256?: string;
  readonly remoteName?: string;
  readonly remoteUrlBase64?: string;
  readonly remoteUrlSha256?: string;
};

export type LegacyAttemptQuarantinePlan = {
  readonly schemaVersion: 1;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly controllerManifestSha256: string;
  readonly controllerScopeEpochSha256: string;
  readonly registryJobCount: number;
  readonly registryJobIdsSha256: string;
  readonly sourceStaleIntegrationPlanSha256: string;
  readonly cutoff: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
  readonly controllerManifest: LegacyAttemptPathBinding;
  readonly entries: readonly LegacyAttemptQuarantineEntry[];
  readonly processEvidence: LegacyAttemptProcessEvidence;
  readonly planSha256: string;
};

type LegacyAttemptQuarantineProgress = {
  readonly schemaVersion: 1;
  readonly planSha256: string;
  readonly completedAttemptIds: readonly string[];
};

export type LegacyAttemptQuarantineReceipt = {
  readonly schemaVersion: 1;
  readonly status: "active_quarantine";
  readonly planSha256: string;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly sourceMutation: false;
  readonly lifecycleTerminalized: false;
  readonly rollbackClaimed: false;
  readonly ledgerConsumptionClaimed: false;
  readonly terminalForLedgerEpochOnly: true;
  readonly processEvidence: LegacyAttemptProcessEvidence;
  readonly entries: readonly {
    readonly attemptId: string;
    readonly attemptSha256: string;
    readonly preservationPath: string;
    readonly preservationSha256: string;
  }[];
  readonly completedAt: string;
};

export type ActiveLegacyAttemptQuarantine = {
  readonly attemptIds: ReadonlySet<string>;
  readonly debt: readonly {
    readonly attemptId: string;
    readonly status: string;
    readonly disposition: string;
    readonly refusalReason?: string;
    readonly planSha256: string;
  }[];
};

type ScopeInput = {
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly controllerManifestSha256: string;
  readonly controllerScopeEpochSha256: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
};

export async function previewLegacyAttemptQuarantinePlan(input: ScopeInput & {
  readonly sourceStaleIntegrationPlanSha256: string;
  readonly cutoff: string;
  readonly captureProcessEvidence: (
    custodyPaths: readonly string[],
  ) => Promise<LegacyAttemptProcessEvidence>;
}): Promise<LegacyAttemptQuarantinePlan> {
  const reconciliation = await loadStaleIntegrationReconciliationPlan({
    controllerJobRootDir: input.controllerJobRootDir,
    expectedPlanSha256: input.sourceStaleIntegrationPlanSha256,
  });
  assertSourcePlanScope(reconciliation, input);
  if (!Number.isFinite(Date.parse(input.cutoff)) || reconciliation.entries.length === 0 ||
    reconciliation.entries.length > 64) {
    throw new Error("legacy_attempt_quarantine_source_plan_invalid");
  }
  const cutoff = new Date(Date.parse(input.cutoff)).toISOString();
  const entries: LegacyAttemptQuarantineEntry[] = [];
  for (const reconciled of reconciliation.entries) {
    const attemptId = reconciled.attemptId;
    const bytes = await readBoundFile(reconciled.attemptPath);
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.updatedAt !== "string" ||
      Date.parse(parsed.updatedAt) > Date.parse(cutoff)) {
      throw new Error("legacy_attempt_quarantine_attempt_newer_than_cutoff");
    }
    const events = await bindPath(
      join(dirname(reconciled.attemptPath), "events.jsonl"),
      true,
    );
    const originalEventsBase64 = events.state === "present"
      ? (await readBoundFile(events.declaredPath)).toString("base64")
      : undefined;
    const targetWorkspace = await bindPath(reconciled.targetWorkspacePath, false);
    entries.push({
      attemptId,
      attemptPath: reconciled.attemptPath,
      attemptSha256: sha256(bytes),
      originalAttemptBase64: bytes.toString("base64"),
      status: reconciled.status,
      updatedAt: parsed.updatedAt,
      disposition: reconciled.eligible
        ? "reconciliation_evidence_bound"
        : "unresolved_evidence_quarantine",
      ...(reconciled.refusalReason
        ? { refusalReason: reconciled.refusalReason }
        : {}),
      priorRejectOutcome: "failed_without_terminalization",
      events,
      ...(originalEventsBase64 ? { originalEventsBase64 } : {}),
      sourceWorkspace: await bindPath(String(parsed.sourceWorkspacePath), false),
      targetWorkspace,
      targetGit: await bindTargetGit({
        gitBinaryPath: reconciliation.gitBinaryPath,
        workspace: targetWorkspace,
        remoteName: reconciled.targetRemote,
      }),
      workerManifest: await bindPath(codexGoalJobManifestPath({
        registryRootDir: input.registryRootDir,
        jobId: String(parsed.workerJobId),
      }), true),
      reconciliation: reconciled,
    });
  }
  const controllerManifest = await bindPath(codexGoalJobManifestPath({
    registryRootDir: input.registryRootDir,
    jobId: input.controllerJobId,
  }), true);
  if (controllerManifest.state !== "present") {
    throw new Error("legacy_attempt_quarantine_controller_manifest_cas_mismatch");
  }
  const registry = await registrySnapshot(input.registryRootDir);
  const custodyPaths = exactPaths(entries.flatMap((entry) => [
    entry.sourceWorkspace.declaredPath,
    entry.targetWorkspace.declaredPath,
  ]));
  const processEvidence = await input.captureProcessEvidence(custodyPaths);
  assertProcessEvidence(processEvidence, custodyPaths);
  const unsigned = {
    schemaVersion: 1 as const,
    controllerJobId: input.controllerJobId,
    projectId: input.projectId,
    registryRootDir: resolve(input.registryRootDir),
    controllerJobRootDir: resolve(input.controllerJobRootDir),
    controllerManifestSha256: input.controllerManifestSha256,
    controllerScopeEpochSha256: input.controllerScopeEpochSha256,
    registryJobCount: registry.count,
    registryJobIdsSha256: registry.sha256,
    sourceStaleIntegrationPlanSha256: reconciliation.planSha256,
    cutoff,
    targetWorkspaceRoots: exactPaths(input.targetWorkspaceRoots),
    deniedRoots: exactPaths(input.deniedRoots ?? []),
    allowedGitRemotes: exactStrings(input.allowedGitRemotes),
    allowedBranches: exactStrings(input.allowedBranches),
    controllerManifest,
    entries,
    processEvidence,
  };
  const plan = { ...unsigned, planSha256: sha256Json(unsigned) };
  await durablePublishJsonFile({
    path: quarantinePlanPath(input.controllerJobRootDir, plan.planSha256),
    value: plan,
  });
  return await loadLegacyAttemptQuarantinePlan({
    controllerJobRootDir: input.controllerJobRootDir,
    expectedPlanSha256: plan.planSha256,
  });
}

export async function loadLegacyAttemptQuarantinePlan(input: {
  readonly controllerJobRootDir: string;
  readonly expectedPlanSha256: string;
}): Promise<LegacyAttemptQuarantinePlan> {
  const plan = await readJson<LegacyAttemptQuarantinePlan>(quarantinePlanPath(
    input.controllerJobRootDir,
    input.expectedPlanSha256,
  ));
  if (plan.schemaVersion !== 1 || plan.planSha256 !== input.expectedPlanSha256 ||
    sha256Json(withoutPlanSha(plan)) !== plan.planSha256 ||
    resolve(plan.controllerJobRootDir) !== resolve(input.controllerJobRootDir) ||
    !Array.isArray(plan.entries) || plan.entries.length === 0) {
    throw new Error("legacy_attempt_quarantine_plan_invalid");
  }
  assertPlanStructure(plan);
  return plan;
}

export async function applyLegacyAttemptQuarantine(input: {
  readonly controllerJobRootDir: string;
  readonly expectedPlanSha256: string;
  readonly captureProcessEvidence: (
    custodyPaths: readonly string[],
  ) => Promise<LegacyAttemptProcessEvidence>;
  readonly runAfterControllerScopeRevalidation: <T>(
    plan: LegacyAttemptQuarantinePlan,
    effect: () => Promise<T>,
  ) => Promise<T>;
}): Promise<LegacyAttemptQuarantineReceipt & { readonly idempotentReplay: boolean }> {
  const initial = await loadLegacyAttemptQuarantinePlan(input);
  const fence = await acquireLocalControllerMaintenanceFence({
    controllerJobRootDir: input.controllerJobRootDir,
    owner: `legacy-attempt-quarantine:${initial.planSha256}`,
  });
  try {
    return await input.runAfterControllerScopeRevalidation(initial, async () => {
      const plan = await loadLegacyAttemptQuarantinePlan(input);
      const existing = await optionalJson<LegacyAttemptQuarantineReceipt>(
        quarantineReceiptPath(plan.controllerJobRootDir, plan.planSha256),
      );
      if (existing) {
        await validateLegacyAttemptQuarantineReceipt(plan, existing);
        const custodyPaths = exactPaths(plan.entries.flatMap((entry) => [
          entry.sourceWorkspace.declaredPath,
          entry.targetWorkspace.declaredPath,
        ]));
        assertProcessEvidence(
          await input.captureProcessEvidence(custodyPaths),
          custodyPaths,
        );
        return { ...existing, idempotentReplay: true };
      }
      await revalidatePlanBindings(plan);
      const custodyPaths = exactPaths(plan.entries.flatMap((entry) => [
        entry.sourceWorkspace.declaredPath,
        entry.targetWorkspace.declaredPath,
      ]));
      const processEvidence = await input.captureProcessEvidence(custodyPaths);
      assertProcessEvidence(processEvidence, custodyPaths);
      const progressPath = quarantineProgressPath(
        plan.controllerJobRootDir,
        plan.planSha256,
      );
      const progress = await optionalJson<LegacyAttemptQuarantineProgress>(progressPath) ?? {
        schemaVersion: 1 as const,
        planSha256: plan.planSha256,
        completedAttemptIds: [],
      };
      assertProgress(progress, plan);
      const completed = new Set(progress.completedAttemptIds);
      for (const entry of plan.entries) {
        const preservation = preservationRecord(plan, entry);
        const path = preservationPath(plan, entry.attemptId);
        await durablePublishJsonFile({ path, value: preservation });
        const stored = await readBoundFile(path);
        if (sha256(stored) !== sha256(serializeJson(preservation))) {
          throw new Error("legacy_attempt_quarantine_preservation_conflict");
        }
        completed.add(entry.attemptId);
        await durableReplaceJsonFile({
          path: progressPath,
          value: {
            schemaVersion: 1,
            planSha256: plan.planSha256,
            completedAttemptIds: [...completed].sort(),
          } satisfies LegacyAttemptQuarantineProgress,
        });
      }
      const receipt: LegacyAttemptQuarantineReceipt = {
        schemaVersion: 1,
        status: "active_quarantine",
        planSha256: plan.planSha256,
        controllerJobId: plan.controllerJobId,
        projectId: plan.projectId,
        sourceMutation: false,
        lifecycleTerminalized: false,
        rollbackClaimed: false,
        ledgerConsumptionClaimed: false,
        terminalForLedgerEpochOnly: true,
        processEvidence,
        entries: plan.entries.map((entry) => {
          const path = preservationPath(plan, entry.attemptId);
          return {
            attemptId: entry.attemptId,
            attemptSha256: entry.attemptSha256,
            preservationPath: path,
            preservationSha256: sha256(serializeJson(preservationRecord(plan, entry))),
          };
        }),
        completedAt: new Date().toISOString(),
      };
      await durablePublishJsonFile({
        path: quarantineReceiptPath(plan.controllerJobRootDir, plan.planSha256),
        value: receipt,
      });
      const stored = await readJson<LegacyAttemptQuarantineReceipt>(
        quarantineReceiptPath(plan.controllerJobRootDir, plan.planSha256),
      );
      await validateLegacyAttemptQuarantineReceipt(plan, stored);
      return { ...stored, idempotentReplay: false };
    });
  } finally {
    await releaseLocalControllerMaintenanceFence(fence);
  }
}

export async function readActiveLegacyAttemptQuarantine(
  controllerJobRootDir: string,
): Promise<ActiveLegacyAttemptQuarantine> {
  const root = join(quarantineRoot(controllerJobRootDir), "receipts");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { attemptIds: new Set(), debt: [] };
    throw error;
  }
  const attemptIds = new Set<string>();
  const debt: ActiveLegacyAttemptQuarantine["debt"][number][] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) {
      throw new Error("legacy_attempt_quarantine_receipt_root_invalid");
    }
    const planSha256 = name.slice(0, 64);
    const plan = await loadLegacyAttemptQuarantinePlan({
      controllerJobRootDir,
      expectedPlanSha256: planSha256,
    });
    const receipt = await readJson<LegacyAttemptQuarantineReceipt>(join(root, name));
    await validateLegacyAttemptQuarantineReceipt(plan, receipt);
    for (const entry of plan.entries) {
      if (attemptIds.has(entry.attemptId)) {
        throw new Error("legacy_attempt_quarantine_attempt_duplicate");
      }
      attemptIds.add(entry.attemptId);
      debt.push({
        attemptId: entry.attemptId,
        status: entry.status,
        disposition: entry.disposition,
        ...(entry.refusalReason ? { refusalReason: entry.refusalReason } : {}),
        planSha256,
      });
    }
  }
  return { attemptIds, debt };
}

async function revalidatePlanBindings(plan: LegacyAttemptQuarantinePlan): Promise<void> {
  const controller = await bindPath(plan.controllerManifest.declaredPath, true);
  if (JSON.stringify(controller) !== JSON.stringify(plan.controllerManifest)) {
    throw new Error("legacy_attempt_quarantine_controller_manifest_cas_mismatch");
  }
  const registry = await registrySnapshot(plan.registryRootDir);
  if (registry.count !== plan.registryJobCount ||
    registry.sha256 !== plan.registryJobIdsSha256) {
    throw new Error("legacy_attempt_quarantine_registry_cas_mismatch");
  }
  const current = await buildStaleIntegrationReconciliationPlan({
    controllerJobId: plan.controllerJobId,
    projectId: plan.projectId,
    registryRootDir: plan.registryRootDir,
    controllerJobRootDir: plan.controllerJobRootDir,
    controllerManifestSha256: plan.controllerManifestSha256,
    controllerScopeEpochSha256: plan.controllerScopeEpochSha256,
    targetWorkspaceRoots: plan.targetWorkspaceRoots,
    deniedRoots: plan.deniedRoots,
    allowedGitRemotes: plan.allowedGitRemotes,
    allowedBranches: plan.allowedBranches,
  });
  if (current.planSha256 !== plan.sourceStaleIntegrationPlanSha256) {
    throw new Error("legacy_attempt_quarantine_source_plan_drift");
  }
  const byId = new Map(current.entries.map((entry) => [entry.attemptId, entry]));
  for (const entry of plan.entries) {
    const bytes = await readBoundFile(entry.attemptPath);
    if (sha256(bytes) !== entry.attemptSha256 ||
      bytes.toString("base64") !== entry.originalAttemptBase64 ||
      JSON.stringify(byId.get(entry.attemptId)) !== JSON.stringify(entry.reconciliation) ||
      JSON.stringify(await bindPath(entry.sourceWorkspace.declaredPath, false)) !==
        JSON.stringify(entry.sourceWorkspace) ||
      JSON.stringify(await bindPath(entry.targetWorkspace.declaredPath, false)) !==
        JSON.stringify(entry.targetWorkspace) ||
      JSON.stringify(await bindTargetGit({
        gitBinaryPath: current.gitBinaryPath,
        workspace: entry.targetWorkspace,
        remoteName: entry.reconciliation.targetRemote,
      })) !== JSON.stringify(entry.targetGit) ||
      JSON.stringify(await bindPath(entry.workerManifest.declaredPath, true)) !==
        JSON.stringify(entry.workerManifest) ||
      JSON.stringify(await bindPath(entry.events.declaredPath, true)) !==
        JSON.stringify(entry.events) ||
      (entry.events.state === "present" &&
        (await readBoundFile(entry.events.declaredPath)).toString("base64") !==
          entry.originalEventsBase64)) {
      throw new Error("legacy_attempt_quarantine_binding_drift");
    }
  }
}

async function registrySnapshot(registryRootDir: string): Promise<{
  readonly count: number;
  readonly sha256: string;
}> {
  const records: string[] = [];
  for (const entry of (await readdir(registryRootDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("legacy_attempt_quarantine_registry_unsafe");
    }
    const path = join(registryRootDir, entry.name, "job.json");
    let bytes: Buffer;
    try {
      bytes = await readBoundFile(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    records.push(`${entry.name}:${sha256(bytes)}`);
  }
  return { count: records.length, sha256: sha256Json(records) };
}

async function validateLegacyAttemptQuarantineReceipt(
  plan: LegacyAttemptQuarantinePlan,
  receipt: LegacyAttemptQuarantineReceipt,
): Promise<void> {
  if (receipt.schemaVersion !== 1 || receipt.status !== "active_quarantine" ||
    receipt.planSha256 !== plan.planSha256 ||
    receipt.controllerJobId !== plan.controllerJobId ||
    receipt.projectId !== plan.projectId ||
    receipt.sourceMutation !== false ||
    receipt.lifecycleTerminalized !== false ||
    receipt.rollbackClaimed !== false ||
    receipt.ledgerConsumptionClaimed !== false ||
    receipt.terminalForLedgerEpochOnly !== true ||
    receipt.entries.length !== plan.entries.length) {
    throw new Error("legacy_attempt_quarantine_receipt_invalid");
  }
  const custodyPaths = exactPaths(plan.entries.flatMap((entry) => [
    entry.sourceWorkspace.declaredPath,
    entry.targetWorkspace.declaredPath,
  ]));
  assertProcessEvidence(receipt.processEvidence, custodyPaths);
  await revalidatePlanBindings(plan);
  for (const [index, entry] of plan.entries.entries()) {
    const item = receipt.entries[index];
    const expectedPath = preservationPath(plan, entry.attemptId);
    if (!item || item.attemptId !== entry.attemptId ||
      item.attemptSha256 !== entry.attemptSha256 ||
      item.preservationPath !== expectedPath) {
      throw new Error("legacy_attempt_quarantine_receipt_invalid");
    }
    const bytes = await readBoundFile(expectedPath);
    if (sha256(bytes) !== item.preservationSha256 ||
      item.preservationSha256 !==
        sha256(serializeJson(preservationRecord(plan, entry)))) {
      throw new Error("legacy_attempt_quarantine_preservation_drift");
    }
  }
}

function assertSourcePlanScope(
  plan: Awaited<ReturnType<typeof loadStaleIntegrationReconciliationPlan>>,
  input: ScopeInput,
): void {
  if (plan.controllerJobId !== input.controllerJobId ||
    plan.projectId !== input.projectId ||
    plan.registryRootDir !== resolve(input.registryRootDir) ||
    plan.controllerJobRootDir !== resolve(input.controllerJobRootDir) ||
    plan.controllerManifestSha256 !== input.controllerManifestSha256 ||
    plan.controllerScopeEpochSha256 !== input.controllerScopeEpochSha256 ||
    JSON.stringify(plan.targetWorkspaceRoots) !==
      JSON.stringify(exactPaths(input.targetWorkspaceRoots)) ||
    JSON.stringify(plan.deniedRoots) !==
      JSON.stringify(exactPaths(input.deniedRoots ?? [])) ||
    JSON.stringify(plan.allowedGitRemotes) !==
      JSON.stringify(exactStrings(input.allowedGitRemotes)) ||
    JSON.stringify(plan.allowedBranches) !==
      JSON.stringify(exactStrings(input.allowedBranches))) {
    throw new Error("legacy_attempt_quarantine_source_plan_scope_mismatch");
  }
}

function preservationRecord(
  plan: LegacyAttemptQuarantinePlan,
  entry: LegacyAttemptQuarantineEntry,
) {
  return {
    schemaVersion: 1,
    state: "quarantined_not_repaired",
    valid: true,
    repaired: false,
    planSha256: plan.planSha256,
    controllerJobId: plan.controllerJobId,
    projectId: plan.projectId,
    ...entry,
  } as const;
}

function assertProgress(
  progress: LegacyAttemptQuarantineProgress,
  plan: LegacyAttemptQuarantinePlan,
): void {
  const planned = new Set(plan.entries.map((entry) => entry.attemptId));
  if (progress.schemaVersion !== 1 || progress.planSha256 !== plan.planSha256 ||
    !Array.isArray(progress.completedAttemptIds) ||
    progress.completedAttemptIds.some((id) => !planned.has(id)) ||
    new Set(progress.completedAttemptIds).size !== progress.completedAttemptIds.length) {
    throw new Error("legacy_attempt_quarantine_progress_invalid");
  }
}

function assertProcessEvidence(
  evidence: LegacyAttemptProcessEvidence,
  custodyPaths: readonly string[],
): void {
  if (evidence.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    JSON.stringify(evidence.custodyPaths) !== JSON.stringify(custodyPaths) ||
    !Number.isSafeInteger(evidence.inspectedPidCount) ||
    !/^[a-f0-9]{64}$/.test(evidence.inventorySha256) ||
    !Array.isArray(evidence.blockers)) {
    throw new Error("legacy_attempt_quarantine_process_evidence_invalid");
  }
  if (evidence.blockers.length > 0) {
    throw new Error("legacy_attempt_quarantine_processes_active");
  }
}

function assertPlanStructure(plan: LegacyAttemptQuarantinePlan): void {
  if (!/^[a-f0-9]{64}$/.test(plan.controllerManifestSha256) ||
    !/^[a-f0-9]{64}$/.test(plan.controllerScopeEpochSha256) ||
    !/^[a-f0-9]{64}$/.test(plan.registryJobIdsSha256) ||
    !/^[a-f0-9]{64}$/.test(plan.sourceStaleIntegrationPlanSha256) ||
    !Number.isSafeInteger(plan.registryJobCount) || plan.registryJobCount < 1 ||
    !Number.isFinite(Date.parse(plan.cutoff)) ||
    JSON.stringify(plan.targetWorkspaceRoots) !==
      JSON.stringify(exactPaths(plan.targetWorkspaceRoots)) ||
    JSON.stringify(plan.deniedRoots) !== JSON.stringify(exactPaths(plan.deniedRoots)) ||
    JSON.stringify(plan.allowedGitRemotes) !==
      JSON.stringify(exactStrings(plan.allowedGitRemotes)) ||
    JSON.stringify(plan.allowedBranches) !==
      JSON.stringify(exactStrings(plan.allowedBranches)) ||
    plan.entries.length > 64) {
    throw new Error("legacy_attempt_quarantine_plan_invalid");
  }
  assertProcessEvidence(plan.processEvidence, exactPaths(plan.entries.flatMap((entry) => [
    entry.sourceWorkspace.declaredPath,
    entry.targetWorkspace.declaredPath,
  ])));
  const ids = new Set<string>();
  for (const entry of plan.entries) {
    const bytes = Buffer.from(entry.originalAttemptBase64, "base64");
    if (!entry.attemptId || ids.has(entry.attemptId) ||
      resolve(entry.attemptPath) !== entry.attemptPath ||
      !/^[a-f0-9]{64}$/.test(entry.attemptSha256) ||
      bytes.toString("base64") !== entry.originalAttemptBase64 ||
      sha256(bytes) !== entry.attemptSha256 ||
      !Number.isFinite(Date.parse(entry.updatedAt)) ||
      Date.parse(entry.updatedAt) > Date.parse(plan.cutoff) ||
      entry.priorRejectOutcome !== "failed_without_terminalization" ||
      (entry.disposition === "reconciliation_evidence_bound") !==
        entry.reconciliation.eligible ||
      (entry.disposition === "unresolved_evidence_quarantine" &&
        (!entry.refusalReason || entry.reconciliation.eligible)) ||
      entry.refusalReason !== entry.reconciliation.refusalReason ||
      entry.attemptId !== entry.reconciliation.attemptId ||
      entry.attemptSha256 !== entry.reconciliation.attemptSha256) {
      throw new Error("legacy_attempt_quarantine_plan_invalid");
    }
    ids.add(entry.attemptId);
  }
}

async function bindPath(
  path: string,
  includeBytes: boolean,
): Promise<LegacyAttemptPathBinding> {
  const declaredPath = resolve(path);
  try {
    const metadata = await lstat(declaredPath);
    if (metadata.isSymbolicLink()) throw new Error("legacy_attempt_quarantine_path_unsafe");
    const canonicalPath = await realpath(declaredPath);
    const bytes = includeBytes && metadata.isFile()
      ? await readBoundFile(declaredPath)
      : undefined;
    return {
      declaredPath,
      state: "present",
      canonicalPath,
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      size: metadata.size,
      ...(bytes ? { sha256: sha256(bytes) } : {}),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { declaredPath, state: "missing" };
    throw error;
  }
}

async function bindTargetGit(input: {
  readonly gitBinaryPath: string;
  readonly workspace: LegacyAttemptPathBinding;
  readonly remoteName: string;
}): Promise<LegacyAttemptTargetGitBinding> {
  if (input.workspace.state === "missing") return { state: "workspace_missing" };
  const run = async (args: readonly string[]): Promise<Buffer> => {
    const result = await execFileAsync(input.gitBinaryPath, args, {
      cwd: input.workspace.declaredPath,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
    });
    return Buffer.from(result.stdout);
  };
  const [headBytes, status, remoteUrl] = await Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["status", "--porcelain=v1", "-z"]),
    run(["remote", "get-url", "--", input.remoteName]),
  ]);
  const head = headBytes.toString("utf8").trim();
  if (!/^[a-f0-9]{40,64}$/.test(head)) {
    throw new Error("legacy_attempt_quarantine_target_head_invalid");
  }
  return {
    state: "observed",
    head,
    statusBase64: status.toString("base64"),
    statusSha256: sha256(status),
    remoteName: input.remoteName,
    remoteUrlBase64: remoteUrl.toString("base64"),
    remoteUrlSha256: sha256(remoteUrl),
  };
}

async function readBoundFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("legacy_attempt_quarantine_file_unsafe");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("legacy_attempt_quarantine_file_drift");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function exactPaths(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function exactStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function quarantineRoot(controllerJobRootDir: string): string {
  return join(resolve(controllerJobRootDir), "project-integration", "legacy-attempt-quarantine");
}

function quarantinePlanPath(controllerJobRootDir: string, planSha256: string): string {
  return join(quarantineRoot(controllerJobRootDir), "plans", `${planSha256}.json`);
}

function quarantineProgressPath(controllerJobRootDir: string, planSha256: string): string {
  return join(quarantineRoot(controllerJobRootDir), "progress", `${planSha256}.json`);
}

function quarantineReceiptPath(controllerJobRootDir: string, planSha256: string): string {
  return join(quarantineRoot(controllerJobRootDir), "receipts", `${planSha256}.json`);
}

function preservationPath(
  plan: LegacyAttemptQuarantinePlan,
  attemptId: string,
): string {
  return join(
    quarantineRoot(plan.controllerJobRootDir),
    "preservation",
    plan.planSha256,
    `${sha256(Buffer.from(attemptId))}.json`,
  );
}

function withoutPlanSha(plan: LegacyAttemptQuarantinePlan): unknown {
  const { planSha256: _ignored, ...unsigned } = plan;
  return unsigned;
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value)));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse((await readBoundFile(path)).toString("utf8")) as T;
}

async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
