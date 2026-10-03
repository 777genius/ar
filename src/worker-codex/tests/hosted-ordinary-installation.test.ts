import { routeHostedGoalLaunch, stopHostedGoalLaunch } from "../hosted-readonly-goal-launch";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { codexAuthJsonForAccount, StaticRunner } from "./file-backend-codex-worker-test-support";
import * as egressFiles from "../hosted-test-egress-files";
import { PassThrough } from "node:stream";
import { runHostedRuntimeForeground, runHostedOrdinaryBootstrap, routeHostedRuntimeCommand } from "../hosted-readonly-foreground";
import { admitHostedControllerLaunch } from "../hosted-readonly-controller-admission";
import { admitHostedTestEgress } from "../hosted-test-egress-admission";
import { admitHostedReadonlyInputs } from "../hosted-readonly-admission";
import { EventEmitter } from "node:events";
import { spawnCodexAppServerProcess, signalCodexAppServerChildGroup } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId, withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedCustodyReservationState, parseHostedActivation, type HostedOrdinaryReservation } from "@vioxen/subscription-runtime/worker-core";
import { HostedReadonlyEpochStore } from "../hosted-readonly-epoch-store";
import { HostedReadonlySupervisorHost } from "../hosted-readonly-supervisor-host";
import { ordinaryCompletionBytes } from "../hosted-readonly-host-kernel";
import { readonlyCustodySnapshot } from "../hosted-readonly-custody";
import { HostedInstallationActivationStore, readHostedOrdinaryBirth, readHostedOrdinaryRuntime } from "../hosted-installation-activation";

// Real private record I/O and real installation/kernel composition. Only finite
// synthetic /proc, systemd and private filesystem facts replace the actual host.
const fixture = vi.hoisted(() => ({ root: "", boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", group: "/system.slice/trusted.service",
  spawn: vi.fn(), child: null as unknown, creatorBirth: "789", creatorGroup: "/system.slice/trusted.service", runtimeUnit: "",
  failRename: "", unsafeDescriptor: false, enabled: "trusted.service enabled enabled\n", jobs: "", stopFailed: false, populated: false, stops: [] as string[], onStop: undefined as (() => void) | undefined }));
const root = "/var/lib/subscription-runtime-host-policy";
const stages = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages";
function local(path: string): string {
  if (["/", "/var", "/var/lib", root, "/run", "/run/user", "/run/user/0", "/run/user/0/subscription-runtime-host-policy", "/etc", "/etc/systemd", "/etc/systemd/system"].includes(path)) return fixture.root;
  const grants = "/run/user/0/subscription-runtime-host-policy/codex-egress";
  if (path === grants || path.startsWith(grants + "/")) return join(fixture.root, "grants", path.slice(grants.length));
  for (const [kind, directory] of [["codex-readonly", "policies"], ["codex-readonly-reviewed", "reviews"]]) {
    const prefix = "/run/user/0/subscription-runtime-host-policy/" + kind;
    if (path === prefix || path.startsWith(prefix + "/")) return join(fixture.root, directory!, path.slice(prefix.length));
  }
  if (["/managed", "/work", "/jobs", "/jobs/ordinary-job"].includes(path)) return fixture.root;
  for (const workspace of ["/managed/W", "/jobs/ordinary-job/workspace"]) {
    if (path === workspace || path.startsWith(workspace + "/")) return join(fixture.root, "managed-W", path.slice(workspace.length));
  }
  if (path === stages || path.startsWith(stages + "/")) return join(fixture.root, "stages", path.slice(stages.length));
  if (path.startsWith(root + "/")) return join(fixture.root, path.slice(root.length + 1));
  if (path === "/etc/systemd/system/trusted.service") return join(fixture.root, "fragment");
  return path;
}
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    readFileSync: (path: string, options: Parameters<typeof real.readFileSync>[1]) => {
      if (path === "/proc/self/uid_map") return "0 0 4294967295\n";
      if (path === "/proc/sys/kernel/random/boot_id") return fixture.boot;
      if (path === "/etc/machine-id") return "a".repeat(32);
      if (path === "/proc/self/cgroup") return `0::${fixture.group}\n`;
      if (path === "/proc/123/stat") return "123 (supervisor) " + [...Array(19).fill("0"), "456"].join(" ");
      if (path === `/proc/${process.pid}/stat`) return `${process.pid} (dispatcher) ` + [...Array(19).fill("0"), fixture.creatorBirth].join(" ");
      if (path === `/proc/${process.pid}/cgroup`) return `0::${fixture.creatorGroup}\n`;
      if (path === "/proc/self/mountinfo") return "1 0 8:1 / / rw - ext4 /dev/TEST rw\n";
      if (path.startsWith("/sys/fs/cgroup") && path.endsWith("/cgroup.events")) return `populated ${fixture.populated ? 1 : 0}\n`;
      if (path.startsWith("/sys/fs/cgroup") && path.endsWith("/cgroup.procs")) return path.includes("trusted.service") ? "123\n" : "";
      return real.readFileSync(local(path), options);
    },
    readdirSync: (path: string, options: Parameters<typeof real.readdirSync>[1]) => {
      if (path === "/proc/self/fd") return fixture.unsafeDescriptor ? ["0", "1", "2", "99"] : ["0", "1", "2"];
      if (path.startsWith("/sys/fs/cgroup")) return (path === "/sys/fs/cgroup" ? ["system.slice"] :
        path === "/sys/fs/cgroup/system.slice" ? ["trusted.service"] : []).map(name => ({ name, isDirectory: () => true }));
      return real.readdirSync(local(path), options);
    },
    readlinkSync: (path: string) => path.startsWith("/proc/") ? "host" : real.readlinkSync(local(path)),
    realpathSync: (path: string) => path === "/etc/systemd/system/trusted.service" ? path : real.realpathSync(path),
    statfsSync: () => ({ type: 0xef53 }),
    lstatSync: (path: string) => Object.assign(real.lstatSync(local(path)), { uid: 0 }),
    fstatSync: (fd: number) => fd <= 2 ? { isFIFO: () => true, isSocket: () => false } : fd === 99 ?
      { isFile: () => true, isDirectory: () => false } : Object.assign(real.fstatSync(fd), { uid: 0 }),
    openSync: (path: string, flags: number, mode: number) => real.openSync(local(path), flags, mode),
    mkdirSync: (path: string, options: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), options),
    rmdirSync: (path: string) => real.rmdirSync(local(path)),
    renameSync: (from: string, to: string) => {
      if (fixture.failRename && from.endsWith(fixture.failRename)) throw new Error("synthetic publication interruption");
      real.renameSync(local(from), local(to));
    },
  };
});
vi.mock("node:child_process", () => ({ execFile: () => { throw new Error("unexpected external command"); },
  spawn: (...args: unknown[]) => fixture.spawn(...args), spawnSync: (command: string, args: string[]) => {
  if (command !== "/usr/bin/systemctl") throw new Error("unexpected external command");
  if (args[0] === "kill" || args[0] === "stop") {
    fixture.stops.push(args.at(-1)!); fixture.onStop?.();
    return { status: fixture.stopFailed ? 1 : 0, stdout: "" };
  }
  if (args[0] === "show" && args.at(-1) === fixture.runtimeUnit) return { status: 0, stdout:
    `Id=${fixture.runtimeUnit}\nFragmentPath=\nDropInPaths=\nControlGroup=/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${fixture.runtimeUnit}\nMainPID=234\n` };
  if (args[0] === "show" && args.at(-1) !== "trusted.service") return { status: 0, stdout:
    `Id=${args.at(-1)}\nFragmentPath=\nDropInPaths=\nControlGroup=\nMainPID=0\n` };
  if (args[0] === "show") return { status: 0, stdout: "Id=trusted.service\nFragmentPath=/etc/systemd/system/trusted.service\nDropInPaths=\nControlGroup=/system.slice/trusted.service\nMainPID=123\n" };
  if (args[0] === "list-unit-files") return { status: 0, stdout: fixture.enabled };
  if (args[0] === "list-units") return { status: 0, stdout: args.includes("--type=socket,timer") ? "" : "trusted.service loaded active running trusted\n" };
  if (args[0] === "list-jobs") return { status: 0, stdout: fixture.jobs };
  throw new Error("unexpected service mutation");
} }));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const runtimeDirectory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const stageName = "stages/" + hash(runtimeDirectory) + ".json";
function put(name: string, value: unknown) { writeFileSync(join(fixture.root, name), JSON.stringify(value) + "\n", { mode: 0o600 }); }
function read(name: string) { return JSON.parse(readFileSync(join(fixture.root, name), "utf8")); }
function creator() { return { creatorId: "ordinary-creator", jobId: "ordinary-job", jobRootDir: "/jobs/ordinary-job",
  workspacePath: "/jobs/ordinary-job/workspace", launch: { command: process.execPath, args: [join(runtimeDirectory, "dist/worker-codex/codex-goal-cli.js"), "start", "ordinary-job"], cwd: "/jobs/ordinary-job/workspace" } }; }
