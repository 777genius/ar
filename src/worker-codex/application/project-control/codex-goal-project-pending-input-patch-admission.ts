import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type {
  CodexGoalJobManifest,
  CodexGoalJobSummary,
  CodexGoalProjectPreStartAdmission,
} from "../../codex-goal-jobs";
import {
  validateBuiltinWorkerLaunchSpec,
  workerLaunchSpecHasOwnershipBoundWorkKey,
} from "./codex-goal-project-builtin-pre-start-admission";
import { assertProjectPreStartAdmissionLaunchBinding } from
  "./codex-goal-project-pre-start-admission";
import {
  captureProjectPreStartBinding,
  verifiedInputPatchBindingValid,
  verifiedInputPatchFromReceipt,
} from "./codex-goal-project-pre-start-binding";
import {
  parseWorkerLaunchSpec,
  workerLaunchOwnsChangedPath,
} from "./worker-launch-spec";

type JsonObject = Readonly<Record<string, unknown>>;

const MAX_CONTRACT_BYTES = 256 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

export type ValidatedPendingInputPatchAdmission = {
  readonly attestationSha256: string;
  readonly ownedPaths: readonly string[];
  readonly affectedPaths: readonly string[];
};

const PENDING_RECOMMENDED_ACTION = "inspect_dirty_workspace";

export async function pendingAdmittedInputPatchPathEvidence(input: {
  readonly item: JsonObject;
  readonly summary: CodexGoalJobSummary | undefined;
  readonly workerAlive: boolean;
  readonly duplicateWorkspaceIdentity: boolean;
  readonly registryRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly readJob?: (input: {
    readonly registryRootDir: string;
    readonly jobId: string;
  }) => Promise<CodexGoalJobManifest>;
}): Promise<
  | {
      readonly affectedPaths: readonly string[];
      readonly pathDisjointProducerEligible: true;
    }
  | undefined
