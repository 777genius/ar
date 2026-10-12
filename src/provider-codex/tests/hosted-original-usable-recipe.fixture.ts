import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { HostedInventoryCategory, parseHostedInventoryV5 } from "../../core/host-infrastructure/host-inventory";
import { planStoredProjectStart } from "../../worker-codex/stored-start-planning";
import { parseSystemBusInfrastructure, SystemBusInfrastructureRole, SystemBusQueryRenderer } from "../../core/host-infrastructure/system-bus-infrastructure";
import { parseDependencyToolRegistration, DependencyToolTransformCache } from "../../core/dependency-environment/dependency-tool-profile";
import { parseHostedInstallation } from "../../worker-core/hosted-custody/domain/hosted-installation-activation";

/** Pure public fixture DATA only. No file, credential, kernel or effect access.
 * The caller owns source-to-dist module-location projection in a Vitest harness.
 * Actual planning and binding run and must produce the selected runtime path. */
export type OriginalUsableRecipeOptions = Readonly<{
  runtimeDirectory?: string; hostId?: string; bootId?: string; workerBirth?: string;
  workerPid?: number; workerUnit?: string; workerInvocationId?: string;
  workerPatch?: Record<string, unknown>;
}>;
export const originalUsablePolicy = "/var/lib/subscription-runtime-host-policy", qualification = originalUsablePolicy + "/ordinary-qualification";
const provider = "a4f8971f-1e6f-4339-8d8c-469af3f910ac", workerId = "b4f8971f-1e6f-4339-8d8c-469af3f910ac";
const testId = "c4f8971f-1e6f-4339-8d8c-469af3f910ac", operationId = "d4f8971f-1e6f-4339-8d8c-469af3f910ac";
const bootId = "e4f8971f-1e6f-4339-8d8c-469af3f910ac", hostId = "a".repeat(32);
const jobId = "TEST-ordinary-usable-" + provider, controllerId = "TEST-ordinary-usable-control-fixed-" + provider;
const job = originalUsablePolicy + "/dependency-test-jobs/jobs/" + jobId, workspace = job + "/workspace";
const registry = originalUsablePolicy + "/dependency-test-jobs/jobs/pr278-registry-fixed-" + provider;
const source = "/srv/workers/pr278-source-" + provider, auth = qualification + "/broker";
export const originalUsablePaths = Object.freeze({ policy: originalUsablePolicy, qualification, provider, workerId, testId, operationId, bootId, hostId, jobId, controllerId, job, workspace, registry, source, auth });
const policy = originalUsablePolicy;
const json = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