beforeEach(() => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  fixture.root = mkdtempSync(join(tmpdir(), "ordinary-installation-")); fixture.group = "/system.slice/trusted.service";
  fixture.failRename = ""; fixture.unsafeDescriptor = false; fixture.enabled = "trusted.service enabled enabled\n"; fixture.jobs = ""; fixture.stopFailed = false; fixture.populated = false; fixture.stops = []; fixture.onStop = undefined;
  fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fixture.spawn.mockReset();
  const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { write: vi.fn(() => true), end: vi.fn() }),
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true) });
  fixture.child = child; fixture.spawn.mockReturnValue(child);
  fixture.creatorBirth = "789"; fixture.creatorGroup = "/system.slice/trusted.service"; fixture.runtimeUnit = "";
  for (const dir of ["stages", "grants", "policies", "reviews", "managed-W", "ordinary-origins", "ordinary-starts", "ordinary-completed", "codex-readonly-custody", "codex-readonly-revoked"]) mkdirSync(join(fixture.root, dir), { mode: 0o700 });
  mkdirSync(join(fixture.root, "managed-W/input"), { mode: 0o700 });
  writeFileSync(join(fixture.root, "fragment"), "reviewed", { mode: 0o600 });
  put("readonly-inventory.json", { schemaVersion: 2, hostId: "a".repeat(32), supervisorUnit: "trusted.service",
    units: [{ name: "trusted.service", controlGroup: "/system.slice/trusted.service", fragmentSha256: hash("reviewed") }],
    runtimeLaunch: { command: "/runtime/node", args: ["/runtime/managed.js"], cwd: "/work/managed" }, ordinaryCreators: [creator()], disabledCreators: [] });
  put(stageName, { schemaVersion: 1, runtimeDirectory, runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64) });
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("trusted same-artifact installation and ordinary origin enrollment", () => {
  it("derives installation from reviewed stage/inventory, enrolls configured identity and explicitly resumes", () => {
    const store = new HostedInstallationActivationStore();
    const installed = store.install();
    expect(installed.phase).toBe("CLOSED");
    expect(store.install()).toEqual(installed);
    expect(store.enrollOrdinary("ordinary-creator")).toEqual(expect.objectContaining({ jobId: "ordinary-job", origin: "ordinary" }));
    const before = read("host-activation.json");
    store.enrollOrdinary("ordinary-creator");
    expect(read("host-activation.json")).toEqual(before);
    expect(() => readHostedOrdinaryBirth("ordinary-job")).toThrow();
    expect(store.resumeOrdinary().phase).toBe("ORDINARY");
    expect(readHostedOrdinaryBirth("ordinary-job").birth.jobId).toBe("ordinary-job");
    expect(() => store.enrollOrdinary("ordinary-creator")).toThrow();
  });
  it("accepts a genuine configured npm grant without rewriting or issuing egress authority", () => {
    const store = new HostedInstallationActivationStore(); store.install();
    const name = `grants/${hash("ordinary-job")}.json`;
    put(name, { schemaVersion: 1, jobId: "ordinary-job", jobRootDir: creator().jobRootDir,
      workspacePath: creator().workspacePath, profileId: "codex-test-npm-qualification" });
    const bytes = readFileSync(join(fixture.root, name));
    expect(store.enrollOrdinary("ordinary-creator").jobId).toBe("ordinary-job");
    expect(readFileSync(join(fixture.root, name))).toEqual(bytes);
  });
  it.each(["missing-stage", "wrong-stage-directory", "bad-sha", "legacy-inventory", "unowned-caller", "competing-creator", "queued-creator", "inherited-handle", "foreign-launcher"])(
    "rejects %s without installing authority", fault => {
      if (fault === "missing-stage") rmSync(join(fixture.root, stageName));
      if (fault === "wrong-stage-directory") put(stageName, { ...read(stageName), runtimeDirectory: "/foreign" });
      if (fault === "bad-sha") put(stageName, { ...read(stageName), runtimeSha: "invalid" });
      if (fault === "legacy-inventory") { const value = read("readonly-inventory.json"); delete value.ordinaryCreators; delete value.disabledCreators; put("readonly-inventory.json", { ...value, schemaVersion: 1 }); }
      if (fault === "unowned-caller") fixture.group = "/system.slice/worker.service";
      if (fault === "competing-creator") fixture.enabled += "old.service enabled enabled\n";
      if (fault === "queued-creator") fixture.jobs = "9 old.service start waiting\n";
      if (fault === "inherited-handle") fixture.unsafeDescriptor = true;
      if (fault === "foreign-launcher") put("readonly-inventory.json", { ...read("readonly-inventory.json"), ordinaryCreators: [
        { ...creator(), launch: { ...creator().launch, args: ["/older/runtime/cli.js", "start", "ordinary-job"] } }] });
      expect(() => new HostedInstallationActivationStore().install()).toThrow();
      expect(() => readFileSync(join(fixture.root, "host-installation.json"))).toThrow();
    });
  it.each(["unknown-creator", "stage-drift", "inventory-drift", "revoked", "custody", "wrong-session", "managed-grant", "foreign-grant"])(
    "rejects %s before ordinary birth publication", fault => {
      const store = new HostedInstallationActivationStore(); store.install();
      if (fault === "stage-drift") put(stageName, { ...read(stageName), runtimeManifestSha256: "c".repeat(64) });
      if (fault === "inventory-drift") put("readonly-inventory.json", { ...read("readonly-inventory.json"), ordinaryCreators: [{ ...creator(), jobId: "changed-job" }] });
      if (fault === "revoked" || fault === "custody") put(`codex-readonly-${fault}/${hash("ordinary-job")}.json`, { jobId: "ordinary-job" });
      if (fault === "managed-grant" || fault === "foreign-grant") put(`grants/${hash("ordinary-job")}.json`, {
        schemaVersion: 1, jobId: fault === "foreign-grant" ? "foreign-job" : "ordinary-job", jobRootDir: creator().jobRootDir,
        workspacePath: creator().workspacePath, profileId: fault === "managed-grant" ? "codex-test-managed-qualification" : "codex-test-npm-qualification" });
      if (fault === "wrong-session") fixture.boot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      expect(() => store.enrollOrdinary(fault === "unknown-creator" ? "worker-requested-creator" : "ordinary-creator")).toThrow();
      expect(() => readFileSync(join(fixture.root, "ordinary-origins", hash("ordinary-job") + ".json"))).toThrow();
    });
  it.each(["host-activation.next", "ordinary-origins.next"])("recovers interrupted %s with a retained catalog and CLOSED activation", file => {
    const store = new HostedInstallationActivationStore(); store.install(); fixture.failRename = file;
    expect(() => store.enrollOrdinary("ordinary-creator")).toThrow("publication interruption");
    expect(() => store.resumeOrdinary()).toThrow();
    fixture.failRename = "";
    store.recoverSerialized(() => expect(store.read().phase).toBe("CLOSED"));
    expect(read("ordinary-origins.json").origins).toHaveLength(1);
    store.resumeOrdinary();
    expect(readHostedOrdinaryBirth("ordinary-job").birth.jobId).toBe("ordinary-job");
  });
  it.each(["ordinary-origins", "ordinary-starts", "codex-readonly-custody", "codex-readonly-revoked"])(
    "cannot initialize over retained %s after index loss", directory => {
      put(`${directory}/retained.json`, { retained: true });
      expect(() => new HostedInstallationActivationStore().install()).toThrow();
      expect(() => readFileSync(join(fixture.root, "host-installation.json"))).toThrow();
    });
  it("retains an orphan installation instead of recreating missing activation history", () => {
    const store = new HostedInstallationActivationStore(); store.install(); rmSync(join(fixture.root, "host-activation.json"));
    expect(() => store.install()).toThrow();
    expect(() => readFileSync(join(fixture.root, "host-activation.json"))).toThrow();
  });
  it("missing or corrupt ordinary catalog/birth cannot resume", () => {
    const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary("ordinary-creator");
    put(`ordinary-origins/${hash("ordinary-job")}.json`, { ...creator(), approved: true });
    expect(() => store.resumeOrdinary()).toThrow();
    expect(store.read().phase).toBe("CLOSED");
  });
});

