import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertHostedActivationOperator, readHostedActivationBytes } from "@vioxen/subscription-runtime/provider-codex";
import {
  HostedRetentionCleanupOutcome, HostedRetentionLaunchKind, hostedMemoryTopologyMountPoint, parseHostedRetentionContainerRecord, parseHostedRetentionFunded,
  parseHostedRetentionPacket, type HostedRetentionFile, type HostedRetentionFunded, type HostedRetentionPacket, type HostedRetentionRequest,
} from "../core/host-infrastructure/host-retention-operation";
import { observeHostMemoryTopology, readLinuxMemoryAvailability, type HostMemoryReference } from "../worker-local/linux-memory-availability";
import { readRetainedNonqualifiedPermit, projectControlRetainNonqualifiedAttempt } from "./codex-goal-mcp-project-control-retained-nonqualified";
import { assertInspectedInstallation, readHostedInstallationActivation } from "./hosted-installation-activation";
import { HostedReadonlyHostKernel, readTrustedFragment } from "./hosted-readonly-host-kernel";
import { collectBootId, collectProcessBirth } from "./hosted-readonly-linux-collector";
import {
  assertRetentionFundedSession, assertRetentionLiveFacts, assertRetentionOperationFacts, assertRetentionOperatorAdmission, retentionBudgetMs,
  retentionMemoryReference, retentionToolArgs, type RetentionOperationFacts, type RetentionOperatorSession,
} from "./retained-memory-authority";
import { collectHostedMemoryTopology } from "./retained-memory-topology-issuance";
import {
  createRetentionRecord, decodeRetentionJson, ensureRetentionOperationDirectories, readRetentionRecord, retentionHeld, retentionOperationRoot,
  retentionSha256,
} from "./retention-operation-records";
import {
  assertDockerTestMounts, cleanupOwnedDockerTestContainer, proveContainerExecutable, proveDockerContainerIdentity, runOwnedDockerTestLifecycle,
  type OutsideCleanupGate, type OutsideCleanupResult,
} from "./retention-operation-test-launcher";

/**
 * Host composition of the closed RETENTION OPERATOR role: the only caller that constructs the memory-availability port the
 * expanded retention policy consumes. The role is a DISCRIMINATOR of the existing admitted installation supervisor
 * operation (`hosted-ordinary-installation-bootstrap.ts`, funded packet schemaVersion 3), not a second actor:
 *
 * WHY an external process cannot be the operator. `HostedReadonlyHostKernel.operatorSession()` requires, for a V5 inventory,
 * `collectProcessBirth(process.pid) === inventory.supervisor.birth` (and the supervisor's own cgroup) before it returns the
 * session. The V5 inventory is created once by the installation supervisor process and names that process's birth, so any
 * other process (an outside root operator, a retention unit, a container) always refuses. That guard is unchanged here and
 * still refuses every unadmitted external caller; nothing in this file relabels a caller as the supervisor.
 *
 * Flow (nothing here is executed by its author):
 *  1. The initial-root operator prepares the existing qualified-pair installation request with one closed `retention`
 *     request and funds it exactly like any installation operation (operation record, launcher consumption, window).
 *  2. The existing installation supervisor unit starts, runs ALL its existing proofs, publishes the inventory and installs
 *     the activation (unchanged), then - instead of enrolling/resuming/launching the creator - calls
 *     `runAdmittedRetentionOperation`: kernel admission FIRST, then bind the actual installation/runtime/boot/window,
 *     observe the live memory topology, publish packet + funded records create-once, and only then run the real retention
 *     MCP entry with the port (or, for the TEST launcher, the owned container that re-observes the same topology).
 *  3. `runRetentionOperationSupervisor` (TEST container only) re-authenticates inside the pinned container.
 *
 * Already-installed hosts. The V5 inventory is create-only, so the supervisor identity that satisfies the kernel exists only
 * inside an installation operation. An installed host therefore enters the role through the INSTALLATION SUCCESSOR
 * (funded packet schemaVersion 4, `hosted-installation-successor.ts`): the fresh supervisor of a new owned operation commits
 * one fenced, versioned selection of its own inventory and installation BEFORE this function admits it, and everything below
 * then runs unchanged against the selected world.
 *
 * Finite cleanup owner. The TEST container lies outside the supervisor's control group, so the supervisor cannot be its only
 * cleanup owner: it announces custody before each step (`intent`, `created`) and the issuing outside process, which outlives
 * it, stops exactly that container within its own cleanup window (`cleanupOwnedRetentionContainer`) - but only AFTER the
 * original installation unit is proved terminal (`proveOriginalUnitTerminal`), because until then the admitted supervisor can
 * still create and start the container. If that issuer dies, the same helper is re-run by the recovery entry
 * (`recoverOwnedRetentionCleanup` in the installation bootstrap), without funding and without replaying the operation.
 */
