import { constants, closeSync, fstatSync, openSync, readFileSync, lstatSync, mkdirSync, writeFileSync, existsSync, type Stats } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand, researchProcessIdentity } from "./research-launch-host";
import { researchCustody, researchHash, researchPath, researchRecord, researchDirectoryIdentity, assertResearchDirectory } from "./research-launch-files";
import type { LocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { MimoProjectBridgeOperation, parseMimoProjectBridgeRequest, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { workerLaunchAdmissionSchema, workerLaunchOwnsPath } from "./application/project-control/worker-launch-spec";
import { hostedMimoProjectRuntime } from "./hosted-mimo-project-runtime-routing";
import { hostedMimoSealedSourcePort } from "./hosted-mimo-project-source";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
import { readCodexGoalJob } from "./codex-goal-jobs";
import { protectedCodexGoalJobRuntimeProvenance } from "./protected-job-birth";
import type { MimoAdmissionRepairPlan } from "./hosted-mimo-project-bridge-contract";

type AdmissionRepairIdentity = Readonly<{ schemaVersion: 1; machineId: string; projectId: string; workstreamId: string; jobId: string }>;
type PreviousAdmissionDeniedStart = Readonly<{ ownerSha256: string; requestSha256: string; resultSha256: string }>;
type AdmissionRepairHelper = {
  repairHostedMimoJobAdmissionPlan(plan: MimoAdmissionRepairPlan, runtimeDirectory: string, artifactSha256: string): Promise<unknown>;
  finalizeHostedMimoJobAdmissionRepair(identity: AdmissionRepairIdentity, runtimeDirectory: string, artifactSha256: string): Promise<unknown>;
  assertHostedMimoAdmissionRepairStartRearm(identity: AdmissionRepairIdentity, previousStart: PreviousAdmissionDeniedStart): Promise<{ receiptSha256: string }>;
};
async function admissionRepairHelper(): Promise<AdmissionRepairHelper> {
  // Fixed installed composition, never a caller-selected executable or path.
  const helperUrl = new URL("../../host-integration/runtime-admission/mimo-job-admission-repair.mts", import.meta.url);
  const helperBytes = hostedMimoBridgeMetadataBytes(fileURLToPath(helperUrl), 262144);
  const helper = await import(helperUrl.href) as AdmissionRepairHelper;
  if (!hostedMimoBridgeMetadataBytes(fileURLToPath(helperUrl), 262144).equals(helperBytes))
    throw new Error("mimo_project_bridge_runtime_invalid");
  return helper;
}
/** A bounded read of the finalizer's exact evidence, never launch authority. */
export async function assertHostedMimoAdmissionRepairStartRearm(request: MimoProjectBridgeRequest,
  previousStart: PreviousAdmissionDeniedStart): Promise<{ receiptSha256: string }> {
  const helper = await admissionRepairHelper();
  return await helper.assertHostedMimoAdmissionRepairStartRearm({ schemaVersion: 1, machineId: request.machineId,
    projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId }, previousStart);
}

export type HostedMimoProjectBinding = Readonly<{
  schemaVersion: 1; projectId: string; workstreamId: string; machineId: string; routingEnabled: boolean;
  stateRoot: string; scratchRoot: string; registryRootDir: string; controllerJobId: string;
  sourceWorkspacePath: string; sourceCommit: string; sourceRef: string; codexBinaryPath: string;
  taskTimeoutMs: number; appServerStartupTimeoutMs: number; operationTimeoutMs: number; admission: unknown;
}>;
export function parseHostedMimoProjectBinding(value: unknown, request: MimoProjectBridgeRequest): HostedMimoProjectBinding {
  const row = researchRecord(value, "schemaVersion,projectId,workstreamId,machineId,routingEnabled,stateRoot,scratchRoot,registryRootDir,controllerJobId,sourceWorkspacePath,sourceCommit,sourceRef,codexBinaryPath,taskTimeoutMs,appServerStartupTimeoutMs,operationTimeoutMs,admission");
  if (row.schemaVersion !== 1 || row.projectId !== request.projectId || row.workstreamId !== request.workstreamId || row.machineId !== request.machineId ||
      typeof row.routingEnabled !== "boolean" || typeof row.controllerJobId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row.controllerJobId) ||
      typeof row.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(row.sourceCommit)) throw new Error("mimo_project_bridge_binding_invalid");
  if (typeof row.sourceRef !== "string" || !/^origin\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(row.sourceRef) || row.sourceRef.includes(".."))
    throw new Error("mimo_project_bridge_binding_invalid");
  const state = `/srv/worker-state/mimo-projects/${request.projectId}/${request.workstreamId}`;
  const scratch = `/srv/workers/mimo-projects/${request.projectId}/${request.workstreamId}`;
  if (row.stateRoot !== state || row.scratchRoot !== scratch || row.registryRootDir !== join(state, "registry")) throw new Error("mimo_project_bridge_binding_invalid");
  for (const key of ["sourceWorkspacePath", "codexBinaryPath"]) researchPath(row[key]);
  if (!(row.sourceWorkspacePath as string).startsWith(scratch + "/")) throw new Error("mimo_project_bridge_binding_invalid");
  for (const key of ["taskTimeoutMs", "appServerStartupTimeoutMs", "operationTimeoutMs"]) if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 1000 || (row[key] as number) > 86400000)
    throw new Error("mimo_project_bridge_binding_invalid");
  const admission = workerLaunchAdmissionSchema.parse(row.admission);
  const sandbox = admission.contract.executionPolicy.sandboxRoot;
  researchPath(sandbox);
  const sandboxRelative = relative(row.sourceWorkspacePath as string, sandbox);
  if (!sandboxRelative || sandboxRelative.startsWith("..") || isAbsolute(sandboxRelative))
    throw new Error("mimo_project_bridge_admission_invalid");
  return Object.freeze(row) as HostedMimoProjectBinding;
}
/** Largest binding or other trusted metadata file any bridge reader accepts. */
export const hostedMimoBridgeMetadataMaxBytes = 65536;
/** Fixed trusted metadata only. The remote caller never selects an executable,
 * controller, credential, filesystem path or arbitrary MCP operation. */
