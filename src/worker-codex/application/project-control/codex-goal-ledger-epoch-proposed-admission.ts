import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ProjectDebtReason,
  summarizeProjectAdmissionDebt,
  type ConsumedOutputLedgerEpochPlan,
  type ConsumedOutputLedgerEpochReceipt,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "../../codex-goal-jobs";
import type { LedgerEpochDebtCustodyBinding } from
  "./codex-goal-consumed-output-ledger-epoch-switch";
import { LEDGER_EPOCH_V2_SIDECAR_NAME } from
  "./codex-goal-consumed-output-ledger-epoch-target";

const execFileAsync = promisify(execFile);

export const SOCIAL_PROPOSED_ADMISSION_PLAN_SHA256 =
  "e8d9c821ddf973b11796b2780f2adb1b22760291650998dfb7b0f41ce7c1ea99";
export const LEDGER_EPOCH_PROPOSED_ADMISSION_SIDECAR =
  ".ledger-epoch-proposed-admission-v1";
const STAGING_SUFFIX = ".staging";
const EXPECTED_SHA_NAME = "expected-anchor-sha256";
const HISTORICAL_ALIAS =
  "social-monitor-x-attribution-reuse-fixture-integration-v1-20260719";
const HISTORICAL_HEAD_PREFIX = "6c0129f";
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
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly sha256: string;
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
    readonly declaredPath: string;
    readonly linkTarget: string;
    readonly canonicalPath: string;
    readonly headSha: string;
    readonly registryManifest: FileBinding;
    readonly pushedAttempt: FileBinding;
    readonly consumedEvidence: FileBinding;
  };
  readonly anchorSha256: string;
};

export async function createOrVerifySocialProposedAdmissionAnchor(input: {
  readonly plan: ConsumedOutputLedgerEpochPlan;
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly summaries: readonly CodexGoalJobSummary[];
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
  readonly summaries: readonly CodexGoalJobSummary[];
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
    summaries: input.summaries,
    controllerJobRootDir: input.controllerJobRootDir,
    oldRoot: input.plan.oldRoot,
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

export async function verifySocialProposedAdmissionAnchorEvidence(
  anchor: LedgerEpochProposedAdmissionAnchor,
): Promise<void> {
  const alias = anchor.historicalAlias;
  const metadata = await lstat(alias.declaredPath);
  if (!metadata.isSymbolicLink() || await readlink(alias.declaredPath) !== alias.linkTarget ||
    await realpath(alias.declaredPath) !== alias.canonicalPath) {
    throw new Error("ledger_epoch_proposed_admission_alias_symlink_drift");
  }
  const [head, status] = await Promise.all([
    git(alias.declaredPath, ["rev-parse", "HEAD"]),
    git(alias.declaredPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (head !== alias.headSha || status !== "") {
    throw new Error("ledger_epoch_proposed_admission_alias_git_proof_drift");
  }
  for (const binding of [
    alias.registryManifest, alias.pushedAttempt, alias.consumedEvidence,
  ]) {
    if (JSON.stringify(await bindFile(binding.path)) !== JSON.stringify(binding)) {
      throw new Error("ledger_epoch_proposed_admission_alias_evidence_drift");
    }
  }
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
    value.sourceOrphanBindingSha256.length !== 205 ||
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
    sourceCanonical.length !== 205 ||
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
    typeof value.declaredPath !== "string" || typeof value.linkTarget !== "string" ||
    typeof value.canonicalPath !== "string" ||
    !/^[a-f0-9]{40}$/.test(typeof value.headSha === "string" ? value.headSha : "") ||
    !isFileBinding(value.registryManifest) || !isFileBinding(value.pushedAttempt) ||
    !isFileBinding(value.consumedEvidence)) {
    throw new Error("ledger_epoch_proposed_admission_alias_anchor_shape_invalid");
  }
}

function isFileBinding(value: unknown): value is FileBinding {
  return isRecord(value) && typeof value.path === "string" &&
    typeof value.canonicalPath === "string" && typeof value.device === "number" &&
    typeof value.inode === "number" && typeof value.size === "number" &&
    isSha256(value.sha256);
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
  readonly summaries: readonly CodexGoalJobSummary[];
  readonly controllerJobRootDir: string;
  readonly oldRoot: string;
}): Promise<LedgerEpochProposedAdmissionAnchor["historicalAlias"]> {
  const planBindings = input.plan.evidenceBindings.filter((binding) =>
    basename(binding.declaredPath) === HISTORICAL_ALIAS && binding.state === "symlink"
  );
  if (planBindings.length !== 1) {
    throw new Error("ledger_epoch_proposed_admission_alias_plan_binding_mismatch");
  }
  const planBinding = planBindings[0]!;
  const matchingSummaries = input.summaries.filter((value) =>
    value.jobId === HISTORICAL_ALIAS &&
    resolve(value.workspacePath) === resolve(planBinding.declaredPath)
  );
  if (matchingSummaries.length !== 1) {
    throw new Error("ledger_epoch_proposed_admission_alias_unregistered");
  }
  const summary = matchingSummaries[0]!;
  const declaredPath = resolve(summary.workspacePath);
  const metadata = await lstat(declaredPath);
  if (!metadata.isSymbolicLink()) {
    throw new Error("ledger_epoch_proposed_admission_alias_symlink_required");
  }
  const [linkTarget, canonicalPath, head, historicalHead, status] = await Promise.all([
    readlink(declaredPath),
    realpath(declaredPath),
    git(declaredPath, ["rev-parse", "HEAD"]),
    git(declaredPath, ["rev-parse", `${HISTORICAL_HEAD_PREFIX}^{commit}`]),
    git(declaredPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if ((planBinding.canonicalPath !== undefined &&
      resolve(planBinding.canonicalPath) !== resolve(canonicalPath)) ||
    head !== historicalHead || status !== "") {
    throw new Error("ledger_epoch_proposed_admission_alias_git_proof_mismatch");
  }
  const attempt = await findMatchingJsonFile(
    join(input.controllerJobRootDir, "project-integration", "integration-attempts"),
    "attempt.json",
    (value, bytes) => value.status === "pushed" && bytes.includes(HISTORICAL_ALIAS),
  );
  const attemptId = typeof attempt.value.attemptId === "string" &&
      attempt.value.attemptId.length > 0
    ? attempt.value.attemptId
    : undefined;
  if (!attemptId) {
    throw new Error("ledger_epoch_proposed_admission_alias_attempt_id_required");
  }
  const consumed = await findMatchingJsonFile(
    join(input.oldRoot, "items"),
    undefined,
    (value, bytes) => bytes.includes(HISTORICAL_ALIAS) &&
      value.attemptId === attemptId,
  );
  return {
    name: HISTORICAL_ALIAS,
    declaredPath,
    linkTarget,
    canonicalPath,
    headSha: head,
    registryManifest: await bindFile(summary.manifestPath),
    pushedAttempt: attempt.binding,
    consumedEvidence: consumed.binding,
  };
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
  return { value: matches[0]!.value, binding: await bindFile(matches[0]!.path) };
}

async function bindFile(path: string): Promise<FileBinding> {
  const declared = resolve(path);
  const canonicalPath = await realpath(declared);
  const [metadata, bytes] = await Promise.all([lstat(canonicalPath), readFile(canonicalPath)]);
  if (!metadata.isFile()) throw new Error("ledger_epoch_proposed_admission_proof_file_invalid");
  return {
    path: declared,
    canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

async function git(path: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", path, ...args], {
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
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
