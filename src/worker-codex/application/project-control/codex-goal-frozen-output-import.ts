import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ImmutablePatchEvidence,
  ProjectAccessScope,
  ProjectControlEvidenceCustodyPort,
} from
  "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../../codex-goal-jobs";
import {
  assertFrozenOutputReadAllowed,
  buildFrozenOutputPathAuthorization,
  canonicalFrozenOutputPathAuthorization,
  frozenOutputPathsEqual,
  type FrozenOutputPathAuthorization,
  type FrozenOutputPathClass,
} from "./codex-goal-frozen-output-authorization";
import {
  exactKeys,
  gitObject,
  inside,
  matchesPrefix,
  plainObject,
  safeChangedPath,
} from "./codex-goal-frozen-output-validation";
import {
  assertRegistryManifestIdentity,
  effectiveResultPath,
  parseJobManifest,
  type FrozenOutputRuntimeObservation,
  type FrozenOutputRuntimeObserver,
} from "./codex-goal-frozen-output-runtime";
export type { FrozenOutputRuntimeObservation, FrozenOutputRuntimeObserver } from
  "./codex-goal-frozen-output-runtime";
import {
  frozenOutputImportPlanSha256,
  parseFrozenOutputReceipt as parseReceipt,
  planFromFrozenOutputReceipt as planFromReceipt,
  type FrozenOutputImportPlan,
  type FrozenOutputImportReceipt,
  type FrozenOutputSourceManifest,
  type FrozenOutputSupersededSummary,
} from "./codex-goal-frozen-output-contract";
export {
  frozenOutputImportPlanSha256,
  type FrozenOutputImportPlan,
  type FrozenOutputImportReceipt,
  type FrozenOutputSourceManifest,
  type FrozenOutputSupersededSummary,
} from "./codex-goal-frozen-output-contract";

