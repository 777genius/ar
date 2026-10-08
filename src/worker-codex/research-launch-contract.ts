import { CodexModelBackend, CodexProviderEgressProfileId, type CodexReasoningEffort, type CodexServiceTier } from "@vioxen/subscription-runtime/provider-codex";
import { AccessBoundary, NetworkAccessMode } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { join } from "node:path";
import { researchHash, researchId, researchInvalid, researchPath, researchRecord, type ResearchDirectoryIdentity } from "./research-launch-files";
import type { ResearchProcessIdentity, ResearchServiceIdentity } from "./research-launch-host";
import { parseResearchDurableDirectory, type ResearchDurableDirectory } from "./research-durable-handoff-directory";
import { hostedResearchSetupTimeoutMs } from "../provider-codex/app-server/adapters/hosted-app-server-launch-frame";

// Host-owned finite bound: systemd namespace setup timed out at 179.984s before
// provider exec; allow five minutes for OS setup and readiness/ownership handoff.
export const researchProviderSetupTimeoutMs = hostedResearchSetupTimeoutMs;

export type ResearchOperatorRequest = Readonly<{
  schemaVersion: 1; jobId: string; taskId: string; jobRootDir: string; workspacePath: string;
  promptPath: string; authRootDir: string; accounts: readonly string[]; codexBinaryPath: string;
  model: string; reasoningEffort: CodexReasoningEffort; serviceTier: CodexServiceTier; taskTimeoutMs: number;
  durableHandoffRootDir?: string;
}>;
export const researchHashRequest = (request: ResearchOperatorRequest): string => researchHash(JSON.stringify(request));
export function parseResearchOperatorRequest(value: unknown): ResearchOperatorRequest {
  const optional = value !== null && typeof value === "object" && Object.hasOwn(value, "durableHandoffRootDir");
  const r = researchRecord(value, "schemaVersion,jobId,taskId,jobRootDir,workspacePath,promptPath,authRootDir,accounts,codexBinaryPath,model,reasoningEffort,serviceTier,taskTimeoutMs" + (optional ? ",durableHandoffRootDir" : ""));
  if (r.schemaVersion !== 1 || typeof r.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(r.model) ||
      !["none", "minimal", "low", "medium", "high", "xhigh"].includes(r.reasoningEffort as string) ||
      !["default", "fast", "flex", "priority"].includes(r.serviceTier as string) ||
      !Number.isSafeInteger(r.taskTimeoutMs) || (r.taskTimeoutMs as number) < 1000 || (r.taskTimeoutMs as number) > 86400000 ||
      !Array.isArray(r.accounts) || !r.accounts.length || r.accounts.length > 16 || new Set(r.accounts).size !== r.accounts.length) researchInvalid();
  const jobRootDir = researchPath(r.jobRootDir), workspacePath = researchPath(r.workspacePath), promptPath = researchPath(r.promptPath);
  const authRootDir = researchPath(r.authRootDir);
  const durableHandoffRootDir = optional ? researchPath(r.durableHandoffRootDir) : undefined;
  if (jobRootDir === workspacePath || jobRootDir.startsWith(workspacePath + "/") ||
      workspacePath.startsWith(join(jobRootDir, "state") + "/") || workspacePath === join(jobRootDir, "state") ||
      workspacePath.startsWith(join(jobRootDir, "home") + "/") || workspacePath === join(jobRootDir, "home") ||
      !promptPath.startsWith(jobRootDir + "/") || promptPath.startsWith(workspacePath + "/") ||
      [jobRootDir, workspacePath].some(path => authRootDir === path || authRootDir.startsWith(path + "/") || path.startsWith(authRootDir + "/"))) researchInvalid();
  return Object.freeze({ schemaVersion: 1, jobId: researchId(r.jobId), taskId: researchId(r.taskId), jobRootDir, workspacePath,
    promptPath, authRootDir, ...(durableHandoffRootDir === undefined ? {} : { durableHandoffRootDir }),
    accounts: Object.freeze(r.accounts.map(researchId)), codexBinaryPath: researchPath(r.codexBinaryPath),
    model: r.model, reasoningEffort: r.reasoningEffort as CodexReasoningEffort, serviceTier: r.serviceTier as CodexServiceTier, taskTimeoutMs: r.taskTimeoutMs as number });
}
export type ResearchGrant = Readonly<{
  schemaVersion: 1; profileId: CodexProviderEgressProfileId.PublicResearchV1 | CodexProviderEgressProfileId.FullInternetV1;
  jobId: string; jobRootDir: string; workspacePath: string; grantId: string;
  jobDirectory: ResearchDirectoryIdentity; workspaceDirectory: ResearchDirectoryIdentity;
  registeredHandoff?: ResearchRegisteredHandoff;
}>;
export type ResearchRegisteredHandoff = Readonly<{
  registryRootDir: string; controllerJobId: string; manifestSha256: string;
  scopeSha256: string; receiptSha256: string; requestSha256: string;
  durableDirectory: ResearchDurableDirectory;
}>;
export function parseResearchRegisteredHandoff(value: unknown): ResearchRegisteredHandoff {
  const r = researchRecord(value, "registryRootDir,controllerJobId,manifestSha256,scopeSha256,receiptSha256,requestSha256,durableDirectory");
  const registryRootDir = researchPath(r.registryRootDir), controllerJobId = researchId(r.controllerJobId);
  for (const key of ["manifestSha256", "scopeSha256", "receiptSha256", "requestSha256"]) {
    if (typeof r[key] !== "string" || !/^[a-f0-9]{64}$/.test(r[key] as string)) researchInvalid();
  }
  return Object.freeze({ ...r, registryRootDir, controllerJobId,
    durableDirectory: parseResearchDurableDirectory(r.durableDirectory, join(registryRootDir, "durable-handoffs")) }) as ResearchRegisteredHandoff;
}
export function parseResearchGrant(value: unknown): ResearchGrant {
  const optional = value !== null && typeof value === "object" && Object.hasOwn(value, "registeredHandoff");
  const r = researchRecord(value, "schemaVersion,profileId,jobId,jobRootDir,workspacePath,grantId,jobDirectory,workspaceDirectory" + (optional ? ",registeredHandoff" : ""));
  if (r.schemaVersion !== 1 || (r.profileId !== CodexProviderEgressProfileId.PublicResearchV1 && r.profileId !== CodexProviderEgressProfileId.FullInternetV1) ||
      typeof r.grantId !== "string" || !/^[a-f0-9-]{36}$/.test(r.grantId)) researchInvalid();
  const jobRootDir = researchPath(r.jobRootDir), workspacePath = researchPath(r.workspacePath);
  return Object.freeze({ schemaVersion: 1, profileId: r.profileId,
    jobId: researchId(r.jobId), jobRootDir, workspacePath, grantId: r.grantId,
    ...(optional ? { registeredHandoff: parseResearchRegisteredHandoff(r.registeredHandoff) } : {}),
    jobDirectory: parseResearchDirectory(r.jobDirectory, jobRootDir), workspaceDirectory: parseResearchDirectory(r.workspaceDirectory, workspacePath) });
}
export type ResearchStartSpec = Readonly<{
  schemaVersion: 1; startId: string; runtimeDirectory: string; artifactSha256: string; grantSha256: string;
  request: ResearchOperatorRequest; requestSha256: string; nodeSha256: string; codexSha256: string;
  unit: string; jobDirectory: ResearchDirectoryIdentity; workspaceDirectory: ResearchDirectoryIdentity;
  registeredHandoff?: ResearchRegisteredHandoff;
}>;
export type ResearchStartBinding = Readonly<{
  schemaVersion: 1; specSha256: string; process: ResearchProcessIdentity; service: ResearchServiceIdentity;
}>;
// These records are written/read only by the trusted installed owner. Exact bytes
// are retained and compared; the request parser prevents environment/payload bags.
export function parseResearchStartSpec(value: unknown): ResearchStartSpec {
  const optional = value !== null && typeof value === "object" && Object.hasOwn(value, "registeredHandoff");
  const r = researchRecord(value, "schemaVersion,startId,runtimeDirectory,artifactSha256,grantSha256,request,requestSha256,nodeSha256,codexSha256,unit,jobDirectory,workspaceDirectory" + (optional ? ",registeredHandoff" : ""));
  if (r.schemaVersion !== 1 || typeof r.startId !== "string" || !/^[a-f0-9-]{36}$/.test(r.startId) ||
      r.unit !== `subscription-runtime-research-${r.startId}.service`) researchInvalid();
  for (const key of ["artifactSha256", "grantSha256", "requestSha256", "nodeSha256", "codexSha256"]) {
    if (typeof r[key] !== "string" || !/^[a-f0-9]{64}$/.test(r[key] as string)) researchInvalid();
  }
  const request = parseResearchOperatorRequest(r.request);
  const registeredHandoff = optional ? parseResearchRegisteredHandoff(r.registeredHandoff) : undefined;
  if ((request.durableHandoffRootDir !== undefined) !== optional ||
      (registeredHandoff && (request.durableHandoffRootDir !== registeredHandoff.durableDirectory.path ||
        researchHashRequest(request) !== registeredHandoff.requestSha256))) researchInvalid();
  for (const [key, path] of [["jobDirectory", request.jobRootDir], ["workspaceDirectory", request.workspacePath]] as const) {
    parseResearchDirectory(r[key], path);
  }
  return Object.freeze({ ...r, request, ...(registeredHandoff ? { registeredHandoff } : {}), runtimeDirectory: researchPath(r.runtimeDirectory) }) as ResearchStartSpec;
}
function parseResearchDirectory(value: unknown, path: string): ResearchDirectoryIdentity {
  const dir = researchRecord(value, "path,device,inode");
  if (dir.path !== path || !Number.isSafeInteger(dir.device) || (dir.device as number) < 0 ||
      !Number.isSafeInteger(dir.inode) || (dir.inode as number) < 1) researchInvalid();
  return Object.freeze({ path, device: dir.device as number, inode: dir.inode as number });
}
export function researchRunConfig(request: ResearchOperatorRequest): CodexGoalRunConfig {
  // Match the CLI's fixed temp contract; scratch remains logically jobRoot/tmp.
  const runtimeTempRoot = join(request.jobRootDir, "tmp"), agentTempRoot = join(runtimeTempRoot, "agent");
  return { ...request, accounts: request.accounts.map(name => ({ name })),
    executionEngine: "app-server-goal", modelBackend: CodexModelBackend.OpenAiChatGpt,
    stateRootDir: join(request.jobRootDir, "state"), runtimeHomeRootDir: join(request.jobRootDir, "home"),
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, networkAccess: NetworkAccessMode.Unrestricted,
    // Derive only the admitted workspace; job state, homes and Host authority
    // stay outside the project scope. Agent temp uses the fixed temp contract.
    projectAccessScope: { projectId: request.jobId, isolatedWorkspaceRoot: request.workspacePath, authRoot: request.authRootDir },
    prewarmOnStart: true, appServerStartupTimeoutMs: researchProviderSetupTimeoutMs + 30_000,
    sourceEnv: { PATH: "/usr/bin:/bin", HOME: join(request.jobRootDir, "home"),
      SUBSCRIPTION_RUNTIME_JOB_ROOT: request.jobRootDir, SUBSCRIPTION_RUNTIME_TMPDIR: runtimeTempRoot,
      TMPDIR: agentTempRoot, TMP: agentTempRoot, TEMP: agentTempRoot,
      SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } };
}
