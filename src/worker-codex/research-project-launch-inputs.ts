import { loadJobLaunch, loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { readAuthorizedProjectPreStartLaunchReceipt, readCurrentAuthorizedProjectPreStartLaunchReceipt } from "./application/project-control/codex-goal-project-pre-start-launch-authorization";
import { AccessBoundary, createAccessPolicyService } from "@vioxen/subscription-runtime/worker-core";
import { researchHashRequest, type ResearchOperatorRequest, type ResearchProjectLaunchBinding, type ResearchRegisteredExecution } from "./research-launch-contract";
import { researchCustody, researchHash, researchInvalid, researchRead } from "./research-launch-files";
import { codexGoalJobManifestPath } from "./codex-goal-jobs";

const digest = (value: unknown): string => researchHash(JSON.stringify(value));
type Loaded = Awaited<ReturnType<typeof loadJobLaunch>>;
type Controller = Awaited<ReturnType<typeof loadProjectControlController>>;
/** Shared current-byte reader, not a launch capability. Only an owner-specific
 * compatibility gate and the original reservation can mint an authorization. */
export async function researchProjectLaunchInputs(input: {
  readonly registryRootDir: string; readonly controllerJobId: string;
  readonly request: ResearchOperatorRequest; readonly preStart?: boolean;
  readonly execution?: ResearchRegisteredExecution;
  readonly bindSupportedRequest: (loaded: Loaded, controller: Controller) => ResearchOperatorRequest;
}): Promise<{ readonly binding: ResearchProjectLaunchBinding; readonly request: ResearchOperatorRequest;
  readonly controller: Controller; readonly assertAuthorityBytes: () => void }> {
  const { registryRootDir, controllerJobId, request, execution } = input;
  const controllerPath = codexGoalJobManifestPath({ registryRootDir, jobId: controllerJobId });
  const manifestPath = codexGoalJobManifestPath({ registryRootDir, jobId: request.jobId });
  const controllerBytes = researchRead(controllerPath), manifestBytes = researchRead(manifestPath);
  const controller = await loadProjectControlController({ registryRootDir, controllerJobId });
  const loaded = await loadJobLaunch({ registryRootDir, jobId: request.jobId });
  const { manifest, launch } = loaded;
  researchCustody(registryRootDir);
  if (controller.registryRootDir !== registryRootDir || loaded.registryRootDir !== registryRootDir ||
      !manifest.projectPreStartAdmission || manifest.jobId !== request.jobId) researchInvalid();
  const policy = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope: controller.scope });
  if (!policy.canStartWorker({ jobId: request.jobId, registryRoot: registryRootDir, workspacePath: request.workspacePath }).allowed ||
      request.accounts.some(accountId => !policy.canUseAccount({ accountId }).allowed)) researchInvalid();
  for (const key of ["jobId", "taskId", "jobRootDir", "workspacePath", "promptPath", "authRootDir", "codexBinaryPath",
    "model", "reasoningEffort", "serviceTier", "taskTimeoutMs"] as const) {
    if (request[key] !== launch.config[key]) researchInvalid();
  }
  if (request.accounts.length !== 1 || !launch.config.accounts.some(account => account.name === request.accounts[0])) researchInvalid();
  // A native adapter may validate a fixed projection; an OpenAI adapter derives
  // its stored sink here. Neither may silently discard execution semantics.
  const boundRequest = input.bindSupportedRequest(loaded, controller);
  researchCustody(manifest.projectPreStartAdmission.receiptPath, true);
  const { receipt, receiptSha256 } = input.preStart
    ? await readAuthorizedProjectPreStartLaunchReceipt({ manifest, scope: controller.scope })
    : await readCurrentAuthorizedProjectPreStartLaunchReceipt(manifest);
  const immutableInputs = [[manifest.promptPath, "promptSha256"],
    [manifest.projectPreStartAdmission.contractPath, "contractSha256"],
    [manifest.projectPreStartAdmission.statePath, "stateSha256"]] as const;
  for (const [path, key] of immutableInputs) if (researchHash(researchRead(path)) !== receipt[key]) researchInvalid();
  const binding = Object.freeze({ registryRootDir, controllerJobId, manifestSha256: digest(manifest),
    scopeSha256: digest(controller.scope), receiptSha256, requestSha256: researchHashRequest(boundRequest),
    ...(execution ? { registeredExecution: execution } : {}) });
  const freshManifest = await loadJobLaunch({ registryRootDir, jobId: request.jobId });
  const freshController = await loadProjectControlController({ registryRootDir, controllerJobId });
  if (digest(freshManifest.manifest) !== binding.manifestSha256 || digest(freshController.scope) !== binding.scopeSha256) researchInvalid();
  // Finish awaited observation with synchronous nofollow exact-byte custody.
  const assertAuthorityBytes = (): void => {
    if (researchHash(researchRead(manifest.projectPreStartAdmission!.receiptPath)) !== receiptSha256 ||
        !researchRead(controllerPath).equals(controllerBytes) || !researchRead(manifestPath).equals(manifestBytes)) researchInvalid();
    for (const [path, key] of immutableInputs) if (researchHash(researchRead(path)) !== receipt[key]) researchInvalid();
  };
  assertAuthorityBytes();
  researchCustody(controllerPath, true); researchCustody(manifestPath, true);
  return { binding, request: boundRequest, controller, assertAuthorityBytes };
}
