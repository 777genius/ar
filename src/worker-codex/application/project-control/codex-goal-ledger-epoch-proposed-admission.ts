import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ProjectDebtReason,
  summarizeProjectAdmissionDebt,
  type ConsumedOutputLedgerEpochPlan,
  type ConsumedOutputLedgerEpochReceipt,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import type { LedgerEpochDebtCustodyBinding } from
  "./codex-goal-consumed-output-ledger-epoch-switch";
import { LEDGER_EPOCH_V2_SIDECAR_NAME } from
  "./codex-goal-consumed-output-ledger-epoch-target";

export const SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 =
  "e8d9c821ddf973b11796b2780f2adb1b22760291650998dfb7b0f41ce7c1ea99";
export const LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR =
  ".ledger-epoch-proposed-admission-v1";
const STAGING_SUFFIX = ".staging";
const EXPECTED_SHA_NAME = "expected-anchor-sha256";
const HISTORICAL_ALIAS =
  "social-monitor-x-attribution-reuse-fixture-integration-v1-20260719";
const HISTORICAL_ALIAS_PATH =
  "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-integration-v1-20260719";
const HISTORICAL_WORKER_JOB =
  "social-monitor-x-attribution-reuse-fixture-ci-v1-20260719";
const HISTORICAL_SOURCE_WORKSPACE =
  "/var/data/social-monitor/worktrees/social-monitor-x-attribution-reuse-fixture-ci-v1-20260719";
const HISTORICAL_ATTEMPT_ID =
  "social-monitor-x-attribution-reuse-fixture-integration-20260719-001";
const HISTORICAL_COMMIT = "6c0129f655a056da0832355c5f8733a4e1daa4ff";
const HISTORICAL_ARCHIVE_NAME =
  "social-monitor-x-attribution-reuse-fixture-ci-v1-20260719-integrated-6c0129f655a0-social-monitor-x-attribution-reuse-fixture-integration-20260719-001";
const ITEM_RELATIVE_PATH =
  `items/${HISTORICAL_WORKER_JOB}--${HISTORICAL_ATTEMPT_ID}.json`;
const PREPARATION_RELATIVE_PATH = `preparations/${HISTORICAL_ATTEMPT_ID}.json`;
const ITEM_SHA256 = "d230f4ceed015a5f9a9ccc207f62418a3495fb54ae7ec8c02df9a794d7765b4d";
const PREPARATION_SHA256 =
  "55e2a0824804d6db0a9a5698fe5ef84b453c9a8a6e21ed373748536048ecb523";
const ATTEMPT_SHA256 = "e54f8f26db111df27bdc0b3773942c53eb0a8a278c2f7c9c9fea48b3604068a8";
const ARCHIVE_FILE_CONSTANTS = {
  "git-status.txt": { size: 70, sha256:
    "6e3b8a86eebeb8e0ce448ead56ecfccd326f8c2d491131cab331ba195029fe00" },
  "tracked.diff": { size: 1019, sha256:
    "3a90d2c4fd6dfdb0a4ddd26c2d11b5594a833fd2a93e811e213e38e8a0eabfc5" },
  "tracked.numstat": { size: 72, sha256:
    "ed87382617904c748408aa0e89832e323941a255f44e5336381c57e4baf06d35" },
} as const;
const EXPECTED_BLOCKING = {
  [ProjectDebtReason.ActiveWriterConflict]: 6,
  [ProjectDebtReason.InactiveDirtyWorkspace]: 4,
  [ProjectDebtReason.OrphanLegacyWorkspace]: 205,
  [ProjectDebtReason.UnconsumedCompletedJob]: 495,
} as const;
const EXPECTED_ALL = {
  [ProjectDebtReason.ActiveWriterConflict]: 6,
  [ProjectDebtReason.InactiveDirtyWorkspace]: 4,
  [ProjectDebtReason.LegacyOutputQuarantineRequired]: 1738,
  [ProjectDebtReason.OrphanLegacyWorkspace]: 205,
  [ProjectDebtReason.UnconsumedCompletedJob]: 495,
} as const;

type FileBinding = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
};

type PlanFileBinding = {
  readonly planRecord: ConsumedOutputLedgerEpochPlan["files"][number];
  readonly planRecordSha256: string;
  readonly preserved: FileBinding;
};