export function buildOriginalUsableRecipe(options: OriginalUsableRecipeOptions = {}) {
  const hostId = options.hostId ?? originalUsablePaths.hostId, bootId = options.bootId ?? originalUsablePaths.bootId;
  const workerPid = options.workerPid ?? (options.workerBirth ? Number(options.workerBirth.split(":")[0]) : process.pid);
  const workerPatch = options.workerPatch ?? {};
  const facts = { privateBytes: new Map<string, Buffer>(), activationBytes: new Map<string, Buffer>(),
    qualificationBytes: new Map<string, Buffer>(), procBytes: new Map<string, string | Buffer>(),
    procLinks: new Map<string, string>(), namespaces: new Map<string, { dev: number; ino: number }>(),
    birth: "", unit: "", invocation: "", group: "" };
  // Fields modeled from retained-usable-{launch,controller}-configuration-
  // readback.json. No auth file is read or added to the fixture.
  const common = { schemaVersion: 1, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
    accounts: ["account-test"], taskId: jobId, model: "gpt-6.1-sol", reasoningEffort: "high", serviceTier: "default" };
  const deniedRoots = [auth, registry, policy + "/dependency-test-jobs/jobs/" + controllerId,
    "/srv/workers/pr278-registry-" + provider, "/srv/workers/pr278-controller-" + provider,
    "/srv/platform/projects", "/etc/subscription-runtime/secrets"];
  const scopeBase = { projectId: "subscription-runtime-pr278-" + provider,
    projectSlug: "subscription-runtime/pr278-" + provider, registryRoot: registry, authRoot: auth,
    deniedRoots, allowedAccountIds: ["account-test"] };
  const worker = { ...common, jobId, jobRootDir: job, workspacePath: workspace, cwd: workspace,
    authRootDir: auth, stateRootDir: job + "/state", durableHandoffRootDir: registry + "/durable-handoffs",
    logPath: job + "/state/run.log", progressPath: job + "/state/progress.json",
    outputPath: job + "/" + jobId + ".latest-result.json", promptPath: job + "/prompt.md", tmuxSession: jobId,
    executionEngine: "app-server", codexBinaryPath: "/opt/nodejs/node-v24.21.0-linux-x64/lib/node_modules/@openai/codex/bin/codex.js",
    projectAccessScope: { ...scopeBase, readRoots: [source, workspace, registry], isolatedWorkspaceRoot: workspace, workspaceRoots: [workspace] },
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite, requireGitWorkspace: true, prewarmOnStart: false,
    editMode: "read-only", networkAccess: "unrestricted", outputFormat: "json", workerReportMode: "runtime-only",
    taskTimeoutMs: 180000, progressHeartbeatMs: 60000, maxAccountCycles: 1, appServerStartupTimeoutMs: 30000,
    allowDangerFullAccess: false, allowDuplicateAccountIdentities: false, ...workerPatch };
  const controllerRoot = policy + "/dependency-test-jobs/jobs/" + controllerId;
  const controller = { ...common, jobId: controllerId, jobRootDir: controllerRoot, workspacePath: source, cwd: source,
    promptPath: controllerRoot + "/prompt.md", authRootDir: auth, stateRootDir: controllerRoot + "/state",
    durableHandoffRootDir: registry + "/durable-handoffs", accessBoundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: { ...scopeBase, readRoots: [source, workspace], workspaceRoots: [source], worktreeRoots: [workspace],
      jobIdPrefixes: [jobId, controllerId], tmuxSessionPrefixes: [jobId, controllerId],
      allowedBranches: ["1137ea2c651df332c2a7912f8d589b535764ce1b", "test/pr278-usable-fixture-" + provider], allowedGitRemotes: [] } };
  const snapshots = { controller: json(controller), worker: json(worker), prompt: Buffer.from("Public fixture dependency task.\n"), preStart: null };
  const request = { controllerJobId: controllerId, jobId, registryRootDir: registry, confirmStart: true,
    forceStart: false, skipDoctor: false, dependencyBootstrap: "off" };
  const plan = planStoredProjectStart(JSON.stringify(request), workspace, snapshots);
  const launch = { command: process.execPath, args: [plan.launch.cliCommand[1]!, "tool", "codex_goal_project_start",
    "--args-json", JSON.stringify({ ...request, storedStartBinding: plan.binding }), "--json"], cwd: workspace };
  facts.privateBytes.set(registry + "/" + controllerId + "/job.json", snapshots.controller);
  facts.privateBytes.set(registry + "/" + jobId + "/job.json", snapshots.worker);
  facts.privateBytes.set(job + "/prompt.md", snapshots.prompt);
  const artifact = options.runtimeDirectory ?? dirname(dirname(dirname(plan.launch.cliCommand[1]!)));
  if (plan.launch.cliCommand[1] !== artifact + "/dist/worker-codex/codex-goal-cli.js")
    throw new Error("fixture_actual_planner_runtime_location_mismatch");
  const bootstrap = artifact + "/dist/worker-codex/hosted-ordinary-installation-usable-guest.js", bootstrapBytes = Buffer.from("Public original Usable bootstrap fixture.\n");
  const operation = { operationId, workEndEpochMs: Date.now() + 120000, cleanupEndEpochMs: Date.now() + 150000 };
  const funded = { schemaVersion: 2, ...operation, issuedEpochMs: Date.now(), issuedMonotonicNs: process.hrtime.bigint().toString(),
    runtimeDirectory: artifact, runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64),
    node: { path: process.execPath, sha256: "8".repeat(64) } };
  const fundedBytes = json(funded), creator = { creatorId: jobId, jobId, jobRootDir: job, workspacePath: workspace, launch };
  const candidate = { candidateArtifactPath: artifact, runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64),
    launcherSha256: "3".repeat(64), codecSha256: "4".repeat(64), profileSha256: "5".repeat(64), sourceScopeSha256: "6".repeat(64) };
  const pin = (path: string) => ({ path, sha256: "a".repeat(64) });
  const executable = pin("/usr/bin/dbus-daemon"), loader = pin("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");
  const systemBusInfrastructure = parseSystemBusInfrastructure({ version: 2, role: SystemBusInfrastructureRole.SystemBus,
    service: { name: "dbus.service", controlGroup: "/system.slice/dbus.service", fragmentPath: "/etc/systemd/system/dbus.service", fragmentSha256: "a".repeat(64) },
    socket: { name: "dbus.socket", endpoint: "/run/dbus/system_bus_socket", fragmentPath: "/etc/systemd/system/dbus.socket", fragmentSha256: "a".repeat(64) },
    config: pin("/etc/subscription-runtime/system-bus/bus.conf"), executable, elfClosure: [executable, loader],
    queryTool: { renderer: SystemBusQueryRenderer.Systemd255Terse, ...pin("/usr/bin/busctl"), elfClosure: [pin("/usr/bin/busctl"), loader] } });
  const tools = parseDependencyToolRegistration({ testFiles: ["public.test.ts"], optimizerDependencies: ["typescript"], transformCache: DependencyToolTransformCache.Temporary });
  const input = { schemaVersion: 1, operation, candidate, fixture: { testId, guestMachineId: hostId,
    guestHostname: "ordinary-test-" + testId, guestEntrySha256: sha(bootstrapBytes) }, workerId, providerId: provider,
    creator, systemBusInfrastructure, tools };
  const inputBytes = json(input);
  facts.birth = options.workerBirth ?? workerPid + ":100"; facts.unit = options.workerUnit ?? "subscription-runtime-hosted-" + workerId + ".service";
  facts.invocation = options.workerInvocationId ?? "b".repeat(32); facts.group = "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + facts.unit;
  const namespaceRows = ["user", "mnt", "pid", "net"].map((name, index) => ({ name, dev: 1, ino: index + 10 }));
  for (const row of namespaceRows) for (const pid of ["self", "1"]) facts.namespaces.set("/proc/" + pid + "/ns/" + row.name, { dev: row.dev, ino: row.ino });
  const ready = { schemaVersion: 1, operationSha256: sha(fundedBytes), guestInputSha256: sha(inputBytes),
    unit: "subscription-runtime-ordinary-" + testId + ".service", invocationId: "c".repeat(32), namespaces: namespaceRows, bootId };
  const ancestors = ["", "/subscription.slice", "/subscription.slice/subscription-runtime.slice", "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice", facts.group];
  const inventoryDraft = { schemaVersion: 5, hostId, bootId, supervisorUnit: facts.unit,
    units: [{ category: HostedInventoryCategory.Supervisor, name: facts.unit, aliases: [], controlGroup: facts.group,
      fragmentPath: "/run/systemd/transient/" + facts.unit, fragmentSha256: "7".repeat(64), dropIns: [], loadState: "loaded",
      activeState: "active", unitFileState: "transient", invocationId: facts.invocation, mainPidBirth: facts.birth, job: "", delegate: false }],
    cgroups: ancestors.map((path, index) => ({ path, dev: "1", ino: String(index + 1), ownerUnit: path === facts.group ? facts.unit : null,
      parent: index === 0 ? null : ancestors[index - 1], members: path === facts.group ? [{ birth: facts.birth, controlGroup: facts.group }] : [] })),
    activators: [], supervisor: { birth: facts.birth, executable: { path: process.execPath, sha256: "8".repeat(64) },
      bootstrap: { path: bootstrap, sha256: sha(bootstrapBytes) }, ...operation }, ordinaryCreators: [creator], disabledCreators: [],
    runtimeLaunch: launch, systemBusInfrastructure, collectorProfile: { path: policy + "/fd-collector-profile.v1.json", sha256: candidate.profileSha256 } };
  // Original schema-5 host read models require the pinned borrowed system bus.
  const busBirth = (workerPid === 42 ? 43 : 42) + ":200";
  inventoryDraft.units.push({ category: HostedInventoryCategory.Borrowed, name: "dbus.service", aliases: [],
    controlGroup: "/system.slice/dbus.service", fragmentPath: systemBusInfrastructure.service.fragmentPath,
    fragmentSha256: systemBusInfrastructure.service.fragmentSha256, dropIns: [], loadState: "loaded", activeState: "active",
    unitFileState: "enabled", invocationId: "d".repeat(32), mainPidBirth: busBirth, job: "", delegate: false });
  inventoryDraft.cgroups.push({ path: "/system.slice", dev: "1", ino: "100", ownerUnit: null, parent: "", members: [] },
    { path: "/system.slice/dbus.service", dev: "1", ino: "101", ownerUnit: "dbus.service", parent: "/system.slice",
      members: [{ birth: busBirth, controlGroup: "/system.slice/dbus.service" }] });
  const inventory = parseHostedInventoryV5(inventoryDraft);
  const inventoryBytes = json(inventory);
  facts.activationBytes.set("readonly-inventory.json", inventoryBytes); facts.privateBytes.set(policy + "/readonly-inventory.json", inventoryBytes);
  const installationTemplate = parseHostedInstallation({ schemaVersion: 1, installationId: "test-installation", hostId,
    runtimeDirectory: artifact, runtimeSha: candidate.runtimeSha, runtimeManifestSha256: candidate.runtimeManifestSha256, inventorySha256: sha(inventoryBytes) });
  facts.activationBytes.set("host-installation.json", json(installationTemplate));
  facts.qualificationBytes.set(qualification + "/usable-input.json", inputBytes);
  facts.qualificationBytes.set(qualification + "/funded-operation.json", fundedBytes);
  facts.qualificationBytes.set(qualification + "/usable-ready.json", json(ready)); facts.qualificationBytes.set(bootstrap, bootstrapBytes);
  facts.procBytes.set("/etc/machine-id", hostId + "\n"); facts.procBytes.set("/etc/hostname", input.fixture.guestHostname + "\n");
  facts.procBytes.set("/run/systemd/container", "systemd-nspawn\n"); facts.procBytes.set("/proc/sys/kernel/random/boot_id", bootId + "\n");
  facts.procBytes.set("/proc/self/cmdline", Buffer.from([process.execPath, bootstrap, "worker"].join("\0") + "\0"));
  facts.procBytes.set(`/proc/${workerPid}/cmdline`, facts.procBytes.get("/proc/self/cmdline")!);
  facts.procLinks.set("/proc/1/exe", "/usr/lib/systemd/systemd"); facts.procLinks.set("/proc/self/exe", process.execPath);
  facts.procLinks.set(`/proc/${workerPid}/exe`, process.execPath);
  return { ...facts, paths: { ...originalUsablePaths, hostId, bootId }, workerPid, launch, plan, snapshots, request, inventory, inventoryBytes, installationTemplate,
    input, inputBytes, funded, fundedBytes, ready, candidate, creator, operation, bootstrap, bootstrapBytes };
}
