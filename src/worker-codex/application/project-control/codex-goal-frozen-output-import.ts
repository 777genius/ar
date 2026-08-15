import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ProjectAccessScope } from
  "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../../codex-goal-jobs";

export type FrozenOutputSupersededSummary = {
  readonly jobId: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly workspacePath: string;
};

export type FrozenOutputImportPlan = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceLength: number;
  readonly sourceManifestPath: string;
  readonly sourceManifestSha256: string;
  readonly destinationEvidenceRoot: string;
  readonly destinationLedgerRoot: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly patchSha256: string;
  readonly retainedRegistrationJobId: string;
  readonly retainedManifestPath: string;
  readonly retainedManifestSha256: string;
  readonly retainedOutputPath: string;
  readonly retainedOutputSha256: string;
  readonly supersededSummaries: readonly FrozenOutputSupersededSummary[];
};

export type FrozenOutputImportReceipt = FrozenOutputImportPlan & {
  readonly planSha256: string;
  readonly importedAt: string;
  readonly custodyOutputPath: string;
  readonly custodySourceManifestPath: string;
  readonly receiptPath: string;
  readonly ledgerRegistrationPath: string;
};

export function frozenOutputImportPlanSha256(plan: FrozenOutputImportPlan): string {
  return sha256(`${JSON.stringify(plan)}\n`);
}