export function hostedMimoBridgeMetadataBytes(path: string, maximumBytes = hostedMimoBridgeMetadataMaxBytes): Buffer {
  researchCustody(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > maximumBytes)
      throw new Error("mimo_project_bridge_binding_invalid");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs)
      throw new Error("mimo_project_bridge_binding_invalid");
    return bytes;
  } finally { closeSync(fd); }
}
declare const heldPreparationFenceBrand: unique symbol;
export type HeldMimoPreparationFence = Readonly<{ [heldPreparationFenceBrand]: true }>;
const heldPreparationFences = new WeakMap<HeldMimoPreparationFence, { stateRoot: string; assertCurrent(): void }>();
/** Source-only ownership of a fence just acquired by this process. It cannot be
 * serialized as permission or substituted with the public fence shape. */
export function captureHeldMimoPreparationFence(binding: HostedMimoProjectBinding, fence: LocalControllerMaintenanceFence): HeldMimoPreparationFence {
  const path = join(binding.stateRoot, ".controller-maintenance-fence.json"), directory = researchDirectoryIdentity(binding.stateRoot);
  const stat = lstatSync(path), bytes = hostedMimoBridgeMetadataBytes(path), after = lstatSync(path), owner = JSON.parse(bytes.toString());
  const processIdentity = JSON.stringify(researchProcessIdentity());
  if (fence.path !== path || owner.schemaVersion !== 1 || owner.ownerToken !== fence.ownerToken || owner.pid !== process.pid ||
      owner.processStartIdentity !== researchCommand("/usr/bin/ps", ["-p", String(process.pid), "-o", "lstart="]).trim() ||
      stat.dev !== after.dev || stat.ino !== after.ino || stat.ctimeMs !== after.ctimeMs ||
      (stat.mode & 0o077) !== 0) throw new Error("mimo_project_bridge_route_closed");
  const capability = Object.freeze({}) as HeldMimoPreparationFence;
  heldPreparationFences.set(capability, { stateRoot: binding.stateRoot, assertCurrent: () => {
    assertResearchDirectory(directory);
    const current = lstatSync(path);
    if (binding.stateRoot !== directory.path || current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeMs !== stat.ctimeMs ||
        !hostedMimoBridgeMetadataBytes(path).equals(bytes) || JSON.stringify(researchProcessIdentity()) !== processIdentity)
      throw new Error("mimo_project_bridge_route_closed");
  } });
  return capability;
}
/** Source-only recheck that a fence captured by this process is still the one on disk. */
export function assertHeldMimoPreparationFenceCurrent(binding: HostedMimoProjectBinding, heldFence: HeldMimoPreparationFence): void {
  const held = heldPreparationFences.get(heldFence);
  if (!held || held.stateRoot !== binding.stateRoot) throw new Error("mimo_project_bridge_route_closed");
  held.assertCurrent();
}
export function assertHostedMimoProjectRouteOpen(binding: HostedMimoProjectBinding, heldFence?: HeldMimoPreparationFence): void {
  if (heldFence) {
    const held = heldPreparationFences.get(heldFence);
    if (!held || held.stateRoot !== binding.stateRoot) throw new Error("mimo_project_bridge_route_closed");
    held.assertCurrent();
  }
  if (existsSync(join(binding.stateRoot, ".controller-recovery.json")) ||
      (!heldFence && existsSync(join(binding.stateRoot, ".controller-maintenance-fence.json"))) ||
      !binding.routingEnabled || existsSync(`/etc/subscription-runtime/projects/${binding.projectId}.route-disabled`) ||
      existsSync(`/etc/subscription-runtime/projects/${binding.projectId}.d/${binding.workstreamId}.route-disabled`))
    throw new Error("mimo_project_bridge_route_closed");
  const yaml = hostedMimoBridgeMetadataBytes(`/etc/subscription-runtime/projects/${binding.projectId}.d/${binding.workstreamId}.yml`).toString("utf8");
  // Read only the fixed scalar routing contract, not arbitrary YAML features.
  // The reviewed Ansible template emits these scalars as plain/JSON strings.
  for (const [key, expected] of Object.entries({ project_id: binding.projectId, workstream_id: binding.workstreamId,
    state_root: `/srv/worker-state/jobs/${binding.projectId}/${binding.workstreamId}`, scratch_root: `/srv/workers/jobs/${binding.projectId}/${binding.workstreamId}`, routing_enabled: true })) {
    const lines = yaml.split("\n").filter(line => line.startsWith(key + ":"));
    if (lines.length !== 1) throw new Error("mimo_project_bridge_route_closed");
    const raw = lines[0]!.slice(key.length + 1).trim();
    let value: unknown;
    try { value = raw === "true" ? true : raw.startsWith('"') ? JSON.parse(raw) : raw; }
    catch { throw new Error("mimo_project_bridge_route_closed"); }
    if (value !== expected) throw new Error("mimo_project_bridge_route_closed");
  }
}