export type LedgerEpochProposedAdmissionAnchor = {
  readonly schemaVersion: 1;
  readonly planSha256: typeof SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256;
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly cutoff: string;
  readonly debtCount: 2448;
  readonly blockingDebtCount: 710;
  readonly infoDebtCount: 1738;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly debt: readonly ProjectDebtItem[];
  readonly debtItemSha256: readonly string[];
  readonly blockingDebtItemSha256: readonly string[];
  readonly debtSha256: string;
  readonly debtCustody: readonly LedgerEpochDebtCustodyBinding[];
  readonly debtCustodySha256: string;
  readonly sourceOrphanBindingSha256: readonly string[];
  readonly sourceOrphanBindingsSha256: string;
  readonly sourceOrphanBindings: readonly Record<string, unknown>[];
  readonly sourceOrphanBindingCount: 205;
  readonly historicalAlias: {
    readonly name: typeof HISTORICAL_ALIAS;
    readonly targetWorkspacePath: typeof HISTORICAL_ALIAS_PATH;
    readonly workerJobId: typeof HISTORICAL_WORKER_JOB;
    readonly sourceWorkspacePath: typeof HISTORICAL_SOURCE_WORKSPACE;
    readonly attemptId: typeof HISTORICAL_ATTEMPT_ID;
    readonly commitSha: typeof HISTORICAL_COMMIT;
    readonly item: PlanFileBinding;
    readonly preparation: PlanFileBinding;
    readonly archiveEvidenceBindings:
      readonly ConsumedOutputLedgerEpochPlan["evidenceBindings"][number][];
    readonly archiveEvidenceBindingsSha256: string;
    readonly archiveRoot: string;
    readonly gitStatus: FileBinding;
    readonly trackedDiff: FileBinding;
    readonly trackedNumstat: FileBinding;
    readonly pushedAttempt: FileBinding;
  };
  readonly anchorSha256: string;
};

export async function createOrVerifySocialProposedAdmissionAnchor(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly controllerJobRootDir: string;
  readonly debtCustody: readonly LedgerEpochDebtCustodyBinding[];
  readonly sourceOrphanSeal: PreparedV1SourceOrphanSeal;
  readonly expectedAnchorSha256: string;
}): Promise<LedgerEpochProposedAdmissionAnchor | undefined> {
  if (input.plan.planSha256 !== SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) return undefined;
  assertSha256(input.expectedAnchorSha256,
    "ledger_epoch_proposed_admission_expected_anchor_sha256_required");
  const existing = await readSocialProposedAdmissionAnchor(
    input.plan,
    input.expectedAnchorSha256,
  );
  if (existing) {
    assertSocialProposedAdmissionSourceOrphanSeal(existing, input.sourceOrphanSeal);
    await verifySocialProposedAdmissionAnchorEvidence(existing);
    assertSocialProposedAdmissionDebtCustody(existing, input.debtCustody);
    normalizeAnchoredProposedAdmission({ anchor: existing, snapshot: input.snapshot });
    return existing;
  }
  const anchor = await buildSocialProposedAdmissionAnchor(input);
  if (!anchor) return undefined;
  if (anchor.anchorSha256 !== input.expectedAnchorSha256) {
    throw new Error("ledger_epoch_proposed_admission_expected_anchor_hash_mismatch");
  }
  await publishCreateOnce(input.plan.newRoot, anchor);
  return anchor;
}

export async function buildSocialProposedAdmissionAnchor(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly controllerJobRootDir: string;
  readonly debtCustody: readonly LedgerEpochDebtCustodyBinding[];
  readonly sourceOrphanSeal: PreparedV1SourceOrphanSeal;
}): Promise<LedgerEpochProposedAdmissionAnchor | undefined> {
  if (input.plan.planSha256 !== SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) return undefined;
  assertNoUnreadableWorkspace(input.snapshot.debt);
  assertExactEnvelope(input.plan, input.snapshot);
  const blocking = input.snapshot.debt.filter(isBlocking);
  const historicalAlias = await bindHistoricalAlias({
    plan: input.plan,
  });
  assertDebtCustody(blocking, input.debtCustody);
  const canonical = canonicalDebt(input.snapshot.debt);
  const debtItemSha256 = canonical.map(debtHash).sort();
  const blockingDebtItemSha256 = blocking.map(debtHash).sort();
  const categoryCounts = categoryCountsFor(input.snapshot.debt);
  const unsigned = {
    schemaVersion: 1 as const,
    planSha256: SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 as
      typeof SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256,
    controllerJobId: input.plan.controllerJobId,
    projectId: input.plan.projectId,
    oldRoot: input.plan.oldRoot,
    newRoot: input.plan.newRoot,
    cutoff: input.plan.cutoff,
    debtCount: 2448 as const,
    blockingDebtCount: 710 as const,
    infoDebtCount: 1738 as const,
    categoryCounts,
    debt: canonical,
    debtItemSha256,
    blockingDebtItemSha256,
    debtSha256: sha256Json(canonical),
    debtCustody: input.debtCustody,
    debtCustodySha256: sha256Json(input.debtCustody),
    sourceOrphanBindingSha256: input.sourceOrphanSeal.bindingSha256,
    sourceOrphanBindingsSha256: input.sourceOrphanSeal.bindingsSha256,
    sourceOrphanBindings: input.sourceOrphanSeal.bindings,
    sourceOrphanBindingCount: 205 as const,
    historicalAlias,
  };
  const anchor: LedgerEpochProposedAdmissionAnchor = {
    ...unsigned,
    anchorSha256: sha256Json(unsigned),
  };
  return anchor;
}

export type PreparedV1SourceOrphanSeal = {
  readonly bindings: readonly Record<string, unknown>[];
  readonly bindingSha256: readonly string[];
  readonly bindingsSha256: string;
};