function seedManaged(jobId = "managed-job") {
  const policy = { schemaVersion: 1 as const, jobId, jobRootDir: jobId === "ordinary-job" ? creator().jobRootDir : "/managed/job",
    workspacePath: jobId === "ordinary-job" ? creator().workspacePath : "/managed/W", runtimeSha: "a".repeat(40), runtimeManifestSha256: "b".repeat(64),
    issuerDeploymentDigest: "c".repeat(64), readonlyPaths: [jobId === "ordinary-job" ? creator().workspacePath + "/input" : "/managed/W/input"] };
  const name = hash(jobId) + ".json";
  put("policies/" + name, policy);
  put("reviews/" + name, { schemaVersion: 1, policy, corepackShim: null, reviewReference: "synthetic-review", custodyReference: "synthetic-custody" });
  put("grants/" + name, { schemaVersion: 1, jobId, jobRootDir: policy.jobRootDir, workspacePath: policy.workspacePath, profileId: "codex-test-managed-qualification" });
  const identity = { jobId, jobRootDir: policy.jobRootDir, workspacePath: policy.workspacePath, runtimeSha: policy.runtimeSha,
    runtimeManifestSha256: policy.runtimeManifestSha256, issuerDeploymentDigest: policy.issuerDeploymentDigest,
    policySha256: hash(readFileSync(join(fixture.root, "policies", name))), reviewSha256: hash(readFileSync(join(fixture.root, "reviews", name))),
    stageSha256: hash(readFileSync(join(fixture.root, stageName))), grantSha256: hash(readFileSync(join(fixture.root, "grants", name))) };
  put("codex-readonly-custody/" + name, { schemaVersion: 1, jobId, policySha256: identity.policySha256,
    reviewSha256: identity.reviewSha256, stageSha256: identity.stageSha256, snapshot: readonlyCustodySnapshot(policy) });
  const epoch = { schemaVersion: 1, hostId: "a".repeat(32), bootId: fixture.boot, supervisorId: "123:456", generation: 1,
    requirement: "test_managed_qualification", identity, phase: "closed", revoked: false, reservations: [], outerRuntime: null };
  put("readonly-enrollment.json", epoch);
  put("readonly-epoch.json", { ...epoch, generation: 2, phase: "ready" });
}

describe("explicit retained managed installation migration", () => {
  function retained() {
    seedManaged(); put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "closed" });
    return new HostedInstallationActivationStore();
  }
  it.each([false, true])("retains exact managed history and revocation while publishing only CLOSED: revoked=%s", revoked => {
    const store = retained();
    put("readonly-epoch.json", { ...read("readonly-epoch.json"), revoked });
    const before = readFileSync(join(fixture.root, "readonly-epoch.json"));
    const birth = readFileSync(join(fixture.root, "readonly-enrollment.json"));
    expect(() => store.install()).toThrow();
    const activation = store.installManaged();
    expect(activation.phase).toBe("CLOSED");
    expect(activation.exclusiveEnrollmentSha256).toBe(hash(birth));
    expect(read("ordinary-origins.json").origins).toEqual([]);
    expect(store.installManaged()).toEqual(activation);
    expect(readFileSync(join(fixture.root, "readonly-epoch.json"))).toEqual(before);
    expect(readFileSync(join(fixture.root, "readonly-enrollment.json"))).toEqual(birth);
    expect(fixture.spawn).not.toHaveBeenCalled(); expect(fixture.stops).toEqual([]);
  });
  it.each(["missing-birth", "missing-epoch", "ready", "stage", "foreign-host", "pending-epoch", "ordinary-history", "foreign-operator", "missing-terminal-proof"])(
    "rejects %s without creating installation authority", fault => {
      const store = retained();
      if (fault === "missing-birth") rmSync(join(fixture.root, "readonly-enrollment.json"));
      if (fault === "missing-epoch") rmSync(join(fixture.root, "readonly-epoch.json"));
      if (fault === "ready") put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "ready" });
      if (fault === "stage") put(stageName, { ...read(stageName), runtimeSha: "f".repeat(40) });
      if (fault === "foreign-host") put("readonly-epoch.json", { ...read("readonly-epoch.json"), hostId: "foreign-host" });
      if (fault === "pending-epoch") put("readonly-epoch.next", read("readonly-epoch.json"));
      if (fault === "ordinary-history") put("ordinary-starts/orphan.json", { incomplete: true });
      if (fault === "foreign-operator") fixture.group = "/system.slice/foreign.service";
      if (fault === "missing-terminal-proof") put("readonly-epoch.json", { ...read("readonly-epoch.json"), reservations: [{
        startId: "33333333-3333-4333-8333-333333333333", creatorId: "33333333-3333-4333-8333-333333333333",
        unit: "subscription-runtime-hosted-33333333-3333-4333-8333-333333333333.service", state: "terminal" }] });
      expect(() => store.installManaged()).toThrow();
      expect(() => read("host-installation.json")).toThrow();
      expect(fixture.spawn).not.toHaveBeenCalled(); expect(fixture.stops).toEqual([]);
    });
  it("missing activation after publication is not reconstructed on migration replay", () => {
    const store = retained(); store.installManaged(); rmSync(join(fixture.root, "host-activation.json"));
    expect(() => store.installManaged()).toThrow();
    expect(() => read("host-activation.json")).toThrow();
  });
  it("official managed migration command derives retained identity without caller-authored records", async () => {
    retained();
    // Directory provisioning is an explicit substituted host fact. All records,
    // installation validation and CLI dispatch below use the real composition.
    vi.spyOn(egressFiles, "assertHostedTestEgressDirectory").mockResolvedValue(true);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const argv = process.argv, exitCode = process.exitCode;
    try {
      process.argv = [process.execPath, "operator", "install-managed-host"];
      await import("../hosted-readonly-inputs-cli");
    } finally { process.argv = argv; process.exitCode = exitCode; vi.resetModules(); }
    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"operation":"install-managed-host"'));
    expect(read("host-activation.json").phase).toBe("CLOSED");
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});
function ordinarySlots(store: HostedInstallationActivationStore): HostedOrdinaryReservation[] {
  const origin = read("ordinary-origins.json").origins[0];
  const rows: HostedOrdinaryReservation[] = [];
  for (const [index, startId] of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"].entries()) {
    store.serialized(fence => {
      const activation = store.read(), unit = `subscription-runtime-${index ? "hosted" : "ordinary"}-${startId}.service`;
      const row = { startId, unit, creatorId: "ordinary-creator", originSha256: origin.birthSha256,
        generation: activation.generation + 1, state: HostedCustodyReservationState.Reserved };
      put(`ordinary-starts/${startId}.json`, { schemaVersion: 1, installationId: activation.installationId, activationGeneration: row.generation,
        bootId: activation.bootId, supervisorId: activation.supervisorId, jobId: origin.jobId, jobRootDir: origin.jobRootDir, workspacePath: origin.workspacePath,
        originSha256: row.originSha256, unit, controlGroup: `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`,
        creatorId: row.creatorId, creatorPidBirth: "123:456", grantSha256: null });
      store.publish(fence, { ...activation, generation: activation.generation + 1, ordinaryStarts: [...activation.ordinaryStarts, row] });
      rows.push(row);
    });
  }
  return rows;
}
function completed(row: HostedOrdinaryReservation) {
  writeFileSync(join(fixture.root, `ordinary-completed/${row.startId}.json`),
    ordinaryCompletionBytes(row.startId, hash(readFileSync(join(fixture.root, `ordinary-starts/${row.startId}.json`)))), { mode: 0o600 });
}

