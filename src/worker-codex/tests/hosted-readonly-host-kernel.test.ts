import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostedReadonlyHostKernel, completionBytes, completionPath } from "../hosted-readonly-host-kernel";

// OS observations are synthetic. The production kernel parser and decision code
// run unchanged; no host inventory, systemd manager or credentials are accessed.
const os = vi.hoisted(() => ({ files: new Map<string, string>(), records: new Map<string, Buffer>(),
  groups: new Map<string, string[]>(), units: "", jobs: "", show: new Map<string, string>(),
  descriptors: vi.fn(), operator: vi.fn(), systemctl: vi.fn() }));
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  readFileSync: (path: string) => {
    if (!os.files.has(path)) throw Object.assign(new Error("synthetic absent file"), { code: "ENOENT" });
    return os.files.get(path)!;
  },
  readdirSync: (path: string) => (os.groups.get(path) ?? []).map(name => ({ name, isDirectory: () => true })),
  realpathSync: (path: string) => path,
  lstatSync: () => ({ isDirectory: () => true, uid: 0, mode: 0o755 }),
  openSync: () => 99,
  fstatSync: () => ({ isFile: () => true, uid: 0, mode: 0o644, nlink: 1, size: 8, ctimeMs: 1 }),
  readSync: (_fd: number, buffer: Buffer) => { buffer.write("reviewed"); return 8; },
  closeSync: () => {},
}));
vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => os.systemctl(...args) }));
vi.mock("../hosted-readonly-authority", async original => ({
  ...await original<typeof import("../hosted-readonly-authority")>(), assertReadonlyHostOperator: os.operator,
}));
vi.mock("../hosted-readonly-inputs", async original => ({
  ...await original<typeof import("../hosted-readonly-inputs")>(),
  readHostedPrivateBytes: (path: string) => os.records.get(path) ?? null,
}));
vi.mock("@vioxen/subscription-runtime/provider-codex", () => ({ assertHostedProcessDescriptors: os.descriptors }));
const root = "/var/lib/subscription-runtime-host-policy";
const hostId = "a".repeat(32), bootId = "11111111-1111-4111-8111-111111111111";
const startId = "22222222-2222-4222-8222-222222222222";
const reservation = { startId, creatorId: startId, unit: `subscription-runtime-hosted-${startId}.service`, state: "reserved" as never };
function inventory() {
  return { schemaVersion: 1, hostId, supervisorUnit: "trusted.service",
    units: [{ name: "trusted.service", controlGroup: "/system.slice/trusted.service",
      fragmentSha256: createHash("sha256").update("reviewed").digest("hex") }],
    runtimeLaunch: { command: "/runtime/node", args: ["/runtime/cli.js"], cwd: "/synthetic/W" } };
}
function publish(value: unknown) { os.records.set(root + "/readonly-inventory.json", Buffer.from(JSON.stringify(value))); }
function show(name: string, group: string, pid: string) {
  return `Id=${name}\nFragmentPath=/etc/systemd/system/${name}\nControlGroup=${group}\nMainPID=${pid}\nDropInPaths=\n`;
}
beforeEach(() => {
  vi.resetAllMocks(); os.files.clear(); os.records.clear(); os.groups.clear(); os.show.clear();
  os.units = "init.scope loaded active running init\ntrusted.service loaded active running trusted\n"; os.jobs = ""; publish(inventory());
  os.files.set("/etc/machine-id", hostId); os.files.set("/proc/sys/kernel/random/boot_id", bootId);
  os.files.set("/proc/self/cgroup", "0::/system.slice/trusted.service\n");
  os.files.set("/proc/123/stat", "123 (supervisor with spaces) " + [...Array(19).fill("0"), "456"].join(" "));
  os.show.set("trusted.service", show("trusted.service", "/system.slice/trusted.service", "123"));
  os.show.set(reservation.unit, show(reservation.unit, "", "0"));
  for (const [group, children, pids] of [
    ["", ["system.slice", "init.scope"], ""], ["/init.scope", [], "1\n"],
    ["/system.slice", ["trusted.service"], ""], ["/system.slice/trusted.service", [], "123\n"],
  ] as const) {
    os.groups.set("/sys/fs/cgroup" + group, [...children]);
    os.files.set("/sys/fs/cgroup" + group + "/cgroup.procs", pids);
  }
  os.systemctl.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe("/usr/bin/systemctl");
    let stdout;
    if (args[0] === "list-units") stdout = os.units;
    else if (args[0] === "list-jobs") stdout = os.jobs;
    else if (args[0] === "show") stdout = os.show.get(args.at(-1)!);
    else throw new Error("unplanned synthetic systemctl operation");
    return { status: stdout === undefined ? 1 : 0, stdout: stdout ?? "" };
  });
});
describe("host kernel from explicit synthetic OS facts", () => {
  it("binds exact supervisor cgroup, PID birth, host and boot; accepts finite inventory", () => {
    const kernel = new HostedReadonlyHostKernel();
    expect(kernel.session()).toEqual({ hostId, bootId, supervisorId: "123:456" });
    expect(() => kernel.verifyExclusiveInventory()).not.toThrow();
  });
  it.each(["unknown-unit", "unlisted-process", "init-sibling", "queued-start", "changed-fragment", "unreviewed-dropin", "wrong-caller", "wrong-host", "manager-error"])
  ("rejects %s before exclusive readiness", fault => {
    if (fault === "unknown-unit") os.units += "sibling.service loaded active running sibling\n";
    if (fault === "unlisted-process") os.files.set("/sys/fs/cgroup/system.slice/cgroup.procs", "999\n");
    if (fault === "init-sibling") os.files.set("/sys/fs/cgroup/init.scope/cgroup.procs", "1\n999\n");
    if (fault === "queued-start") os.jobs = "7 sibling.service start waiting\n";
    if (fault === "changed-fragment") { const value = inventory(); value.units[0]!.fragmentSha256 = "0".repeat(64); publish(value); }
    if (fault === "unreviewed-dropin") os.show.set("trusted.service", os.show.get("trusted.service")!.replace("DropInPaths=", "DropInPaths=/etc/systemd/system/trusted.service.d/override.conf"));
    if (fault === "wrong-caller") os.files.set("/proc/self/cgroup", "0::/system.slice/sibling.service\n");
    if (fault === "wrong-host") os.files.set("/etc/machine-id", "b".repeat(32));
    if (fault === "manager-error") os.systemctl.mockReturnValue({ status: 1, stdout: "" });
    expect(() => new HostedReadonlyHostKernel().verifyExclusiveInventory()).toThrow();
  });
  it.each(["extra-key", "duplicate-unit", "broad-cgroup", "missing", "bad-json"])("rejects %s inventory", fault => {
    const value = inventory();
    if (fault === "extra-key") publish({ ...value, approved: true });
    if (fault === "duplicate-unit") publish({ ...value, units: [...value.units, ...value.units] });
    if (fault === "broad-cgroup") { value.units[0]!.controlGroup = "/"; publish(value); }
    if (fault === "missing") os.records.clear();
    if (fault === "bad-json") os.records.set(root + "/readonly-inventory.json", Buffer.from("{"));
    expect(() => new HostedReadonlyHostKernel().session()).toThrow();
  });
  it("requires exact completion receipt; queued start and populated descendants independently reject", () => {
    const kernel = new HostedReadonlyHostKernel();
    expect(() => kernel.fenceCreator(reservation, bootId)).toThrow("creator_not_fenced");
    os.records.set(completionPath(reservation), completionBytes(reservation));
    expect(() => kernel.fenceCreator(reservation, bootId)).not.toThrow();
    os.jobs = `7 ${reservation.unit} start waiting\n`;
    expect(() => kernel.drainQueuedStart(reservation)).toThrow("still_queued");
    os.jobs = "";
    expect(() => kernel.drainQueuedStart(reservation)).not.toThrow();
    const events = `/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${reservation.unit}/cgroup.events`;
    os.files.set(events, "populated 1\nfrozen 0\n");
    expect(() => kernel.confirmTerminalDescendants(reservation)).toThrow("not_terminal");
    os.files.set(events, "populated 0\nfrozen 0\n");
    expect(() => kernel.confirmTerminalDescendants(reservation)).not.toThrow();
  });
  it("rejects foreign completion identity and retained main PID", () => {
    os.records.set(completionPath(reservation), Buffer.from("{}"));
    expect(() => new HostedReadonlyHostKernel().fenceCreator(reservation, bootId)).toThrow();
    os.show.set(reservation.unit, show(reservation.unit, "", "888"));
    expect(() => new HostedReadonlyHostKernel().confirmTerminalDescendants(reservation)).toThrow();
  });
  it("real host reboot only discharges creator fencing, never queue or descendant checks", () => {
    const kernel = new HostedReadonlyHostKernel();
    expect(() => kernel.fenceCreator(reservation, "old-boot")).not.toThrow();
    os.jobs = `8 ${reservation.unit} start waiting\n`;
    expect(() => kernel.drainQueuedStart(reservation)).toThrow();
  });
});

