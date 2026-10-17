import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  HostedRetentionCleanupOutcome, HostedRetentionLaunchKind, hostedMemoryTopologyMountPoint, hostedRetentionCleanupClosing,
  parseHostedRetentionCleanup, parseHostedRetentionContainerRecord, parseHostedRetentionCreated, parseHostedRetentionIntent,
  type HostedRetentionCleanup, type HostedRetentionContainerRecord, type HostedRetentionCreated, type HostedRetentionIntent,
  type HostedRetentionMount, type HostedRetentionPacket,
} from "../core/host-infrastructure/host-retention-operation";
import { readTrustedFragment } from "./hosted-readonly-host-kernel";
import { collectProcessCgroup, collectSelfCgroup } from "./hosted-readonly-linux-collector";
import { createRetentionRecord, decodeRetentionJson, readRetentionRecord, retentionHeld, retentionOperationRoot, retentionRecordPath, retentionSha256 } from "./retention-operation-records";

/**
 * TRUSTED SOURCE TEST launcher of the retention operator role. It uses the SAME role and admission as the supervisor-resident
 * route: the admitted installation supervisor (admitted by the existing kernel operator session) authenticated the installation,
 * the packet and the live topology and wrote the funded record BEFORE any container exists. This module only differs in how
 * the worked-on process is born, identified and bounded. The supervisor creates, funds and starts the container; the OUTSIDE
 * installation issuer, which outlives it, is the cleanup owner (`cleanupOwnedDockerTestContainer`). Nothing here is production
 * authority and nothing is executed by its author:
 *
 * - The container shares the HOST cgroup namespace and sees the COMPLETE hierarchy read-only; its PID namespace stays
 *   PRIVATE, so it establishes NO full-host process custody and cannot qualify the full-host scanner.
 * - Disposable fixtures only: every non-required mount, the permit file, the registry and every path inside the permit
 *   must lie under the packet's `fixtureRoot`, which must be a TEST/.tmp area. No original job path can be mounted.
 * - The executable is the PINNED host file, bind-mounted read-only over the entrypoint path, so the image cannot substitute
 *   other bytes there; the in-container supervisor re-hashes the file it actually runs (and `/proc/self/exe`) against the
 *   packet before it builds the memory port. The image must supply compatible shared libraries (a qualification caveat).
 * - Exact identity: the image is pinned by id, mounts by (source, target, mode), and the container carries a label with the
 *   operation id; after start the operator records container id, host pid, cgroup and kernel start ticks.
 * - The finite window is enforced by the OPERATOR across create, start and work, with bounded cleanup of ONLY the exact owned
 *   container (fresh id + image + label proof, and the recorded birth before any signal). A CLI timeout is never treated as
 *   container termination. If the stop cannot be proved the lifecycle fails HELD with the container left as evidence.
 * - Partial or uncertain effects stay on disk: the funded record is create-once, a container is never removed or
 *   re-created by this code, and no new attempt for the same permit starts until the previous one is `closed`.
 * - Docker command/inspect field spelling is UNVERIFIED against current Docker documentation (no network here).
 * - No environment value, JSON argument or test flag selects anything: the packet (private, root-owned, hash-funded) does.
 */
const dockerExecutable = "/usr/bin/docker";
const requiredFixtureRoot = /\/(?:\.tmp-[A-Za-z0-9._-]+|TEST-[A-Za-z0-9._-]+)(?:\/|$)/;
const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
export const retentionContainerLabel = "subscription-runtime.retention-operation";

export const retentionTestContainerName = (operationId: string) => `subscription-runtime-retention-test-${operationId}`;

type DockerTestPacket = HostedRetentionPacket & { readonly launch: Extract<HostedRetentionPacket["launch"], { kind: HostedRetentionLaunchKind.DockerTest }> };
function dockerLaunch(packet: HostedRetentionPacket): DockerTestPacket["launch"] {
  if (packet.launch.kind !== HostedRetentionLaunchKind.DockerTest) retentionHeld("not_a_docker_test_packet");
  return packet.launch;
}

/**
 * The exact mount set the TEST container may have. Required: the complete host cgroup2 hierarchy READ-ONLY (so every
 * enforcing ancestor is visible), the operation records (packet and funded READ-ONLY; this operation's own directory
 * writable), the host machine id, the runtime and the PINNED node executable READ-ONLY. Anything else must be a fixture
 * path under `fixtureRoot`.
 */
