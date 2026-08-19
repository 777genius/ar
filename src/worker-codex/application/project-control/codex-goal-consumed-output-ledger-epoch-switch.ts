import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ProjectDebtReason,
  type ConsumedOutputLedgerEpochPlan,
  type ConsumedOutputLedgerEpochReceipt,
  type ProjectAccessScope,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobSummary } from "../../codex-goal-jobs";
import {
  resolveConsumedOutputLedgerEpochReceipt,
  resolvePendingConsumedOutputLedgerEpochPlan,
} from "./codex-goal-consumed-output-ledger-epoch";

export type LedgerEpochCustodyFileBinding = {
  readonly path: string;
  readonly present: boolean;
  readonly canonicalPath?: string;
  readonly device?: number;
  readonly inode?: number;
  readonly byteLength?: number;
  readonly sha256?: string;
};

export type LedgerEpochDebtCustodyBinding = {
  readonly reason: string;
  readonly subject: string;
  readonly jobId?: string;
  readonly declaredPath: string;
  readonly canonicalPath: string;
  readonly device: number;
  readonly inode: number;
  readonly aliasResolutionSha256?: string;
  readonly aliasTarget?: string;
  readonly registryManifest?: LedgerEpochCustodyFileBinding;
  readonly jobUpdatedAt?: string;
  readonly jobStatus?: string;
  readonly jobArtifacts?: readonly LedgerEpochCustodyFileBinding[];
};

const JOB_REASONS = new Set<ProjectDebtReason>([
  ProjectDebtReason.UnconsumedCompletedJob,
  ProjectDebtReason.ActiveWriterConflict,
]);

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

export async function resolveLedgerEpochDebtCustody(
  snapshot: ProjectAdmissionSnapshot,
  summaries: readonly CodexGoalJobSummary[],
): Promise<readonly LedgerEpochDebtCustodyBinding[]> {
  const jobs = new Map(summaries.map((summary) => [summary.jobId, summary]));
  const debt = snapshot.debt.filter((item) =>
    item.reason === ProjectDebtReason.UnconsumedCompletedJob ||
    item.reason === ProjectDebtReason.OrphanLegacyWorkspace ||
    item.reason === ProjectDebtReason.ActiveWriterConflict ||
    item.reason === ProjectDebtReason.InactiveDirtyWorkspace
  );
  const resolvedDebt = await Promise.all(debt.map(async (item) => ({
    item,
    job: await resolveDebtJob(item, jobs, summaries),
  })));
  const bindings = await Promise.all(resolvedDebt.map(({ item, job }) =>
    bindDebtCustody(item.reason, item.subject, job)
  ));
  return bindings.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

async function resolveDebtJob(
  item: ProjectAdmissionSnapshot["debt"][number],
  jobs: ReadonlyMap<string, CodexGoalJobSummary>,
  summaries: readonly CodexGoalJobSummary[],
): Promise<CodexGoalJobSummary | undefined> {
  const exact = jobs.get(item.subject);
  if (exact || !JOB_REASONS.has(item.reason)) return exact;
  if (!isAbsolute(item.subject)) return missingDebtJob(item.subject);

  const normalizedSubject = resolve(item.subject);
  const normalizedMatches = summaries.filter((summary) =>
    isAbsolute(summary.workspacePath) &&
    resolve(summary.workspacePath) === normalizedSubject
  );
  if (normalizedMatches.length > 1) {
    const evidenceMatches = normalizedMatches.filter((summary) =>
      hasExactInactiveDirtyEvidence(item.evidence, summary.jobId)
    );
    if (evidenceMatches.length === 1) return evidenceMatches[0];
    return ambiguousDebtJob(item.subject);
  }
  if (normalizedMatches.length === 1) return normalizedMatches[0];

  let canonicalSubject: string;
  try {
    canonicalSubject = await realpath(normalizedSubject);
  } catch {
    return missingDebtJob(item.subject);
  }
  const canonicalMatches = (await Promise.all(summaries.map(async (summary) => {
    if (!isAbsolute(summary.workspacePath)) return undefined;
    try {
      return await realpath(resolve(summary.workspacePath)) === canonicalSubject
        ? summary
        : undefined;
    } catch {
      return undefined;
    }
  }))).filter((summary): summary is CodexGoalJobSummary => summary !== undefined);
  if (canonicalMatches.length > 1) return ambiguousDebtJob(item.subject);
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  return missingDebtJob(item.subject);
}

function hasExactInactiveDirtyEvidence(
  evidence: readonly string[],
  jobId: string,
): boolean {
  const expected = `${jobId} is inactive with dirty workspace`;
  return evidence.some((entry) => entry.split(/\r?\n/u).includes(expected));
}

function missingDebtJob(subject: string): never {
  throw new Error(`ledger_epoch_debt_job_manifest_missing:${subject}`);
}

function ambiguousDebtJob(subject: string): never {
  throw new Error(`ledger_epoch_debt_job_manifest_ambiguous:${subject}`);
}

export async function assertLedgerEpochDebtCustodyUnchanged(
  bindings: readonly LedgerEpochDebtCustodyBinding[],
  summaries?: readonly CodexGoalJobSummary[],
): Promise<void> {
  if (summaries) {
    try {
      const current = await Promise.all(bindings.map(async (binding) => {
        if (binding.jobId === undefined) {
          return await bindDebtCustody(binding.reason, binding.subject);
        }
        const matches = summaries.filter((summary) =>
          summary.jobId === binding.jobId
        );
        if (matches.length !== 1) {
          throw new Error("ledger_epoch_debt_custody_drift");
        }
        return await bindDebtCustody(
          binding.reason,
          binding.subject,
          matches[0],
        );
      }));
      current.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
      if (JSON.stringify(current) !== JSON.stringify(bindings)) {
        throw new Error("ledger_epoch_debt_custody_drift");
      }
    } catch {
      throw new Error("ledger_epoch_debt_custody_drift");
    }
    return;
  }
  for (const binding of bindings) {
    const canonicalPath = await realpath(binding.declaredPath);
    const metadata = await lstat(canonicalPath);
    if (canonicalPath !== binding.canonicalPath || !metadata.isDirectory() ||
      metadata.dev !== binding.device || metadata.ino !== binding.inode) {
      throw new Error("ledger_epoch_debt_workspace_identity_drift");
    }
  }
}

async function bindDebtCustody(
  reason: string,
  subject: string,
  job?: CodexGoalJobSummary,
): Promise<LedgerEpochDebtCustodyBinding> {
  const declaredPath = job?.workspacePath ?? subject;
  if (!declaredPath.startsWith("/")) {
    throw new Error(`ledger_epoch_debt_job_workspace_missing:${subject}`);
  }
  const resolvedDeclaredPath = resolve(declaredPath);
  const canonicalPath = await realpath(resolvedDeclaredPath);
  const metadata = await lstat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new Error("ledger_epoch_debt_workspace_invalid");
  }
  const declaredMetadata = await lstat(resolvedDeclaredPath);
  const aliasTarget = declaredMetadata.isSymbolicLink()
    ? await readlink(resolvedDeclaredPath)
    : undefined;
  const aliasResolutionSha256 = sha256Json({
    declaredPath: resolvedDeclaredPath,
    canonicalPath,
    declaredDevice: declaredMetadata.dev,
    declaredInode: declaredMetadata.ino,
    ...(aliasTarget === undefined ? {} : { aliasTarget }),
    device: metadata.dev,
    inode: metadata.ino,
  });
  const jobFacts = job ? await bindJobFacts(job) : undefined;
  return {
    reason,
    subject,
    ...(job ? { jobId: job.jobId } : {}),
    declaredPath: resolvedDeclaredPath,
    canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
    aliasResolutionSha256,
    ...(aliasTarget === undefined ? {} : { aliasTarget }),
    ...(jobFacts ?? {}),
  };
}

