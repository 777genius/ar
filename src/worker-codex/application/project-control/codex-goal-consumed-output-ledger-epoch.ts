import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  consumedOutputRecordFromJson,
  type ConsumedOutputLedgerEpochAdmissionSummary,
  type ConsumedOutputLedgerEpochFilePlan,
  type ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  type ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor,
  type ConsumedOutputLedgerEpochPlan,
  type ConsumedOutputLedgerEpochReceipt,
  type ConsumedOutputLedgerEpochState,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  assertEpochArtifactsAbsent,
  isEpochPlan,
  isEpochState,
} from "./codex-goal-consumed-output-ledger-epoch-validation";
import {
  canonicalConsumedOutputLedgerRoot,
  durableConfirmEpochRoot,
  durablePublishEpochRoot,
  durableReplaceEpochJson,
} from "./codex-goal-consumed-output-ledger-epoch-durability";
export { canonicalConsumedOutputLedgerRoot } from
  "./codex-goal-consumed-output-ledger-epoch-durability";
import { ledgerFilenameMatchesPayload } from
  "./codex-goal-consumed-output-ledger-io";
import {
  LEDGER_EPOCH_RECEIPT_NAME,
  ledgerEpochReceiptSha256,
  ledgerEpochStateReceipt,
  publishLedgerEpochReceipt,
  readLedgerEpochReceiptTuple,
} from "./codex-goal-consumed-output-ledger-epoch-receipt";
import {
  assertConsumedOutputLedgerRetiredMarkerIfPresent,
  publishConsumedOutputLedgerRetiredMarker,
} from
  "./codex-goal-consumed-output-ledger-epoch-retirement";
import {
  bindLedgerEpochOrphanWorkspace,
  ledgerEpochOrphanWorkspaceBindingMatches,
} from "./codex-goal-ledger-epoch-orphan-quarantine";
import {
  assertLedgerEpochEvidenceBindingsUnchanged,
  bindLedgerEpochEvidencePath,
  canonicalLedgerEpochRoots,
  restrictedLedgerEpochEvidenceSource,
  scanLedgerEpochRoot,
  terminalLedgerEpochEvidencePaths,
} from "./codex-goal-ledger-epoch-evidence";
import { assertConsumedOutputLedgerEpochAdmissionTransition } from
  "./codex-goal-ledger-epoch-admission-transition";
