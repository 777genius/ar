import { dirname, join, relative } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { loadJobLaunch, loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { readAuthorizedProjectPreStartLaunchReceipt, readCurrentAuthorizedProjectPreStartLaunchReceipt } from "./application/project-control/codex-goal-project-pre-start-launch-authorization";
import { AccessBoundary, createAccessPolicyService } from "@vioxen/subscription-runtime/worker-core";
import { parseResearchOperatorRequest, researchHashRequest, type ResearchOperatorRequest, type ResearchRegisteredHandoff } from "./research-launch-contract";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchCustody, researchHash, researchId, researchInvalid, researchPath, researchRead, researchRecord } from "./research-launch-files";
import { assertResearchDurableDirectory, researchDurableDirectory, sameResearchDurableBacking } from "./research-durable-handoff-directory";
import type { ResearchStartSpec } from "./research-launch-contract";
import { codexGoalJobManifestPath } from "./codex-goal-jobs";
import { withCurrentControllerScopeActivity } from "./application/project-control/codex-goal-current-controller-activity";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "./codex-goal-project-workspace-lock";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { installedResearchRuntimeDirectory } from "./research-launch-admission";
import { hostedCodexExecutableReadPath } from "../provider-codex/hosted-codex-permissions";

/** Root adapters must already hold the registered action's activity/workspace
 * locks and have authorized its receipt through the policy/semantic broker.
 * The token cannot be deserialized or minted from an independently supplied sink. */
export type RegisteredResearchHandoffAuthorization = Readonly<{ request: ResearchOperatorRequest }>;
const authorizations = new WeakMap<RegisteredResearchHandoffAuthorization, ResearchRegisteredHandoff>();
const digest = (value: unknown): string => researchHash(JSON.stringify(value));
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export class RegisteredResearchHandoffUnsupportedSink extends Error {
  constructor() { super("hosted_research_registered_sink_unsupported"); }
}
export class RegisteredResearchSinkPreparationUnresolved extends Error {
  readonly preparationRetained = true;
  constructor() { super("hosted_research_registered_sink_preparation_unresolved"); }
}