export function assertDockerTestMounts(packet: HostedRetentionPacket): readonly HostedRetentionMount[] {
  const launch = dockerLaunch(packet);
  if (!requiredFixtureRoot.test(launch.fixtureRoot)) retentionHeld("fixture_root_not_test_area");
  const need = (source: string, readonly: boolean, target = source) => {
    const found = launch.mounts.find(m => m.target === target);
    if (!found || found.source !== source || found.readonly !== readonly) retentionHeld(`mount_missing_or_wrong:${target}`);
  };
  need(hostedMemoryTopologyMountPoint, true);
  need(retentionOperationRoot, true);
  need(`${retentionOperationRoot}/${packet.operationId}`, false);
  need("/etc/machine-id", true);
  need(packet.runtimeDirectory, true);
  // The executable that actually runs is this very host file, mounted over the entrypoint path: the image cannot replace it.
  need(packet.node.path, true);
  const required = new Set([hostedMemoryTopologyMountPoint, retentionOperationRoot, `${retentionOperationRoot}/${packet.operationId}`, "/etc/machine-id", packet.runtimeDirectory, packet.node.path]);
  for (const mount of launch.mounts) {
    if (required.has(mount.target)) continue;
    if (mount.source !== mount.target || !within(launch.fixtureRoot, mount.source)) retentionHeld(`mount_outside_fixture_root:${mount.target}`);
  }
  if (!within(launch.fixtureRoot, packet.retention.permitFile) ||
      (packet.retention.registryRootDir !== undefined && !within(launch.fixtureRoot, packet.retention.registryRootDir))) retentionHeld("invocation_outside_fixture_root");
  // The fixture root itself must be mounted writable at its own path, or the tool has no registry to act on.
  need(launch.fixtureRoot, false);
  return launch.mounts;
}

/** `docker create` arguments; no shell, no environment, no privilege, no network. Pure. */
export function dockerTestCreateArgs(packet: HostedRetentionPacket): readonly string[] {
  const launch = dockerLaunch(packet);
  const mounts = assertDockerTestMounts(packet);
  return ["create", "--name", retentionTestContainerName(packet.operationId), `--label=${retentionContainerLabel}=${packet.operationId}`,
    "--cgroupns=host", "--network=none", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=512", "--user=0:0", "--workdir=/", "--entrypoint", packet.node.path,
    ...mounts.flatMap(m => ["--mount", `type=bind,source=${m.source},target=${m.target}${m.readonly ? ",readonly" : ""}`]),
    launch.image, packet.bootstrap.path, "--retention-operation", packet.operationId];
}

/** The created container must be exactly what the packet pinned: image, label, host cgroup namespace, private PID, no privilege, exact mounts. Pure. */
export function assertDockerInspect(inspect: unknown, packet: HostedRetentionPacket): string {
  const launch = dockerLaunch(packet);
  const row = Array.isArray(inspect) && inspect.length === 1 ? inspect[0] as Record<string, unknown> : retentionHeld("inspect_not_single");
  const host = (row.HostConfig ?? {}) as Record<string, unknown>;
  const id = row.Id;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) retentionHeld("container_id_invalid");
  assertOwnedContainer(row, packet, id);
  if (host.CgroupnsMode !== "host") retentionHeld("cgroup_namespace_not_host");
  if (host.PidMode !== "" && host.PidMode !== undefined) retentionHeld("pid_namespace_not_private");
  if (host.Privileged !== false || host.NetworkMode !== "none" || (Array.isArray(host.CapAdd) && host.CapAdd.length > 0)) retentionHeld("privilege_or_network");
  const actual = (Array.isArray(row.Mounts) ? row.Mounts : []).map(raw => {
    const m = raw as Record<string, unknown>;
    return m.Type === "bind" && typeof m.Source === "string" && typeof m.Destination === "string" && typeof m.RW === "boolean"
      ? { source: m.Source, target: m.Destination, readonly: !m.RW } : retentionHeld("mount_not_bind");
  }).sort((a, b) => a.target.localeCompare(b.target));
  const expected = launch.mounts.map(m => ({ source: m.source, target: m.target, readonly: m.readonly })).sort((a, b) => a.target.localeCompare(b.target));
  if (!isDeepStrictEqual(actual, expected)) retentionHeld("mounts_mismatch");
  return id;
}

