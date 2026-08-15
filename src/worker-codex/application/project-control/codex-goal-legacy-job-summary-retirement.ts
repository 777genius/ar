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
import { basename, dirname, join, resolve } from "node:path";
import type { CodexGoalJobManifest, CodexGoalJobSummary } from
  "../../codex-goal-jobs";

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
    safeComponent(input.projectId),
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
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly manifest: CodexGoalJobManifest;
  readonly manifestPath: string;
  readonly expectedManifestPath: string;
  readonly expectedManifestSha256: string;
  readonly expectedWorkspacePath: string;
  readonly retainedManifest: CodexGoalJobManifest;
  readonly retainedManifestPath: string;
  readonly expectedRetainedManifestSha256: string;
  readonly workerAlive: boolean;
}): Promise<LegacyJobSummaryRetirementPlan> {
  await assertCanonicalRegistryRoot(input.registryRootDir);
  const manifestPath = resolve(input.manifestPath);
  if (manifestPath !== resolve(input.expectedManifestPath)) {
    throw new Error("legacy_job_summary_manifest_path_cas_mismatch");
  }
  const manifestSha256 = await regularFileSha256(manifestPath);
  if (manifestSha256 !== input.expectedManifestSha256.toLowerCase()) {
    throw new Error("legacy_job_summary_manifest_sha256_cas_mismatch");
  }
  if (
    resolve(input.manifest.workspacePath) !== resolve(input.expectedWorkspacePath)
  ) {
    throw new Error("legacy_job_summary_workspace_cas_mismatch");
  }
  await assertWorkspaceEnoent(input.expectedWorkspacePath);
  if (input.workerAlive) throw new Error("legacy_job_summary_worker_live");
  await assertNeverLaunchedArtifactsAbsent(input.manifest);

  if (input.retainedManifest.jobId === input.manifest.jobId) {
    throw new Error("legacy_job_summary_retained_sibling_required");
  }
  const retainedManifestPath = resolve(input.retainedManifestPath);
  const retainedManifestSha256 = await regularFileSha256(retainedManifestPath);
  if (
    retainedManifestSha256 !==
      input.expectedRetainedManifestSha256.toLowerCase()
  ) {
    throw new Error("legacy_job_summary_retained_manifest_cas_mismatch");
  }
  if (
    resolve(input.retainedManifest.workspacePath) !==
      resolve(input.expectedWorkspacePath) ||
    input.retainedManifest.projectAccessScope?.projectId !== input.projectId
  ) {
    throw new Error("legacy_job_summary_retained_registration_mismatch");
  }
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    controllerJobId: input.controllerJobId,
    jobId: input.manifest.jobId,
    manifestPath,
    manifestSha256,
    workspacePath: resolve(input.expectedWorkspacePath),
    retainedRegistrationJobId: input.retainedManifest.jobId,
    retainedManifestPath,
    retainedManifestSha256,
    reasonCode: LEGACY_JOB_SUMMARY_RETIREMENT_REASON,
  };
}

export async function publishLegacyJobSummaryRetirement(input: {
  readonly registryRootDir: string;
  readonly plan: LegacyJobSummaryRetirementPlan;
  readonly expectedPlanSha256: string;
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
  const receiptPath = legacyJobSummaryRetirementPath({
    registryRootDir: input.registryRootDir,
    projectId: input.plan.projectId,
    jobId: input.plan.jobId,
    manifestSha256: input.plan.manifestSha256,
  });
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    const handle = await open(
      receiptPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dirname(receiptPath));
    return { receipt, receiptPath, idempotentReplay: false };
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    const existing = parseRetirementReceipt(await readFile(receiptPath, "utf8"));
    if (
      existing.planSha256 !== planSha256 ||
      legacyJobSummaryRetirementPlanSha256(planFromReceipt(existing)) !== planSha256
    ) {
      throw new Error("legacy_job_summary_retirement_receipt_conflict");
    }
    return { receipt: existing, receiptPath, idempotentReplay: true };
  }
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
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly summaries: readonly CodexGoalJobSummary[];
}): Promise<{
  readonly active: readonly CodexGoalJobSummary[];
  readonly retired: readonly LegacyJobSummaryRetirementReceipt[];
}> {
  let entries;
  try {
    entries = await readdir(legacyJobSummaryRetirementRoot(input), {
      withFileTypes: true,
    });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { active: input.summaries, retired: [] };
    }
    throw error;
  }
  const receipts: LegacyJobSummaryRetirementReceipt[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    receipts.push(parseRetirementReceipt(await readFile(
      join(legacyJobSummaryRetirementRoot(input), entry.name),
      "utf8",
    )));
  }
  const retired: LegacyJobSummaryRetirementReceipt[] = [];
  const active: CodexGoalJobSummary[] = [];
  for (const summary of input.summaries) {
    const candidates = receipts.filter((receipt) => receipt.jobId === summary.jobId);
    if (candidates.length === 0) {
      active.push(summary);
      continue;
    }
    const currentSha256 = await regularFileSha256(summary.manifestPath);
    let matched: LegacyJobSummaryRetirementReceipt | undefined;
    for (const receipt of candidates) {
      let retainedCurrent = false;
      try {
        retainedCurrent =
          await regularFileSha256(receipt.retainedManifestPath) ===
            receipt.retainedManifestSha256;
      } catch {
        retainedCurrent = false;
      }
      if (receipt.manifestPath === resolve(summary.manifestPath) &&
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

async function assertCanonicalRegistryRoot(root: string): Promise<void> {
  const lexical = resolve(root);
  const [physical, metadata] = await Promise.all([realpath(lexical), lstat(lexical)]);
  if (physical !== lexical || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("legacy_job_summary_registry_root_noncanonical");
  }
}

async function assertWorkspaceEnoent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("legacy_job_summary_workspace_still_exists");
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  let parent = dirname(resolve(path));
  for (;;) {
    try {
      if (await realpath(parent) !== parent) {
        throw new Error("legacy_job_summary_workspace_parent_noncanonical");
      }
      return;
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

async function assertNeverLaunchedArtifactsAbsent(
  manifest: CodexGoalJobManifest,
): Promise<void> {
  const explicit = [manifest.outputPath, manifest.progressPath, manifest.logPath]
    .filter((path): path is string => path !== undefined);
  for (const path of explicit) {
    try {
      await lstat(path);
      throw new Error("legacy_job_summary_runtime_artifact_present");
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
    }
  }
  let entries;
  try {
    entries = await readdir(manifest.jobRootDir, { withFileTypes: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  const forbidden = /(^|[-_.])(launch|handoff|result|output)([-_.]|$)/i;
  if (entries.some((entry) => forbidden.test(entry.name))) {
    throw new Error("legacy_job_summary_runtime_artifact_present");
  }
}

async function regularFileSha256(path: string): Promise<string> {
  const lexical = resolve(path);
  const [physical, metadata, bytes] = await Promise.all([
    realpath(lexical),
    lstat(lexical),
    readFile(lexical),
  ]);
  if (
    physical !== lexical || metadata.isSymbolicLink() || !metadata.isFile() ||
    metadata.size !== bytes.length
  ) throw new Error("legacy_job_summary_manifest_noncanonical");
  return sha256(bytes);
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

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeComponent(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === ".." || basename(safe) !== safe) {
    throw new Error("legacy_job_summary_identity_invalid");
  }
  return safe;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" ? error.code : undefined;
}