export const retentionBootstrapPath = fileURLToPath(new URL("./retention-operation-bootstrap.js", import.meta.url));
const runtimeDirectoryOf = () => fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

/** The facts of the funded installation operation the role runs inside; it contributes the finite window and pins only. */
export type RetentionInstallationWindow = Readonly<{
  operationId: string; hostId: string; bootId: string; issuedEpochMs: number; workEndEpochMs: number; cleanupEndEpochMs: number;
  issuedMonotonicNs: string; node: HostedRetentionFile; bootstrap: HostedRetentionFile;
  runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string;
}>;

function readHostFacts(): Omit<RetentionOperationFacts, "packet" | "nowEpochMs" | "nowMonotonicNs"> {
  const { installation, activation } = readHostedInstallationActivation();
  assertInspectedInstallation(installation);
  const installationBytes = readHostedActivationBytes("host-installation.json") ?? retentionHeld("installation_missing");
  const inventoryBytes = readHostedActivationBytes("readonly-inventory.json") ?? retentionHeld("inventory_missing");
  return { installation, activation, installationBytes, inventoryBytes, liveBootId: collectBootId(),
    liveMachineId: readFileSync("/etc/machine-id", "utf8").trim(), runtimeDirectory: runtimeDirectoryOf() };
}
const protectedPin = (pin: HostedRetentionFile) => {
  if (retentionSha256(readTrustedFragment(pin.path, 256 * 1024 * 1024)) !== pin.sha256) retentionHeld("pin_mismatch");
};
function loadPacket(operationId: string): { packet: HostedRetentionPacket; packetBytes: Buffer } {
  const packetBytes = readRetentionRecord(operationId, "packet") ?? retentionHeld("packet_missing");
  const packet = parseHostedRetentionPacket(decodeRetentionJson(packetBytes));
  if (packet.operationId !== operationId) retentionHeld("operation_id_mismatch");
  return { packet, packetBytes };
}

/**
 * ADMISSION: the actual existing kernel operator session. It requires the caller to be in the admitted supervisor's own
 * cgroup and, for V5, to BE that supervisor process, with live boot, machine and supervisor identity. Being root in the
 * initial namespaces, or reading a consistent installation, is not this. An external process throws here and nothing is
 * published, funded or launched.
 */
function admitSupervisor(): RetentionOperatorSession {
  return new HostedReadonlyHostKernel().operatorSession();
}

/**
 * A new attempt for the same permit is refused while an earlier operation for it has no `closed` record: a held or
 * uncertain earlier attempt must be reconciled first (the retention tool itself is same-permit idempotent), never blindly
 * replayed.
 */
function assertNoUnclosedOperation(packet: HostedRetentionPacket): void {
  const names = readdirSync(retentionOperationRoot).filter(name => /^[a-f0-9-]{36}\.funded\.json$/.test(name));
  if (names.length > 256) retentionHeld("too_many_operations");
  for (const name of names) {
    const id = name.slice(0, 36);
    if (id === packet.operationId) continue;
    const other = readRetentionRecord(id, "packet");
    if (!other) continue;
    const prior = parseHostedRetentionPacket(decodeRetentionJson(other));
    if (prior.retention.expectedPermitSha256 === packet.retention.expectedPermitSha256 && readRetentionRecord(id, "closed") === null) retentionHeld(`unclosed_operation_for_permit:${id}`);
  }
}

/**
 * The retention dispatch INSIDE the admitted installation supervisor process. Order is the contract: kernel admission,
 * then actual bindings, then publication/funding, then the workload. Any refusal before the funded record leaves nothing
 * published; any later failure writes a held record and throws (uncertainty is retained, never repaired).
 */