/** Ownership of ONE container, proven freshly before every signal: exact id, pinned image and this operation's label. Pure. */
export function assertOwnedContainer(row: Record<string, unknown>, packet: HostedRetentionPacket, expectedId: string): void {
  const launch = dockerLaunch(packet);
  const labels = ((row.Config ?? {}) as { Labels?: Record<string, unknown> | null }).Labels ?? {};
  if (row.Id !== expectedId) retentionHeld("container_not_owned:id");
  if (row.Image !== launch.image) retentionHeld("image_mismatch");
  if (labels[retentionContainerLabel] !== packet.operationId) retentionHeld("container_not_owned:label");
}

/** Container facts the operator observed after start, as the record the in-container supervisor must match. Pure. */
export function dockerContainerRecord(input: Readonly<{ packet: HostedRetentionPacket; containerId: string; hostPid: number; hostCgroup: string; startTicks: string }>): HostedRetentionContainerRecord {
  const launch = dockerLaunch(input.packet);
  const match = /^0::(\/.+)$/.exec(input.hostCgroup);
  if (!match) retentionHeld("host_cgroup_unresolved");
  return parseHostedRetentionContainerRecord({ schemaVersion: 3, operationId: input.packet.operationId, containerId: input.containerId, image: launch.image,
    cgroup: match[1], startTicks: input.startTicks, hostPid: input.hostPid, mounts: launch.mounts });
}

/** What the supervised process sees of itself inside the container. */
export type DockerContainerView = Readonly<{ pid: number; selfCgroup: string; startTicks: string; mountinfo: string }>;
/** The in-container supervisor accepts the operator's record only if its OWN view agrees. Pure. */
export function assertDockerContainerView(record: HostedRetentionContainerRecord, packet: HostedRetentionPacket, view: DockerContainerView): void {
  const launch = dockerLaunch(packet);
  if (record.operationId !== packet.operationId || record.image !== launch.image || !isDeepStrictEqual(record.mounts, launch.mounts)) retentionHeld("container_record_mismatch");
  if (view.pid !== 1) retentionHeld("not_container_init");
  if (view.selfCgroup !== `0::${record.cgroup}`) retentionHeld("container_cgroup_mismatch");
  if (view.startTicks !== record.startTicks) retentionHeld("container_birth_mismatch");
  const options = new Map<string, readonly string[]>();
  for (const line of view.mountinfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length > 5) options.set(fields[4]!, fields[5]!.split(","));
  }
  for (const mount of launch.mounts) {
    const flags = options.get(mount.target);
    if (!flags || flags.includes("ro") !== mount.readonly) retentionHeld(`container_mount_mismatch:${mount.target}`);
  }
}

/** The executable ACTUALLY running inside the container, against the admitted packet pins. Pure. */
export type ContainerExecutableView = Readonly<{ procSelfExe: string; execPath: string; nodeSha256: string; bootstrapSha256: string }>;
export function assertContainerExecutable(packet: HostedRetentionPacket, view: ContainerExecutableView): void {
  if (view.procSelfExe !== packet.node.path || view.execPath !== packet.node.path) retentionHeld("executable_path_mismatch");
  if (view.nodeSha256 !== packet.node.sha256) retentionHeld("executable_bytes_mismatch");
  if (view.bootstrapSha256 !== packet.bootstrap.sha256) retentionHeld("bootstrap_bytes_mismatch");
}
/** IN-CONTAINER: hash the bytes of the file this very process is running, before any port or workload exists. */
export function proveContainerExecutable(packet: HostedRetentionPacket): void {
  assertContainerExecutable(packet, { procSelfExe: readlinkSync("/proc/self/exe"), execPath: process.execPath,
    nodeSha256: retentionSha256(readTrustedFragment(packet.node.path, 256 * 1024 * 1024)),
    bootstrapSha256: retentionSha256(readTrustedFragment(packet.bootstrap.path)) });
}

// ---------------------------------------------------------------- finite, owned lifecycle