describe("actual activation, epoch, material and kernel transition composition", () => {
  function ordinary() {
    const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary("ordinary-creator"); store.resumeOrdinary();
    return store;
  }
  it("closes before unlocked stops, retains provider siblings, and requires explicit resume after drained return", () => {
    const store = ordinary(), rows = ordinarySlots(store);
    fixture.onStop = () => {
      expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
      expect(() => withHostedActivationFence(() => {})).not.toThrow();
      expect(() => store.resumeOrdinary()).toThrow();
    };
    store.enterExclusive(); fixture.onStop = undefined;
    expect(new Set(fixture.stops)).toEqual(new Set(rows.map(row => row.unit)));
    expect(store.read().ordinaryStarts.every(row => row.state === "reserved")).toBe(true);
    expect(() => store.finishClosed()).toThrow("creator_not_fenced");
    rows.forEach(completed);
    expect(store.finishClosed().phase).toBe("CLOSED");
    expect(store.read().ordinaryStarts.every(row => row.state === "terminal")).toBe(true);
    expect(store.resumeOrdinary().phase).toBe("ORDINARY");
  });
  it.each(["creator", "queue", "descendant", "start-binding", "stop"])("keeps %s uncertainty closed without forgetting reservations", fault => {
    const store = ordinary(), rows = ordinarySlots(store);
    rows.forEach(completed);
    if (fault === "creator") rmSync(join(fixture.root, `ordinary-completed/${rows[1]!.startId}.json`));
    if (fault === "queue") fixture.jobs = `8 ${rows[1]!.unit} start waiting\n`;
    if (fault === "descendant") fixture.populated = true;
    if (fault === "start-binding") put(`ordinary-starts/${rows[1]!.startId}.json`, { ...read(`ordinary-starts/${rows[1]!.startId}.json`), originSha256: "0".repeat(64) });
    if (fault === "stop") fixture.stopFailed = true;
    if (fault === "stop") {
      expect(() => store.enterExclusive()).toThrow("stop_incomplete");
      expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
    } else {
      store.enterExclusive();
      expect(() => store.finishClosed()).toThrow();
      expect(store.read().phase).toBe("CLOSED");
    }
    expect(store.read().ordinaryStarts).toHaveLength(2);
    expect(store.read().ordinaryStarts.some(row => row.state === "reserved")).toBe(true);
    expect(() => store.resumeOrdinary()).toThrow();
  });
  it("actual reboot fences creators but still requires queue and descendant proofs before new session", () => {
    const store = ordinary(), rows = ordinarySlots(store); store.enterExclusive();
    fixture.boot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    fixture.jobs = `8 ${rows[1]!.unit} start waiting\n`;
    expect(() => store.finishClosed()).toThrow();
    fixture.jobs = ""; fixture.populated = true;
    expect(() => store.finishClosed()).toThrow();
    fixture.populated = false;
    expect(store.finishClosed().bootId).toBe(fixture.boot);
    expect(store.read().ordinaryStarts.every(row => row.state === "terminal")).toBe(true);
    expect(store.resumeOrdinary().phase).toBe("ORDINARY");
  });
  it("activates only a READY authentic managed tuple, retains its birth on exit, and resumes a distinct ordinary origin", () => {
    const store = ordinary(); store.enterExclusive(); seedManaged();
    expect(store.finishExclusive().phase).toBe("EXCLUSIVE");
    const reference = store.read().exclusiveEnrollmentSha256;
    expect(reference).toBe(hash(readFileSync(join(fixture.root, "readonly-enrollment.json"))));
    expect(() => readHostedOrdinaryBirth("ordinary-job")).toThrow();
    store.leaveExclusive();
    expect(store.read().phase).toBe("LEAVING_EXCLUSIVE");
    expect(read("readonly-epoch.json").phase).toBe("closed");
    expect(store.finishClosed().phase).toBe("CLOSED");
    expect(store.read().exclusiveEnrollmentSha256).toBe(reference);
    expect(store.resumeOrdinary().phase).toBe("ORDINARY");
    expect(readHostedOrdinaryBirth("ordinary-job").birth.jobId).toBe("ordinary-job");
  });
  it.each(["missing-grant", "missing-policy", "missing-custody", "review-drift", "epoch-closed", "managed-reservation"])(
    "never activates exclusive with %s", fault => {
      const store = ordinary(); store.enterExclusive(); seedManaged();
      const name = hash("managed-job") + ".json";
      if (fault === "missing-grant") rmSync(join(fixture.root, "grants", name));
      if (fault === "missing-policy") rmSync(join(fixture.root, "policies", name));
      if (fault === "missing-custody") rmSync(join(fixture.root, "codex-readonly-custody", name));
      if (fault === "review-drift") put("reviews/" + name, { ...read("reviews/" + name), reviewReference: "changed" });
      if (fault === "epoch-closed") put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "closed" });
      if (fault === "managed-reservation") put("readonly-epoch.json", { ...read("readonly-epoch.json"), reservations: [
        { startId: "33333333-3333-4333-8333-333333333333", creatorId: "33333333-3333-4333-8333-333333333333",
          unit: "subscription-runtime-hosted-33333333-3333-4333-8333-333333333333.service", state: "reserved" }] });
      expect(() => store.finishExclusive()).toThrow();
      expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
      expect(store.read().exclusiveEnrollmentSha256).not.toBeNull();
    });
  it("promotion permanently outranks an ordinary birth after mutable grant/policy removal", () => {
    const store = ordinary(); store.enterExclusive(); seedManaged("ordinary-job"); store.finishExclusive(); store.leaveExclusive(); store.finishClosed();
    for (const dir of ["grants", "policies", "codex-readonly-custody"]) rmSync(join(fixture.root, dir, hash("ordinary-job") + ".json"));
    put("readonly-epoch.json", { ...read("readonly-epoch.json"), revoked: true });
    store.resumeOrdinary();
    expect(() => readHostedOrdinaryBirth("ordinary-job")).toThrow();
    expect(parseHostedActivation(read("host-activation.json")).exclusiveEnrollmentSha256).not.toBeNull();
  });
});

it("revocation closes host activation and epoch before unlocked stops of ordinary siblings", () => {
  const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary("ordinary-creator"); store.resumeOrdinary();
  store.enterExclusive(); seedManaged(); store.finishExclusive(); store.leaveExclusive(); store.finishClosed(); store.resumeOrdinary();
  const rows = ordinarySlots(store);
  fixture.onStop = () => {
    expect(store.read().phase).toBe("CLOSED");
    expect(read("readonly-epoch.json").revoked).toBe(true);
    expect(() => withHostedActivationFence(() => {})).not.toThrow();
  };
  fixture.stopFailed = true;
  expect(() => store.revokeManaged("managed-job")).toThrow("stop_incomplete");
  fixture.onStop = undefined;
  expect(new Set(fixture.stops)).toEqual(new Set(rows.map(row => row.unit)));
  expect(read(`codex-readonly-revoked/${hash("managed-job")}.json`).jobId).toBe("managed-job");
  expect(store.read().ordinaryStarts.every(row => row.state === "reserved")).toBe(true);
  expect(() => store.resumeOrdinary()).toThrow();
  expect(store.read().exclusiveEnrollmentSha256).not.toBeNull();
});

