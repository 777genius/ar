import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  consumedOutputRecordFor,
  type ConsumedOutputLedger,
  type ProjectAccessScope,
  type ProjectAdmissionRequest,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import { readCodexGoalJob, type CodexGoalJobManifest, type CodexGoalJobSummary } from "../../codex-goal-jobs";
import { captureCodexGoalHandoffPatchFingerprint } from "../../codex-goal-handoff-artifacts";
import { stringValue } from "../codex-goal-input-values";
import { matchesProjectControlPrefix, pathInsideOrEqual } from "./codex-goal-project-utils";
import {
  admissionCreationTargetIdentity,
  admissionStartSelfIdentity,
  type ProjectAdmissionTargetBinding,
} from "./codex-goal-project-admission-target";
import {
  admissionWorkspacePathsMatch,
  optionalRealPathForAdmission,
} from "./codex-goal-project-admission-paths";
import { readVerifiedProducerHandoff } from "./codex-goal-project-verifier-handoff";
import { defaultProjectControlGitPort } from "./adapters/host-command-adapters";

type JsonObject = Readonly<Record<string, unknown>>;
type RequestedWorkspaceInput = {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly controllerJobId?: string;
  readonly requestedWorkspacePath?: string;
  readonly targetBinding?: ProjectAdmissionTargetBinding;
  readonly targetRequest?: ProjectAdmissionRequest;
};
type RetainedOutputEvidenceInput = {
  readonly item: JsonObject;
  readonly consumedOutput: ConsumedOutputLedger;
  readonly summariesByJobId: ReadonlyMap<string, CodexGoalJobSummary>;
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
  readonly readJob: ((input: {
    readonly registryRootDir: string;
    readonly jobId: string;
  }) => Promise<CodexGoalJobManifest>) | undefined;
  readonly isolatedRequestedWorkspace: boolean;
  readonly duplicateWorkspaceIdentity: boolean;
};

export async function isolatedRequestedWorkspaceIdentity(
  input: RequestedWorkspaceInput,
  summaries: readonly CodexGoalJobSummary[],
  overviewItems: readonly JsonObject[],
): Promise<boolean> {
  const requested = input.requestedWorkspacePath;
  if (!requested) return false;
  const bindingInput = { ...input,
    ...(input.targetBinding ? { binding: input.targetBinding } : {}),
    ...(input.targetRequest ? { request: input.targetRequest } : {}),
  };
  const createdIdentity = await admissionCreationTargetIdentity(bindingInput);
  const identity = await optionalRealPathForAdmission(requested) ?? createdIdentity;
  if (!identity) return false;
  if (!createdIdentity) try {
    const root = await defaultProjectControlGitPort.run({
      args: ["-C", requested, "rev-parse", "--show-toplevel"],
    });
    if (await optionalRealPathForAdmission(root.stdout.trim()) !== identity) return false;
  } catch {
    return false;
  }
  const self = await admissionStartSelfIdentity({ ...bindingInput, summaries, overviewItems });
  for (const summary of summaries) {
    const historical = await optionalRealPathForAdmission(summary.workspacePath);
    if (!historical) return false;
    if (historical === identity && !(self?.jobId === summary.jobId && self.workspacePath === identity)) return false;
  }
  return true;
}

