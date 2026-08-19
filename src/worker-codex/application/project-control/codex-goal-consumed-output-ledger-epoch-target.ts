import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ConsumedOutputLedgerEpochPlan } from
  "@vioxen/subscription-runtime/worker-core";
import type { ConsumedOutputLedgerEpochLegacyAdmissionAnchor } from
  "@vioxen/subscription-runtime/worker-core";
import type { LegacyAttemptProcessEvidence } from
  "./codex-goal-legacy-attempt-process-evidence";
import type { LedgerEpochDebtCustodyBinding } from
  "./codex-goal-consumed-output-ledger-epoch-switch";
import { durableReplaceEpochJson } from
  "./codex-goal-consumed-output-ledger-epoch-durability";

export const LEDGER_EPOCH_INTENT_NAME = ".ledger-epoch-intent.json";
export const LEDGER_EPOCH_V2_SIDECAR_NAME = ".ledger-epoch-v2-sidecar";
const UPGRADE_JOURNAL = ".ledger-epoch-v2-upgrade-journal.json";
const UPGRADE_STAGING = ".ledger-epoch-v2-sidecar.staging";

type LedgerEpochEvidenceSource = {
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly pathSize: (path: string) => Promise<number | undefined>;
  readonly pathSha256: (path: string) => Promise<string | undefined>;
  readonly resolveWorkspacePath: (path: string) => Promise<string | undefined>;
};

export function memoizedLedgerEpochEvidenceSource(
  source: LedgerEpochEvidenceSource,
): LedgerEpochEvidenceSource {
  const pathExists = new Map<string, Promise<boolean>>();
  const pathSizes = new Map<string, Promise<number | undefined>>();
  const pathHashes = new Map<string, Promise<string | undefined>>();
  const workspacePaths = new Map<string, Promise<string | undefined>>();
  return {
    pathExists: async (path) => await memoized(
      pathExists, path, async () => await source.pathExists(path),
    ),
    pathSize: async (path) => await memoized(
      pathSizes, path, async () => await source.pathSize(path),
    ),
    pathSha256: async (path) => await memoized(
      pathHashes, path, async () => await source.pathSha256(path),
    ),
    resolveWorkspacePath: async (path) => await memoized(
      workspacePaths, path, async () => await source.resolveWorkspacePath(path),
    ),
  };
}

function memoized<T>(
  values: Map<string, Promise<T>>,
  path: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = values.get(path);
  if (existing) return existing;
  const pending = load();
  values.set(path, pending);
  return pending;
}

type RootIdentity = {
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
};

export type { LedgerEpochDebtCustodyBinding } from
  "./codex-goal-consumed-output-ledger-epoch-switch";

export async function ledgerEpochIntent(
  plan: ConsumedOutputLedgerEpochPlan,
  physicalRoot: string,
) {
  const targetRoot = await rootIdentity(physicalRoot, plan.newRoot);
  return {
    schemaVersion: 2,
    status: "prepared" as const,
    controllerJobId: plan.controllerJobId,
    projectId: plan.projectId,
    oldRoot: plan.oldRoot,
    newRoot: plan.newRoot,
    epochNumber: plan.epochNumber,
    previousEpochPlanSha256: plan.previousEpochPlanSha256 ?? null,
    oldRootDevice: plan.oldRootDevice,
    oldRootInode: plan.oldRootInode,
    newRootParentDevice: plan.newRootParentDevice,
    newRootParentInode: plan.newRootParentInode,
    targetRoot,
    planSha256: plan.planSha256,
  };
}

export async function assertLedgerEpochTargetIdentity(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<void> {
  const intent = await readJson(join(plan.newRoot, LEDGER_EPOCH_INTENT_NAME));
  if (!isRecord(intent) || intent.schemaVersion !== 2 ||
    intent.planSha256 !== plan.planSha256 || !isRootIdentity(intent.targetRoot)
  ) throw new Error("ledger_epoch_intent_invalid");
  const expected = intent.targetRoot;
  const actual = await rootIdentity(plan.newRoot, plan.newRoot);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("ledger_epoch_target_root_identity_drift");
  }
}

export type PreparedEpochUpgradeResult = {
  readonly upgraded: boolean;
  readonly upgradeSha256?: string;
};

export function preparedEpochV1ArtifactNames(
  plan: ConsumedOutputLedgerEpochPlan,
): readonly string[] {
  return [
    "intent.json",
    ...plan.orphanWorkspaceBindings.map((_, index) => sourceOrphanName(index)),
    "plan.json",
    "owner.json",
    "state.json",
    "receipt.json",
    "manifest.json",
  ];
}