async function registeredHandoffInputs(registryRootDir: string, controllerJobId: string, request: ResearchOperatorRequest, preStart = false) {
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
  // The action has selected/reserved the account. A sink token cannot select a
  // foreign account outside the effective registered launch's candidate set.
  if (request.accounts.length !== 1 || !launch.config.accounts.some(account => account.name === request.accounts[0])) researchInvalid();
  const sink = researchPath(launch.config.durableHandoffRootDir);
  if (sink !== join(registryRootDir, "durable-handoffs")) throw new RegisteredResearchHandoffUnsupportedSink();
  const codexPackage = hostedCodexExecutableReadPath({ codexBinaryPath: request.codexBinaryPath,
    sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } });
  for (const path of [request.jobRootDir, request.workspacePath, request.authRootDir, installedResearchRuntimeDirectory(),
    ...(codexPackage ? [codexPackage] : []), "/run/user", "/etc", "/usr", "/var/lib", controller.controller.jobRootDir]) {
    if (overlaps(sink, path)) researchInvalid();
  }
  researchCustody(manifest.projectPreStartAdmission.receiptPath, true);
  const { receipt, receiptSha256 } = preStart
    ? await readAuthorizedProjectPreStartLaunchReceipt({ manifest, scope: controller.scope })
    : await readCurrentAuthorizedProjectPreStartLaunchReceipt(manifest);
  // The clean-workspace proof becomes historical after start, but these
  // immutable launch inputs and the exact authorized receipt remain live.
  for (const [path, key] of [[manifest.promptPath, "promptSha256"],
    [manifest.projectPreStartAdmission.contractPath, "contractSha256"],
    [manifest.projectPreStartAdmission.statePath, "stateSha256"]] as const) {
    if (researchHash(researchRead(path)) !== receipt[key]) researchInvalid();
  }
  const boundRequest = parseResearchOperatorRequest({ ...request, durableHandoffRootDir: sink });
  const binding = Object.freeze({ registryRootDir, controllerJobId,
    manifestSha256: digest(manifest), scopeSha256: digest(controller.scope), receiptSha256,
    requestSha256: researchHashRequest(boundRequest) });
  // Awaited receipt/loader work can overlap a revocation. Re-read supported
  // metadata and finish with a nofollow, private exact-byte custody witness.
  const freshManifest = await loadJobLaunch({ registryRootDir, jobId: request.jobId });
  const freshController = await loadProjectControlController({ registryRootDir, controllerJobId });
  if (digest(freshManifest.manifest) !== binding.manifestSha256 || digest(freshController.scope) !== binding.scopeSha256) researchInvalid();
  const assertAuthorityBytes = (): void => {
    if (researchHash(researchRead(manifest.projectPreStartAdmission!.receiptPath)) !== receiptSha256 ||
        !researchRead(controllerPath).equals(controllerBytes) || !researchRead(manifestPath).equals(manifestBytes)) researchInvalid();
    for (const [path, key] of [[manifest.promptPath, "promptSha256"],
      [manifest.projectPreStartAdmission!.contractPath, "contractSha256"],
      [manifest.projectPreStartAdmission!.statePath, "stateSha256"]] as const) {
      if (researchHash(researchRead(path)) !== receipt[key]) researchInvalid();
    }
  };
  assertAuthorityBytes();
  researchCustody(codexGoalJobManifestPath({ registryRootDir, jobId: controllerJobId }), true);
  researchCustody(codexGoalJobManifestPath({ registryRootDir, jobId: request.jobId }), true);
  const readDirectory = (path: string): string => lstatSync("/proc/1/root" + path).isDirectory() ? path : dirname(path);
  return { binding, request: boundRequest, assertAuthorityBytes, protectedSources: [request.jobRootDir, request.workspacePath, request.authRootDir,
    installedResearchRuntimeDirectory(), ...(codexPackage ? [readDirectory(codexPackage)] : []), readDirectory(process.execPath),
    controller.controller.jobRootDir, "/usr", "/etc"] };
}
async function currentRegisteredHandoff(registryRootDir: string, controllerJobId: string, request: ResearchOperatorRequest, preStart = false) {
  const current = await registeredHandoffInputs(registryRootDir, controllerJobId, request, preStart);
  const sink = current.request.durableHandoffRootDir!;
  const parentBacking = researchDurableDirectory(registryRootDir);
  let existing: ReturnType<typeof researchDurableDirectory> | undefined;
  try { existing = researchDurableDirectory(sink); }
  catch (error) { if (!preStart || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sinkMount = existing ?? parentBacking;
  const sinkBacking = join(sinkMount.mountRoot, relative(sinkMount.mountPoint, sink));
  for (const source of current.protectedSources) {
    const witness = researchDurableDirectory(source, false);
    if (sinkMount.mountDevice === witness.mountDevice && sinkMount.filesystemUuid === witness.filesystemUuid &&
        overlaps(sinkBacking, join(witness.mountRoot, relative(witness.mountPoint, source)))) researchInvalid();
  }
  if (existing) assertResearchDurableDirectory(existing);
  const readback = () => {
    const binding = Object.freeze({ ...current.binding, durableDirectory: researchDurableDirectory(sink) });
    current.assertAuthorityBytes();
    return { request: current.request, binding, assertAuthorityBytes: current.assertAuthorityBytes };
  };
  try { researchCustody(sink, true); }
  catch (error) {
    if (!preStart || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Only the fixed leaf under this currently authorized registry can be
    // prepared. Never chmod an existing directory or create ancestor paths.
    const parent = researchDurableDirectory(registryRootDir);
    const before = await registeredHandoffInputs(registryRootDir, controllerJobId, request);
    if (digest(before.binding) !== digest(current.binding)) researchInvalid();
    assertResearchDurableDirectory(parent);
    before.assertAuthorityBytes();
    try { mkdirSync(sink, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      assertResearchDurableDirectory(parent);
      researchCustody(sink, true);
      const after = await registeredHandoffInputs(registryRootDir, controllerJobId, request);
      if (digest(after.binding) !== digest(current.binding)) researchInvalid();
      assertResearchDurableDirectory(parent);
      after.assertAuthorityBytes();
      // The final cold sink witness and byte authority read are post-effect
      // observations too. EEXIST is conservatively treated as retained prep.
      return readback();
    } catch { throw new RegisteredResearchSinkPreparationUnresolved(); }
  }
  return readback();
}
export async function authorizeRegisteredResearchHandoff(input: {
  readonly registryRootDir: string; readonly controllerJobId: string;
  readonly request: ResearchOperatorRequest;
}): Promise<RegisteredResearchHandoffAuthorization> {
  assertResearchInitialRoot(true);
  const request = parseResearchOperatorRequest(input.request);
  // An operator cannot replace the stored sink, including with the same-looking
  // path. It is always derived by the loader after current receipt validation.
  if (request.durableHandoffRootDir !== undefined) researchInvalid();
  const registryRootDir = researchPath(input.registryRootDir), controllerJobId = researchId(input.controllerJobId);
  const registry = researchDurableDirectory(registryRootDir);
  return await withCodexGoalRegistryMutation({ registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
    assertResearchDurableDirectory(registry);
    const current = await currentRegisteredHandoff(registryRootDir, controllerJobId, request, true);
    const authorization = Object.freeze({ request: current.request });
    authorizations.set(authorization, current.binding);
    return authorization;
  } });
}
export async function consumeRegisteredResearchHandoffAuthorization(
  authorization: RegisteredResearchHandoffAuthorization,
): Promise<ResearchRegisteredHandoff> {
  assertResearchInitialRoot(true);
  const binding = authorizations.get(authorization);
  if (!binding) researchInvalid();
  authorizations.delete(authorization);
  await assertRegisteredResearchHandoffCurrent(binding, authorization.request);
  return binding;
}
export async function assertRegisteredResearchHandoffCurrent(binding: ResearchRegisteredHandoff, request: ResearchOperatorRequest): Promise<void> {
  assertResearchInitialRoot();
  const current = await currentRegisteredHandoff(binding.registryRootDir, binding.controllerJobId, request);
  if (digest(current.binding) !== digest(binding)) researchInvalid();
  assertResearchDurableDirectory(binding.durableDirectory);
  current.assertAuthorityBytes();
}
/** Publication holds the supported workspace, registry mutation and controller
 * activity fences for the complete async capture/readback. Per-effect guards
 * remain necessary for native grant/receipt revocation and mount replacement. */
export async function withRegisteredResearchHandoffPublication<T>(binding: ResearchRegisteredHandoff,
  request: ResearchOperatorRequest, effect: () => Promise<T>): Promise<T> {
  assertResearchInitialRoot();
  const controller = await loadProjectControlController({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId });
  if (digest(controller.scope) !== binding.scopeSha256) researchInvalid();
  return await withCurrentControllerScopeActivity({ controllerJobRootDir: controller.controller.jobRootDir,
    owner: `research-handoff:${request.jobId}`, expectedScope: controller.scope,
    loadCurrentScope: async () => (await loadProjectControlController({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId })).scope,
    effect: async () => await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(binding.registryRootDir),
      scope: controller.scope, requestedWorkspacePath: request.workspacePath, expectedCanonicalWorkspacePath: request.workspacePath,
      owner: `research-handoff:${request.jobId}`, effect: async () => await withCodexGoalRegistryMutation({
        registryRootDir: binding.registryRootDir, requireExistingRegistryRoot: true, effect: async () => {
          await assertRegisteredResearchHandoffCurrent(binding, request);
          return await effect();
        },
      }),
    }),
  });
}
/** Pin record is published only after the owner verified the actual Host bind.
 * Cold witnesses detect mount loss/replacement even under a runtime target bind. */
export function assertRegisteredResearchHandoffPin(spec: ResearchStartSpec, directory: string): void {
  const binding = spec.registeredHandoff;
  if (!binding) {
    if (spec.request.durableHandoffRootDir !== undefined) researchInvalid();
    return;
  }
  assertResearchDurableDirectory(binding.durableDirectory);
  const r = researchRecord(JSON.parse(researchRead(join(directory, "durable-pin.json")).toString("utf8")), "schemaVersion,specSha256,pin");
  if (r.schemaVersion !== 1 || r.specSha256 !== researchHash(researchRead(join(directory, "spec.json")))) researchInvalid();
  const pin = researchDurableDirectory(join(directory, "pins", "durable-handoff"));
  if (digest(pin) !== digest(r.pin) || !sameResearchDurableBacking(binding.durableDirectory, pin)) researchInvalid();
}
