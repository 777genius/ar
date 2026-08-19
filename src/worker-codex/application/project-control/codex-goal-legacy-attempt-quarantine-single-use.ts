import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { durablePublishJsonFile } from
  "../../project-control-operation-file-store";

type LegacyAttemptQuarantineActivePlan = {
  readonly schemaVersion: 1;
  readonly planSha256: string;
};

type LegacyAttemptReplayPlan = {
  readonly controllerJobId: string;
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly controllerJobRootDir: string;
  readonly sourceStaleIntegrationPlanSha256: string;
  readonly cutoff: string;
  readonly targetWorkspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly allowedGitRemotes: readonly string[];
  readonly allowedBranches: readonly string[];
};

export function normalizedLegacyAttemptQuarantineCutoff(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("legacy_attempt_quarantine_source_plan_invalid");
  }
  return new Date(parsed).toISOString();
}

export function assertLegacyAttemptQuarantineReplayRequest(
  plan: LegacyAttemptReplayPlan,
  input: Omit<LegacyAttemptReplayPlan, "cutoff">,
  cutoff: string,
): void {
  if (plan.controllerJobId !== input.controllerJobId ||
    plan.projectId !== input.projectId ||
    plan.registryRootDir !== resolve(input.registryRootDir) ||
    plan.controllerJobRootDir !== resolve(input.controllerJobRootDir) ||
    plan.sourceStaleIntegrationPlanSha256 !==
      input.sourceStaleIntegrationPlanSha256 || plan.cutoff !== cutoff ||
    JSON.stringify(plan.targetWorkspaceRoots) !==
      JSON.stringify(exactPaths(input.targetWorkspaceRoots)) ||
    JSON.stringify(plan.deniedRoots) !== JSON.stringify(exactPaths(input.deniedRoots)) ||
    JSON.stringify(plan.allowedGitRemotes) !==
      JSON.stringify(exactStrings(input.allowedGitRemotes)) ||
    JSON.stringify(plan.allowedBranches) !==
      JSON.stringify(exactStrings(input.allowedBranches))) {
    throw new Error("legacy_attempt_quarantine_single_use_conflict");
  }
}

export async function claimLegacyAttemptQuarantineSingleUse(input: {
  readonly controllerJobRootDir: string;
  readonly planSha256: string;
  readonly epochPlanSha256s: readonly string[];
}): Promise<void> {
  const existing = await resolveLegacyAttemptQuarantineSingleUsePlan(input);
  if (existing && existing !== input.planSha256) {
    throw new Error("legacy_attempt_quarantine_single_use_conflict");
  }
  await durablePublishJsonFile({
    path: legacyAttemptQuarantineActivePlanPath(input.controllerJobRootDir),
    value: {
      schemaVersion: 1,
      planSha256: input.planSha256,
    } satisfies LegacyAttemptQuarantineActivePlan,
  });
  await assertLegacyAttemptQuarantineActivePlan(
    input.controllerJobRootDir,
    input.planSha256,
  );
}

export async function assertLegacyAttemptQuarantineSingleUseExpected(input: {
  readonly controllerJobRootDir: string;
  readonly expectedPlanSha256: string;
  readonly epochPlanSha256s: readonly string[];
}): Promise<void> {
  const existing = await resolveLegacyAttemptQuarantineSingleUsePlan(input);
  if (existing !== input.expectedPlanSha256) {
    throw new Error("legacy_attempt_quarantine_single_use_conflict");
  }
}

export async function resolveLegacyAttemptQuarantineSingleUsePlan(input: {
  readonly controllerJobRootDir: string;
  readonly epochPlanSha256s: readonly string[];
}): Promise<string | undefined> {
  const shas = new Set<string>();
  const marker = await optionalJson<LegacyAttemptQuarantineActivePlan>(
    legacyAttemptQuarantineActivePlanPath(input.controllerJobRootDir),
  );
  if (marker) {
    if (marker.schemaVersion !== 1 || !validSha(marker.planSha256)) {
      throw new Error("legacy_attempt_quarantine_active_plan_invalid");
    }
    shas.add(marker.planSha256);
  }
  for (const sha of input.epochPlanSha256s) {
    if (!validSha(sha)) {
      throw new Error("legacy_attempt_quarantine_epoch_anchor_invalid");
    }
    shas.add(sha);
  }
  for (const directory of ["plans", "receipts"] as const) {
    for (const name of await optionalArtifactNames(join(
      legacyAttemptQuarantineRoot(input.controllerJobRootDir),
      directory,
    ))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) {
        throw new Error("legacy_attempt_quarantine_artifact_root_invalid");
      }
      shas.add(name.slice(0, 64));
    }
  }
  if (shas.size > 1) {
    throw new Error("legacy_attempt_quarantine_single_use_conflict");
  }
  return [...shas][0];
}

export async function assertLegacyAttemptQuarantineActivePlan(
  controllerJobRootDir: string,
  planSha256: string,
): Promise<void> {
  const marker = await readJson<LegacyAttemptQuarantineActivePlan>(
    legacyAttemptQuarantineActivePlanPath(controllerJobRootDir),
  );
  if (marker.schemaVersion !== 1 || marker.planSha256 !== planSha256) {
    throw new Error("legacy_attempt_quarantine_active_plan_mismatch");
  }
}

export function legacyAttemptQuarantineActivePlanPath(
  controllerJobRootDir: string,
): string {
  return join(legacyAttemptQuarantineRoot(controllerJobRootDir), "active-plan.json");
}

function legacyAttemptQuarantineRoot(controllerJobRootDir: string): string {
  return join(
    resolve(controllerJobRootDir),
    "project-integration",
    "legacy-attempt-quarantine",
  );
}

async function optionalArtifactNames(path: string): Promise<readonly string[]> {
  try {
    const names = await readdir(path);
    if (names.length > 2) {
      throw new Error("legacy_attempt_quarantine_artifact_root_too_large");
    }
    return names.sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function readJson<T>(path: string): Promise<T> {
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024) {
    throw new Error("legacy_attempt_quarantine_single_use_artifact_too_large");
  }
  return JSON.parse(bytes.toString("utf8")) as T;
}

async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function exactPaths(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function exactStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