/**
 * Upgrade an immutable prepared v1 root by publishing only v2 sidecars. Each
 * deterministic file and journal cursor is independently resumable.
 */
export async function upgradePreparedEpochV1(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly legacyAdmission?: ConsumedOutputLedgerEpochLegacyAdmissionAnchor;
  readonly debtCustody: readonly LedgerEpochDebtCustodyBinding[];
  readonly processEvidence: LegacyAttemptProcessEvidence;
  readonly expectedPlanSha256: string;
  readonly crashAfter?: string;
  readonly crashBoundary?: (boundary: string) => void;
}): Promise<PreparedEpochUpgradeResult> {
  if (input.plan.transactionVersion === 2) return { upgraded: false };
  if (input.plan.planSha256 !== input.expectedPlanSha256) {
    throw new Error("ledger_epoch_upgrade_plan_hash_mismatch");
  }
  if (input.processEvidence.blockers.length > 0) {
    throw new Error("ledger_epoch_upgrade_process_custody_active");
  }
  const root = resolve(input.plan.newRoot);
  const finalPath = join(root, LEDGER_EPOCH_V2_SIDECAR_NAME);
  const stagingPath = join(root, UPGRADE_STAGING);
  const journalPath = join(root, UPGRADE_JOURNAL);
  if (await pathExists(finalPath)) {
    const existing = await readCompleteUpgradeManifest({
      plan: input.plan,
      processEvidence: input.processEvidence,
      ...(input.legacyAdmission
        ? { legacyAdmission: input.legacyAdmission }
        : {}),
      debtCustody: input.debtCustody,
      requireIntent: false,
    });
    await writeExactOrVerify(
      join(root, LEDGER_EPOCH_INTENT_NAME),
      await ledgerEpochIntent(input.plan, root),
    );
    reachUpgradeCrashBoundary(input, "intent");
    await assertPreparedEpochV2Sidecar(
      input.plan,
      input.processEvidence,
      input.legacyAdmission,
      input.debtCustody,
    );
    return { upgraded: false, upgradeSha256: existing.upgradeSha256 as string };
  }
  const targetRoot = await rootIdentity(root, root);
  const sourceOrphans = input.plan.orphanWorkspaceBindings.map((binding) =>
    JSON.stringify(binding)
  ).sort();
  const targetOrphans = await directoryFileInventory(
    join(root, "workspace-quarantine"),
  );
  const intent = await ledgerEpochIntent(input.plan, root);
  const snapshots = await Promise.all([
    immutableSnapshot(root, "ledger-epoch-plan.json", true),
    immutableSnapshot(root, ".epoch-owner.json", true),
    immutableSnapshot(root, "ledger-epoch-state.json", true),
    immutableSnapshot(root, "ledger-epoch-receipt.json", false),
  ]);
  if (snapshots[3]?.present !== false) {
    throw new Error("ledger_epoch_upgrade_prepared_receipt_present");
  }
  const manifest = {
    schemaVersion: 2,
    status: "prepared_v1_upgraded" as const,
    planSha256: input.plan.planSha256,
    history: {
      epochNumber: input.plan.epochNumber,
      genesisOldRootHash: input.plan.genesisOldRootHash,
      previousEpochPlanSha256: input.plan.previousEpochPlanSha256 ?? null,
    },
    sourceOrphansSha256: sha256(sourceOrphans.join("\n")),
    targetOrphansSha256: sha256(targetOrphans.join("\n")),
    processEvidence: input.processEvidence,
    ...(input.legacyAdmission ? { legacyAdmission: input.legacyAdmission } : {}),
    debtCustody: input.debtCustody,
    targetRoot,
    intentSha256: sha256Json(intent),
    snapshots,
  };
  const upgradeSha256 = sha256Json(manifest);
  const files = [
    ["intent.json", intent],
    ...sourceOrphans.map((value, index) => [
      sourceOrphanName(index),
      JSON.parse(value) as unknown,
    ] as const),
    ["plan.json", snapshots[0]],
    ["owner.json", snapshots[1]],
    ["state.json", snapshots[2]],
    ["receipt.json", snapshots[3]],
    ["manifest.json", { ...manifest, upgradeSha256 }],
  ] as const;
  const expectedStagedBoundaries = preparedEpochV1UpgradeCrashBoundaries(
    sourceOrphans.length,
  ).slice(0, -2);
  if (JSON.stringify(files.map(([name]) => name)) !==
    JSON.stringify(expectedStagedBoundaries)) {
    throw new Error("ledger_epoch_upgrade_crash_inventory_drift");
  }
  await mkdir(stagingPath, { recursive: true, mode: 0o700 });
  let next = await upgradeCursor(journalPath, upgradeSha256);
  for (let index = 0; index < files.length; index += 1) {
    const [name, value] = files[index]!;
    if (index >= next) {
      await writeExactOrVerify(join(stagingPath, name), value);
      next = index + 1;
      // The cursor is only a bounded replay optimization: exact immutable
      // writes make replay from an earlier checkpoint safe. Checkpointing a
      // batch avoids hundreds of directory-syncing journal replacements while
      // limiting recovery verification to at most fifteen files.
      if (next % 16 === 0 || next === files.length) {
        await durableReplaceEpochJson(journalPath, {
          schemaVersion: 1,
          planSha256: input.plan.planSha256,
          upgradeSha256,
          next,
          fileCount: files.length,
        });
      }
      reachUpgradeCrashBoundary(input, name);
    }
  }
  // The durable cursor makes earlier entries immutable progress. Revalidating
  // every prior entry on every resume makes the public-handler crash matrix
  // quadratic; verify the complete prefix once at the commit boundary instead.
  for (const [name, value] of files) {
    await writeExactOrVerify(join(stagingPath, name), value);
  }
  if (await pathExists(finalPath)) {
    throw new Error("ledger_epoch_upgrade_final_target_not_empty");
  }
  await rename(stagingPath, finalPath);
  reachUpgradeCrashBoundary(input, "final-sidecar");
  await writeExactOrVerify(join(root, LEDGER_EPOCH_INTENT_NAME), intent);
  reachUpgradeCrashBoundary(input, "intent");
  await durableReplaceEpochJson(journalPath, {
    schemaVersion: 1,
    planSha256: input.plan.planSha256,
    upgradeSha256,
    next: files.length,
    fileCount: files.length,
    complete: true,
  });
  await assertPreparedEpochV2Sidecar(
    input.plan,
    input.processEvidence,
    input.legacyAdmission,
    input.debtCustody,
  );
  return { upgraded: true, upgradeSha256 };
}

