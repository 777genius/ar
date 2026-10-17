import { trustedOrdinaryQualificationWorkerLaunch, trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSystemBusInfrastructure } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { hostedFdLaunch, spawnHostedFdChild, HostedFdLaunchKind } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { verifyPinnedFdCollectorProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { assertHostedActivationOperator, withHostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { verifySystemBusInfrastructure } from "../provider-codex/app-server/adapters/system-bus-infrastructure";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { collectOrdinaryInstallationDraft } from "./hosted-ordinary-installation-census";
import { publishReadonlyInventory } from "./hosted-readonly-custody";
import { collectBootId, collectProcessBirth, collectProcessCgroup, collectUnitInvocation, collectUnitShow } from "./hosted-readonly-linux-collector";
import type { OrdinaryInstallationOperation } from "./hosted-ordinary-installation-owned";
import { QualificationChild, QualificationClock, qualificationBootRecipe, qualificationBootUnit, qualificationBytes, qualificationCandidate, qualificationCodec, qualificationCopiedCohort,
  qualificationCreate, qualificationHeld, qualificationJson, qualificationLauncher, qualificationObject, qualificationProfile,
  qualificationRead, qualificationRoot, qualificationSha,
  type OrdinaryLauncherCandidate } from "./hosted-ordinary-installation-qualification";

const entry = fileURLToPath(import.meta.url);
enum WorkerQualificationPhase {
  Input = "input", Descriptors = "descriptors", Profile = "profile", SystemBus = "system_bus", Identity = "identity",
  Inventory = "inventory", Revalidation = "revalidation", InventoryPublication = "inventory_publication",
  Installation = "installation", InstallationCheck = "installation_check", ProviderIntent = "provider_intent", Provider = "provider",
}
let workerPhase = WorkerQualificationPhase.Input;
enum WorkerQualificationGuard {
  Unknown = "unknown", Qualification = "ordinary_launcher_qualification_held", Operator = "hosted_readonly_host_operator_required",
  Activation = "hosted_activation_evidence_invalid", Stdio = "hosted_custody_stdio_pipe_required",
  Descriptor = "hosted_custody_descriptor_invalid", InheritedHandle = "hosted_custody_inherited_handle_denied",
  FdBoundary = "hosted_fd_boundary_unresolved", Bus = "system_bus_infrastructure_unqualified",
  Inventory = "hosted_ordinary_inventory_unresolved", Custody = "hosted_custody_kernel_evidence_invalid",
  Policy = "hosted_readonly_policy_invalid", Binding = "hosted_readonly_policy_binding_mismatch",
  InputCustody = "hosted_readonly_input_custody_invalid", ConflictingEnrollment = "hosted_readonly_conflicting_enrollment",
  Fence = "hosted_custody_common_fence_required", PublicationRecovery = "hosted_activation_publication_recovery_required",
}
enum WorkerQualificationErrno { Unknown = "unknown", Access = "EACCES", Permission = "EPERM", Invalid = "EINVAL",
  Readonly = "EROFS", Space = "ENOSPC", Timeout = "ETIMEDOUT", Busy = "EBUSY", Missing = "ENOENT", Exists = "EEXIST", Io = "EIO" }
function retainWorkerFailure(error: unknown): void {
  try {
  // This TEST worker's original rejection remains status70. Only closed public
  // diagnostics are persisted; arbitrary messages, stacks and stdio never are.
  const failure = error instanceof Error ? error : undefined;
  const guard = Object.values(WorkerQualificationGuard).find(value => value === failure?.message) ?? WorkerQualificationGuard.Unknown;
  const errno = Object.values(WorkerQualificationErrno).find(value => value === (failure as NodeJS.ErrnoException | undefined)?.code) ?? WorkerQualificationErrno.Unknown;
  const modules = ["worker-codex/hosted-ordinary-installation-qualification-guest", "worker-codex/hosted-ordinary-installation-qualification",
    "worker-codex/hosted-ordinary-installation-census", "worker-codex/hosted-installation-activation", "worker-codex/hosted-readonly-host-kernel",
    "worker-codex/hosted-readonly-linux-collector", "worker-codex/hosted-readonly-inputs", "worker-codex/hosted-readonly-custody",
    "provider-codex/app-server/adapters/hosted-process-activation", "provider-codex/app-server/adapters/hosted-process-descriptors",
    "provider-codex/app-server/adapters/hosted-fd-observation", "provider-codex/app-server/adapters/system-bus-infrastructure"] as const;
  const runtime = entry.slice(0, -"/dist/worker-codex/hosted-ordinary-installation-qualification-guest.js".length);
  const callSites: { module: typeof modules[number]; line: number; column: number }[] = [];
  for (const frame of (failure?.stack ?? "").slice(0, 16384).split("\n").slice(1, 16)) {
    for (const module of modules) {
      const prefix = runtime + "/" + (frame.includes(runtime + "/src/") ? "src/" : "dist/") + module + ".";
      const at = frame.indexOf(prefix); if (at < 0) continue;
      const match = /^(?:js|ts):(\d{1,5}):(\d{1,5})\)?$/.exec(frame.slice(at + prefix.length));
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 16384 && Number(match[2]) > 0 && Number(match[2]) <= 4096 && callSites.length < 8)
        callSites.push({ module, line: Number(match[1]), column: Number(match[2]) });
    }
  }
  qualificationCreate(qualificationRoot + "/output/worker-failure.json", qualificationBytes({
    schemaVersion: 1, kind: "Pr270OriginalQualificationWorkerFailure", phase: workerPhase, guard, errno, callSites,
    noRawError: true, noRawStdio: true, qualificationClaim: false,
  }));
  } catch { /* Failed diagnostic custody cannot change the original failure outcome. */ }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Input = Readonly<{ schemaVersion: 1; operation: Pick<OrdinaryInstallationOperation, "operationId" | "workEndEpochMs" | "cleanupEndEpochMs">; candidate: OrdinaryLauncherCandidate;
  fixture: Readonly<{ testId: string; guestMachineId: string; guestHostname: string; guestEntrySha256: string }>;
  workerId: string; providerId: string; systemBusInfrastructure: ReturnType<typeof parseSystemBusInfrastructure> }>;
// Fixed inert payload is public TEST data. No account/model/provider program is run.
const echoProgram = 'process.stdout.write(process.argv[1]+"\\n")';
function readInput(): { input: Input; bytes: Buffer; clock: QualificationClock } {
  assertHostedActivationOperator();
  const bytes = qualificationRead(qualificationRoot + "/input.json", 65536, true);
  const data = qualificationObject(qualificationJson(bytes), "schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure");
  qualificationObject(data.operation, "operationId,workEndEpochMs,cleanupEndEpochMs");
  qualificationObject(data.candidate, "candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256");
  qualificationObject(data.fixture, "testId,guestMachineId,guestHostname,guestEntrySha256");
  const input = data as unknown as Input;
  const fundedBytes = qualificationRead(qualificationRoot + "/funded-operation.json", 65536, true);
  const funded = qualificationJson(fundedBytes) as Record<string, unknown>;
  if (!funded || typeof funded !== "object" || funded.schemaVersion !== 2 ||
      Object.keys(input.operation).some(key => funded[key] !== input.operation[key as keyof Input["operation"]])) qualificationHeld();
  const operation = Object.freeze({ ...input.operation, operationSha256: qualificationSha(fundedBytes) });
  const clock = new QualificationClock(operation, { issuedEpochMs: funded.issuedEpochMs as number, issuedMonotonicNs: funded.issuedMonotonicNs as string });
  if (data.schemaVersion !== 1 || !uuid.test(input.workerId) || !uuid.test(input.providerId) || !uuid.test(input.fixture.testId) ||
      new Set([input.fixture.testId, input.workerId, input.providerId]).size !== 3 ||
      !/^[a-f0-9]{32}$/.test(input.fixture.guestMachineId) || input.fixture.guestHostname !== "ordinary-test-" + input.fixture.testId) qualificationHeld();
  parseSystemBusInfrastructure(input.systemBusInfrastructure); revalidate(input, bytes, clock);
  return { input, bytes, clock };
}
function revalidate(input: Input, bytes: Buffer, clock: QualificationClock): void {
  clock.remaining(); assertHostedActivationOperator();
  if (!qualificationRead(qualificationRoot + "/input.json", 65536, true).equals(bytes) ||
      qualificationSha(qualificationRead(qualificationRoot + "/funded-operation.json", 65536, true)) !== clock.operation.operationSha256 ||
      readFileSync("/etc/machine-id", "utf8").trim() !== input.fixture.guestMachineId ||
      readFileSync("/etc/hostname", "utf8").trim() !== input.fixture.guestHostname ||
      readFileSync("/run/systemd/container", "utf8").trim() !== "systemd-nspawn" || readlinkSync("/proc/1/exe") !== "/usr/lib/systemd/systemd" ||
      qualificationSha(qualificationRead(entry)) !== input.fixture.guestEntrySha256 ||
      entry !== input.candidate.candidateArtifactPath + "/dist/worker-codex/hosted-ordinary-installation-qualification-guest.js") qualificationHeld();
  qualificationCandidate(input.candidate);
  qualificationCopiedCohort(input.candidate);
  for (const [path, hash] of [[qualificationLauncher, input.candidate.launcherSha256], [qualificationCodec, input.candidate.codecSha256],
    [qualificationProfile, input.candidate.profileSha256]]) if (qualificationSha(qualificationRead(path!, 65536, path === qualificationProfile)) !== hash) qualificationHeld();
  const stage = qualificationObject(qualificationJson(qualificationRead("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" +
    qualificationSha(Buffer.from(input.candidate.candidateArtifactPath)) + ".json", 4096, true)), "schemaVersion,runtimeDirectory,runtimeSha,runtimeManifestSha256");
  if (stage.schemaVersion !== 1 || stage.runtimeDirectory !== input.candidate.candidateArtifactPath || stage.runtimeSha !== input.candidate.runtimeSha ||
      stage.runtimeManifestSha256 !== input.candidate.runtimeManifestSha256) qualificationHeld();
  clock.remaining();
}
function baseReceipt(input: Input, bytes: Buffer, clock: QualificationClock) {
  return { schemaVersion: 1, operationSha256: clock.operation.operationSha256, inputSha256: qualificationSha(bytes),
    sourceScopeSha256: input.candidate.sourceScopeSha256, launcherSha256: input.candidate.launcherSha256,
    codecSha256: input.candidate.codecSha256, profileSha256: input.candidate.profileSha256 };
}
async function coordinator(): Promise<void> {
  const { input, bytes, clock } = readInput();
  const profile = verifyPinnedFdCollectorProfile({ path: qualificationProfile, sha256: input.candidate.profileSha256 }, () => clock.remaining());
  const boot = clock.collect(() => collectUnitShow(qualificationBootUnit));
  if (boot.MainPID !== String(process.pid) || boot.ControlGroup !== "/system.slice/" + qualificationBootUnit ||
      collectProcessCgroup(String(process.pid)) !== "0::" + boot.ControlGroup || process.execPath !== profile.node.path ||
      !readFileSync("/proc/self/cmdline").equals(Buffer.from([profile.node.path, entry, "coordinator"].join("\0") + "\0")) ||
      !qualificationRead("/etc/systemd/system/" + qualificationBootUnit).equals(qualificationBootRecipe(profile.node.path, entry))) qualificationHeld();
  const workerUnit = `subscription-runtime-hosted-${input.workerId}.service`, argv = [profile.node.path, entry, "worker"];
  qualificationCreate(qualificationRoot + "/output/worker-intent.json", qualificationBytes({ operationSha256: clock.operation.operationSha256, unit: workerUnit }));
  revalidate(input, bytes, clock);
  let owned: QualificationChild | undefined;
  try {
    const launch = trustedOrdinaryQualificationWorkerLaunch(input.workerId, clock.remaining(),
      Math.min(30_000, clock.operation.cleanupEndEpochMs - clock.operation.workEndEpochMs)); clock.remaining();
    const child = spawn(launch.command, launch.args,
      { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    owned = new QualificationChild(child, workerUnit, clock, qualificationRoot + "/output/worker");
    owned.admitProxy(); owned.endInput();
    await owned.bind(profile.node.path, argv, trustedCustodySystemdRunExecutable); await owned.wait(); const worker = owned.closeUnit();
    revalidate(input, bytes, clock);
    const providerBytes = qualificationRead(qualificationRoot + "/output/provider.json", 65536, true);
    const provider = qualificationObject(qualificationJson(providerBytes), "schemaVersion,operationSha256,inputSha256,sourceScopeSha256,launcherSha256,codecSha256,profileSha256,supervisor,provider,stdoutSha256,stderrSha256,activationGeneration");
    if (Object.entries(baseReceipt(input, bytes, clock)).some(([key, value]) => provider[key] !== value) ||
        !provider.supervisor || !provider.provider || !Number.isSafeInteger(provider.activationGeneration)) qualificationHeld();
    qualificationCreate(qualificationRoot + "/output/coordinator.json", qualificationBytes({ ...baseReceipt(input, bytes, clock), worker,
      providerReceiptSha256: qualificationSha(providerBytes) }));
    revalidate(input, bytes, clock);
    // Exact verified guest only. This acknowledged poweroff is not outer closure.
    const result = spawnSync("/usr/bin/systemctl", ["poweroff", "--no-block"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"], timeout: Math.min(5000, clock.remaining()), maxBuffer: 4096 });
    clock.remaining(); if (result.error || result.status !== 0 || result.signal !== null) qualificationHeld();
  } catch (error) { try { await owned?.settleFailed(); } catch { /* Whole outer owner retains this failed guest. */ } throw error; }
}
async function worker(): Promise<void> {
  const { input, bytes, clock } = readInput();
  workerPhase = WorkerQualificationPhase.Descriptors; assertHostedProcessDescriptors();
  workerPhase = WorkerQualificationPhase.Profile;
  const profile = verifyPinnedFdCollectorProfile({ path: qualificationProfile, sha256: input.candidate.profileSha256 }, () => clock.remaining());
  workerPhase = WorkerQualificationPhase.SystemBus;
  verifySystemBusInfrastructure(input.systemBusInfrastructure, () => clock.remaining());
  workerPhase = WorkerQualificationPhase.Identity;
  const workerUnit = `subscription-runtime-hosted-${input.workerId}.service`, birth = collectProcessBirth(String(process.pid));
  const current = clock.collect(() => collectUnitShow(workerUnit)), invocationId = clock.collect(() => collectUnitInvocation(workerUnit));
  const workerGroup = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${workerUnit}`;
  if (current.MainPID !== String(process.pid) || current.ControlGroup !== workerGroup || collectProcessCgroup(String(process.pid)) !== `0::${workerGroup}` ||
      !readFileSync("/proc/self/cmdline").equals(Buffer.from([profile.node.path, entry, "worker"].join("\0") + "\0"))) qualificationHeld();
  const jobId = "ordinary-qualification-" + input.providerId, jobRootDir = "/srv/workers/jobs/" + jobId, workspacePath = jobRootDir + "/workspace";
  const launch = { command: profile.node.path, args: [input.candidate.candidateArtifactPath + "/dist/worker-codex/codex-goal-cli.js"], cwd: workspacePath };
  workerPhase = WorkerQualificationPhase.Inventory;
  const inventory = collectOrdinaryInstallationDraft({ supervisorUnit: workerUnit,
    supervisor: { birth, executable: { path: profile.node.path, sha256: profile.node.sha256 }, bootstrap: { path: entry, sha256: input.fixture.guestEntrySha256 },
      operationId: input.operation.operationId, workEndEpochMs: input.operation.workEndEpochMs, cleanupEndEpochMs: input.operation.cleanupEndEpochMs },
    ordinaryCreators: [{ creatorId: jobId, jobId, jobRootDir, workspacePath, launch }], disabledCreators: [], runtimeLaunch: launch,
    systemBusInfrastructure: input.systemBusInfrastructure, collectorProfile: { path: qualificationProfile, sha256: input.candidate.profileSha256 } });
  workerPhase = WorkerQualificationPhase.Revalidation; revalidate(input, bytes, clock);
  workerPhase = WorkerQualificationPhase.InventoryPublication; publishReadonlyInventory(qualificationBytes(inventory));
  workerPhase = WorkerQualificationPhase.Installation;
  const store = new HostedInstallationActivationStore(), installed = store.install();
  workerPhase = WorkerQualificationPhase.InstallationCheck;
  if (installed.phase !== HostedActivationPhase.Closed) qualificationHeld(); revalidate(input, bytes, clock);
  const providerUnit = `subscription-runtime-hosted-${input.providerId}.service`;
  workerPhase = WorkerQualificationPhase.ProviderIntent;
  qualificationCreate(qualificationRoot + "/output/provider-intent.json", qualificationBytes({ operationSha256: clock.operation.operationSha256, unit: providerUnit }));
  workerPhase = WorkerQualificationPhase.Provider; clock.remaining();
  const payload = [profile.node.path, input.candidate.candidateArtifactPath + "/dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js", "--fd-ready-v1"];
  const request = { operation: "provider", unit: providerUnit, jobId, payload, readonlyPaths: [] };
  const custody: { owned?: QualificationChild } = {};
  let guard: ReturnType<typeof hostedFdLaunch> | undefined;
  try {
    const child = spawnHostedFdChild(profile.node.path, [qualificationLauncher, "provider", JSON.stringify(request)],
      { cwd: workspacePath, detached: false }, providerUnit, HostedFdLaunchKind.Provider, {
        assertOriginalWork: () => { clock.remaining(); },
        retainOriginalChild: child => {
          custody.owned = new QualificationChild(child, providerUnit, clock, qualificationRoot + "/output/provider-child");
          custody.owned.admitProxy();
        },
      });
    const owned = custody.owned; if (!owned) qualificationHeld();
    guard = hostedFdLaunch(child); const activeGuard = guard, stdout: Buffer[] = []; let outputSize = 0, outputEnded = false, outputFailed = false;
    child.stdout!.on("data", (chunk: Buffer) => { const data = Buffer.from(chunk); outputSize += data.length;
      if (outputSize > 4096) { outputFailed = true; activeGuard.invalidate(); } else stdout.push(data); });
    child.stdout!.once("end", () => { outputEnded = true; }); child.stdout!.once("error", () => { outputFailed = true; });
    await guard.observe(); clock.remaining();
    const serviceArgv = ["/usr/bin/unshare", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--", "/usr/bin/unshare", "--user", "--map-user=65532", "--map-group=65532", "--keep-caps", "--",
      "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--",
      profile.node.path, "/opt/subscription-runtime/managed-launcher/payload-guard.mjs", "--job-id", jobId, "--", ...payload];
    await owned.bind("/usr/bin/unshare", serviceArgv, profile.node.path);
    const challenge = qualificationSha(qualificationBytes({ operationSha256: clock.operation.operationSha256, inputSha256: qualificationSha(bytes), providerId: input.providerId }));
    const frame = qualificationBytes({ schemaVersion: 1, command: profile.node.path, args: ["--input-type=commonjs", "-e", echoProgram, challenge], cwd: workspacePath, env: {} });
    withHostedActivationFence(fence => activeGuard.release(fence, frame, true, () => {
      revalidate(input, bytes, clock); verifyPinnedFdCollectorProfile({ path: qualificationProfile, sha256: input.candidate.profileSha256 }, () => clock.remaining());
      verifySystemBusInfrastructure(input.systemBusInfrastructure, () => clock.remaining());
      if (collectUnitInvocation(workerUnit) !== invocationId || collectUnitShow(workerUnit).MainPID !== String(process.pid) ||
          collectProcessBirth(String(process.pid)) !== birth || store.read().phase !== HostedActivationPhase.Closed) qualificationHeld();
      clock.remaining();
    }));
    await owned.wait(); guard.assertOriginalZeroWaitClosed(); const provider = owned.closeUnit();
    clock.remaining(); const actual = Buffer.concat(stdout), expected = Buffer.from(challenge + "\n");
    if (outputFailed || !outputEnded || !actual.equals(expected) || owned.stderr().length) qualificationHeld();
    revalidate(input, bytes, clock); const activation = store.read();
    if (activation.phase !== HostedActivationPhase.Closed || activation.generation !== installed.generation) qualificationHeld();
    qualificationCreate(qualificationRoot + "/output/provider.json", qualificationBytes({ ...baseReceipt(input, bytes, clock),
      supervisor: { unit: workerUnit, birth, invocationId, controlGroup: workerGroup, bootId: collectBootId() }, provider,
      stdoutSha256: qualificationSha(actual), stderrSha256: qualificationSha(owned.stderr()), activationGeneration: activation.generation }));
    clock.remaining();
  } catch (error) { guard?.invalidate(); try { await custody.owned?.settleFailed(); } catch { /* Original raw wait/EOF listeners remain attached. */ } throw error; }
}
if (process.argv[1] === entry) {
  if (process.argv.length !== 3 || !["coordinator", "worker"].includes(process.argv[2]!)) qualificationHeld();
  void (process.argv[2] === "coordinator" ? coordinator() : worker()).then(() => { process.exitCode = 0; }, (error: unknown) => { if (process.argv[2] === "worker") retainWorkerFailure(error); process.exitCode = 70; });
}