describe("ordinary dispatcher births and actual process origin", () => {
  function prepared(npm = false) {
    const store = new HostedInstallationActivationStore(); store.install();
    if (npm) put(`grants/${hash("ordinary-job")}.json`, { schemaVersion: 1, jobId: "ordinary-job",
      jobRootDir: creator().jobRootDir, workspacePath: creator().workspacePath, profileId: "codex-test-npm-qualification" });
    store.enrollOrdinary("ordinary-creator"); store.resumeOrdinary();
    const launch = creator().launch;
    return { store, launch };
  }
  function reserve(store: HostedInstallationActivationStore, launch: ReturnType<typeof creator>["launch"]) {
    return store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
  }
  function enter(unit: string) {
    fixture.runtimeUnit = unit;
    fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
  }
  it.each([false, true])("binds actual creator PID birth and private scope; npm=%s", npm => {
    const { store, launch } = prepared(npm), first = reserve(store, launch);
    // A subsequent sibling reservation changes activation generation, not the
    // identity of a retained runtime. No env job/profile is used for lookup.
    const second = reserve(store, launch);
    expect(second.start.activationGeneration).toBe(first.start.activationGeneration + 1);
    expect(first.start.creatorPidBirth).toBe(`${process.pid}:789`);
    expect(first.launch).toEqual(launch);
    expect(first.start.grantSha256).toBe(npm ? hash(readFileSync(join(fixture.root, `grants/${hash("ordinary-job")}.json`))) : null);
    enter(first.start.unit);
    withHostedActivationFence(fence => {
      const observed = readHostedOrdinaryRuntime(fence);
      expect(observed.birth.jobId).toBe("ordinary-job");
      expect(observed.reservation).toEqual(first.reservation);
      expect(observed.launch).toEqual(launch);
    });
  });
  it.each(["command", "argv", "cwd", "no-origin", "CLOSED", "stage", "creator", "descriptor", "managed-grant"])(
    "rejects dispatcher %s before reserving", fault => {
      const { store, launch } = prepared();
      if (fault === "no-origin") put("ordinary-origins.json", { ...read("ordinary-origins.json"), origins: [] });
      if (fault === "CLOSED") store.enterExclusive();
      if (fault === "stage") put(stageName, { ...read(stageName), runtimeSha: "c".repeat(40) });
      if (fault === "creator") fixture.group = "/system.slice/foreign.service";
      if (fault === "descriptor") fixture.unsafeDescriptor = true;
      if (fault === "managed-grant") put(`grants/${hash("ordinary-job")}.json`, { schemaVersion: 1, jobId: "ordinary-job",
        jobRootDir: creator().jobRootDir, workspacePath: creator().workspacePath, profileId: "codex-test-managed-qualification" });
      expect(() => store.serialized(fence => store.reserveOrdinaryRuntime(fence,
        fault === "command" ? "/foreign/node" : launch.command, fault === "argv" ? [...launch.args, "--skip-doctor"] : launch.args,
        fault === "cwd" ? "/foreign/work" : launch.cwd))).toThrow();
      expect(read("host-activation.json").ordinaryStarts).toHaveLength(0);
    });
  it("retains a reserved creator and exact successor when activation publication fails", () => {
    const { store, launch } = prepared(); fixture.failRename = "host-activation.next";
    expect(() => reserve(store, launch)).toThrow("publication interruption");
    expect(read("host-activation.next").ordinaryStarts).toHaveLength(1);
    fixture.failRename = "";
    store.recoverSerialized(() => {});
    expect(store.read().phase).toBe("CLOSED");
    expect(store.read().ordinaryStarts).toHaveLength(1);
    expect(() => store.finishClosed()).toThrow(); // Missing birth is not completion.
    expect(() => store.resumeOrdinary()).toThrow();
  });
  it("the common fence excludes exclusive entry while a reservation is prepared", () => {
    const { store, launch } = prepared();
    store.serialized(fence => {
      store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd);
      expect(() => store.enterExclusive()).toThrow();
      expect(store.read().phase).toBe("ORDINARY");
    });
    store.enterExclusive();
    expect(() => reserve(store, launch)).toThrow();
    expect(store.read().ordinaryStarts).toHaveLength(1);
  });
  it.each(["creator-reused", "creator-moved", "foreign-group", "provider-group", "boot", "generation", "origin", "installation",
    "missing-start", "missing-activation", "terminal", "CLOSED", "inventory", "stage", "custody", "revoked", "deleted-grant", "changed-grant"])(
    "rejects actual origin %s", fault => {
      const { store, launch } = prepared(true), reserved = reserve(store, launch);
      const name = `ordinary-starts/${reserved.reservation.startId}.json`;
      enter(reserved.start.unit);
      if (fault === "creator-reused") fixture.creatorBirth = "790";
      if (fault === "creator-moved") fixture.creatorGroup = "/system.slice/foreign.service";
      if (fault === "foreign-group") fixture.group = "/system.slice/foreign.service";
      if (fault === "provider-group") fixture.group = fixture.group.replace("subscription-runtime-ordinary-", "subscription-runtime-hosted-");
      if (fault === "boot") fixture.boot = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      if (fault === "generation") put(name, { ...read(name), activationGeneration: reserved.start.activationGeneration + 1 });
      if (fault === "origin") put(name, { ...read(name), jobRootDir: "/foreign/job" });
      if (fault === "installation") put(name, { ...read(name), installationId: "foreign" });
      if (fault === "missing-start") rmSync(join(fixture.root, name));
      if (fault === "missing-activation") rmSync(join(fixture.root, "host-activation.json"));
      if (fault === "terminal") put("host-activation.json", { ...read("host-activation.json"), ordinaryStarts: [{ ...reserved.reservation, state: "terminal" }] });
      if (fault === "CLOSED") put("host-activation.json", { ...read("host-activation.json"), phase: "CLOSED" });
      if (fault === "inventory") put("readonly-inventory.json", { ...read("readonly-inventory.json"), ordinaryCreators: [] });
      if (fault === "stage") put(stageName, { ...read(stageName), runtimeManifestSha256: "d".repeat(64) });
      if (fault === "custody" || fault === "revoked") put(`codex-readonly-${fault}/${hash("ordinary-job")}.json`, { schemaVersion: 1 });
      if (fault === "deleted-grant") rmSync(join(fixture.root, `grants/${hash("ordinary-job")}.json`));
      if (fault === "changed-grant") put(`grants/${hash("ordinary-job")}.json`, { ...read(`grants/${hash("ordinary-job")}.json`), profileId: "codex-test-managed-qualification" });
      expect(() => withHostedActivationFence(fence => readHostedOrdinaryRuntime(fence))).toThrow();
    });
});

describe("managed preparation under the installed common fence", () => {
  function installed() {
    const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary("ordinary-creator"); store.resumeOrdinary();
    return store;
  }
  it.each(["ORDINARY", "CLOSED", "EXCLUSIVE", "LEAVING_EXCLUSIVE"])("rejects preparation in %s before material effects", phase => {
    const store = installed();
    if (phase === "CLOSED") { store.enterExclusive(); store.finishClosed(); }
    if (phase === "EXCLUSIVE" || phase === "LEAVING_EXCLUSIVE") {
      store.enterExclusive(); seedManaged(); store.finishExclusive();
      if (phase === "LEAVING_EXCLUSIVE") store.leaveExclusive();
    }
    const effects = vi.fn();
    expect(() => store.withExclusivePreparation(effects)).toThrow();
    expect(effects).not.toHaveBeenCalled();
  });
  it.each(["creator", "queue", "descendants"])("requires independent ordinary %s proof before managed material effects", fault => {
    const store = installed(), rows = ordinarySlots(store); store.enterExclusive();
    if (fault !== "creator") rows.forEach(completed);
    if (fault === "queue") fixture.jobs = `9 ${rows[1]!.unit} start waiting\n`;
    if (fault === "descendants") fixture.populated = true;
    const effects = vi.fn();
    expect(() => store.withExclusivePreparation(effects)).toThrow();
    expect(effects).not.toHaveBeenCalled();
    expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
  });
  it("enrolls under the existing fence, and retains the permanent birth when subsequent material publication fails", () => {
    const store = installed(); store.enterExclusive(); seedManaged();
    const epoch = read("readonly-enrollment.json");
    for (const path of ["readonly-enrollment.json", "readonly-epoch.json", `codex-readonly-custody/${hash("managed-job")}.json`]) rmSync(join(fixture.root, path));
    expect(() => store.withExclusivePreparation(fence => {
      expect(() => withHostedActivationFence(() => {})).toThrow();
      const enrolled = new HostedReadonlyEpochStore().enrollWithHeldFence(fence, epoch.identity,
        { hostId: epoch.hostId, bootId: epoch.bootId, supervisorId: epoch.supervisorId });
      expect(enrolled.phase).toBe("closed");
      throw new Error("synthetic material publication interruption");
    })).toThrow("material publication interruption");
    expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
    expect(store.read().exclusiveEnrollmentSha256).toBe(hash(readFileSync(join(fixture.root, "readonly-enrollment.json"))));
    expect(() => store.finishExclusive()).toThrow();
  });
  it("recovers genuine managed material under the same fence but requires separate EXCLUSIVE activation", () => {
    const store = installed(), rows = ordinarySlots(store); rows.forEach(completed); store.enterExclusive(); seedManaged();
    const identity = read("readonly-enrollment.json").identity;
    put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "closed" });
    store.withExclusivePreparation(fence => {
      expect(store.read().ordinaryStarts.every(row => row.state === "terminal")).toBe(true);
      new HostedReadonlySupervisorHost().recoverWithHeldFence(fence, identity);
    }, true);
    expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
    expect(read("readonly-epoch.json").phase).toBe("ready");
    expect(store.finishExclusive().phase).toBe("EXCLUSIVE");
  });
  it("recovers an exact pending epoch publication without allowing missing history or losing the activation fence", () => {
    const store = installed(); store.enterExclusive(); seedManaged();
    const epoch = read("readonly-epoch.json");
    put("readonly-epoch.next", { ...epoch, phase: "closed" });
    expect(() => store.withExclusivePreparation(() => {})).toThrow();
    store.withExclusivePreparation(fence => new HostedReadonlySupervisorHost().recoverWithHeldFence(fence, epoch.identity), true);
    expect(read("readonly-epoch.json").phase).toBe("ready");
    expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
    rmSync(join(fixture.root, "readonly-epoch.json"));
    expect(() => store.withExclusivePreparation(() => {}, true)).toThrow();
  });
});