export async function runAdmittedRetentionOperation(window: RetentionInstallationWindow, request: HostedRetentionRequest): Promise<{ readonly ok: boolean }> {
  assertHostedActivationOperator();
  const session = admitSupervisor();
  const host = readHostFacts();
  const docker = request.launch.kind === HostedRetentionLaunchKind.DockerTest;
  // The TEST container runs the retention bootstrap (re-hashed inside); the supervisor-resident route runs this very process.
  const bootstrap: HostedRetentionFile = docker
    ? { path: retentionBootstrapPath, sha256: retentionSha256(readTrustedFragment(retentionBootstrapPath)) } : window.bootstrap;
  const packet = parseHostedRetentionPacket({ schemaVersion: 3, role: "retention_operator", operationId: window.operationId,
    hostId: window.hostId, bootId: window.bootId, issuedEpochMs: window.issuedEpochMs, workEndEpochMs: window.workEndEpochMs,
    cleanupEndEpochMs: window.cleanupEndEpochMs, issuedMonotonicNs: window.issuedMonotonicNs, node: window.node, bootstrap,
    runtimeDirectory: window.runtimeDirectory, runtimeSha: window.runtimeSha, runtimeManifestSha256: window.runtimeManifestSha256,
    installationSha256: retentionSha256(host.installationBytes), inventorySha256: host.installation.inventorySha256,
    launch: request.launch, retention: request.retention });
  assertRetentionOperatorAdmission({ packet, activation: host.activation, session });
  assertRetentionOperationFacts({ ...host, packet, nowEpochMs: Date.now(), nowMonotonicNs: process.hrtime.bigint() });
  protectedPin(packet.node);
  if (docker) { protectedPin(packet.bootstrap); assertDockerTestMounts(packet); }
  else if (packet.node.path !== process.execPath) retentionHeld("node_path_mismatch");
  ensureRetentionOperationDirectories(packet.operationId);
  assertNoUnclosedOperation(packet);
  // The OUTSIDE-of-workload observation of the complete host memory hierarchy: the reference the workload must match.
  const memoryTopology = collectHostedMemoryTopology();
  const packetBytes = createRetentionRecord(packet.operationId, "packet", packet);
  const funded: HostedRetentionFunded = { schemaVersion: 3, role: "retention_operator", operationId: packet.operationId,
    packetSha256: retentionSha256(packetBytes), session, memoryTopology };
  createRetentionRecord(packet.operationId, "funded", funded);
  try {
    // The admitted session must still be the very same one immediately before the first effect.
    if (!isDeepStrictEqual(admitSupervisor(), session)) retentionHeld("operator_session_changed");
    assertRetentionFundedSession(funded, readHostedInstallationActivation().activation);
    const now = Date.now(), ns = process.hrtime.bigint();
    const workMs = retentionBudgetMs(packet, false, now, ns), cleanupMs = retentionBudgetMs(packet, true, now, ns);
    let exitCode: number;
    if (docker) exitCode = (await runOwnedDockerTestLifecycle(packet, { workMs, cleanupMs })).exitCode;
    else {
      const reference = retentionMemoryReference({ packet, packetBytes, funded, live: observeHostMemoryTopology({ cgroupRoot: hostedMemoryTopologyMountPoint }) });
      createRetentionRecord(packet.operationId, "supervisor", { schemaVersion: 3, operationId: packet.operationId, kind: packet.launch.kind,
        birth: collectProcessBirth(String(process.pid)), bootId: packet.bootId, packetSha256: funded.packetSha256,
        memoryTopologySha256: retentionSha256(Buffer.from(JSON.stringify(funded.memoryTopology))) });
      exitCode = (await runRetentionTool(packet, reference)).ok ? 0 : 1;
    }
    // A result produced after the finite window ended is not closed (both routes): the uncertainty stays HELD. This is the
    // last check before the terminal receipt; the lifecycle also checks after every command it issues.
    retentionBudgetMs(packet, false, Date.now(), process.hrtime.bigint());
    return closeRetentionOperation(packet, exitCode);
  } catch (error) {
    try { createRetentionRecord(packet.operationId, "held", { schemaVersion: 3, operationId: packet.operationId, reason: error instanceof Error ? error.message : "unknown" }); }
    catch { /* An existing held record is the retained evidence. */ }
    throw error;
  }
}

