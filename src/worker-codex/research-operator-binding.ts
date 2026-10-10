import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { fileURLToPath } from "node:url";
import { type ResearchOperatorRequest } from "../core/research-operator-request";
import { parseResearchGrant, parseResearchOperatorRequest, type ResearchOperatorRequest as OwnedResearchRequest } from "./research-launch-contract";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand, researchExecutableDigest } from "./research-launch-host";
import { researchArtifactDigest, researchAuthorityRoot, researchDirectoryIdentity, researchHash, researchJson, researchName, researchPromptBytes, researchPublish, researchRead, researchRecord } from "./research-launch-files";
import { withResearchJobMutation } from "./research-job-mutation-lock";
export type ResearchOperatorBinding = Readonly<{
  schemaVersion: 1; jobId: string; projectId: string; machineId: string; bootId: string;
  runtimeDirectory: string; artifactSha256: string; node: string; nodeSha256: string;
  codexSha256: string; requestPath: string; requestSha256: string; promptSha256: string; grantSha256: string;
  sourceCommit: string; sourceTree: string; expiresAtMs: number;
}>;
export const researchOperatorDirectory = (jobId: string) => join(researchAuthorityRoot, researchName(jobId));
const bindingPath = (jobId: string) => join(researchOperatorDirectory(jobId), "operator-ingress.json");
const machine = () => readFileSync("/etc/machine-id", "utf8").trim();
const boot = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
export const researchOperatorRuntime = () => realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
function source(request: OwnedResearchRequest, commit: string, tree: string) {
  researchDirectoryIdentity(request.workspacePath);
  const actual = researchCommand("/usr/bin/git", ["-C", request.workspacePath, "rev-parse", "HEAD", "HEAD^{tree}"]).trim().split("\n");
  if (actual.length !== 2 || actual[0] !== commit || actual[1] !== tree) throw new Error("research_operator_source_mismatch");
}
/** Initial-root enrollment only. Requires a separately issued genuine grant;
 * restricted ingress cannot enroll itself or choose its filesystem/model inputs. */
export function enrollResearchOperatorRequest(requestPath: string, expectedSha256: string, sourceCommit: string, sourceTree: string, expiresAtMs: number) {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  if (![expectedSha256].every(v => /^[a-f0-9]{64}$/.test(v)) || ![sourceCommit, sourceTree].every(v => /^[a-f0-9]{40}$/.test(v)) ||
      !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + 3600000) throw new Error("research_operator_enrollment_invalid");
  const bytes = researchRead(requestPath);
  if (researchHash(bytes) !== expectedSha256) throw new Error("research_operator_request_mismatch");
  const request = parseResearchOperatorRequest(researchJson(bytes));
  if (request.durableHandoffRootDir !== undefined || request.modelBackend !== undefined || !request.projectId) throw new Error("research_operator_standalone_required");
  return withResearchJobMutation(request.jobId, () => {
    const directory = researchOperatorDirectory(request.jobId);
    if (existsSync(join(directory, "active.json")) || existsSync(bindingPath(request.jobId))) throw new Error("research_operator_already_enrolled");
    const grantBytes = researchRead(join(directory, "grant.json")), grant = parseResearchGrant(researchJson(grantBytes));
    if (grant.profileId !== CodexProviderEgressProfileId.FullInternetV1 || grant.registeredHandoff || grant.projectLaunchBinding || grant.jobId !== request.jobId || grant.jobRootDir !== request.jobRootDir || grant.workspacePath !== request.workspacePath)
      throw new Error("research_operator_grant_mismatch");
    source(request, sourceCommit, sourceTree);
    if (researchCommand("/usr/bin/git", ["-C", request.workspacePath, "status", "--porcelain=v1", "--untracked-files=all"]).trim()) throw new Error("research_operator_workspace_dirty");
    const binding: ResearchOperatorBinding = { schemaVersion: 1, jobId: request.jobId, projectId: request.projectId!, machineId: machine(), bootId: boot(),
      runtimeDirectory: researchOperatorRuntime(), artifactSha256: researchArtifactDigest(researchOperatorRuntime()), node: realpathSync(process.execPath), nodeSha256: researchExecutableDigest(process.execPath),
      codexSha256: researchExecutableDigest(request.codexBinaryPath), requestPath, requestSha256: expectedSha256, promptSha256: researchHash(researchPromptBytes(grant.jobDirectory, request.promptPath)), grantSha256: researchHash(grantBytes), sourceCommit, sourceTree, expiresAtMs };
    researchPublish(bindingPath(request.jobId), binding, true);
    return { jobId: request.jobId, bindingSha256: researchHash(researchRead(bindingPath(request.jobId))) };
  });
}
export function readResearchOperatorBinding(envelope: ResearchOperatorRequest, starting = false) {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const bytes = researchRead(bindingPath(envelope.jobId));
  if (researchHash(bytes) !== envelope.bindingSha256) throw new Error("research_operator_binding_mismatch");
  const binding = researchRecord(researchJson(bytes), "schemaVersion,jobId,projectId,machineId,bootId,runtimeDirectory,artifactSha256,node,nodeSha256,codexSha256,requestPath,requestSha256,promptSha256,grantSha256,sourceCommit,sourceTree,expiresAtMs") as ResearchOperatorBinding;
  if (binding.schemaVersion !== 1 || binding.jobId !== envelope.jobId || binding.projectId !== envelope.projectId || binding.machineId !== envelope.machineId ||
      binding.machineId !== machine() || binding.bootId !== boot() || binding.runtimeDirectory !== researchOperatorRuntime() || binding.node !== realpathSync(process.execPath) ||
      researchExecutableDigest(process.execPath) !== binding.nodeSha256 || researchArtifactDigest(binding.runtimeDirectory) !== binding.artifactSha256) throw new Error("research_operator_identity_mismatch");
  const requestBytes = researchRead(binding.requestPath);
  if (researchHash(requestBytes) !== binding.requestSha256) throw new Error("research_operator_request_mismatch");
  const request = parseResearchOperatorRequest(researchJson(requestBytes));
  if (request.jobId !== binding.jobId || request.projectId !== binding.projectId) throw new Error("research_operator_binding_mismatch");
  if (starting) {
    if (!Number.isSafeInteger(binding.expiresAtMs) || Date.now() >= binding.expiresAtMs) throw new Error("research_operator_binding_expired");
    if (researchHash(researchRead(join(researchOperatorDirectory(request.jobId), "grant.json"))) !== binding.grantSha256 ||
        researchHash(researchPromptBytes(researchDirectoryIdentity(request.jobRootDir), request.promptPath)) !== binding.promptSha256) throw new Error("research_operator_grant_mismatch");
    if (researchExecutableDigest(request.codexBinaryPath) !== binding.codexSha256) throw new Error("research_operator_identity_mismatch");
    source(request, binding.sourceCommit, binding.sourceTree);
    if (researchCommand("/usr/bin/git", ["-C", request.workspacePath, "status", "--porcelain=v1", "--untracked-files=all"]).trim()) throw new Error("research_operator_workspace_dirty");
  }
  return { binding, request };
}
