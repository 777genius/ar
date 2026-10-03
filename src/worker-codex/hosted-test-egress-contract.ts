import {
  CodexProviderEgressProfileId,
  CodexModelBackend,
  HostedMimoProfile,
} from "@vioxen/subscription-runtime/provider-codex";

export type HostedTestEgressGrant = {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly profileId: CodexProviderEgressProfileId.TestNpmQualification
    | CodexProviderEgressProfileId.TestManagedQualification;
} | HostedMimoGrant;

export type HostedMimoGrant = {
  readonly schemaVersion: 2;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly profileId: CodexProviderEgressProfileId.MimoTokenPlan;
  readonly accountId: "account-q";
  readonly hostedProfile: HostedMimoProfile;
  readonly modelBackend: CodexModelBackend.XiaomiMimoTokenPlan;
  readonly executionEngine: "app-server-goal";
  readonly namedPermissions: true;
  readonly globalScanGuard: true;
  readonly nativeToolSurface: "disabled";
};

export type HostedTestEgressIdentity = Pick<
  HostedTestEgressGrant, "jobId" | "jobRootDir" | "workspacePath"
>;

export function parseHostedTestEgressGrant(value: unknown): HostedTestEgressGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 2) {
    if (Object.keys(record).sort().join(",") !==
        "accountId,executionEngine,globalScanGuard,hostedProfile,jobId,jobRootDir,modelBackend,namedPermissions,nativeToolSurface,profileId,schemaVersion,workspacePath" ||
        record.profileId !== CodexProviderEgressProfileId.MimoTokenPlan ||
        record.accountId !== "account-q" ||
        (record.hostedProfile !== HostedMimoProfile.Controller && record.hostedProfile !== HostedMimoProfile.Child) ||
        record.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan ||
        record.executionEngine !== "app-server-goal" || record.namedPermissions !== true ||
        record.globalScanGuard !== true || record.nativeToolSurface !== "disabled" ||
        typeof record.jobId !== "string" || !record.jobId.trim() || record.jobId.length > 256 ||
        typeof record.jobRootDir !== "string" || !record.jobRootDir ||
        typeof record.workspacePath !== "string" || !record.workspacePath) invalid();
    return Object.freeze(record as HostedMimoGrant);
  }
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