const PLAN_VERSION = 1;
const PLAN_NAME = "ledger-epoch-plan.json";
const STATE_NAME = "ledger-epoch-state.json";
const MAX_LEDGER_FILE_BYTES = 16 * 1024 * 1024;
export type {
  ConsumedOutputLedgerEpochAdmissionSummary,
  ConsumedOutputLedgerEpochPlan,
  ConsumedOutputLedgerEpochReceipt,
} from "@vioxen/subscription-runtime/worker-core";
export type BuildConsumedOutputLedgerEpochPlanInput = {
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly cutoff: string;
  readonly currentJobIds: ReadonlySet<string>;
  readonly evidenceRoots: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly orphanWorkspacePaths?: readonly string[];
  readonly controllerManifestSha256: string;
  readonly controllerStableScopeSha256: string;
  readonly legacyAttemptQuarantine?:
    ConsumedOutputLedgerEpochLegacyAttemptQuarantineAnchor;
};
export async function buildConsumedOutputLedgerEpochPlan(
  input: BuildConsumedOutputLedgerEpochPlanInput,
): Promise<ConsumedOutputLedgerEpochPlan> {
  const cutoff = normalizedCutoff(input.cutoff);
  const oldRoot = await canonicalConsumedOutputLedgerRoot(input.oldRoot, true);
  const newRoot = await canonicalConsumedOutputLedgerRoot(input.newRoot, false);
  if (oldRoot === newRoot) throw new Error("ledger_epoch_new_root_must_differ");
  if (pathInsideOrEqual(newRoot, oldRoot) || pathInsideOrEqual(oldRoot, newRoot)) {
    throw new Error("ledger_epoch_roots_must_not_overlap");
  }
  if (dirname(dirname(oldRoot)) !== dirname(dirname(newRoot))) {
    throw new Error("ledger_epoch_evidence_boundary_mismatch");
  }
  const files = await scanLedgerEpochRoot(oldRoot);
  const oldRootStats = await stat(oldRoot);
  const newRootParentStats = await stat(dirname(newRoot));
  const evidenceRoots = uniqueResolvedRoots([...input.evidenceRoots, dirname(oldRoot)]);
  const deniedRoots = uniqueResolvedRoots(input.deniedRoots ?? []);
  const canonicalEvidenceRoots = await canonicalLedgerEpochRoots(evidenceRoots);
  const canonicalDeniedRoots = await canonicalLedgerEpochRoots(deniedRoots);
  const evidenceSource = restrictedLedgerEpochEvidenceSource({
    roots: evidenceRoots,
    canonicalRoots: canonicalEvidenceRoots,
    deniedRoots,
    canonicalDeniedRoots,
  });
  const evidencePathValues = new Set<string>();
  const orphanWorkspacePaths = new Set(
    (input.orphanWorkspacePaths ?? []).map((path) => resolve(path)),
  );
  const planned: ConsumedOutputLedgerEpochFilePlan[] = [];
  for (const file of files) {
    const relativePath = relative(oldRoot, file.path);
    const base = {
      relativePath,
      size: file.size,
      sha256: file.sha256,
    };
    if (!relativePath.startsWith(`items${sep}`) || !relativePath.endsWith(".json")) {
      planned.push({ ...base, disposition: "preserve_only" });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file.path, "utf8"));
      for (const path of terminalLedgerEpochEvidencePaths(value)) {
        evidencePathValues.add(path);
      }
    } catch {
      planned.push({
        ...base,
        disposition: "quarantine",
        quarantineReason: "invalid_json",
      });
      continue;
    }
    if (!ledgerFilenameMatchesPayload(basename(file.path), value)) {
      rememberQuarantinedOrphanCandidate(value, input.currentJobIds, orphanWorkspacePaths);
      planned.push({
        ...base,
        disposition: "quarantine",
        quarantineReason: "invalid_or_missing_evidence",
      });
      continue;
    }
    const record = await consumedOutputRecordFromJson({
      value,
      ledgerPath: file.path,
      source: evidenceSource,
    });
    if (!record?.valid) {
      rememberQuarantinedOrphanCandidate(value, input.currentJobIds, orphanWorkspacePaths);
      planned.push({
        ...base,
        disposition: "quarantine",
        quarantineReason: "invalid_or_missing_evidence",
      });
      continue;
    }
    const postCutoff = record.closedAt !== undefined &&
      Date.parse(record.closedAt) >= Date.parse(cutoff);
    if (!postCutoff && !input.currentJobIds.has(record.jobId)) {
      planned.push({
        ...base,
        disposition: "quarantine",
        quarantineReason: "legacy_before_cutoff",
      });
      continue;
    }
    planned.push({ ...base, disposition: "migrate" });
  }
  const filesInOrder = planned.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
  const evidenceBindings = await Promise.all(
    [...evidencePathValues].sort().map(async (path) =>
      await bindLedgerEpochEvidencePath({
        declaredPath: path,
        roots: evidenceRoots,
        canonicalRoots: canonicalEvidenceRoots,
        deniedRoots,
        canonicalDeniedRoots,
      })
    ),
  );
  const currentOrphanWorkspaceBindings = (await Promise.all(
    [...orphanWorkspacePaths].sort().map(async (workspacePath) =>
      await bindLedgerEpochOrphanWorkspace({ workspacePath, deniedRoots })
    ),
  )).filter((binding): binding is ConsumedOutputLedgerEpochOrphanWorkspaceBinding =>
    binding !== undefined
  );
  const registryJobIds = [...input.currentJobIds].sort();
  const oldRootHash = treeHash(filesInOrder);
  const previousEpoch = await previousEpochReceipt(oldRoot);
  const orphanWorkspaceBindings = await mergeInheritedOrphanWorkspaceBindings({
    previous: previousEpoch?.orphanWorkspaceBindings ?? [],
    current: currentOrphanWorkspaceBindings,
    deniedRoots,
  });
  const unsigned = {
    schemaVersion: PLAN_VERSION as 1,
    controllerJobId: input.controllerJobId,
    projectId: input.projectId,
    oldRoot,
    newRoot,
    cutoff,
    oldRootHash,
    oldRootFileCount: filesInOrder.length,
    oldRootDevice: oldRootStats.dev,
    oldRootInode: oldRootStats.ino,
    newRootParentDevice: newRootParentStats.dev,
    newRootParentInode: newRootParentStats.ino,
    epochNumber: (previousEpoch?.epochNumber ?? 0) + 1,
    genesisOldRootHash: previousEpoch?.genesisOldRootHash ?? oldRootHash,
    ...(previousEpoch
      ? { previousEpochPlanSha256: previousEpoch.planSha256 }
      : {}),
    controllerManifestSha256: input.controllerManifestSha256,
    controllerStableScopeSha256: input.controllerStableScopeSha256,
    registryJobIdsSha256: sha256Json(registryJobIds),
    registryJobCount: registryJobIds.length,
    migratedCount: filesInOrder.filter((file) => file.disposition === "migrate").length,
    quarantinedCount: filesInOrder.filter(
      (file) => file.disposition === "quarantine",
    ).length,
    inheritedQuarantinedCount: previousEpoch
      ? previousEpoch.inheritedQuarantinedCount + previousEpoch.quarantinedCount
      : 0,
    deniedRoots,
    evidenceBindings,
    orphanWorkspaceBindings,
    ...(input.legacyAttemptQuarantine
      ? { legacyAttemptQuarantine: input.legacyAttemptQuarantine }
      : {}),
    files: filesInOrder,
  };
  const plan = { ...unsigned, planSha256: sha256Json(unsigned) };
  await assertConsumedOutputLedgerRetiredMarkerIfPresent(plan);
  return plan;
}
export type ApplyConsumedOutputLedgerEpochInput = {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly expectedPlanSha256: string;
  readonly buildCurrentPlan: () => Promise<ConsumedOutputLedgerEpochPlan>;
  readonly admissionBefore: ConsumedOutputLedgerEpochAdmissionSummary;
  readonly validateProposedAdmission: () => Promise<ConsumedOutputLedgerEpochAdmissionSummary>;
  readonly admissionForNewRoot: () => Promise<ConsumedOutputLedgerEpochAdmissionSummary>;
  readonly switchScope: (newRoot: string) => Promise<void>;
  readonly readActiveRoot: () => Promise<string>;
  readonly now?: () => Date;
  readonly crashAfterPhase?:
    | "prepared"
    | "scope_switched_before_retirement"
    | "scope_switched"
    | "receipt_published";
  readonly revalidatePostSwitchBindings: () => Promise<void>;
};
export async function applyConsumedOutputLedgerEpoch(
  input: ApplyConsumedOutputLedgerEpochInput,
): Promise<{ readonly receipt: ConsumedOutputLedgerEpochReceipt; readonly idempotentReplay: boolean }> {
  assertPlanHash(input.plan, input.expectedPlanSha256);
  await assertRootIdentities(input.plan);
  const replay = await existingActiveReceipt(input.plan.newRoot);
  if (replay) {
    await durableConfirmEpochRoot(input.plan.newRoot);
    if (replay.planSha256 !== input.plan.planSha256) {
      throw new Error("ledger_epoch_existing_root_conflict");
    }
    if (resolve(await input.readActiveRoot()) !== input.plan.newRoot) {
      throw new Error("ledger_epoch_active_receipt_scope_mismatch");
    }
    await assertSeededRootMatchesPlan(input.plan);
    const state = await requireEpochState(input.plan.newRoot);
    if (state.phase === "scope_switched") {
      await input.revalidatePostSwitchBindings();
      await writeJsonAtomic(join(input.plan.newRoot, STATE_NAME), {
        ...state,
        phase: "active",
      });
    } else if (state.phase !== "active") {
      throw new Error("ledger_epoch_receipt_state_mismatch");
    }
    return { receipt: replay, idempotentReplay: true };
  }
  const existingState = await optionalEpochState(input.plan.newRoot);
  if (existingState) {
    assertEpochStateOwned(existingState, input.plan);
    await durableConfirmEpochRoot(input.plan.newRoot);
    return await resumeConsumedOutputLedgerEpoch(input, existingState);
  }
  const currentPlan = await input.buildCurrentPlan();
  if (currentPlan.planSha256 !== input.plan.planSha256) {
    throw new Error("ledger_epoch_plan_drift");
  }
  const stagingRoot = await mkdtemp(join(
    dirname(input.plan.newRoot),
    `.${basename(input.plan.newRoot)}.staging-`,
  ));
  const ownerToken = randomUUID();
  try {
    await assertRootIdentities(input.plan);
    await seedEpochRoot({
      plan: input.plan,
      stagingRoot,
      ownerToken,
      admissionBefore: input.admissionBefore,
    });
    const revalidated = await input.buildCurrentPlan();
    if (revalidated.planSha256 !== input.plan.planSha256) {
      throw new Error("ledger_epoch_plan_drift");
    }
    await assertRootIdentities(input.plan);
    await durablePublishEpochRoot(stagingRoot, input.plan.newRoot);
    const prepared = await requireEpochState(input.plan.newRoot);
    if (input.crashAfterPhase === "prepared") {
      throw new Error("ledger_epoch_simulated_crash_after_prepared");
    }
    return await resumeConsumedOutputLedgerEpoch(input, prepared);
  } catch (error) {
    await removeOwnedStaging(stagingRoot, ownerToken);
    throw error;
  }
}
export async function resolveConsumedOutputLedgerEpochReceipt(
  ledgerRoot: string,
): Promise<ConsumedOutputLedgerEpochReceipt> {
  const plan = await readStoredEpochPlan(ledgerRoot);
  const state = await requireEpochState(ledgerRoot);
  const value = await readLedgerEpochReceiptTuple({
    root: ledgerRoot,
    state,
    plan,
    requireRetirementMarker: true,
  });
  await assertSeededRootMatchesPlan(plan);
  return value;
}
export async function resolvePendingConsumedOutputLedgerEpochPlan(
  ledgerRoot: string,
  allowActiveMarkerRecovery = false,
): Promise<ConsumedOutputLedgerEpochPlan | undefined> {
  const root = resolve(ledgerRoot);
  const state = await optionalEpochState(root);
  if (!state) return undefined;
  const value = await readStoredEpochPlan(root);
  if (state.planSha256 !== value.planSha256 || resolve(value.newRoot) !== root) {
    throw new Error("ledger_epoch_seed_plan_mismatch");
  }
  if (state.phase === "active") {
    await readLedgerEpochReceiptTuple({
      root,
      state,
      plan: value,
      requireRetirementMarker: !allowActiveMarkerRecovery,
    });
  }
  await assertSeededRootMatchesPlan(value);
  return value;
}
async function resumeConsumedOutputLedgerEpoch(
  input: ApplyConsumedOutputLedgerEpochInput,
  state: ConsumedOutputLedgerEpochState,
): Promise<{ readonly receipt: ConsumedOutputLedgerEpochReceipt; readonly idempotentReplay: boolean }> {
  assertEpochStateOwned(state, input.plan);
  await assertSeededRootMatchesPlan(input.plan);
  const activeRoot = resolve(await input.readActiveRoot());
  if (state.phase !== "prepared") {
    if (activeRoot !== input.plan.newRoot) {
      throw new Error("ledger_epoch_scope_state_mismatch");
    }
    await publishConsumedOutputLedgerRetiredMarker(input.plan);
  }
  if (state.phase === "receipt_prepared" || state.phase === "active") {
    await assertLedgerEpochEvidenceBindingsUnchanged(input.plan.evidenceBindings);
    await assertOrphanWorkspaceBindingsUnchanged(input.plan);
    await input.revalidatePostSwitchBindings();
    const receipt = ledgerEpochStateReceipt(state, input.plan);
    await publishLedgerEpochReceipt(input.plan.newRoot, receipt);
    if (state.phase !== "active") {
      await writeJsonAtomic(join(input.plan.newRoot, STATE_NAME), {
        ...state,
        phase: "active",
      });
    }
    return { receipt, idempotentReplay: state.phase === "active" };
  }
  if (state.phase === "prepared") {
    if (activeRoot === input.plan.oldRoot) {
      const currentPlan = await input.buildCurrentPlan();
      if (currentPlan.planSha256 !== input.plan.planSha256) {
        throw new Error("ledger_epoch_plan_drift");
      }
      const proposedAdmission = await input.validateProposedAdmission();
      assertConsumedOutputLedgerEpochAdmissionTransition({
        plan: input.plan,
        before: state.admissionBefore,
        proposed: proposedAdmission,
      });
      await assertOrphanWorkspaceBindingsUnchanged(input.plan);
      await input.switchScope(input.plan.newRoot);
      if (input.crashAfterPhase === "scope_switched_before_retirement") {
        throw new Error(
          "ledger_epoch_simulated_crash_after_scope_switched_before_retirement",
        );
      }
      await publishConsumedOutputLedgerRetiredMarker(input.plan);
    } else if (activeRoot !== input.plan.newRoot) {
      throw new Error("ledger_epoch_controller_scope_drift");
    } else {
      await publishConsumedOutputLedgerRetiredMarker(input.plan);
    }
    await writeJsonAtomic(join(input.plan.newRoot, STATE_NAME), {
      ...state,
      phase: "scope_switched",
    });
    if (input.crashAfterPhase === "scope_switched") {
      throw new Error("ledger_epoch_simulated_crash_after_scope_switched");
    }
  } else if (activeRoot !== input.plan.newRoot) {
    throw new Error("ledger_epoch_scope_state_mismatch");
  }
  await assertLedgerEpochEvidenceBindingsUnchanged(input.plan.evidenceBindings);
  await assertOrphanWorkspaceBindingsUnchanged(input.plan);
  await input.revalidatePostSwitchBindings();
  const admissionAfter = await input.admissionForNewRoot();
  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const receipt: ConsumedOutputLedgerEpochReceipt = {
    schemaVersion: 1,
    status: "active",
    controllerJobId: input.plan.controllerJobId,
    projectId: input.plan.projectId,
    oldRoot: input.plan.oldRoot,
    newRoot: input.plan.newRoot,
    cutoff: input.plan.cutoff,
    oldRootHash: input.plan.oldRootHash,
    oldRootFileCount: input.plan.oldRootFileCount,
    epochNumber: input.plan.epochNumber,
    genesisOldRootHash: input.plan.genesisOldRootHash,
    ...(input.plan.previousEpochPlanSha256
      ? { previousEpochPlanSha256: input.plan.previousEpochPlanSha256 }
      : {}),
    migratedCount: input.plan.migratedCount,
    quarantinedCount: input.plan.quarantinedCount,
    inheritedQuarantinedCount: input.plan.inheritedQuarantinedCount,
    deniedRoots: input.plan.deniedRoots,
    orphanWorkspaceBindings: input.plan.orphanWorkspaceBindings,
    ...(input.plan.legacyAttemptQuarantine
      ? { legacyAttemptQuarantine: input.plan.legacyAttemptQuarantine }
      : {}),
    planSha256: input.plan.planSha256,
    createdAt,
    activatedAt: createdAt,
    admissionBefore: state.admissionBefore,
    admissionAfter,
  };
  const receiptState: ConsumedOutputLedgerEpochState = {
    ...state,
    phase: "receipt_prepared",
    receipt,
    receiptSha256: ledgerEpochReceiptSha256(receipt),
  };
  await writeJsonAtomic(join(input.plan.newRoot, STATE_NAME), receiptState);
  await publishLedgerEpochReceipt(input.plan.newRoot, receipt);
  if (input.crashAfterPhase === "receipt_published") {
    throw new Error("ledger_epoch_simulated_crash_after_receipt_published");
  }
  await writeJsonAtomic(join(input.plan.newRoot, STATE_NAME), {
    ...receiptState,
    phase: "active",
  });
  return { receipt, idempotentReplay: false };
}
export async function resolveConsumedOutputMaintenanceLedgerRoot(
  scope: ProjectAccessScope,
): Promise<{
  readonly ledgerRoot: string;
  readonly epochReceipt?: ConsumedOutputLedgerEpochReceipt;
  readonly pendingEpochPlan?: ConsumedOutputLedgerEpochPlan;
}> {
  const roots = scope.consumedOutputLedgerRoots ?? [];
  if (roots.length !== 1) {
    throw new Error("project_control_consumed_output_ledger_required");
  }
  const ledgerRoot = resolve(roots[0]!);
  try {
    return {
      ledgerRoot,
      epochReceipt: await resolveConsumedOutputLedgerEpochReceipt(ledgerRoot),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      const pendingEpochPlan = await resolvePendingConsumedOutputLedgerEpochPlan(
        ledgerRoot,
      );
      return { ledgerRoot, ...(pendingEpochPlan ? { pendingEpochPlan } : {}) };
    }
    throw error;
  }
}
async function seedEpochRoot(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly stagingRoot: string;
  readonly ownerToken: string;
  readonly admissionBefore: ConsumedOutputLedgerEpochAdmissionSummary;
}): Promise<void> {
  await mkdir(join(input.stagingRoot, "items"), { recursive: true, mode: 0o700 });
  await mkdir(join(input.stagingRoot, "quarantine"), { recursive: true, mode: 0o700 });
  await mkdir(join(input.stagingRoot, "workspace-quarantine"), {
    recursive: true,
    mode: 0o700,
  });
  for (const file of input.plan.files) {
    const source = join(input.plan.oldRoot, file.relativePath);
    const preserved = join(input.stagingRoot, "legacy-preservation", file.relativePath);
    await mkdir(dirname(preserved), { recursive: true, mode: 0o700 });
    await writeFileFromHardenedSource(source, preserved, file.sha256);
    await assertFileHash(preserved, file.sha256);
    if (file.disposition === "migrate") {
      const itemRelativePath = relative("items", file.relativePath);
      const target = join(input.stagingRoot, "items", itemRelativePath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFileFromHardenedSource(source, target, file.sha256);
      await assertFileHash(target, file.sha256);
    } else if (file.disposition === "quarantine") {
      const quarantinePath = join(
        input.stagingRoot,
        "quarantine",
        quarantineArtifactName(file),
      );
      await writeJsonExact(quarantinePath, quarantineArtifact(file));
    }
  }
  for (const binding of input.plan.orphanWorkspaceBindings) {
    await writeJsonExact(
      join(input.stagingRoot, "workspace-quarantine", orphanArtifactName(binding)),
      orphanWorkspaceArtifact(binding, input.plan.planSha256),
    );
  }
  await writeJsonExact(join(input.stagingRoot, PLAN_NAME), input.plan);
  await writeJsonExact(join(input.stagingRoot, ".epoch-owner.json"), {
    schemaVersion: 1,
    ownerToken: input.ownerToken,
    planSha256: input.plan.planSha256,
  });
  await writeJsonExact(join(input.stagingRoot, STATE_NAME), {
    schemaVersion: 1,
    phase: "prepared",
    ownerToken: input.ownerToken,
    planSha256: input.plan.planSha256,
    admissionBefore: input.admissionBefore,
  });
}
async function existingActiveReceipt(
  newRoot: string,
): Promise<ConsumedOutputLedgerEpochReceipt | undefined> {
  const state = await optionalEpochState(newRoot);
  if (!state || state.phase !== "active") return undefined;
  try {
    return await resolveConsumedOutputLedgerEpochReceipt(newRoot);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}
async function previousEpochReceipt(
  oldRoot: string,
): Promise<ConsumedOutputLedgerEpochReceipt | undefined> {
  const state = await optionalEpochState(oldRoot);
  if (!state) return undefined;
  if (state.phase !== "active") {
    throw new Error("ledger_epoch_previous_epoch_incomplete");
  }
  return await resolveConsumedOutputLedgerEpochReceipt(oldRoot);
}
async function optionalEpochState(
  root: string,
): Promise<ConsumedOutputLedgerEpochState | undefined> {
  try {
    return await requireEpochState(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      await assertEpochArtifactsAbsent([
        join(root, PLAN_NAME),
        join(root, LEDGER_EPOCH_RECEIPT_NAME),
      ]);
      return undefined;
    }
    throw error;
  }
}
async function requireEpochState(root: string): Promise<ConsumedOutputLedgerEpochState> {
  const bytes = await readFile(join(root, STATE_NAME));
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isEpochState(value) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
  ) throw new Error("ledger_epoch_state_invalid");
  return value;
}
function assertEpochStateOwned(
  state: ConsumedOutputLedgerEpochState,
  plan: ConsumedOutputLedgerEpochPlan,
): void {
  if (state.planSha256 !== plan.planSha256) {
    throw new Error("ledger_epoch_existing_root_conflict");
  }
}
async function assertSeededRootMatchesPlan(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<void> {
  const storedPlan = await readStoredEpochPlan(plan.newRoot);
  if (storedPlan.planSha256 !== plan.planSha256) {
    throw new Error("ledger_epoch_seed_plan_mismatch");
  }
  const state = await requireEpochState(plan.newRoot);
  const ownerBytes = await readFile(join(plan.newRoot, ".epoch-owner.json"));
  const owner: unknown = JSON.parse(ownerBytes.toString("utf8"));
  if (
    state.planSha256 !== plan.planSha256 || !isRecord(owner) ||
    owner.schemaVersion !== 1 || owner.planSha256 !== plan.planSha256 ||
    typeof owner.ownerToken !== "string" || owner.ownerToken !== state.ownerToken ||
    !ownerBytes.equals(Buffer.from(`${JSON.stringify(owner, null, 2)}\n`))
  ) {
    throw new Error("ledger_epoch_seed_owner_mismatch");
  }
  const preservationPaths: string[] = [];
  const itemPaths: string[] = [];
  const quarantinePaths: string[] = [];
  const orphanPaths: string[] = [];
  for (const file of plan.files) {
    preservationPaths.push(file.relativePath);
    await assertFileHash(
      join(plan.newRoot, "legacy-preservation", file.relativePath),
      file.sha256,
    );
    if (file.disposition === "migrate") {
      itemPaths.push(relative("items", file.relativePath));
      await assertFileHash(
        join(plan.newRoot, "items", relative("items", file.relativePath)),
        file.sha256,
      );
    } else if (file.disposition === "quarantine") {
      const quarantineName = quarantineArtifactName(file);
      quarantinePaths.push(quarantineName);
      const expected = quarantineArtifact(file);
      const actual = await readFile(join(plan.newRoot, "quarantine", quarantineName));
      if (!actual.equals(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`))) {
        throw new Error("ledger_epoch_quarantine_artifact_mismatch");
      }
    }
  }
  for (const binding of plan.orphanWorkspaceBindings) {
    const name = orphanArtifactName(binding);
    orphanPaths.push(name);
    const actual = await readFile(join(plan.newRoot, "workspace-quarantine", name));
    const expected = orphanWorkspaceArtifact(binding, plan.planSha256);
    if (!actual.equals(Buffer.from(`${JSON.stringify(expected, null, 2)}\n`))) {
      throw new Error("ledger_epoch_orphan_quarantine_artifact_mismatch");
    }
  }
  await assertExactRelativeFiles(
    join(plan.newRoot, "legacy-preservation"),
    preservationPaths,
  );
  if (state.phase === "prepared") {
    await assertExactRelativeFiles(join(plan.newRoot, "items"), itemPaths);
  } else {
    await assertExpectedRelativeFiles(join(plan.newRoot, "items"), itemPaths);
  }
  await assertExactRelativeFiles(join(plan.newRoot, "quarantine"), quarantinePaths);
  await assertExactRelativeFiles(
    join(plan.newRoot, "workspace-quarantine"),
    orphanPaths,
  );
}

async function assertOrphanWorkspaceBindingsUnchanged(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<void> {
  for (const binding of plan.orphanWorkspaceBindings) {
    if (binding.state !== "quarantined" ||
      !await ledgerEpochOrphanWorkspaceBindingMatches({
        binding,
        deniedRoots: plan.deniedRoots,
      })
    ) throw new Error("ledger_epoch_orphan_workspace_binding_drift");
  }
}

async function mergeInheritedOrphanWorkspaceBindings(input: {
  readonly previous: readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly current: readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly deniedRoots: readonly string[];
}): Promise<readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[]> {
  const bindings = new Map<string, ConsumedOutputLedgerEpochOrphanWorkspaceBinding>();
  for (const binding of input.previous) {
    if (binding.state !== "quarantined" ||
      !await ledgerEpochOrphanWorkspaceBindingMatches({
        binding,
        deniedRoots: input.deniedRoots,
      })) {
      throw new Error("ledger_epoch_inherited_orphan_workspace_binding_drift");
    }
    bindings.set(resolve(binding.declaredPath), binding);
  }
  for (const binding of input.current) {
    const key = resolve(binding.declaredPath);
    const inherited = bindings.get(key);
    if (inherited && JSON.stringify(inherited) !== JSON.stringify(binding)) {
      throw new Error("ledger_epoch_inherited_orphan_workspace_binding_drift");
    }
    bindings.set(key, binding);
  }
  return [...bindings.values()].sort((left, right) =>
    left.declaredPath.localeCompare(right.declaredPath)
  );
}

function rememberQuarantinedOrphanCandidate(
  value: unknown,
  currentJobIds: ReadonlySet<string>,
  target: Set<string>,
): void {
  if (!isRecord(value) || typeof value.jobId !== "string" ||
    currentJobIds.has(value.jobId) || !isRecord(value.backup) ||
    typeof value.backup.workspace !== "string"
  ) return;
  target.add(resolve(value.backup.workspace));
}

function orphanArtifactName(
  binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
): string {
  return `${createHash("sha256").update(binding.declaredPath).digest("hex")}.json`;
}

function orphanWorkspaceArtifact(
  binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  planSha256: string,
) {
  return {
    schemaVersion: 1,
    status: "quarantined_orphan_legacy_workspace",
    planSha256,
    binding,
    valid: false,
    repaired: false,
    sourceWorkspaceUntouched: true,
  };
}

async function assertRootIdentities(plan: ConsumedOutputLedgerEpochPlan): Promise<void> {
  const oldRoot = await stat(plan.oldRoot);
  const parent = await stat(dirname(plan.newRoot));
  if (
    oldRoot.dev !== plan.oldRootDevice || oldRoot.ino !== plan.oldRootInode ||
    parent.dev !== plan.newRootParentDevice ||
    parent.ino !== plan.newRootParentInode ||
    await realpath(plan.oldRoot) !== plan.oldRoot ||
    await realpath(dirname(plan.newRoot)) !== dirname(plan.newRoot)
  ) {
    throw new Error("ledger_epoch_root_identity_drift");
  }
}

async function readStoredEpochPlan(root: string): Promise<ConsumedOutputLedgerEpochPlan> {
  const bytes = await readFile(join(resolve(root), PLAN_NAME));
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isEpochPlan(value)) throw new Error("ledger_epoch_seed_plan_invalid");
  assertPlanHash(value, value.planSha256);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) {
    throw new Error("ledger_epoch_seed_plan_bytes_mismatch");
  }
  return value;
}

async function assertExactRelativeFiles(
  root: string,
  expected: readonly string[],
): Promise<void> {
  const actual = (await scanLedgerEpochRoot(root))
    .map((file) => relative(root, file.path))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error("ledger_epoch_seed_file_set_mismatch");
  }
}

async function assertExpectedRelativeFiles(
  root: string,
  expected: readonly string[],
): Promise<void> {
  const actual = new Set((await scanLedgerEpochRoot(root)).map((file) =>
    relative(root, file.path)
  ));
  if (expected.some((path) => !actual.has(path))) {
    throw new Error("ledger_epoch_seed_file_set_mismatch");
  }
}

function quarantineArtifactName(file: ConsumedOutputLedgerEpochFilePlan): string {
  const identity = createHash("sha256")
    .update(file.relativePath)
    .digest("hex")
    .slice(0, 16);
  return `${identity}-${file.sha256}.json`;
}

function quarantineArtifact(file: ConsumedOutputLedgerEpochFilePlan) {
  return {
    schemaVersion: 1,
    status: "quarantined_unrecoverable_legacy_evidence",
    sourceRelativePath: file.relativePath,
    sourceSha256: file.sha256,
    sourceSize: file.size,
    reason: file.quarantineReason,
    valid: false,
    repaired: false,
  };
}

async function removeOwnedStaging(path: string, ownerToken: string): Promise<void> {
  try {
    const owner: unknown = JSON.parse(
      await readFile(join(path, ".epoch-owner.json"), "utf8"),
    );
    if (!isRecord(owner) || owner.ownerToken !== ownerToken) return;
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function assertPlanHash(
  plan: ConsumedOutputLedgerEpochPlan,
  expectedPlanSha256: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256)) {
    throw new Error("ledger_epoch_expected_plan_sha256_invalid");
  }
  const { planSha256, ...unsigned } = plan;
  if (
    sha256Json(unsigned) !== planSha256 ||
    planSha256 !== expectedPlanSha256
  ) {
    throw new Error("ledger_epoch_plan_hash_mismatch");
  }
}

function treeHash(files: readonly ConsumedOutputLedgerEpochFilePlan[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readHardenedFile(path)).digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function assertFileHash(path: string, expected: string): Promise<void> {
  if (await sha256File(path) !== expected) {
    throw new Error("ledger_epoch_seed_hash_mismatch");
  }
}

async function writeJsonExact(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await durableReplaceEpochJson(path, value);
}

async function writeFileFromHardenedSource(
  source: string,
  target: string,
  expectedSha256: string,
): Promise<void> {
  const bytes = await readHardenedFile(source);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("ledger_epoch_source_hash_drift");
  }
  await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
}

async function readHardenedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("ledger_epoch_non_regular_file_denied");
    if (metadata.size > MAX_LEDGER_FILE_BYTES) {
      throw new Error("ledger_epoch_file_too_large");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function normalizedCutoff(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("ledger_epoch_cutoff_invalid");
  return new Date(time).toISOString();
}

function uniqueResolvedRoots(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))];
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