async function bindJobFacts(job: CodexGoalJobSummary) {
  const manifestPath = resolve(job.manifestPath);
  const manifestCanonicalPath = await realpath(manifestPath);
  const [manifestMetadata, manifestBytes] = await Promise.all([
    lstat(manifestCanonicalPath),
    readFile(manifestCanonicalPath),
  ]);
  if (!manifestMetadata.isFile()) {
    throw new Error("ledger_epoch_custody_file_invalid");
  }
  const registryManifest: LedgerEpochCustodyFileBinding = {
    path: manifestPath,
    present: true,
    canonicalPath: manifestCanonicalPath,
    device: manifestMetadata.dev,
    inode: manifestMetadata.ino,
    byteLength: manifestBytes.length,
    sha256: sha256(manifestBytes),
  };
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as
    Record<string, unknown>;
  const jobRoot = typeof manifest.jobRootDir === "string"
    ? resolve(manifest.jobRootDir)
    : dirname(job.manifestPath);
  const taskId = typeof manifest.taskId === "string" ? manifest.taskId : job.taskId;
  const outputPath = typeof manifest.outputPath === "string"
    ? resolve(manifest.outputPath)
    : join(jobRoot, `${taskId}.latest-result.json`);
  const expectedEventsPath = join(jobRoot, `${taskId}.events.jsonl`);
  const artifactNames = await matchingNames(jobRoot, (name) =>
    name.endsWith(".manifest.json") || name.endsWith(".events.jsonl")
  );
  const manifestNames = artifactNames.filter((name) =>
    name.endsWith(".manifest.json")
  );
  const eventNames = artifactNames.filter((name) =>
    name.endsWith(".events.jsonl")
  );
  const artifactPaths = [...new Set([
    outputPath,
    expectedEventsPath,
    ...manifestNames.map((name) => join(jobRoot, name)),
    ...eventNames.map((name) => join(jobRoot, name)),
  ])].sort();
  const jobArtifacts = await Promise.all(artifactPaths.map(bindOptionalFile));
  const output = await optionalJson(outputPath);
  return {
    registryManifest,
    jobUpdatedAt: job.updatedAt,
    jobStatus: typeof output?.status === "string" ? output.status : "unknown",
    jobArtifacts,
  };
}

async function matchingNames(
  root: string,
  predicate: (name: string) => boolean,
): Promise<readonly string[]> {
  try {
    return (await readdir(root)).filter(predicate).sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function bindOptionalFile(
  path: string,
): Promise<LedgerEpochCustodyFileBinding> {
  const resolvedPath = resolve(path);
  try {
    const canonicalPath = await realpath(resolvedPath);
    const metadata = await lstat(canonicalPath);
    if (!metadata.isFile()) throw new Error("ledger_epoch_custody_file_invalid");
    const bytes = await readFile(canonicalPath);
    return {
      path: resolvedPath,
      present: true,
      canonicalPath,
      device: metadata.dev,
      inode: metadata.ino,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { path: resolvedPath, present: false };
    throw error;
  }
}

async function optionalJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
