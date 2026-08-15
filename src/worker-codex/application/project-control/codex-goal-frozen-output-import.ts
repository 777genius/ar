import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import type {
  ImmutablePatchEvidence,
  ProjectAccessScope,
  ProjectControlEvidenceCustodyPort,
} from
  "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../../codex-goal-jobs";
import { parseCodexGoalJobManifest } from "../../codex-goal-jobs";

export type FrozenOutputSupersededSummary = {
  readonly jobId: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly workspacePath: string;
  readonly effectiveOutputPath: string;
  readonly observedResultExists: boolean;
};

export type FrozenOutputImportPlan = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly registryRootDir: string;
  readonly jobIdPrefixes: readonly string[];
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
  readonly retainedJobRootDir: string;
  readonly retainedManifestPath: string;
  readonly retainedManifestSha256: string;
  readonly retainedOutputPath: string;
  readonly retainedOutputSha256: string;
  readonly authorizedRetainedOutputRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly supersededSummaries: readonly FrozenOutputSupersededSummary[];
};

export type FrozenOutputSourceManifest = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly patch: {
    readonly sha256: string;
    readonly length: number;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly changedPaths: readonly string[];
  };
  readonly retainedOutput: {
    readonly jobId: string;
    readonly manifestSha256: string;
    readonly outputSha256: string;
  };
};

export type FrozenOutputImportReceipt = FrozenOutputImportPlan & {
  readonly planSha256: string;
  readonly importedAt: string;
  readonly custodyOutputPath: string;
  readonly custodySourceManifestPath: string;
  readonly custodyRetainedManifestPath: string;
  readonly custodyRetainedOutputPath: string;
  readonly receiptPath: string;
  readonly ledgerRegistrationPath: string;
};

export function frozenOutputImportPlanSha256(plan: FrozenOutputImportPlan): string {
  const body = `${JSON.stringify(plan)}\n`;
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) {
    throw new Error("frozen_output_import_plan_too_large");
  }
  return sha256(body);
}

