import { describe, expect, it } from "vitest";
import {
  HostedRetentionLaunchKind, hostedRetentionTool, parseHostedRetentionPacket, type HostedRetentionMount, type HostedRetentionPacket,
} from "../../core/host-infrastructure/host-retention-operation";
import {
  assertContainerExecutable, assertDockerContainerView, assertDockerInspect, assertDockerTestMounts, cleanupOwnedDockerTestContainer, dockerContainerRecord, dockerTestCreateArgs,
  retentionContainerLabel, runOwnedDockerTestLifecycle, type DockerCli, type DockerLifecycleDeps, type OutsideCleanupGate,
} from "../retention-operation-test-launcher";
import { retentionOperationRoot } from "../retention-operation-records";

// The trusted SOURCE TEST launcher is pure where it matters: mount set, create arguments, the exact-container check and the
// in-container comparison. Docker itself is never run here, and the field spelling of `docker inspect` is unverified.
// Source-only: nothing here qualifies a container, a launcher or any authority; it binds the refusals.
const OP = "44444444-4444-4444-4444-444444444444";
const IMAGE = `sha256:${"e".repeat(64)}`, FIXTURE = "/srv/workers/.tmp-retention-TEST/fixture", RUNTIME = "/opt/TEST-runtime";
const mounts = (over: HostedRetentionMount[] = []): HostedRetentionMount[] => [
  { source: "/sys/fs/cgroup", target: "/sys/fs/cgroup", readonly: true },
  { source: retentionOperationRoot, target: retentionOperationRoot, readonly: true },
  { source: `${retentionOperationRoot}/${OP}`, target: `${retentionOperationRoot}/${OP}`, readonly: false },
  { source: "/etc/machine-id", target: "/etc/machine-id", readonly: true },
  { source: RUNTIME, target: RUNTIME, readonly: true },
  { source: "/usr/local/bin/node", target: "/usr/local/bin/node", readonly: true }, // the PINNED host executable, mounted over the entrypoint path
  { source: FIXTURE, target: FIXTURE, readonly: false },
  ...over,
];
function packet(over: { mounts?: HostedRetentionMount[]; fixtureRoot?: string; permitFile?: string; registryRootDir?: string } = {}): HostedRetentionPacket {
  const fixtureRoot = over.fixtureRoot ?? FIXTURE;
  return parseHostedRetentionPacket({
    schemaVersion: 3, role: "retention_operator", operationId: OP, hostId: "d".repeat(32), bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    issuedEpochMs: 1000, workEndEpochMs: 2000, cleanupEndEpochMs: 3000, issuedMonotonicNs: "1",
    node: { path: "/usr/local/bin/node", sha256: "a".repeat(64) }, bootstrap: { path: `${RUNTIME}/dist/worker-codex/retention-operation-bootstrap.js`, sha256: "b".repeat(64) },
    runtimeDirectory: RUNTIME, runtimeSha: "1".repeat(40), runtimeManifestSha256: "2".repeat(64), installationSha256: "3".repeat(64), inventorySha256: "4".repeat(64),
    launch: { kind: HostedRetentionLaunchKind.DockerTest, image: IMAGE, fixtureRoot, mounts: over.mounts ?? mounts() },
    retention: { tool: hostedRetentionTool, controllerJobId: "TEST-controller", workerJobId: "TEST-worker", permitFile: over.permitFile ?? `${FIXTURE}/retain-intent.json`,
      expectedPermitSha256: "5".repeat(64), confirmRetention: false, ...(over.registryRootDir === undefined ? {} : { registryRootDir: over.registryRootDir }) },
  });
}

