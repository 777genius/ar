import { validatePreparedOrdinaryLauncherQualification, runOrdinaryLauncherPairQualification, type OrdinaryLauncherCandidate, type OrdinaryLauncherQualificationFixture } from "./hosted-ordinary-installation-qualification";
import { OrdinaryLauncherPublication, assertOrdinaryCollectorProfileUpgrade, type OrdinaryCopiedCohort, type OrdinaryPriorCollectorProfile } from "./hosted-ordinary-installation-launcher";
import { resolveStoredProjectStartPlan } from "./stored-start-planning";
import { readTrustedFragment } from "./hosted-readonly-host-kernel";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, readdirSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostedActivationOperator, verifySystemBusInfrastructure } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedInventoryV5, type HostedInventoryCreator, type HostedInventoryFile, type HostedInventorySupervisor, type HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import { readSystemBusInfrastructureField, readFdCollectorProfileField, parseFdCollectorProfile, type FdCollectorProfilePin } from "@vioxen/subscription-runtime/core";
import { verifyPinnedFdCollectorProfile, observeHostedFdProcess } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { collectBootId, collectProcessBirth, collectSelfCgroup, collectUnitInvocation, collectUnitShow, collectNonDelegatedUnitShow, collectJobs } from "./hosted-readonly-linux-collector";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "./hosted-installation-activation";
import { ordinaryInstallationCollectorFailure, collectOrdinaryInstallationDraft } from "./hosted-ordinary-installation-census";
import { bindOriginalOrdinaryInstallationSupervisor, retainOriginalOrdinaryInstallationOperation, retainOriginalOrdinaryInstallationOperator, retainOriginalOrdinaryInstallationClosed, assertOrdinaryInstallationOriginalClose, type OrdinaryInstallationOperation, type OriginalOrdinaryInstallationClosed } from "./hosted-ordinary-installation-owned";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, publishReadonlyInventory, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { runHostedRuntimeForeground } from "./hosted-readonly-foreground";
import { hostedForegroundExitCode } from "./hosted-foreground-result";
import { trustedOrdinaryInstallationSupervisorLaunch, trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import { withScopedCollectionBudget, requestScopedManagerEffect } from "./hosted-readonly-linux-collector";

export type OrdinaryInstallationPacket = Readonly<{
  schemaVersion: 1; operationId: string; hostId: string; bootId: string; issuedEpochMs: number;
  workEndEpochMs: number; cleanupEndEpochMs: number; issuedMonotonicNs: string;
  node: HostedInventoryFile; bootstrap: HostedInventoryFile;
  runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string;
  creator: HostedInventoryCreator; collectorProfile: FdCollectorProfilePin;
  systemBusInfrastructure: Readonly<Record<string, unknown>>;
  copiedLauncher: HostedInventoryFile; copiedCodec: HostedInventoryFile;
}>;
export type QualifiedPairInstallationRequest = Readonly<{ schemaVersion: 1; packet: OrdinaryInstallationPacket;
  candidate: OrdinaryLauncherCandidate; preparedFixture: OrdinaryLauncherQualificationFixture; copiedCohort: OrdinaryCopiedCohort;
  preparedCollectorProfile: HostedInventoryFile; priorCollectorProfile: OrdinaryPriorCollectorProfile }>;
type FundedQualifiedPacket = Omit<OrdinaryInstallationPacket, "schemaVersion"> & Omit<QualifiedPairInstallationRequest, "schemaVersion" | "packet"> &
  Readonly<{ schemaVersion: 2; qualificationRequestSha256: string }>;
const packetKeys = "bootId,bootstrap,collectorProfile,copiedCodec,copiedLauncher,creator,hostId,issuedEpochMs,issuedMonotonicNs,operationId,runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion,systemBusInfrastructure,workEndEpochMs,cleanupEndEpochMs";
const qualificationKeys = "candidate,copiedCohort,preparedCollectorProfile,preparedFixture,priorCollectorProfile,qualificationRequestSha256";
const copiedNames = ["managed-launcher/launch.mjs", "managed-launcher/payload-guard.mjs", "managed-launcher/profiles.mjs", "host-jobs/storage-policy.mjs", "managed-launcher/hosted-host-policy.mjs", "managed-launcher/storage-pressure-guard.mjs"] as const;
function closed(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) denied();
}
const operationRoot = join(readonlySupervisorRoot, "ordinary-installations");
const bootstrapPath = fileURLToPath(new URL("./hosted-ordinary-installation-bootstrap.js", import.meta.url));
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function denied(): never { throw new Error("hosted_ordinary_installation_held"); }
function packetPath(id: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) denied(); return join(operationRoot, id + ".json");
}
function checkedPacket(input: OrdinaryInstallationPacket | FundedQualifiedPacket): OrdinaryInstallationPacket {
  if (input.schemaVersion === 2) {
    closed(input, packetKeys + "," + qualificationKeys);
    if (!/^[a-f0-9]{64}$/.test(input.qualificationRequestSha256)) denied();
    const projected = Object.fromEntries(packetKeys.split(",").map(key => [key, key === "schemaVersion" ? 1 : input[key as keyof typeof input]]));
    return checkedPacket(projected as OrdinaryInstallationPacket);
  }
  assertHostedActivationOperator(); packetPath(input.operationId);
  if (Object.keys(input).sort().join(",") !== packetKeys.split(",").sort().join(",") ||
      input.runtimeDirectory !== fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "") || input.schemaVersion !== 1 || readFileSync("/etc/machine-id", "utf8").trim() !== input.hostId || collectBootId() !== input.bootId ||
      !Number.isSafeInteger(input.issuedEpochMs) || !Number.isSafeInteger(input.workEndEpochMs) || !Number.isSafeInteger(input.cleanupEndEpochMs) ||
      input.issuedEpochMs >= input.workEndEpochMs || input.workEndEpochMs >= input.cleanupEndEpochMs || !/^[0-9]{1,30}$/.test(input.issuedMonotonicNs) ||
      input.node.path !== process.execPath || input.bootstrap.path !== bootstrapPath ||
      !/^[a-f0-9]{40}$/.test(input.runtimeSha) || !/^[a-f0-9]{64}$/.test(input.runtimeManifestSha256)) denied();
  const packet = Object.freeze(JSON.parse(JSON.stringify(input)) as OrdinaryInstallationPacket);
  budget(packet, false); return packet;
}
function budget(packet: OrdinaryInstallationPacket, cleanup: boolean): number {
  const end = cleanup ? packet.cleanupEndEpochMs : packet.workEndEpochMs, now = Date.now();
  const elapsedMs = Number((process.hrtime.bigint() - BigInt(packet.issuedMonotonicNs)) / 1_000_000n);
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || now < packet.issuedEpochMs || now < packet.issuedEpochMs + elapsedMs - 1000) denied();
  const ms = Math.min(end - now, end - packet.issuedEpochMs - elapsedMs); if (ms < 1) denied(); return Math.floor(ms);
}
function collectOriginal<T>(packet: OrdinaryInstallationPacket, cleanup: boolean, action: () => T): T {
  const result = withScopedCollectionBudget(budget(packet, cleanup), action); budget(packet, cleanup); return result;
}
function protectedPin(pin: HostedInventoryFile): void {
  const bytes = readTrustedFragment(pin.path, 256 * 1024 * 1024);
  if (!bytes || hash(bytes) !== pin.sha256) denied();
}
function admitSourcePacket(packet: OrdinaryInstallationPacket): void {
  budget(packet, false); protectedPin(packet.node); protectedPin(packet.bootstrap);
  if (packet.copiedLauncher.path !== "/opt/subscription-runtime/managed-launcher/launch.mjs" ||
      packet.copiedCodec.path !== "/opt/subscription-runtime/managed-launcher/host-inventory-codec.cjs") denied();
  const stage = readHostedPrivateBytes("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + hash(Buffer.from(packet.runtimeDirectory)) + ".json", 4096);
  if (!stage) denied();
  const value = JSON.parse(stage.toString("utf8")); closed(value, "schemaVersion,runtimeDirectory,runtimeSha,runtimeManifestSha256");
  if (value.schemaVersion !== 1 || value.runtimeDirectory !== packet.runtimeDirectory || value.runtimeSha !== packet.runtimeSha || value.runtimeManifestSha256 !== packet.runtimeManifestSha256) denied();
  if (packet.creator.launch.command !== packet.node.path || packet.creator.launch.args[0] !== join(packet.runtimeDirectory, "dist/worker-codex/codex-goal-cli.js") ||
      packet.creator.launch.args[1] !== "tool" || packet.creator.launch.args[2] !== "codex_goal_project_start" || packet.creator.launch.args.length !== 6 ||
      packet.creator.launch.args[3] !== "--args-json" || packet.creator.launch.args[5] !== "--json") denied();
  const plan = resolveStoredProjectStartPlan(packet.creator.launch.args[4]!, packet.creator.workspacePath);
  if (plan.jobId !== packet.creator.jobId || plan.jobRoot !== packet.creator.jobRootDir || plan.workspace !== packet.creator.workspacePath || packet.creator.launch.cwd !== plan.workspace) denied();
  budget(packet, false);
}
function admitInstalledPair(packet: OrdinaryInstallationPacket): void {
  admitSourcePacket(packet); protectedPin(packet.copiedLauncher); protectedPin(packet.copiedCodec);
  const profile = verifyPinnedFdCollectorProfile(packet.collectorProfile, () => budget(packet, false));
  const policyPath = "/opt/subscription-runtime/managed-launcher/hosted-host-policy.mjs";
  const policy = { path: policyPath, sha256: hash(readTrustedFragment(policyPath)) };
  protectedPin({ path: join(packet.runtimeDirectory, "host-integration/managed-launcher/hosted-host-policy.mjs"), sha256: policy.sha256 });
  for (const pin of [packet.copiedLauncher, packet.copiedCodec, policy]) if (!profile.bootstraps.some(p => p.path === pin.path && p.sha256 === pin.sha256)) denied();
  const bus = readSystemBusInfrastructureField({ schemaVersion: 5, systemBusInfrastructure: packet.systemBusInfrastructure });
  if (!bus) denied(); verifySystemBusInfrastructure(bus, () => budget(packet, false));
  budget(packet, false);
}
function assertCopiedCohort(cohort: OrdinaryCopiedCohort): void {
  closed(cohort, copiedNames.join(","));
  for (const name of copiedNames) {
    const identity = cohort[name]; closed(identity, "sha256,dev,ino,ctimeMs,mtimeMs");
    const path = "/opt/subscription-runtime/" + name, before = lstatSync(path), bytes = readTrustedFragment(path), after = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || hash(bytes) !== identity.sha256 ||
        before.dev !== identity.dev || before.ino !== identity.ino || before.ctimeMs !== identity.ctimeMs || before.mtimeMs !== identity.mtimeMs ||
        after.dev !== before.dev || after.ino !== before.ino || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) denied();
  }
}
function admitQualifiedPairRequestCold(operationId: string): { request: QualifiedPairInstallationRequest; bytes: Buffer } {
  const bytes = readHostedPrivateBytes(packetPath(operationId).replace(/\.json$/, ".request.json"), 64 * 1024); if (!bytes) denied();
  const request = JSON.parse(bytes.toString("utf8")) as QualifiedPairInstallationRequest;
  closed(request, "schemaVersion,packet,candidate,preparedFixture,copiedCohort,preparedCollectorProfile,priorCollectorProfile");
  if (request.schemaVersion !== 1 || request.packet.schemaVersion !== 1 || request.packet.operationId !== operationId) denied();
  const packet = checkedPacket(request.packet); admitSourcePacket(packet);
  const candidate = request.candidate;
  closed(candidate, "candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256");
  if (candidate.candidateArtifactPath !== packet.runtimeDirectory || candidate.runtimeSha !== packet.runtimeSha || candidate.runtimeManifestSha256 !== packet.runtimeManifestSha256 ||
      candidate.launcherSha256 !== packet.copiedLauncher.sha256 || candidate.codecSha256 !== packet.copiedCodec.sha256 || candidate.profileSha256 !== packet.collectorProfile.sha256 || request.preparedCollectorProfile.sha256 !== candidate.profileSha256 ||
      !/^[a-f0-9]{64}$/.test(candidate.sourceScopeSha256)) denied();
  protectedPin({ path: join(packet.runtimeDirectory, "host-integration/managed-launcher/launch.mjs"), sha256: candidate.launcherSha256 });
  protectedPin({ path: join(packet.runtimeDirectory, "host-integration/managed-launcher/host-inventory-codec.cjs"), sha256: candidate.codecSha256 });
  assertCopiedCohort(request.copiedCohort);
  assertOrdinaryCollectorProfileUpgrade(operationId, request.preparedCollectorProfile, request.priorCollectorProfile, candidate.candidateArtifactPath, candidate.launcherSha256, candidate.codecSha256);
  const profileBytes = readHostedPrivateBytes(request.preparedCollectorProfile.path, 64 * 1024); if (!profileBytes) denied();
  const profile = parseFdCollectorProfile(JSON.parse(profileBytes.toString("utf8")));
  if (profile.node.path !== packet.node.path || profile.node.sha256 !== packet.node.sha256) denied();
  for (const executable of [profile.ss, profile.node, ...profile.wrappers]) for (const pin of executable.elfFiles) { protectedPin(pin); budget(packet, false); }
  validatePreparedOrdinaryLauncherQualification(candidate, request.preparedFixture, packet);
  const existing = readHostedPrivateBytes(join(readonlySupervisorRoot, "host-installation.json"), 64 * 1024);
  if (existing) {
    const { installation, activation } = readHostedInstallationActivation();
    if (activation.phase !== HostedActivationPhase.Closed || installation.hostId !== packet.hostId || installation.runtimeDirectory !== packet.runtimeDirectory || installation.runtimeSha !== packet.runtimeSha || installation.runtimeManifestSha256 !== packet.runtimeManifestSha256) denied();
    const installedInventory = readHostedPrivateBytes(join(readonlySupervisorRoot, "readonly-inventory.json"), 4 * 1024 * 1024);
    if (!installedInventory) denied();
    const prior = parseHostedInventoryV5(JSON.parse(installedInventory.toString("utf8")));
    if (prior.supervisor.operationId !== packet.operationId || prior.collectorProfile.sha256 !== packet.collectorProfile.sha256 || prior.supervisor.bootstrap.sha256 !== packet.bootstrap.sha256) denied();
  }
  if (!existing) {
    for (const name of ["host-activation.json", "host-activation.next", "ordinary-origins.json", "ordinary-origins.next", "readonly-enrollment.json", "readonly-epoch.json", "readonly-epoch.next"])
      if (readHostedPrivateBytes(join(readonlySupervisorRoot, name), 4 * 1024 * 1024)) denied();
    for (const name of ["ordinary-origins", "ordinary-starts", "codex-readonly-custody", "codex-readonly-revoked"]) {
      const path = join(readonlySupervisorRoot, name), stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) || readdirSync(path).length) denied();
    }
  }
  budget(packet, false); return { request: Object.freeze(request), bytes };
}
export async function runQualifiedPairInstallationOperator(operationId: string) {
  const { request, bytes } = admitQualifiedPairRequestCold(operationId), packet = checkedPacket(request.packet);
  const funded: FundedQualifiedPacket = { ...packet, schemaVersion: 2, qualificationRequestSha256: hash(bytes), candidate: request.candidate,
    preparedFixture: request.preparedFixture, copiedCohort: request.copiedCohort, preparedCollectorProfile: request.preparedCollectorProfile, priorCollectorProfile: request.priorCollectorProfile };
  assertCopiedCohort(request.copiedCohort);
  assertOrdinaryCollectorProfileUpgrade(operationId, request.preparedCollectorProfile, request.priorCollectorProfile,
    request.candidate.candidateArtifactPath, request.candidate.launcherSha256, request.candidate.codecSha256);
  const operation = fundOriginalOperation(funded);
  const pair = await runOrdinaryLauncherPairQualification(operation, request.candidate, request.preparedFixture);
  const publication = new OrdinaryLauncherPublication(operation, pair, request.copiedCohort, request.preparedCollectorProfile, request.priorCollectorProfile);
  publication.publish(); admitInstalledPair(packet);
  if (!readHostedPrivateBytes(packet.collectorProfile.path, 64 * 1024)?.equals(readHostedPrivateBytes(request.preparedCollectorProfile.path, 64 * 1024)!)) denied();
  publication.consumeBeforeOriginalSupervisorBirth();
  return runFundedInstallationSupervisor(packet, operation);
}
/** Administrative Root issue. The original funded record precedes supervisor
 * birth. It cannot recreate a consumed operation or certify its own terminal. */