function reachUpgradeCrashBoundary(
  input: {
    readonly crashAfter?: string;
    readonly crashBoundary?: (boundary: string) => void;
  },
  boundary: string,
): void {
  input.crashBoundary?.(boundary);
  if (input.crashAfter === boundary) {
    throw new Error(`ledger_epoch_simulated_upgrade_crash:${boundary}`);
  }
}

export function preparedEpochV1UpgradeCrashBoundaries(
  sourceOrphanCount: number,
): readonly string[] {
  return [
    "intent.json",
    ...Array.from({ length: sourceOrphanCount }, (_, index) =>
      sourceOrphanName(index)
    ),
    "plan.json",
    "owner.json",
    "state.json",
    "receipt.json",
    "manifest.json",
    "final-sidecar",
    "intent",
  ];
}

export async function assertPreparedEpochV2Sidecar(
  plan: ConsumedOutputLedgerEpochPlan,
  processEvidence?: LegacyAttemptProcessEvidence,
  legacyAdmission?: ConsumedOutputLedgerEpochLegacyAdmissionAnchor,
  debtCustody?: readonly LedgerEpochDebtCustodyBinding[],
): Promise<void> {
  if (plan.transactionVersion === 2) {
    await assertLedgerEpochTargetIdentity(plan);
    return;
  }
  await readCompleteUpgradeManifest({
    plan,
    ...(processEvidence ? { processEvidence } : {}),
    ...(legacyAdmission ? { legacyAdmission } : {}),
    ...(debtCustody ? { debtCustody } : {}),
    requireIntent: true,
  });
  await assertLedgerEpochTargetIdentity(plan);
}

