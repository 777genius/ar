import { lstat, mkdir, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  codexGoalJobToArgs,
  readCodexGoalJob,
} from "./codex-goal-jobs";
import {
  collectCodexGoalStatus,
  resolveCodexGoalWorkerLiveness,
} from "./codex-goal-ops";
import { goalLaunchInput } from "./codex-goal-mcp-launch-input";
import { booleanValue, stringValue } from "./codex-goal-mcp-values";
import { ensureTerminalCodexGoalHandoffArtifacts } from "./application/ensure-codex-goal-handoff-artifacts";
import { codexGoalStatusInputFromLaunch } from "./application/codex-goal-status-input";
import {
  readVerifiableProducerHandoff,
  readVerifiedProducerHandoff,
  type VerifiedProducerHandoff,
} from "./application/project-control/codex-goal-project-verifier-handoff";
import { publishImmutableTextArtifact } from "./local-immutable-text-artifact";
import {
  resolveReviewedOutputAggregate,
  reviewedOutputAggregateView,
  type ReviewedOutputAggregate,
} from "./application/project-control/reviewed-output-aggregate-materializer";
import {
  LocalReviewedWorkerOutputStore,
  reviewedWorkerOutputRoot,
} from "./reviewed-worker-output";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import type { ProjectControlOperationToolName } from "./project-control-operation-lifecycle";
import type { CodexGoalMcpProjectControlJobsDeps } from "./codex-goal-mcp-project-control-jobs";

type JsonObject = Readonly<Record<string, unknown>>;

type RefillWorker = (
  args: ProjectControlMcpArgs,
  deps: CodexGoalMcpProjectControlJobsDeps,
  boundedToolName: ProjectControlOperationToolName,
) => Promise<JsonObject>;

export async function prepareProjectControlVerifierView(input: {
  readonly args: ProjectControlMcpArgs;
  readonly deps: CodexGoalMcpProjectControlJobsDeps;
  readonly refillWorker: RefillWorker;
}): Promise<JsonObject> {
  const producerJobId = stringValue(input.args.producerJobId);
  const reviewedOutputIds = reviewedOutputIdValues(
    input.args.reviewedOutputIds,
  );
  assertVerifierInputSource({
    operationToolName: "codex_goal_project_prepare_verifier",
    producerJobId,
    reviewedOutputIds,
  });
  if (reviewedOutputIds && booleanValue(input.args.confirmRefill) !== true) {
    const controller = await input.deps.loadProjectControlController(input.args);
    const aggregate = await resolveLocalReviewedOutputAggregate({
      registryRootDir: controller.registryRootDir,
      projectId: controller.scope.projectId,
      reviewedOutputIds,
    });
    return {
      ok: false,
      reason: "confirm_refill_required",
      mode: "project_control_prepare_verifier_preview",
      controllerJobId: controller.controller.jobId,
      targetJobId: stringValue(input.args.jobId),
      requiredInputPatchHash: aggregate.patchSha256,
      reviewedOutputAggregate: reviewedOutputAggregateView(aggregate),
      requiredConfirmation: "confirmRefill",
    };
  }
  if (input.args.preStartAdmission === undefined) {
    throw new Error("project_control_verifier_pre_start_admission_required");
  }
  const requestedRole = stringValue(input.args.workerRole) ?? "reviewer";
  if (requestedRole !== "reviewer" && requestedRole !== "fastgate") {
    throw new Error("project_control_verifier_role_required");
  }
  const result = await input.refillWorker(
    {
      ...input.args,
      workerRole: requestedRole,
      requireCanonicalRemoteHead: true,
    },
    input.deps,
    "codex_goal_project_prepare_verifier",
  );
  return { ...result, mode: "project_control_prepare_verifier" };
}

export function reviewedOutputIdValues(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("reviewed_output_aggregate_ids_invalid");
  }
  return value;
}

export function assertVerifierInputSource(input: {
  readonly operationToolName: ProjectControlOperationToolName;
  readonly producerJobId: string | undefined;
  readonly reviewedOutputIds: readonly string[] | undefined;
}): void {
  if (input.operationToolName !== "codex_goal_project_prepare_verifier") {
    if (input.reviewedOutputIds) {
      throw new Error(
        "project_control_reviewed_output_aggregate_verifier_only",
      );
    }
    return;
  }
  if (input.producerJobId && input.reviewedOutputIds) {
    throw new Error("project_control_verifier_input_source_conflict");
  }
  if (!input.producerJobId && !input.reviewedOutputIds) {
    throw new Error("project_control_verifier_input_source_required");
  }
}

