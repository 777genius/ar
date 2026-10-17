import { observedProcessCgroup } from "./hosted-readonly-observations";
import { dirname, join } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HostedInstallation, HostedOrdinaryStart, ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import { HostedCustodyReservationState, parseHostedOrdinaryStart, parseHostedOrdinaryOrigins, workerPoolSlotId } from "@vioxen/subscription-runtime/worker-core";
import { CodexModelBackend, CodexProviderEgressProfileId, withHostedActivationFence, readHostedActivationBytes,
  decodeHostedActivationBytes, type HostedActivationFence, codexWorkerCacheRoot, codexWorkerCacheSlotKey } from "@vioxen/subscription-runtime/provider-codex";
import { currentHostedOrdinaryWriterExtent, assertHostedOrdinaryPublicationPaths, assertHostedOrdinaryWriterPaths, HostedOrdinaryWriterProfile, ordinaryExtentHash, observeOrdinaryWriterPath,
  parseHostedOrdinaryWriterExtent, readHostedOrdinaryWriterExtent } from "../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import type { CodexGoalRunConfig } from "./codex-goal-runner";
import { codexGoalJobManifestPath, codexGoalJobToArgs, parseStoredCodexGoalJobManifest, type CodexGoalJobManifest } from "./codex-goal-jobs";
import { goalLaunchInputFromRecord } from "./application/codex-goal-launch-input";
import { buildCodexGoalForegroundArgv, HostedGoalLifecycleOperation } from "./application/codex-goal-foreground-command";
import { codexSafeExecutorId } from "./codex-account-identity";
import { codexSessionHomeCacheKey } from "./codex-session-home-profile";
import { parseHostedTestEgressGrant, assertHostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { parseFlags, requiredOption, option, resolvePath, flag } from "./codex-goal-cli-support";
import { runConfigFromFlags } from "./codex-goal-cli-run-config";
import { mapManagedGoalLayout, type ManagedGoalAdmission } from "./managed-goal-admission";
import { resolveHostScratchLifetimeSources } from "./host-scratch-temp";
import { researchCustody } from "./research-launch-files";
import { createReadonlyPrivateRecord, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedOrdinaryRuntime, readHostedOrdinaryObservationOrigin } from "./hosted-installation-activation";
import { withCodexGoalRegistryMutation } from "./codex-goal-job-manifest-revision";
import { projectControlWorkspaceLockRoot } from "./codex-goal-project-workspace-lock";
import type { TerminalHandoffPublicationAuthority } from "./codex-goal-terminal-handoff-materialization";

function invalid(): never { throw new Error("hosted_ordinary_writer_extent_invalid"); }
const encoded = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
type Launch = Readonly<{ command: string; args: readonly string[]; cwd: string }>;
function launchInputs(launch: Launch, env: Readonly<Record<string, string | undefined>>): (ManagedGoalAdmission & { lifecycle?: { manifestSha256: string; executionSha256: string } }) | undefined {
  const cli = join(fileURLToPath(new URL("../../", import.meta.url)), "dist/worker-codex/codex-goal-cli.js");
  const args = launch.command === cli ? launch.args : launch.command === process.execPath && launch.args[0] === cli ? launch.args.slice(1) : undefined;
  if (!args || !["run", "continue"].includes(args[0] ?? "") || args.includes("--child-lifetime-json")) return undefined;
  const flags = parseFlags(args.slice(1));
  const lifecycle = option(flags, {}, "--hosted-lifecycle", []);
  if (flag(flags, "--tmux") || (lifecycle === undefined && option(flags, env, "--tmux-session", []) !== undefined)) return undefined;
  // Legacy inventoried commands may intentionally omit the run configuration.
  // Only a complete modern launch can publish a seal; leave older owners alone.
  const requiredInputs: readonly (readonly [string, readonly string[]])[] = [
    ["--job-root", ["SUBSCRIPTION_RUNTIME_JOB_ROOT"]],
    ["--task-id", ["SUBSCRIPTION_RUNTIME_TASK_ID", "MEMO_STACK_GOAL_TASK_ID"]],
    ["--accounts", ["CODEX_ACCOUNTS"]],
    ["--workspace", ["SUBSCRIPTION_RUNTIME_WORKSPACE_PATH", "MEMO_STACK_GOAL_WORKSPACE_PATH"]],
    ["--prompt", ["SUBSCRIPTION_RUNTIME_PROMPT_PATH", "MEMO_STACK_GOAL_PROMPT_PATH"]],
  ];
  if (requiredInputs.some(([name, envNames]) => !option(flags, env, name, envNames))) return undefined;
  const config = runConfigFromFlags(flags, env, launch.cwd,
    requiredOption(flags, env, "--job-root", ["SUBSCRIPTION_RUNTIME_JOB_ROOT"]),
    requiredOption(flags, env, "--task-id", ["SUBSCRIPTION_RUNTIME_TASK_ID", "MEMO_STACK_GOAL_TASK_ID"]));
  if (config.storage || config.childLifetime) return undefined;
  const registryRootDir = option(flags, env, "--registry-root", [
    "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "CODEX_GOAL_REGISTRY_ROOT"]);
  const logPath = option(flags, env, "--log", []);
  const mapped = mapManagedGoalLayout({ config, ...(logPath ? { logPath: resolvePath(launch.cwd, logPath) } : {}),
    ...(registryRootDir ? { registryRootDir: resolvePath(launch.cwd, registryRootDir) } : {}) });
  const inputs = { ...mapped, logPath: mapped.logPath ?? join(mapped.config.jobRootDir, `${mapped.config.taskId}.log`) };
  if (lifecycle !== undefined) {
    if (!Object.values(HostedGoalLifecycleOperation).includes(lifecycle as HostedGoalLifecycleOperation) || !inputs.registryRootDir ||
        requiredOption(flags, {}, "--lifecycle-job-id", []) !== (config.jobId ?? config.taskId)) invalid();
    // The stored loader's pure normalization is the authority input, rather
    // than trusting the outer argv's copy of a stored execution configuration.
    const manifestBytes = readLifecycleManifest(codexGoalJobManifestPath({
      registryRootDir: inputs.registryRootDir, jobId: config.jobId ?? config.taskId }));
    const manifest = parseStoredCodexGoalJobManifest(decodeHostedActivationBytes(manifestBytes));
    const stored = storedLifecycleLaunch(manifest, inputs.registryRootDir, launch.cwd);
    const normalized = mapManagedGoalLayout({ config: { ...stored.config, sourceEnv: env },
      logPath: stored.logPath, registryRootDir: inputs.registryRootDir });
    if (manifest.jobId !== (config.jobId ?? config.taskId) || configHash(normalized.config) !== configHash(inputs.config) ||
        normalized.logPath !== inputs.logPath || option(flags, {}, "--tmux-session", []) !== stored.tmuxSession ||
        executionHash(normalized.config) !== executionHash(inputs.config)) invalid();
    return { ...inputs, lifecycle: { manifestSha256: ordinaryExtentHash(manifestBytes), executionSha256: executionHash(inputs.config) } };
  }
  return inputs;
}
function readLifecycleManifest(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 1024 * 1024) invalid();
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const bytes = buffer.subarray(0, length), after = fstatSync(fd), named = lstatSync(path);
    if (bytes.length !== before.size || after.size !== before.size || named.size !== before.size ||
        before.dev !== named.dev || before.ino !== named.ino ||
        before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || after.ctimeMs !== named.ctimeMs ||
        after.mtimeMs !== named.mtimeMs || named.isSymbolicLink()) invalid();
    return bytes;
  } finally { closeSync(fd); }
}
function storedLifecycleLaunch(manifest: CodexGoalJobManifest, registryRootDir: string, cwd: string) {
  return goalLaunchInputFromRecord({ ...codexGoalJobToArgs(manifest),
    durableHandoffRootDir: manifest.durableHandoffRootDir ?? join(registryRootDir, "durable-handoffs") }, cwd);
}
/** Existing deterministic nonsecret execution projection, including model,
 * budgets, policy and checkpoint configuration; never sourceEnv or credentials. */
function executionHash(config: CodexGoalRunConfig): string {
  return ordinaryExtentHash(JSON.stringify(buildCodexGoalForegroundArgv({ config, cliCommand: [],
    cwd: config.workspacePath, logPath: join(config.jobRootDir, `${config.taskId}.log`) })));
}
function configuration(config: CodexGoalRunConfig) {
  return { jobId: config.jobId ?? config.taskId, taskId: config.taskId, jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath, promptPath: config.promptPath, authRootDir: config.authRootDir,
    stateRootDir: config.stateRootDir ?? join(config.jobRootDir, "state"),
    runtimeHomeRootDir: config.runtimeHomeRootDir ?? config.stateRootDir ?? join(config.jobRootDir, "state"),
    encryptionKeyPath: config.encryptionKeyPath ?? join(config.jobRootDir, "encryption-key.hex"),
    progressPath: config.progressPath ?? join(config.jobRootDir, `${config.taskId}.progress.json`),
    outputPath: config.outputPath ?? join(config.jobRootDir, `${config.taskId}.latest-result.json`),
    durableHandoffRootDir: config.durableHandoffRootDir ?? join(config.jobRootDir, "durable-handoffs"),
    accounts: config.accounts, sessionHomeProfile: config.sessionHomeProfile ?? null,
    executorId: config.executorId ?? codexSafeExecutorId(config.workspacePath),
    modelBackend: config.modelBackend ?? CodexModelBackend.OpenAiChatGpt,
    executionEngine: config.executionEngine ?? "app-server-goal",
    runtimeTempRoot: config.sourceEnv?.SUBSCRIPTION_RUNTIME_TMPDIR ?? join(config.jobRootDir, "tmp") };
}
const configHash = (config: CodexGoalRunConfig) => ordinaryExtentHash(JSON.stringify(configuration(config)));

export function hostedOrdinaryLaunchEnvironment(launch: Launch, env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return launchInputs(launch, env)?.config.sourceEnv ?? env;
}

/** Owner publication follows the existing pending reservation and precedes
 * raw origin, bootstrap or any setup. Missing/partial seals stay Unknown.
 * No caller-supplied writable list, executable permit or second allocation. */
export function sealHostedOrdinaryWriterExtent(fence: HostedActivationFence,
  start: HostedOrdinaryStart, startId: string, installation: HostedInstallation, launch: Launch,
  profileId: CodexProviderEgressProfileId, env: Readonly<Record<string, string | undefined>>): void {
  const inputs = launchInputs(launch, env);
  if (!inputs) return;
  const { config } = inputs; // Other inventoried entries retain their conservative owner contract.
  const binding = configuration(config);
  // Shared handoff is the frozen registry child, published only by the trusted
  // packet owner under the existing registry mutation lease.
  if (binding.durableHandoffRootDir !== join(start.jobRootDir, "durable-handoffs") &&
      (!inputs.registryRootDir || binding.durableHandoffRootDir !== join(inputs.registryRootDir, "durable-handoffs"))) return;
  const insideJob = (path: string) => path === start.jobRootDir || path.startsWith(start.jobRootDir + "/");
  if (!insideJob(binding.runtimeHomeRootDir)) return;
  if (binding.jobId !== start.jobId || config.jobRootDir !== start.jobRootDir || config.workspacePath !== start.workspacePath ||
      binding.runtimeTempRoot !== join(start.jobRootDir, "tmp")) invalid();
  const homes = config.accounts.map((account, index) => {
    const cacheKey = codexSessionHomeCacheKey({ profile: config.sessionHomeProfile,
      providerInstanceId: `${config.taskId}-${account.name}`, workerId: workerPoolSlotId(binding.executorId, index) });
    const root = codexWorkerCacheRoot(join(binding.runtimeHomeRootDir, "codex-session-cache"),
      codexWorkerCacheSlotKey(cacheKey, 0), binding.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
        ? CodexProviderEgressProfileId.MimoTokenPlan : profileId);
    return { home: join(root, "home"), codexHome: join(root, "codex-home") };
  });
  const scratch = resolveHostScratchLifetimeSources(start.jobRootDir, homes.map(row => row.codexHome));
  const paths = [...new Set([start.jobRootDir, start.workspacePath, binding.stateRootDir,
    binding.runtimeHomeRootDir, binding.runtimeTempRoot, binding.encryptionKeyPath,
    dirname(binding.progressPath), dirname(binding.outputPath), dirname(binding.encryptionKeyPath),
    ...(inputs.logPath ? [dirname(inputs.logPath)] : []),
    ...(insideJob(binding.durableHandoffRootDir) ? [binding.durableHandoffRootDir] : []),
    ...homes.flatMap(row => [row.home, row.codexHome]), ...scratch.map(row => row.source)])].map(path => observeOrdinaryWriterPath(path, scratch.some(row => row.target === path && row.source !== path)));
  const extent = parseHostedOrdinaryWriterExtent({ schemaVersion: 1, profile: HostedOrdinaryWriterProfile.LifetimeV1,
    startId, startSha256: ordinaryExtentHash(encoded(start)), runtimeSha: installation.runtimeSha,
    runtimeManifestSha256: installation.runtimeManifestSha256, inventorySha256: installation.inventorySha256,
    launchSha256: ordinaryExtentHash(JSON.stringify(launch)), configSha256: configHash(config),
    taskId: config.taskId, promptPath: config.promptPath, modelBackend: binding.modelBackend,
    registryRootDir: inputs.registryRootDir ?? null, homes, paths, lifecycle: inputs.lifecycle ?? null,
    publication: { jobId: binding.jobId, durableHandoffRootDir: binding.durableHandoffRootDir,
      paths: [...new Set([binding.durableHandoffRootDir, ...(inputs.registryRootDir ?
        [inputs.registryRootDir, join(inputs.registryRootDir, binding.jobId), projectControlWorkspaceLockRoot(inputs.registryRootDir)] : [])])].map(path => observeOrdinaryWriterPath(path)) } });
  createReadonlyPrivateRecord(join(readonlySupervisorRoot, "ordinary-starts", startId + ".extent.json"), encoded(extent));
  if (!readHostedOrdinaryWriterExtent(fence, startId, encoded(start), installation)) invalid();
}

export function assertHostedOrdinaryLaunchExtent(fence: HostedActivationFence,
  start: HostedOrdinaryStart, startId: string, installation: HostedInstallation, launch: Launch,
  env?: Readonly<Record<string, string | undefined>>): void {
  const extent = readHostedOrdinaryWriterExtent(fence, startId, encoded(start), installation);
  if (!extent) return;
  if (extent.launchSha256 !== ordinaryExtentHash(JSON.stringify(launch))) invalid();
  if (env) {
    const inputs = launchInputs(launch, env);
    if (!inputs || configHash(inputs.config) !== extent.configSha256 ||
        (inputs.registryRootDir ?? null) !== extent.registryRootDir ||
        (extent.lifecycle !== null && JSON.stringify(inputs.lifecycle) !== JSON.stringify(extent.lifecycle))) invalid();
  }
  assertHostedOrdinaryPublicationPaths(extent, extent.publication?.paths.map(pin => pin.path) ?? []);
}

/** The actual original process start selects the owner. Sibling reservations
 * can advance activation.generation without changing this start's seal. */
export function assertHostedOrdinaryGoalExtent(config: CodexGoalRunConfig, paths: readonly string[] = [], registryRootDir?: string): void {
  if (!isHostedOrdinaryRuntime()) return;
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence), startId = origin.reservation.startId;
    const extent = readHostedOrdinaryWriterExtent(fence, startId, encoded(origin.start), origin.installation);
    if (!extent) return;
    if (configHash(config) !== extent.configSha256 ||
        (extent.lifecycle !== null && executionHash(config) !== extent.lifecycle.executionSha256) ||
        (registryRootDir !== undefined && registryRootDir !== extent.registryRootDir)) invalid();
    assertHostedOrdinaryWriterPaths(extent, [...extent.paths.map(pin => pin.path), ...paths]);
  });
}