export function assertSocialProposedAdmissionSourceOrphanSeal(
  anchor: LedgerEpochProposedAdmissionAnchor,
  seal: PreparedV1SourceOrphanSeal,
): void {
  if (anchor.sourceOrphanBindingsSha256 !== seal.bindingsSha256 ||
    JSON.stringify(anchor.sourceOrphanBindings) !== JSON.stringify(seal.bindings) ||
    JSON.stringify(anchor.sourceOrphanBindingSha256) !==
      JSON.stringify(seal.bindingSha256)) {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_anchor_drift");
  }
}

/** Verify the immutable legacy v2 sidecar against its plan-bound source records. */
export async function verifySocialPreparedV1SourceOrphanSeal(
  plan: ConsumedOutputLedgerEpochPlan | ConsumedOutputLedgerEpochReceipt,
): Promise<PreparedV1SourceOrphanSeal> {
  if (plan.planSha256 !== SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) {
    throw new Error("ledger_epoch_proposed_admission_plan_mismatch");
  }
  const root = join(resolve(plan.newRoot), LEDGER_EPOCH_V2_SIDECAR_NAME);
  const manifest = await readJsonRecord(join(root, "manifest.json"));
  const upgradeSha256 = manifest.upgradeSha256;
  if (manifest.schemaVersion !== 2 || manifest.planSha256 !== plan.planSha256 ||
    typeof upgradeSha256 !== "string") {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_manifest_invalid");
  }
  const { upgradeSha256: ignored, ...unsigned } = manifest;
  void ignored;
  if (sha256Json(unsigned) !== upgradeSha256) {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_manifest_hash_mismatch");
  }
  const expectedCanonical = plan.orphanWorkspaceBindings.map((binding) =>
    JSON.stringify(binding)
  ).sort();
  const sourceNames = expectedCanonical.map((_, index) =>
    `source-orphan-${String(index).padStart(4, "0")}.json`
  );
  const expectedNames = [
    "intent.json", ...sourceNames, "plan.json", "owner.json", "state.json",
    "receipt.json", "manifest.json",
  ].sort();
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_sidecar_partial");
  }
  const bindings = await Promise.all(sourceNames.map(async (name) =>
    await readJsonRecord(join(root, name))
  ));
  const canonical = bindings.map((binding) => JSON.stringify(binding));
  if (JSON.stringify(canonical) !== JSON.stringify(expectedCanonical)) {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
  }
  if (manifest.sourceOrphansSha256 !== sha256(canonical.join("\n"))) {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_seal_mismatch");
  }
  const intent = await readJsonRecord(join(root, "intent.json"));
  if (manifest.intentSha256 !== sha256Json(intent)) {
    throw new Error("ledger_epoch_proposed_admission_source_orphan_intent_mismatch");
  }
  return {
    bindings: canonical.map((value) => JSON.parse(value) as Record<string, unknown>),
    bindingSha256: canonical.map((value) => sha256(value)),
    bindingsSha256: manifest.sourceOrphansSha256,
  };
}

export async function readSocialProposedAdmissionAnchor(
  plan: ConsumedOutputLedgerEpochPlan | ConsumedOutputLedgerEpochReceipt,
  expectedAnchorSha256?: string,
): Promise<LedgerEpochProposedAdmissionAnchor | undefined> {
  if (plan.planSha256 !== SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256) return undefined;
  const path = join(plan.newRoot, LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR, "anchor.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  const expected = expectedAnchorSha256 ?? (await readFile(join(
    plan.newRoot,
    LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR,
    EXPECTED_SHA_NAME,
  ), "utf8")).trim();
  assertSha256(expected, "ledger_epoch_proposed_admission_expected_anchor_token_invalid");
  const anchor = assertAnchor(value, plan, expected);
  const names = (await readdir(join(
    plan.newRoot,
    LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR,
  ))).sort();
  if (JSON.stringify(names) !== JSON.stringify([EXPECTED_SHA_NAME, "anchor.json"].sort())) {
    throw new Error("ledger_epoch_proposed_admission_anchor_partial");
  }
  return anchor;
}

export function assertSocialProposedAdmissionDebtCustody(
  anchor: LedgerEpochProposedAdmissionAnchor,
  current: readonly LedgerEpochDebtCustodyBinding[],
): void {
  assertCustodyShape(anchor.debtCustody);
  if (sha256Json(anchor.debtCustody) !== anchor.debtCustodySha256) {
    throw new Error("ledger_epoch_proposed_admission_custody_anchor_hash_mismatch");
  }
  const anchored = multiset(anchor.debtCustody.map((binding) =>
    sha256Json(binding)
  ));
  for (const binding of current) {
    assertCustodyShape([binding]);
    const hash = sha256Json(binding);
    const count = anchored.get(hash) ?? 0;
    if (count === 0) {
      throw new Error("ledger_epoch_proposed_admission_custody_drift");
    }
    anchored.set(hash, count - 1);
  }
}

