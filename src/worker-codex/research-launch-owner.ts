import { trustedResearchRuntimeLaunch } from "./trusted-custody-systemd-launch";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseResearchGrant, parseResearchOperatorRequest, type ResearchStartSpec } from "./research-launch-contract";
import { installedResearchRuntimeDirectory, researchCurrentStart, researchJobAuthority } from "./research-launch-admission";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand, researchExecutableDigest } from "./research-launch-host";
import { assertResearchDirectory, researchArtifactDigest, researchAuthorityRoot, researchDirectoryIdentity,
  researchHash, researchId, researchInvalid, researchJson, researchPath, researchPrivateDirectory, researchPublish, researchRead, researchCustody, researchPromptBytes } from "./research-launch-files";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { terminalResearchStart } from "./research-launch-lifecycle";
import { annotateResearchLaunchStage, ResearchLaunchStage } from "./research-launch-diagnostics";

/** Initial-host-root only. The request is closed operator data, never a worker
 * environment, managed/TEST grant, project tag or pre-start observation. */
export function grantResearchLaunch(jobId: string, jobRootDir: string, workspacePath: string): void {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  researchId(jobId);
  const jobDirectory = researchDirectoryIdentity(jobRootDir), workspaceDirectory = researchDirectoryIdentity(workspacePath);
  if (jobRootDir === workspacePath || jobRootDir.startsWith(workspacePath + "/")) researchInvalid();
  researchPrivateDirectory(researchAuthorityRoot);
  const job = researchJobAuthority(jobId); researchPrivateDirectory(job);
  if (existsSync(join(job, "active.json"))) researchInvalid();
  // A unique grant identity makes revoke/regrant different even for the same tuple.
  researchPublish(join(job, "grant.json"), { schemaVersion: 1, jobId, jobRootDir, workspacePath,
    profileId: CodexProviderEgressProfileId.FullInternetV1, grantId: randomUUID(), jobDirectory, workspaceDirectory });
}
export function revokeResearchLaunch(jobId: string): void {
  assertResearchInitialRoot(true);
  const path = join(researchJobAuthority(jobId), "grant.json");
  researchRead(path); unlinkSync(path); // Active ownership is retained for verified cancel.
}
export function startResearchLaunch(requestPath: string, expectedRequestSha256: string): { jobId: string; unit: string; startId: string; specSha256: string } {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  researchPath(requestPath);
  const requestBytes = researchRead(requestPath);
  if (researchHash(requestBytes) !== expectedRequestSha256) researchInvalid();
  const request = parseResearchOperatorRequest(researchJson(requestBytes)), job = researchJobAuthority(request.jobId);
  if (!existsSync(join(job, "active.json")) && existsSync(join(job, "last-terminal.json"))) terminalResearchStart(request.jobId);
  const grantBytes = researchRead(join(job, "grant.json"));
  const grant = parseResearchGrant(researchJson(grantBytes));
  if (grant.jobId !== request.jobId || grant.jobRootDir !== request.jobRootDir || grant.workspacePath !== request.workspacePath) researchInvalid();
  assertResearchDirectory(grant.jobDirectory); assertResearchDirectory(grant.workspaceDirectory);
  const runtimeDirectory = installedResearchRuntimeDirectory();
  const artifactSha256 = researchArtifactDigest(runtimeDirectory);
  const nodeSha256 = researchExecutableDigest(process.execPath), codexSha256 = researchExecutableDigest(request.codexBinaryPath);
  researchPromptBytes(researchDirectoryIdentity(request.jobRootDir), request.promptPath);
  // Auth roots are trust inputs, not provider-readable writable workspaces.
  researchCustody(request.authRootDir);
  const startId = randomUUID(), unit = `subscription-runtime-research-${startId}.service`;
  researchPrivateDirectory(join(job, "starts"));
  const directory = join(job, "starts", startId); researchPrivateDirectory(directory);
  researchPrivateDirectory(join(directory, "providers")); researchPrivateDirectory(join(directory, "pins"));
  const jobDirectory = researchDirectoryIdentity(request.jobRootDir), workspaceDirectory = researchDirectoryIdentity(request.workspacePath);
  const spec: ResearchStartSpec = { schemaVersion: 1, startId, runtimeDirectory, artifactSha256, nodeSha256, codexSha256,
    grantSha256: researchHash(grantBytes), request, requestSha256: expectedRequestSha256, unit, jobDirectory, workspaceDirectory };
  // Acquire the per-job active slot exclusively before any mount/service effect.
  const specBytes = Buffer.from(JSON.stringify(spec) + "\n"), specSha256 = researchHash(specBytes);
  researchPublish(join(directory, "spec.json"), spec, true);
  researchPublish(join(job, "active.json"), { schemaVersion: 1, startId, specSha256 }, true);
  // Never undo an uncertain launch. The retained active slot identifies exactly
  // what status/cancel must reconcile; no replacement job or shared-scope kill.
  let stage = ResearchLaunchStage.PinPreparation;
  try {
    for (const [name, identity] of [["job", jobDirectory], ["workspace", workspaceDirectory]] as const) {
      const pin = join(directory, "pins", name); researchPrivateDirectory(pin);
      assertResearchDirectory(identity);
      researchCommand("/usr/bin/mount", ["--bind", identity.path, pin]);
      assertResearchDirectory(identity); assertResearchDirectory(identity, pin);
      researchCommand("/usr/bin/mount", ["--make-private", pin]);
    }
    stage = ResearchLaunchStage.InputPreparation;
    researchPromptBytes(jobDirectory, request.promptPath, join(directory, "pins", "job"));
    for (const name of ["state", "home", "tmp"]) {
      const path = join(directory, "pins", "job", name);
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      researchDirectoryIdentity(path);
    }
    stage = ResearchLaunchStage.LaunchPlan;
    const launch = trustedResearchRuntimeLaunch(spec, specSha256);
    stage = ResearchLaunchStage.HostSubmission;
    assertResearchSharedHost();
    researchCommand(launch.command, launch.args);
    // A successful submission is a request, not evidence of provider/turn success.
    stage = ResearchLaunchStage.StartReadback;
    const current = researchCurrentStart(request.jobId);
    if (!current.bytes.equals(specBytes)) researchInvalid();
    return { jobId: request.jobId, unit, startId, specSha256 };
  } catch (error) { throw annotateResearchLaunchStage(error, stage); }
}