export type DockerCli = (args: readonly string[], timeoutMs: number) => string;
export type DockerLifecycleDeps = Readonly<{
  cli: DockerCli;
  clock: Readonly<{ nowMs(): number; sleep(ms: number): Promise<void> }>;
  observePid(pid: number): Readonly<{ cgroup: string; startTicks: string }>;
  recordContainer(packetOperationId: string, record: HostedRetentionContainerRecord): void;
  /** Custody records written BEFORE the step they announce (see `HostedRetentionIntent`). Create-once. */
  recordIntent(operationId: string, record: HostedRetentionIntent): void;
  recordCreated(operationId: string, record: HostedRetentionCreated): void;
  /** What the supervisor bound for this operation, read by the OUTSIDE cleanup owner. */
  readOwnership(operationId: string): Readonly<{ intent: HostedRetentionIntent | null; created: HostedRetentionCreated | null; container: HostedRetentionContainerRecord | null }>;
  /** The terminal cleanup receipt, if a previous call (or a recovery run) already retained a CLOSING outcome. */
  readCleanup(operationId: string): HostedRetentionCleanup | null;
  recordCleanup(operationId: string, record: HostedRetentionCleanup): void;
}>;
function dockerCli(args: readonly string[], timeoutMs: number): string {
  const result = spawnSync(dockerExecutable, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) retentionHeld(`docker_failed:${args[0] ?? "?"}`);
  return result.stdout;
}
function startTicksOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  return ticks && /^[1-9][0-9]{0,19}$/.test(ticks) ? ticks : retentionHeld("start_ticks_unreadable");
}
export const realDockerLifecycleDeps: DockerLifecycleDeps = {
  cli: dockerCli,
  clock: { nowMs: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) },
  observePid: pid => ({ cgroup: collectProcessCgroup(String(pid)), startTicks: startTicksOf(pid) }),
  recordContainer: (operationId, record) => { createRetentionRecord(operationId, "container", record); },
  recordIntent: (operationId, record) => { createRetentionRecord(operationId, "intent", record); },
  recordCreated: (operationId, record) => { createRetentionRecord(operationId, "created", record); },
  readOwnership: operationId => {
    const read = <T>(record: "intent" | "created" | "container", parse: (value: unknown) => T): T | null => {
      const bytes = readRetentionRecord(operationId, record);
      return bytes ? parse(decodeRetentionJson(bytes)) : null;
    };
    return { intent: read("intent", parseHostedRetentionIntent), created: read("created", parseHostedRetentionCreated), container: read("container", parseHostedRetentionContainerRecord) };
  },
  readCleanup: operationId => {
    const bytes = readRetentionRecord(operationId, "cleanup");
    return bytes ? parseHostedRetentionCleanup(decodeRetentionJson(bytes)) : null;
  },
  recordCleanup: (operationId, record) => { createRetentionRecord(operationId, "cleanup", record); },
};

type ContainerState = Readonly<{ running: boolean; pid: number; exitCode: number }>;
function stateOf(row: Record<string, unknown>): ContainerState {
  const state = (row.State ?? {}) as { Running?: unknown; Pid?: unknown; ExitCode?: unknown };
  if (typeof state.Running !== "boolean" || !Number.isSafeInteger(state.Pid) || !Number.isSafeInteger(state.ExitCode)) retentionHeld("container_state_unreadable");
  return { running: state.Running, pid: state.Pid as number, exitCode: state.ExitCode as number };
}

/**
 * OUTSIDE operator side, bounded by the packet's finite window (the operator passes the remaining work and cleanup
 * budgets, each already the tighter of the wall and monotonic clocks). Create, verify the exact container, start it,
 * record its identity, then POLL its state until it stops or the work deadline passes. Every command's timeout is capped by
 * the deadline that applies. On deadline, error or partial failure the exact owned container is stopped within the cleanup
 * budget and the stop is verified; the lifecycle then fails HELD (`container_stopped_after_failure`) or, if the stop cannot
 * be proved, `cleanup_unproved`, in both cases leaving the container and records as evidence. It returns only for a
 * container that ended by itself inside the window. Nothing is removed, restarted, re-created or signalled by name.
 */