/** Downgrade only byte-identical anchored blocking items. Missing anchored debt is allowed. */
export function normalizeAnchoredProposedAdmission(input: {
  readonly anchor: LedgerEpochProposedAdmissionAnchor;
  readonly snapshot: ProjectAdmissionSnapshot;
}): ProjectAdmissionSnapshot {
  assertNoUnreadableWorkspace(input.snapshot.debt);
  const allRemaining = multiset(input.anchor.debtItemSha256);
  const blockingRemaining = multiset(input.anchor.blockingDebtItemSha256);
  const debt = input.snapshot.debt.map((item) => {
    const hash = debtHash(item);
    const allCount = allRemaining.get(hash) ?? 0;
    if (allCount === 0) {
      if (isPostActivationConsumedDirtyWorkspace(input.anchor, item)) return item;
      throw new Error("ledger_epoch_proposed_admission_new_or_changed_debt");
    }
    allRemaining.set(hash, allCount - 1);
    if (!isBlocking(item)) return item;
    const count = blockingRemaining.get(hash) ?? 0;
    if (count === 0) {
      throw new Error("ledger_epoch_proposed_admission_new_or_changed_debt");
    }
    blockingRemaining.set(hash, count - 1);
    return { ...item, severity: "info" as const };
  });
  return { ...input.snapshot, debt, counts: summarizeProjectAdmissionDebt(debt).counts };
}

function isPostActivationConsumedDirtyWorkspace(
  anchor: LedgerEpochProposedAdmissionAnchor,
  item: ProjectDebtItem,
): boolean {
  if (anchor.debt.some((anchored) =>
    anchored.reason === item.reason && anchored.subject === item.subject
  )) return false;
  if (item.reason !== ProjectDebtReason.ConsumedDirtyWorkspace ||
    item.severity !== "info") return false;
  const integrated = item.evidence.length === 3 && item.evidence[0] ===
      "dirty output consumed by terminal ledger status: integrated" &&
    /^commit: [0-9a-f]{7,40}$/i.test(item.evidence[2] ?? "");
  // The snapshot builder emits rejected debt only after validating its complete backup.
  const rejected = item.evidence.length === 2 && item.evidence[0] ===
    "dirty output consumed by terminal ledger status: rejected";
  if ((!integrated && !rejected) || !item.evidence[1]?.startsWith("ledger: ")) {
    return false;
  }
  const ledgerPath = item.evidence[1].slice("ledger: ".length);
  if (ledgerPath !== resolve(ledgerPath)) return false;
  const child = relative(join(resolve(anchor.newRoot), "items"), ledgerPath);
  return child !== "" && !isAbsolute(child) && child !== ".." &&
    !child.startsWith(`..${sep}`);
}

export async function verifySocialProposedAdmissionAnchorEvidence(
  anchor: LedgerEpochProposedAdmissionAnchor,
): Promise<void> {
  const alias = anchor.historicalAlias;
  for (const binding of [alias.item.preserved, alias.preparation.preserved,
    alias.gitStatus, alias.trackedDiff, alias.trackedNumstat, alias.pushedAttempt]) {
    if (JSON.stringify(await bindFileBytes(binding.path)) !== JSON.stringify(binding)) {
      throw new Error("ledger_epoch_proposed_admission_alias_lineage_drift");
    }
  }
  const item = await readJsonRecord(alias.item.preserved.path);
  const preparation = await readJsonRecord(alias.preparation.preserved.path);
  const attempt = await readJsonRecord(alias.pushedAttempt.path);
  assertHistoricalCrossLinks(alias, item, preparation, attempt);
}

async function publishCreateOnce(
  root: string,
  anchor: LedgerEpochProposedAdmissionAnchor,
): Promise<void> {
  const finalPath = join(root, LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR);
  const existing = await readOptionalAnchor(finalPath);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(anchor)) {
      throw new Error("ledger_epoch_proposed_admission_anchor_drift");
    }
    return;
  }
  const staging = `${finalPath}${STAGING_SUFFIX}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(anchor, null, 2)}\n`;
  const path = join(staging, "anchor.json");
  const expectedPath = join(staging, EXPECTED_SHA_NAME);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST") || await readFile(path, "utf8") !== bytes) {
      throw new Error("ledger_epoch_proposed_admission_staging_drift", { cause: error });
    }
  }
  try {
    await writeFile(expectedPath, `${anchor.anchorSha256}\n`, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST") ||
      await readFile(expectedPath, "utf8") !== `${anchor.anchorSha256}\n`) {
      throw new Error("ledger_epoch_proposed_admission_expected_anchor_staging_drift",
        { cause: error });
    }
  }
  await syncFile(path);
  await syncFile(expectedPath);
  await chmod(path, 0o444);
  await chmod(expectedPath, 0o444);
  await syncDirectory(staging);
  try {
    await rename(staging, finalPath);
  } catch (error) {
    if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOTEMPTY")) throw error;
  }
  const published = await readOptionalAnchor(finalPath);
  if (JSON.stringify(published) !== JSON.stringify(anchor)) {
    throw new Error("ledger_epoch_proposed_admission_anchor_publish_failed");
  }
  await chmod(finalPath, 0o555);
  await syncDirectory(finalPath);
  await syncDirectory(root);
}

