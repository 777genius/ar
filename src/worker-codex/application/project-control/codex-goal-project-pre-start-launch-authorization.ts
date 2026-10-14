import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ProjectAuthorityMode, initializeProjectAuthorityPreState,
  type ProjectAccessScope,
  type ProjectAuthorityTupleStorePort,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import {
  assertProjectPreStartAdmissionLaunchBinding,
  assertProjectPreStartAdmissionDescriptorPaths,
  readLaunchAuthorizedWorkerLaunchAttestation,
  type ProjectPreStartAdmissionLaunchWorkspaceMode,
} from "./codex-goal-project-pre-start-admission";
import {
  readCurrentExpectedPendingInputPatchReceipt,
  readExpectedPendingInputPatchReceipt,
  type ValidatedPendingInputPatchAdmission,
} from "./codex-goal-project-pending-input-patch-admission";

const MAX_RECEIPT_BYTES = 64 * 1024;

type JsonObject = Readonly<Record<string, unknown>>;

export type ProjectPreStartAdmissionLaunchAuthorization = {
  readonly receiptPath: string;
  readonly previousReceipt: JsonObject;
  readonly authorizedReceipt: JsonObject;
};

export async function authorizeProjectPreStartAdmissionLaunch(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly workspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
  readonly expectedPendingInputPatch?: ValidatedPendingInputPatchAdmission;
  readonly assertLaunchEligible?: () => Promise<void>;
  readonly authorityStore?: ProjectAuthorityTupleStorePort;
}): Promise<ProjectPreStartAdmissionLaunchAuthorization | undefined> {
  const descriptor = input.manifest.projectPreStartAdmission;
  // Unchecked legacy scopes must not bypass Hosted authority via optional admission.
  if (input.scope.preStartAdmission?.authorityMode ===
      ProjectAuthorityMode.HostedWebCoreV1 &&
      (input.scope.preStartAdmission.required !== true || !descriptor || !input.authorityStore)) {
    throw new Error("project_authority_explicit_pre_start_configuration_required");
  }
  if (!descriptor) {
    if (input.scope.preStartAdmission?.required) {
      throw new Error("project_control_pre_start_admission_required");
    }
    return undefined;
  }
  let receipt = input.expectedPendingInputPatch
    ? await readExpectedPendingInputPatchReceipt({
        manifest: input.manifest,
        scope: input.scope,
        expected: input.expectedPendingInputPatch,
      })
    : await validatedReceipt(input);
  await input.assertLaunchEligible?.();
  if (input.expectedPendingInputPatch) {
    receipt = await readCurrentExpectedPendingInputPatchReceipt({
      manifest: input.manifest,
      expected: input.expectedPendingInputPatch,
    });
  }
  const authorityPreState = await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
  });
  if (input.scope.preStartAdmission?.authorityMode ===
      ProjectAuthorityMode.HostedWebCoreV1) {
    if (!input.scope.preStartAdmission.required || !input.authorityStore || !authorityPreState) {
      throw new Error("project_authority_explicit_pre_start_configuration_required");
    }
    await initializeProjectAuthorityPreState(
      input.authorityStore,
      authorityPreState,
    );
  }
  const authorizationCount =
    typeof receipt.launchAuthorizationCount === "number" &&
      Number.isSafeInteger(receipt.launchAuthorizationCount) &&
      receipt.launchAuthorizationCount >= 0
      ? receipt.launchAuthorizationCount
      : 0;
  const authorizedReceipt = {
    ...receipt,
    status: "launch_authorized",
    launchAuthorizationCount: authorizationCount + 1,
    launchAuthorizedAt: new Date().toISOString(),
  };
  await writeReceipt(descriptor.receiptPath, authorizedReceipt);
  return {
    receiptPath: descriptor.receiptPath,
    previousReceipt: receipt,
    authorizedReceipt,
  };
}

async function validatedReceipt(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly workspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
}): Promise<JsonObject> {
  await assertProjectPreStartAdmissionLaunchBinding({
    manifest: input.manifest,
    scope: input.scope,
    ...(input.workspaceMode ? { workspaceMode: input.workspaceMode } : {}),
  });
  return await readReceipt(input.manifest.projectPreStartAdmission!.receiptPath);
}

/** Trusted registered launch adapters consume a current authorized receipt;
 * they cannot replace admission by supplying a receipt-shaped object. */
export async function readAuthorizedProjectPreStartLaunchReceipt(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
}): Promise<{ readonly receipt: JsonObject; readonly receiptSha256: string }> {
  if (!input.manifest.projectPreStartAdmission) {
    throw new Error("project_control_pre_start_admission_required");
  }
  const attestation = await readLaunchAuthorizedWorkerLaunchAttestation(input);
  const snapshot = await readCurrentAuthorizedProjectPreStartLaunchReceipt(input.manifest);
  if (snapshot.receiptSha256 !== attestation.receiptSha256) {
    throw new Error("project_control_pre_start_attestation_changed_during_read");
  }
  return snapshot;
}

