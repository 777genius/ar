import {
  CodexProviderEgressProfileId,
} from "@vioxen/subscription-runtime/provider-codex";

export type HostedTestEgressGrant = {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly profileId: CodexProviderEgressProfileId.TestNpmQualification
    | CodexProviderEgressProfileId.TestManagedQualification;
};

export type HostedTestEgressIdentity = Pick<
  HostedTestEgressGrant, "jobId" | "jobRootDir" | "workspacePath"
>;

export function parseHostedTestEgressGrant(value: unknown): HostedTestEgressGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !==
      "jobId,jobRootDir,profileId,schemaVersion,workspacePath" ||
      record.schemaVersion !== 1 ||
      (record.profileId !== CodexProviderEgressProfileId.TestNpmQualification &&
       record.profileId !== CodexProviderEgressProfileId.TestManagedQualification) ||
      typeof record.jobId !== "string" || !record.jobId.trim() ||
      record.jobId.length > 256 ||
      typeof record.jobRootDir !== "string" || !record.jobRootDir ||
      typeof record.workspacePath !== "string" || !record.workspacePath) invalid();
  return Object.freeze({
    schemaVersion: 1,
    jobId: record.jobId,
    jobRootDir: record.jobRootDir,
    workspacePath: record.workspacePath,
    profileId: record.profileId,
  });
}

export function assertHostedTestEgressIdentity(
  grant: HostedTestEgressGrant,
  identity: HostedTestEgressIdentity,
): void {
  if (grant.jobId !== identity.jobId ||
      grant.jobRootDir !== identity.jobRootDir ||
      grant.workspacePath !== identity.workspacePath) invalid();
}

function invalid(): never {
  throw new Error("hosted_test_egress_grant_invalid");
}