export type FrozenOutputSupersessionReceiptProjection = {
  readonly receipt: FrozenOutputImportReceipt;
  readonly supersededSummaries: readonly FrozenOutputSupersededSummary[];
};

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
  readonly observeRuntime: FrozenOutputRuntimeObserver;
  readonly superseded: readonly {
    readonly jobId: string;
    readonly manifestPath: string;
    readonly expectedManifestSha256: string;
  }[];
}): Promise<FrozenOutputImportPlan> {
  const lexicalAuthorization = buildFrozenOutputPathAuthorization({
    scope: input.scope,
    registryRootDir: input.registryRootDir,
  });
  assertFrozenOutputReadAllowed(lexicalAuthorization, input.sourcePath, "read",
    "frozen_output_source_outside_project_read_scope");
  assertFrozenOutputReadAllowed(lexicalAuthorization, input.sourceManifestPath,
    "read", "frozen_output_manifest_outside_project_read_scope");
  assertExpectedRegistryManifestPath(lexicalAuthorization,
    input.retainedRegistrationJobId, input.retainedManifestPath);
  for (const candidate of input.superseded) {
    assertExpectedRegistryManifestPath(lexicalAuthorization, candidate.jobId,
      candidate.manifestPath);
  }
  assertFrozenOutputReadAllowed(lexicalAuthorization,
    input.destinationEvidenceRoot, "evidence",
    "frozen_output_destination_outside_evidence_scope");
  assertFrozenOutputReadAllowed(lexicalAuthorization,
    input.destinationLedgerRoot, "ledger",
    "frozen_output_destination_outside_ledger_scope");
  const authorization = await canonicalFrozenOutputPathAuthorization(
    input.custody, lexicalAuthorization,
  );
  const registryRootDir = authorization.registryRoot;
  if (input.changedPaths.length === 0 || input.changedPaths.length > 10_000 ||
    new Set(input.changedPaths).size !== input.changedPaths.length ||
    input.changedPaths.some((path) => !safeChangedPath(path))) {
    throw new Error("frozen_output_changed_paths_invalid");
  }
  const source = await input.custody.inspectImmutablePatch(
    input.sourcePath, 64 * 1024 * 1024,
  );
  assertFrozenOutputReadAllowed(authorization, source.canonicalPath, "read",
    "frozen_output_source_outside_project_read_scope");
  const sourceManifest = await authorizedImmutableFileIdentity(input.custody,
    lexicalAuthorization, authorization, input.sourceManifestPath, "read",
    1024 * 1024, "frozen_output_manifest_outside_project_read_scope");
  const authoritativeManifest = parseSourceManifest(sourceManifest.bytes);
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
  if (!authorization.evidenceRoots.includes(destinationEvidenceRoot)) {
    throw new Error("frozen_output_destination_outside_evidence_scope");
  }
  const destinationLedgerRoot = resolve(input.destinationLedgerRoot);
  if (!authorization.ledgerRoots.includes(destinationLedgerRoot)) {
    throw new Error("frozen_output_destination_outside_ledger_scope");
  }
  if (!gitObject(input.baseCommit) || !gitObject(input.headCommit)) {
    throw new Error("frozen_output_git_identity_invalid");
  }
  const retainedManifest = await authorizedImmutableFileIdentity(input.custody,
    lexicalAuthorization, authorization, input.retainedManifestPath, "registry",
    1024 * 1024);
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
  assertFrozenOutputReadAllowed(authorization, retainedJobRootDir, "registry");
  const authorizedRetainedOutputRoots = [...authorization.projectRoots];
  const retainedOutputPath = resolve(retainedRegistration.outputPath ?? join(
    retainedJobRootDir,
    `${retainedRegistration.taskId}.latest-result.json`,
  ));
  const retainedOutput = await authorizedImmutableFileIdentity(input.custody,
    lexicalAuthorization, authorization, retainedOutputPath, "project",
    64 * 1024 * 1024,
    "frozen_output_retained_output_outside_project_scope");
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
    const identity = await authorizedImmutableFileIdentity(input.custody,
      lexicalAuthorization, authorization, candidate.manifestPath, "registry",
      1024 * 1024);
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
    const runtime = await input.observeRuntime(candidateManifest);
    if (runtime.workerAlive) throw new Error("frozen_output_legacy_worker_live");
    if (!runtime.workspaceDirty) {
      throw new Error("frozen_output_legacy_dirty_workspace_required");
    }
    const effectiveOutputPath = effectiveResultPath(candidateManifest);
    assertFrozenOutputReadAllowed(lexicalAuthorization, effectiveOutputPath,
      "project");
    if (runtime.resultPath !== undefined &&
      resolve(runtime.resultPath) !== effectiveOutputPath) {
      throw new Error("frozen_output_observed_result_path_mismatch");
    }
    await assertRegistrationOutputAbsent(input.custody, candidateManifest,
      runtime.resultExists, lexicalAuthorization, authorization);
    assertFrozenOutputReadAllowed(lexicalAuthorization,
      candidateManifest.workspacePath, "project");
    const workspacePath = await input.custody.canonicalDirectory(
      candidateManifest.workspacePath,
    );
    assertFrozenOutputReadAllowed(authorization, workspacePath, "project");
    if (workspacePath !== resolve(candidateManifest.workspacePath)) {
      throw new Error("frozen_output_legacy_workspace_noncanonical");
    }
    supersededSummaries.push({
      jobId: candidateManifest.jobId,
      manifestPath: identity.path,
      manifestSha256: identity.sha256,
      workspacePath,
      effectiveOutputPath,
      observedResultExists: runtime.resultExists,
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
    deniedRoots: [...authorization.deniedRoots].sort(),
    supersededSummaries: supersededSummaries.sort((a, b) =>
      a.jobId.localeCompare(b.jobId)
    ),
  };
}

export async function publishFrozenOutputImport(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly scope: ProjectAccessScope;
  readonly plan: FrozenOutputImportPlan;
  readonly expectedPlanSha256: string;
  readonly rebuildCurrentPlan: () => Promise<FrozenOutputImportPlan>;
  readonly now?: Date;
}): Promise<{ readonly receipt: FrozenOutputImportReceipt; readonly idempotentReplay: boolean }> {
  const planSha256 = frozenOutputImportPlanSha256(input.plan);
  if (planSha256 !== input.expectedPlanSha256.toLowerCase()) {
    throw new Error("frozen_output_import_plan_cas_mismatch");
  }
  const lexicalAuthorization = buildFrozenOutputPathAuthorization({
    scope: input.scope,
    registryRootDir: input.plan.registryRootDir,
  });
  assertFrozenOutputReadAllowed(lexicalAuthorization, input.plan.sourcePath,
    "read");
  assertFrozenOutputReadAllowed(lexicalAuthorization,
    input.plan.sourceManifestPath, "read");
  assertExpectedRegistryManifestPath(lexicalAuthorization,
    input.plan.retainedRegistrationJobId, input.plan.retainedManifestPath);
  assertFrozenOutputReadAllowed(lexicalAuthorization,
    input.plan.retainedOutputPath, "project");
  assertFrozenOutputReadAllowed(lexicalAuthorization,
    input.plan.destinationEvidenceRoot, "evidence");
  assertFrozenOutputReadAllowed(lexicalAuthorization,
    input.plan.destinationLedgerRoot, "ledger");
  for (const expected of input.plan.supersededSummaries) {
    assertExpectedRegistryManifestPath(lexicalAuthorization, expected.jobId,
      expected.manifestPath);
    assertFrozenOutputReadAllowed(lexicalAuthorization, expected.workspacePath,
      "project");
    assertFrozenOutputReadAllowed(lexicalAuthorization,
      expected.effectiveOutputPath, "project");
  }
  const authorization = await canonicalFrozenOutputPathAuthorization(
    input.custody, lexicalAuthorization,
  );
  const plannedAuthorization: FrozenOutputPathAuthorization = {
    ...authorization,
    projectRoots: [...input.plan.authorizedRetainedOutputRoots],
    deniedRoots: [...input.plan.deniedRoots],
  };
  if (!frozenOutputPathsEqual(authorization, plannedAuthorization)) {
    throw new Error("frozen_output_import_authorization_drift");
  }
  // Re-read source identities after the plan was built. The copy routine also
  // holds an O_NOFOLLOW handle and checks the inode/size again after reading.
  const [source, sourceManifest, retainedManifest, retainedOutput] = await Promise.all([
    input.custody.inspectImmutablePatch(input.plan.sourcePath, 64 * 1024 * 1024),
    authorizedReadImmutableBytes(input.custody, lexicalAuthorization,
      authorization, input.plan.sourceManifestPath, "read", 1024 * 1024),
    authorizedReadImmutableBytes(input.custody, lexicalAuthorization,
      authorization, input.plan.retainedManifestPath, "registry", 1024 * 1024),
    authorizedReadImmutableBytes(input.custody, lexicalAuthorization,
      authorization, input.plan.retainedOutputPath, "project"),
  ]);
  assertFrozenOutputReadAllowed(authorization, source.canonicalPath, "read");
  if (source.sha256 !== input.plan.sourceSha256 || source.length !== input.plan.sourceLength ||
    sourceManifest.sha256 !== input.plan.sourceManifestSha256 ||
    retainedManifest.sha256 !== input.plan.retainedManifestSha256 ||
    retainedOutput.sha256 !== input.plan.retainedOutputSha256) {
    throw new Error("frozen_output_import_source_drift");
  }
  const retainedRegistration = parseJobManifest(retainedManifest.bytes);
  const registryRootDir = authorization.registryRoot;
  assertRegistryManifestIdentity({
    registryRootDir,
    manifestPath: input.plan.retainedManifestPath,
    manifest: retainedRegistration,
    expectedJobId: input.plan.retainedRegistrationJobId,
  });
  const retainedJobRootDir = await input.custody.canonicalDirectory(
    retainedRegistration.jobRootDir,
  );
  assertFrozenOutputReadAllowed(authorization, retainedJobRootDir, "registry");
  const authorizedRetainedOutputRoots = authorization.projectRoots;
  const deniedRoots = authorization.deniedRoots;
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
    const current = await authorizedImmutableFileIdentity(input.custody,
      lexicalAuthorization, authorization, expected.manifestPath, "registry",
      1024 * 1024);
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
    const effectiveOutputPath = effectiveResultPath(manifest);
    assertFrozenOutputReadAllowed(lexicalAuthorization, effectiveOutputPath,
      "project");
    assertFrozenOutputReadAllowed(lexicalAuthorization, manifest.workspacePath,
      "project");
    const workspacePath = await input.custody.canonicalDirectory(
      manifest.workspacePath,
    );
    assertFrozenOutputReadAllowed(authorization, workspacePath, "project");
    if (effectiveOutputPath !== expected.effectiveOutputPath ||
      workspacePath !== expected.workspacePath) {
      throw new Error("frozen_output_import_superseded_identity_drift");
    }
    await assertRegistrationOutputAbsent(input.custody, manifest,
      expected.observedResultExists, lexicalAuthorization, authorization);
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
  assertFrozenOutputReadAllowed(lexicalAuthorization, importRoot, "evidence");
  assertFrozenOutputReadAllowed(lexicalAuthorization, receiptPath, "evidence");
  assertFrozenOutputReadAllowed(lexicalAuthorization, ledgerRegistrationPath,
    "ledger");
  const importDirectories = ["frozen-output-imports", planSha256];
  const validatePreparedReceipt = (prepared: FrozenOutputImportReceipt) => {
    const importedAt = new Date(prepared.importedAt);
    if (prepared.planSha256 !== planSha256 ||
      frozenOutputImportPlanSha256(planFromReceipt(prepared)) !== planSha256 ||
      prepared.custodyOutputPath !== custodyOutputPath ||
      prepared.custodySourceManifestPath !== custodySourceManifestPath ||
      prepared.custodyRetainedManifestPath !== custodyRetainedManifestPath ||
      prepared.custodyRetainedOutputPath !== custodyRetainedOutputPath ||
      prepared.receiptPath !== receiptPath ||
      prepared.ledgerRegistrationPath !== ledgerRegistrationPath ||
      typeof prepared.importedAt !== "string" ||
      Number.isNaN(importedAt.valueOf()) ||
      importedAt.toISOString() !== prepared.importedAt) {
      throw new Error("frozen_output_import_ledger_conflict");
    }
    return prepared;
  };
  const readPreparedReceipt = async () => validatePreparedReceipt(parseReceipt(
    decode((await authorizedReadImmutableBytes(
      input.custody, lexicalAuthorization, authorization,
      ledgerRegistrationPath, "ledger", 4 * 1024 * 1024,
    )).bytes),
  ));
  let receipt: FrozenOutputImportReceipt;
  let prepared = true;
  try {
    receipt = await readPreparedReceipt();
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
    prepared = false;
    receipt = {
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
  }
  let body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    await input.custody.publishImmutableBytes({
      root: input.plan.destinationLedgerRoot,
      directories: ["frozen-output-imports"],
      fileName: `${planSha256}.json`,
      bytes: body,
      expectedSha256: sha256(body),
    });
  } catch (error) {
    if (prepared || !(error instanceof Error) ||
      error.message !== "evidence_custody_immutable_conflict") throw error;
    receipt = await readPreparedReceipt();
    body = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  }
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
  const currentPlan = await input.rebuildCurrentPlan();
  if (frozenOutputImportPlanSha256(currentPlan) !== planSha256) {
    throw new Error("frozen_output_import_plan_drift");
  }
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
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
  readonly evidenceRoots: readonly string[];
  readonly ledgerRoots?: readonly string[];
  readonly projectId?: string;
  readonly controllerJobId?: string;
  readonly summaries: readonly CodexGoalJobSummary[];
  readonly observeRuntime: FrozenOutputRuntimeObserver;
}): Promise<{
  readonly active: readonly CodexGoalJobSummary[];
  readonly supersessions: readonly FrozenOutputSupersessionReceiptProjection[];
}> {
  if (input.evidenceRoots.length === 0) {
    return { active: input.summaries, supersessions: [] };
  }
  const lexicalAuthorization = buildFrozenOutputPathAuthorization({
    scope: input.scope,
    registryRootDir: input.registryRootDir,
  });
  for (const evidenceRoot of input.evidenceRoots) {
    assertFrozenOutputReadAllowed(lexicalAuthorization, evidenceRoot, "evidence");
  }
  for (const ledgerRoot of input.ledgerRoots ?? []) {
    assertFrozenOutputReadAllowed(lexicalAuthorization, ledgerRoot, "ledger");
  }
  const authorization = await canonicalFrozenOutputPathAuthorization(
    input.custody, lexicalAuthorization,
  );
  const receipts: FrozenOutputImportReceipt[] = [];
  for (const evidenceRoot of input.evidenceRoots) {
    const root = join(evidenceRoot, "frozen-output-imports");
    assertFrozenOutputReadAllowed(lexicalAuthorization, root, "evidence");
    const canonicalRoot = await input.custody.canonicalDirectory(root, true);
    assertFrozenOutputReadAllowed(authorization, canonicalRoot, "evidence");
    let entries;
    try {
      entries = await input.custody.listDirectory(root);
    } catch (error) { throw error; }
    for (const entry of entries) {
      if (entry.kind !== "directory") continue;
      const path = join(root, entry.name, "receipt.json");
      assertFrozenOutputReadAllowed(lexicalAuthorization, path, "evidence");
      try {
        const receipt = parseReceipt(decode((await authorizedReadImmutableBytes(
          input.custody, lexicalAuthorization, authorization, path, "evidence",
          4 * 1024 * 1024,
        )).bytes));
        if ((input.projectId !== undefined && receipt.projectId !== input.projectId) ||
          (input.controllerJobId !== undefined &&
            receipt.controllerJobId !== input.controllerJobId)) continue;
        await verifyFrozenOutputReceipt(input.custody, receipt, path, evidenceRoot,
          input, lexicalAuthorization, authorization);
        receipts.push(receipt);
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") throw error;
      }
    }
  }
  const effectivePairs: {
    readonly receipt: FrozenOutputImportReceipt;
    readonly summary: FrozenOutputImportReceipt["supersededSummaries"][number];
  }[] = [];
  const active: CodexGoalJobSummary[] = [];
  for (const summary of input.summaries) {
    const candidates = receipts.flatMap((receipt) =>
      receipt.supersededSummaries
        .filter((expected) => expected.jobId === summary.jobId)
        .map((expected) => ({ receipt, summary: expected }))
    );
    if (candidates.length === 0) {
      active.push(summary);
      continue;
    }
    assertExpectedRegistryManifestPath(lexicalAuthorization, summary.jobId,
      summary.manifestPath);
    const current = await authorizedImmutableFileIdentity(input.custody,
      lexicalAuthorization, authorization, summary.manifestPath, "registry",
      1024 * 1024);
    const matched = candidates.filter(({ summary: expected }) =>
      expected.manifestPath === resolve(summary.manifestPath) &&
      expected.workspacePath === resolve(summary.workspacePath) &&
      current.sha256 === expected.manifestSha256
    );
    const manifest = parseJobManifest(current.bytes);
    let runtimeAllowsSupersession = false;
    if (matched.length > 0) {
      try {
        const runtime = await input.observeRuntime(manifest);
        const canonicalWorkspace = await input.custody.canonicalDirectory(
          manifest.workspacePath,
        );
        assertFrozenOutputReadAllowed(authorization, canonicalWorkspace,
          "project");
        runtimeAllowsSupersession = runtime.workspaceDirty &&
          !runtime.workerAlive && !runtime.resultExists &&
          (runtime.resultPath === undefined ||
            resolve(runtime.resultPath) === effectiveResultPath(manifest)) &&
          canonicalWorkspace === resolve(manifest.workspacePath) &&
          !await registrationHasOutput(input.custody, manifest,
            lexicalAuthorization, authorization);
      } catch {
        runtimeAllowsSupersession = false;
      }
    }
    if (!runtimeAllowsSupersession) {
      active.push(summary);
    } else {
      effectivePairs.push(...matched);
    }
  }
  const supersessions = receipts.flatMap((receipt) => {
    const supersededSummaries = effectivePairs
      .filter((pair) => pair.receipt === receipt)
      .map((pair) => pair.summary);
    return supersededSummaries.length === 0
      ? []
      : [{ receipt, supersededSummaries }];
  });
  return {
    active: active.length === input.summaries.length ? input.summaries : active,
    supersessions,
  };
}