/** The real retention MCP entry with the port only this role can construct; the outcome is retained create-once. */
async function runRetentionTool(packet: HostedRetentionPacket, reference: HostMemoryReference): Promise<{ readonly ok: boolean }> {
  let ok = false, output = "";
  try {
    const response = await projectControlRetainNonqualifiedAttempt(retentionToolArgs(packet), () => readLinuxMemoryAvailability({ reference }));
    output = response.content.map(part => part.text).join("\n");
    ok = (response.structuredContent as { readonly ok?: unknown }).ok === true;
  } catch (error) { output = error instanceof Error ? error.message : "unknown"; }
  createRetentionRecord(packet.operationId, "result", { schemaVersion: 3, operationId: packet.operationId, ok,
    outputSha256: retentionSha256(Buffer.from(output)), truncated: output.length > 32_000, output: output.slice(0, 32_000) });
  return { ok };
}

/**
 * IO of the closing step. Every read and the final create are separate IO, and the WORK window is sampled after each of them
 * and once more immediately before the create (a10 F7): a read that began inside the window and returned after it cannot prove
 * the evidence was positive INSIDE the window, so it never reaches `closed`.
 */
export type RetentionCloseIo = Readonly<{
  read(operationId: string, record: "supervisor" | "result" | "container"): Buffer | null;
  /** `undefined` only when the group is gone (ENOENT); any other failure throws. */
  readCgroupEvents(cgroup: string): string | undefined;
  create(operationId: string, record: "closed", value: unknown): Buffer;
  /** Throws once the packet's WORK window has ended. */
  assertInWindow(): void;
}>;
const realCloseIo = (packet: HostedRetentionPacket): RetentionCloseIo => ({
  read: readRetentionRecord,
  readCgroupEvents: cgroup => {
    try { return readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.events`, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
  },
  create: createRetentionRecord,
  assertInWindow: () => { retentionBudgetMs(packet, false, Date.now(), process.hrtime.bigint()); },
});

/** The operation closes only from retained positive evidence; anything else stays HELD for same-attempt reconciliation. */
export function closeRetentionOperation(packet: HostedRetentionPacket, exitCode: number, io: RetentionCloseIo = realCloseIo(packet)): { readonly ok: boolean } {
  const id = packet.operationId;
  const supervisor = io.read(id, "supervisor") ?? retentionHeld("supervisor_record_missing"); io.assertInWindow();
  const resultBytes = io.read(id, "result") ?? retentionHeld("result_record_missing"); io.assertInWindow();
  const result = decodeRetentionJson(resultBytes) as { operationId?: unknown; ok?: unknown };
  if (result.operationId !== id || typeof result.ok !== "boolean") retentionHeld("result_record_invalid");
  if (packet.launch.kind === HostedRetentionLaunchKind.DockerTest) {
    // Positive terminal evidence for the TEST container: its recorded cgroup must be empty (or gone). The lifecycle already
    // returned only after a fresh inspect showed it stopped.
    const container = parseHostedRetentionContainerRecord(decodeRetentionJson(io.read(id, "container") ?? retentionHeld("container_record_missing"))); io.assertInWindow();
    const events = io.readCgroupEvents(container.cgroup); io.assertInWindow();
    if (events !== undefined && !/^populated 0$/m.test(events)) retentionHeld("container_group_populated");
  }
  if (exitCode !== 0 && result.ok) retentionHeld("exit_code_contradicts_result");
  io.assertInWindow(); // immediately before the claim
  io.create(id, "closed", { schemaVersion: 3, operationId: id, exitCode, ok: result.ok,
    supervisorSha256: retentionSha256(supervisor), resultSha256: retentionSha256(resultBytes) });
  return { ok: result.ok };
}

/**
 * What the ORIGINAL installation unit looks like to the outside cleanup owner. Positive facts only: an unreadable or absent
 * group is not "empty". `invocationId` is `null` in the expectation only when the issuer never bound the supervisor.
 * `bootId` is the funded boot; `authority` is non-null only when the issuer's own bound record (unit, boot, birth, invocation,
 * group) agreed with the supervisor's self-record AND the issuer's retained LIVE observation of the original leaf's parent chain
 * (`original-leaf-chain.json`, written while the unit was alive) belongs to the same unit/boot/group: the retained invocation
 * really belongs to the admitted supervisor birth, and these exact parent directories are the ones that held the genuine live leaf.
 */
export type OriginalCgroupNode = Readonly<{ path: string; dev: number; ino: number }>;
export type OriginalRetiredAuthority = Readonly<{ parents: readonly OriginalCgroupNode[] }>;
export type OriginalUnitExpectation = Readonly<{ controlGroup: string; invocationId: string | null; bootId: string; authority: OriginalRetiredAuthority | null }>;
/** One authenticated sample of the manager's view of the unit. `controlGroup` and `invocationId` are `""` when systemd reports none. */
export type OriginalUnitSample = Readonly<{ bootId: string; loadState: string; activeState: string; mainPid: string; jobPresent: boolean; controlGroup: string; invocationId: string }>;
/** `empty`: the exact original leaf exists and every node reports empty. `absent_proved`: the bound parent chain is a live cgroup2 path and the exact leaf name is absent. Anything else is `not_proved`. */
export type OriginalLeafObservation = "empty" | "absent_proved" | "not_proved";
/**
 * The leaf observation is bracketed by two unit samples; they must be identical or the observation drifted. `parents` is the held
 * ancestry (slice directories below the cgroup2 root, with device/inode) that the bound observation actually opened.
 */
export type OriginalUnitFacts = Readonly<{ before: OriginalUnitSample; leaf: OriginalLeafObservation; parents: readonly OriginalCgroupNode[]; after: OriginalUnitSample }>;
/** The LoadState of a unit the manager still holds (a failed unit keeps its record and invocation). */
const knownUnitLoadState = "loaded";
/**
 * The LoadState of a unit the manager has already collected. PHYSICALLY (Root receipt runtime-systemd-loadstate-a2-actual.json) a
 * normally exited or stopped transient unit becomes `not-found`/`inactive`/`dead` with empty group and invocation, and a NEVER-created
 * unit prints exactly the same. The string therefore proves nothing: it is accepted only on top of retained, authenticated authority.
 */
const retiredUnitLoadState = "not-found";
const unitSampleKeys = ["bootId", "loadState", "activeState", "mainPid", "jobPresent", "controlGroup", "invocationId"] as const;
const sameAncestry = (observed: readonly OriginalCgroupNode[], retained: readonly OriginalCgroupNode[]) =>
  retained.length > 0 && observed.length === retained.length && observed.every((node, at) => node.path === retained[at]!.path && node.dev === retained[at]!.dev && node.ino === retained[at]!.ino);
/**
 * Pure. Throws HELD for a REPLACED unit (another boot, group or invocation: the facts belong to something else and waiting cannot
 * repair that), for an absence or a `not-found` unit that cannot be authenticated, or for parents that are not the retained ones;
 * returns the first still-pending fact, or `null` only when EVERY custody fact holds. Three distinct accepting shapes:
 *
 * 1. EXISTING EMPTY leaf (`loaded`): every node empty, systemd still names the original group and a retained invocation.
 * 2. LOADED + BOUND-ABSENT (a `failed` unit keeps its record): the leaf is gone, systemd reports an empty group and the RETAINED
 *    invocation exactly; the bound parents equal the retained live ancestry. An empty invocation on a loaded unit is not authority.
 * 3. AUTHENTICATED-RETIRED `not-found` (a normally exited or stopped unit that systemd collected): ActiveState `inactive`,
 *    MainPID 0, no job, EMPTY group and invocation on both samples, the leaf proved absent under parents equal to the retained live
 *    ancestry, and non-null `authority` (issuer record + supervisor self-record + retained live chain). Without that authority
 *    `not-found` is HELD, which is what a never-created unit looks like. Empty group/invocation are never authority by themselves.
 *
 * A NON-empty invocation or group that differs from the retained one is a replacement and is never substituted.
 */
export function originalUnitPending(facts: OriginalUnitFacts, expected: OriginalUnitExpectation): string | null {
  for (const sample of [facts.before, facts.after]) {
    if (sample.bootId !== expected.bootId) retentionHeld("original_unit_replaced:boot");
    if (sample.controlGroup !== "" && sample.controlGroup !== expected.controlGroup) retentionHeld("original_unit_replaced:control_group");
    if (sample.invocationId !== "" && expected.invocationId !== null && sample.invocationId !== expected.invocationId) retentionHeld("original_unit_replaced:invocation");
  }
  if (unitSampleKeys.some(key => facts.before[key] !== facts.after[key])) return "observation_drift";
  const unit = facts.before, retired = unit.loadState === retiredUnitLoadState;
  if (unit.loadState !== knownUnitLoadState && !retired) return `unit_not_known:${unit.loadState}`;
  // Waiting cannot create missing authority: an unauthenticated `not-found` unit (never created, or someone else's) is HELD at once.
  if (retired && (expected.invocationId === null || expected.authority === null)) retentionHeld("original_unit_unauthenticated");
  if (unit.activeState !== "inactive" && unit.activeState !== "failed") return `unit_not_terminal:${unit.activeState}`;
  if (retired && unit.activeState !== "inactive") return `retired_unit_not_inactive:${unit.activeState}`;
  if (unit.mainPid !== "0") return "main_pid_alive";
  if (unit.jobPresent) return "job_present";
  if (retired && (unit.controlGroup !== "" || unit.invocationId !== "")) return "retired_unit_reports_identity";
  if (facts.leaf === "not_proved") return "group_not_empty";
  if (facts.leaf === "empty") {
    // An existing leaf contradicts a collected unit, and otherwise keeps its CURRENT binding.
    if (retired) return "retired_unit_with_live_leaf";
    if (unit.controlGroup !== expected.controlGroup) return "control_group_unbound_for_live_leaf";
    if (unit.invocationId === "") return "invocation_unretained_for_live_leaf";
    return null;
  }
  // `absent_proved`: authenticate BEFORE accepting the absence, and bind the parents to the ones that held the genuine live leaf.
  if (expected.invocationId === null || expected.authority === null) retentionHeld("original_unit_unauthenticated");
  if (!sameAncestry(facts.parents, expected.authority.parents)) retentionHeld("original_leaf_parents_unbound");
  if (retired) return null;
  if (unit.controlGroup !== "") return "control_group_reported_for_absent_leaf";
  if (unit.invocationId !== expected.invocationId) return "invocation_empty_for_loaded_unit";
  return null;
}
/**
 * The facts the caller already holds BEFORE it derives an expectation: the funded operation, the original unit and its exact group,
 * the funded machine and boot, and the machine and boot read live now. `controlGroup` must end in `/${unit}` below at least one slice.
 */
export type OriginalUnitIdentity = Readonly<{
  operationId: string; unit: string; controlGroup: string; hostId: string; bootId: string; liveHostId: string; liveBootId: string;
}>;
/**
 * The raw bytes of the three records, as the private root-owned reader returned them (`null` = absent): the issuer's bound
 * `original-supervisor.json`, the supervisor's own `<id>.supervisor.json` and the issuer's retained live `original-leaf-chain.json`.
 * Reading them stays with the caller's private/held reader; this module never opens a path and grants nothing to arbitrary bytes.
 */
export type OriginalUnitRecordBytes = Readonly<{ bound: Uint8Array | null; self: Uint8Array | null; chain: Uint8Array | null }>;
const supervisorRecordKeys = ["operationId", "unit", "bootId", "birth", "invocationId", "controlGroup"] as const;
const safeDevice = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const safeInode = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
function closedRecord(bytes: Uint8Array, keys: readonly string[], what: string): Record<string, unknown> {
  const value = decodeRetentionJson(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) retentionHeld(`${what}_record_shape`);
  return value as Record<string, unknown>;
}
/**
 * Pure. The ONE derivation of the expectation `originalUnitPending` is judged against, shared by the outside cleanup gate and the
 * issuer's final closure. A mismatch of ANY identity field is HELD with a field-specific reason (waiting cannot repair a foreign or
 * reused record); an ABSENT record only withholds authority (`authority: null`), which makes a collected unit HELD in the predicate.
 *
 *  1. Machine and boot: the live machine/boot must be the funded ones.
 *  2. Bound record (issuer, written from a live physical bind): same operation, unit, exact original group and funded boot, and a
 *     well-formed retained invocation. No bound record = no retained invocation, no authority.
 *  3. Supervisor self-record (written by the admitted supervisor process itself): every field (operation, unit, boot, BIRTH,
 *     INVOCATION, group) must equal the bound record: two independent writers agree on the admitted birth. Absent = no authority.
 *  4. Retained live chain (issuer, taken from the live unit): same operation, unit, boot and group, the exact slice paths of the
 *     original group in order with sane device/inode, and a sane leaf identity. Absent = no authority.
 *
 * Not a grant: the live supervisor/unit/cgroup observation and the private-record custody of the reader remain the caller's.
 */
export function deriveOriginalUnitExpectation(identity: OriginalUnitIdentity, records: OriginalUnitRecordBytes): OriginalUnitExpectation {
  const groups = identity.controlGroup.split("/").slice(1);
  if (groups.pop() !== identity.unit || groups.length < 1) retentionHeld("identity_group_invalid");
  if (identity.liveHostId !== identity.hostId) retentionHeld("machine_mismatch");
  if (identity.liveBootId !== identity.bootId) retentionHeld("boot_stale");
  const base = { controlGroup: identity.controlGroup, bootId: identity.bootId };
  if (!records.bound) return { ...base, invocationId: null, authority: null };
  const expectedFields = { operationId: identity.operationId, unit: identity.unit, controlGroup: identity.controlGroup, bootId: identity.bootId };
  const bound = closedRecord(records.bound, supervisorRecordKeys, "bound");
  for (const [key, value] of Object.entries(expectedFields)) if (bound[key] !== value) retentionHeld(`bound_record_mismatch:${key}`);
  const { invocationId, birth } = bound;
  if (typeof invocationId !== "string" || !/^[a-f0-9]{32}$/.test(invocationId)) retentionHeld("bound_invocation_invalid");
  if (typeof birth !== "string" || birth === "") retentionHeld("bound_birth_invalid");
  const unauthenticated = { ...base, invocationId, authority: null };
  if (!records.self) return unauthenticated;
  const self = closedRecord(records.self, supervisorRecordKeys, "supervisor_self");
  for (const key of supervisorRecordKeys) if (self[key] !== bound[key]) retentionHeld(`supervisor_record_mismatch:${key}`);
  if (!records.chain) return unauthenticated;
  const chain = closedRecord(records.chain, ["operationId", "unit", "bootId", "controlGroup", "parents", "leaf"], "leaf_chain");
  for (const [key, value] of Object.entries(expectedFields)) if (chain[key] !== value) retentionHeld(`leaf_chain_mismatch:${key}`);
  const slices = groups.map((_, at) => "/" + groups.slice(0, at + 1).join("/")), rows = chain.parents;
  if (!Array.isArray(rows) || rows.length !== slices.length) retentionHeld("leaf_chain_parents_invalid");
  const parents = (rows as unknown[]).map((row, at): OriginalCgroupNode => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== "dev,ino,path") retentionHeld("leaf_chain_parents_invalid");
    const { path, dev, ino } = row as Record<string, unknown>;
    if (path !== slices[at] || !safeDevice(dev) || !safeInode(ino)) retentionHeld("leaf_chain_parents_invalid");
    return Object.freeze({ path: path as string, dev, ino });
  });
  const leaf = chain.leaf as Record<string, unknown> | null;
  if (!leaf || typeof leaf !== "object" || Array.isArray(leaf) || Object.keys(leaf).sort().join(",") !== "dev,ino" || !safeDevice(leaf.dev) || !safeInode(leaf.ino)) retentionHeld("leaf_chain_leaf_invalid");
  return { ...base, invocationId, authority: Object.freeze({ parents: Object.freeze(parents) }) };
}
/**
 * Bounded proof that the original unit is terminal. `stop --no-block` and the proxy closing are asynchronous with respect to
 * the unit, so a still-pending fact is polled until the window runs out and then HELD; a replaced unit is HELD immediately.
 * The proof is only as good as its last observation: it is accepted only if the window still holds AFTER that observation.
 */
export async function proveOriginalUnitTerminal(expected: OriginalUnitExpectation, observe: () => OriginalUnitFacts,
  window: Readonly<{ remainingMs(): number; sleep(ms: number): Promise<void> }>, pollMs = 200): Promise<void> {
  const left = () => { try { return window.remainingMs(); } catch { return 0; } };
  let last = "not_observed";
  for (;;) {
    let facts: OriginalUnitFacts | undefined;
    try { facts = observe(); } catch (error) { last = `observation_failed:${error instanceof Error ? error.message : "unknown"}`; }
    if (facts) {
      const pending = originalUnitPending(facts, expected);
      if (pending === null) { if (left() < 1) retentionHeld("original_unit_not_terminal:window_ended_after_observation"); return; }
      last = pending;
    }
    if (left() <= pollMs) retentionHeld(`original_unit_not_terminal:${last}`);
    await window.sleep(pollMs);
  }
}

/**
 * The OUTSIDE cleanup owner of the TEST container, called by the installation issuer (or by the recovery entry, see
 * `recoverOwnedRetentionCleanup` in the bootstrap) bounded by a cleanup window. It holds no retention authority: it never funds,
 * starts or runs anything, it reads only what the admitted supervisor bound before each step, and it can only stop the exact
 * owned container (see `cleanupOwnedDockerTestContainer`).
 *
 * "The supervisor never published a packet, so it created nothing" is only true of a supervisor that can no longer act. The
 * original unit is therefore proved terminal FIRST (`gate`), before the packet is read, and again before the Docker ownership
 * is read; the gate is a required argument, so there is no call that cleans up on the strength of a proxy closure alone.
 */
export async function cleanupOwnedRetentionContainer(operationId: string, gate: OutsideCleanupGate): Promise<OutsideCleanupResult> {
  assertHostedActivationOperator();
  try { await gate.proveOriginalTerminal(); }
  catch (error) { return { ok: false, outcome: HostedRetentionCleanupOutcome.CleanupUnproved, containerId: null, reason: `original_unit_unproved:${error instanceof Error ? error.message : "unknown"}` }; }
  const packetBytes = readRetentionRecord(operationId, "packet");
  if (!packetBytes) return { ok: true, outcome: HostedRetentionCleanupOutcome.NoContainer, containerId: null };
  const packet = parseHostedRetentionPacket(decodeRetentionJson(packetBytes));
  if (packet.operationId !== operationId) retentionHeld("operation_id_mismatch");
  if (packet.launch.kind !== HostedRetentionLaunchKind.DockerTest) return { ok: true, outcome: HostedRetentionCleanupOutcome.NoContainer, containerId: null };
  return cleanupOwnedDockerTestContainer(packet, gate);
}

/** TEST container only: inside the pinned container the process re-authenticates against records the admitted supervisor wrote. */
export async function runRetentionOperationSupervisor(operationId: string): Promise<{ readonly ok: boolean }> {
  assertHostedActivationOperator();
  const { packet, packetBytes } = loadPacket(operationId);
  if (packet.launch.kind !== HostedRetentionLaunchKind.DockerTest) retentionHeld("launch_kind_not_container");
  const funded = parseHostedRetentionFunded(decodeRetentionJson(readRetentionRecord(operationId, "funded") ?? retentionHeld("funded_missing")));
  // The TEST container has no installation files; the admitted supervisor authenticated the chain and its funded record
  // pins this packet. The live boot/machine/runtime/window are still checked here.
  assertRetentionLiveFacts({ packet, liveBootId: collectBootId(), liveMachineId: readFileSync("/etc/machine-id", "utf8").trim(),
    runtimeDirectory: runtimeDirectoryOf(), nowEpochMs: Date.now(), nowMonotonicNs: process.hrtime.bigint() });
  await proveDockerContainerIdentity(packet);
  // The executable ACTUALLY running here (and the bootstrap it loaded) must be the pinned bytes of the admitted packet,
  // before any memory port or workload exists. The image cannot have substituted them: they are read-only bind mounts.
  proveContainerExecutable(packet);
  // Disposable fixtures only: the permit and every path it names must lie under the fixture root.
  await assertPermitInsideFixtureRoot(packet);
  // The topology observed NOW must be identical to the one the admitted supervisor funded; the reader re-observes it again.
  const reference = retentionMemoryReference({ packet, packetBytes, funded, live: observeHostMemoryTopology({ cgroupRoot: hostedMemoryTopologyMountPoint }) });
  createRetentionRecord(operationId, "supervisor", { schemaVersion: 3, operationId, kind: packet.launch.kind, birth: "container", bootId: packet.bootId,
    packetSha256: retentionSha256(packetBytes), memoryTopologySha256: retentionSha256(Buffer.from(JSON.stringify(funded.memoryTopology))) });
  return runRetentionTool(packet, reference);
}

async function assertPermitInsideFixtureRoot(packet: HostedRetentionPacket): Promise<void> {
  if (packet.launch.kind !== HostedRetentionLaunchKind.DockerTest) return;
  const root = packet.launch.fixtureRoot, within = (path: string) => path === root || path.startsWith(`${root}/`);
  const { permit } = await readRetainedNonqualifiedPermit(retentionToolArgs(packet));
  for (const path of [permit.registryRootDir, permit.workerJobRootDir, permit.sourceWorkspace, permit.archivePath, permit.evidenceRoot.path, permit.ledgerRoot.path]) {
    if (!within(path)) retentionHeld("permit_outside_fixture_root");
  }
}