it("the official recover CLI uses installed exclusive preparation and leaves host activation fenced", async () => {
  const store = new HostedInstallationActivationStore(); store.install(); store.enterExclusive(); seedManaged();
  put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "closed" });
  const argv = process.argv, exitCode = process.exitCode;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    process.argv = [process.execPath, "hosted-readonly-inputs-cli.js", "recover", "managed-job"];
    await import("../hosted-readonly-inputs-cli");
    expect(errors).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"phase":"ready"'));
    expect(read("readonly-epoch.json").phase).toBe("ready");
    expect(store.read().phase).toBe("ENTERING_EXCLUSIVE");
    expect(store.read().exclusiveEnrollmentSha256).not.toBeNull();
  } finally { process.argv = argv; process.exitCode = exitCode; output.mockRestore(); errors.mockRestore(); }
});

describe("real default provider primitive under ordinary activation", () => {
  function runtime(npm = false, managedHistory = false) {
    const store = new HostedInstallationActivationStore(); store.install();
    if (npm) put(`grants/${hash("ordinary-job")}.json`, { schemaVersion: 1, jobId: "ordinary-job", jobRootDir: creator().jobRootDir,
      workspacePath: creator().workspacePath, profileId: "codex-test-npm-qualification" });
    store.enrollOrdinary("ordinary-creator"); store.resumeOrdinary();
    if (managedHistory) { store.enterExclusive(); seedManaged(); store.finishExclusive(); store.leaveExclusive(); store.finishClosed(); store.resumeOrdinary(); }
    const launch = creator().launch;
    const { start } = store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
    fixture.runtimeUnit = start.unit; fixture.group = start.controlGroup;
    const input = { command: "/TEST/codex", args: ["app-server"], cwd: creator().workspacePath, env: {
      SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE:
        npm ? "codex-test-npm-qualification" : "codex-provider-api", TEST_BOOTSTRAP_VALUE: "fixture-only" } };
    return { store, input };
  }
  it.each(["app-server", "app-server-goal", "packaged-exec", "plain-exec"] as const)("no-grant egress preserves ordinary engine eligibility: %s", async executionEngine => {
    const { input } = runtime();
    const identity = { jobId: creator().jobId, jobRootDir: creator().jobRootDir, workspacePath: creator().workspacePath,
      sourceEnv: input.env, executionEngine };
    const policy = await admitHostedTestEgress(identity);
    expect(policy.profileId).toBe("codex-provider-api");
    expect(admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy })).toBeUndefined();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])("official controller composition preserves the genuine default factory; npm=%s", async npm => {
    const { store, input } = runtime(npm);
    const identity = { jobId: creator().jobId, jobRootDir: creator().jobRootDir, workspacePath: creator().workspacePath, sourceEnv: input.env };
    const policy = await admitHostedTestEgress(identity);
    expect(policy.profileId).toBe(input.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE);
    expect(admitHostedReadonlyInputs({ ...identity, providerEgressPolicy: policy })).toBeUndefined();
    const launch = { cwd: input.cwd, logPath: "/TEST/run.log", cliCommand: [process.execPath, "cli.js"],
      config: { ...identity, taskId: identity.jobId, authRootDir: "/TEST/auth-unused", promptPath: "/TEST/prompt-unused", accounts: [{ name: "TEST" }] } };
    await expect(routeHostedGoalLaunch(launch)).resolves.toBeUndefined();
    await expect(routeHostedRuntimeCommand(creator().launch.args)).resolves.toBeUndefined();
    const admitted = await admitHostedControllerLaunch(launch);
    admitted.processFactory(input);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(store.read().ordinaryStarts).toHaveLength(2);
    put("host-activation.json", { ...read("host-activation.json"), phase: "CLOSED" });
    expect(() => admitted.processFactory({ ...input, env: { ...input.env, CODEX_HOME: "/TEST/next-account-unused" } })).toThrow();
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
  });
  it.each(["identity", "workspace", "policy", "grant-deleted", "engine", "environment"])("official admission rejects %s before effects", async fault => {
    const { input } = runtime(true);
    const identity = { jobId: creator().jobId, jobRootDir: creator().jobRootDir, workspacePath: creator().workspacePath, sourceEnv: input.env };
    if (fault === "identity") identity.jobId = "foreign-job";
    if (fault === "workspace") identity.workspacePath = "/foreign/workspace";
    if (fault === "policy") put(`policies/${hash("ordinary-job")}.json`, { schemaVersion: 1 });
    if (fault === "grant-deleted") rmSync(join(fixture.root, `grants/${hash("ordinary-job")}.json`));
    if (fault === "environment") input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND = "";
    await expect(admitHostedTestEgress({ ...identity, ...(fault === "engine" ? { executionEngine: "plain-exec" as const } : {}) })).rejects.toThrow();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it.each([false, true])("the default primitive reserves before real mocked OS submission; npm=%s", npm => {
    const { store, input } = runtime(npm);
    fixture.spawn.mockImplementation(() => {
      expect(store.read().ordinaryStarts).toHaveLength(2);
      expect(() => withHostedActivationFence(() => {})).toThrow();
      expect(() => store.enterExclusive()).toThrow();
      return fixture.child;
    });
    const child = spawnCodexAppServerProcess(input);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = fixture.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(["/opt/subscription-runtime/managed-launcher/launch.mjs", "provider"]);
    const request = JSON.parse(args[2]);
    expect(request).toEqual({ operation: "provider", jobId: "ordinary-job", unit: store.read().ordinaryStarts[1]!.unit,
      payload: [process.execPath, expect.stringMatching(/\/hosted-app-server-launcher\.js$/)] });
    expect(request.readonlyPaths).toBeUndefined();
    expect(options).toEqual(expect.objectContaining({ cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] }));
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify({ schemaVersion: 1, ...input,
      env: { ...input.env, SUBSCRIPTION_RUNTIME_JOB_ID: "ordinary-job" } }) + "\n");
    const reservation = store.read().ordinaryStarts[1]!;
    (fixture.child as EventEmitter).emit("exit", 0, null);
    expect(read(`ordinary-completed/${reservation.startId}.json`).startSha256).toBe(hash(readFileSync(join(fixture.root, `ordinary-starts/${reservation.startId}.json`))));
    expect(store.read().ordinaryStarts[1]!.state).toBe("reserved"); // Queue/descendants still require independent proof.
  });
  it("retains provider siblings across respawns and admits a distinct origin after explicit managed drain", () => {
    const { store, input } = runtime(true, true);
    spawnCodexAppServerProcess(input);
    spawnCodexAppServerProcess({ ...input, env: { ...input.env, CODEX_HOME: "/TEST/second-account" } });
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect(store.read().ordinaryStarts).toHaveLength(3);
    expect(new Set(store.read().ordinaryStarts.map(row => row.unit)).size).toBe(3);
    rmSync(join(fixture.root, `grants/${hash("ordinary-job")}.json`));
    expect(() => spawnCodexAppServerProcess(input)).toThrow();
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
  });
  it("a forged managed ticket cannot bypass actual ordinary origin after environment stripping", () => {
    const { input } = runtime(); input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND = "";
    expect(() => spawnCodexAppServerProcess(input, undefined, undefined, {})).toThrow();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it("namespace-local root/non-root is not the enrolled host operator", () => {
    const { input } = runtime(); vi.spyOn(process, "getuid").mockReturnValue(65532);
    expect(() => spawnCodexAppServerProcess(input)).toThrow();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it.each(["CLOSED", "missing", "profile", "deleted-grant", "environment", "group", "creator", "managed", "cwd"])(
    "default provider rejects %s before spawn", fault => {
      const { input } = runtime(true);
      if (fault === "cwd") input.cwd = "/foreign/workspace";
      if (fault === "CLOSED") put("host-activation.json", { ...read("host-activation.json"), phase: "CLOSED" });
      if (fault === "missing") rmSync(join(fixture.root, "host-activation.json"));
      if (fault === "profile") input.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE = "codex-provider-api";
      if (fault === "deleted-grant") rmSync(join(fixture.root, `grants/${hash("ordinary-job")}.json`));
      if (fault === "environment") input.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND = "";
      if (fault === "group") fixture.group = "/system.slice/foreign.service";
      if (fault === "creator") fixture.creatorBirth = "790";
      if (fault === "managed") seedManaged("ordinary-job");
      expect(() => spawnCodexAppServerProcess(input)).toThrow();
      expect(fixture.spawn).not.toHaveBeenCalled();
    });
  it("a synchronous ambiguous submit closes activation and retains the sibling without a completion receipt", () => {
    const { store, input } = runtime(); fixture.spawn.mockImplementation(() => { throw new Error("ambiguous OS submit"); });
    expect(() => spawnCodexAppServerProcess(input)).toThrow("ambiguous OS submit");
    expect(store.read().phase).toBe("CLOSED");
    expect(store.read().ordinaryStarts).toHaveLength(2);
    expect(() => read(`ordinary-completed/${store.read().ordinaryStarts[1]!.startId}.json`)).toThrow();
  });
  it.each(["signal", "stdin", "error"])("%s followed by late zero cannot mint creator completion", fault => {
    const { store, input } = runtime(), child = spawnCodexAppServerProcess(input);
    if (fault === "signal") signalCodexAppServerChildGroup(child, "SIGTERM");
    if (fault === "stdin") (child.stdin as unknown as EventEmitter).emit("error", new Error("fixture pipe failure"));
    if (fault === "error") (fixture.child as EventEmitter).emit("error", new Error("fixture process failure"));
    (fixture.child as EventEmitter).emit("exit", 0, null);
    expect(() => read(`ordinary-completed/${store.read().ordinaryStarts[1]!.startId}.json`)).toThrow();
  });
});

describe("actual ordinary outer dispatcher and fixed bootstrap", () => {
  function ordinary() {
    const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary("ordinary-creator"); store.resumeOrdinary();
    return store;
  }
  it("reserves the inventoried outer unit before synchronous submit and records only its normal wait", async () => {
    const store = ordinary(), launch = creator().launch;
    fixture.spawn.mockImplementation(() => {
      expect(store.read().ordinaryStarts).toHaveLength(1);
      expect(() => withHostedActivationFence(() => {})).toThrow();
      return fixture.child;
    });
    const pending = runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, { TEST_PRIVATE_ENV: "fixture" });
    const [command, args] = fixture.spawn.mock.calls[0]!;
    expect(command).toBe("/usr/bin/systemd-run");
    expect(args).toContain("ordinary-bootstrap");
    expect(args).toContain(`--working-directory=${launch.cwd}`);
    expect(args).not.toContain("TEST_PRIVATE_ENV");
    const row = store.read().ordinaryStarts[0]!;
    (fixture.child as EventEmitter).emit("exit", 0, null);
    expect(await pending).toBe(0);
    expect(store.read().phase).toBe("ORDINARY");
    expect(store.read().ordinaryStarts[0]!.state).toBe("reserved");
    expect(read(`ordinary-completed/${row.startId}.json`).startSha256).toBe(hash(readFileSync(join(fixture.root, `ordinary-starts/${row.startId}.json`))));
  });
  it.each(["signal", "stdin", "error", "nonzero"])("%s closes activation before unlocked stops and never creates a late-zero receipt", async fault => {
    const store = ordinary(), launch = creator().launch;
    const pending = runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, {});
    fixture.onStop = () => {
      expect(store.read().phase).toBe("CLOSED");
      expect(() => withHostedActivationFence(() => {})).not.toThrow();
    };
    const child = fixture.child as EventEmitter & { stdin: EventEmitter };
    if (fault === "signal") process.emit("SIGTERM");
    if (fault === "stdin") child.stdin.emit("error", new Error("synthetic pipe failure"));
    if (fault === "error") child.emit("error", new Error("synthetic spawn failure"));
    if (fault === "nonzero") child.emit("exit", 1, null);
    child.emit("exit", 0, null);
    expect(await pending).toBe(fault === "nonzero" ? 1 : 70);
    expect(store.read().phase).toBe("CLOSED");
    expect(fixture.stops).toContain(store.read().ordinaryStarts[0]!.unit);
    expect(() => read(`ordinary-completed/${store.read().ordinaryStarts[0]!.startId}.json`)).toThrow();
  });
  it("a failed synchronous dispatcher submit retains the creator and closes future starts", async () => {
    const store = ordinary(), launch = creator().launch;
    fixture.spawn.mockImplementation(() => { throw new Error("synthetic ambiguous submit"); });
    await expect(runHostedRuntimeForeground(launch.command, launch.args, launch.cwd, {})).rejects.toThrow("ambiguous submit");
    expect(store.read().phase).toBe("CLOSED");
    expect(store.read().ordinaryStarts).toHaveLength(1);
  });
  it.each(["ordinary", "closed", "grant-changed", "inner-runtime", "inner-closed", "inner-grant-deleted"])("official stop retains custody and uses positive ordinary origin: %s", mode => {
    const store = ordinary(), launch = creator().launch;
    if (mode === "inner-grant-deleted") put(`grants/${hash(creator().jobId)}.json`, { schemaVersion: 1,
      jobId: creator().jobId, jobRootDir: creator().jobRootDir, workspacePath: creator().workspacePath,
      profileId: "codex-test-npm-qualification" });
    const prepared = store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
    if (mode === "closed" || mode === "inner-closed") put("host-activation.json", { ...read("host-activation.json"), phase: "CLOSED" });
    if (mode === "grant-changed") put(`grants/${hash(creator().jobId)}.json`, { invalid: true });
    if (mode === "inner-grant-deleted") rmSync(join(fixture.root, `grants/${hash(creator().jobId)}.json`), { force: true });
    if (mode.startsWith("inner-")) { fixture.runtimeUnit = prepared.start.unit; fixture.group = prepared.start.controlGroup; }
    fixture.onStop = () => {
      expect(store.read().phase).toBe("CLOSED");
      expect(() => withHostedActivationFence(() => {})).not.toThrow();
    };
    stopHostedGoalLaunch({ cwd: launch.cwd, logPath: "/TEST/run.log", cliCommand: [launch.command],
      config: { taskId: creator().jobId, jobId: creator().jobId, jobRootDir: creator().jobRootDir,
        workspacePath: creator().workspacePath, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted" },
        promptPath: "/TEST/prompt-unused", authRootDir: "/TEST/auth-unused", accounts: [{ name: "TEST" }] } });
    expect(fixture.stops).toContain(prepared.reservation.unit);
    if (mode.startsWith("inner-")) expect(() => store.serialized(fence => readHostedOrdinaryRuntime(fence))).toThrow();
    expect(store.read().ordinaryStarts[0]!.state).toBe("reserved");
    expect(() => read(`ordinary-completed/${prepared.reservation.startId}.json`)).toThrow();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it.each(["identity", "start-scope", "start-origin", "missing-start", "foreign-operator", "stage-drift"])("ordinary stop rejects %s before publishing or signaling", fault => {
    const store = ordinary(), launch = creator().launch;
    const prepared = store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
    const name = `ordinary-starts/${prepared.reservation.startId}.json`;
    if (fault === "start-scope") put(name, { ...read(name), workspacePath: "/foreign" });
    if (fault === "start-origin") put(name, { ...read(name), originSha256: "f".repeat(64) });
    if (fault === "missing-start") rmSync(join(fixture.root, name));
    if (fault === "foreign-operator") fixture.group = "/system.slice/foreign.service";
    if (fault === "stage-drift") put(stageName, { ...read(stageName), runtimeSha: "f".repeat(40) });
    const before = read("host-activation.json");
    expect(() => store.stopOrdinaryRuntime({ jobId: creator().jobId, jobRootDir: creator().jobRootDir,
      workspacePath: fault === "identity" ? "/foreign" : creator().workspacePath })).toThrow();
    expect(read("host-activation.json")).toEqual(before);
    expect(fixture.stops).toEqual([]);
  });
  it("ordinary stop signals only the selected job and retains every sibling reservation", () => {
    const other = { ...creator(), creatorId: "other-creator", jobId: "other-job", jobRootDir: "/jobs/other-job", workspacePath: "/work/other-job",
      launch: { ...creator().launch, args: [...creator().launch.args.slice(0, -1), "other-job"], cwd: "/work/other-job" } };
    put("readonly-inventory.json", { ...read("readonly-inventory.json"), ordinaryCreators: [creator(), other] });
    const store = new HostedInstallationActivationStore(); store.install();
    store.enrollOrdinary(creator().creatorId); store.enrollOrdinary(other.creatorId); store.resumeOrdinary();
    const reserve = (launch: typeof other.launch) => store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
    const first = reserve(creator().launch), second = reserve(other.launch);
    expect(store.stopOrdinaryRuntime(creator())).toBe(true);
    expect(fixture.stops).toContain(first.reservation.unit);
    expect(fixture.stops).not.toContain(second.reservation.unit);
    expect(store.read().ordinaryStarts.map(row => row.state)).toEqual(["reserved", "reserved"]);
    fixture.stopFailed = true;
    expect(() => store.stopOrdinaryRuntime(creator())).toThrow("hosted_activation_stop_incomplete");
    expect(store.read().phase).toBe("CLOSED");
    expect(store.read().ordinaryStarts.map(row => row.state)).toEqual(["reserved", "reserved"]);
  });
  it.each(["valid", "command-in-frame", "closed"])("fixed bootstrap derives its command from actual private origin: %s", async mode => {
    const store = ordinary(), launch = creator().launch;
    const prepared = store.serialized(fence => store.reserveOrdinaryRuntime(fence, launch.command, launch.args, launch.cwd));
    fixture.runtimeUnit = prepared.start.unit; fixture.group = prepared.start.controlGroup;
    const input = new PassThrough();
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
    if (mode === "closed") put("host-activation.json", { ...read("host-activation.json"), phase: "CLOSED" });
    const pending = runHostedOrdinaryBootstrap();
    input.end(JSON.stringify({ schemaVersion: 1, env: { TEST_FRAME: "fixture" }, ...(mode === "command-in-frame" ? { command: "/foreign" } : {}) }));
    if (mode !== "valid") {
      await expect(pending).rejects.toThrow(); expect(fixture.spawn).not.toHaveBeenCalled(); return;
    }
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce());
    expect(fixture.spawn).toHaveBeenCalledWith(launch.command, launch.args, { cwd: launch.cwd, env: { TEST_FRAME: "fixture" }, stdio: ["pipe", "inherit", "inherit"] });
    (fixture.child as EventEmitter).emit("exit", 0, null);
    expect(await pending).toBe(0);
  });
});

it.each(["api", "npm", "npm-grant-deleted"])("real ordinary runner and default factory revalidate on quota account switch: %s", async mode => {
  const config = { jobId: "ordinary-job", taskId: "ordinary-job", jobRootDir: join(fixture.root, "jobs/ordinary-job"),
    workspacePath: join(fixture.root, "jobs/ordinary-job/workspace"), promptPath: join(fixture.root, "prompt"),
    authRootDir: join(fixture.root, "unused-synthetic-auth"), accounts: codexGoalAccountSlots(["fake-a", "fake-b"]),
    maxAccountCycles: 1, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } };
  mkdirSync(config.jobRootDir, { recursive: true, mode: 0o700 }); mkdirSync(config.workspacePath); writeFileSync(config.promptPath, "Offline rotation");
  const bound = { ...creator(), jobRootDir: config.jobRootDir, workspacePath: config.workspacePath,
    launch: { ...creator().launch, cwd: config.workspacePath } };
  put("readonly-inventory.json", { ...read("readonly-inventory.json"), ordinaryCreators: [bound] });
  const grant = `grants/${hash(config.jobId)}.json`;
  if (mode !== "api") put(grant, { schemaVersion: 1, jobId: config.jobId, jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath, profileId: "codex-test-npm-qualification" });
  const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary(bound.creatorId); store.resumeOrdinary();
  const prepared = store.serialized(fence => store.reserveOrdinaryRuntime(fence, bound.launch.command, bound.launch.args, bound.launch.cwd));
  fixture.runtimeUnit = prepared.start.unit; fixture.group = prepared.start.controlGroup;
  const fakes = [new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "You've hit your usage limit",
    onRequest: request => { if (request.method === "turn/start" && mode === "npm-grant-deleted") rmSync(join(fixture.root, grant)); } }), new FakeAppServerFactory()];
  const frames: { env: Record<string, string> }[] = [];
  fixture.spawn.mockImplementation((command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(["/opt/subscription-runtime/managed-launcher/launch.mjs", "provider"]);
    expect(options.cwd).toBe(options.env.HOME);
    expect(options.cwd).not.toBe(config.workspacePath);
    expect(store.read().ordinaryStarts).toHaveLength(frames.length + 2);
    expect(() => withHostedActivationFence(() => {})).toThrow();
    const request = JSON.parse(args[2]!);
    expect(request).toEqual({ operation: "provider", jobId: config.jobId,
      unit: store.read().ordinaryStarts[frames.length + 1]!.unit,
      payload: [process.execPath, expect.stringMatching(/\/hosted-app-server-launcher\.js$/)] });
    expect(request.readonlyPaths).toBeUndefined();
    const child = fakes[frames.length]!.create({ ...options, args });
    const write = child.stdin.write; let bootstrap = true;
    child.stdin.write = chunk => {
      if (bootstrap) { frames.push(JSON.parse(String(chunk))); bootstrap = false; return true; }
      return write(chunk);
    };
    return child;
  });
  fixture.onStop = () => { for (const fake of fakes) for (const child of fake.processes) child.kill(); };
  const clock = { now: () => new Date("2026-05-31T00:05:00.000Z"), monotonicMs: () => performance.now() };
  const result = await runCodexGoal(config, {
    createExecutor: options => new FileBackendCodexSafeExecutor({
    ...options, requireGitWorkspace: false, prewarmOnStart: false, clock,
    accounts: options.accounts.map((account, index) => ({
      codexAuthJson: codexAuthJsonForAccount(`synthetic-refresh-${index}`, `synthetic-account-${index}`),
      worker: { ...account.worker, clock, warmupPrompt: false, runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }) },
    })),
  }) });
  expect(fixture.spawn).toHaveBeenCalledTimes(mode === "npm-grant-deleted" ? 1 : 2);
  expect(result.attempts[0]?.failureReason, result.attempts[0]?.failureMessage).toBe("quota_limited");
  expect(frames.every(frame => frame.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE ===
    (mode === "api" ? "codex-provider-api" : "codex-test-npm-qualification"))).toBe(true);
  if (mode === "npm-grant-deleted") expect(result.status).not.toBe("completed");
  else { expect(result.status).toBe("completed"); expect(new Set(frames.map(frame => frame.env.CODEX_HOME)).size).toBe(2); }
});

