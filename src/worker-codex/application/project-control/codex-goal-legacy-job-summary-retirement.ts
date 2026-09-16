import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectControlEvidenceCustodyPort } from
  "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../../codex-goal-jobs";
import { parseCodexGoalJobManifest } from "../../codex-goal-jobs";

export type LegacyJobRuntimeObserver = (
  manifest: CodexGoalJobManifest,
) => Promise<{ readonly workerAlive: boolean }>;

export const LEGACY_JOB_SUMMARY_RETIREMENT_REASON =
  "workspace_missing_registration_never_launched" as const;

export type LegacyJobSummaryRetirementPlan = {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly jobId: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly workspacePath: string;
  readonly retainedRegistrationJobId: string;
  readonly retainedManifestPath: string;
  readonly retainedManifestSha256: string;
  readonly reasonCode: typeof LEGACY_JOB_SUMMARY_RETIREMENT_REASON;
};

export type LegacyJobSummaryRetirementReceipt =
  LegacyJobSummaryRetirementPlan & {
    readonly planSha256: string;
    readonly retiredAt: string;
    readonly proofs: readonly [
      "workspace_enoent",
      "worker_stopped",
      "launch_handoff_result_output_absent",
      "retained_sibling_exact",
      "manifest_cas_exact",
    ];
  };

export function legacyJobSummaryRetirementPlanSha256(
  plan: LegacyJobSummaryRetirementPlan,
): string {
  return sha256(`${JSON.stringify(plan)}\n`);
}

export function legacyJobSummaryRetirementRoot(input: {
  readonly registryRootDir: string;
  readonly projectId: string;
}): string {
  return join(
    input.registryRootDir,
    ".project-control",
    "legacy-job-summary-retirements",
    identityComponent(input.projectId),
  );
}

export function legacyJobSummaryRetirementPath(input: {
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly manifestSha256: string;
}): string {
  return join(
    legacyJobSummaryRetirementRoot(input),
    `${safeComponent(input.jobId)}--${input.manifestSha256}.json`,
  );
}

export async function buildLegacyJobSummaryRetirementPlan(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly jobIdPrefixes: readonly string[];
  readonly manifestPath: string;
  readonly expectedManifestPath: string;
  readonly expectedManifestSha256: string;
  readonly expectedWorkspacePath: string;
  readonly retainedManifestPath: string;
  readonly expectedRetainedManifestSha256: string;
  readonly observeRuntime: LegacyJobRuntimeObserver;
}): Promise<LegacyJobSummaryRetirementPlan> {
  await assertCanonicalRegistryRoot(input.custody, input.registryRootDir);
  const manifestPath = resolve(input.manifestPath);
  if (manifestPath !== resolve(input.expectedManifestPath)) {
    throw new Error("legacy_job_summary_manifest_path_cas_mismatch");
  }
  const manifestFile = await input.custody.readImmutableFile(
    manifestPath, 1024 * 1024,
  );
  const manifest = parseManifest(manifestFile.bytes);
  const manifestSha256 = manifestFile.sha256;
  if (manifestSha256 !== input.expectedManifestSha256.toLowerCase()) {
    throw new Error("legacy_job_summary_manifest_sha256_cas_mismatch");
  }
  if (
    resolve(manifest.workspacePath) !== resolve(input.expectedWorkspacePath)
  ) {
    throw new Error("legacy_job_summary_workspace_cas_mismatch");
  }
  assertRegistryJobOwned({
    registryRootDir: input.registryRootDir,
    projectId: input.projectId,
    jobIdPrefixes: input.jobIdPrefixes,
    manifest,
    manifestPath,
    allowUnscopedLegacy: true,
  });
  await assertWorkspaceEnoent(input.custody, input.expectedWorkspacePath);
  if ((await input.observeRuntime(manifest)).workerAlive) {
    throw new Error("legacy_job_summary_worker_live");
  }
  await assertNeverLaunchedArtifactsAbsent(input.custody, manifest);

  const retainedManifestPath = resolve(input.retainedManifestPath);
  const retainedFile = await input.custody.readImmutableFile(
    retainedManifestPath, 1024 * 1024,
  );
  const retainedManifest = parseManifest(retainedFile.bytes);
  if (retainedManifest.jobId === manifest.jobId) {
    throw new Error("legacy_job_summary_retained_sibling_required");
  }
  const retainedManifestSha256 = retainedFile.sha256;
  if (
    retainedManifestSha256 !==
      input.expectedRetainedManifestSha256.toLowerCase()
  ) {
    throw new Error("legacy_job_summary_retained_manifest_cas_mismatch");
  }
  assertRegistryJobOwned({
    registryRootDir: input.registryRootDir,
    projectId: input.projectId,
    jobIdPrefixes: input.jobIdPrefixes,
    manifest: retainedManifest,
    manifestPath: retainedManifestPath,
    allowUnscopedLegacy: false,
  });
  if (
    resolve(retainedManifest.workspacePath) !==
      resolve(input.expectedWorkspacePath) ||
    retainedManifest.projectAccessScope?.projectId !== input.projectId
  ) {
    throw new Error("legacy_job_summary_retained_registration_mismatch");
  }
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    controllerJobId: input.controllerJobId,
    jobId: manifest.jobId,
    manifestPath,
    manifestSha256,
    workspacePath: resolve(input.expectedWorkspacePath),
    retainedRegistrationJobId: retainedManifest.jobId,
    retainedManifestPath,
    retainedManifestSha256,
    reasonCode: LEGACY_JOB_SUMMARY_RETIREMENT_REASON,
  };
}

