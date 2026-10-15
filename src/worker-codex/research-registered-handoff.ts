import { dirname, join, relative } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { loadJobLaunch, loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { parseResearchOperatorRequest, type ResearchOperatorRequest, type ResearchRegisteredHandoff, type ResearchRegisteredExecution } from "./research-launch-contract";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchCustody, researchHash, researchId, researchInvalid, researchPath, researchRead, researchRecord, researchRegisteredPromptBytes } from "./research-launch-files";
import { assertResearchDurableDirectory, researchDurableDirectory, researchDurableDirectories, sameResearchDurableBacking } from "./research-durable-handoff-directory";
import type { ResearchStartSpec } from "./research-launch-contract";
import { withCurrentControllerScopeActivity } from "./application/project-control/codex-goal-current-controller-activity";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "./codex-goal-project-workspace-lock";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { installedResearchRuntimeDirectory } from "./research-launch-admission";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { assertCodexProjectReservedLaunchAuthority, assertCodexProjectReservedAccountReceiptCurrent,
  consumeCodexProjectReservedLaunchAuthority } from "./application/project-control/codex-goal-project-account-reservation";
import { assertFreshRegisteredResearchProfile, assertRegisteredResearchExecutionSupported, researchRegisteredExecutionFromReservation } from "./research-registered-execution";
import { researchProjectLaunchInputs } from "./research-project-launch-inputs";
import { hostedCodexExecutableReadClosure } from "../provider-codex/hosted-codex-permissions";
import { parseCodexGoalProjectAccessScope } from "./codex-goal-access-plan";
import { AccessBoundary, createAccessPolicyService, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";

/** Root adapters must already hold the registered action's activity/workspace
 * locks and have authorized its receipt through the policy/semantic broker.
 * The token cannot be deserialized or minted from an independently supplied sink. */
export type RegisteredResearchHandoffAuthorization = Readonly<{ request: ResearchOperatorRequest; registryRootDir: string }>;
const authorizations = new WeakMap<RegisteredResearchHandoffAuthorization, {
  binding: ResearchRegisteredHandoff; manifest: Awaited<ReturnType<typeof loadJobLaunch>>["manifest"]; reservedLaunch: CodexGoalLaunchInput;
}>();
const digest = (value: unknown): string => researchHash(JSON.stringify(value));
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
export class RegisteredResearchHandoffUnsupportedSink extends Error {
  constructor() { super("hosted_research_registered_sink_unsupported"); }
}
export class RegisteredResearchSinkPreparationUnresolved extends Error {
  readonly preparationRetained = true;
  constructor() { super("hosted_research_registered_sink_preparation_unresolved"); }
}

async function registeredHandoffInputs(registryRootDir: string, controllerJobId: string, request: ResearchOperatorRequest, preStart = false, execution?: ResearchRegisteredExecution) {
  const codexClosure = hostedCodexExecutableReadClosure({ codexBinaryPath: request.codexBinaryPath,
    sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } });
  const current = await researchProjectLaunchInputs({ registryRootDir, controllerJobId, request, preStart,
    ...(execution ? { execution } : {}), readPromptBytes: path => researchRegisteredPromptBytes(request.jobRootDir, path),
    bindSupportedRequest: ({ manifest, launch }, controller) => {
      const sink = researchPath(launch.config.durableHandoffRootDir);
      if (sink !== join(registryRootDir, "durable-handoffs")) throw new RegisteredResearchHandoffUnsupportedSink();
      for (const path of [request.jobRootDir, request.workspacePath, request.authRootDir, installedResearchRuntimeDirectory(),
        ...(codexClosure?.paths ?? []), "/run/user", "/etc", "/usr", "/var/lib", controller.controller.jobRootDir]) {
        if (overlaps(sink, path)) researchInvalid();
      }
      assertRegisteredResearchExecutionSupported({ registryRootDir, manifest, controller: controller.controller, launch, request, execution });
      return parseResearchOperatorRequest({ ...request, durableHandoffRootDir: sink });
    },
  });
  const readDirectory = (path: string): string => lstatSync("/proc/1/root" + path).isDirectory() ? path : dirname(path);
  return { ...current, protectedSources: [request.jobRootDir, request.workspacePath, request.authRootDir,
    installedResearchRuntimeDirectory(), ...(codexClosure?.paths.map(readDirectory) ?? []), readDirectory(process.execPath),
    current.controller.controller.jobRootDir, "/usr", "/etc"] };
}
async function currentRegisteredHandoff(registryRootDir: string, controllerJobId: string, request: ResearchOperatorRequest, preStart = false,
  execution?: ResearchRegisteredExecution, beforeSinkEffects?: (assertAuthorityBytes: () => void) => Promise<void>) {
  const current = await registeredHandoffInputs(registryRootDir, controllerJobId, request, preStart, execution);
  // The supported reservation is historical and single-use. Consume only after
  // current receipt/unsupported-field validation and before any sink effects.
  await beforeSinkEffects?.(current.assertAuthorityBytes);
  current.assertAuthorityBytes();
  const sink = current.request.durableHandoffRootDir!;
  const parentBacking = researchDurableDirectory(registryRootDir);
  let existing: ReturnType<typeof researchDurableDirectory> | undefined;
  try { existing = researchDurableDirectory(sink); }
  catch (error) { if (!preStart || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sinkMount = existing ?? parentBacking;
  const sinkBacking = join(sinkMount.mountRoot, relative(sinkMount.mountPoint, sink));
  const sources = [...new Set(current.protectedSources)];
  const sourceWitnesses = researchDurableDirectories(sources.map(path => ({ path, privateLeaf: false })));
  for (const [index, source] of sources.entries()) {
    const witness = sourceWitnesses[index]!;
    if (sinkMount.mountDevice === witness.mountDevice && sinkMount.filesystemUuid === witness.filesystemUuid &&
        overlaps(sinkBacking, join(witness.mountRoot, relative(witness.mountPoint, source)))) researchInvalid();
  }
  if (existing) assertResearchDurableDirectory(existing);
  const readback = () => {
    const binding = Object.freeze({ ...current.binding, durableDirectory: researchDurableDirectory(sink) });
    current.assertAuthorityBytes();
    return { request: current.request, binding, controller: current.controller, assertAuthorityBytes: current.assertAuthorityBytes };
  };
  try { researchCustody(sink, true); }
  catch (error) {
    if (!preStart || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Only the fixed leaf under this currently authorized registry can be
    // prepared. Never chmod an existing directory or create ancestor paths.
    const parent = researchDurableDirectory(registryRootDir);
    const before = await registeredHandoffInputs(registryRootDir, controllerJobId, request, false, execution);
    if (digest(before.binding) !== digest(current.binding)) researchInvalid();
    assertResearchDurableDirectory(parent);
    before.assertAuthorityBytes();
    try { mkdirSync(sink, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      assertResearchDurableDirectory(parent);
      researchCustody(sink, true);
      const after = await registeredHandoffInputs(registryRootDir, controllerJobId, request, false, execution);
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
  readonly request: ResearchOperatorRequest; readonly reservedLaunch: CodexGoalLaunchInput;
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
    const loaded = await loadJobLaunch({ registryRootDir, jobId: request.jobId });
    const reserved = { manifest: loaded.manifest, sourceLaunch: loaded.launch, reservedLaunch: input.reservedLaunch };
    const authority = assertCodexProjectReservedLaunchAuthority(reserved);
    assertFreshRegisteredResearchProfile(request);
    const execution = researchRegisteredExecutionFromReservation(authority, input.reservedLaunch);
    const current = await currentRegisteredHandoff(registryRootDir, controllerJobId, request, true, execution,
      async assertAuthorityBytes => {
        await assertCodexProjectReservedAccountReceiptCurrent({ manifest: loaded.manifest, reservedLaunch: input.reservedLaunch });
        assertAuthorityBytes();
        consumeCodexProjectReservedLaunchAuthority(reserved);
      });
    const authorization = Object.freeze({ request: current.request, registryRootDir });
    authorizations.set(authorization, { binding: current.binding, manifest: loaded.manifest, reservedLaunch: input.reservedLaunch });
    return authorization;
  } });
}
export async function consumeRegisteredResearchHandoffAuthorization(
  authorization: RegisteredResearchHandoffAuthorization,
  publish?: (binding: ResearchRegisteredHandoff, assertAuthorityBytes: () => void) => void,
): Promise<ResearchRegisteredHandoff> {
  assertResearchInitialRoot(true);
  const retained = authorizations.get(authorization);
  if (!retained) researchInvalid();
  authorizations.delete(authorization);
  const assertAuthorityBytes = await assertRegisteredResearchHandoffCurrent(retained.binding, authorization.request);
  await assertCodexProjectReservedAccountReceiptCurrent({ manifest: retained.manifest, reservedLaunch: retained.reservedLaunch });
  assertAuthorityBytes();
  publish?.(retained.binding, assertAuthorityBytes);
  return retained.binding;
}
/** Fresh async observation ends in a synchronous current-byte guard for the
 * owner's next individual effect. The closure never caches admission. */
export async function assertRegisteredResearchHandoffCurrent(binding: ResearchRegisteredHandoff, request: ResearchOperatorRequest,
  assertRoot: () => void = assertResearchInitialRoot): Promise<() => void> {
  assertRoot();
  const current = await currentRegisteredHandoff(binding.registryRootDir, binding.controllerJobId, request, false, binding.registeredExecution);
  if (digest(current.binding) !== digest(binding)) researchInvalid();
  assertResearchDurableDirectory(binding.durableDirectory);
  current.assertAuthorityBytes();
  return () => { assertRoot(); assertResearchDurableDirectory(binding.durableDirectory); current.assertAuthorityBytes(); };
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
/** Historical scope authenticates only immutable terminal inputs. Permission for
 * preservation still comes from the current controller, under its own fences. */
export async function prepareRegisteredResearchTerminalAuthority(binding: ResearchRegisteredHandoff,
  request: ResearchOperatorRequest, historicalScope: unknown) {
  assertResearchInitialRoot(true);
  const historical = parseCodexGoalProjectAccessScope(historicalScope);
  const current = await currentRegisteredHandoff(binding.registryRootDir, binding.controllerJobId, request, false, binding.registeredExecution);
  assertResearchTerminalAccountTail(historical, current.controller.scope, binding.scopeSha256);
  if (digest({ ...current.binding, scopeSha256: binding.scopeSha256 }) !== digest(binding)) researchInvalid();
  const scope = current.controller.scope, policy = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope });
  if (!policy.canReadPath({ path: request.workspacePath }).allowed ||
      !policy.canWritePath({ path: request.workspacePath }).allowed ||
      !policy.canReadPath({ path: binding.durableDirectory.path }).allowed) researchInvalid();
  // Canonical result/progress are typed broker effects through the exact admitted
  // job pin. They do not grant raw writes to registry/job roots outside workspace.
  const assertCurrent = (): void => {
    assertResearchInitialRoot(true); assertResearchDurableDirectory(binding.durableDirectory); current.assertAuthorityBytes();
  };
  assertCurrent();
  return { scope, assertCurrent,
    withPublication: async <T>(effect: () => Promise<T>): Promise<T> => await withCurrentControllerScopeActivity({
      controllerJobRootDir: current.controller.controller.jobRootDir, owner: `research-terminal:${request.jobId}`, expectedScope: scope,
      loadCurrentScope: async () => (await loadProjectControlController({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId })).scope,
      effect: async () => await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(binding.registryRootDir), scope,
        requestedWorkspacePath: request.workspacePath, expectedCanonicalWorkspacePath: request.workspacePath,
        owner: `research-terminal:${request.jobId}`, effect: async () => await withCodexGoalRegistryMutation({
          registryRootDir: binding.registryRootDir, requireExistingRegistryRoot: true,
          effect: async () => { assertCurrent(); const result = await effect(); assertCurrent(); return result; },
        }),
      }),
    }),
  };
}
/** The one supported drift is an appended account tail, never a general scope
 * subset. Hash the existing normalized parser output without a new projection. */