async function readOptionalAnchor(root: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(join(root, "anchor.json"), "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertAnchor(
  value: unknown,
  plan: ConsumedOutputLedgerEpochPlan | ConsumedOutputLedgerEpochReceipt,
  expectedAnchorSha256: string,
): LedgerEpochProposedAdmissionAnchor {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
    value.planSha256 !== SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 ||
    value.controllerJobId !== plan.controllerJobId || value.projectId !== plan.projectId ||
    value.oldRoot !== plan.oldRoot || value.newRoot !== plan.newRoot ||
    value.cutoff !== plan.cutoff || value.debtCount !== 2448 ||
    value.blockingDebtCount !== 710 || value.infoDebtCount !== 1738 ||
    value.sourceOrphanBindingCount !== 205 || value.anchorSha256 !== expectedAnchorSha256 ||
    !Array.isArray(value.debt) || !Array.isArray(value.debtItemSha256) ||
    !Array.isArray(value.blockingDebtItemSha256) ||
    !Array.isArray(value.debtCustody) || !Array.isArray(value.sourceOrphanBindingSha256) ||
    !Array.isArray(value.sourceOrphanBindings) ||
    !isRecord(value.categoryCounts)) {
    throw new Error("ledger_epoch_proposed_admission_anchor_invalid");
  }
  const { anchorSha256, ...unsigned } = value;
  if (sha256Json(unsigned) !== anchorSha256) {
    throw new Error("ledger_epoch_proposed_admission_anchor_hash_mismatch");
  }
  if (value.debtItemSha256.length !== 2448 ||
    value.debt.length !== 2448 ||
    value.blockingDebtItemSha256.length !== 710 ||
    value.sourceOrphanBindingSha256.length !== 506 ||
    !value.debtItemSha256.every(isSha256) ||
    !value.blockingDebtItemSha256.every(isSha256) ||
    !value.sourceOrphanBindingSha256.every(isSha256) ||
    !isSha256(value.debtSha256) || !isSha256(value.debtCustodySha256) ||
    !isSha256(value.sourceOrphanBindingsSha256) ||
    JSON.stringify(value.categoryCounts) !== JSON.stringify(EXPECTED_ALL)) {
    throw new Error("ledger_epoch_proposed_admission_anchor_shape_invalid");
  }
  assertCustodyShape(value.debtCustody as LedgerEpochDebtCustodyBinding[]);
  if (sha256Json(value.debtCustody) !== value.debtCustodySha256) {
    throw new Error("ledger_epoch_proposed_admission_custody_anchor_hash_mismatch");
  }
  const debt = canonicalDebt(value.debt as ProjectDebtItem[]);
  const blocking = debt.filter(isBlocking);
  const sourceCanonical = (value.sourceOrphanBindings as Record<string, unknown>[])
    .map((binding) => JSON.stringify(binding)).sort();
  if (JSON.stringify(debt) !== JSON.stringify(value.debt) ||
    JSON.stringify(debt.map(debtHash).sort()) !== JSON.stringify(value.debtItemSha256) ||
    JSON.stringify(blocking.map(debtHash).sort()) !==
      JSON.stringify(value.blockingDebtItemSha256) ||
    sha256Json(debt) !== value.debtSha256 ||
    JSON.stringify(categoryCountsFor(debt)) !== JSON.stringify(value.categoryCounts) ||
    sourceCanonical.length !== 506 ||
    sha256(sourceCanonical.join("\n")) !== value.sourceOrphanBindingsSha256 ||
    JSON.stringify(sourceCanonical.map((binding) => sha256(binding))) !==
      JSON.stringify(value.sourceOrphanBindingSha256)) {
    throw new Error("ledger_epoch_proposed_admission_anchor_nested_hash_mismatch");
  }
  assertHistoricalAliasShape(value.historicalAlias);
  return value as LedgerEpochProposedAdmissionAnchor;
}

function assertCustodyShape(bindings: readonly LedgerEpochDebtCustodyBinding[]): void {
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.reason !== "string" ||
      typeof binding.subject !== "string" || typeof binding.declaredPath !== "string" ||
      typeof binding.canonicalPath !== "string" || typeof binding.device !== "number" ||
      typeof binding.inode !== "number" ||
      (binding.aliasResolutionSha256 !== undefined &&
        !isSha256(binding.aliasResolutionSha256)) ||
      (binding.registryManifest !== undefined &&
        !isCustodyFileBinding(binding.registryManifest)) ||
      binding.jobArtifacts?.some((artifact) => !isCustodyFileBinding(artifact))) {
      throw new Error("ledger_epoch_proposed_admission_custody_anchor_shape_invalid");
    }
  }
}

function isCustodyFileBinding(value: unknown): boolean {
  if (!isRecord(value) || typeof value.path !== "string" ||
    typeof value.present !== "boolean") return false;
  return value.present
    ? typeof value.canonicalPath === "string" && typeof value.device === "number" &&
      typeof value.inode === "number" && typeof value.byteLength === "number" &&
      isSha256(value.sha256)
    : value.canonicalPath === undefined && value.device === undefined &&
      value.inode === undefined && value.byteLength === undefined && value.sha256 === undefined;
}

