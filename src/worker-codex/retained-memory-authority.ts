import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { HostedActivation, HostedInstallation } from "@vioxen/subscription-runtime/worker-core";
import {
  hostedRetentionTool, type HostedRetentionFunded, type HostedRetentionPacket, type HostedMemoryTopologyIdentity,
} from "../core/host-infrastructure/host-retention-operation";
import { assertActivationSession } from "./hosted-activation-validation";
import type { HostMemoryReference } from "../worker-local/linux-memory-availability";
import type { RetainedNonqualifiedMcpArgs } from "./codex-goal-mcp-project-control-retained-nonqualified";

/**
 * Pure authentication of the RETENTION OPERATOR role. Everything here takes facts that the Host adapter already read
 * through the existing authenticated readers and compares them; there is no path, permit, environment value, scalar or
 * caller-chosen digest input. The authority chain is:
 *
 *   admitted installation (host-installation.json bytes pinned by the packet; its inventory pin; activation of THIS boot)
 *   -> retention packet (schemaVersion 3, role retention_operator, finite window, runtime/boot/machine)
 *   -> funded record written once by the OUTSIDE operator (packet hash + live topology identities)
 *   -> supervised unit / pinned TEST container that re-observes the same topology.
 *
 * The historical job being retained appears only as the permit named by the invocation; this role creates no origin,
 * no creator and no enrollment for it.
 */
export type RetentionOperationFacts = Readonly<{
  packet: HostedRetentionPacket; installation: HostedInstallation; activation: HostedActivation;
  installationBytes: Uint8Array; inventoryBytes: Uint8Array;
  liveBootId: string; liveMachineId: string; runtimeDirectory: string; nowEpochMs: number; nowMonotonicNs: bigint;
}>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function held(reason: string): never { throw new Error(`hosted_retention_operation_held:${reason}`); }

/** Remaining milliseconds of the finite operation window; a rolled-back or skewed clock yields none. */
export function retentionBudgetMs(packet: Pick<HostedRetentionPacket, "issuedEpochMs" | "workEndEpochMs" | "cleanupEndEpochMs" | "issuedMonotonicNs">,
  cleanup: boolean, nowEpochMs: number, nowMonotonicNs: bigint): number {
  const end = cleanup ? packet.cleanupEndEpochMs : packet.workEndEpochMs;
  const elapsed = Number((nowMonotonicNs - BigInt(packet.issuedMonotonicNs)) / 1_000_000n);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0 || nowEpochMs < packet.issuedEpochMs || nowEpochMs < packet.issuedEpochMs + elapsed - 1000) held("clock_or_window_invalid");
  const ms = Math.min(end - nowEpochMs, end - packet.issuedEpochMs - elapsed);
  if (ms < 1) held("window_ended");
  return Math.floor(ms);
}

/** The live facts every process of the role must match, wherever it runs (unit or pinned TEST container). */
export type RetentionLiveFacts = Pick<RetentionOperationFacts, "packet" | "liveBootId" | "liveMachineId" | "runtimeDirectory" | "nowEpochMs" | "nowMonotonicNs">;
export function assertRetentionLiveFacts(facts: RetentionLiveFacts): void {
  const { packet } = facts;
  if (facts.liveMachineId !== packet.hostId) held("machine_mismatch");
  if (facts.runtimeDirectory !== packet.runtimeDirectory) held("runtime_mismatch");
  if (facts.liveBootId !== packet.bootId) held("boot_mismatch");
  retentionBudgetMs(packet, false, facts.nowEpochMs, facts.nowMonotonicNs);
}

/**
 * The admitted installation chain, authenticated by the OUTSIDE operator and by the supervised unit (the TEST container
 * has no installation files and relies on the operator's funded record, which pins this packet by hash).
 */