export async function buildFrozenOutputImportPlan(input: {
  readonly scope: ProjectAccessScope;
  readonly controllerJobId: string;
  readonly sourcePath: string;
  readonly expectedSourceSha256: string;
  readonly expectedSourceLength: number;
  readonly sourceManifestPath: string;
  readonly expectedSourceManifestSha256: string;
  readonly destinationEvidenceRoot: string;
  readonly destinationLedgerRoot: string;
  readonly changedPaths: readonly string[];
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly patchSha256: string;
  readonly retainedManifest: CodexGoalJobManifest;
  readonly retainedManifestPath: string;
  readonly expectedRetainedManifestSha256: string;
  readonly expectedRetainedOutputSha256: string;
  readonly superseded: readonly {
    readonly manifest: CodexGoalJobManifest;
    readonly manifestPath: string;
    readonly expectedManifestSha256: string;
    readonly workspaceDirty: boolean;
    readonly workerAlive: boolean;
  }[];
}): Promise<FrozenOutputImportPlan> {
  const sourceRoots = await canonicalRoots(input.scope.readRoots ?? []);
  const deniedRoots = await canonicalRoots(input.scope.deniedRoots ?? [], true);
  const evidenceRoots = await canonicalRoots(
    input.scope.consumedOutputEvidenceRoots ?? [],
  );
  const ledgerRoots = await canonicalRoots(
    input.scope.consumedOutputLedgerRoots ?? [],
  );
  const source = await immutableFileIdentity(input.sourcePath);
  const sourceManifest = await immutableFileIdentity(input.sourceManifestPath);
  if (!sourceRoots.some((root) => inside(source.path, root)) ||
    deniedRoots.some((root) => inside(source.path, root))) {
    throw new Error("frozen_output_source_outside_project_read_scope");
  }
  if (!sourceRoots.some((root) => inside(sourceManifest.path, root)) ||
    deniedRoots.some((root) => inside(sourceManifest.path, root))) {
    throw new Error("frozen_output_manifest_outside_project_read_scope");
  }
  if (source.sha256 !== input.expectedSourceSha256.toLowerCase() ||
    source.length !== input.expectedSourceLength) {
    throw new Error("frozen_output_source_cas_mismatch");
  }
  if (source.sha256 !== input.patchSha256.toLowerCase()) {
    throw new Error("frozen_output_patch_identity_mismatch");
  }
  if (sourceManifest.sha256 !== input.expectedSourceManifestSha256.toLowerCase()) {
    throw new Error("frozen_output_source_manifest_cas_mismatch");
  }
  const destinationEvidenceRoot = resolve(input.destinationEvidenceRoot);
  if (!evidenceRoots.includes(destinationEvidenceRoot)) {
    throw new Error("frozen_output_destination_outside_evidence_scope");
  }
  const destinationLedgerRoot = resolve(input.destinationLedgerRoot);
  if (!ledgerRoots.includes(destinationLedgerRoot)) {
    throw new Error("frozen_output_destination_outside_ledger_scope");
  }
  if (input.changedPaths.length === 0 ||
    new Set(input.changedPaths).size !== input.changedPaths.length ||
    input.changedPaths.some((path) => !safeChangedPath(path))) {
    throw new Error("frozen_output_changed_paths_invalid");
  }
  if (!gitObject(input.baseCommit) || !gitObject(input.headCommit)) {
    throw new Error("frozen_output_git_identity_invalid");
  }
  const retainedManifest = await immutableFileIdentity(input.retainedManifestPath);
  if (retainedManifest.sha256 !== input.expectedRetainedManifestSha256.toLowerCase()) {
    throw new Error("frozen_output_retained_manifest_cas_mismatch");
  }
  if (input.retainedManifest.projectAccessScope?.projectId !== input.scope.projectId ||
    !input.retainedManifest.outputPath) {
    throw new Error("frozen_output_output_bearing_registration_required");
  }
  const retainedOutput = await immutableFileIdentity(input.retainedManifest.outputPath);
  if (retainedOutput.length === 0 ||
    retainedOutput.sha256 !== input.expectedRetainedOutputSha256.toLowerCase()) {
    throw new Error("frozen_output_retained_output_cas_mismatch");
  }
  const supersededSummaries: FrozenOutputSupersededSummary[] = [];
  for (const candidate of input.superseded) {
    if (candidate.workerAlive) throw new Error("frozen_output_legacy_worker_live");
    if (!candidate.workspaceDirty) {
      throw new Error("frozen_output_legacy_dirty_workspace_required");
    }
    if (candidate.manifest.projectAccessScope?.projectId !== input.scope.projectId) {
      throw new Error("frozen_output_legacy_project_mismatch");
    }
    if (candidate.manifest.outputPath) {
      try {
        await immutableFileIdentity(candidate.manifest.outputPath);
        throw new Error("frozen_output_legacy_output_bearing_refused");
      } catch (error) {
        if (error instanceof Error &&
          error.message === "frozen_output_legacy_output_bearing_refused") throw error;
        if (nodeErrorCode(error) !== "ENOENT") throw error;
      }
    }
    const identity = await immutableFileIdentity(candidate.manifestPath);
    if (identity.sha256 !== candidate.expectedManifestSha256.toLowerCase()) {
      throw new Error("frozen_output_legacy_manifest_cas_mismatch");
    }
    const workspacePath = await realpath(candidate.manifest.workspacePath);
    if (workspacePath !== resolve(candidate.manifest.workspacePath)) {
      throw new Error("frozen_output_legacy_workspace_noncanonical");
    }
    supersededSummaries.push({
      jobId: candidate.manifest.jobId,
      manifestPath: identity.path,
      manifestSha256: identity.sha256,
      workspacePath,
    });
  }
  if (supersededSummaries.length === 0) {
    throw new Error("frozen_output_legacy_summary_required");
  }
  return {
    schemaVersion: 1,
    projectId: input.scope.projectId,
    controllerJobId: input.controllerJobId,
    sourcePath: source.path,
    sourceSha256: source.sha256,
    sourceLength: source.length,
    sourceManifestPath: sourceManifest.path,
    sourceManifestSha256: sourceManifest.sha256,
    destinationEvidenceRoot,
    destinationLedgerRoot,
    changedPaths: [...input.changedPaths].sort(),
    baseCommit: input.baseCommit.toLowerCase(),
    headCommit: input.headCommit.toLowerCase(),
    patchSha256: input.patchSha256.toLowerCase(),
    retainedRegistrationJobId: input.retainedManifest.jobId,
    retainedManifestPath: retainedManifest.path,
    retainedManifestSha256: retainedManifest.sha256,
    retainedOutputPath: retainedOutput.path,
    retainedOutputSha256: retainedOutput.sha256,
    supersededSummaries: supersededSummaries.sort((a, b) =>
      a.jobId.localeCompare(b.jobId)
    ),
  };
}