function assertHistoricalAliasShape(value: unknown): void {
  if (!isRecord(value) || value.name !== HISTORICAL_ALIAS ||
    value.targetWorkspacePath !== HISTORICAL_ALIAS_PATH ||
    value.workerJobId !== HISTORICAL_WORKER_JOB ||
    value.sourceWorkspacePath !== HISTORICAL_SOURCE_WORKSPACE ||
    value.attemptId !== HISTORICAL_ATTEMPT_ID || value.commitSha !== HISTORICAL_COMMIT ||
    !isPlanFileBinding(value.item, expectedItemPlanRecord()) ||
    !isPlanFileBinding(value.preparation, expectedPreparationPlanRecord()) ||
    !Array.isArray(value.archiveEvidenceBindings) ||
    !isSha256(value.archiveEvidenceBindingsSha256) ||
    sha256Json(value.archiveEvidenceBindings) !== value.archiveEvidenceBindingsSha256 ||
    typeof value.archiveRoot !== "string" ||
    JSON.stringify(value.archiveEvidenceBindings) !==
      JSON.stringify(expectedArchiveEvidenceBindings(value.archiveRoot)) ||
    !isExactFileBinding(value.gitStatus, join(value.archiveRoot, "git-status.txt"),
      ARCHIVE_FILE_CONSTANTS["git-status.txt"]) ||
    !isExactFileBinding(value.trackedDiff, join(value.archiveRoot, "tracked.diff"),
      ARCHIVE_FILE_CONSTANTS["tracked.diff"]) ||
    !isExactFileBinding(value.trackedNumstat, join(value.archiveRoot, "tracked.numstat"),
      ARCHIVE_FILE_CONSTANTS["tracked.numstat"]) ||
    !isExactFileBinding(value.pushedAttempt, value.pushedAttempt &&
      isRecord(value.pushedAttempt) ? String(value.pushedAttempt.path) : "", {
        size: 2724, sha256: ATTEMPT_SHA256,
      })) {
    throw new Error("ledger_epoch_proposed_admission_alias_anchor_shape_invalid");
  }
}

function isFileBinding(value: unknown): value is FileBinding {
  return isRecord(value) && typeof value.path === "string" &&
    typeof value.size === "number" && isSha256(value.sha256);
}

function isExactFileBinding(
  value: unknown,
  path: string,
  expected: { readonly size: number; readonly sha256: string },
): boolean {
  return isFileBinding(value) && value.path === path && value.size === expected.size &&
    value.sha256 === expected.sha256;
}