export function assertRetentionOperationFacts(facts: RetentionOperationFacts): void {
  const { packet, installation, activation } = facts;
  // The admitted installation, by exact bytes: a substituted or re-created installation cannot satisfy the pin.
  if (sha(facts.installationBytes) !== packet.installationSha256) held("installation_substituted");
  if (installation.inventorySha256 !== packet.inventorySha256 || sha(facts.inventoryBytes) !== packet.inventorySha256) held("inventory_substituted");
  if (installation.hostId !== packet.hostId || activation.hostId !== packet.hostId) held("machine_mismatch");
  if (installation.runtimeDirectory !== packet.runtimeDirectory ||
      installation.runtimeSha !== packet.runtimeSha || installation.runtimeManifestSha256 !== packet.runtimeManifestSha256) held("runtime_mismatch");
  if (activation.installationId !== installation.installationId) held("activation_installation_mismatch");
  // The installation must have been re-sessioned in THIS boot by the normal lifecycle; a reboot needs that first.
  if (activation.bootId !== packet.bootId) held("boot_mismatch");
  assertRetentionLiveFacts(facts);
}

/**
 * ADMISSION of the outside operator. `session` is what the EXISTING kernel returned (`HostedReadonlyHostKernel.operatorSession()`:
 * the caller is in the admitted supervisor's own cgroup and, for V5, is that supervisor process, with live boot, machine and
 * supervisor identity). Parsing records or being root in the initial namespaces is not admission. The installed activation
 * must belong to exactly that session (the same comparison every normal installation operation makes), and the session must
 * be the boot and machine the packet names. A stale or replaced session, a lookalike installation or another supervisor refuses.
 */
export type RetentionOperatorSession = Readonly<{ hostId: string; bootId: string; supervisorId: string }>;
export function assertRetentionOperatorAdmission(input: Readonly<{
  packet: Pick<HostedRetentionPacket, "hostId" | "bootId">; activation: HostedActivation; session: RetentionOperatorSession;
}>): void {
  try { assertActivationSession(input.activation, input.session); }
  catch { held("operator_session_activation_mismatch"); }
  if (input.session.hostId !== input.packet.hostId || input.session.bootId !== input.packet.bootId) held("operator_session_packet_mismatch");
}
/** The supervised child only continues for the exact admitted session recorded when the operation was funded. */
export function assertRetentionFundedSession(funded: Pick<HostedRetentionFunded, "session">, activation: HostedActivation): void {
  if (funded.session.hostId !== activation.hostId || funded.session.bootId !== activation.bootId ||
      funded.session.supervisorId !== activation.supervisorId) held("funded_session_stale");
}

/**
 * The funded record must be the outside operator's record for exactly this packet, and the topology observed NOW must be
 * identical to the one it recorded (boot, machine and every identity). The returned reference is what the memory reader
 * consumes; the reader still re-observes and re-checks everything, so this is not the only line of defence.
 */
export function retentionMemoryReference(input: Readonly<{
  packet: HostedRetentionPacket; packetBytes: Uint8Array; funded: HostedRetentionFunded; live: HostMemoryReference;
}>): HostMemoryReference {
  const refuse = (reason: string): never => { throw new Error(`linux_memory_unknown:${reason}`); };
  if (input.funded.operationId !== input.packet.operationId || input.funded.packetSha256 !== sha(input.packetBytes)) refuse("host_reference_not_funded");
  if (input.live.bootId !== input.packet.bootId) refuse("host_reference_stale_boot");
  if (input.live.machineId !== input.packet.hostId) refuse("host_reference_machine_mismatch");
  const recorded: HostedMemoryTopologyIdentity = input.funded.memoryTopology;
  if (!isDeepStrictEqual(recorded, input.live.topology)) refuse("host_reference_hierarchy_mismatch");
  return Object.freeze({ bootId: input.packet.bootId, machineId: input.packet.hostId, topology: recorded });
}

/** The ONE closed tool invocation of the role, mapped to the real retention MCP entry arguments. */
export function retentionToolArgs(packet: HostedRetentionPacket): RetainedNonqualifiedMcpArgs {
  const call = packet.retention;
  if (call.tool !== hostedRetentionTool) held("tool_not_admitted");
  return { controllerJobId: call.controllerJobId, workerJobId: call.workerJobId, permitFile: call.permitFile,
    expectedPermitSha256: call.expectedPermitSha256, confirmRetention: call.confirmRetention,
    ...(call.expectedPlanSha256 === undefined ? {} : { expectedPlanSha256: call.expectedPlanSha256 }),
    ...(call.registryRootDir === undefined ? {} : { registryRootDir: call.registryRootDir }) };
}
