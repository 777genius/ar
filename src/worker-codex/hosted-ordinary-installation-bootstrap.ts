import { runOriginalUsableGuestQualification } from "./hosted-ordinary-installation-broker-use";
import { parseDependencyToolRegistration, type DependencyToolRegistration } from "../core/dependency-environment/dependency-tool-profile";
import { hostedDependencyJobRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { writeHostedTestEgressGrant } from "./hosted-test-egress-files";
import { CodexProviderEgressProfileId } from "../provider-codex/codex-provider-egress-policy";
import { validatePreparedOrdinaryLauncherQualification, runOrdinaryLauncherPairQualification, type OrdinaryLauncherCandidate, type OrdinaryLauncherQualificationFixture } from "./hosted-ordinary-installation-qualification";
import { OrdinaryLauncherPublication, assertOrdinaryCollectorProfileUpgrade, type OrdinaryCopiedCohort, type OrdinaryPriorCollectorProfile } from "./hosted-ordinary-installation-launcher";
import { resolveStoredProjectStartPlan } from "./stored-start-planning";
import { readTrustedFragment } from "./hosted-readonly-host-kernel";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, readdirSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostedActivationOperator, readHostedActivationBytes, verifySystemBusInfrastructure } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase, HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedInventoryV5, type HostedInventoryCreator, type HostedInventoryFile, type HostedInventorySupervisor, type HostedInventoryV5 } from "../core/host-infrastructure/host-inventory";
import { readSystemBusInfrastructureField, readFdCollectorProfileField, parseFdCollectorProfile, type FdCollectorProfilePin } from "@vioxen/subscription-runtime/core";
import { verifyPinnedFdCollectorProfile, observeHostedFdProcess } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { collectBootId, collectProcessBirth, collectSelfCgroup, collectUnitInvocation, collectUnitShow, collectNonDelegatedUnitShow, collectJobs, collectOriginalUnitTerminalShow } from "./hosted-readonly-linux-collector";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "./hosted-installation-activation";
import { ordinaryInstallationCollectorFailure, collectOrdinaryInstallationDraft } from "./hosted-ordinary-installation-census";
import { bindOriginalOrdinaryInstallationSupervisor, retainOriginalOrdinaryInstallationOperation, retainOriginalOrdinaryInstallationOperator, retainOriginalOrdinaryInstallationClosed, assertOrdinaryInstallationOriginalClose, type OrdinaryInstallationOperation, type OriginalOrdinaryInstallationClosed } from "./hosted-ordinary-installation-owned";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { createReadonlyPrivateRecord, publishReadonlyInventory, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { runHostedRuntimeForeground } from "./hosted-readonly-foreground";
import { hostedForegroundExitCode } from "./hosted-foreground-result";
import { HostedRetentionCleanupOutcome, HostedRetentionLaunchKind, parseHostedRetentionRequest, type HostedRetentionRequest } from "../core/host-infrastructure/host-retention-operation";
import { hostedFundedInstallationVersions, parseHostedSuccessorRequest, type HostedSuccessorRequest } from "../core/host-infrastructure/host-installation-successor";
import { cleanupOwnedRetentionContainer, deriveOriginalUnitExpectation, proveOriginalUnitTerminal, runAdmittedRetentionOperation, type OriginalCgroupNode, type OriginalLeafObservation, type OriginalUnitFacts, type OriginalUnitSample } from "./retention-operation-host";
import type { OutsideCleanupGate, OutsideCleanupResult } from "./retention-operation-test-launcher";
import { commitInstallationSuccessor, type OutsideSupervisorRecord } from "./hosted-installation-successor";
import { trustedOrdinaryInstallationSupervisorLaunch, trustedCustodySystemdRunExecutable } from "./trusted-custody-systemd-launch";
import { withScopedCollectionBudget, requestScopedManagerEffect } from "./hosted-readonly-linux-collector";

export type OrdinaryInstallationPacket = Readonly<{
  schemaVersion: 1; operationId: string; hostId: string; bootId: string; issuedEpochMs: number;
  workEndEpochMs: number; cleanupEndEpochMs: number; issuedMonotonicNs: string;
  node: HostedInventoryFile; bootstrap: HostedInventoryFile;
  runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string;
  creator: HostedInventoryCreator; testTools?: DependencyToolRegistration; collectorProfile: FdCollectorProfilePin;
  systemBusInfrastructure: Readonly<Record<string, unknown>>;
  copiedLauncher: HostedInventoryFile; copiedCodec: HostedInventoryFile;
}>;
/**
 * schemaVersion 1 is the normal installation; 2 adds ONE closed retention request (the retention discriminator); 3 adds, on top
 * of 2, the closed pins of the committed predecessor of an ALREADY-INSTALLED host (the installation successor). A successor is
 * only ever authorized together with the retention request.
 */
export type QualifiedPairInstallationRequest = Readonly<{ schemaVersion: 1 | 2 | 3; packet: OrdinaryInstallationPacket;
  candidate: OrdinaryLauncherCandidate; preparedFixture: OrdinaryLauncherQualificationFixture; copiedCohort: OrdinaryCopiedCohort;
  preparedCollectorProfile: HostedInventoryFile; priorCollectorProfile: OrdinaryPriorCollectorProfile; retention?: HostedRetentionRequest; successor?: HostedSuccessorRequest }>;
/** Funded: schemaVersion 2 = normal; 3 = plus the retention request (never a normal job); 4 = plus the successor pins. */
type FundedQualifiedPacket = Omit<OrdinaryInstallationPacket, "schemaVersion"> & Omit<QualifiedPairInstallationRequest, "schemaVersion" | "packet"> &
  Readonly<{ schemaVersion: 2 | 3 | 4; qualificationRequestSha256: string }>;
const requestKeys = "schemaVersion,packet,candidate,preparedFixture,copiedCohort,preparedCollectorProfile,priorCollectorProfile";
const fundedExtraKeys = (version: number) => version === 4 ? ",retention,successor" : version === 3 ? ",retention" : "";
const packetKeys = "bootId,bootstrap,collectorProfile,copiedCodec,copiedLauncher,creator,hostId,issuedEpochMs,issuedMonotonicNs,node,operationId,runtimeDirectory,runtimeManifestSha256,runtimeSha,schemaVersion,systemBusInfrastructure,workEndEpochMs,cleanupEndEpochMs";
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
  const selectedKeys = packetKeys + (Object.prototype.hasOwnProperty.call(input, "testTools") ? ",testTools" : "");
  if (Object.prototype.hasOwnProperty.call(input, "testTools")) {
    try {
      parseDependencyToolRegistration(input.testTools);
      const jobRoot = hostedDependencyJobRoot(input.creator.jobId);
      if (input.creator.jobRootDir !== jobRoot || input.creator.workspacePath !== jobRoot + "/workspace") denied();
    } catch { denied(); }
  }
  if (input.schemaVersion !== 1) {
    if (!hostedFundedInstallationVersions.includes(input.schemaVersion)) denied();
    closed(input, selectedKeys + "," + qualificationKeys + fundedExtraKeys(input.schemaVersion));
    if (input.schemaVersion >= 3) parseHostedRetentionRequest(input.retention);
    if (input.schemaVersion === 4) parseHostedSuccessorRequest(input.successor);
    if (!/^[a-f0-9]{64}$/.test(input.qualificationRequestSha256)) denied();
    const projected = Object.fromEntries(selectedKeys.split(",").map(key => [key, key === "schemaVersion" ? 1 : input[key as keyof typeof input]]));
    return checkedPacket(projected as OrdinaryInstallationPacket);
  }
  assertHostedActivationOperator(); packetPath(input.operationId);
  if (Object.keys(input).sort().join(",") !== selectedKeys.split(",").sort().join(",") ||
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
  const version = (request as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== 1 && version !== 2 && version !== 3) denied();
  closed(request, requestKeys + (version === 3 ? ",retention,successor" : version === 2 ? ",retention" : ""));
  if (request.schemaVersion >= 2) parseHostedRetentionRequest(request.retention);
  const successor = request.schemaVersion === 3 ? parseHostedSuccessorRequest(request.successor) : undefined;
  if (request.packet.schemaVersion !== 1 || request.packet.operationId !== operationId) denied();
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
  // The SELECTED installation (the original fixed record, or the versioned successor copy the activation selects).
  const existing = readHostedActivationBytes("host-installation.json");
  if (successor && !existing) denied(); // a successor needs an installed predecessor
  if (existing) {
    const { installation, activation } = readHostedInstallationActivation();
    const installedInventory = readHostedActivationBytes("readonly-inventory.json");
    if (!installedInventory) denied();
    const prior = parseHostedInventoryV5(JSON.parse(installedInventory.toString("utf8")));
    if (successor) {
      // Early refusal only: the supervisor re-checks every pin under the activation fence, the authority for the transition.
      // The runtime may differ from the predecessor's (that is the point of a new artifact); nothing else may.
      if (activation.phase !== HostedActivationPhase.Closed || activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal) ||
          installation.hostId !== packet.hostId || activation.bootId !== packet.bootId || installation.installationId !== successor.installationId ||
          hash(existing) !== successor.installationSha256 || hash(installedInventory) !== successor.inventorySha256 ||
          hash(readHostedActivationBytes("host-activation.json") ?? denied()) !== successor.activationSha256 || activation.generation !== successor.activationGeneration ||
          prior.supervisor.operationId === packet.operationId) denied();
    } else {
      if (activation.phase !== HostedActivationPhase.Closed || installation.hostId !== packet.hostId || installation.runtimeDirectory !== packet.runtimeDirectory || installation.runtimeSha !== packet.runtimeSha || installation.runtimeManifestSha256 !== packet.runtimeManifestSha256) denied();
      if (prior.supervisor.operationId !== packet.operationId || prior.collectorProfile.sha256 !== packet.collectorProfile.sha256 || prior.supervisor.bootstrap.sha256 !== packet.bootstrap.sha256) denied();
    }
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
  const funded: FundedQualifiedPacket = { ...packet, schemaVersion: request.schemaVersion === 3 ? 4 : request.schemaVersion === 2 ? 3 : 2, qualificationRequestSha256: hash(bytes), candidate: request.candidate,
    preparedFixture: request.preparedFixture, copiedCohort: request.copiedCohort, preparedCollectorProfile: request.preparedCollectorProfile, priorCollectorProfile: request.priorCollectorProfile,
    ...(request.schemaVersion >= 2 ? { retention: request.retention } : {}), ...(request.schemaVersion === 3 ? { successor: request.successor } : {}) };
  assertCopiedCohort(request.copiedCohort);
  assertOrdinaryCollectorProfileUpgrade(operationId, request.preparedCollectorProfile, request.priorCollectorProfile,
    request.candidate.candidateArtifactPath, request.candidate.launcherSha256, request.candidate.codecSha256);
  const operation = fundOriginalOperation(funded);
  const pair = await runOrdinaryLauncherPairQualification(operation, request.candidate, request.preparedFixture);
  const publication = new OrdinaryLauncherPublication(operation, pair, request.copiedCohort, request.preparedCollectorProfile, request.priorCollectorProfile);
  publication.publish(); admitInstalledPair(packet);
  if (!readHostedPrivateBytes(packet.collectorProfile.path, 64 * 1024)?.equals(readHostedPrivateBytes(request.preparedCollectorProfile.path, 64 * 1024)!)) denied();
  // Optional fixed TEST qualification; a present malformed selection refuses.
  let usable = true;
  try { lstatSync(join(operationRoot, operationId + ".usable-fixture.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; usable = false; }
  if (usable) await runOriginalUsableGuestQualification(operation);
  publication.consumeBeforeOriginalSupervisorBirth();
  return runFundedInstallationSupervisor(packet, operation, request.retention);
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
async function runFundedInstallationSupervisor(packet: OrdinaryInstallationPacket, operation: OrdinaryInstallationOperation, retention?: HostedRetentionRequest): Promise<Readonly<{ sourceExitCode: number; settled: true; closure: OriginalOrdinaryInstallationClosed }>> {
  budget(packet, false);
  const unit = `subscription-runtime-installation-${packet.operationId}.service`;
  const launch = trustedOrdinaryInstallationSupervisorLaunch(packet.operationId, budget(packet, false), budget(packet, true));
  budget(packet, false);
  const child = spawn(launch.command, launch.args, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  const closure = retainOperatorChild(child, packet, unit, operation);
  let wait: Awaited<typeof closure> | undefined, waitFailure: unknown;
  try { wait = await closure; } catch (error) { waitFailure = error; }
  // OUTSIDE cleanup owner. The proxy has closed here, but a closed proxy (or a requested `stop --no-block`) is NOT the unit's
  // terminal custody: until the ORIGINAL unit is observed terminal (MainPID 0, no job, control group empty) the admitted
  // supervisor can still create and start the container. `runOutsideCleanup` therefore proves that FIRST, inside the cleanup
  // window, and only then stops ONLY the exact container the supervisor bound to this operation, or retains the uncertainty.
  let cleanedUp = true;
  if (retention?.launch.kind === HostedRetentionLaunchKind.DockerTest) {
    cleanedUp = (await runOutsideCleanup(packet.operationId, { hostId: packet.hostId, bootId: packet.bootId }, () => budget(packet, true))).ok;
  }
  if (waitFailure) throw waitFailure;
  if (!wait || !cleanedUp) denied();
  budget(packet, true);
  const session = readHostedPrivateBytes(join(operationRoot, packet.operationId + ".supervisor.json"), 4096);
  if (!session || wait.signal !== null) denied();
  const original = JSON.parse(session.toString("utf8"));
  if (JSON.stringify(original) !== JSON.stringify(wait.original)) denied();
  if (original.unit !== unit || original.bootId !== packet.bootId || !/^[a-f0-9]{32}$/.test(original.invocationId) || original.operationId !== packet.operationId) denied();
  // The SAME terminal proof the outside cleanup uses. A normally exited or stopped `--wait` unit is collected by systemd (empty group
  // and invocation, `not-found`) and its leaf is gone; it is accepted only on the retained, authenticated original identity.
  await proveOriginalUnitTerminalCustody(packet.operationId, { hostId: packet.hostId, bootId: packet.bootId }, () => budget(packet, true));
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
    let original: Record<string, unknown> | undefined, liveChain: OriginalLeafChain | undefined, readyText = "", proxyBirth: string | null = null;
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
        // The live leaf and its parents, observed while the unit is alive, are the only provenance a later `not-found` unit can use.
        liveChain = observeLiveLeafChain(current.ControlGroup, unit, () => budget(packet, true));
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
              // Chain first: a bound record without its chain only ever withholds authority for a collected unit, never grants it.
              createReadonlyPrivateRecord(join(directory, "original-leaf-chain.json"), Buffer.from(JSON.stringify({ operationId: packet.operationId, unit,
                bootId: packet.bootId, controlGroup: original!.controlGroup, parents: liveChain!.parents, leaf: liveChain!.leaf }) + "\n"));
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
function assertOriginalSupervisorEmpty(group: string, unit: string, remaining: () => number): void {
  if (group !== originalUnitGroup(unit)) denied();
  let nodes = 0;
  const walk = (path: string): void => {
    remaining(); if (++nodes > 256) denied();
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
const installationUnit = (operationId: string) => `subscription-runtime-installation-${operationId}.service`;
const originalUnitGroup = (unit: string) => `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
const cgroupRoot = "/sys/fs/cgroup", cgroup2SuperMagic = 0x63677270n;
/**
 * Bound observation of the exact ORIGINAL leaf. Every directory from the cgroup2 root down is opened THROUGH its parent's
 * descriptor (`/proc/self/fd/<fd>/<name>`, O_DIRECTORY|O_NOFOLLOW), must be a root-owned cgroup2 directory (every non-root one with a
 * readable `cgroup.events`, i.e. a live cgroup), and is re-resolved by path afterwards to the same device/inode.
 * - The leaf exists: the existing safe positive walk (`assertOriginalSupervisorEmpty`) must show it and every descendant empty
 *   (`empty`); populated, unreadable or vanished-mid-walk is `not_proved`.
 * - The leaf name is ABSENT (ENOENT on the parent descriptor and not listed by it): `absent_proved` only if EVERY parent of the
 *   canonical original path was opened and proved live and none changed afterwards. A missing or unproved parent, any other error
 *   or any identity change is `not_proved` (or throws), never absence. A global scan is never consulted.
 */
type HeldCgroupNode = { path: string; fd: number; dev: number; ino: number };
function splitOriginalGroup(group: string, unit: string): { parents: string[]; leaf: string } {
  if (group !== originalUnitGroup(unit)) denied();
  const parents = group.split("/").slice(1), leaf = parents.pop()!;
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(leaf) || parents.some(part => !/^[A-Za-z0-9_.@-]+\.slice$/.test(part))) denied();
  return { parents, leaf };
}
/**
 * Opens the cgroup2 root and then each parent THROUGH its parent's descriptor into `held` (the caller closes every entry). Returns
 * false when the chain is not proved (a parent is absent, not a root-owned cgroup2 directory, or has no readable `cgroup.events`);
 * any other failure throws. The one place both the live retention and the terminal observation build their ancestry.
 */
function holdCgroupParents(parents: readonly string[], held: HeldCgroupNode[], remaining: () => number): boolean {
  for (const [depth, name] of [null, ...parents].entries()) {
    remaining();
    const path = held.length === 0 ? cgroupRoot : `${held.at(-1)!.path}/${name}`, via = held.length === 0 ? cgroupRoot : `/proc/self/fd/${held.at(-1)!.fd}/${name}`;
    let fd: number;
    try { fd = openSync(via, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const stat = fstatSync(fd), anchored = `/proc/self/fd/${fd}`;
    held.push({ path, fd, dev: stat.dev, ino: stat.ino });
    if (!stat.isDirectory() || stat.uid !== 0 || statfsSync(anchored, { bigint: true }).type !== cgroup2SuperMagic) return false;
    if (depth > 0 && !/^populated [01]$/m.test(readFileSync(anchored + "/cgroup.events", "utf8"))) return false;
  }
  return true;
}
const releaseCgroupNodes = (held: HeldCgroupNode[]) => { for (const node of held.reverse()) try { closeSync(node.fd); } catch { /* the observation is already decided; a stuck close cannot turn it into proof */ } };
/** The slice directories below the cgroup2 root, as retained/compared identities (path relative to the root). */
const ancestryOf = (held: readonly HeldCgroupNode[]): OriginalCgroupNode[] => held.slice(1).map(node => ({ path: node.path.slice(cgroupRoot.length), dev: node.dev, ino: node.ino }));
/**
 * The issuer's LIVE observation of the original leaf and its parents, taken from the same bind that records unit, invocation, group,
 * argv and birth, while the unit is alive: every parent proved and the leaf present as a root-owned directory. Retained (create-once)
 * as `original-leaf-chain.json`; a later `not-found` unit is only ever judged against THESE parents, never against whatever
 * directories happen to carry the same names. Any failure throws and the bind is not completed.
 */
function observeLiveLeafChain(group: string, unit: string, remaining: () => number): OriginalLeafChain {
  const { parents, leaf } = splitOriginalGroup(group, unit), held: HeldCgroupNode[] = [];
  try {
    if (!holdCgroupParents(parents, held, remaining)) denied();
    const stat = lstatSync(`/proc/self/fd/${held.at(-1)!.fd}/${leaf}`);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0) denied();
    return { parents: ancestryOf(held), leaf: { dev: stat.dev, ino: stat.ino } };
  } finally { releaseCgroupNodes(held); }
}
type OriginalLeafChain = Readonly<{ parents: readonly OriginalCgroupNode[]; leaf: Readonly<{ dev: number; ino: number }> }>;
function observeOriginalLeaf(group: string, unit: string, remaining: () => number): { leaf: OriginalLeafObservation; parents: readonly OriginalCgroupNode[] } {
  const { parents, leaf } = splitOriginalGroup(group, unit), held: HeldCgroupNode[] = [];
  const result = (observation: OriginalLeafObservation) => ({ leaf: observation, parents: observation === "not_proved" ? [] : ancestryOf(held) });
  try {
    if (!holdCgroupParents(parents, held, remaining)) return result("not_proved");
    const parent = held.at(-1)!, anchoredParent = `/proc/self/fd/${parent.fd}`;
    let exists = true;
    try { lstatSync(`${anchoredParent}/${leaf}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
    if (exists) {
      try { assertOriginalSupervisorEmpty(group, unit, remaining); return result("empty"); }
      catch { return result("not_proved"); /* populated, unreadable or gone mid-walk: not proved empty, polled again until the window ends */ }
    }
    remaining();
    if (readdirSync(anchoredParent).includes(leaf)) return result("not_proved");
    for (const node of held) {
      const now = lstatSync(node.path);
      if (!now.isDirectory() || now.dev !== node.dev || now.ino !== node.ino) return result("not_proved");
    }
    if (!/^populated [01]$/m.test(readFileSync(anchoredParent + "/cgroup.events", "utf8"))) return result("not_proved"); // the parent is a slice, never the root
    return result("absent_proved");
  } finally { releaseCgroupNodes(held); }
}
function sampleOriginalUnit(unit: string): OriginalUnitSample {
  const show = collectOriginalUnitTerminalShow(unit);
  return { bootId: collectBootId(), loadState: show.LoadState!, activeState: show.ActiveState!, mainPid: show.MainPID!,
    jobPresent: show.Job !== "" || collectJobs().includes(unit), controlGroup: show.ControlGroup!, invocationId: show.InvocationID! };
}
/**
 * Positive observation of the ORIGINAL installation unit for the outside cleanup owner (a10 F1): manager state, MainPID, queued
 * job, and the exact original leaf, as ONE bracket: authenticated unit sample, bound leaf observation, authenticated unit sample
 * again. The decision (identity, terminal-retired state, drift between the samples) is the pure `originalUnitPending`.
 */
function observeOriginalUnit(unit: string, remaining: () => number): OriginalUnitFacts {
  return withScopedCollectionBudget(remaining(), () => {
    const before = sampleOriginalUnit(unit), observed = observeOriginalLeaf(originalUnitGroup(unit), unit, remaining), after = sampleOriginalUnit(unit);
    return { before, leaf: observed.leaf, parents: observed.parents, after };
  });
}
/** The outside issuer's own record of the supervisor it bound (`original-supervisor.json`), or `null` when none was written. */
function readOutsideSupervisorRecord(operationId: string): OutsideSupervisorRecord | null {
  const bytes = readHostedPrivateBytes(join(operationRoot, operationId, "original-supervisor.json"), 4096);
  if (!bytes) return null;
  const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  closed(value, "operationId,unit,bootId,birth,invocationId,controlGroup");
  return Object.freeze(value as unknown as OutsideSupervisorRecord);
}
/**
 * ONE terminal proof of the ORIGINAL installation unit, shared by the outside cleanup gate and the issuer's final closure
 * (`runFundedInstallationSupervisor`); there is no second, weaker predicate. The expectation is DERIVED by the pure
 * `deriveOriginalUnitExpectation` (funded vs live machine and boot, the issuer's bound record, the supervisor's self-record, the
 * retained live leaf chain) from the raw bytes of the three records, read here through the private root-owned reader, BEFORE any
 * observation. A terminal unit (empty current invocation/group, leaf gone, even a manager that already forgot it) is therefore only
 * ever judged against the retained identity of the original admitted supervisor, never against the current manager state alone.
 */
async function proveOriginalUnitTerminalCustody(operationId: string, identity: Readonly<{ hostId: string; bootId: string }>, remaining: () => number): Promise<void> {
  const unit = installationUnit(operationId), directory = join(operationRoot, operationId);
  const expected = deriveOriginalUnitExpectation({ operationId, unit, controlGroup: originalUnitGroup(unit), hostId: identity.hostId, bootId: identity.bootId,
    liveHostId: readFileSync("/etc/machine-id", "utf8").trim(), liveBootId: collectBootId() }, {
    bound: readHostedPrivateBytes(join(directory, "original-supervisor.json"), 4096),
    self: readHostedPrivateBytes(join(operationRoot, operationId + ".supervisor.json"), 4096),
    chain: readHostedPrivateBytes(join(directory, "original-leaf-chain.json"), 4096) });
  await proveOriginalUnitTerminal(expected, () => observeOriginalUnit(unit, remaining),
    { remainingMs: remaining, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
}
/** The gate `cleanupOwnedRetentionContainer` REQUIRES: terminal custody of the original unit inside the cleanup window. */
function outsideCleanupGate(operationId: string, identity: Readonly<{ hostId: string; bootId: string }>, remaining: () => number): OutsideCleanupGate {
  return Object.freeze({ remainingMs: remaining, proveOriginalTerminal: () => proveOriginalUnitTerminalCustody(operationId, identity, remaining) });
}
/**
 * Terminal-custody gate, then the exact-container cleanup. A failed attempt is contained here (the caller only learns `ok`) and
 * retained as the FIRST evidence in `cleanup-held.json`; it consumes no terminal receipt, so the same helper can be re-run by the
 * recovery entry once the unit is provably gone.
 */
async function runOutsideCleanup(operationId: string, identity: Readonly<{ hostId: string; bootId: string }>, remaining: () => number): Promise<OutsideCleanupResult> {
  let result: OutsideCleanupResult;
  try { result = await cleanupOwnedRetentionContainer(operationId, outsideCleanupGate(operationId, identity, remaining)); }
  catch (error) { result = { ok: false, outcome: HostedRetentionCleanupOutcome.CleanupUnproved, containerId: null, reason: `cleanup_failed:${error instanceof Error ? error.message : "unknown"}` }; }
  if (!result.ok) {
    try { createReadonlyPrivateRecord(join(operationRoot, operationId, "cleanup-held.json"), Buffer.from(JSON.stringify({ operationId, outcome: result.outcome, containerId: result.containerId, reason: result.reason ?? null }) + "\n")); }
    catch { /* The first retained cleanup-held record stays the evidence; the operation itself is still reported HELD by the caller. */ }
  }
  return result;
}
/** Bounded window of the recovery entry: a fresh finite budget, never the (ended) window of the original operation. */
export const recoveryCleanupWindowMs = 120_000;
/**
 * RECOVERY of the outside cleanup owner when the issuer died (or its cleanup was left HELD). It re-runs the SAME helper
 * (`cleanupOwnedRetentionContainer`, with the same terminal-custody gate) for an already funded Docker TEST operation. It funds
 * nothing, starts nothing and replays nothing: it requires the operation record, its launcher-consumption record and the live
 * boot/machine of the funded packet, and it acts only on the custody the admitted supervisor retained. A closing receipt that
 * already exists closes idempotently without a Docker call; a live (not terminal) unit keeps it HELD.
 */
export async function recoverOwnedRetentionCleanup(operationId: string, windowMs = recoveryCleanupWindowMs): Promise<OutsideCleanupResult> {
  assertHostedActivationOperator();
  const bytes = readHostedPrivateBytes(packetPath(operationId), 64 * 1024); if (!bytes) denied();
  const funded = JSON.parse(bytes.toString("utf8")) as FundedQualifiedPacket;
  if (!hostedFundedInstallationVersions.includes(funded.schemaVersion) || funded.schemaVersion < 3 || funded.operationId !== operationId ||
      !readHostedPrivateBytes(join(operationRoot, operationId, "operation.json"), 64 * 1024)?.equals(bytes) ||
      !readHostedPrivateBytes(join(operationRoot, operationId, "launcher-consumed.json"), 4096)?.equals(Buffer.from(hash(bytes) + "\n"))) denied();
  if (parseHostedRetentionRequest(funded.retention).launch.kind !== HostedRetentionLaunchKind.DockerTest) denied(); // nothing owned outside the unit
  if (readFileSync("/etc/machine-id", "utf8").trim() !== funded.hostId || collectBootId() !== funded.bootId) denied();
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) denied();
  const end = performance.now() + windowMs;
  return runOutsideCleanup(operationId, { hostId: funded.hostId, bootId: funded.bootId }, () => { const ms = Math.floor(end - performance.now()); return ms < 1 ? denied() : ms; });
}
function retainCollectorFailure(operationId: string, error: unknown): void {
  const failed = ordinaryInstallationCollectorFailure(error);
  if (!failed) return;
  const directory = join(operationRoot, operationId);
  createReadonlyPrivateRecord(join(directory, "collector-stdout.log"), Buffer.from(failed.stdout));
  createReadonlyPrivateRecord(join(directory, "collector-stderr.log"), Buffer.from(failed.stderr));
  createReadonlyPrivateRecord(join(directory, "collector-failure.json"), Buffer.from(JSON.stringify({ operationId, args: failed.args, status: failed.status, signal: failed.signal }) + "\n"));
}
/**
 * The OUTSIDE issuer's own record of the supervisor it launched (`original-supervisor.json`, written by `retainOperatorChild`
 * after the issuer's fresh physical bind of unit, invocation, cgroup, argv, executable and birth). A successor commits only
 * when this independent record agrees with the supervisor's own census; bounded wait, never an unbounded poll.
 */
async function outsideSupervisorRecord(packet: OrdinaryInstallationPacket): Promise<OutsideSupervisorRecord> {
  for (;;) {
    const record = readOutsideSupervisorRecord(packet.operationId);
    if (record) return record;
    if (budget(packet, false) < 500) denied();
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
/** One original measured supervisor, all Store operations in this same PID. */
export async function runOrdinaryInstallationSupervisor(operationId: string): Promise<number> {
  assertHostedActivationOperator();
  const bytes = readHostedPrivateBytes(packetPath(operationId), 64 * 1024); if (!bytes) denied();
  const funded = JSON.parse(bytes.toString("utf8")) as FundedQualifiedPacket;
  if (!hostedFundedInstallationVersions.includes(funded.schemaVersion) || !readHostedPrivateBytes(join(operationRoot, operationId, "operation.json"), 64 * 1024)?.equals(bytes) ||
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
  const inventoryBytes = Buffer.from(JSON.stringify(inventory) + "\n");
  // The installation-successor discriminator (funded schemaVersion 4) keeps the predecessor's create-once fixed inventory; the
  // candidate census is staged and selected by the successor transaction below instead of being published over it.
  const successor = funded.schemaVersion === 4 ? parseHostedSuccessorRequest(funded.successor) : undefined;
  budget(packet, false); if (!successor) publishReadonlyInventory(inventoryBytes);
  const store = new HostedInstallationActivationStore();
  let sourceExitCode = 70;
  // The retention discriminator (funded schemaVersion 3 or 4). It is parsed closed again here, from the funded bytes that the
  // launcher-consumed record already pins, so only a request that was funded with the operation can select this branch.
  const retention = funded.schemaVersion >= 3 ? parseHostedRetentionRequest(funded.retention) : undefined;
  try {
    if (successor) {
      const outside = await outsideSupervisorRecord(packet);
      collectOriginal(packet, false, () => commitInstallationSuccessor({ store, operationId, request: successor, candidateBytes: inventoryBytes,
        runtime: { runtimeDirectory: packet.runtimeDirectory, runtimeSha: packet.runtimeSha, runtimeManifestSha256: packet.runtimeManifestSha256 }, outside }));
    } else collectOriginal(packet, false, () => store.install());
    if (retention) {
      // This is the admitted supervisor: no creator enrollment, no resume, no hosted creator launch, no origin birth. The
      // activation stays Closed; the role runs the finite retention operation and nothing else.
      const outcome = await runAdmittedRetentionOperation({ operationId, hostId: packet.hostId, bootId: packet.bootId, issuedEpochMs: packet.issuedEpochMs,
        workEndEpochMs: packet.workEndEpochMs, cleanupEndEpochMs: packet.cleanupEndEpochMs, issuedMonotonicNs: packet.issuedMonotonicNs, node: packet.node,
        bootstrap: packet.bootstrap, runtimeDirectory: packet.runtimeDirectory, runtimeSha: packet.runtimeSha, runtimeManifestSha256: packet.runtimeManifestSha256 }, retention);
      sourceExitCode = outcome.ok ? 0 : 1;
      budget(packet, true);
      const activation = collectOriginal(packet, true, () => readHostedInstallationActivation().activation);
      if (activation.phase !== HostedActivationPhase.Closed) denied();
      createReadonlyPrivateRecord(join(operationRoot, operationId + ".closed.json"), Buffer.from(JSON.stringify({ operationId, sourceExitCode, generation: activation.generation }) + "\n"));
      return sourceExitCode;
    }
    if (packet.testTools) {
      budget(packet, false);
      await writeHostedTestEgressGrant({ schemaVersion: 1, jobId: packet.creator.jobId,
        jobRootDir: packet.creator.jobRootDir, workspacePath: packet.creator.workspacePath,
        profileId: CodexProviderEgressProfileId.TestNpmQualification }, packet.testTools);
      budget(packet, false);
    }
    collectOriginal(packet, false, () => store.enrollOrdinary(packet.creator.creatorId)); collectOriginal(packet, false, () => store.resumeOrdinary());
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
    // The retention branch never opened an ordinary runtime launch, so there is nothing to close for it.
    if (!retention) try { store.closeOrdinaryRuntimeLaunch(); } catch { /* Original evidence remains held. */ }
    throw error;
  }
}
if (process.argv[1] === bootstrapPath) {
  if (process.argv.length !== 4 && process.argv.length !== 5) denied();
  if (process.argv.length === 5 && process.argv[2] === "install" && process.argv[3] === "--qualified-pair") {
    void runQualifiedPairInstallationOperator(process.argv[4]!).then(result => { process.exitCode = result.sourceExitCode; }, () => { process.exitCode = 70; });
  } else if (process.argv.length === 4 && process.argv[2] === "--recover-cleanup") {
    // Root operator recovery of the outside cleanup owner of ONE already funded Docker TEST operation (no funding, no replay).
    void recoverOwnedRetentionCleanup(process.argv[3]!).then(result => {
      process.stdout.write(JSON.stringify({ ok: result.ok, outcome: result.outcome, containerId: result.containerId, reason: result.reason ?? null }) + "\n");
      process.exitCode = result.ok ? 0 : 70;
    }, (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "hosted_ordinary_installation_held"}\n`);
      process.exitCode = 70;
    });
  } else {
    if (process.argv.length !== 4 || process.argv[2] !== "--operation") denied();
    void runOrdinaryInstallationSupervisor(process.argv[3]!).then(code => { process.exitCode = code; }, () => { process.exitCode = 70; });
  }
}