export async function publishFrozenOutputImport(input: {
  readonly plan: FrozenOutputImportPlan;
  readonly expectedPlanSha256: string;
  readonly now?: Date;
}): Promise<{ readonly receipt: FrozenOutputImportReceipt; readonly idempotentReplay: boolean }> {
  const planSha256 = frozenOutputImportPlanSha256(input.plan);
  if (planSha256 !== input.expectedPlanSha256.toLowerCase()) {
    throw new Error("frozen_output_import_plan_cas_mismatch");
  }
  // Re-read source identities after the plan was built. The copy routine also
  // holds an O_NOFOLLOW handle and checks the inode/size again after reading.
  const [source, sourceManifest] = await Promise.all([
    readImmutableBytes(input.plan.sourcePath),
    readImmutableBytes(input.plan.sourceManifestPath),
  ]);
  if (source.sha256 !== input.plan.sourceSha256 || source.length !== input.plan.sourceLength ||
    sourceManifest.sha256 !== input.plan.sourceManifestSha256) {
    throw new Error("frozen_output_import_source_drift");
  }
  const importRoot = join(
    input.plan.destinationEvidenceRoot,
    "frozen-output-imports",
    planSha256,
  );
  await mkdir(importRoot, { recursive: true, mode: 0o700 });
  const custodyOutputPath = join(importRoot, "output.patch");
  const custodySourceManifestPath = join(importRoot, "source-manifest.json");
  const receiptPath = join(importRoot, "receipt.json");
  const ledgerRegistrationRoot = join(
    input.plan.destinationLedgerRoot,
    "frozen-output-imports",
  );
  const ledgerRegistrationPath = join(
    ledgerRegistrationRoot,
    `${planSha256}.json`,
  );
  await writeImmutable(custodyOutputPath, source.bytes, input.plan.sourceSha256);
  await writeImmutable(
    custodySourceManifestPath,
    sourceManifest.bytes,
    input.plan.sourceManifestSha256,
  );
  const receipt: FrozenOutputImportReceipt = {
    ...input.plan,
    planSha256,
    importedAt: (input.now ?? new Date()).toISOString(),
    custodyOutputPath,
    custodySourceManifestPath,
    receiptPath,
    ledgerRegistrationPath,
  };
  const body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    await writeNewSynced(receiptPath, body);
    await fsyncDirectory(importRoot);
    await mkdir(ledgerRegistrationRoot, { recursive: true, mode: 0o700 });
    await writeImmutable(ledgerRegistrationPath, body, sha256(body));
    await fsyncDirectory(ledgerRegistrationRoot);
    return { receipt, idempotentReplay: false };
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    const existing = parseReceipt(await readFile(receiptPath, "utf8"));
    if (existing.planSha256 !== planSha256 ||
      frozenOutputImportPlanSha256(planFromReceipt(existing)) !== planSha256) {
      throw new Error("frozen_output_import_receipt_conflict");
    }
    const existingBody = Buffer.from(`${JSON.stringify(existing, null, 2)}\n`);
    await mkdir(ledgerRegistrationRoot, { recursive: true, mode: 0o700 });
    await writeImmutable(
      existing.ledgerRegistrationPath,
      existingBody,
      sha256(existingBody),
    );
    await fsyncDirectory(ledgerRegistrationRoot);
    return { receipt: existing, idempotentReplay: true };
  }
}

export async function frozenOutputSupersessionProjection(input: {
  readonly evidenceRoots: readonly string[];
  readonly summaries: readonly CodexGoalJobSummary[];
}): Promise<{
  readonly active: readonly CodexGoalJobSummary[];
  readonly receipts: readonly FrozenOutputImportReceipt[];
}> {
  const receipts: FrozenOutputImportReceipt[] = [];
  for (const evidenceRoot of input.evidenceRoots) {
    const root = join(evidenceRoot, "frozen-output-imports");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "receipt.json");
      try {
        const receipt = parseReceipt(await readFile(path, "utf8"));
        await verifyFrozenOutputReceipt(receipt, path, evidenceRoot);
        receipts.push(receipt);
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") throw error;
      }
    }
  }
  const superseded = receipts.flatMap((receipt) => receipt.supersededSummaries);
  const active: CodexGoalJobSummary[] = [];
  for (const summary of input.summaries) {
    const candidates = superseded.filter((expected) =>
      expected.jobId === summary.jobId
    );
    if (candidates.length === 0) {
      active.push(summary);
      continue;
    }
    const currentSha256 = (await immutableFileIdentity(summary.manifestPath)).sha256;
    const matched = candidates.some((expected) =>
      expected.manifestPath === resolve(summary.manifestPath) &&
      expected.workspacePath === resolve(summary.workspacePath) &&
      currentSha256 === expected.manifestSha256
    );
    if (!matched) {
      active.push(summary);
    }
  }
  return {
    active: active.length === input.summaries.length ? input.summaries : active,
    receipts,
  };
}