export async function runOwnedDockerTestLifecycle(packet: HostedRetentionPacket, budget: Readonly<{ workMs: number; cleanupMs: number }>,
  deps: DockerLifecycleDeps = realDockerLifecycleDeps): Promise<{ readonly containerId: string; readonly exitCode: number }> {
  const start = deps.clock.nowMs(), workEnd = start + budget.workMs, cleanupEnd = start + budget.cleanupMs;
  if (!(budget.cleanupMs > budget.workMs)) retentionHeld("cleanup_budget_missing");
  const { run, inspect, within } = boundedDocker(deps);

  // Custody is announced BEFORE each step so the OUTSIDE cleanup owner (which outlives this supervisor) can act on exactly this
  // container: `intent` before create, `created` (the exact id) before start. A failure to announce stops the lifecycle there.
  const launch = dockerLaunch(packet);
  deps.recordIntent(packet.operationId, { schemaVersion: 3, operationId: packet.operationId, image: launch.image, label: retentionContainerLabel });
  within(workEnd, "intent_record");
  let id: string;
  try { id = run(dockerTestCreateArgs(packet), workEnd).trim(); }
  catch (error) {
    // No container id was returned: custody is UNKNOWN, and nothing is signalled by name. The operator holds the attempt.
    return retentionHeld(`create_uncertain:${error instanceof Error ? error.message : "unknown"}`);
  }
  if (!/^[a-f0-9]{64}$/.test(id)) retentionHeld("create_output_invalid");
  // The id is durably bound BEFORE start. If this cannot be recorded the container is never started (a created-not-started
  // container runs nothing) and the outside owner reports the creation as uncertain.
  deps.recordCreated(packet.operationId, { schemaVersion: 3, operationId: packet.operationId, containerId: id });
  within(workEnd, "created_record");

  let recorded: HostedRetentionContainerRecord | undefined;
  try {
    if (assertDockerInspect([inspect(id, workEnd)], packet) !== id) retentionHeld("container_id_changed");
    run(["start", id], workEnd);
    const started = stateOf(inspect(id, workEnd));
    if (!started.running || started.pid < 1) retentionHeld("container_not_running");
    const view = deps.observePid(started.pid);
    recorded = dockerContainerRecord({ packet, containerId: id, hostPid: started.pid, hostCgroup: view.cgroup, startTicks: view.startTicks });
    deps.recordContainer(packet.operationId, recorded);
    within(workEnd, "container_record");
    for (;;) {
      const left = Math.floor(workEnd - deps.clock.nowMs());
      if (left < 1) retentionHeld("work_deadline_expired");
      const state = stateOf(inspect(id, workEnd)); // returned inside the window (checked after the command, see boundedDocker)
      if (!state.running) {
        // Success is only claimed while the window still holds at the moment it is claimed.
        within(workEnd, "final_state");
        return { containerId: id, exitCode: state.exitCode };
      }
      await deps.clock.sleep(Math.min(1000, left));
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    try { await stopOwnedContainer(id, packet, recorded, deps, cleanupEnd, run, inspect, within); }
    catch (cleanupError) { return retentionHeld(`cleanup_unproved:${reason}:${cleanupError instanceof Error ? cleanupError.message : "unknown"}`); }
    return retentionHeld(`container_stopped_after_failure:${reason}`);
  }
}

type DockerRun = (args: readonly string[], end: number, cap?: number) => string;
type DockerInspect = (id: string, end: number) => Record<string, unknown>;
type DockerWithin = (end: number, what: string) => void;
/**
 * Every effect is bounded on BOTH sides. Before a command the remaining time caps its timeout (a CLI timeout is never treated
 * as container death); AFTER it returns the deadline is checked again, because a command that started inside the window and
 * returned late cannot prove WHEN it completed. Defined boundary: an observation that returns with less than 1 ms left (or
 * exactly at the deadline) is LATE and is never accepted as success or as in-budget cleanup proof.
 */
function boundedDocker(deps: DockerLifecycleDeps): { run: DockerRun; inspect: DockerInspect; within: DockerWithin } {
  const within: DockerWithin = (end, what) => { if (Math.floor(end - deps.clock.nowMs()) < 1) retentionHeld(`deadline_after:${what}`); };
  const run: DockerRun = (args, end, cap = 30_000) => {
    const ms = Math.min(cap, Math.floor(end - deps.clock.nowMs()));
    if (ms < 1) retentionHeld("deadline_before_command");
    const output = deps.cli(args, ms);
    within(end, `command:${args[0] ?? "?"}`);
    return output;
  };
  const inspect: DockerInspect = (id, end) => {
    const parsed = JSON.parse(run(["inspect", id], end)) as unknown;
    return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] as Record<string, unknown> : retentionHeld("inspect_not_single");
  };
  return { run, inspect, within };
}