/** Exact start revision is checked by the existing lifecycle boundary before
 * its first operation. Later owner-authorized metadata updates remain allowed. */
export function assertHostedOrdinaryLifecycleStart(config: CodexGoalRunConfig, registryRootDir: string): void {
  if (!isHostedOrdinaryRuntime()) return;
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence), extent = readHostedOrdinaryWriterExtent(fence,
      origin.reservation.startId, encoded(origin.start), origin.installation);
    if (!extent) return;
    if (!extent.lifecycle || extent.registryRootDir !== registryRootDir ||
        executionHash(config) !== extent.lifecycle.executionSha256 || ordinaryExtentHash(readLifecycleManifest(codexGoalJobManifestPath({
          registryRootDir, jobId: config.jobId ?? config.taskId }))) !== extent.lifecycle.manifestSha256) invalid();
  });
}

/** Trusted terminal dependency selected from the actual original ordinary start.
 * The existing registry lease encloses capture and publication; no synchronous
 * activation fence survives an await and no shared root becomes provider RW. */
export function hostedOrdinaryHandoffPublicationAuthority(input: {
  readonly jobId?: string; readonly taskId: string; readonly jobRootDir: string;
  readonly workspacePath: string; readonly durableHandoffRootDir?: string;
}): TerminalHandoffPublicationAuthority | undefined {
  // Missing legacy seal is checked before grant/origin validation, as in raw
  // effect guards; a present corrupt or unsafe record still fails closed.
  if (!currentHostedOrdinaryWriterExtent()?.publication) return undefined;
  const current = (paths: readonly string[] = []) => withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence), startId = origin.reservation.startId;
    const extent = readHostedOrdinaryWriterExtent(fence, startId, encoded(origin.start), origin.installation);
    if (!extent?.publication) invalid();
    if (extent.publication.jobId !== (input.jobId ?? input.taskId) || extent.taskId !== input.taskId ||
        origin.start.jobRootDir !== input.jobRootDir || origin.start.workspacePath !== input.workspacePath ||
        extent.publication.durableHandoffRootDir !== (input.durableHandoffRootDir ?? join(input.jobRootDir, "durable-handoffs"))) invalid();
    for (const path of paths) if (path !== extent.publication.durableHandoffRootDir &&
        !path.startsWith(extent.publication.durableHandoffRootDir + "/")) invalid();
    assertHostedOrdinaryPublicationPaths(extent, [...extent.publication.paths.map(pin => pin.path), ...paths]);
    return extent;
  });
  const initial = current();
  if (!initial) return undefined;
  let held = false;
  const assertPublicationAuthorized = async (paths: readonly string[] = []) => {
    if (!held || current(paths)?.startId !== initial.startId) invalid();
  };
  return { assertPublicationAuthorized, withPublicationAuthority: async effect => {
    if (held || current()?.startId !== initial.startId) invalid();
    const publish = async () => {
      held = true;
      try { await assertPublicationAuthorized(); return await effect(); }
      finally { held = false; }
    };
    return initial.registryRootDir ? await withCodexGoalRegistryMutation({ registryRootDir: initial.registryRootDir,
      requireExistingRegistryRoot: true, effect: publish }) : await publish();
  } };
}