export function assertResearchTerminalAccountTail(historical: ProjectAccessScope | undefined,
  current: ProjectAccessScope, expectedSha256: string): asserts historical is ProjectAccessScope {
  if (!historical || digest(historical) !== expectedSha256 || !historical.allowedAccountIds?.length ||
      !current.allowedAccountIds || historical.allowedAccountIds.length >= current.allowedAccountIds.length ||
      historical.allowedAccountIds.some((id, index) => id !== current.allowedAccountIds![index]) ||
      digest({ ...current, allowedAccountIds: historical.allowedAccountIds }) !== digest(historical)) researchInvalid();
}
/** Pin record is published only after the owner verified the actual Host bind.
 * Cold witnesses detect mount loss/replacement even under a runtime target bind. */
export function assertRegisteredResearchHandoffPin(spec: ResearchStartSpec, directory: string): void {
  const binding = spec.registeredHandoff;
  if (!binding) {
    if (spec.request.durableHandoffRootDir !== undefined) researchInvalid();
    return;
  }
  const [source, pin] = researchDurableDirectories([{ path: binding.durableDirectory.path }, { path: join(directory, "pins", "durable-handoff") }]);
  if (digest(source) !== digest(binding.durableDirectory)) researchInvalid();
  const r = researchRecord(JSON.parse(researchRead(join(directory, "durable-pin.json")).toString("utf8")), "schemaVersion,specSha256,pin");
  if (r.schemaVersion !== 1 || r.specSha256 !== researchHash(researchRead(join(directory, "spec.json")))) researchInvalid();

  if (digest(pin) !== digest(r.pin) || !sameResearchDurableBacking(binding.durableDirectory, pin!)) researchInvalid();
}