> {
  if (
    input.workerAlive ||
    input.item.workerAlive !== false ||
    input.item.workspaceDirty !== true ||
    input.item.resultExists !== false ||
    input.item.resultStatus !== undefined ||
    input.item.recommendedAction !== PENDING_RECOMMENDED_ACTION ||
    !Array.isArray(input.item.lifecycleMarkerTypes) ||
    input.item.lifecycleMarkerTypes.length > 0 ||
    input.item.activeWriterRisk !== "dirty_workspace_without_worker" ||
    input.item.workspaceConflict === true ||
    input.duplicateWorkspaceIdentity ||
    !input.summary ||
    !strictProducerRole(input.summary.tags) ||
    !input.readJob
  ) {
    return undefined;
  }
  try {
    const manifest = await input.readJob({
      registryRootDir: input.registryRootDir,
      jobId: input.summary.jobId,
    });
    if (
      !strictProducerRole(manifest.tags ?? []) ||
      !await workspacePathsMatch(
        manifest.workspacePath,
        input.summary.workspacePath,
      )
    ) {
      return undefined;
    }
    const launch = await readValidatedInputPatchWorkerLaunchSpec({
      manifest,
      scope: input.scope,
    });
    return {
      affectedPaths: launch.affectedPaths,
      pathDisjointProducerEligible: true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Revalidates immutable ownership for a broker-admitted patch which has not
 * launched. The caller must hold the workspace lock when this authorizes a
 * start; admission snapshot callers use it only as conservative path evidence.
 */
export async function readValidatedInputPatchWorkerLaunchSpec(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<ValidatedPendingInputPatchAdmission> {
  return (await inspectValidatedInputPatchAdmission(input)).admission;
}

export async function readExpectedPendingInputPatchReceipt(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly expected: ValidatedPendingInputPatchAdmission;
}): Promise<JsonObject> {
  const observed = await inspectValidatedInputPatchAdmission(input);
  if (
    observed.admission.attestationSha256 !==
      input.expected.attestationSha256 ||
    !samePaths(observed.admission.ownedPaths, input.expected.ownedPaths) ||
    !samePaths(observed.admission.affectedPaths, input.expected.affectedPaths)
  ) {
    throw new Error("project_control_pre_start_pending_attestation_mismatch");
  }
  return observed.receipt;
}

export async function readCurrentExpectedPendingInputPatchReceipt(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly expected: ValidatedPendingInputPatchAdmission;
}): Promise<JsonObject> {
  const descriptor = await assertPendingDescriptorSecure(input.manifest);
  if (!("mode" in descriptor) || descriptor.mode !== "serial-builtin") {
    throw new Error(
      "project_control_pre_start_builtin_validated_input_patch_required",
    );
  }
  const [contract, receipt] = await Promise.all([
    readJsonArtifact(descriptor.contractPath, MAX_CONTRACT_BYTES),
    readJsonArtifact(descriptor.receiptPath, MAX_RECEIPT_BYTES),
  ]);
  if (
    receipt.value.status !== "validated_not_launched" ||
    receipt.value.workspaceMode !== "verified_input_patch" ||
    attestationSha256(contract.raw, receipt.raw) !==
      input.expected.attestationSha256
  ) {
    throw new Error("project_control_pre_start_pending_attestation_mismatch");
  }
  return receipt.value;
}

export function assertPendingInputPatchTerminalFree(
  status: {
    readonly resultExists?: boolean;
    readonly resultStatus?: string;
    readonly recommendedAction?: unknown;
    readonly lifecycleMarkerTypes?: unknown;
  },
): void {
  if (
    status.resultExists !== false ||
    status.resultStatus !== undefined ||
    status.recommendedAction !== PENDING_RECOMMENDED_ACTION ||
    (Array.isArray(status.lifecycleMarkerTypes) &&
      status.lifecycleMarkerTypes.length > 0)
  ) {
    throw new Error("project_control_pending_input_patch_terminal_state");
  }
}

async function inspectValidatedInputPatchAdmission(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<{
  readonly admission: ValidatedPendingInputPatchAdmission;
  readonly receipt: JsonObject;
}> {
  const descriptor = input.manifest.projectPreStartAdmission;
  if (
    !descriptor ||
    !("mode" in descriptor) ||
    descriptor.mode !== "serial-builtin"
  ) {
    throw new Error(
      "project_control_pre_start_builtin_validated_input_patch_required",
    );
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch",
  });
  const [contractBefore, receiptBefore] = await Promise.all([
    readJsonArtifact(descriptor.contractPath, MAX_CONTRACT_BYTES),
    readJsonArtifact(descriptor.receiptPath, MAX_RECEIPT_BYTES),
  ]);
  if (
    receiptBefore.value.status !== "validated_not_launched" ||
    receiptBefore.value.workspaceMode !== "verified_input_patch"
  ) {
    throw new Error(
      "project_control_pre_start_validated_input_patch_receipt_required",
    );
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch",
  });
  const [contractAfter, receiptAfter, state] = await Promise.all([
    readJsonArtifact(descriptor.contractPath, MAX_CONTRACT_BYTES),
    readJsonArtifact(descriptor.receiptPath, MAX_RECEIPT_BYTES),
    readJsonArtifact(descriptor.statePath, MAX_STATE_BYTES),
  ]);
  if (
    !contractBefore.raw.equals(contractAfter.raw) ||
    !receiptBefore.raw.equals(receiptAfter.raw)
  ) {
    throw new Error("project_control_pre_start_attestation_changed_during_read");
  }
  await validateBuiltinWorkerLaunchSpec({
    contract: contractAfter.value,
    state: state.value,
    manifest: input.manifest,
    scope: input.scope,
  });
  const launch = parseWorkerLaunchSpec(contractAfter.value);
  if (
    launch.inputPatchHash === null ||
    !workerLaunchSpecHasOwnershipBoundWorkKey(launch)
  ) {
    throw new Error(
      "project_control_pre_start_validated_input_patch_binding_required",
    );
  }
  const binding = await captureProjectPreStartBinding(
    input.manifest,
    descriptor,
  );
  const verifiedInputPatch = verifiedInputPatchFromReceipt(
    receiptAfter.value,
    contractAfter.value,
  );
  if (
    !verifiedInputPatch ||
    !verifiedInputPatchBindingValid(binding, verifiedInputPatch) ||
    binding.workspaceStagedPaths.length === 0 ||
    !binding.workspaceStagedPaths.every((path) =>
      workerLaunchOwnsChangedPath(launch, path)
    )
  ) {
    throw new Error(
      "project_control_pre_start_pending_patch_ownership_mismatch",
    );
  }
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    workspaceMode: "admitted_input_patch",
  });
  const [contractFinal, receiptFinal] = await Promise.all([
    readJsonArtifact(descriptor.contractPath, MAX_CONTRACT_BYTES),
    readJsonArtifact(descriptor.receiptPath, MAX_RECEIPT_BYTES),
  ]);
  if (
    !contractAfter.raw.equals(contractFinal.raw) ||
    !receiptAfter.raw.equals(receiptFinal.raw)
  ) {
    throw new Error("project_control_pre_start_attestation_changed_during_read");
  }
  return {
    admission: {
      attestationSha256: attestationSha256(
        contractFinal.raw,
        receiptFinal.raw,
      ),
      ownedPaths: launch.ownedPaths,
      affectedPaths: binding.workspaceStagedPaths,
    },
    receipt: receiptFinal.value,
  };
}