export async function stoppedRetainedOutputPathEvidence(input: RetainedOutputEvidenceInput): Promise<(Pick<ProjectDebtItem, "affectedPaths" | "pathDisjointProducerEligible" | "evidence"> & {
  readonly affectedPaths: readonly string[];
}) | undefined> {
  const { item } = input;
  const jobId = stringValue(item.jobId);
  const workspace = stringValue(item.workspacePath);
  const summary = jobId ? input.summariesByJobId.get(jobId) : undefined;
  // A missing lease or workerAlive:false alone is not stopped evidence. Require
  // explicit process observation and a native strict completed result, then
  // re-read the retained identity/bytes and the complete current Git snapshot.
  if (!input.isolatedRequestedWorkspace || !summary || !input.readJob || !workspace ||
    item.workerAlive !== false || item.workerProcessAlive !== false ||
    item.progressProcessAlive !== false || item.workspaceDirty !== true ||
    item.resultExists !== true ||
    (item.resultStatus !== "done" && item.resultStatus !== "completed") ||
    (item.activeWriterRisk !== "none" && item.activeWriterRisk !== "dirty_workspace_without_worker") ||
    (item.workspaceConflict === true && !input.duplicateWorkspaceIdentity)) return undefined;
  try {
    if (consumedOutputRecordFor({ ledger: input.consumedOutput, jobId: summary.jobId,
      workspacePath: workspace, resolvedWorkspacePath: await realpath(workspace) })) return undefined;
    const manifest = await input.readJob({ registryRootDir: input.registryRootDir, jobId: summary.jobId });
    await assertRetainedRegistryCustody({ registryRootDir: input.registryRootDir,
      scope: input.scope, summary, manifest });
    if (manifest.jobId !== summary.jobId ||
      !await admissionWorkspacePathsMatch(manifest.workspacePath, workspace) ||
      !await admissionWorkspacePathsMatch(summary.workspacePath, workspace)) return undefined;
    const retained = await readVerifiedProducerHandoff({ producer: manifest });
    if (!retained.resultPath || retained.changedPaths.length === 0) return undefined;
    const current = await captureCodexGoalHandoffPatchFingerprint({
      workspacePath: workspace, expectedBaseCommit: retained.baseCommit,
    });
    if (!current || current.patchSha256 !== retained.patchSha256 ||
      JSON.stringify(current.changedPaths) !== JSON.stringify(retained.changedPaths)) return undefined;
    return {
      affectedPaths: retained.changedPaths, pathDisjointProducerEligible: true,
      evidence: [
        `stopped terminal output retained for ${jobId}: ${retained.resultPath}`,
        `handoff manifestSha256=${retained.manifestSha256} patchSha256=${retained.patchSha256}`,
      ],
    };
  } catch {
    return undefined;
  }
}

async function assertRetainedRegistryCustody(input: {
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly summary: CodexGoalJobSummary;
  readonly manifest: CodexGoalJobManifest;
}): Promise<void> {
  const jobId = input.summary.jobId;
  const registry = resolve(input.registryRootDir);
  const manifestPath = join(registry, jobId, "job.json");
  if (basename(jobId) !== jobId || jobId.includes("\\") ||
    input.manifest.jobId !== jobId || resolve(input.summary.manifestPath) !== manifestPath ||
    (input.scope.registryRoot && resolve(input.scope.registryRoot) !== registry)) {
    throw new Error("retained_admission_registry_identity_mismatch");
  }
  const canonicalRegistry = await realpath(registry);
  const registration = await lstat(dirname(manifestPath));
  const file = await lstat(manifestPath);
  if (!registration.isDirectory() || registration.isSymbolicLink() ||
    !file.isFile() || file.isSymbolicLink() || file.size > 1024 * 1024 ||
    await realpath(manifestPath) !== join(canonicalRegistry, jobId, "job.json") ||
    !isDeepStrictEqual(await readCodexGoalJob({ registryRootDir: registry, jobId }), input.manifest)) {
    throw new Error("retained_admission_registry_custody_mismatch");
  }
  // Native creation permits a prefixed job root below the registry's parent,
  // including sibling jobs/<jobId>; both lexical and physical roots must agree.
  const root = resolve(input.manifest.jobRootDir);
  const base = dirname(registry);
  const rootStat = await lstat(root);
  const canonicalRoot = await realpath(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
    !pathInsideOrEqual(root, base) ||
    !pathInsideOrEqual(canonicalRoot, await realpath(base)) ||
    !matchesProjectControlPrefix(basename(root), input.scope.jobIdPrefixes ?? []) ||
    !matchesProjectControlPrefix(basename(canonicalRoot), input.scope.jobIdPrefixes ?? [])) {
    throw new Error("retained_admission_job_root_outside_scope");
  }
}
