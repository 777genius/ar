import { readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeHostedInventoryBytes, parseHostedInventoryV5, type HostedInventoryLaunch } from "../core/host-infrastructure/host-inventory";
import type { DependencyParentRecipeOriginalRoots } from "../core/dependency-environment/dependency-parent-recipe-reader";
import { parseHostedInstallation, type HostedInstallation } from "../worker-core/hosted-custody/domain/hosted-installation-activation";
import { resolveStoredProjectStartPlan } from "./stored-start-planning";
import { collectProcessBirth, collectProcessCgroup, collectUnitInvocation, collectUnitShow } from "./hosted-readonly-linux-collector";
import { QualificationClock, qualificationJson, qualificationObject, qualificationRead, qualificationRoot,
  qualificationSha } from "./hosted-ordinary-installation-qualification";
import { assertHostedActivationFence, readHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";

/** Read-only writer facts for the existing original Usable producer. No caller
 * flag or credential can select this branch; the protected stored tuple, live
 * Source worker and original funded guest records must all agree. */
const broker = qualificationRoot + "/broker";
const jobs = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same = isDeepStrictEqual;
function fail(): never { throw new Error("hosted_original_usable_parent_recipe_unsupported"); }
export function readHostedOriginalUsableParentRoots(raw: HostedInventoryLaunch, job: string, workspace: string): DependencyParentRecipeOriginalRoots | undefined {
  return readOriginalRoots(raw, job, workspace);
}
/** The existing Store's fresh placement fence supplies its actual unpublished
 * installation DATA. This check cannot select a grant or writer scope: those
 * callers always require the published installation through the function above. */
export function readHostedOriginalUsableInstallationRecipe(fence: HostedActivationFence, installation: HostedInstallation, raw: HostedInventoryLaunch): boolean {
  assertHostedActivationFence(fence);
  const selected = readOriginalRoots(raw, raw.cwd.slice(0, -"/workspace".length), raw.cwd, installation) !== undefined;
  assertHostedActivationFence(fence); return selected;
}
function readOriginalRoots(raw: HostedInventoryLaunch, job: string, workspace: string, draft?: HostedInstallation): DependencyParentRecipeOriginalRoots | undefined {
  if (raw.args[1] !== "tool") return undefined;
  if (raw.args.length !== 6 || raw.args[2] !== "codex_goal_project_start" || raw.args[3] !== "--args-json" ||
      raw.args[5] !== "--json" || raw.cwd !== workspace) fail();
  const plan = resolveStoredProjectStartPlan(raw.args[4]!, workspace), config = plan.launch.config;
  if (config.authRootDir !== broker) return undefined;
  if (plan.jobRoot !== job || plan.workspace !== workspace || raw.command !== process.execPath ||
      plan.launch.cliCommand[0] !== raw.command || plan.launch.cliCommand[1] !== raw.args[0]) fail();
  const captured = new Map<string, Buffer>();
  const privateRecord = (name: string, keys: string) => {
    const bytes = qualificationRead(qualificationRoot + "/" + name, 65536, true); captured.set(name, bytes);
    return qualificationObject(qualificationJson(bytes), keys);
  };
  const input = privateRecord("usable-input.json", "schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure,creator,tools");
  const operation = qualificationObject(input.operation, "operationId,workEndEpochMs,cleanupEndEpochMs");
  const candidate = qualificationObject(input.candidate, "candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256");
  const fixture = qualificationObject(input.fixture, "testId,guestMachineId,guestHostname,guestEntrySha256");
  const creator = qualificationObject(input.creator, "creatorId,jobId,jobRootDir,workspacePath,launch");
  qualificationObject(creator.launch, "command,args,cwd");
  if (input.schemaVersion !== 1 || ![operation.operationId, fixture.testId, input.workerId, input.providerId].every(id => typeof id === "string" && uuid.test(id)) ||
      new Set([fixture.testId, input.workerId, input.providerId]).size !== 3 ||
      creator.creatorId !== "TEST-ordinary-usable-" + input.providerId || creator.jobId !== creator.creatorId || creator.jobId !== plan.jobId ||
      job !== jobs + "/" + creator.jobId || creator.jobRootDir !== job || creator.workspacePath !== workspace || workspace !== job + "/workspace" ||
      !same(creator.launch, raw) || raw.args[0] !== candidate.candidateArtifactPath + "/dist/worker-codex/codex-goal-cli.js") fail();
  // This is the original producer's funded operation, never a new recipe grant.
  const fundedBytes = qualificationRead(qualificationRoot + "/funded-operation.json", 65536, true); captured.set("funded-operation.json", fundedBytes);
  const funded = qualificationJson(fundedBytes) as Record<string, unknown>;
  if (!funded || funded.schemaVersion !== 2 || Object.entries(operation).some(([key,value]) => funded[key] !== value) ||
      funded.runtimeDirectory !== candidate.candidateArtifactPath || funded.runtimeSha !== candidate.runtimeSha ||
      funded.runtimeManifestSha256 !== candidate.runtimeManifestSha256) fail();
  const clock = new QualificationClock({ operationId: operation.operationId as string, workEndEpochMs: operation.workEndEpochMs as number,
    cleanupEndEpochMs: operation.cleanupEndEpochMs as number, operationSha256: qualificationSha(fundedBytes) },
    { issuedEpochMs: funded.issuedEpochMs as number, issuedMonotonicNs: funded.issuedMonotonicNs as string });
  const ready = privateRecord("usable-ready.json", "schemaVersion,operationSha256,guestInputSha256,unit,invocationId,namespaces,bootId");
  const inventoryBytes = readHostedActivationBytes("readonly-inventory.json"), installationBytes = readHostedActivationBytes("host-installation.json");
  if (!inventoryBytes || !installationBytes && !draft) fail();
  const inventory = parseHostedInventoryV5(decodeHostedInventoryBytes(inventoryBytes));
  const installation = parseHostedInstallation(draft ?? qualificationJson(installationBytes!));
  if (installationBytes && !same(parseHostedInstallation(qualificationJson(installationBytes)), installation)) fail();
  const entry = installation.runtimeDirectory + "/dist/worker-codex/hosted-ordinary-installation-usable-guest.js";
  const supervisor = inventory.supervisor, unit = "subscription-runtime-hosted-" + input.workerId + ".service";
  const selected = inventory.units.find(row => row.name === unit);
  if (installation.inventorySha256 !== qualificationSha(inventoryBytes) || installation.runtimeDirectory !== candidate.candidateArtifactPath ||
      installation.runtimeSha !== candidate.runtimeSha || installation.runtimeManifestSha256 !== candidate.runtimeManifestSha256 ||
      inventory.hostId !== installation.hostId || inventory.hostId !== fixture.guestMachineId ||
      inventory.supervisorUnit !== unit || supervisor.bootstrap.path !== entry || supervisor.bootstrap.sha256 !== fixture.guestEntrySha256 ||
      qualificationSha(qualificationRead(entry, 1024 * 1024)) !== fixture.guestEntrySha256 ||
      supervisor.executable.path !== raw.command || !same(funded.node, supervisor.executable) || supervisor.operationId !== operation.operationId ||
      supervisor.workEndEpochMs !== operation.workEndEpochMs || supervisor.cleanupEndEpochMs !== operation.cleanupEndEpochMs ||
      inventory.ordinaryCreators.length !== 1 || !same(inventory.ordinaryCreators[0], creator) || !same(inventory.runtimeLaunch, raw) ||
      !same(inventory.systemBusInfrastructure, input.systemBusInfrastructure) || inventory.collectorProfile.sha256 !== candidate.profileSha256 ||
      readFileSync("/etc/machine-id", "utf8").trim() !== fixture.guestMachineId ||
      fixture.guestHostname !== "ordinary-test-" + fixture.testId || readFileSync("/etc/hostname", "utf8").trim() !== fixture.guestHostname ||
      readFileSync("/run/systemd/container", "utf8").trim() !== "systemd-nspawn" || readlinkSync("/proc/1/exe") !== "/usr/lib/systemd/systemd" ||
      ready.schemaVersion !== 1 || ready.operationSha256 !== qualificationSha(fundedBytes) || ready.guestInputSha256 !== qualificationSha(captured.get("usable-input.json")!) ||
      ready.unit !== "subscription-runtime-ordinary-" + fixture.testId + ".service" || typeof ready.invocationId !== "string" || !/^[a-f0-9]{32}$/.test(ready.invocationId) ||
      ready.bootId !== inventory.bootId || ready.bootId !== readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ||
      !Array.isArray(ready.namespaces) || ready.namespaces.length !== 4 || !selected ||
      selected.controlGroup !== "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + unit) fail();
  for (const name of ["user", "mnt", "pid", "net"]) {
    const rows = (ready.namespaces as Record<string,unknown>[]).filter(row => row.name === name);
    if (rows.length !== 1) fail();
    const row = qualificationObject(rows[0], "name,dev,ino"), own = statSync(`/proc/self/ns/${name}`), initial = statSync(`/proc/1/ns/${name}`);
    if (own.dev !== initial.dev || own.ino !== initial.ino || row.dev !== own.dev || row.ino !== own.ino) fail();
  }
  const worker = () => clock.collect(() => {
    const current = collectUnitShow(unit), pid = supervisor.birth.split(":")[0]!;
    if (current.MainPID !== pid || current.ControlGroup !== selected.controlGroup || collectProcessBirth(pid) !== supervisor.birth ||
        collectProcessCgroup(pid) !== "0::" + selected.controlGroup || collectUnitInvocation(unit) !== selected.invocationId ||
        readlinkSync(`/proc/${pid}/exe`) !== supervisor.executable.path ||
        !readFileSync(`/proc/${pid}/cmdline`).equals(Buffer.from([raw.command, entry, "worker"].join("\0") + "\0"))) fail();
  });
  worker();
  const registry = plan.registryRootDir, controller = plan.controller, manifest = plan.manifest;
  const controlRoot = jobs + "/" + controller.jobId;
  const workerScope = config.projectAccessScope, controlScope = controller.projectAccessScope;
  // Exact relationships of the sealed original producer plan. A prefix alone
  // cannot select another auth, registry, controller or writer destination.
  if (dirname(registry) !== jobs || registry === job || registry === controlRoot || controller.jobRootDir !== controlRoot ||
      !workerScope || !controlScope || workerScope.registryRoot !== registry || controlScope.registryRoot !== registry ||
      workerScope.authRoot !== broker || controlScope.authRoot !== broker || workerScope.projectId !== controlScope.projectId ||
      !same(workerScope.workspaceRoots, [workspace]) || workerScope.isolatedWorkspaceRoot !== workspace ||
      !same(controlScope.worktreeRoots, [workspace]) || !same(controlScope.workspaceRoots, [controller.workspacePath]) ||
      !same(controlScope.jobIdPrefixes, [plan.jobId, controller.jobId]) || !same(controlScope.tmuxSessionPrefixes, [plan.jobId, controller.jobId]) ||
      !same(workerScope.allowedAccountIds, ["account-test"]) || !same(controlScope.allowedAccountIds, ["account-test"]) ||
      ![broker, registry, controlRoot].every(path => workerScope.deniedRoots?.includes(path) && controlScope.deniedRoots?.includes(path)) ||
      config.accounts?.length !== 1 || config.accounts[0]?.name !== "account-test" || (config.accounts[0].authJsonPath ?? broker + "/account-test/auth.json") !== broker + "/account-test/auth.json" ||
      config.accounts[0].envVarName !== undefined || controller.authRootDir !== broker ||
      manifest.stateRootDir !== job + "/state" || config.stateRootDir !== job + "/state" || controller.stateRootDir !== controlRoot + "/state" ||
      config.durableHandoffRootDir !== registry + "/durable-handoffs" || controller.durableHandoffRootDir !== registry + "/durable-handoffs" ||
      config.progressPath !== job + "/state/progress.json" || plan.launch.logPath !== job + "/state/run.log" ||
      plan.taskId !== plan.jobId || plan.output !== job + "/" + plan.taskId + ".latest-result.json" || config.promptPath !== job + "/prompt.md" ||
      manifest.allowDangerFullAccess !== false || manifest.allowDuplicateAccountIdentities !== false || plan.binding.preStart !== null) fail();
  worker();
  for (const [name, bytes] of captured) if (!qualificationRead(qualificationRoot + "/" + name, 65536, true).equals(bytes)) fail();
  const currentInstallation = readHostedActivationBytes("host-installation.json");
  if (!readHostedActivationBytes("readonly-inventory.json")?.equals(inventoryBytes) ||
      (installationBytes ? !currentInstallation?.equals(installationBytes) : currentInstallation !== null)) fail();
  clock.remaining();
  return Object.freeze({ auth: broker, capacity: qualificationRoot + "/.subscription-runtime-account-capacity", registry,
    handoff: registry + "/durable-handoffs", state: job + "/state", progress: job + "/state/progress.json", log: job + "/state/run.log" });
}