function isPlanFileBinding(
  value: unknown,
  expected: ConsumedOutputLedgerEpochPlan["files"][number],
): boolean {
  return isRecord(value) && JSON.stringify(value.planRecord) === JSON.stringify(expected) &&
    value.planRecordSha256 === sha256Json(expected) && isRecord(value.preserved) &&
    value.preserved.size === expected.size && value.preserved.sha256 === expected.sha256 &&
    typeof value.preserved.path === "string";
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertSha256(value: unknown, message: string): asserts value is string {
  if (!isSha256(value)) throw new Error(message);
}

function assertExactEnvelope(
  plan: ConsumedOutputLedgerEpochPlan,
  snapshot: ProjectAdmissionSnapshot,
): void {
  if (snapshot.projectId !== "social-monitor" || snapshot.projectId !== plan.projectId ||
    snapshot.debt.length !== 2448 || snapshot.debt.filter(isBlocking).length !== 710 ||
    snapshot.debt.filter((item) => !isBlocking(item)).length !== 1738) {
    throw new Error("ledger_epoch_proposed_admission_exact_envelope_mismatch");
  }
  const blockingCounts = categoryCountsFor(snapshot.debt.filter(isBlocking));
  if (JSON.stringify(blockingCounts) !== JSON.stringify(EXPECTED_BLOCKING)) {
    throw new Error("ledger_epoch_proposed_admission_exact_count_mismatch");
  }
  if (JSON.stringify(categoryCountsFor(snapshot.debt)) !==
      JSON.stringify(EXPECTED_ALL)) {
    throw new Error("ledger_epoch_proposed_admission_exact_category_mismatch");
  }
}

function assertDebtCustody(
  debt: readonly ProjectDebtItem[],
  custody: readonly LedgerEpochDebtCustodyBinding[],
): void {
  const expected = multiset(debt.map((item) => `${item.reason}\0${item.subject}`));
  for (const binding of custody) {
    const key = `${binding.reason}\0${binding.subject}`;
    const count = expected.get(key) ?? 0;
    if (count === 0) throw new Error("ledger_epoch_proposed_admission_custody_mismatch");
    expected.set(key, count - 1);
  }
  if ([...expected.values()].some((count) => count !== 0)) {
    throw new Error("ledger_epoch_proposed_admission_custody_incomplete");
  }
}

async function bindHistoricalAlias(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
}): Promise<LedgerEpochProposedAdmissionAnchor["historicalAlias"]> {
  const itemRecord = uniquePlanFile(input.plan, ITEM_RELATIVE_PATH,
    expectedItemPlanRecord());
  const preparationRecord = uniquePlanFile(input.plan, PREPARATION_RELATIVE_PATH,
    expectedPreparationPlanRecord());
  const archiveRoots = input.plan.evidenceBindings.filter((binding) =>
    binding.declaredPath.endsWith(`/${HISTORICAL_ARCHIVE_NAME}`)
  );
  if (archiveRoots.length !== 1) {
    throw new Error("ledger_epoch_proposed_admission_archive_plan_binding_mismatch");
  }
  const archiveRoot = archiveRoots[0]!.declaredPath;
  const archiveEvidenceBindings = expectedArchiveEvidenceBindings(archiveRoot);
  const actualArchiveBindings = input.plan.evidenceBindings.filter((binding) =>
    binding.declaredPath === archiveRoot || binding.declaredPath.startsWith(`${archiveRoot}/`)
  );
  if (JSON.stringify(actualArchiveBindings) !== JSON.stringify(archiveEvidenceBindings)) {
    throw new Error("ledger_epoch_proposed_admission_archive_plan_binding_mismatch");
  }
  const controllerRoot = dirname(dirname(archiveRoot));
  const attempt = await findMatchingJsonFile(
    join(controllerRoot, "project-integration", "integration-attempts"),
    "attempt.json",
    (value) => value.attemptId === HISTORICAL_ATTEMPT_ID,
  );
  const historicalAlias: LedgerEpochProposedAdmissionAnchor["historicalAlias"] = {
    name: HISTORICAL_ALIAS,
    targetWorkspacePath: HISTORICAL_ALIAS_PATH,
    workerJobId: HISTORICAL_WORKER_JOB,
    sourceWorkspacePath: HISTORICAL_SOURCE_WORKSPACE,
    attemptId: HISTORICAL_ATTEMPT_ID,
    commitSha: HISTORICAL_COMMIT,
    item: await bindPlanFile(input.plan, itemRecord),
    preparation: await bindPlanFile(input.plan, preparationRecord),
    archiveEvidenceBindings,
    archiveEvidenceBindingsSha256: sha256Json(archiveEvidenceBindings),
    archiveRoot,
    gitStatus: await bindFileBytes(join(archiveRoot, "git-status.txt")),
    trackedDiff: await bindFileBytes(join(archiveRoot, "tracked.diff")),
    trackedNumstat: await bindFileBytes(join(archiveRoot, "tracked.numstat")),
    pushedAttempt: attempt.binding,
  };
  assertHistoricalAliasShape(historicalAlias);
  assertHistoricalCrossLinks(historicalAlias, await readJsonRecord(
    historicalAlias.item.preserved.path), await readJsonRecord(
    historicalAlias.preparation.preserved.path), attempt.value);
  return historicalAlias;
}

function expectedItemPlanRecord(): ConsumedOutputLedgerEpochPlan["files"][number] {
  return {
    relativePath: ITEM_RELATIVE_PATH,
    size: 1980,
    sha256: ITEM_SHA256,
    disposition: "quarantine",
    quarantineReason: "invalid_or_missing_evidence",
  };
}

function expectedPreparationPlanRecord():
  ConsumedOutputLedgerEpochPlan["files"][number] {
  return {
    relativePath: PREPARATION_RELATIVE_PATH,
    size: 1296,
    sha256: PREPARATION_SHA256,
    disposition: "preserve_only",
  };
}

function uniquePlanFile(
  plan: ConsumedOutputLedgerEpochPlan,
  relativePath: string,
  expected: ConsumedOutputLedgerEpochPlan["files"][number],
): ConsumedOutputLedgerEpochPlan["files"][number] {
  const matches = plan.files.filter((record) => record.relativePath === relativePath);
  if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(expected)) {
    throw new Error("ledger_epoch_proposed_admission_plan_file_mismatch");
  }
  return matches[0]!;
}

async function bindPlanFile(
  plan: ConsumedOutputLedgerEpochPlan,
  planRecord: ConsumedOutputLedgerEpochPlan["files"][number],
): Promise<PlanFileBinding> {
  const preserved = await bindFileBytes(join(
    plan.newRoot, "legacy-preservation", planRecord.relativePath,
  ));
  if (preserved.size !== planRecord.size || preserved.sha256 !== planRecord.sha256) {
    throw new Error("ledger_epoch_proposed_admission_preserved_file_mismatch");
  }
  return { planRecord, planRecordSha256: sha256Json(planRecord), preserved };
}

function expectedArchiveEvidenceBindings(
  archiveRoot: string,
): readonly ConsumedOutputLedgerEpochPlan["evidenceBindings"][number][] {
  return [archiveRoot, join(archiveRoot, "git-status.txt"),
    join(archiveRoot, "tracked.diff"), join(archiveRoot, "tracked.numstat")].map(
    (declaredPath) => ({ declaredPath, state: "denied" as const,
      canonicalPath: declaredPath }),
  );
}