export async function resolveLocalReviewedOutputAggregate(input: {
  readonly registryRootDir: string;
  readonly projectId: string;
  readonly reviewedOutputIds: readonly string[];
  readonly expectedBaseCommit?: string;
}): Promise<ReviewedOutputAggregate> {
  const store = new LocalReviewedWorkerOutputStore({
    rootDir: reviewedWorkerOutputRoot(input.registryRootDir),
  });
  return await resolveReviewedOutputAggregate(
    {
      store,
      readPatch: async (snapshot) => await store.readPatch(snapshot),
    },
    {
      projectId: input.projectId,
      reviewedOutputIds: input.reviewedOutputIds,
      ...(input.expectedBaseCommit
        ? { expectedBaseCommit: input.expectedBaseCommit }
        : {}),
    },
  );
}

export async function materializeReviewedOutputAggregateArtifacts(input: {
  readonly jobRootDir: string;
  readonly aggregate: ReviewedOutputAggregate;
}): Promise<{
  readonly patchPath: string;
  readonly provenancePath: string;
  readonly createdPaths: readonly string[];
}> {
  const requestedJobRootParent = dirname(input.jobRootDir);
  const jobRootParentItem = await lstat(requestedJobRootParent);
  if (jobRootParentItem.isSymbolicLink() || !jobRootParentItem.isDirectory()) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const canonicalJobRootParent = await realpath(requestedJobRootParent);
  const requestedJobRoot = join(
    canonicalJobRootParent,
    basename(input.jobRootDir),
  );
  await mkdir(requestedJobRoot, { recursive: true, mode: 0o700 });
  const jobRootItem = await lstat(requestedJobRoot);
  if (jobRootItem.isSymbolicLink() || !jobRootItem.isDirectory()) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const canonicalJobRoot = await realpath(requestedJobRoot);
  if (dirname(canonicalJobRoot) !== canonicalJobRootParent) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const root = join(canonicalJobRoot, "reviewed-output-aggregate");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootItem = await lstat(root);
  if (rootItem.isSymbolicLink() || !rootItem.isDirectory()) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const canonicalRoot = await realpath(root);
  if (dirname(canonicalRoot) !== canonicalJobRoot) {
    throw new Error("reviewed_output_aggregate_artifact_root_unsafe");
  }
  const patchPath = join(canonicalRoot, "input.patch");
  const provenancePath = join(canonicalRoot, "provenance.json");
  const createdPaths: string[] = [];
  try {
    const patchArtifact = await publishImmutableTextArtifact({
      path: patchPath,
      content: input.aggregate.patch,
      existingPathUnsafeError: "reviewed_output_aggregate_artifact_unsafe",
      contentMismatchError: "reviewed_output_aggregate_immutable_conflict",
    });
    if (patchArtifact.created) createdPaths.push(patchPath);
    const provenance = `${JSON.stringify(
      reviewedOutputAggregateView(input.aggregate),
      null,
      2,
    )}\n`;
    const provenanceArtifact = await publishImmutableTextArtifact({
      path: provenancePath,
      content: provenance,
      existingPathUnsafeError: "reviewed_output_aggregate_artifact_unsafe",
      contentMismatchError: "reviewed_output_aggregate_immutable_conflict",
    });
    if (provenanceArtifact.created) createdPaths.push(provenancePath);
    return { patchPath, provenancePath, createdPaths };
  } catch (error) {
    await removeReviewedOutputAggregateArtifacts(createdPaths);
    throw error;
  }
}

export async function removeReviewedOutputAggregateArtifacts(
  paths: readonly string[],
): Promise<void> {
  for (const path of [...paths].reverse()) await rm(path, { force: true });
  const root = paths[0] ? dirname(paths[0]) : undefined;
  if (root) await rmdir(root).catch(() => undefined);
}

export async function resolveProducerHandoffForVerifier(input: {
  readonly registryRootDir: string;
  readonly producerJobId: string;
  readonly expectedInputPatchHash: unknown;
  readonly allowProviderOutputInvalid: boolean;
}): Promise<VerifiedProducerHandoff> {
  const producer = await readCodexGoalJob({
    registryRootDir: input.registryRootDir,
    jobId: input.producerJobId,
  });
  const launch = await goalLaunchInput(codexGoalJobToArgs(producer));
  const initialStatus = await collectCodexGoalStatus(
    codexGoalStatusInputFromLaunch(launch),
  );
  const status = await ensureTerminalCodexGoalHandoffArtifacts({
    launch,
    status: initialStatus,
  });
  if (resolveCodexGoalWorkerLiveness({ status }).alive) {
    throw new Error("project_control_verifier_producer_still_running");
  }
  const handoff = input.allowProviderOutputInvalid
    ? await readVerifiableProducerHandoff({ producer })
    : await readVerifiedProducerHandoff({ producer });
  if (
    typeof input.expectedInputPatchHash !== "string" ||
    input.expectedInputPatchHash.toLowerCase() !== handoff.patchSha256
  ) {
    throw new Error("project_control_verifier_admission_patch_hash_mismatch");
  }
  return handoff;
}