describe("TEST launcher: disposable fixtures and the complete read-only hierarchy only", () => {
  it("accepts the exact required mount set and builds an unprivileged, networkless, host-cgroup-namespace create command", () => {
    const args = dockerTestCreateArgs(packet());
    expect(args).toContain("--cgroupns=host");
    expect(args).toContain("--network=none");
    expect(args).toContain(`--label=${retentionContainerLabel}=${OP}`);
    expect(args).toContain("type=bind,source=/usr/local/bin/node,target=/usr/local/bin/node,readonly");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).not.toContain("--privileged");
    expect(args.some(arg => /^--pid(?:=|$)/.test(arg))).toBe(false); // private PID namespace: no full-host process custody claim
    expect(args).toContain("type=bind,source=/sys/fs/cgroup,target=/sys/fs/cgroup,readonly");
    expect(args).toContain(`type=bind,source=${FIXTURE},target=${FIXTURE}`);
    expect(args.slice(-4)).toEqual([IMAGE, `${RUNTIME}/dist/worker-codex/retention-operation-bootstrap.js`, "--retention-operation", OP]);
  });

  it.each([
    ["a writable cgroup hierarchy", () => mounts().map(m => m.target === "/sys/fs/cgroup" ? { ...m, readonly: false } : m), "mount_missing_or_wrong:/sys/fs/cgroup"],
    ["a missing cgroup hierarchy", () => mounts().filter(m => m.target !== "/sys/fs/cgroup"), "mount_missing_or_wrong:/sys/fs/cgroup"],
    ["writable operation records (packet and funded must be read-only)", () => mounts().map(m => m.target === retentionOperationRoot ? { ...m, readonly: false } : m), `mount_missing_or_wrong:${retentionOperationRoot}`],
    ["a read-only own-output directory", () => mounts().map(m => m.target.endsWith(`/${OP}`) ? { ...m, readonly: true } : m), `mount_missing_or_wrong:${retentionOperationRoot}/${OP}`],
    ["no mount of the pinned executable (the image's own binary would run)", () => mounts().filter(m => m.target !== "/usr/local/bin/node"), "mount_missing_or_wrong:/usr/local/bin/node"],
    ["a writable executable mount", () => mounts().map(m => m.target === "/usr/local/bin/node" ? { ...m, readonly: false } : m), "mount_missing_or_wrong:/usr/local/bin/node"],
    ["a different file mounted over the executable path", () => mounts().map(m => m.target === "/usr/local/bin/node" ? { ...m, source: `${FIXTURE}/fake-node` } : m), "mount_missing_or_wrong:/usr/local/bin/node"],
    ["a mount of an original job path outside the fixture root", () => mounts([{ source: "/srv/workers/jobs/ORIGINAL-1", target: "/srv/workers/jobs/ORIGINAL-1", readonly: false }]), "mount_outside_fixture_root:/srv/workers/jobs/ORIGINAL-1"],
    ["a remapped fixture mount", () => mounts([{ source: "/srv/workers/jobs/ORIGINAL-1", target: `${FIXTURE}/jobs`, readonly: false }]), `mount_outside_fixture_root:${FIXTURE}/jobs`],
    ["a read-only fixture root", () => mounts().map(m => m.target === FIXTURE ? { ...m, readonly: true } : m), `mount_missing_or_wrong:${FIXTURE}`],
  ])("holds %s", (_name, build, reason) => {
    expect(() => assertDockerTestMounts(packet({ mounts: build() }))).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  it.each([
    ["a fixture root that is not a TEST area", { fixtureRoot: "/srv/workers/jobs", mounts: mounts().map(m => m.target === FIXTURE ? { source: "/srv/workers/jobs", target: "/srv/workers/jobs", readonly: false } : m) }, "fixture_root_not_test_area"],
    ["a permit outside the fixture root", { permitFile: "/var/lib/subscription-runtime-host-policy/permit.json" }, "invocation_outside_fixture_root"],
    ["a registry outside the fixture root", { registryRootDir: "/srv/workers/jobs/registry" }, "invocation_outside_fixture_root"],
  ])("holds %s", (_name, over, reason) => {
    expect(() => assertDockerTestMounts(packet(over))).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  it("refuses a supervisor-resident packet in the TEST launcher", () => {
    const unit = parseHostedRetentionPacket({ ...JSON.parse(JSON.stringify(packet())), launch: { kind: "installation_supervisor" } });
    expect(() => dockerTestCreateArgs(unit)).toThrow("hosted_retention_operation_held:not_a_docker_test_packet");
  });
});

describe("TEST launcher: exact container identity", () => {
  const id = "c".repeat(64);
  const inspect = (over: Record<string, unknown> = {}, host: Record<string, unknown> = {}) => [{
    Id: id, Image: IMAGE, Config: { Labels: { [retentionContainerLabel]: OP } },
    HostConfig: { CgroupnsMode: "host", PidMode: "", Privileged: false, NetworkMode: "none", CapAdd: null, ...host },
    Mounts: mounts().map(m => ({ Type: "bind", Source: m.source, Destination: m.target, RW: !m.readonly })), ...over,
  }];

  it("accepts exactly the pinned container and returns its id", () => {
    expect(assertDockerInspect(inspect(), packet())).toBe(id);
  });

  it.each([
    ["another image", () => inspect({ Image: `sha256:${"f".repeat(64)}` }), "image_mismatch"],
    ["a container without this operation's label", () => inspect({ Config: { Labels: {} } }), "container_not_owned:label"],
    ["a container labelled for another operation", () => inspect({ Config: { Labels: { [retentionContainerLabel]: "55555555-5555-5555-5555-555555555555" } } }), "container_not_owned:label"],
    ["a private cgroup namespace", () => inspect({}, { CgroupnsMode: "private" }), "cgroup_namespace_not_host"],
    ["the host PID namespace", () => inspect({}, { PidMode: "host" }), "pid_namespace_not_private"],
    ["a privileged container", () => inspect({}, { Privileged: true }), "privilege_or_network"],
    ["host networking", () => inspect({}, { NetworkMode: "host" }), "privilege_or_network"],
    ["an added capability", () => inspect({}, { CapAdd: ["SYS_ADMIN"] }), "privilege_or_network"],
    ["an extra mount", () => inspect({ Mounts: [...inspect()[0]!.Mounts, { Type: "bind", Source: "/", Destination: "/host", RW: true }] }), "mounts_mismatch"],
    ["a writable hierarchy", () => inspect({ Mounts: mounts().map(m => ({ Type: "bind", Source: m.source, Destination: m.target, RW: m.target === "/sys/fs/cgroup" ? true : !m.readonly })) }), "mounts_mismatch"],
    ["a volume instead of a bind", () => inspect({ Mounts: [{ Type: "volume", Source: "v", Destination: "/x", RW: true }] }), "mount_not_bind"],
    ["a malformed id", () => inspect({ Id: "short" }), "container_id_invalid"],
    ["several containers", () => [...inspect(), ...inspect()], "inspect_not_single"],
  ])("holds %s", (_name, build, reason) => {
    expect(() => assertDockerInspect(build(), packet())).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  const record = () => dockerContainerRecord({ packet: packet(), containerId: id, hostPid: 4242, hostCgroup: "0::/system.slice/docker-abc.scope", startTicks: "9001" });
  const mountinfo = mounts().map((m, i) => `${40 + i} 22 0:5 / ${m.target} ${m.readonly ? "ro" : "rw"},nosuid - bind src rw`).join("\n");
  const view = (over: Partial<{ pid: number; selfCgroup: string; startTicks: string; mountinfo: string }> = {}) =>
    ({ pid: 1, selfCgroup: "0::/system.slice/docker-abc.scope", startTicks: "9001", mountinfo, ...over });

  it("lets the in-container supervisor proceed only when its OWN view matches the operator's record", () => {
    expect(() => assertDockerContainerView(record(), packet(), view())).not.toThrow();
  });

  it.each([
    ["a process that is not the container init", { pid: 7 }, "not_container_init"],
    ["another cgroup (a different or private namespace view)", { selfCgroup: "0::/" }, "container_cgroup_mismatch"],
    ["another birth (a different or restarted container)", { startTicks: "9002" }, "container_birth_mismatch"],
    ["a writable mount where the record pins read-only", { mountinfo: mountinfo.replace("/sys/fs/cgroup ro", "/sys/fs/cgroup rw") }, "container_mount_mismatch:/sys/fs/cgroup"],
    ["a missing pinned mount", { mountinfo: mountinfo.split("\n").slice(1).join("\n") }, "container_mount_mismatch:/sys/fs/cgroup"],
  ])("holds %s", (_name, over, reason) => {
    expect(() => assertDockerContainerView(record(), packet(), view(over))).toThrow(`hosted_retention_operation_held:${reason}`);
  });

  it("holds a record that belongs to another operation or image", () => {
    const other = { ...record(), image: `sha256:${"f".repeat(64)}` };
    expect(() => assertDockerContainerView(other, packet(), view())).toThrow("hosted_retention_operation_held:container_record_mismatch");
  });
});

describe("TEST launcher: the executable actually used inside the container is the admitted pinned artifact", () => {
  const good = { procSelfExe: "/usr/local/bin/node", execPath: "/usr/local/bin/node", nodeSha256: "a".repeat(64), bootstrapSha256: "b".repeat(64) };
  it("lets the workload start only when the running file, its bytes and the loaded bootstrap all match the packet", () => {
    expect(() => assertContainerExecutable(packet(), good)).not.toThrow();
  });
  it.each([
    ["an image binary at another path", { procSelfExe: "/usr/bin/node", execPath: "/usr/bin/node" }, "executable_path_mismatch"],
    ["a /proc/self/exe that differs from the pinned path", { procSelfExe: "/opt/image/node" }, "executable_path_mismatch"],
    ["changed or substituted executable bytes at the same path", { nodeSha256: "c".repeat(64) }, "executable_bytes_mismatch"],
    ["a replaced bootstrap", { bootstrapSha256: "c".repeat(64) }, "bootstrap_bytes_mismatch"],
  ])("holds %s", (_name, over, reason) => {
    expect(() => assertContainerExecutable(packet(), { ...good, ...over })).toThrow(`hosted_retention_operation_held:${reason}`);
  });
});

// The lifecycle runs against a controlled Docker CLI and clock. It binds the finite-window obligations of the operator:
// every command is capped by the applicable deadline, only the exact owned container is ever stopped, the stop is verified
// from a fresh inspect, and an unprovable stop is HELD. It does not prove Docker's real behaviour (field spelling unverified).
describe("TEST launcher: finite, owned container lifecycle", () => {
  const id = "c".repeat(64), WORK = 5000, CLEANUP = 12000;
  type Options = Partial<{ createMs: number; createFails: boolean; startFails: boolean; finishAtMs: number; stopWorks: boolean; killWorks: boolean;
    labelAfterStart: string; ticksAtCleanup: string; inspectFailsAtMs: number;
    /** A STOPPED observation is slow: the command starts inside the window and returns after this many ms (post-IO deadline cases). */
    stoppedInspectTakesMs: number;
    /** The outside cleanup owner starts with the supervisor already dead and the container still running (it was started by it). */
    runningAtStart: boolean; startNow: number }>;
  function harness(options: Options = {}) {
    let now = options.startNow ?? 0; let running = options.runningAtStart ?? false; let exitCode = 0; let started = options.runningAtStart ?? false;
    const calls: string[][] = [], records: unknown[] = [], custody: [string, unknown][] = [];
    const row = () => ({ Id: id, Image: IMAGE, Config: { Labels: { [retentionContainerLabel]: started && options.labelAfterStart ? options.labelAfterStart : OP } },
      HostConfig: { CgroupnsMode: "host", PidMode: "", Privileged: false, NetworkMode: "none", CapAdd: null },
      Mounts: mounts().map(m => ({ Type: "bind", Source: m.source, Destination: m.target, RW: !m.readonly })),
      State: { Running: running, Pid: running ? 4242 : 0, ExitCode: exitCode } });
    const cli: DockerCli = (args, timeoutMs) => {
      calls.push([...args]);
      if (args[0] === "create") {
        const takes = options.createMs ?? 10;
        now += Math.min(takes, timeoutMs);
        if (options.createFails || takes > timeoutMs) throw new Error("docker_failed:create");
        return `${id}\n`;
      }
      if (args[0] === "inspect") {
        if (args[1] !== id) throw new Error("inspect of a container that is not the owned id");
        if (options.inspectFailsAtMs !== undefined && now >= options.inspectFailsAtMs && running) throw new Error("docker_failed:inspect");
        if (!running && started && options.stoppedInspectTakesMs !== undefined) now += options.stoppedInspectTakesMs;
        return JSON.stringify([row()]);
      }
      if (args[0] === "start") { if (options.startFails) throw new Error("docker_failed:start"); running = true; started = true; return id; }
      if (args[0] === "stop") { if (options.stopWorks) { running = false; exitCode = 137; } return id; }
      if (args[0] === "kill") { if (options.killWorks) { running = false; exitCode = 137; } return id; }
      throw new Error(`unexpected docker command ${args[0]}`);
    };
    const deps: DockerLifecycleDeps = { cli,
      clock: { nowMs: () => now, sleep: async ms => { now += ms; if (options.finishAtMs !== undefined && running && now >= options.finishAtMs) { running = false; exitCode = 0; } } },
      observePid: () => ({ cgroup: "0::/system.slice/docker-abc.scope", startTicks: started && now >= WORK && options.ticksAtCleanup ? options.ticksAtCleanup : "9001" }),
      recordContainer: (_operationId, record) => { records.push(record); custody.push(["container", record]); },
      recordIntent: (_operationId, record) => { custody.push(["intent", record]); },
      recordCreated: (_operationId, record) => { custody.push(["created", record]); },
      readOwnership: () => {
        const find = (name: string) => custody.find(([n]) => n === name)?.[1] ?? null;
        return { intent: find("intent") as never, created: find("created") as never, container: find("container") as never };
      },
      readCleanup: () => (custody.find(([n]) => n === "cleanup")?.[1] ?? null) as never,
      recordCleanup: (_operationId, record) => { custody.push(["cleanup", record]); } };
    return { deps, calls, records, custody, state: () => ({ running, now }) };
  }
  const signals = (calls: string[][]) => calls.filter(c => c[0] === "stop" || c[0] === "kill");
  const run = (h: ReturnType<typeof harness>) => runOwnedDockerTestLifecycle(packet(), { workMs: WORK, cleanupMs: CLEANUP }, h.deps);

  it("returns the exit code of a container that ends by itself inside the window, and signals nothing", async () => {
    const h = harness({ finishAtMs: 2000 });
    expect(await run(h)).toEqual({ containerId: id, exitCode: 0 });
    expect(signals(h.calls)).toEqual([]);
    expect(h.records).toHaveLength(1);
  });

  it("stops the exact owned container when the work deadline passes, verifies it stopped from a fresh inspect, and then fails HELD", async () => {
    const h = harness({ stopWorks: true });
    await expect(run(h)).rejects.toThrow("hosted_retention_operation_held:container_stopped_after_failure:hosted_retention_operation_held:work_deadline_expired");
    expect(signals(h.calls)).toEqual([["stop", "--time=5", id]]);
    expect(h.state().running).toBe(false);
    // After creation every command addresses the exact container id, never its name; nothing is removed or re-created.
    expect(h.calls.filter(c => c[0] !== "create").every(c => c.slice(1).every(arg => !arg.includes("subscription-runtime-retention-test")))).toBe(true);
    expect(h.calls.filter(c => c[0] === "create")).toHaveLength(1);
    expect(h.calls.some(c => c[0] === "rm")).toBe(false);
    expect(h.records).toHaveLength(1); // the identity evidence is retained
  });

  it("escalates to kill inside the cleanup budget when a graceful stop does not stop it", async () => {
    const h = harness({ stopWorks: false, killWorks: true });
    await expect(run(h)).rejects.toThrow("container_stopped_after_failure");
    expect(signals(h.calls).map(c => c[0])).toEqual(["stop", "kill"]);
    expect(h.state().running).toBe(false);
  });

  it("fails HELD with cleanup_unproved when the container cannot be proved stopped by the end of the cleanup budget", async () => {
    const h = harness({ stopWorks: false, killWorks: false });
    await expect(run(h)).rejects.toThrow("hosted_retention_operation_held:cleanup_unproved");
    await expect(run(harness({ stopWorks: false, killWorks: false }))).rejects.toThrow("still_running_at_cleanup_end");
    expect(h.state().now).toBeLessThanOrEqual(CLEANUP + 1000); // bounded: it did not wait indefinitely
    expect(h.state().running).toBe(true); // truthfully reported, container left as evidence
  });

  it("never signals a container whose birth changed or that is not provably the owned one", async () => {
    const reborn = harness({ stopWorks: true, ticksAtCleanup: "9999" });
    await expect(run(reborn)).rejects.toThrow("cleanup_unproved");
    expect(signals(reborn.calls)).toEqual([]);
    const foreign = harness({ stopWorks: true, labelAfterStart: "55555555-5555-5555-5555-555555555555" });
    await expect(run(foreign)).rejects.toThrow("cleanup_unproved");
    expect(signals(foreign.calls)).toEqual([]);
  });

  it("treats slow setup as uncertain custody: no container id means no signal by name and no retry", async () => {
    const h = harness({ createMs: WORK + 1 });
    await expect(run(h)).rejects.toThrow("hosted_retention_operation_held:create_uncertain");
    expect(h.calls.map(c => c[0])).toEqual(["create"]);
    const failing = harness({ createFails: true });
    await expect(run(failing)).rejects.toThrow("create_uncertain");
    expect(signals(failing.calls)).toEqual([]);
  });

  it("cleans up only what it started after a partial start failure and after an operator-side CLI failure mid-work", async () => {
    const partial = harness({ startFails: true });
    await expect(run(partial)).rejects.toThrow("container_stopped_after_failure");
    expect(signals(partial.calls)).toEqual([]); // created but never started: nothing to stop
    const cliFailure = harness({ stopWorks: true, inspectFailsAtMs: 1500 });
    // The CLI that failed mid-work cannot prove the stop either: HELD, and nothing was signalled that was not proved owned.
    await expect(run(cliFailure)).rejects.toThrow("hosted_retention_operation_held:cleanup_unproved");
    expect(signals(cliFailure.calls)).toEqual([]);
  });

  it("refuses a cleanup budget that does not exceed the work budget", async () => {
    await expect(runOwnedDockerTestLifecycle(packet(), { workMs: 1000, cleanupMs: 1000 }, harness().deps)).rejects.toThrow("cleanup_budget_missing");
  });

  // POST-IO deadlines (a9 P1). A command that starts inside the window and returns after it cannot prove WHEN it completed.
  describe("a command that returns after its deadline is never accepted", () => {
    it("a stopped observation that returns AFTER the work end is not success: late work is stopped (owned, bounded) and HELD", async () => {
      // The container ends by itself (3500 ms); the next inspect starts inside the window (4010 ms) and returns at 5210 > 5000.
      const h = harness({ finishAtMs: 3500, stoppedInspectTakesMs: 1200 });
      await expect(run(h)).rejects.toThrow("container_stopped_after_failure:hosted_retention_operation_held:deadline_after:command:inspect");
      expect(h.custody.some(([name]) => name === "cleanup")).toBe(false); // the lifecycle itself never claims the outside owner's receipt
    });

    it("defines the boundary: returning exactly AT the deadline is late, returning 1 ms before it is accepted", async () => {
      // The final inspect starts at 4010 ms (work end 5000): +990 returns exactly at 5000 (late), +989 returns at 4999 (in time).
      await expect(run(harness({ finishAtMs: 3500, stoppedInspectTakesMs: 990 }))).rejects.toThrow("deadline_after:command:inspect");
      await expect(run(harness({ finishAtMs: 3500, stoppedInspectTakesMs: 989 }))).resolves.toEqual({ containerId: id, exitCode: 0 });
    });

    it("a stopped cleanup observation that returns AFTER the cleanup end is cleanup_unproved, never an in-budget stop", async () => {
      // Work expires (5000+), stop works, but the fresh stopped inspect returns after 12000.
      const h = harness({ stopWorks: true, stoppedInspectTakesMs: 8000 });
      await expect(run(h)).rejects.toThrow("hosted_retention_operation_held:cleanup_unproved");
      expect(signals(h.calls)).toEqual([["stop", "--time=5", id]]); // exactly the owned container, and the late proof is still refused
    });

    it("announces custody before each step: intent before create, the exact id before start", async () => {
      const h = harness({ finishAtMs: 2000 });
      await run(h);
      expect(h.custody.map(([name]) => name)).toEqual(["intent", "created", "container"]);
      expect(h.custody[1]![1]).toMatchObject({ operationId: OP, containerId: id });
      expect(h.calls.map(c => c[0])[0]).toBe("create");
    });

    it("never starts a container whose id could not be bound", async () => {
      const h = harness({ finishAtMs: 2000 });
      const failing = { ...h.deps, recordCreated: () => { throw new Error("TEST_record_failed"); } };
      await expect(runOwnedDockerTestLifecycle(packet(), { workMs: WORK, cleanupMs: CLEANUP }, failing)).rejects.toThrow("TEST_record_failed");
      expect(h.calls.map(c => c[0])).toEqual(["create"]); // created, never started, never inspected or signalled
    });

    it("never creates a container when the intent could not be announced (a10 F8)", async () => {
      const h = harness({ finishAtMs: 2000 });
      const failing = { ...h.deps, recordIntent: () => { throw new Error("TEST_intent_failed"); } };
      await expect(runOwnedDockerTestLifecycle(packet(), { workMs: WORK, cleanupMs: CLEANUP }, failing)).rejects.toThrow("TEST_intent_failed");
      expect(h.calls).toEqual([]); // no `docker create` at all: nothing can exist for the outside owner to find
    });

    it("a started container whose identity record cannot be written is stopped (owned, bounded) and the attempt fails HELD (a10 F8)", async () => {
      const h = harness({ stopWorks: true });
      const failing = { ...h.deps, recordContainer: () => { throw new Error("TEST_container_record_failed"); } };
      await expect(runOwnedDockerTestLifecycle(packet(), { workMs: WORK, cleanupMs: CLEANUP }, failing)).rejects.toThrow("container_stopped_after_failure:TEST_container_record_failed");
      expect(h.calls.map(c => c[0])).toContain("start"); // it WAS started: the failure is after `start`
      expect(signals(h.calls)).toEqual([["stop", "--time=5", id]]); // exactly the bound container, verified stopped
      expect(h.state().running).toBe(false);
    });
  });
});

// The OUTSIDE cleanup owner (the installation issuer outlives the supervisor): it acts only on custody the supervisor bound
// before each step and can only stop the exact owned container. These are the supervisor-death cases the lifecycle's own
// tests above cannot show, because there the owner stays alive.
describe("TEST launcher: outside cleanup owner after the supervisor is gone", () => {
  const id = "c".repeat(64), CLEANUP = 7000;
  const bound = { intent: { schemaVersion: 3, operationId: OP, image: IMAGE, label: retentionContainerLabel },
    created: { schemaVersion: 3, operationId: OP, containerId: id },
    container: { schemaVersion: 3, operationId: OP, containerId: id, image: IMAGE, cgroup: "/system.slice/docker-abc.scope", startTicks: "9001", hostPid: 4242, mounts: mounts() } };
  type Row = { Id: string; Image: string; Config: { Labels: Record<string, string> }; State: { Running: boolean; Pid: number; ExitCode: number } };
  function owner(options: { ownership?: Partial<typeof bound>; running?: boolean; stopWorks?: boolean; label?: string; ticks?: string; inspectTakesMs?: number;
    /** The terminal-custody proof of the ORIGINAL unit; rejects while any custody fact is unproved. */
    proof?: () => Promise<void>; remainingMs?: () => number; existingCleanup?: unknown; recordTakesMs?: number } = {}) {
    let now = 0, running = options.running ?? true;
    const calls: string[][] = [], cleanup: unknown[] = [], events: string[] = [];
    const ownership = { intent: bound.intent, created: bound.created, container: bound.container, ...options.ownership };
    const row = (): Row => ({ Id: id, Image: IMAGE, Config: { Labels: { [retentionContainerLabel]: options.label ?? OP } }, State: { Running: running, Pid: running ? 4242 : 0, ExitCode: 137 } });
    const gate: OutsideCleanupGate = { remainingMs: options.remainingMs ?? (() => CLEANUP),
      proveOriginalTerminal: async () => { events.push("proof"); await (options.proof ?? (async () => undefined))(); } };
    const deps: DockerLifecycleDeps = {
      cli: (args, timeoutMs) => {
        events.push(`cli:${args[0]}`);
        calls.push([...args]);
        if (args[0] === "inspect") { if (args[1] !== id) throw new Error("only the bound id may be inspected"); now += options.inspectTakesMs ?? 0; return JSON.stringify([row()]); }
        if (args[0] === "stop") { if (options.stopWorks !== false) running = false; return id; }
        if (args[0] === "kill") return id;
        throw new Error(`unexpected docker command ${args[0]} (${timeoutMs})`);
      },
      clock: { nowMs: () => now, sleep: async ms => { now += ms; } },
      observePid: () => ({ cgroup: "0::/system.slice/docker-abc.scope", startTicks: options.ticks ?? "9001" }),
      recordContainer: () => { throw new Error("the outside owner records no workload container"); },
      recordIntent: () => { throw new Error("the outside owner announces no custody"); },
      recordCreated: () => { throw new Error("the outside owner announces no custody"); },
      readOwnership: () => { events.push("readOwnership"); return { intent: ownership.intent as never, created: ownership.created as never, container: ownership.container as never }; },
      readCleanup: () => (options.existingCleanup ?? null) as never,
      recordCleanup: (_operationId, record) => { events.push("recordCleanup"); now += options.recordTakesMs ?? 0; cleanup.push(record); },
    };
    return { deps, calls, cleanup, events, gate };
  }
  const clean = (o: ReturnType<typeof owner>) => cleanupOwnedDockerTestContainer(packet(), o.gate, o.deps);
  const signals = (calls: string[][]) => calls.filter(c => c[0] === "stop" || c[0] === "kill");

  it("stops ONLY the exact bound container that outlived the dead supervisor and retains the proved outcome", async () => {
    const o = owner();
    await expect(clean(o)).resolves.toEqual({ ok: true, outcome: "stopped", containerId: id });
    expect(signals(o.calls)).toEqual([["stop", "--time=5", id]]);
    expect(o.calls.every(c => c[1] === id || c[1] === "--time=5")).toBe(true); // never addressed by name or filter
    expect(o.cleanup).toEqual([{ schemaVersion: 3, operationId: OP, outcome: "stopped", containerId: id }]);
  });

  it("an already stopped container (the supervisor finished) is closed without any signal", async () => {
    const o = owner({ running: false });
    await expect(clean(o)).resolves.toMatchObject({ ok: true, outcome: "already_stopped" });
    expect(signals(o.calls)).toEqual([]);
  });

  it("no announced custody means no container can exist: nothing is called at all", async () => {
    const o = owner({ ownership: { intent: null as never, created: null as never, container: null as never } });
    await expect(clean(o)).resolves.toMatchObject({ ok: true, outcome: "no_container" });
    expect(o.calls).toEqual([]);
  });

  it("an uncertain creation (intent without a bound id) blocks: nothing looked up by name, nothing signalled, no receipt consumed", async () => {
    const o = owner({ ownership: { created: null as never, container: null as never } });
    await expect(clean(o)).resolves.toMatchObject({ ok: false, outcome: "create_uncertain", containerId: null, reason: "intent_without_created" });
    expect(o.calls).toEqual([]);
    expect(o.cleanup).toEqual([]); // only a CLOSING outcome consumes the create-once receipt, so a recovery run can still close it
  });

  it.each([
    ["a container that is not labelled for this operation", { label: "55555555-5555-5555-5555-555555555555" }],
    ["a container whose birth differs from the recorded one", { ticks: "9999" }],
    ["a stop that does not take effect", { stopWorks: false }],
    ["a stopped proof that returns after the cleanup window", { inspectTakesMs: CLEANUP }],
  ])("%s is never accepted as cleanup: unproved and HELD, and nothing foreign is signalled", async (_name, options) => {
    const o = owner(options);
    const result = await clean(o);
    expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved" });
    expect(result.reason).toEqual(expect.any(String));
    expect(o.cleanup).toEqual([]); // no closing receipt for an unproved outcome
    if ("label" in options || "ticks" in options) expect(signals(o.calls)).toEqual([]);
  });

  it("refuses a packet that is not a TEST container packet", async () => {
    const unit = parseHostedRetentionPacket({ ...JSON.parse(JSON.stringify(packet())), launch: { kind: "installation_supervisor" } });
    await expect(cleanupOwnedDockerTestContainer(unit, owner().gate, owner().deps)).rejects.toThrow("hosted_retention_operation_held:not_a_docker_test_packet");
  });

  it.each(["intent", "created", "container"] as const)("a `%s` custody record that names another operation is never acted on: unproved, nothing called (a10 F8)", async record => {
    const other = "55555555-5555-5555-5555-555555555555";
    const o = owner({ ownership: { [record]: { ...bound[record], operationId: other } } as Partial<typeof bound> });
    const result = await clean(o);
    expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved", containerId: null, reason: `${record}_record_operation_mismatch` });
    expect(o.calls).toEqual([]);
    expect(o.cleanup).toEqual([]);
  });

  // BINDING tests of the a10 F1 guard (clause 3 of the guard-binding oracle: the tests above are context, THESE bind the guard).
  // Mutation to run: delete the `await gate.proveOriginalTerminal()` try-block in `cleanupOwnedDockerTestContainer` (assert the
  // edit applied first); every test in this block must then fail; restore and observe green.
  describe("no cleanup outcome is accepted while the ORIGINAL unit is not proved terminal (the admitted supervisor can still create and start)", () => {
    const unproved = async () => { throw new Error("hosted_retention_operation_held:original_unit_not_terminal:main_pid_alive"); };

    it.each([
      ["created but not yet started (the supervisor may still call `start`): would have read as already_stopped", { running: false }],
      ["still running", { running: true }],
      ["intent recorded, no id yet (the supervisor may still be inside `create`): would have read as create_uncertain", { ownership: { created: null as never, container: null as never } }],
      ["no intent at all (the supervisor may not have announced yet): would have read as no_container", { ownership: { intent: null as never, created: null as never, container: null as never } }],
    ])("a container %s is neither signalled, looked up, nor closed while the proof fails", async (_name, options) => {
      const o = owner({ ...options, proof: unproved });
      const result = await clean(o);
      expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved", containerId: null });
      expect(result.reason).toContain("original_unit_unproved:");
      expect(result.reason).toContain("main_pid_alive");
      expect(o.events).toEqual(["proof"]); // ownership never read, Docker never called, nothing recorded
      expect(o.cleanup).toEqual([]);
    });

    it("reads ownership and calls Docker only AFTER the proof, and the proof is evaluated again on every call (no cached terminal state)", async () => {
      const proofs: boolean[] = [];
      const o = owner({ proof: async () => { proofs.push(true); } });
      await expect(clean(o)).resolves.toMatchObject({ ok: true, outcome: "stopped" });
      expect(o.events[0]).toBe("proof");
      expect(o.events.indexOf("readOwnership")).toBeGreaterThan(o.events.indexOf("proof"));
      expect(o.events.filter(e => e.startsWith("cli:")).every(e => o.events.indexOf(e) > o.events.indexOf("proof"))).toBe(true);
      await clean(owner({ proof: async () => { proofs.push(true); } }));
      expect(proofs).toHaveLength(2);
    });

    it("a proof that succeeds but leaves no cleanup window is not a license to act", async () => {
      for (const remainingMs of [() => 0, () => { throw new Error("hosted_ordinary_installation_held"); }]) {
        const o = owner({ remainingMs });
        const result = await clean(o);
        expect(result).toMatchObject({ ok: false, outcome: "cleanup_unproved" });
        expect(result.reason).toContain("cleanup_window_ended");
        expect(o.events).toEqual(["proof"]);
      }
    });

    it("a terminal receipt that already exists closes idempotently with no proof, no Docker call and no second receipt; a non-closing one never closes", async () => {
      const closed = owner({ existingCleanup: { schemaVersion: 3, operationId: OP, outcome: "stopped", containerId: id } });
      await expect(clean(closed)).resolves.toEqual({ ok: true, outcome: "stopped", containerId: id });
      expect(closed.events).toEqual([]);
      const held = owner({ existingCleanup: { schemaVersion: 3, operationId: OP, outcome: "cleanup_unproved", containerId: id } });
      await expect(clean(held)).resolves.toMatchObject({ ok: false, outcome: "cleanup_unproved", reason: "cleanup_record_not_closing" });
      expect(held.events).toEqual([]);
    });

    it("DELAYED FINAL IO: a stop that was proved but whose receipt write returns after the cleanup end is not an in-window closure", async () => {
      // The stop works, the fresh stopped inspect is in time; only the receipt write (the last IO) overruns the window.
      const o = owner({ recordTakesMs: CLEANUP });
      const result = await clean(o);
      expect(result).toMatchObject({ ok: false, outcome: "stopped", containerId: id });
      expect(result.reason).toContain("deadline_after:cleanup_record");
      // Boundary: the same write 1 ms inside the window is accepted.
      await expect(clean(owner({ recordTakesMs: CLEANUP - 1 }))).resolves.toMatchObject({ ok: true, outcome: "stopped" });
    });
  });
});
