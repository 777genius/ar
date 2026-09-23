import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeTestCustody } from "./fixtures/hosted-custody-test-observer";

const startId = "22222222-2222-4222-8222-222222222222";
const bootId = "11111111-1111-4111-8111-111111111111";
const unit = `subscription-runtime-hosted-${startId}.service`;
const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
const stat = "123 (synthetic process) " + [...Array(19).fill("0"), "456"].join(" ");
const show = `Id=${unit}\nFragmentPath=/synthetic/unit\nDropInPaths=\nControlGroup=${group}\nMainPID=0\n`;
let root: string;
let identity: Record<string, string>, observations: Record<string, string>;
function save() {
  writeFileSync(join(root, "identity.json"), JSON.stringify(identity));
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations));
}
beforeEach(() => {
  root = mkdtempSync("/tmp/test-custody-observer-");
  identity = { startId, bootId, pid: "123", processBirth: "123:456" };
  observations = { bootId, processStat: stat, unitShow: show, jobs: "", cgroupEvents: "populated 0\nfrozen 0\n" };
  save();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("TEST-only custody snapshot observer", () => {
  it("records bounded synthetic evidence under its disposable root", () => {
    const result = observeTestCustody(root);
    expect(result).toMatchObject({ kind: "synthetic_observation_only", startId, processBirth: "123:456", populated: 0 });
    expect(JSON.parse(readFileSync(join(root, "observation-evidence.json"), "utf8"))).toEqual(result);
    expect(() => observeTestCustody(root)).toThrow(); // evidence cannot be silently overwritten
  });
  it.each([
    ["wrong boot", () => { observations.bootId = "33333333-3333-4333-8333-333333333333"; }],
    ["reused birth", () => { identity.processBirth = "123:999"; }],
    ["foreign unit", () => { observations.unitShow = show.replace(`Id=${unit}`, "Id=foreign.service"); }],
    ["reused unit identity", () => { identity.startId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; }],
    ["wrong derived group", () => { observations.unitShow = show.replace(group, "/system.slice/foreign.service"); }],
    ["retained main PID", () => { observations.unitShow = show.replace("MainPID=0", "MainPID=123"); }],
    ["queued start", () => { observations.jobs = `7 ${unit} start waiting\n`; }],
    ["foreign queued unit", () => { observations.jobs = "7 foreign.service start waiting\n"; }],
    ["malformed queued job", () => { observations.jobs = "no-id foreign.service start waiting\n"; }],
    ["duplicate unit observation", () => { observations.unitShow += `Id=${unit}\n`; }],
    ["duplicate populated", () => { observations.cgroupEvents += "populated 0\n"; }],
    ["malformed populated", () => { observations.cgroupEvents = "populated 00\n"; }],
    ["populated descendant", () => { observations.cgroupEvents = "populated 1\n"; }],
    ["missing cgroup observation", () => { delete observations.cgroupEvents; }],
    ["injected OS path", () => { Object.assign(observations, { cgroupPath: "/sys/fs/cgroup" }); }],
  ])("refuses %s", (_fault, mutate) => {
    mutate(); save();
    expect(() => observeTestCustody(root)).toThrow();
    expect(existsSync(join(root, "observation-evidence.json"))).toBe(false);
  });
  it("rejects malformed snapshots and refuses to overwrite an existing evidence name", () => {
    writeFileSync(join(root, "observations.json"), "{");
    expect(() => observeTestCustody(root)).toThrow();
    expect(existsSync(join(root, "observation-evidence.json"))).toBe(false);
    save();
    writeFileSync(join(root, "observation-evidence.json"), "operator-supplied\n");
    expect(() => observeTestCustody(root)).toThrow();
    expect(readFileSync(join(root, "observation-evidence.json"), "utf8")).toBe("operator-supplied\n");
  });
  it("rejects foreign paths and symlinked inputs", () => {
    expect(() => observeTestCustody("/sys/fs/cgroup")).toThrow();
    rmSync(join(root, "observations.json"));
    symlinkSync("/etc/machine-id", join(root, "observations.json"));
    expect(() => observeTestCustody(root)).toThrow();
  });
  it("rejects a TEST root accessible to another uid without depending on root privileges", () => {
    chmodSync(root, 0o755);
    expect(() => observeTestCustody(root)).toThrow();
  });
});