function observeOrdinary(manifest: CodexGoalJobManifest): ProjectAdmissionWriterObservation {
  return withHostedActivationFence(fence => {
    const { installation, activation, birth, originSha256, creator } = readHostedOrdinaryObservationOrigin(manifest.jobId);
    if (birth.jobRootDir !== manifest.jobRootDir || birth.workspacePath !== manifest.workspacePath) return { status: "unknown" };
    const rows = activation.ordinaryStarts.filter(row => row.originSha256 === originSha256);
    if (rows.length === 0) return { status: "unknown" };
    const terminal = rows.every(row => row.state === HostedCustodyReservationState.Terminal);
    const roots: { device: string; backingPath: string }[] = [];
    let sawRuntime = false;
    for (const row of rows) {
      const bytes = readHostedActivationBytes(`ordinary-starts/${row.startId}.json`);
      if (!bytes) invalid();
      const start = parseHostedOrdinaryStart(decodeHostedActivationBytes(bytes));
      if (start.installationId !== installation.installationId || start.jobId !== birth.jobId ||
          start.jobRootDir !== birth.jobRootDir || start.workspacePath !== birth.workspacePath ||
          start.originSha256 !== originSha256 || start.creatorId !== row.creatorId || start.unit !== row.unit ||
          start.activationGeneration !== row.generation || start.bootId !== activation.bootId ||
          start.supervisorId !== activation.supervisorId) invalid();
      if (!row.unit.startsWith("subscription-runtime-ordinary-")) continue;
      const extent = readHostedOrdinaryWriterExtent(fence, row.startId, bytes, installation);
      if (!extent || extent.taskId !== manifest.taskId || extent.promptPath !== manifest.promptPath ||
          extent.modelBackend !== (manifest.modelBackend ?? CodexModelBackend.OpenAiChatGpt) ||
          extent.launchSha256 !== ordinaryExtentHash(JSON.stringify(creator.launch))) return { status: "unknown" };
      if (extent.lifecycle && (!extent.registryRootDir || executionHash(storedLifecycleLaunch(manifest,
          extent.registryRootDir, creator.launch.cwd).config) !== extent.lifecycle.executionSha256)) return { status: "unknown" };
      sawRuntime = true;
      if (!terminal) assertHostedOrdinaryPublicationPaths(extent, extent.publication?.paths.map(pin => pin.path) ?? []);
      roots.push(...extent.paths.flatMap(pin => pin.roots));
    }
    if (!sawRuntime) return { status: "unknown" };
    // Terminal is a positive owner transition after exact creator, queue and
    // provider closure. Any retained provider/successor reservation keeps it held.
    if (terminal) return { status: "released" };
    return { status: "allocated", roots };
  });
}
export async function observeHostedOrdinaryJobWriterAuthority(manifest: CodexGoalJobManifest): Promise<ProjectAdmissionWriterObservation> {
  try { return observeOrdinary(manifest); } catch { return { status: "unknown" }; }
}