/**
 * Stop ONLY the exact owned container, escalating within the cleanup budget, and require a fresh stopped state observed inside
 * that budget. Returns whether this call had to signal (`stopped`) or found nothing running (`already_stopped`).
 */
async function stopOwnedContainer(id: string, packet: HostedRetentionPacket, recorded: HostedRetentionContainerRecord | undefined,
  deps: DockerLifecycleDeps, cleanupEnd: number, run: DockerRun, inspect: DockerInspect, within: DockerWithin): Promise<"stopped" | "already_stopped"> {
  let row = inspect(id, cleanupEnd);
  assertOwnedContainer(row, packet, id);
  let state = stateOf(row);
  if (!state.running) return "already_stopped"; // created but never started, or already ended: nothing is signalled
  if (recorded !== undefined && deps.observePid(state.pid).startTicks !== recorded.startTicks) retentionHeld("container_birth_changed");
  within(cleanupEnd, "birth_check");
  try { run(["stop", "--time=5", id], cleanupEnd, 20_000); } catch { /* escalate below; the verified final state decides */ }
  let killed = false;
  for (;;) {
    const left = Math.floor(cleanupEnd - deps.clock.nowMs());
    if (left < 1) retentionHeld("still_running_at_cleanup_end");
    row = inspect(id, cleanupEnd); // a stopped observation that returns after the cleanup end is late and throws here
    assertOwnedContainer(row, packet, id);
    state = stateOf(row);
    if (!state.running) { within(cleanupEnd, "cleanup_final_state"); return "stopped"; }
    if (!killed) { killed = true; try { run(["kill", id], cleanupEnd, 10_000); } catch { /* the loop re-verifies the actual state */ } }
    await deps.clock.sleep(Math.min(250, left));
  }
}

/**
 * The OUTSIDE cleanup owner (run by the installation issuer, which outlives the supervisor and owns the operation through its
 * separate cleanup window). It acts only on what the admitted supervisor durably bound BEFORE the step: no `intent` means no
 * container can exist; `intent` without `created` is an UNCERTAIN creation (nothing was started, nothing is signalled, nothing
 * is looked up by name or retried); `created` names the exact container, which is stopped only after a fresh id + pinned image
 * + operation-label proof (and the recorded birth when the supervisor got that far).
 *
 * ORDER IS THE CONTRACT (a10 F1). The admitted supervisor can still `create` and `start` the container for as long as its unit
 * is alive, so no ownership is read and no outcome is formed until `gate.proveOriginalTerminal` has positively shown the ORIGINAL
 * installation unit terminal (MainPID 0, no job, control group empty). A proxy closure or an asynchronous `stop --no-block` is
 * not that proof. If the proof fails nothing is read, signalled or recorded: the attempt stays HELD and the same helper can be
 * run again (recovery) once the unit is provably gone.
 *
 * Only a CLOSING outcome is retained as the create-once terminal `cleanup` receipt, and only if the receipt itself was written
 * inside the cleanup window. A non-closing outcome is returned with its reason and left for the caller to retain as evidence; it
 * does not consume the receipt name, so a later recovery run can still close the operation. A receipt that already exists
 * closes idempotently without a single Docker call.
 */