/** After launch the workspace is expected to change. This narrow lifetime
 * reader preserves the immutable manifest/authorization binding without
 * pretending that the original clean-workspace admission can be rerun. Trusted
 * callers also retain/compare the full receipt, contract, scope and directory. */
export async function readCurrentAuthorizedProjectPreStartLaunchReceipt(manifest: CodexGoalJobManifest): Promise<{ readonly receipt: JsonObject; readonly receiptSha256: string }> {
  const descriptor = manifest.projectPreStartAdmission;
  if (!descriptor) throw new Error("project_control_pre_start_admission_required");
  assertProjectPreStartAdmissionDescriptorPaths(descriptor, manifest.jobRootDir);
  const directories = [manifest.jobRootDir, dirname(descriptor.receiptPath)];
  const before = await Promise.all(directories.map(async path => {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("project_control_pre_start_artifact_root_invalid");
    }
    return { dev: info.dev, ino: info.ino, ctimeNs: info.ctimeNs, mtimeNs: info.mtimeNs, canonical: await realpath(path) };
  }));
  const snapshot = await readReceiptSnapshot(descriptor.receiptPath), { receipt } = snapshot;
  for (const [index, path] of directories.entries()) {
    const info = await lstat(path, { bigint: true }), expected = before[index]!;
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev ||
        info.ino !== expected.ino || info.ctimeNs !== expected.ctimeNs ||
        info.mtimeNs !== expected.mtimeNs || await realpath(path) !== expected.canonical) {
      throw new Error("project_control_pre_start_artifact_root_changed");
    }
  }
  if (receipt.status !== "launch_authorized" ||
      receipt.jobId !== manifest.jobId ||
      receipt.manifestSha256 !== createHash("sha256").update(JSON.stringify(manifest)).digest("hex") ||
      !Number.isSafeInteger(receipt.launchAuthorizationCount) ||
      (receipt.launchAuthorizationCount as number) < 1) {
    throw new Error("project_control_pre_start_launch_authorization_required");
  }
  return snapshot;
}

export async function rollbackProjectPreStartAdmissionLaunch(
  authorization: ProjectPreStartAdmissionLaunchAuthorization,
): Promise<void> {
  const currentReceipt = await readReceipt(authorization.receiptPath);
  if (!isDeepStrictEqual(currentReceipt, authorization.authorizedReceipt)) {
    throw new Error(
      "project_control_pre_start_launch_authorization_rollback_conflict",
    );
  }
  await writeReceipt(
    authorization.receiptPath,
    authorization.previousReceipt,
  );
}

export async function withProjectPreStartAdmissionLaunchAuthorization<T>(
  input: {
    readonly manifest: CodexGoalJobManifest;
    readonly scope: ProjectAccessScope;
    readonly workspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
    readonly expectedPendingInputPatch?: ValidatedPendingInputPatchAdmission;
    readonly assertLaunchEligible?: () => Promise<void>;
    readonly authorityStore?: ProjectAuthorityTupleStorePort;
  },
  start: () => Promise<T>,
): Promise<T> {
  const authorization = await authorizeProjectPreStartAdmissionLaunch(input);
  try {
    return await start();
  } catch (error) {
    if (authorization) {
      try {
        await rollbackProjectPreStartAdmissionLaunch(authorization);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "project_control_pre_start_launch_rollback_failed",
        );
      }
    }
    throw error;
  }
}

async function readReceipt(path: string): Promise<JsonObject> {
  return (await readReceiptSnapshot(path)).receipt;
}
async function readReceiptSnapshot(path: string): Promise<{ readonly receipt: JsonObject; readonly receiptSha256: string }> {
  try {
    // Observe only one bounded regular file. A forged alias or partial rewrite
    // must not become an allocated-writer or effect-authority observation.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let body: Buffer;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_RECEIPT_BYTES)) {
        throw new Error("invalid_receipt_file");
      }
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      if (!named.isFile() || named.isSymbolicLink() || named.dev !== before.dev ||
          named.ino !== before.ino || named.nlink !== 1n || after.nlink !== 1n ||
          BigInt(used) !== before.size || after.size !== before.size || named.size !== before.size ||
          after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs ||
          named.ctimeNs !== before.ctimeNs || named.mtimeNs !== before.mtimeNs) {
        throw new Error("receipt_changed_during_read");
      }
      body = buffer.subarray(0, used);
    } finally { await file.close(); }
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not_object");
    }
    return { receipt: value as JsonObject, receiptSha256: createHash("sha256").update(body).digest("hex") };
  } catch {
    throw new Error("project_control_pre_start_receipt_invalid");
  }
}

async function writeReceipt(path: string, value: JsonObject): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}