export function runOrdinaryInstallationOperator(operationId: string) {
  return runQualifiedPairInstallationOperator(operationId);
}
function fundOriginalOperation(packet: OrdinaryInstallationPacket | FundedQualifiedPacket): OrdinaryInstallationOperation {
  const path = packetPath(packet.operationId);
  if (readHostedPrivateBytes(path, 64 * 1024)) throw new Error("hosted_ordinary_installation_consumed");
  const operationBytes = Buffer.from(JSON.stringify(packet) + "\n");
  if (operationBytes.length > 64 * 1024) denied();
  createReadonlyPrivateRecord(path, operationBytes);
  const directory = join(operationRoot, packet.operationId); mkdirSync(directory, { mode: 0o700 });
  createReadonlyPrivateRecord(join(directory, "operation.json"), operationBytes);
  const operation: OrdinaryInstallationOperation = Object.freeze({ operationId: packet.operationId, operationSha256: hash(operationBytes), workEndEpochMs: packet.workEndEpochMs, cleanupEndEpochMs: packet.cleanupEndEpochMs });
  retainOriginalOrdinaryInstallationOperation(operation, operationBytes);
  return operation;
}
async function runFundedInstallationSupervisor(packet: OrdinaryInstallationPacket, operation: OrdinaryInstallationOperation): Promise<Readonly<{ sourceExitCode: number; settled: true; closure: OriginalOrdinaryInstallationClosed }>> {
  budget(packet, false);
  const unit = `subscription-runtime-installation-${packet.operationId}.service`;
  const launch = trustedOrdinaryInstallationSupervisorLaunch(packet.operationId, budget(packet, false), budget(packet, true));
  budget(packet, false);
  const child = spawn(launch.command, launch.args, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  const closure = retainOperatorChild(child, packet, unit, operation);
  const wait = await closure;
  budget(packet, true);
  const session = readHostedPrivateBytes(join(operationRoot, packet.operationId + ".supervisor.json"), 4096);
  if (!session || wait.signal !== null) denied();
  const original = JSON.parse(session.toString("utf8"));
  if (JSON.stringify(original) !== JSON.stringify(wait.original)) denied();
  if (original.unit !== unit || original.bootId !== packet.bootId || !/^[a-f0-9]{32}$/.test(original.invocationId) || original.operationId !== packet.operationId) denied();
  const current = collectOriginal(packet, true, () => collectUnitShow(unit));
  if (collectOriginal(packet, true, () => collectUnitInvocation(unit)) !== original.invocationId || current.ControlGroup !== original.controlGroup || current.MainPID !== "0" || collectOriginal(packet, true, collectJobs).includes(unit)) denied();
  assertOriginalSupervisorEmpty(original.controlGroup, unit, packet);
  const terminal = readHostedPrivateBytes(join(operationRoot, packet.operationId + ".closed.json"), 4096);
  if (!terminal || JSON.parse(terminal.toString("utf8")).sourceExitCode !== wait.code || wait.code !== 0) denied();
  return Object.freeze({ sourceExitCode: wait.code, settled: true, closure: collectOriginal(packet, true, () => retainOriginalOrdinaryInstallationClosed(operation)) });
}
function retainOperatorChild(child: ChildProcess, packet: OrdinaryInstallationPacket, unit: string, operation: OrdinaryInstallationOperation) {
  const directory = join(operationRoot, packet.operationId);
  return new Promise<{ code: number; signal: NodeJS.Signals | null; original: Record<string, unknown> }>((resolve, reject) => {
    // These listeners and their retained raw buffers/log cells belong to this
    // original child, before any fallible descriptor acquisition or observation.
    const fds: { fd: number; closed: boolean; failed: boolean }[] = [], raw: Buffer[][] = [[], []];
    let original: Record<string, unknown> | undefined, readyText = "", proxyBirth: string | null = null;
    let stdoutEnded = false, stderrEnded = false, failed = false, written = 0, stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bind = () => {
      if (original) return;
      collectOriginal(packet, true, () => {
        const current = collectNonDelegatedUnitShow(unit), invocationId = collectUnitInvocation(unit);
        if (collectBootId() !== packet.bootId || current.Id !== unit || !/^[1-9][0-9]*$/.test(current.MainPID ?? "") || !["no", "false"].includes(current.Delegate ?? "") ||
            current.ControlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`) denied();
        const facts = observeHostedFdProcess(Number(current.MainPID));
        if (facts.exe !== packet.node.path || facts.argv.join("\0") !== [packet.node.path, bootstrapPath, "--operation", packet.operationId].join("\0")) denied();
        budget(packet, true); bindOriginalOrdinaryInstallationSupervisor(operation);
        original = { operationId: packet.operationId, unit, bootId: packet.bootId, birth: facts.birth, invocationId, controlGroup: current.ControlGroup };
      });
    };
    const closeLogs = (sync: boolean) => {
      for (const cell of fds) {
        if (cell.closed) continue;
        try { if (sync) { budget(packet, true); fsyncSync(cell.fd); } } catch { cell.failed = true; failed = true; }
        try { closeSync(cell.fd); cell.closed = true; } catch { cell.failed = true; failed = true; /* The exact FD stays retained as cleanup debt. */ }
      }
    };
    const fail = () => {
      failed = true;
      if (stopping) return;
      stopping = true;
      try {
        try {
          bind();
          collectOriginal(packet, true, () => {
            const current = collectNonDelegatedUnitShow(unit);
            if (!original || collectBootId() !== packet.bootId || collectUnitInvocation(unit) !== original.invocationId || current.ControlGroup !== original.controlGroup ||
                !/^[1-9][0-9]*$/.test(current.MainPID ?? "") || collectProcessBirth(current.MainPID!) !== original.birth) denied();
            budget(packet, true); requestScopedManagerEffect(["stop", "--no-block", "--", unit], budget(packet, true));
          });
        } catch { /* Unbound/replaced/expired original unit stays HELD. */ }
        if (!proxyBirth || child.exitCode !== null || child.signalCode !== null || !child.pid || collectProcessBirth(String(child.pid)) !== proxyBirth) return;
        const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[1] !== String(process.pid) || readlinkSync(`/proc/${child.pid}/exe`) !== trustedCustodySystemdRunExecutable) return;
        budget(packet, true); child.kill("SIGTERM");
      } catch { /* Expiry or lost original proxy custody remains HELD. */ }
      finally { stopping = false; }
    };
    child.once("error", fail); child.stdin?.once("error", fail);
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      if (!stream) { failed = true; continue; }
      stream.on("data", (bytes: Buffer) => {
        // Keep bounded actual bytes even after authority expires. Expiry cannot
        // turn raw EOF/close into success or license a late filesystem write.
        if ((written += bytes.length) <= 64 * 1024 * 1024 && raw[index]!.length < 4096) raw[index]!.push(Buffer.from(bytes));
        else { fail(); return; }
        try { budget(packet, true);
          if (index === 0 && !original && !failed) {
            readyText += bytes.toString("utf8");
            if (readyText.length > 4096) denied();
            if (readyText.includes("ordinary_installation_supervisor_ready\n")) {
              bind(); budget(packet, true);
              createReadonlyPrivateRecord(join(directory, "original-supervisor.json"), Buffer.from(JSON.stringify(original) + "\n"));
            }
          }
          const cell = fds[index]; if (!cell || cell.closed || cell.failed) denied(); writeFileSync(cell.fd, bytes); } catch { fail(); }
      });
      stream.once("error", fail); stream.once("end", () => { if (index === 0) stdoutEnded = true; else stderrEnded = true; });
    }
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      closeLogs(true);
      try { budget(packet, true); createReadonlyPrivateRecord(join(directory, "wait.json"), Buffer.from(JSON.stringify({ unit, code, signal, stdoutEnded, stderrEnded, failed }) + "\n")); }
      catch { failed = true; }
      if (failed || !original || !stdoutEnded || !stderrEnded || !child.stdin!.writableFinished || code === null) { reject(new Error("hosted_ordinary_installation_held")); return; }
      resolve({ code, signal, original: original! });
    });
    try {
      retainOriginalOrdinaryInstallationOperator(operation, child);
      timer = setTimeout(fail, budget(packet, false));
      if (!child.stdout || !child.stderr || !child.stdin) denied();
      if (child.pid) proxyBirth = collectProcessBirth(String(child.pid));
      for (const name of ["stdout", "stderr"]) {
        budget(packet, false);
        const fd = openSync(join(directory, name + ".log"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        fds.push({ fd, closed: false, failed: false });
      }
      budget(packet, false); child.stdin.end();
    } catch { closeLogs(false); fail(); }
  });
}
/** Only the original fixed issuer reservation selects this path. Every node
 * positively reports zero members/population; absent groups remain HELD. */
function assertOriginalSupervisorEmpty(group: string, unit: string, packet: OrdinaryInstallationPacket): void {
  if (group !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`) denied();
  let nodes = 0;
  const walk = (path: string): void => {
    budget(packet, true); if (++nodes > 256) denied();
    const before = lstatSync(path), fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd); if (!stat.isDirectory() || stat.uid !== 0 || stat.dev !== before.dev || stat.ino !== before.ino) denied();
      const anchored = `/proc/self/fd/${fd}`, events = readFileSync(anchored + "/cgroup.events", "utf8");
      if (readFileSync(anchored + "/cgroup.procs", "utf8") !== "" || !/^populated 0$/m.test(events) || /^populated 1$/m.test(events)) denied();
      for (const child of readdirSync(anchored, { withFileTypes: true })) if (child.isDirectory()) walk(path + "/" + child.name);
      const current = lstatSync(path); if (current.dev !== stat.dev || current.ino !== stat.ino) denied();
    } finally { closeSync(fd); }
  };
  walk("/sys/fs/cgroup" + group);
}
function retainCollectorFailure(operationId: string, error: unknown): void {
  const failed = ordinaryInstallationCollectorFailure(error);
  if (!failed) return;
  const directory = join(operationRoot, operationId);
  createReadonlyPrivateRecord(join(directory, "collector-stdout.log"), Buffer.from(failed.stdout));
  createReadonlyPrivateRecord(join(directory, "collector-stderr.log"), Buffer.from(failed.stderr));
  createReadonlyPrivateRecord(join(directory, "collector-failure.json"), Buffer.from(JSON.stringify({ operationId, args: failed.args, status: failed.status, signal: failed.signal }) + "\n"));
}
/** One original measured supervisor, all Store operations in this same PID. */
export async function runOrdinaryInstallationSupervisor(operationId: string): Promise<number> {
  assertHostedActivationOperator();
  const bytes = readHostedPrivateBytes(packetPath(operationId), 64 * 1024); if (!bytes) denied();
  const funded = JSON.parse(bytes.toString("utf8")) as FundedQualifiedPacket;
  if (funded.schemaVersion !== 2 || !readHostedPrivateBytes(join(operationRoot, operationId, "operation.json"), 64 * 1024)?.equals(bytes) ||
      !readHostedPrivateBytes(join(operationRoot, operationId, "launcher-consumed.json"), 4096)?.equals(Buffer.from(hash(bytes) + "\n"))) denied();
  const packet = checkedPacket(funded); admitInstalledPair(packet);
  if (!readHostedPrivateBytes(packet.collectorProfile.path, 64 * 1024)?.equals(readHostedPrivateBytes(funded.preparedCollectorProfile.path, 64 * 1024)!)) denied();
  const unit = `subscription-runtime-installation-${operationId}.service`, current = collectOriginal(packet, false, () => collectUnitShow(unit));
  const birth = collectProcessBirth(String(process.pid)), facts = observeHostedFdProcess(process.pid);
  if (current.MainPID !== String(process.pid) || current.Id !== unit || collectSelfCgroup() !== `0::${current.ControlGroup}` ||
      facts.exe !== packet.node.path || facts.argv.join("\0") !== [packet.node.path, bootstrapPath, "--operation", operationId].join("\0") ||
      ["0", "1", "2"].some(fd => !readlinkSync(`/proc/self/fd/${fd}`).startsWith("socket:["))) denied();
  const supervisor: HostedInventorySupervisor = { birth, executable: packet.node, bootstrap: packet.bootstrap,
    operationId, workEndEpochMs: packet.workEndEpochMs, cleanupEndEpochMs: packet.cleanupEndEpochMs };
  createReadonlyPrivateRecord(join(operationRoot, operationId + ".supervisor.json"), Buffer.from(JSON.stringify({ operationId, unit,
    bootId: packet.bootId, birth, invocationId: collectOriginal(packet, false, () => collectUnitInvocation(unit)), controlGroup: current.ControlGroup }) + "\n"));
  process.stdout.write("ordinary_installation_supervisor_ready\n");
  let inventory: HostedInventoryV5;
  try { inventory = collectOrdinaryInstallationDraft({ supervisorUnit: unit, supervisor, ordinaryCreators: [packet.creator], disabledCreators: [],
    runtimeLaunch: packet.creator.launch, systemBusInfrastructure: packet.systemBusInfrastructure, collectorProfile: packet.collectorProfile }); }
  catch (error) { retainCollectorFailure(operationId, error); throw error; }
  parseHostedInventoryV5(inventory); readSystemBusInfrastructureField(inventory as unknown as Record<string, unknown>); readFdCollectorProfileField(inventory as unknown as Record<string, unknown>);
  budget(packet, false); publishReadonlyInventory(Buffer.from(JSON.stringify(inventory) + "\n"));
  const store = new HostedInstallationActivationStore();
  let sourceExitCode = 70;
  try {
    collectOriginal(packet, false, () => store.install()); collectOriginal(packet, false, () => store.enrollOrdinary(packet.creator.creatorId)); collectOriginal(packet, false, () => store.resumeOrdinary());
    budget(packet, false);
    sourceExitCode = hostedForegroundExitCode(await runHostedRuntimeForeground(packet.creator.launch.command, packet.creator.launch.args, packet.creator.launch.cwd, {}));
    if (sourceExitCode !== 0) denied();
    assertOrdinaryInstallationOriginalClose(); budget(packet, true);
    const activation = collectOriginal(packet, true, () => store.finishClosed()); if (activation.phase !== HostedActivationPhase.Closed) denied();
    createReadonlyPrivateRecord(join(operationRoot, operationId + ".closed.json"), Buffer.from(JSON.stringify({ operationId, sourceExitCode, generation: activation.generation }) + "\n"));
    return sourceExitCode;
  } catch (error) {
    retainCollectorFailure(operationId, error);
    createReadonlyPrivateRecord(join(operationRoot, operationId + ".held.json"), Buffer.from(JSON.stringify({ operationId, sourceExitCode, error: error instanceof Error ? error.message : "held" }) + "\n"));
    try { store.closeOrdinaryRuntimeLaunch(); } catch { /* Original evidence remains held. */ }
    throw error;
  }
}
if (process.argv[1] === bootstrapPath) {
  if (process.argv.length !== 4 && process.argv.length !== 5) denied();
  if (process.argv.length === 5 && process.argv[2] === "install" && process.argv[3] === "--qualified-pair") {
    void runQualifiedPairInstallationOperator(process.argv[4]!).then(result => { process.exitCode = result.sourceExitCode; }, () => { process.exitCode = 70; });
  } else {
    if (process.argv.length !== 4 || process.argv[2] !== "--operation") denied();
    void runOrdinaryInstallationSupervisor(process.argv[3]!).then(code => { process.exitCode = code; }, () => { process.exitCode = 70; });
  }
}