async function canonicalRoots(inputs: readonly string[], allowMissing = false): Promise<string[]> {
  return await Promise.all(inputs.map(async (input) => {
    const lexical = resolve(input);
    try {
      const [physical, metadata] = await Promise.all([realpath(lexical), lstat(lexical)]);
      if (physical !== lexical || metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("frozen_output_scope_root_noncanonical");
      }
      return physical;
    } catch (error) {
      if (allowMissing && nodeErrorCode(error) === "ENOENT") return lexical;
      throw error;
    }
  }));
}

async function immutableFileIdentity(path: string) {
  const read = await readImmutableBytes(path);
  return { path: resolve(path), sha256: read.sha256, length: read.length };
}

async function readImmutableBytes(path: string): Promise<{
  readonly bytes: Buffer; readonly sha256: string; readonly length: number;
}> {
  const lexical = resolve(path);
  if (await realpath(lexical) !== lexical) {
    throw new Error("frozen_output_file_noncanonical");
  }
  const handle = await open(lexical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 256 * 1024 * 1024) {
      throw new Error("frozen_output_file_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || after.size !== bytes.length) {
      throw new Error("frozen_output_file_changed_during_read");
    }
    return { bytes, sha256: sha256(bytes), length: bytes.length };
  } finally {
    await handle.close();
  }
}

async function writeImmutable(path: string, bytes: Buffer, expectedSha256: string) {
  try {
    await writeNewSynced(path, bytes);
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    const existing = await readImmutableBytes(path);
    if (existing.sha256 !== expectedSha256 || existing.length !== bytes.length) {
      throw new Error("frozen_output_custody_conflict");
    }
  }
}

async function writeNewSynced(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function planFromReceipt(receipt: FrozenOutputImportReceipt): FrozenOutputImportPlan {
  const { planSha256: _plan, importedAt: _at, custodyOutputPath: _out,
    custodySourceManifestPath: _manifest, receiptPath: _receipt,
    ledgerRegistrationPath: _ledger, ...plan } = receipt;
  return plan;
}

function parseReceipt(body: string): FrozenOutputImportReceipt {
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { planSha256?: unknown }).planSha256 !== "string") {
    throw new Error("frozen_output_import_receipt_invalid");
  }
  const receipt = value as FrozenOutputImportReceipt;
  if (!/^[a-f0-9]{64}$/.test(receipt.planSha256) ||
    !Array.isArray(receipt.changedPaths) ||
    !Array.isArray(receipt.supersededSummaries) ||
    frozenOutputImportPlanSha256(planFromReceipt(receipt)) !== receipt.planSha256) {
    throw new Error("frozen_output_import_receipt_invalid");
  }
  return receipt;
}

async function verifyFrozenOutputReceipt(
  receipt: FrozenOutputImportReceipt,
  receiptPath: string,
  evidenceRoot: string,
): Promise<void> {
  if (receipt.receiptPath !== resolve(receiptPath) ||
    receipt.destinationEvidenceRoot !== resolve(evidenceRoot) ||
    !inside(receipt.custodyOutputPath, evidenceRoot) ||
    !inside(receipt.custodySourceManifestPath, evidenceRoot)) {
    throw new Error("frozen_output_import_receipt_scope_mismatch");
  }
  const [output, sourceManifest, ledgerRegistration] = await Promise.all([
    immutableFileIdentity(receipt.custodyOutputPath),
    immutableFileIdentity(receipt.custodySourceManifestPath),
    immutableFileIdentity(receipt.ledgerRegistrationPath),
  ]);
  if (output.sha256 !== receipt.sourceSha256 ||
    output.length !== receipt.sourceLength ||
    sourceManifest.sha256 !== receipt.sourceManifestSha256 ||
    !inside(receipt.ledgerRegistrationPath, receipt.destinationLedgerRoot) ||
    ledgerRegistration.sha256 !== sha256(
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    )) {
    throw new Error("frozen_output_import_receipt_evidence_mismatch");
  }
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function safeChangedPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") &&
    path.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

function gitObject(value: string): boolean {
  return /^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" ? error.code : undefined;
}
