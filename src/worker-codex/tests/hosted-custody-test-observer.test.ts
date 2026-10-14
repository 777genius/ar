import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeTestCustody } from "./fixtures/hosted-custody-test-observer";

// All OS calls are mocked. The TEST harness itself is never run against systemd.
const os = vi.hoisted(() => ({ boot: "", birth: "", group: "", invocation: "", show: {} as Record<string, string>,
  jobs: "", events: { kind: "present", text: "populated 0\nfrozen 0\n" } as { kind: "present" | "absent"; text?: string },
  changed: false, birthChanged: false, groupChanged: false, births: 0, groups: 0, onJobs: null as null | (() => void) }));
vi.mock("../hosted-readonly-linux-collector", () => ({
  collectBootId: () => os.boot,
  collectProcessBirth: () => { os.births++; return os.birthChanged && os.births > 1 ? "123:999" : os.birth; },
  collectProcessCgroup: () => { os.groups++; return os.groupChanged && os.groups > 1 ? "0::/changed" : os.group; },
  collectUnitInvocation: () => { if (!os.invocation) throw new Error("synthetic bus failure"); return os.invocation; },
  collectExactUnit: () => {
    if (os.show.Id !== unit || os.show.ControlGroup !== group) throw new Error("synthetic identity failure");
    if (os.changed) os.invocation = "f".repeat(32);
    return { ...os.show };
  },
  collectJobs: () => { os.onJobs?.(); return os.jobs; },
  collectCustodyEvents: () => os.events,
}));
const startId = "22222222-2222-4222-8222-222222222222";
const bootId = "11111111-1111-4111-8111-111111111111";
const unit = `subscription-runtime-hosted-${startId}.service`;
const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
let root: string;
function saveIdentity(value: unknown = { startId, bootId, creatorPid: "123" }) {
  writeFileSync(join(root, "identity.json"), JSON.stringify(value));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "test-custody-observer-"));
  saveIdentity();
  os.boot = bootId; os.birth = "123:456"; os.group = "0::/system.slice/trusted.service"; os.invocation = "a".repeat(32);
  os.changed = false; os.birthChanged = false; os.groupChanged = false; os.births = 0; os.groups = 0; os.onJobs = null;
  os.show = { Id: unit, FragmentPath: "/synthetic/unit", DropInPaths: "", ControlGroup: group, MainPID: "456" };
  os.jobs = ""; os.events = { kind: "present", text: "populated 0\nfrozen 0\n" };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("finite TEST custody OS observer with synthetic syscalls", () => {
  function birth() { return observeTestCustody(root, "initial"); }
  it("records separate birth and terminal observations without rechecking a departed PID", () => {
    expect(birth()).toMatchObject({ kind: "live_observation_only", phase: "initial", processBirth: "123:456" });
    os.birth = "departed";
    os.show.MainPID = "0";
    expect(observeTestCustody(root, "terminal")).toMatchObject({ phase: "terminal", populated: 0 });
    expect(JSON.parse(readFileSync(join(root, "terminal-evidence.json"), "utf8"))).toMatchObject({ kind: "live_observation_only" });
    expect(() => observeTestCustody(root, "terminal")).toThrow();
  });
  it.each([
    ["boot", () => { os.boot = "33333333-3333-4333-8333-333333333333"; }],
    ["creator birth", () => { os.birthChanged = true; }],
    ["creator group", () => { os.groupChanged = true; }],
    ["unit", () => { os.show.Id = "foreign.service"; }],
    ["group", () => { os.show.ControlGroup = "/system.slice/foreign.service"; }],
    ["PID", () => { os.show.MainPID = "0"; }],
    ["queue", () => { os.jobs = `7 ${unit} start waiting\n`; }],
    ["reused unit", () => { os.changed = true; }],
  ])("rejects wrong initial %s", (_name, mutate) => {
    mutate(); expect(birth).toThrow(); expect(existsSync(join(root, "initial-evidence.json"))).toBe(false);
  });
  it.each([
    ["queued start", () => { os.jobs = `7 ${unit} start waiting\n`; }],
    ["populated descendants", () => { os.events = { kind: "present", text: "populated 1\n" }; }],
    ["duplicate events", () => { os.events = { kind: "present", text: "populated 0\n populated 1\n" }; }],
    ["missing cgroup", () => { os.events = { kind: "absent" }; }],
    ["reused unit", () => { os.invocation = "b".repeat(32); }],
    ["wrong terminal group", () => { os.show.ControlGroup = "/system.slice/other.service"; }],
  ])("rejects terminal %s", (_name, mutate) => {
    birth(); os.show.MainPID = "0"; mutate();
    expect(() => observeTestCustody(root, "terminal")).toThrow();
    expect(existsSync(join(root, "terminal-evidence.json"))).toBe(false);
  });
  it("rejects changed identity, foreign paths, symlinks and accessible roots", () => {
    birth(); os.show.MainPID = "0";
    saveIdentity({ startId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bootId, creatorPid: "123" });
    expect(() => observeTestCustody(root, "terminal")).toThrow();
    expect(() => observeTestCustody("/sys/fs/cgroup", "initial")).toThrow();
    rmSync(join(root, "identity.json")); symlinkSync("/etc/machine-id", join(root, "identity.json"));
    expect(birth).toThrow();
    rmSync(join(root, "identity.json")); saveIdentity(); chmodSync(root, 0o755);
    expect(birth).toThrow();
  });
  it("fails closed on manager error and refuses a second writer lock", () => {
    os.invocation = ""; expect(birth).toThrow();
    os.invocation = "a".repeat(32);
    writeFileSync(join(root, ".observer-lock"), "busy");
    expect(birth).toThrow();
  });
  it("rejects identity replacement during collection and a file beyond its bound", () => {
    os.onJobs = () => saveIdentity({ startId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bootId, creatorPid: "123" });
    expect(birth).toThrow();
    expect(existsSync(join(root, "initial-evidence.json"))).toBe(false);
    os.onJobs = null;
    writeFileSync(join(root, "identity.json"), "x".repeat(4097));
    expect(birth).toThrow();
  });
  it("rejects linked identity files and never overwrites existing evidence", () => {
    linkSync(join(root, "identity.json"), join(root, "linked-identity.json"));
    expect(birth).toThrow();
    rmSync(join(root, "linked-identity.json"));
    writeFileSync(join(root, "initial-evidence.json"), "operator supplied\n");
    expect(birth).toThrow();
    expect(readFileSync(join(root, "initial-evidence.json"), "utf8")).toBe("operator supplied\n");
  });
  it("fails closed if the TEST root loses its exclusive mode during collection", () => {
    os.onJobs = () => chmodSync(root, 0o755);
    expect(birth).toThrow();
    expect(existsSync(join(root, "initial-evidence.json"))).toBe(false);
  });
});