async function readJsonArtifact(
  path: string,
  maxBytes: number,
): Promise<{ readonly raw: Buffer; readonly value: JsonObject }> {
  const leafBefore = await lstat(path, { bigint: true });
  assertBoundedRegularArtifact(leafBefore, maxBytes);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer;
  try {
    const openedBefore = await handle.stat({ bigint: true });
    assertBoundedRegularArtifact(openedBefore, maxBytes);
    if (!sameArtifactSnapshot(leafBefore, openedBefore)) {
      throw new Error("artifact_changed_during_read");
    }
    const bounded = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const read = await handle.read(
        bounded,
        bytesRead,
        bounded.byteLength - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error("size_limit_exceeded");
    const openedAfter = await handle.stat({ bigint: true });
    const leafAfter = await lstat(path, { bigint: true });
    if (
      !sameArtifactSnapshot(openedBefore, openedAfter) ||
      !sameArtifactSnapshot(openedAfter, leafAfter) ||
      openedAfter.size !== BigInt(bytesRead)
    ) {
      throw new Error("artifact_changed_during_read");
    }
    raw = bounded.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("json_object_required");
  }
  return { raw, value: value as JsonObject };
}

function assertBoundedRegularArtifact(
  stat: BigIntStats,
  maxBytes: number,
): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("artifact_leaf_not_regular");
  }
  if (stat.size > BigInt(maxBytes)) throw new Error("size_limit_exceeded");
}

function sameArtifactSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function strictProducerRole(tags: readonly string[]): boolean {
  const roles = tags.filter((tag) => tag.startsWith("worker-role-"));
  return roles.length === 1 && roles[0] === "worker-role-producer";
}

async function assertPendingDescriptorSecure(
  manifest: CodexGoalJobManifest,
): Promise<CodexGoalProjectPreStartAdmission> {
  const descriptor = manifest.projectPreStartAdmission;
  if (!descriptor) {
    throw new Error("project_control_pre_start_admission_required");
  }
  const artifactRoot = join(manifest.jobRootDir, "pre-start-admission");
  const expectedPaths = {
    contractPath: join(artifactRoot, "contract.json"),
    statePath: join(artifactRoot, "state.json"),
    receiptPath: join(artifactRoot, "receipt.json"),
  };
  for (const [field, expectedPath] of Object.entries(expectedPaths)) {
    if (descriptor[field as keyof typeof expectedPaths] !== expectedPath) {
      throw new Error(`project_control_pre_start_${field}_invalid`);
    }
  }
  if ((await lstat(manifest.jobRootDir)).isSymbolicLink()) {
    throw new Error("project_control_pre_start_job_root_symlink_denied");
  }
  if ((await lstat(artifactRoot)).isSymbolicLink()) {
    throw new Error("project_control_pre_start_artifact_root_symlink_denied");
  }
  return descriptor;
}

function attestationSha256(contract: Buffer, receipt: Buffer): string {
  return createHash("sha256")
    .update(String(contract.byteLength))
    .update("\0")
    .update(contract)
    .update(String(receipt.byteLength))
    .update("\0")
    .update(receipt)
    .digest("hex");
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((path, index) => path === right[index]);
}

async function workspacePathsMatch(left: string, right: string): Promise<boolean> {
  return (await optionalRealPath(left) ?? resolve(left)) ===
    (await optionalRealPath(right) ?? resolve(right));
}

async function optionalRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}