it("outer service invocation uses a fixed bootstrap and no environment/credential properties", () => {
  const record = { startId, creatorId: startId, unit: `subscription-runtime-outer-${startId}.service` };
  const invocation = new HostedReadonlyHostKernel().runtimeInvocation(record, "/runtime/node", ["/runtime/cli.js"], "/synthetic/W");
  expect(invocation.command).toBe("/usr/bin/systemd-run");
  expect(invocation.args).toContain(`--unit=${record.unit}`);
  expect(invocation.args).toContain("--working-directory=/synthetic/W");
  expect(invocation.args.at(-2)).toBe(process.execPath);
  expect(invocation.args.at(-1)).toMatch(/hosted-readonly-runtime-bootstrap\.js$/);
  expect(invocation.args.some(value => /Environment|setenv|BindPaths/.test(value))).toBe(false);
});
it("ordinary service invocation preserves the independent custody cgroup and fixed bootstrap", () => {
  const record = { ...reservation, unit: `subscription-runtime-ordinary-${startId}.service`,
    originSha256: "a".repeat(64), generation: 1 };
  const invocation = new HostedReadonlyHostKernel().ordinaryRuntimeInvocation(record, "/synthetic/W");
  expect(invocation.command).toBe("/usr/bin/systemd-run");
  expect(invocation.args).toContain(`--unit=${record.unit}`);
  expect(invocation.args).toContain("--working-directory=/synthetic/W");
  expect(invocation.args.at(-3)).toBe(process.execPath);
  expect(invocation.args.at(-2)).toMatch(/hosted-readonly-host-launch-cli\.js$/);
  expect(invocation.args.at(-1)).toBe("ordinary-bootstrap");
  expect(invocation.args.some(value => /Environment|setenv|BindPaths/.test(value))).toBe(false);
});
it.each(["valid", "wrong-group", "closed", "terminal", "old-generation", "wrong-supervisor"])("outer owner requires actual reserved service membership: %s", scenario => {
  const outer = { startId, creatorId: startId, unit: `subscription-runtime-outer-${startId}.service`, state: "reserved", generation: 2 };
  const epoch = { schemaVersion: 1, hostId, bootId, supervisorId: "123:456", generation: 2,
    requirement: "test_managed_qualification", phase: "ready", revoked: false, reservations: [], outerRuntime: outer,
    identity: { jobId: "TEST", jobRootDir: "/synthetic/job", workspacePath: "/synthetic/W", runtimeSha: "a".repeat(40),
      runtimeManifestSha256: "b".repeat(64), issuerDeploymentDigest: "c".repeat(64), policySha256: "d".repeat(64),
      reviewSha256: "e".repeat(64), stageSha256: "f".repeat(64), grantSha256: "0".repeat(64) } };
  os.records.set(root + "/readonly-enrollment.json", Buffer.from(JSON.stringify({ ...epoch, generation: 1, phase: "closed", outerRuntime: null })));
  const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${outer.unit}`;
  os.files.set("/proc/self/cgroup", `0::${group}\n`);
  os.show.set(outer.unit, show(outer.unit, group, "456"));
  if (scenario === "wrong-group") os.files.set("/proc/self/cgroup", "0::/system.slice/trusted.service\n");
  if (scenario === "closed") epoch.phase = "closed";
  if (scenario === "terminal") outer.state = "terminal";
  if (scenario === "old-generation") outer.generation = 1;
  if (scenario === "wrong-supervisor") epoch.supervisorId = "123:999";
  os.records.set(root + "/readonly-epoch.json", Buffer.from(JSON.stringify(epoch)));
  const action = () => new HostedReadonlyHostKernel().verifyRuntimeOwner();
  if (scenario === "valid") {
    expect(action).not.toThrow();
    os.units += `${outer.unit} loaded active running outer\n`;
    os.groups.get("/sys/fs/cgroup")!.push("subscription.slice");
    os.groups.set("/sys/fs/cgroup/subscription.slice", ["subscription-runtime.slice"]);
    os.groups.set("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice", ["subscription-runtime-hosted.slice"]);
    os.groups.set("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice", [outer.unit]);
    os.files.set("/sys/fs/cgroup/subscription.slice/cgroup.procs", "");
    os.files.set("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/cgroup.procs", "");
    os.groups.set("/sys/fs/cgroup" + group, []);
    os.files.set("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/cgroup.procs", "");
    os.files.set("/sys/fs/cgroup" + group + "/cgroup.procs", "456\n");
    expect(() => new HostedReadonlyHostKernel().verifyExclusiveInventory()).not.toThrow();
    os.units += "subscription-runtime-outer-ffffffff-ffff-ffff-ffff-ffffffffffff.service loaded active running sibling\n";
    expect(() => new HostedReadonlyHostKernel().verifyExclusiveInventory()).toThrow();
  } else expect(action).toThrow();
});
it("unloaded unit proof distinguishes explicit not-found from manager failure", () => {
  os.show.delete(reservation.unit);
  os.systemctl.mockImplementation((_command: string, args: string[]) => ({
    status: 4, stdout: args.includes("--property=LoadState") ? "LoadState=not-found\n" : "",
  }));
  expect(() => new HostedReadonlyHostKernel().confirmTerminalDescendants(reservation)).not.toThrow();
  os.systemctl.mockReturnValue({ status: 1, stdout: "LoadState=not-found\n" });
  expect(() => new HostedReadonlyHostKernel().confirmTerminalDescendants(reservation)).toThrow();
});

describe("creator role uses real kernel/store parsers with synthetic OS observations", () => {
  function enrolledOuter() {
    const birth = { schemaVersion: 1, hostId, bootId, supervisorId: "123:456", generation: 1,
      requirement: "test_managed_qualification", phase: "closed", revoked: false, reservations: [], outerRuntime: null,
      identity: { jobId: "TEST", jobRootDir: "/job", workspacePath: "/synthetic/W", runtimeSha: "a".repeat(40),
        runtimeManifestSha256: "b".repeat(64), issuerDeploymentDigest: "c".repeat(64), policySha256: "d".repeat(64),
        reviewSha256: "e".repeat(64), stageSha256: "f".repeat(64), grantSha256: "1".repeat(64) } };
    const unit = `subscription-runtime-outer-${startId}.service`;
    const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
    const epoch = { ...birth, phase: "ready", generation: 2,
      outerRuntime: { ...reservation, unit, generation: 2 } };
    os.records.set(root + "/readonly-enrollment.json", Buffer.from(JSON.stringify(birth)));
    os.records.set(root + "/readonly-epoch.json", Buffer.from(JSON.stringify(epoch)));
    os.show.set(unit, show(unit, group, "456"));
    return { epoch, unit, group };
  }
  it("distinguishes the authenticated supervisor from the exact reserved runtime", () => {
    const { group } = enrolledOuter();
    const kernel = new HostedReadonlyHostKernel();
    expect(kernel.runtimeRole()).toBe("supervisor");
    os.files.set("/proc/self/cgroup", `0::${group}\n`);
    expect(kernel.runtimeRole()).toBe("runtime");
  });
  it.each(["foreign", "descendant", "closed", "revoked", "generation", "boot", "missing-pid"])("rejects %s without treating it as a supervisor", fault => {
    const { epoch, unit, group } = enrolledOuter();
    os.files.set("/proc/self/cgroup", `0::${group}\n`);
    if (fault === "foreign") os.files.set("/proc/self/cgroup", "0::/system.slice/other.service\n");
    if (fault === "descendant") os.files.set("/proc/self/cgroup", `0::${group}/foreign\n`);
    if (fault === "closed") epoch.phase = "closed";
    if (fault === "revoked") epoch.revoked = true;
    if (fault === "generation") epoch.generation++;
    if (fault === "boot") epoch.bootId = "22222222-2222-4222-8222-222222222222";
    if (fault === "missing-pid") os.show.set(unit, show(unit, group, "0"));
    os.records.set(root + "/readonly-epoch.json", Buffer.from(JSON.stringify(epoch)));
    expect(() => new HostedReadonlyHostKernel().runtimeRole()).toThrow();
  });
});

describe("version 2 finite ordinary creator inventory", () => {
  function v2() {
    return { ...inventory(), schemaVersion: 2, disabledCreators: ["old-runtime.service", "old-runtime.timer", "old-runtime.socket"],
      ordinaryCreators: [{ creatorId: "ordinary-start", jobId: "ordinary-job", jobRootDir: "/jobs/ordinary",
        workspacePath: "/work/ordinary", launch: { command: "/runtime/node", args: ["/runtime/cli.js", "start", "ordinary-job"], cwd: "/work/ordinary" } }] };
  }
  function observations() {
    const original = os.systemctl.getMockImplementation()!;
    os.systemctl.mockImplementation((command: string, args: string[]) => {
      if (args[0] === "list-unit-files") return { status: 0, stdout: "trusted.service enabled enabled\n" };
      if (args.includes("--type=socket,timer")) return { status: 0, stdout: "" };
      if (args.includes("--property=Id,LoadState,ActiveState,UnitFileState,Job")) return { status: 0,
        stdout: `Id=${args.at(-1)}\nLoadState=masked\nActiveState=inactive\nUnitFileState=masked\nJob=\n` };
      return original(command, args);
    });
  }
  it("uses the original managed tuple and separately verifies ordinary and disabled creator rows", () => {
    publish(v2()); observations();
    expect(() => new HostedReadonlyHostKernel().verifyExclusiveInventory()).not.toThrow();
    expect(new HostedReadonlyHostKernel().operatorSession()).toEqual({ hostId, bootId, supervisorId: "123:456" });
    expect(os.systemctl.mock.calls.some(([, args]) => args.includes("--type=socket,timer"))).toBe(true);
  });
  it.each(["duplicate-creator", "foreign-scope", "unknown-creator-key", "bad-launch", "conflicting-job", "duplicate-disabled", "trusted-disabled"])(
    "rejects %s closed inventory", fault => {
      const value = v2(), creator = value.ordinaryCreators[0]!;
      if (fault === "duplicate-creator") value.ordinaryCreators.push(creator);
      if (fault === "foreign-scope") creator.workspacePath = "/work/../foreign";
      if (fault === "unknown-creator-key") Object.assign(creator, { approved: true });
      if (fault === "bad-launch") creator.launch.command = "node";
      if (fault === "conflicting-job") value.ordinaryCreators.push({ ...creator, creatorId: "other-creator", workspacePath: "/foreign" });
      if (fault === "duplicate-disabled") value.disabledCreators.push(value.disabledCreators[0]!);
      if (fault === "trusted-disabled") value.disabledCreators.push("trusted.service");
      publish(value); observations();
      expect(() => new HostedReadonlyHostKernel().verifyExclusiveInventory()).toThrow();
    });
  it.each(["enabled-old-service", "enabled-timer", "active-socket", "unmasked-old", "active-old", "queued-old", "foreign-supervisor"])(
    "rejects %s as future competing creator evidence", fault => {
      publish(v2()); observations();
      const original = os.systemctl.getMockImplementation()!;
      os.systemctl.mockImplementation((command: string, args: string[]) => {
        if (fault === "enabled-old-service" && args[0] === "list-unit-files") return { status: 0, stdout: "old-runtime.service enabled enabled\n" };
        if (fault === "enabled-timer" && args[0] === "list-unit-files") return { status: 0, stdout: "old-runtime.timer enabled enabled\n" };
        if (fault === "active-socket" && args.includes("--type=socket,timer")) return { status: 0, stdout: "old-runtime.socket loaded active listening\n" };
        const result = original(command, args);
        if (args.includes("--property=Id,LoadState,ActiveState,UnitFileState,Job")) {
          if (fault === "unmasked-old") return { ...result, stdout: result.stdout.replace("LoadState=masked", "LoadState=loaded") };
          if (fault === "active-old") return { ...result, stdout: result.stdout.replace("ActiveState=inactive", "ActiveState=active") };
          if (fault === "queued-old") return { ...result, stdout: result.stdout.replace("Job=", "Job=17") };
        }
        return result;
      });
      if (fault === "foreign-supervisor") os.files.set("/proc/self/cgroup", "0::/system.slice/foreign.service\n");
      expect(() => new HostedReadonlyHostKernel().verifyExclusiveInventory()).toThrow();
    });
});