async function readCompleteUpgradeManifest(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly processEvidence?: LegacyAttemptProcessEvidence;
  readonly legacyAdmission?: ConsumedOutputLedgerEpochLegacyAdmissionAnchor;
  readonly debtCustody?: readonly LedgerEpochDebtCustodyBinding[];
  readonly requireIntent: boolean;
}): Promise<Record<string, unknown>> {
  const root = resolve(input.plan.newRoot);
  let manifest: unknown;
  try {
    manifest = await readJson(join(root, LEDGER_EPOCH_V2_SIDECAR_NAME, "manifest.json"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error("ledger_epoch_upgrade_sidecar_partial");
    }
    throw error;
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== 2 ||
    manifest.planSha256 !== input.plan.planSha256 ||
    typeof manifest.upgradeSha256 !== "string"
  ) throw new Error("ledger_epoch_upgrade_sidecar_invalid");
  const { upgradeSha256, ...unsigned } = manifest;
  if (sha256Json(unsigned) !== upgradeSha256) {
    throw new Error("ledger_epoch_upgrade_sidecar_hash_mismatch");
  }
  if (!isRootIdentity(manifest.targetRoot) || JSON.stringify(manifest.targetRoot) !==
      JSON.stringify(await rootIdentity(root, input.plan.newRoot))) {
    throw new Error("ledger_epoch_target_root_identity_drift");
  }
  const sourceOrphans = input.plan.orphanWorkspaceBindings.map((binding) =>
    JSON.stringify(binding)
  ).sort();
  const expectedNames = [
    "intent.json",
    ...sourceOrphans.map((_, index) =>
      sourceOrphanName(index)
    ),
    "plan.json",
    "owner.json",
    "state.json",
    "receipt.json",
    "manifest.json",
  ].sort();
  const actualNames = (await readdir(join(root, LEDGER_EPOCH_V2_SIDECAR_NAME))).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("ledger_epoch_upgrade_sidecar_partial");
  }
  for (let index = 0; index < sourceOrphans.length; index += 1) {
    const actual = await readJson(join(
      root,
      LEDGER_EPOCH_V2_SIDECAR_NAME,
      sourceOrphanName(index),
    ));
    if (JSON.stringify(actual) !== sourceOrphans[index]) {
      throw new Error("ledger_epoch_upgrade_sidecar_drift");
    }
  }
  const sidecarIntent = await readJson(join(
    root,
    LEDGER_EPOCH_V2_SIDECAR_NAME,
    "intent.json",
  ));
  if (sha256Json(sidecarIntent) !== manifest.intentSha256) {
    throw new Error("ledger_epoch_upgrade_sidecar_drift");
  }
  const targetOrphans = await directoryFileInventory(
    join(root, "workspace-quarantine"),
  );
  if (manifest.sourceOrphansSha256 !== sha256(sourceOrphans.join("\n")) ||
    manifest.targetOrphansSha256 !== sha256(targetOrphans.join("\n")) ||
    manifest.intentSha256 !== sha256Json(
      await ledgerEpochIntent(input.plan, input.plan.newRoot),
    )
  ) throw new Error("ledger_epoch_upgrade_provenance_drift");
  if (!Array.isArray(manifest.snapshots)) {
    throw new Error("ledger_epoch_upgrade_provenance_invalid");
  }
  for (const [sidecarName, snapshotName] of [
    ["plan.json", "ledger-epoch-plan.json"],
    ["owner.json", ".epoch-owner.json"],
    ["state.json", "ledger-epoch-state.json"],
    ["receipt.json", "ledger-epoch-receipt.json"],
  ] as const) {
    const expected = manifest.snapshots.find((value) =>
      isRecord(value) && value.name === snapshotName
    );
    if (!expected || JSON.stringify(await readJson(join(
      root,
      LEDGER_EPOCH_V2_SIDECAR_NAME,
      sidecarName,
    ))) !== JSON.stringify(expected)) {
      throw new Error("ledger_epoch_upgrade_sidecar_drift");
    }
  }
  for (const name of ["ledger-epoch-plan.json", ".epoch-owner.json"]) {
    const expected = manifest.snapshots.find((value) =>
      isRecord(value) && value.name === name
    );
    const actual = await immutableSnapshot(root, name, true);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error("ledger_epoch_upgrade_provenance_drift");
    }
  }
  const state = await readJson(join(root, "ledger-epoch-state.json"));
  if (isRecord(state) && state.phase === "prepared") {
    for (const [name, required] of [
      ["ledger-epoch-state.json", true],
      ["ledger-epoch-receipt.json", false],
    ] as const) {
      const expected = manifest.snapshots.find((value) =>
        isRecord(value) && value.name === name
      );
      if (!expected || JSON.stringify(expected) !== JSON.stringify(
        await immutableSnapshot(root, name, required),
      )) throw new Error("ledger_epoch_upgrade_provenance_drift");
    }
  }
  if (input.processEvidence) {
    const stored = manifest.processEvidence;
    if (!isRecord(stored) ||
      stored.inventorySha256 !== input.processEvidence.inventorySha256 ||
      stored.inspectedPidCount !== input.processEvidence.inspectedPidCount ||
      JSON.stringify(stored.custodyPaths) !==
        JSON.stringify(input.processEvidence.custodyPaths) ||
      JSON.stringify(stored.blockers) !== JSON.stringify(input.processEvidence.blockers)
    ) throw new Error("ledger_epoch_process_inventory_drift");
  }
  if (input.legacyAdmission && JSON.stringify(manifest.legacyAdmission) !==
      JSON.stringify(input.legacyAdmission)) {
    throw new Error("ledger_epoch_upgrade_legacy_admission_drift");
  }
  if (!input.legacyAdmission && "legacyAdmission" in manifest) {
    throw new Error("ledger_epoch_upgrade_legacy_admission_drift");
  }
  if (input.debtCustody && JSON.stringify(manifest.debtCustody) !==
      JSON.stringify(input.debtCustody)) {
    throw new Error("ledger_epoch_upgrade_debt_custody_drift");
  }
  if (input.requireIntent) {
    const intent = await readJson(join(root, LEDGER_EPOCH_INTENT_NAME));
    if (sha256Json(intent) !== manifest.intentSha256) {
      throw new Error("ledger_epoch_intent_invalid");
    }
  }
  return manifest;
}