function assertHistoricalCrossLinks(
  alias: LedgerEpochProposedAdmissionAnchor["historicalAlias"],
  item: Record<string, unknown>,
  preparation: Record<string, unknown>,
  attempt: Record<string, unknown>,
): void {
  const backup = recordValue(item.backup);
  const workerOutput = recordValue(attempt.workerOutput);
  const commitCandidate = recordValue(attempt.commitCandidate);
  const pushAttempt = recordValue(attempt.pushAttempt);
  if (item.jobId !== HISTORICAL_WORKER_JOB || item.attemptId !== HISTORICAL_ATTEMPT_ID ||
    item.status !== "integrated" || item.commitSha !== HISTORICAL_COMMIT ||
    item.integratedCommitSha !== HISTORICAL_COMMIT || item.commit !== HISTORICAL_COMMIT ||
    item.archivePath !== alias.archiveRoot ||
    backup.workspace !== HISTORICAL_SOURCE_WORKSPACE ||
    backup.statusPath !== alias.gitStatus.path || backup.patchPath !== alias.trackedDiff.path ||
    backup.numstatPath !== alias.trackedNumstat.path ||
    preparation.attemptId !== HISTORICAL_ATTEMPT_ID ||
    preparation.workerJobId !== HISTORICAL_WORKER_JOB ||
    preparation.workerWorkspacePath !== HISTORICAL_SOURCE_WORKSPACE ||
    preparation.commitSha !== HISTORICAL_COMMIT ||
    preparation.archivePath !== alias.archiveRoot ||
    preparation.statusPath !== alias.gitStatus.path ||
    preparation.patchPath !== alias.trackedDiff.path ||
    preparation.numstatPath !== alias.trackedNumstat.path ||
    attempt.attemptId !== HISTORICAL_ATTEMPT_ID || attempt.projectId !== "social-monitor" ||
    attempt.workerJobId !== HISTORICAL_WORKER_JOB ||
    attempt.sourceWorkspacePath !== HISTORICAL_SOURCE_WORKSPACE ||
    attempt.targetWorkspacePath !== HISTORICAL_ALIAS_PATH || attempt.status !== "pushed" ||
    workerOutput.workerJobId !== HISTORICAL_WORKER_JOB ||
    workerOutput.workspacePath !== HISTORICAL_SOURCE_WORKSPACE ||
    workerOutput.patchSha256 !== ARCHIVE_FILE_CONSTANTS["tracked.diff"].sha256 ||
    commitCandidate.commitSha !== HISTORICAL_COMMIT ||
    pushAttempt.commitSha !== HISTORICAL_COMMIT || pushAttempt.status !== "pushed") {
    throw new Error("ledger_epoch_proposed_admission_alias_cross_link_mismatch");
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("ledger_epoch_proposed_admission_alias_cross_link_mismatch");
  }
  return value;
}

function assertNoUnreadableWorkspace(debt: readonly ProjectDebtItem[]): void {
  if (debt.some((item) => item.reason === ProjectDebtReason.UnreadableWorkspace)) {
    throw new Error("ledger_epoch_proposed_admission_unreadable_workspace_blocked");
  }
}

async function findMatchingJsonFile(
  root: string,
  nestedName: string | undefined,
  predicate: (value: Record<string, unknown>, bytes: string) => boolean,
): Promise<{ value: Record<string, unknown>; binding: FileBinding }> {
  const matches: Array<{ value: Record<string, unknown>; path: string }> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = nestedName
      ? join(root, entry.name, nestedName)
      : join(root, entry.name);
    if (nestedName ? (!entry.isDirectory() || entry.isSymbolicLink()) : !entry.isFile()) continue;
    const bytes = await readFile(path, "utf8");
    const value: unknown = JSON.parse(bytes);
    if (isRecord(value) && predicate(value, bytes)) matches.push({ value, path });
  }
  if (matches.length !== 1) {
    throw new Error("ledger_epoch_proposed_admission_alias_evidence_mismatch");
  }
  return { value: matches[0]!.value, binding: await bindFileBytes(matches[0]!.path) };
}

async function bindFileBytes(path: string): Promise<FileBinding> {
  const declared = resolve(path);
  const bytes = await readFile(declared);
  return {
    path: declared,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function canonicalDebt(debt: readonly ProjectDebtItem[]): readonly ProjectDebtItem[] {
  return debt.map((item) => ({
    reason: item.reason,
    subject: item.subject,
    evidence: [...item.evidence],
    severity: item.severity ?? "blocking",
    ...(item.affectedPaths ? { affectedPaths: [...item.affectedPaths].sort() } : {}),
    ...(item.pathDisjointProducerEligible ? { pathDisjointProducerEligible: true as const } : {}),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function debtHash(item: ProjectDebtItem): string {
  return sha256Json(canonicalDebt([item])[0]);
}

function categoryCountsFor(debt: readonly ProjectDebtItem[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const item of debt) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function multiset(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function isBlocking(item: ProjectDebtItem): boolean {
  return item.severity !== "info" && item.severity !== "warning";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error("ledger_epoch_proposed_admission_json_record_invalid");
  }
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