function childAdmission(binding: HostedMimoProjectBinding, workspace: string, ownedPaths?: readonly string[]) {
  const template = workerLaunchAdmissionSchema.parse(binding.admission);
  if (ownedPaths && !ownedPaths.every(path => workerLaunchOwnsPath(template.contract, path)))
    throw new Error("mimo_project_bridge_ownership_expansion_denied");
  const sandboxRelative = relative(binding.sourceWorkspacePath, template.contract.executionPolicy.sandboxRoot);
  return workerLaunchAdmissionSchema.parse({ ...template, contract: { ...template.contract, ...(ownedPaths ? { ownedPaths: [...ownedPaths] } : {}),
    executionPolicy: { ...template.contract.executionPolicy, sandboxRoot: join(workspace, sandboxRelative) } } });
}
function unwrap(value: { content: readonly { type: string; text?: string }[] }): unknown {
  const text = value.content.find(row => row.type === "text")?.text;
  if (!text) throw new Error("mimo_project_bridge_response_invalid");
  return JSON.parse(text);
}
export async function handleHostedMimoProjectBridge(value: unknown): Promise<unknown> {
  const request = parseMimoProjectBridgeRequest(value);
  assertResearchInitialRoot(true); assertResearchSharedHost();
  if (readFileSync("/etc/machine-id", "utf8").trim() !== request.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  const bytes = hostedMimoBridgeMetadataBytes(`/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`), binding = parseHostedMimoProjectBinding(JSON.parse(bytes.toString("utf8")), request);
  const { projectControlRefillWorkerFromSealedSource, projectControlStartStoredJob, projectControlStopStoredJob,
    loadProjectControlController, loadJobLaunch, collectRegisteredCodexGoalJobStatus } = await hostedMimoProjectRuntime(binding, request);
  const args: ProjectControlMcpArgs = { registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId, jobId: request.jobId };
  const controller = await loadProjectControlController(args);
  if (controller.scope.projectId !== request.projectId ||
      ((request.operation === MimoProjectBridgeOperation.Create || request.operation === MimoProjectBridgeOperation.Start) &&
        !controller.scope.allowedAccountIds?.includes("account-q"))) throw new Error("mimo_project_bridge_scope_denied");
  const jobRoot = join(binding.stateRoot, "jobs", request.jobId), workspace = join(binding.scratchRoot, "workspaces", request.jobId);
  const records = join(binding.stateRoot, "mimo-bridge-attempts"), recordPath = join(records, request.jobId + ".json");
  if (request.operation === MimoProjectBridgeOperation.Create) {
    assertHostedMimoProjectRouteOpen(binding);
    if (request.sourceCommit !== binding.sourceCommit) throw new Error("mimo_project_bridge_source_mismatch");
    const admission = childAdmission(binding, workspace, request.ownedPaths);
    researchCustody(binding.stateRoot);
    if (!existsSync(records)) mkdirSync(records, { mode: 0o700 });
    researchCustody(records);
    // Retain one request before any creation effect. Uncertain results cannot
    // be replayed as a new workspace or provider attempt under this job ID.
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, requestSha256: researchHash(JSON.stringify(request)),
      projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId, jobRoot, workspace }) + "\n", { flag: "wx", mode: 0o600 });
    return unwrap(await projectControlRefillWorkerFromSealedSource({ ...args, jobRootDir: jobRoot, workspacePath: workspace,
      sourceWorkspacePath: binding.sourceWorkspacePath, sourceRef: binding.sourceRef, expectedSourceCommit: binding.sourceCommit,
      newBranch: `feat/${request.jobId}`, promptBody: request.prompt!, preStartAdmission: admission,
      confirmPreStartAdmission: true, confirmRefill: true, startWorker: false, overwrite: false, dependencyBootstrap: "off", executionMode: "sync",
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, accounts: ["account-q"], model: "mimo-v2.6-pro", executionEngine: "app-server",
      maxAccountCycles: 1, prewarmOnStart: false, codexBinaryPath: binding.codexBinaryPath, serviceTier: "default", reasoningEffort: request.reasoningEffort ?? "medium",
      taskTimeoutMs: binding.taskTimeoutMs, appServerStartupTimeoutMs: binding.appServerStartupTimeoutMs }, hostedMimoSealedSourcePort(binding)));
  }
  let retained: Stats | undefined;
  try { researchCustody(records); retained = lstatSync(recordPath); }
  catch (error) {
    // Directly registered jobs predate bridge Create records. Status still uses
    // their selected runtime, stored launch and native publication authority.
    if (request.operation !== MimoProjectBridgeOperation.Status || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (retained) {
    if (!retained.isFile() || retained.isSymbolicLink() || retained.uid !== 0 || retained.nlink !== 1 || (retained.mode & 0o077) !== 0 || retained.size > 4096)
      throw new Error("mimo_project_bridge_attempt_invalid");
    const record = researchRecord(JSON.parse(readFileSync(recordPath, "utf8")), "schemaVersion,requestSha256,projectId,workstreamId,jobId,jobRoot,workspace");
    if (record.schemaVersion !== 1 || record.projectId !== request.projectId || record.workstreamId !== request.workstreamId || record.jobId !== request.jobId ||
        record.jobRoot !== jobRoot || record.workspace !== workspace) throw new Error("mimo_project_bridge_attempt_invalid");
  }
  if (request.operation === MimoProjectBridgeOperation.RepairAdmission || request.operation === MimoProjectBridgeOperation.FinalizeAdmissionRepair) {
    if (request.operation === MimoProjectBridgeOperation.RepairAdmission && researchHash(bytes) !== request.repairPlan!.expectedBindingSha256)
      throw new Error("mimo_project_bridge_binding_invalid");
    const job = await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: request.jobId });
    if (job.jobId !== request.jobId || job.jobRootDir !== jobRoot || job.workspacePath !== workspace)
      throw new Error("mimo_project_bridge_attempt_invalid");
    const controllerOrigin = protectedCodexGoalJobRuntimeProvenance(controller.controller, binding.registryRootDir);
    const jobOrigin = protectedCodexGoalJobRuntimeProvenance(job, binding.registryRootDir);
    if (!controllerOrigin || !jobOrigin || controllerOrigin.runtimeDirectory !== jobOrigin.runtimeDirectory ||
        controllerOrigin.artifactSha256 !== jobOrigin.artifactSha256) throw new Error("mimo_project_bridge_repair_origin_invalid");
    const helper = await admissionRepairHelper();
    controllerOrigin.assertCurrent(); jobOrigin.assertCurrent();
    if (request.operation === MimoProjectBridgeOperation.FinalizeAdmissionRepair)
      return await helper.finalizeHostedMimoJobAdmissionRepair({ schemaVersion: 1, machineId: request.machineId,
        projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId }, jobOrigin.runtimeDirectory, jobOrigin.artifactSha256);
    return await helper.repairHostedMimoJobAdmissionPlan(request.repairPlan!, jobOrigin.runtimeDirectory, jobOrigin.artifactSha256);
  }
  const loaded = await loadJobLaunch(args);
  const c = loaded.launch.config;
  if (c.jobRootDir !== jobRoot || c.workspacePath !== workspace || c.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan ||
      c.accounts.length !== 1 || c.accounts[0]?.name !== "account-q" || c.projectAccessScope?.projectId !== request.projectId)
    throw new Error("mimo_project_bridge_attempt_invalid");
  if (request.operation === MimoProjectBridgeOperation.Start) {
    assertHostedMimoProjectRouteOpen(binding);
    return unwrap(await projectControlStartStoredJob({ ...args, confirmStart: true }));
  }
  if (request.operation === MimoProjectBridgeOperation.Stop) return unwrap(await projectControlStopStoredJob({ ...args, confirmStop: true }));
  return { ok: true, projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId,
    status: await collectRegisteredCodexGoalJobStatus({ registryRootDir: binding.registryRootDir, launch: loaded.launch }) };
}