export async function publishLegacyJobSummaryRetirement(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly registryRootDir: string;
  readonly plan: LegacyJobSummaryRetirementPlan;
  readonly expectedPlanSha256: string;
  readonly rebuildCurrentPlan: () => Promise<LegacyJobSummaryRetirementPlan>;
  readonly now?: Date;
}): Promise<{
  readonly receipt: LegacyJobSummaryRetirementReceipt;
  readonly receiptPath: string;
  readonly idempotentReplay: boolean;
}> {
  const planSha256 = legacyJobSummaryRetirementPlanSha256(input.plan);
  if (planSha256 !== input.expectedPlanSha256.toLowerCase()) {
    throw new Error("legacy_job_summary_retirement_plan_cas_mismatch");
  }
  const receiptPath = legacyJobSummaryRetirementPath({
    registryRootDir: input.registryRootDir,
    projectId: input.plan.projectId,
    jobId: input.plan.jobId,
    manifestSha256: input.plan.manifestSha256,
  });
  try {
    const existing = parseRetirementReceipt(decode((await input.custody
      .readImmutableFile(receiptPath, 1024 * 1024)).bytes));
    if (existing.planSha256 !== planSha256 ||
      legacyJobSummaryRetirementPlanSha256(planFromReceipt(existing)) !==
        planSha256) throw new Error("legacy_job_summary_retirement_receipt_conflict");
    return { receipt: existing, receiptPath, idempotentReplay: true };
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  const currentPlan = await input.rebuildCurrentPlan();
  if (legacyJobSummaryRetirementPlanSha256(currentPlan) !== planSha256) {
    throw new Error("legacy_job_summary_retirement_plan_drift");
  }
  const receipt: LegacyJobSummaryRetirementReceipt = {
    ...input.plan,
    planSha256,
    retiredAt: (input.now ?? new Date()).toISOString(),
    proofs: [
      "workspace_enoent",
      "worker_stopped",
      "launch_handoff_result_output_absent",
      "retained_sibling_exact",
      "manifest_cas_exact",
    ],
  };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const published = await input.custody.publishImmutableBytes({
    root: input.registryRootDir,
    directories: [
      ".project-control",
      "legacy-job-summary-retirements",
      identityComponent(input.plan.projectId),
    ],
    fileName: `${safeComponent(input.plan.jobId)}--${input.plan.manifestSha256}.json`,
    bytes: Buffer.from(body),
    expectedSha256: sha256(body),
  });
  return { receipt, receiptPath, idempotentReplay: !published.created };
}

function planFromReceipt(
  receipt: LegacyJobSummaryRetirementReceipt,
): LegacyJobSummaryRetirementPlan {
  return {
    schemaVersion: receipt.schemaVersion,
    projectId: receipt.projectId,
    controllerJobId: receipt.controllerJobId,
    jobId: receipt.jobId,
    manifestPath: receipt.manifestPath,
    manifestSha256: receipt.manifestSha256,
    workspacePath: receipt.workspacePath,
    retainedRegistrationJobId: receipt.retainedRegistrationJobId,
    retainedManifestPath: receipt.retainedManifestPath,
    retainedManifestSha256: receipt.retainedManifestSha256,
    reasonCode: receipt.reasonCode,
  };
}

export async function projectRetirementProjection(input: {
  readonly custody: ProjectControlEvidenceCustodyPort;
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly controllerJobId?: string;
  readonly jobIdPrefixes?: readonly string[];
  readonly summaries: readonly CodexGoalJobSummary[];
  readonly observeRuntime: LegacyJobRuntimeObserver;
}): Promise<{
  readonly active: readonly CodexGoalJobSummary[];
  readonly retired: readonly LegacyJobSummaryRetirementReceipt[];
}> {
  let entries;
  try {
    entries = await input.custody.listDirectory(
      legacyJobSummaryRetirementRoot(input),
    );
  } catch (error) { throw error; }
  const receipts: LegacyJobSummaryRetirementReceipt[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const receipt = parseRetirementReceipt(decode((await input.custody.readImmutableFile(
      join(legacyJobSummaryRetirementRoot(input), entry.name), 1024 * 1024,
    )).bytes));
    if (receipt.projectId !== input.projectId ||
      (input.controllerJobId !== undefined &&
        receipt.controllerJobId !== input.controllerJobId) ||
      (input.jobIdPrefixes !== undefined &&
        !matchesPrefix(receipt.jobId, input.jobIdPrefixes))) continue;
    receipts.push(receipt);
  }
  const retired: LegacyJobSummaryRetirementReceipt[] = [];
  const active: CodexGoalJobSummary[] = [];
  for (const summary of input.summaries) {
    const candidates = receipts.filter((receipt) => receipt.jobId === summary.jobId);
    if (candidates.length === 0) {
      active.push(summary);
      continue;
    }
    const currentFile = await input.custody.readImmutableFile(
      summary.manifestPath, 1024 * 1024,
    );
    const currentSha256 = currentFile.sha256;
    const currentManifest = parseManifest(currentFile.bytes);
    assertRegistryJobOwned({
      registryRootDir: input.registryRootDir,
      projectId: input.projectId,
      jobIdPrefixes: input.jobIdPrefixes ?? [],
      manifest: currentManifest,
      manifestPath: summary.manifestPath,
      allowUnscopedLegacy: true,
    });
    let matched: LegacyJobSummaryRetirementReceipt | undefined;
    for (const receipt of candidates) {
      let retainedCurrent = false;
      try {
        const retainedFile = await input.custody.readImmutableFile(
          receipt.retainedManifestPath, 1024 * 1024,
        );
        const retained = parseManifest(retainedFile.bytes);
        retainedCurrent = retainedFile.sha256 === receipt.retainedManifestSha256 &&
          retained.projectAccessScope?.projectId === input.projectId &&
          retained.jobId === receipt.retainedRegistrationJobId;
      } catch {
        retainedCurrent = false;
      }
      let runtimeStillRetired = false;
      try {
        await assertWorkspaceEnoent(input.custody, currentManifest.workspacePath);
        runtimeStillRetired =
          !(await input.observeRuntime(currentManifest)).workerAlive;
        if (runtimeStillRetired) {
          await assertNeverLaunchedArtifactsAbsent(input.custody, currentManifest);
        }
      } catch {
        runtimeStillRetired = false;
      }
      if (runtimeStillRetired &&
        receipt.manifestPath === resolve(summary.manifestPath) &&
        receipt.manifestSha256 === currentSha256 &&
        receipt.workspacePath === resolve(summary.workspacePath) &&
        retainedCurrent) {
        matched = receipt;
        break;
      }
    }
    if (matched) {
      retired.push(matched);
    } else {
      active.push(summary);
    }
  }
  return {
    active: retired.length === 0 ? input.summaries : active,
    retired,
  };
}

async function assertCanonicalRegistryRoot(custody: ProjectControlEvidenceCustodyPort,
  root: string): Promise<void> {
  await custody.canonicalDirectory(root);
}

async function assertWorkspaceEnoent(custody: ProjectControlEvidenceCustodyPort,
  path: string): Promise<void> {
  if (await custody.pathKind(path) !== "absent") {
    throw new Error("legacy_job_summary_workspace_still_exists");
  }
  let parent = dirname(resolve(path));
  for (;;) {
    try {
      await custody.canonicalDirectory(parent);
      return;
    } catch (error) {
      if (await custody.pathKind(parent) !== "absent") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

async function assertNeverLaunchedArtifactsAbsent(
  custody: ProjectControlEvidenceCustodyPort,
  manifest: CodexGoalJobManifest,
): Promise<void> {
  const effectiveRuntimeFiles = new Set([
    resolve(manifest.outputPath ??
      join(manifest.jobRootDir, `${manifest.taskId}.latest-result.json`)),
    resolve(manifest.progressPath ??
      join(manifest.jobRootDir, `${manifest.taskId}.progress.json`)),
    resolve(manifest.logPath ??
      join(manifest.jobRootDir, `${manifest.taskId}.log`)),
    resolve(join(manifest.jobRootDir, `${manifest.taskId}.events.jsonl`)),
  ]);
  for (const path of effectiveRuntimeFiles) {
    if (await custody.pathKind(path) !== "absent") {
      throw new Error("legacy_job_summary_runtime_artifact_present");
    }
  }
  const stateRoots = new Set([
    resolve(join(manifest.jobRootDir, "state")),
    ...(manifest.stateRootDir ? [resolve(manifest.stateRootDir)] : []),
  ]);
  for (const stateRoot of stateRoots) {
    if (await custody.pathKind(stateRoot) !== "absent") {
      throw new Error("legacy_job_summary_runtime_state_present");
    }
  }
  const entries = await custody.listDirectory(manifest.jobRootDir);
  const forbidden =
    /(^|[-_.])(launch|handoff|result|output|progress|log|events)([-_.]|$)/i;
  if (entries.some((entry) => forbidden.test(entry.name))) {
    throw new Error("legacy_job_summary_runtime_artifact_present");
  }
}

function parseManifest(bytes: Uint8Array): CodexGoalJobManifest {
  try {
    return parseCodexGoalJobManifest(JSON.parse(decode(bytes)));
  } catch (error) {
    throw new Error("legacy_job_summary_manifest_invalid", { cause: error });
  }
}

function parseRetirementReceipt(value: string): LegacyJobSummaryRetirementReceipt {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (parsed as { planSha256?: unknown }).planSha256 !== "string"
  ) throw new Error("legacy_job_summary_retirement_receipt_invalid");
  const receipt = parsed as LegacyJobSummaryRetirementReceipt;
  if (
    !/^[a-f0-9]{64}$/.test(receipt.planSha256) ||
    receipt.reasonCode !== LEGACY_JOB_SUMMARY_RETIREMENT_REASON ||
    !Array.isArray(receipt.proofs) ||
    legacyJobSummaryRetirementPlanSha256(planFromReceipt(receipt)) !==
      receipt.planSha256
  ) throw new Error("legacy_job_summary_retirement_receipt_invalid");
  return receipt;
}

function safeComponent(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === ".." || basename(safe) !== safe) {
    throw new Error("legacy_job_summary_identity_invalid");
  }
  return safe;
}

function identityComponent(value: string): string {
  return `${safeComponent(value).slice(0, 80)}--${sha256(value).slice(0, 16)}`;
}

function assertRegistryJobOwned(input: {
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly jobIdPrefixes: readonly string[];
  readonly manifest: CodexGoalJobManifest;
  readonly manifestPath: string;
  readonly allowUnscopedLegacy: boolean;
}): void {
  if (!matchesPrefix(input.manifest.jobId, input.jobIdPrefixes)) {
    throw new Error("legacy_job_summary_job_prefix_mismatch");
  }
  const expectedRoot = join(resolve(input.registryRootDir), input.manifest.jobId);
  if (resolve(input.manifestPath) !== join(expectedRoot, "job.json") ||
    resolve(input.manifest.jobRootDir) !== expectedRoot) {
    throw new Error("legacy_job_summary_registry_ownership_mismatch");
  }
  const manifestProjectId = input.manifest.projectAccessScope?.projectId;
  if (manifestProjectId !== input.projectId &&
    !(input.allowUnscopedLegacy && manifestProjectId === undefined)) {
    throw new Error("legacy_job_summary_project_mismatch");
  }
}

function matchesPrefix(jobId: string, prefixes: readonly string[]): boolean {
  return prefixes.length > 0 && prefixes.some((prefix) =>
    prefix.length > 0 && jobId.startsWith(prefix));
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