export async function resolvePreparedEpochUpgradeSha256(
  plan: ConsumedOutputLedgerEpochPlan,
): Promise<string | undefined> {
  if (plan.transactionVersion === 2) return undefined;
  const manifest = await readJson(join(
    resolve(plan.newRoot),
    LEDGER_EPOCH_V2_SIDECAR_NAME,
    "manifest.json",
  ));
  if (!isRecord(manifest) || typeof manifest.upgradeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.upgradeSha256)) {
    throw new Error("ledger_epoch_upgrade_sidecar_invalid");
  }
  return manifest.upgradeSha256;
}

export async function assertUnusedEpochTarget(root: string): Promise<void> {
  try {
    await lstat(root);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("ledger_epoch_unowned_target_refused");
}

export async function assertNoAbandonedEpochStagingRoots(
  targetRoot: string,
): Promise<void> {
  const parent = dirname(targetRoot);
  const prefix = `.${basename(targetRoot)}.staging-`;
  const entries = await readdir(parent, { withFileTypes: true });
  if (entries.some((entry) => entry.name.startsWith(prefix))) {
    throw new Error("ledger_epoch_abandoned_staging_root_refused");
  }
}

async function rootIdentity(path: string, finalPath: string): Promise<RootIdentity> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("ledger_epoch_target_root_alias_denied");
  }
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) {
    throw new Error("ledger_epoch_target_root_alias_denied");
  }
  return { canonicalPath: resolve(finalPath), device: metadata.dev, inode: metadata.ino };
}

async function immutableSnapshot(root: string, name: string, required: boolean) {
  try {
    const bytes = await readFile(join(root, name));
    return { name, present: true as const, size: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (!required && isNodeError(error, "ENOENT")) {
      return { name, present: false as const };
    }
    throw error;
  }
}

async function directoryFileInventory(root: string): Promise<readonly string[]> {
  try {
    const names = (await readdir(root)).sort();
    return await Promise.all(names.map(async (name) => {
      const bytes = await readFile(join(root, name));
      return `${name}\0${bytes.length}\0${sha256(bytes)}`;
    }));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function upgradeCursor(path: string, upgradeSha256: string): Promise<number> {
  try {
    const value = await readJson(path);
    if (!isRecord(value) || value.upgradeSha256 !== upgradeSha256 ||
      !Number.isSafeInteger(value.next)) {
      throw new Error("ledger_epoch_upgrade_journal_drift");
    }
    return value.next as number;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
}

async function writeExactOrVerify(path: string, value: unknown): Promise<void> {
  const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  try {
    await writeFile(path, expected, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    if (!(await readFile(path)).equals(expected)) {
      throw new Error("ledger_epoch_upgrade_staging_drift");
    }
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function sourceOrphanName(index: number): string {
  return `source-orphan-${String(index).padStart(4, "0")}.json`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function isRootIdentity(value: unknown): value is RootIdentity {
  return isRecord(value) && typeof value.canonicalPath === "string" &&
    typeof value.device === "number" && typeof value.inode === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