export type OutsideCleanupGate = Readonly<{
  /** Milliseconds left in the issuer's cleanup window; throws (or returns less than 1) once it has ended. Sampled AFTER the proof. */
  remainingMs(): number;
  /** Throws unless the original installation unit is terminal: stopped, MainPID 0, no job, every control group node empty. */
  proveOriginalTerminal(): Promise<void>;
}>;
export type OutsideCleanupResult = Readonly<{ ok: boolean; outcome: HostedRetentionCleanupOutcome; containerId: string | null; reason?: string }>;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "unknown";
export async function cleanupOwnedDockerTestContainer(packet: HostedRetentionPacket, gate: OutsideCleanupGate,
  deps: DockerLifecycleDeps = realDockerLifecycleDeps): Promise<OutsideCleanupResult> {
  dockerLaunch(packet);
  const prior = deps.readCleanup(packet.operationId);
  if (prior) {
    return prior.operationId === packet.operationId && hostedRetentionCleanupClosing.includes(prior.outcome)
      ? { ok: true, outcome: prior.outcome, containerId: prior.containerId }
      : { ok: false, outcome: HostedRetentionCleanupOutcome.CleanupUnproved, containerId: prior.containerId, reason: "cleanup_record_not_closing" };
  }
  try { await gate.proveOriginalTerminal(); }
  catch (error) { return { ok: false, outcome: HostedRetentionCleanupOutcome.CleanupUnproved, containerId: null, reason: `original_unit_unproved:${messageOf(error)}` }; }
  let cleanupMs: number;
  try { cleanupMs = gate.remainingMs(); }
  catch (error) { return { ok: false, outcome: HostedRetentionCleanupOutcome.CleanupUnproved, containerId: null, reason: `cleanup_window_ended:${messageOf(error)}` }; }
  if (!(cleanupMs >= 1)) return { ok: false, outcome: HostedRetentionCleanupOutcome.CleanupUnproved, containerId: null, reason: "cleanup_window_ended" };
  const cleanupEnd = deps.clock.nowMs() + cleanupMs;
  const { run, inspect, within } = boundedDocker(deps);
  const own = deps.readOwnership(packet.operationId);
  let outcome: HostedRetentionCleanupOutcome, containerId: string | null = own.created?.containerId ?? null, reason: string | undefined;
  // Every custody record is bound to the packet's operation by its path AND by its own operationId (defence in depth, a10 F8).
  const foreign = [["intent", own.intent], ["created", own.created], ["container", own.container]].find(([, row]) => row && (row as { operationId: string }).operationId !== packet.operationId);
  if (foreign) { outcome = HostedRetentionCleanupOutcome.CleanupUnproved; containerId = null; reason = `${foreign[0] as string}_record_operation_mismatch`; }
  else if (!own.intent) outcome = HostedRetentionCleanupOutcome.NoContainer;
  else if (!own.created) { outcome = HostedRetentionCleanupOutcome.CreateUncertain; reason = "intent_without_created"; }
  else {
    try {
      const result = await stopOwnedContainer(own.created.containerId, packet, own.container ?? undefined, deps, cleanupEnd, run, inspect, within);
      outcome = result === "stopped" ? HostedRetentionCleanupOutcome.Stopped : HostedRetentionCleanupOutcome.AlreadyStopped;
    } catch (error) { outcome = HostedRetentionCleanupOutcome.CleanupUnproved; reason = messageOf(error); }
  }
  if (!hostedRetentionCleanupClosing.includes(outcome)) return { ok: false, outcome, containerId, ...(reason === undefined ? {} : { reason }) };
  deps.recordCleanup(packet.operationId, { schemaVersion: 3, operationId: packet.operationId, outcome, containerId });
  // The receipt write is an IO of its own: a closure whose last IO returned after the cleanup end is not an in-window closure.
  try { within(cleanupEnd, "cleanup_record"); }
  catch (error) { return { ok: false, outcome, containerId, reason: messageOf(error) }; }
  return { ok: true, outcome, containerId };
}

/** IN-CONTAINER side: wait (bounded) for the operator's record, then verify it against this process's own view. */
export async function proveDockerContainerIdentity(packet: HostedRetentionPacket, pollMs = 250, maxPolls = 120): Promise<void> {
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const bytes = readRetentionRecord(packet.operationId, "container");
    if (bytes) {
      const stat = readFileSync("/proc/self/stat", "utf8");
      assertDockerContainerView(parseHostedRetentionContainerRecord(decodeRetentionJson(bytes)), packet, {
        pid: process.pid, selfCgroup: collectSelfCgroup(), mountinfo: readFileSync("/proc/self/mountinfo", "utf8"),
        startTicks: stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] ?? "" });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  retentionHeld(`container_record_missing:${retentionRecordPath(packet.operationId, "container")}`);
}