async function readImmutableBytes(custody: ProjectControlEvidenceCustodyPort,
  path: string, maxBytes = 64 * 1024 * 1024): Promise<{
  readonly canonicalPath: string; readonly bytes: Uint8Array;
  readonly sha256: string; readonly length: number;
}> {
  const file = await custody.readImmutableFile(path, maxBytes);
  return file;
}

async function authorizedReadImmutableBytes(
  custody: ProjectControlEvidenceCustodyPort,
  lexical: FrozenOutputPathAuthorization,
  canonical: FrozenOutputPathAuthorization,
  path: string,
  pathClass: FrozenOutputPathClass,
  maxBytes = 64 * 1024 * 1024,
  errorCode?: string,
) {
  assertFrozenOutputReadAllowed(lexical, path, pathClass, errorCode);
  const file = await readImmutableBytes(custody, path, maxBytes);
  assertFrozenOutputReadAllowed(canonical, file.canonicalPath, pathClass,
    errorCode);
  return file;
}

async function authorizedImmutableFileIdentity(
  custody: ProjectControlEvidenceCustodyPort,
  lexical: FrozenOutputPathAuthorization,
  canonical: FrozenOutputPathAuthorization,
  path: string,
  pathClass: FrozenOutputPathClass,
  maxBytes = 64 * 1024 * 1024,
  errorCode?: string,
) {
  const read = await authorizedReadImmutableBytes(custody, lexical, canonical,
    path, pathClass, maxBytes, errorCode);
  return {
    path: read.canonicalPath,
    sha256: read.sha256,
    length: read.length,
    bytes: read.bytes,
  };
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
  lexicalPaths: FrozenOutputPathAuthorization,
  canonicalPaths: FrozenOutputPathAuthorization,
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
    receipt.registryRootDir !== lexicalPaths.registryRoot ||
    (authorization.ledgerRoots !== undefined &&
      !authorization.ledgerRoots.map((root) => resolve(root))
        .includes(receipt.destinationLedgerRoot)) ||
    !inside(receipt.ledgerRegistrationPath, receipt.destinationLedgerRoot)) {
    throw new Error("frozen_output_import_receipt_scope_mismatch");
  }
  for (const path of [receipt.custodyOutputPath,
    receipt.custodySourceManifestPath, receipt.custodyRetainedManifestPath,
    receipt.custodyRetainedOutputPath]) {
    assertFrozenOutputReadAllowed(lexicalPaths, path, "evidence");
  }
  assertFrozenOutputReadAllowed(lexicalPaths, receipt.ledgerRegistrationPath,
    "ledger");
  const [output, sourceManifest, retainedManifest, retainedOutput,
    ledgerRegistration] = await Promise.all([
    authorizedImmutableFileIdentity(custody, lexicalPaths, canonicalPaths,
      receipt.custodyOutputPath, "evidence"),
    authorizedImmutableFileIdentity(custody, lexicalPaths, canonicalPaths,
      receipt.custodySourceManifestPath, "evidence"),
    authorizedImmutableFileIdentity(custody, lexicalPaths, canonicalPaths,
      receipt.custodyRetainedManifestPath, "evidence"),
    authorizedImmutableFileIdentity(custody, lexicalPaths, canonicalPaths,
      receipt.custodyRetainedOutputPath, "evidence"),
    authorizedImmutableFileIdentity(custody, lexicalPaths, canonicalPaths,
      receipt.ledgerRegistrationPath, "ledger"),
  ]);
  if (output.sha256 !== receipt.sourceSha256 ||
    output.length !== receipt.sourceLength ||
    sourceManifest.sha256 !== receipt.sourceManifestSha256 ||
    retainedManifest.sha256 !== receipt.retainedManifestSha256 ||
    retainedOutput.sha256 !== receipt.retainedOutputSha256 ||
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

async function assertRegistrationOutputAbsent(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
  observedResultExists: boolean,
  lexical: FrozenOutputPathAuthorization,
  canonical: FrozenOutputPathAuthorization,
): Promise<void> {
  if (observedResultExists || await authorizedPathKind(custody, lexical,
    canonical, effectiveResultPath(manifest)) !== "absent") {
    throw new Error("frozen_output_legacy_output_bearing_refused");
  }
  if (await registrationHasHandoff(custody, manifest, lexical, canonical)) {
    throw new Error("frozen_output_legacy_handoff_bearing_refused");
  }
}

async function registrationHasOutput(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
  lexical: FrozenOutputPathAuthorization,
  canonical: FrozenOutputPathAuthorization,
): Promise<boolean> {
  return await authorizedPathKind(custody, lexical, canonical,
    effectiveResultPath(manifest)) !== "absent" ||
    await registrationHasHandoff(custody, manifest, lexical, canonical);
}

async function registrationHasHandoff(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
  lexical: FrozenOutputPathAuthorization,
  canonical: FrozenOutputPathAuthorization,
): Promise<boolean> {
  assertFrozenOutputReadAllowed(lexical, manifest.jobRootDir, "registry");
  const canonicalJobRoot = await custody.canonicalDirectory(manifest.jobRootDir);
  assertFrozenOutputReadAllowed(canonical, canonicalJobRoot, "registry");
  return (await custody.listDirectory(canonicalJobRoot)).some((entry) =>
    entry.name.startsWith(`${manifest.taskId}.`) &&
    /\.handoff\.(patch|summary\.json|manifest\.json)$/i.test(entry.name)
  );
}

async function authorizedPathKind(
  custody: ProjectControlEvidenceCustodyPort,
  lexical: FrozenOutputPathAuthorization,
  canonical: FrozenOutputPathAuthorization,
  path: string,
): Promise<"absent" | "file" | "directory" | "symlink" | "other"> {
  const candidate = assertFrozenOutputReadAllowed(lexical, path, "project");
  if (lexical.projectRoots.includes(candidate) ||
    canonical.projectRoots.includes(candidate)) return "directory";
  const parent = dirname(candidate);
  assertFrozenOutputReadAllowed(lexical, parent, "project");
  const inspection = await custody.openDirectoryForInspection(parent);
  try {
    assertFrozenOutputReadAllowed(canonical, inspection.canonicalPath, "project");
    return await inspection.pathKind(basename(candidate));
  } finally {
    await inspection.close();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    value === right[index]);
}

function assertExpectedRegistryManifestPath(
  authorization: FrozenOutputPathAuthorization,
  jobId: string,
  manifestPath: string,
): void {
  const expected = join(authorization.registryRoot, jobId, "job.json");
  if (resolve(manifestPath) !== expected) {
    throw new Error("frozen_output_registry_identity_mismatch");
  }
  assertFrozenOutputReadAllowed(authorization, manifestPath, "registry");
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