// C1-R1: the genuine migrated installation binds both submission boundaries.
describe("managed inspected installation admission", () => {
  function migrated() {
    seedManaged(); put("readonly-epoch.json", { ...read("readonly-epoch.json"), phase: "closed" });
    const store = new HostedInstallationActivationStore(); store.installManaged(); store.enterExclusive();
    store.withExclusivePreparation(fence => new HostedReadonlySupervisorHost().recoverWithHeldFence(fence, read("readonly-epoch.json").identity));
    store.finishExclusive();
  }
  function drift(fault: string) {
    if (fault === "inventory") {
      const inventory = read("readonly-inventory.json"); inventory.runtimeLaunch.args.push("--UNREVIEWED-TEST-ARG");
      put("readonly-inventory.json", inventory);
    }
    if (fault === "directory") put("host-installation.json", { ...read("host-installation.json"), runtimeDirectory: "/TEST/foreign" });
    if (fault === "digest") put("host-installation.json", { ...read("host-installation.json"), inventorySha256: "f".repeat(64) });
    if (fault === "stage") put(stageName, { ...read(stageName), runtimeSha: "f".repeat(40) });
  }
  it.each(["exact", "inventory", "directory", "digest", "stage"])("outer submission binds %s before callback", fault => {
    migrated(); drift(fault);
    const command = read("readonly-inventory.json").runtimeLaunch, submit = vi.fn(() => 17);
    const run = () => new HostedReadonlySupervisorHost().runRuntimeLaunch(command.command, command.args, command.cwd, submit);
    if (fault === "exact") { expect(run()).toBe(17); expect(submit).toHaveBeenCalledOnce(); }
    else { expect(run).toThrow(); expect(submit).not.toHaveBeenCalled(); }
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it.each(["exact", "inventory", "directory", "digest", "stage"])("retained provider factory binds %s before spawn", fault => {
    migrated(); const command = read("readonly-inventory.json").runtimeLaunch;
    new HostedReadonlySupervisorHost().runRuntimeLaunch(command.command, command.args, command.cwd, () => 17);
    const epoch = read("readonly-epoch.json"); fixture.runtimeUnit = epoch.outerRuntime.unit;
    fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${fixture.runtimeUnit}`;
    mkdirSync(join(fixture.root, "codex-readonly-services"), { mode: 0o700 });
    mkdirSync(join(fixture.root, "codex-readonly-services", hash("managed-job") + ".json"), { mode: 0o700 });
    const factory = admitHostedReadonlyInputs({ ...epoch.identity, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
      providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification) })!;
    drift(fault);
    const launch = () => factory({ command: "/TEST/codex", args: ["app-server"], cwd: "/managed/W", env: {
      SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job", SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: "codex-test-managed-qualification" } });
    if (fault === "exact") {
      launch(); expect(fixture.spawn).toHaveBeenCalledOnce();
      const request = JSON.parse(fixture.spawn.mock.calls[0]![1][2]);
      expect(request.readonlyPaths).toContain("/managed/W/input");
      expect(read("readonly-epoch.json").reservations).toHaveLength(1);
    } else { expect(launch).toThrow(); expect(fixture.spawn).not.toHaveBeenCalled(); }
  });
});