export async function buildFrozenOutputImportPlan(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly jobIdPrefixes: readonly string[];
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
  readonly retainedRegistrationJobId: string;
  readonly retainedManifestPath: string;
  readonly expectedRetainedManifestSha256: string;
  readonly expectedRetainedOutputSha256: string;
  readonly superseded: readonly {
    readonly jobId: string;
    readonly manifestPath: string;
    readonly expectedManifestSha256: string;
    readonly workspaceDirty: boolean;
    readonly workerAlive: boolean;
    readonly observedResultExists: boolean;
    readonly observedResultPath?: string;
  }[];
}): Promise<FrozenOutputImportPlan> {
  const registryRootDir = await input.custody.canonicalDirectory(
    input.registryRootDir,
  );
  if (input.scope.registryRoot !== undefined &&
    await input.custody.canonicalDirectory(input.scope.registryRoot) !==
      registryRootDir) {
    throw new Error("frozen_output_registry_scope_mismatch");
  }
  const sourceRoots = await canonicalRoots(input.custody, input.scope.readRoots ?? []);
  const deniedRoots = await canonicalRoots(input.custody,
    input.scope.deniedRoots ?? [], true);
  const evidenceRoots = await canonicalRoots(
    input.custody, input.scope.consumedOutputEvidenceRoots ?? [],
  );
  const ledgerRoots = await canonicalRoots(
    input.custody, input.scope.consumedOutputLedgerRoots ?? [],
  );
  const ownershipRoots = await canonicalRoots(input.custody, [
    ...(input.scope.readRoots ?? []), ...(input.scope.workspaceRoots ?? []),
    ...(input.scope.worktreeRoots ?? []),
    ...(input.scope.observedWorkspaceRoots ?? []),
    ...(input.scope.isolatedWorkspaceRoot
      ? [input.scope.isolatedWorkspaceRoot]
      : []),
    ...(input.scope.registryRoot ? [input.scope.registryRoot] : []),
  ]);
  for (const root of [...evidenceRoots, ...ledgerRoots]) {
    if (!ownershipRoots.some((owned) => inside(root, owned)) ||
      deniedRoots.some((denied) => inside(root, denied) || inside(denied, root))) {
      throw new Error("frozen_output_custody_root_outside_project_scope");
    }
  }
  if (input.changedPaths.length === 0 || input.changedPaths.length > 10_000 ||
    new Set(input.changedPaths).size !== input.changedPaths.length ||
    input.changedPaths.some((path) => !safeChangedPath(path))) {
    throw new Error("frozen_output_changed_paths_invalid");
  }
  const source = await input.custody.inspectImmutablePatch(
    input.sourcePath, 64 * 1024 * 1024,
  );
  const sourceManifest = await immutableFileIdentity(input.custody,
    input.sourceManifestPath, 1024 * 1024);
  const authoritativeManifest = parseSourceManifest(sourceManifest.bytes);
  if (!sourceRoots.some((root) => inside(source.canonicalPath, root)) ||
    deniedRoots.some((root) => inside(source.canonicalPath, root))) {
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
  assertPatchDescriptor(source, {
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    changedPaths: input.changedPaths,
  });
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
  if (!gitObject(input.baseCommit) || !gitObject(input.headCommit)) {
    throw new Error("frozen_output_git_identity_invalid");
  }
  const retainedManifest = await immutableFileIdentity(input.custody,
    input.retainedManifestPath, 1024 * 1024);
  if (retainedManifest.sha256 !== input.expectedRetainedManifestSha256.toLowerCase()) {
    throw new Error("frozen_output_retained_manifest_cas_mismatch");
  }
  const retainedRegistration = parseJobManifest(retainedManifest.bytes);
  assertRegistryManifestIdentity({
    registryRootDir,
    manifestPath: retainedManifest.path,
    manifest: retainedRegistration,
    expectedJobId: input.retainedRegistrationJobId,
  });
  if (retainedRegistration.projectAccessScope?.projectId !== input.scope.projectId ||
    !matchesPrefix(retainedRegistration.jobId, input.jobIdPrefixes)) {
    throw new Error("frozen_output_output_bearing_registration_required");
  }
  const retainedJobRootDir = await input.custody.canonicalDirectory(
    retainedRegistration.jobRootDir,
  );
  const authorizedRetainedOutputRoots = [...new Set([
    retainedJobRootDir,
    ...ownershipRoots,
  ])].sort();
  const retainedOutputPath = resolve(retainedRegistration.outputPath ?? join(
    retainedJobRootDir,
    `${retainedRegistration.taskId}.latest-result.json`,
  ));
  const retainedOutput = await immutableFileIdentity(input.custody,
    retainedOutputPath);
  if (!authorizedRetainedOutputRoots.some((root) =>
      inside(retainedOutput.path, root)) ||
    deniedRoots.some((root) => inside(retainedOutput.path, root))) {
    throw new Error("frozen_output_retained_output_outside_project_scope");
  }
  if (retainedOutput.length === 0 ||
    retainedOutput.sha256 !== input.expectedRetainedOutputSha256.toLowerCase()) {
    throw new Error("frozen_output_retained_output_cas_mismatch");
  }
  assertSourceManifestBinding(authoritativeManifest, {
    projectId: input.scope.projectId,
    controllerJobId: input.controllerJobId,
    sourceSha256: source.sha256,
    sourceLength: source.length,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    changedPaths: input.changedPaths,
    retainedJobId: retainedRegistration.jobId,
    retainedManifestSha256: retainedManifest.sha256,
    retainedOutputSha256: retainedOutput.sha256,
  });
  const supersededSummaries: FrozenOutputSupersededSummary[] = [];
  if (input.superseded.length > 1_000 ||
    new Set(input.superseded.map((candidate) => candidate.jobId)).size !==
      input.superseded.length) {
    throw new Error("frozen_output_legacy_summaries_invalid");
  }
  for (const candidate of input.superseded) {
    if (candidate.workerAlive) throw new Error("frozen_output_legacy_worker_live");
    if (!candidate.workspaceDirty) {
      throw new Error("frozen_output_legacy_dirty_workspace_required");
    }
    const identity = await immutableFileIdentity(input.custody,
      candidate.manifestPath, 1024 * 1024);
    if (identity.sha256 !== candidate.expectedManifestSha256.toLowerCase()) {
      throw new Error("frozen_output_legacy_manifest_cas_mismatch");
    }
    const candidateManifest = parseJobManifest(identity.bytes);
    assertRegistryManifestIdentity({
      registryRootDir,
      manifestPath: identity.path,
      manifest: candidateManifest,
      expectedJobId: candidate.jobId,
    });
    if (candidateManifest.projectAccessScope?.projectId !== input.scope.projectId) {
      throw new Error("frozen_output_legacy_project_mismatch");
    }
    if (!matchesPrefix(candidateManifest.jobId, input.jobIdPrefixes)) {
      throw new Error("frozen_output_legacy_job_prefix_mismatch");
    }
    const effectiveOutputPath = effectiveResultPath(candidateManifest);
    if (candidate.observedResultPath !== undefined &&
      resolve(candidate.observedResultPath) !== effectiveOutputPath) {
      throw new Error("frozen_output_observed_result_path_mismatch");
    }
    await assertRegistrationOutputAbsent(input.custody, candidateManifest,
      candidate.observedResultExists);
    const workspacePath = await input.custody.canonicalDirectory(
      candidateManifest.workspacePath,
    );
    if (workspacePath !== resolve(candidateManifest.workspacePath)) {
      throw new Error("frozen_output_legacy_workspace_noncanonical");
    }
    supersededSummaries.push({
      jobId: candidateManifest.jobId,
      manifestPath: identity.path,
      manifestSha256: identity.sha256,
      workspacePath,
      effectiveOutputPath,
      observedResultExists: candidate.observedResultExists,
    });
  }
  if (supersededSummaries.length === 0) {
    throw new Error("frozen_output_legacy_summary_required");
  }
  return {
    schemaVersion: 1,
    projectId: input.scope.projectId,
    controllerJobId: input.controllerJobId,
    registryRootDir,
    jobIdPrefixes: [...input.jobIdPrefixes].sort(),
    sourcePath: source.canonicalPath,
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
    retainedRegistrationJobId: retainedRegistration.jobId,
    retainedJobRootDir,
    retainedManifestPath: retainedManifest.path,
    retainedManifestSha256: retainedManifest.sha256,
    retainedOutputPath: retainedOutput.path,
    retainedOutputSha256: retainedOutput.sha256,
    authorizedRetainedOutputRoots,
    deniedRoots: [...deniedRoots].sort(),
    supersededSummaries: supersededSummaries.sort((a, b) =>
      a.jobId.localeCompare(b.jobId)
    ),
  };
}

export async function publishFrozenOutputImport(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
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
  const [source, sourceManifest, retainedManifest, retainedOutput] = await Promise.all([
    input.custody.inspectImmutablePatch(input.plan.sourcePath, 64 * 1024 * 1024),
    readImmutableBytes(input.custody, input.plan.sourceManifestPath, 1024 * 1024),
    readImmutableBytes(input.custody, input.plan.retainedManifestPath, 1024 * 1024),
    readImmutableBytes(input.custody, input.plan.retainedOutputPath),
  ]);
  if (source.sha256 !== input.plan.sourceSha256 || source.length !== input.plan.sourceLength ||
    sourceManifest.sha256 !== input.plan.sourceManifestSha256 ||
    retainedManifest.sha256 !== input.plan.retainedManifestSha256 ||
    retainedOutput.sha256 !== input.plan.retainedOutputSha256) {
    throw new Error("frozen_output_import_source_drift");
  }
  const retainedRegistration = parseJobManifest(retainedManifest.bytes);
  const [registryRootDir, retainedJobRootDir, authorizedRetainedOutputRoots,
    deniedRoots] = await Promise.all([
    input.custody.canonicalDirectory(input.plan.registryRootDir),
    input.custody.canonicalDirectory(retainedRegistration.jobRootDir),
    canonicalRoots(input.custody, input.plan.authorizedRetainedOutputRoots),
    canonicalRoots(input.custody, input.plan.deniedRoots, true),
  ]);
  assertRegistryManifestIdentity({
    registryRootDir,
    manifestPath: input.plan.retainedManifestPath,
    manifest: retainedRegistration,
    expectedJobId: input.plan.retainedRegistrationJobId,
  });
  const currentRetainedOutputPath = effectiveResultPath(retainedRegistration);
  if (registryRootDir !== input.plan.registryRootDir ||
    retainedJobRootDir !== input.plan.retainedJobRootDir ||
    !sameStrings(authorizedRetainedOutputRoots,
      input.plan.authorizedRetainedOutputRoots) ||
    !sameStrings(deniedRoots, input.plan.deniedRoots) ||
    currentRetainedOutputPath !== input.plan.retainedOutputPath ||
    !authorizedRetainedOutputRoots.some((root) =>
      inside(currentRetainedOutputPath, root)) ||
    deniedRoots.some((root) => inside(currentRetainedOutputPath, root))) {
    throw new Error("frozen_output_import_retained_authorization_drift");
  }
  for (const expected of input.plan.supersededSummaries) {
    const current = await immutableFileIdentity(input.custody,
      expected.manifestPath, 1024 * 1024);
    if (current.sha256 !== expected.manifestSha256) {
      throw new Error("frozen_output_import_superseded_manifest_drift");
    }
    const manifest = parseJobManifest(current.bytes);
    assertRegistryManifestIdentity({
      registryRootDir,
      manifestPath: current.path,
      manifest,
      expectedJobId: expected.jobId,
    });
    if (effectiveResultPath(manifest) !== expected.effectiveOutputPath ||
      await input.custody.canonicalDirectory(manifest.workspacePath) !==
        expected.workspacePath) {
      throw new Error("frozen_output_import_superseded_identity_drift");
    }
    await assertRegistrationOutputAbsent(input.custody, manifest,
      expected.observedResultExists);
  }
  const importRoot = join(
    input.plan.destinationEvidenceRoot,
    "frozen-output-imports",
    planSha256,
  );
  const custodyOutputPath = join(importRoot, "output.patch");
  const custodySourceManifestPath = join(importRoot, "source-manifest.json");
  const custodyRetainedManifestPath = join(importRoot, "retained-manifest.json");
  const custodyRetainedOutputPath = join(importRoot, "retained-output.json");
  const receiptPath = join(importRoot, "receipt.json");
  const ledgerRegistrationRoot = join(
    input.plan.destinationLedgerRoot,
    "frozen-output-imports",
  );
  const ledgerRegistrationPath = join(
    ledgerRegistrationRoot,
    `${planSha256}.json`,
  );
  const importDirectories = ["frozen-output-imports", planSha256];
  await Promise.all([
    input.custody.copyImmutableFile({
      sourcePath: input.plan.sourcePath,
      expectedSha256: input.plan.sourceSha256,
      expectedLength: input.plan.sourceLength,
      maxBytes: 64 * 1024 * 1024,
      root: input.plan.destinationEvidenceRoot,
      directories: importDirectories,
      fileName: "output.patch",
    }),
    input.custody.publishImmutableBytes({
      root: input.plan.destinationEvidenceRoot,
      directories: importDirectories,
      fileName: "source-manifest.json",
      bytes: sourceManifest.bytes,
      expectedSha256: input.plan.sourceManifestSha256,
    }),
    input.custody.publishImmutableBytes({
      root: input.plan.destinationEvidenceRoot,
      directories: importDirectories,
      fileName: "retained-manifest.json",
      bytes: retainedManifest.bytes,
      expectedSha256: input.plan.retainedManifestSha256,
    }),
    input.custody.copyImmutableFile({
      sourcePath: input.plan.retainedOutputPath,
      expectedSha256: input.plan.retainedOutputSha256,
      expectedLength: retainedOutput.length,
      maxBytes: 64 * 1024 * 1024,
      root: input.plan.destinationEvidenceRoot,
      directories: importDirectories,
      fileName: "retained-output.json",
    }),
  ]);
  const candidateReceipt: FrozenOutputImportReceipt = {
    ...input.plan,
    planSha256,
    importedAt: (input.now ?? new Date()).toISOString(),
    custodyOutputPath,
    custodySourceManifestPath,
    custodyRetainedManifestPath,
    custodyRetainedOutputPath,
    receiptPath,
    ledgerRegistrationPath,
  };
  let receipt = candidateReceipt;
  try {
    const prepared = parseReceipt(decode((await input.custody.readImmutableFile(
      ledgerRegistrationPath, 4 * 1024 * 1024,
    )).bytes));
    if (prepared.planSha256 !== planSha256 ||
      frozenOutputImportPlanSha256(planFromReceipt(prepared)) !== planSha256) {
      throw new Error("frozen_output_import_ledger_conflict");
    }
    receipt = prepared;
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  const body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await input.custody.publishImmutableBytes({
    root: input.plan.destinationLedgerRoot,
    directories: ["frozen-output-imports"],
    fileName: `${planSha256}.json`,
    bytes: body,
    expectedSha256: sha256(body),
  });
  // The receipt is the commit marker and must be published last. Projection
  // cannot observe a committed import without its durable ledger record.
  const published = await input.custody.publishImmutableBytes({
    root: input.plan.destinationEvidenceRoot,
    directories: importDirectories,
    fileName: "receipt.json",
    bytes: body,
    expectedSha256: sha256(body),
  });
  return { receipt, idempotentReplay: !published.created };
}

export async function frozenOutputSupersessionProjection(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly evidenceRoots: readonly string[];
  readonly ledgerRoots?: readonly string[];
  readonly projectId?: string;
  readonly controllerJobId?: string;
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
      entries = await input.custody.listDirectory(root);
    } catch (error) { throw error; }
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      const path = join(root, entry.name, "receipt.json");
      try {
        const receipt = parseReceipt(decode((await input.custody.readImmutableFile(
          path, 4 * 1024 * 1024,
        )).bytes));
        if ((input.projectId !== undefined && receipt.projectId !== input.projectId) ||
          (input.controllerJobId !== undefined &&
            receipt.controllerJobId !== input.controllerJobId)) continue;
        await verifyFrozenOutputReceipt(input.custody, receipt, path, evidenceRoot,
          input);
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
    const current = await immutableFileIdentity(input.custody,
      summary.manifestPath, 1024 * 1024);
    const matched = candidates.some((expected) =>
      expected.manifestPath === resolve(summary.manifestPath) &&
      expected.workspacePath === resolve(summary.workspacePath) &&
      current.sha256 === expected.manifestSha256
    );
    if (!matched || await registrationHasOutput(input.custody,
      parseJobManifest(current.bytes))) {
      active.push(summary);
    }
  }
  return {
    active: active.length === input.summaries.length ? input.summaries : active,
    receipts,
  };
}

async function canonicalRoots(custody: ProjectControlEvidenceCustodyPort,
  inputs: readonly string[], allowMissing = false): Promise<string[]> {
  return await Promise.all(inputs.map(async (input) => {
    return await custody.canonicalDirectory(input, allowMissing);
  }));
}

async function immutableFileIdentity(custody: ProjectControlEvidenceCustodyPort,
  path: string, maxBytes = 64 * 1024 * 1024) {
  const read = await readImmutableBytes(custody, path, maxBytes);
  return {
    path: resolve(path), sha256: read.sha256, length: read.length, bytes: read.bytes,
  };
}

async function readImmutableBytes(custody: ProjectControlEvidenceCustodyPort,
  path: string, maxBytes = 64 * 1024 * 1024): Promise<{
  readonly bytes: Uint8Array; readonly sha256: string; readonly length: number;
}> {
  const file = await custody.readImmutableFile(path, maxBytes);
  return { bytes: file.bytes, sha256: file.sha256, length: file.length };
}

function planFromReceipt(receipt: FrozenOutputImportReceipt): FrozenOutputImportPlan {
  const { planSha256: _plan, importedAt: _at, custodyOutputPath: _out,
    custodySourceManifestPath: _manifest, receiptPath: _receipt,
    custodyRetainedManifestPath: _retainedManifest,
    custodyRetainedOutputPath: _retainedOutput,
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
  custody: ProjectControlEvidenceCustodyPort,
  receipt: FrozenOutputImportReceipt,
  receiptPath: string,
  evidenceRoot: string,
  authorization: {
    readonly ledgerRoots?: readonly string[];
    readonly projectId?: string;
    readonly controllerJobId?: string;
  },
): Promise<void> {
  if (receipt.receiptPath !== resolve(receiptPath) ||
    receipt.destinationEvidenceRoot !== resolve(evidenceRoot) ||
    !inside(receipt.custodyOutputPath, evidenceRoot) ||
    !inside(receipt.custodySourceManifestPath, evidenceRoot) ||
    !inside(receipt.custodyRetainedManifestPath, evidenceRoot) ||
    !inside(receipt.custodyRetainedOutputPath, evidenceRoot) ||
    (authorization.projectId !== undefined &&
      receipt.projectId !== authorization.projectId) ||
    (authorization.controllerJobId !== undefined &&
      receipt.controllerJobId !== authorization.controllerJobId) ||
    (authorization.ledgerRoots !== undefined &&
      !authorization.ledgerRoots.map((root) => resolve(root))
        .includes(receipt.destinationLedgerRoot))) {
    throw new Error("frozen_output_import_receipt_scope_mismatch");
  }
  const [output, sourceManifest, retainedManifest, retainedOutput,
    ledgerRegistration] = await Promise.all([
    immutableFileIdentity(custody, receipt.custodyOutputPath),
    immutableFileIdentity(custody, receipt.custodySourceManifestPath),
    immutableFileIdentity(custody, receipt.custodyRetainedManifestPath),
    immutableFileIdentity(custody, receipt.custodyRetainedOutputPath),
    immutableFileIdentity(custody, receipt.ledgerRegistrationPath),
  ]);
  if (output.sha256 !== receipt.sourceSha256 ||
    output.length !== receipt.sourceLength ||
    sourceManifest.sha256 !== receipt.sourceManifestSha256 ||
    retainedManifest.sha256 !== receipt.retainedManifestSha256 ||
    retainedOutput.sha256 !== receipt.retainedOutputSha256 ||
    !inside(receipt.ledgerRegistrationPath, receipt.destinationLedgerRoot) ||
    ledgerRegistration.sha256 !== sha256(
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    )) {
    throw new Error("frozen_output_import_receipt_evidence_mismatch");
  }
  const authoritativeManifest = parseSourceManifest(sourceManifest.bytes);
  assertSourceManifestBinding(authoritativeManifest, {
    projectId: receipt.projectId,
    controllerJobId: receipt.controllerJobId,
    sourceSha256: receipt.sourceSha256,
    sourceLength: receipt.sourceLength,
    baseCommit: receipt.baseCommit,
    headCommit: receipt.headCommit,
    changedPaths: receipt.changedPaths,
    retainedJobId: receipt.retainedRegistrationJobId,
    retainedManifestSha256: receipt.retainedManifestSha256,
    retainedOutputSha256: receipt.retainedOutputSha256,
  });
  const retained = parseJobManifest(retainedManifest.bytes);
  assertRegistryManifestIdentity({
    registryRootDir: receipt.registryRootDir,
    manifestPath: receipt.retainedManifestPath,
    manifest: retained,
    expectedJobId: receipt.retainedRegistrationJobId,
  });
  if (retained.jobId !== receipt.retainedRegistrationJobId ||
    retained.projectAccessScope?.projectId !== receipt.projectId ||
    !matchesPrefix(retained.jobId, receipt.jobIdPrefixes) ||
    resolve(retained.jobRootDir) !== receipt.retainedJobRootDir ||
    resolve(retained.outputPath ?? join(retained.jobRootDir,
      `${retained.taskId}.latest-result.json`)) !== receipt.retainedOutputPath ||
    !receipt.authorizedRetainedOutputRoots.some((root) =>
      inside(receipt.retainedOutputPath, root)) ||
    receipt.deniedRoots.some((root) => inside(receipt.retainedOutputPath, root))) {
    throw new Error("frozen_output_import_retained_manifest_mismatch");
  }
}

function parseSourceManifest(bytes: Uint8Array): FrozenOutputSourceManifest {
  let value: unknown;
  try { value = JSON.parse(decode(bytes)); } catch {
    throw new Error("frozen_output_source_manifest_invalid");
  }
  if (!plainObject(value) || exactKeys(value, [
    "schemaVersion", "projectId", "controllerJobId", "patch", "retainedOutput",
  ]) === false || value.schemaVersion !== 1 || typeof value.projectId !== "string" ||
    typeof value.controllerJobId !== "string" || !plainObject(value.patch) ||
    !plainObject(value.retainedOutput) || !exactKeys(value.patch, [
      "sha256", "length", "baseCommit", "headCommit", "changedPaths",
    ]) || !exactKeys(value.retainedOutput, [
      "jobId", "manifestSha256", "outputSha256",
    ]) || typeof value.patch.sha256 !== "string" ||
    !Number.isSafeInteger(value.patch.length) || typeof value.patch.baseCommit !== "string" ||
    typeof value.patch.headCommit !== "string" || !Array.isArray(value.patch.changedPaths) ||
    value.patch.changedPaths.some((item) => typeof item !== "string") ||
    typeof value.retainedOutput.jobId !== "string" ||
    typeof value.retainedOutput.manifestSha256 !== "string" ||
    typeof value.retainedOutput.outputSha256 !== "string") {
    throw new Error("frozen_output_source_manifest_invalid");
  }
  return value as FrozenOutputSourceManifest;
}

function assertSourceManifestBinding(manifest: FrozenOutputSourceManifest, expected: {
  readonly projectId: string; readonly controllerJobId: string;
  readonly sourceSha256: string; readonly sourceLength: number;
  readonly baseCommit: string; readonly headCommit: string;
  readonly changedPaths: readonly string[]; readonly retainedJobId: string;
  readonly retainedManifestSha256: string; readonly retainedOutputSha256: string;
}): void {
  if (manifest.projectId !== expected.projectId ||
    manifest.controllerJobId !== expected.controllerJobId ||
    manifest.patch.sha256.toLowerCase() !== expected.sourceSha256 ||
    manifest.patch.length !== expected.sourceLength ||
    manifest.patch.baseCommit.toLowerCase() !== expected.baseCommit.toLowerCase() ||
    manifest.patch.headCommit.toLowerCase() !== expected.headCommit.toLowerCase() ||
    JSON.stringify([...manifest.patch.changedPaths].sort()) !==
      JSON.stringify([...expected.changedPaths].sort()) ||
    manifest.retainedOutput.jobId !== expected.retainedJobId ||
    manifest.retainedOutput.manifestSha256.toLowerCase() !==
      expected.retainedManifestSha256 ||
    manifest.retainedOutput.outputSha256.toLowerCase() !== expected.retainedOutputSha256) {
    throw new Error("frozen_output_source_manifest_binding_mismatch");
  }
}

function assertPatchDescriptor(evidence: ImmutablePatchEvidence, expected: {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changedPaths: readonly string[];
}): void {
  const changed = new Set<string>();
  for (const pair of evidence.changedPathPairs) {
    for (const path of pair) {
      if (!safeChangedPath(path)) {
        throw new Error("frozen_output_patch_descriptor_invalid");
      }
      changed.add(path);
    }
  }
  if (evidence.commits.length === 0 || evidence.baseCommits.length !== 1 ||
    changed.size === 0 ||
    evidence.commits.at(-1) !== expected.headCommit.toLowerCase() ||
    evidence.baseCommits[0] !== expected.baseCommit.toLowerCase() ||
    JSON.stringify([...changed].sort()) !==
      JSON.stringify([...expected.changedPaths].sort())) {
    throw new Error("frozen_output_patch_descriptor_mismatch");
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) =>
    actual[index] === [...keys].sort()[index]);
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function safeChangedPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") &&
    path.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

function gitObject(value: string): boolean {
  return /^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(value);
}

function matchesPrefix(jobId: string, prefixes: readonly string[]): boolean {
  return prefixes.length > 0 && prefixes.some((prefix) =>
    prefix.length > 0 && jobId.startsWith(prefix));
}

function effectiveResultPath(manifest: CodexGoalJobManifest): string {
  return resolve(manifest.outputPath ?? join(
    manifest.jobRootDir,
    `${manifest.taskId}.latest-result.json`,
  ));
}

async function assertRegistrationOutputAbsent(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
  observedResultExists: boolean,
): Promise<void> {
  if (observedResultExists || await custody.pathKind(effectiveResultPath(manifest)) !==
    "absent") {
    throw new Error("frozen_output_legacy_output_bearing_refused");
  }
  if (await registrationHasHandoff(custody, manifest)) {
    throw new Error("frozen_output_legacy_handoff_bearing_refused");
  }
}

async function registrationHasOutput(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
): Promise<boolean> {
  return await custody.pathKind(effectiveResultPath(manifest)) !== "absent" ||
    await registrationHasHandoff(custody, manifest);
}

async function registrationHasHandoff(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
): Promise<boolean> {
  return (await custody.listDirectory(manifest.jobRootDir)).some((entry) =>
    entry.kind === "file" &&
    entry.name.startsWith(`${manifest.taskId}.`) &&
    /\.handoff\.(patch|summary\.json|manifest\.json)$/i.test(entry.name)
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    value === right[index]);
}

function parseJobManifest(bytes: Uint8Array): CodexGoalJobManifest {
  try {
    return parseCodexGoalJobManifest(JSON.parse(decode(bytes)));
  } catch (error) {
    throw new Error("frozen_output_job_manifest_invalid", { cause: error });
  }
}

function assertRegistryManifestIdentity(input: {
  readonly registryRootDir: string;
  readonly manifestPath: string;
  readonly manifest: CodexGoalJobManifest;
  readonly expectedJobId: string;
}): void {
  const expectedJobRoot = join(resolve(input.registryRootDir), input.expectedJobId);
  if (input.manifest.jobId !== input.expectedJobId ||
    resolve(input.manifestPath) !== join(expectedJobRoot, "job.json") ||
    resolve(input.manifest.jobRootDir) !== expectedJobRoot) {
    throw new Error("frozen_output_registry_identity_mismatch");
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decode(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" ? error.code : undefined;
}