/** Routing observation only. The positive private origin reader, never this
 * cgroup prefix or caller identity, authorizes the selected ordinary route. */
export function isHostedOrdinaryRuntime(): boolean {
  return process.platform === "linux" && /^0::\/subscription\.slice\/subscription-runtime\.slice\/subscription-runtime-hosted\.slice\/subscription-runtime-ordinary-/.test(
    observedProcessCgroup(readFileSync("/proc/self/cgroup", "utf8")));
}
export function admitHostedOrdinaryIdentity(identity: { readonly jobId: string; readonly jobRootDir: string; readonly workspacePath: string }): CodexProviderEgressProfileId {
  return withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence);
    if (origin.birth.jobId !== identity.jobId || origin.birth.jobRootDir !== identity.jobRootDir ||
        origin.birth.workspacePath !== identity.workspacePath) invalid();
    if (origin.start.grantSha256 === null) return CodexProviderEgressProfileId.FullInternetV1;
    const name = ordinaryExtentHash(Buffer.from(identity.jobId)) + ".json";
    const bytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, name), 4096);
    if (!bytes || ordinaryExtentHash(bytes) !== origin.start.grantSha256) invalid();
    const grant = parseHostedTestEgressGrant(decodeHostedActivationBytes(bytes));
    assertHostedTestEgressIdentity(grant, identity);
    return grant.profileId;
  });
}


/** A protected never-started birth cannot mask even an incomplete ordinary
 * origin. Missing root is accepted only beneath authenticated host ancestry. */
export function hostedOrdinaryWriterAuthorityAbsent(jobId: string): boolean {
  try {
    researchCustody(dirname(readonlySupervisorRoot));
    try { lstatSync(readonlySupervisorRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return true; }
    researchCustody(readonlySupervisorRoot, true);
    return withHostedActivationFence(() => {
      if (readHostedActivationBytes(`ordinary-origins/${ordinaryExtentHash(jobId)}.json`)) return false;
      const catalog = readHostedActivationBytes("ordinary-origins.json");
      return !catalog || !parseHostedOrdinaryOrigins(decodeHostedActivationBytes(catalog)).origins.some(row => row.jobId === jobId);
    });
  } catch { return false; }
}
