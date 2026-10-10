import { join } from "node:path";
import { CodexModelBackend, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { defaultStartupTimeoutMs } from "../provider-codex/app-server/domain/app-server-types";
import { CodexGoalNativeLifecycle, type CodexGoalLaunchInput } from "./codex-goal-ops";
import { parseResearchOperatorRequest } from "./research-launch-contract";
import { authorizeRegisteredResearchHandoff, assertRegisteredResearchHandoffCurrent } from "./research-registered-handoff";
import { grantRegisteredResearchLaunch, startRegisteredResearchLaunch } from "./research-launch-owner";
import { researchCurrentStart, researchJobAuthority } from "./research-launch-admission";
import { cancelRegisteredResearchLaunch, finalizeOwnedMimoWorker, terminalResearchStart, statusResearchLaunch } from "./research-launch-lifecycle";
import { researchHash, researchJson, researchPublish, researchRead, researchRecord } from "./research-launch-files";

export function isProjectMimoWorkerLaunch(launch: CodexGoalLaunchInput): boolean {
  return launch.config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan;
}

/** The registered authorizer independently reloads scope, manifest and receipt
 * and consumes the original account reservation. No model-supplied host data. */
export async function launchProjectMimoWorker(input: {
  readonly registryRootDir: string; readonly controllerJobId: string;
  readonly reservedLaunch: CodexGoalLaunchInput;
}): Promise<{ jobId: string; unit: string; startId: string; specSha256: string }> {
  const c = input.reservedLaunch.config;
  if (!isProjectMimoWorkerLaunch(input.reservedLaunch)) throw new Error("project_mimo_worker_backend_required");
  const request = parseResearchOperatorRequest({ schemaVersion: 1,
    jobId: c.jobId ?? c.taskId, taskId: c.taskId, jobRootDir: c.jobRootDir,
    workspacePath: c.workspacePath, promptPath: c.promptPath, authRootDir: c.authRootDir,
    accounts: c.accounts.map(account => account.name), codexBinaryPath: c.codexBinaryPath,
    modelBackend: c.modelBackend, model: c.model ?? codexMimoDefaultModel,
    reasoningEffort: c.reasoningEffort ?? "medium", serviceTier: c.serviceTier ?? "default",
    taskTimeoutMs: c.taskTimeoutMs, projectId: c.projectAccessScope?.projectId,
    maxAccountCycles: c.maxAccountCycles, prewarmOnStart: c.prewarmOnStart ?? false,
    appServerStartupTimeoutMs: c.appServerStartupTimeoutMs ?? defaultStartupTimeoutMs });
  const directory = researchJobAuthority(request.jobId);
  const requestPath = join(directory, "project-worker-request.json");
  try { researchRead(requestPath); throw new Error("project_mimo_worker_prior_submission_retained"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const authorization = await authorizeRegisteredResearchHandoff({ ...input, request });
  await grantRegisteredResearchLaunch(authorization);
  // Exclusive publication prevents retries from replacing uncertain intent.
  researchPublish(requestPath, authorization.request, true);
  const requestSha256 = researchHash(researchRead(requestPath));
  let started: Awaited<ReturnType<typeof startRegisteredResearchLaunch>>;
  try { started = await startRegisteredResearchLaunch(requestPath, requestSha256); }
  catch (error) {
    // A transport failure is uncertain. Recover only the existing owner attempt;
    // never retry submission or replace the retained request.
    try {
      const current = researchCurrentStart(request.jobId);
      if (current.spec.registeredHandoff?.controllerJobId !== input.controllerJobId) throw error;
      const recovered = await recoverProjectMimoWorkerAttempt({ registryRootDir: input.registryRootDir, launch: input.reservedLaunch }, current);
      if (recovered.startId !== current.spec.startId || recovered.specSha256 !== researchHash(current.bytes) ||
          recovered.requestSha256 !== requestSha256 || recovered.controllerJobId !== input.controllerJobId ||
          recovered.registryRootDir !== input.registryRootDir || recovered.jobId !== request.jobId) throw error;
      // A positively retained accepted attempt must not roll back its project
      // launch receipt merely because the transport response was lost.
      return { jobId: request.jobId, unit: current.spec.unit, startId: current.spec.startId, specSha256: researchHash(current.bytes) };
    } catch { /* Retain the original error and immutable intent for later status. */ }
    throw error;
  }
  researchPublish(join(directory, "project-worker-attempt.json"), { schemaVersion: 1,
    registryRootDir: input.registryRootDir, controllerJobId: input.controllerJobId,
    jobId: started.jobId, startId: started.startId, specSha256: started.specSha256,
    requestSha256 }, true);
  return started;
}

/** One explicit status observation reconciles an already staged candidate.
 * No polling, detached owner, replacement launch or completion inferred from exit. */
async function currentProjectMimoWorker(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput;
  readonly publicationAdmission?: boolean;
}): Promise<ReturnType<typeof researchCurrentStart> | undefined> {
  if (!isProjectMimoWorkerLaunch(input.launch) || process.platform !== "linux" || process.getuid?.() !== 0) return;
  const c = input.launch.config, jobId = c.jobId ?? c.taskId;
  let current: ReturnType<typeof researchCurrentStart>;
  try { current = researchCurrentStart(jobId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { current = terminalResearchStart(jobId); }
    catch (terminalError) { if ((terminalError as NodeJS.ErrnoException).code === "ENOENT") return; throw terminalError; }
  }
  const receipt = await recoverProjectMimoWorkerAttempt(input, current);
  const { spec } = current;
  if (receipt.schemaVersion !== 1 || receipt.registryRootDir !== input.registryRootDir || receipt.jobId !== jobId ||
      !spec.registeredHandoff || spec.registeredHandoff.registryRootDir !== input.registryRootDir ||
      spec.registeredHandoff.controllerJobId !== receipt.controllerJobId || spec.startId !== receipt.startId ||
      researchHash(current.bytes) !== receipt.specSha256 || spec.requestSha256 !== receipt.requestSha256 ||
      spec.request.jobRootDir !== c.jobRootDir || spec.request.workspacePath !== c.workspacePath ||
      spec.request.taskId !== c.taskId || spec.request.projectId !== c.projectAccessScope?.projectId) {
    throw new Error("project_mimo_worker_attempt_mismatch");
  }
  if (input.publicationAdmission !== false) await assertRegisteredResearchHandoffCurrent(spec.registeredHandoff, spec.request);
  return current;
}

async function recoverProjectMimoWorkerAttempt(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput; readonly publicationAdmission?: boolean;
}, captured?: ReturnType<typeof researchCurrentStart>): Promise<Record<string, unknown>> {
  const c = input.launch.config, jobId = c.jobId ?? c.taskId;
  const path = join(researchJobAuthority(jobId), "project-worker-attempt.json");
  try { return researchRecord(researchJson(researchRead(path)),
    "schemaVersion,registryRootDir,controllerJobId,jobId,startId,specSha256,requestSha256"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const current = captured ?? researchCurrentStart(jobId), { spec } = current;
  const requestBytes = researchRead(join(researchJobAuthority(jobId), "project-worker-request.json"));
  if (!spec.registeredHandoff || spec.registeredHandoff.registryRootDir !== input.registryRootDir ||
      spec.request.jobId !== jobId || spec.request.jobRootDir !== c.jobRootDir || spec.request.workspacePath !== c.workspacePath ||
      spec.request.taskId !== c.taskId || spec.request.projectId !== c.projectAccessScope?.projectId ||
      spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan ||
      researchHash(requestBytes) !== spec.requestSha256) throw new Error("project_mimo_worker_attempt_mismatch");
  if (input.publicationAdmission !== false) await assertRegisteredResearchHandoffCurrent(spec.registeredHandoff, spec.request);
  const receipt = { schemaVersion: 1, registryRootDir: input.registryRootDir,
    controllerJobId: spec.registeredHandoff.controllerJobId, jobId, startId: spec.startId,
    specSha256: researchHash(current.bytes), requestSha256: spec.requestSha256 };
  try { researchPublish(path, receipt, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return researchRecord(researchJson(researchRead(path)),
    "schemaVersion,registryRootDir,controllerJobId,jobId,startId,specSha256,requestSha256");
}

export async function reconcileProjectMimoWorker(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput;
}): Promise<void> {
  const current = await currentProjectMimoWorker(input);
  if (!current) return;
  try { researchRead(join(current.directory, "mimo-candidate.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await finalizeOwnedMimoWorker(current.spec.request.jobId, current.spec.startId, researchHash(current.bytes));
}

/** Called without the generic workspace lease: native cancellation/publication
 * acquire their own validated controller, workspace and registry fences. */
export async function stopProjectMimoWorker(input: {
  readonly registryRootDir: string; readonly controllerJobId: string; readonly launch: CodexGoalLaunchInput;
}): Promise<{ readonly handoffPacketPath?: string; readonly handoffManifestSha256?: string; readonly cleanWorkspace?: string }> {
  const current = await currentProjectMimoWorker({ ...input, publicationAdmission: false });
  if (!current || current.spec.registeredHandoff?.controllerJobId !== input.controllerJobId) {
    throw new Error("project_mimo_worker_attempt_required");
  }
  const { spec } = current;
  let published = false;
  try { researchRead(join(current.directory, "mimo-publication.json")); published = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!published) try {
    const cancelled = await cancelRegisteredResearchLaunch({ jobId: spec.request.jobId, startId: spec.startId,
      specSha256: researchHash(current.bytes), requestSha256: spec.requestSha256 });
    if (cancelled.cleanWorkspace === true) return { cleanWorkspace: "true" };
    if (!cancelled.handoffPacketPath || !cancelled.handoffManifestSha256) throw new Error("project_control_stop_handoff_evidence_missing");
    return { handoffPacketPath: cancelled.handoffPacketPath, handoffManifestSha256: cancelled.handoffManifestSha256 };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "hosted_mimo_worker_finalization_pending") throw error;
  }
  await finalizeOwnedMimoWorker(spec.request.jobId, spec.startId, researchHash(current.bytes));
  const publication = researchJson(researchRead(join(current.directory, "mimo-publication.json"))) as
    { result?: { details?: { handoffPacketPath?: unknown; handoffManifestSha256?: unknown } } };
  const details = publication.result?.details;
  if (publication.result && Array.isArray((publication.result as { changedFiles?: unknown }).changedFiles) &&
      ((publication.result as { changedFiles: unknown[] }).changedFiles).length === 0 && details?.handoffPacketPath === undefined) return { cleanWorkspace: "true" };
  if (typeof details?.handoffPacketPath !== "string" || typeof details.handoffManifestSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(details.handoffManifestSha256)) throw new Error("project_control_stop_handoff_evidence_missing");
  return { handoffPacketPath: details.handoffPacketPath, handoffManifestSha256: details.handoffManifestSha256 };
}

/** Observe only the independently validated retained native attempt. Submission
 * receipts and missing tmux sessions are never proof of its lifecycle. */
export async function observeProjectMimoWorker(input: {
  readonly registryRootDir: string; readonly launch: CodexGoalLaunchInput;
}): Promise<CodexGoalNativeLifecycle | undefined> {
  if (!isProjectMimoWorkerLaunch(input.launch)) return;
  if (process.platform !== "linux" || process.getuid?.() !== 0) return CodexGoalNativeLifecycle.Uncertain;
  try {
    const current = await currentProjectMimoWorker(input);
    if (!current) {
      const directory = researchJobAuthority(input.launch.config.jobId ?? input.launch.config.taskId);
      for (const name of ["project-worker-request.json", "project-worker-attempt.json"]) {
        try { researchRead(join(directory, name)); return CodexGoalNativeLifecycle.Uncertain; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return CodexGoalNativeLifecycle.Uncertain; }
      }
      return;
    }
    const observed = statusResearchLaunch(current.spec.request.jobId);
    if (observed.startId !== current.spec.startId || observed.unit !== current.spec.unit || observed.jobId !== current.spec.request.jobId)
      return CodexGoalNativeLifecycle.Uncertain;
    return observed.active || observed.providers.some(provider => provider.active)
      ? CodexGoalNativeLifecycle.Active : CodexGoalNativeLifecycle.Terminal;
  } catch { return CodexGoalNativeLifecycle.Uncertain; }
}
