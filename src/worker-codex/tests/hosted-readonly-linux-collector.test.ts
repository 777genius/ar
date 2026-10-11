import { beforeEach, describe, expect, it, vi } from "vitest";
import { fenceScopedSubmitter, collectFutureCreatorShow, collectBootId, collectCgroupProcesses, collectCustodyEvents, collectJobs, collectProcessBirth,
  collectProcessCgroup, collectSelfCgroup, collectNonDelegatedUnitShow, collectUnitInvocation, collectUnitNotFound, collectUnitShow } from "../hosted-readonly-linux-collector";

const os = vi.hoisted(() => ({ files: new Map<string, string>(), errors: new Map<string, string>(),
  systemctl: vi.fn() }));
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  readFileSync: (path: string) => {
    if (os.errors.has(path)) throw Object.assign(new Error("synthetic OS failure"), { code: os.errors.get(path) });
    if (!os.files.has(path)) throw Object.assign(new Error("synthetic absent"), { code: "ENOENT" });
    return os.files.get(path)!;
  },
}));
vi.mock("node:child_process", () => ({ spawnSync: (...args: unknown[]) => os.systemctl(...args) }));
const id = "22222222-2222-4222-8222-222222222222";
const unit = `subscription-runtime-hosted-${id}.service`;
const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
const events = `/sys/fs/cgroup${group}/cgroup.events`;
const show = `Id=${unit}\nFragmentPath=/synthetic/unit\nDropInPaths=\nControlGroup=${group}\nMainPID=123\n`;
beforeEach(() => {
  vi.resetAllMocks(); os.files.clear(); os.errors.clear();
  os.files.set("/proc/sys/kernel/random/boot_id", "11111111-1111-4111-8111-111111111111\n");
  os.files.set("/proc/123/stat", "123 (synthetic creator) " + [...Array(19).fill("0"), "456"].join(" "));
  os.files.set("/proc/123/cgroup", "0::/system.slice/trusted.service\n");
  os.files.set("/proc/self/cgroup", "0::/system.slice/trusted.service\n");
  os.files.set("/sys/fs/cgroup/cgroup.procs", "1\n");
  os.files.set(events, "populated 0\nfrozen 0\n");
  os.systemctl.mockImplementation((_command: string, args: string[]) => ({ status: 0,
    stdout: args.includes("--property=Id,InvocationID") ? `Id=${unit}\nInvocationID=${"a".repeat(32)}\n` :
      args.includes("--property=LoadState") ? "LoadState=not-found\n" :
      args[0] === "list-jobs" ? "" : show }));
});
describe("fixed Linux collector with synthetic syscalls", () => {
  it("uses fixed host paths, bounded manager calls and exact unit selection", () => {
    expect(collectBootId()).toBe("11111111-1111-4111-8111-111111111111");
    expect(collectProcessBirth("123")).toBe("123:456");
    expect(collectProcessCgroup("123")).toBe("0::/system.slice/trusted.service");
    expect(collectSelfCgroup()).toBe("0::/system.slice/trusted.service");
    expect(collectCgroupProcesses("")).toBe("1\n");
    expect(collectUnitShow(unit).Id).toBe(unit);
    expect(collectUnitInvocation(unit)).toBe("a".repeat(32));
    expect(collectJobs()).toBe("");
    expect(collectCustodyEvents(unit)).toEqual({ kind: "present", text: "populated 0\nfrozen 0\n" });
    expect(collectUnitNotFound(unit)).toBe(true);
    for (const [command, args, options] of os.systemctl.mock.calls) {
      expect(command).toBe("/usr/bin/systemctl");
      expect(["show", "list-jobs"]).toContain(args[0]);
      expect(options).toMatchObject({ timeout: 5000, maxBuffer: 256 * 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
    }
  });
  it("reports missing events without promoting absence to terminal, and propagates permission failures", () => {
    os.files.delete(events);
    expect(collectCustodyEvents(unit)).toEqual({ kind: "absent" });
    os.errors.set(events, "EACCES");
    expect(() => collectCustodyEvents(unit)).toThrow("synthetic OS failure");
    os.systemctl.mockReturnValue({ status: 1, stdout: "" });
    expect(() => collectJobs()).toThrow("evidence_invalid");
  });
  it("rejects foreign unit identity, invalid invocation and arbitrary process paths", () => {
    os.systemctl.mockReturnValue({ status: 0, stdout: show.replace(`Id=${unit}`, "Id=foreign.service") });
    expect(() => collectUnitShow(unit)).toThrow("evidence_invalid");
    expect(() => collectUnitInvocation(unit)).toThrow("evidence_invalid");
    expect(() => collectProcessBirth("../self")).toThrow("evidence_invalid");
    expect(() => collectProcessCgroup("../self")).toThrow("evidence_invalid");
    expect(() => collectCgroupProcesses("/../foreign")).toThrow("evidence_invalid");
  });
  it("accepts either manager property order while rejecting duplicate generation fields", () => {
    os.systemctl.mockReturnValue({ status: 0, stdout: `InvocationID=${"a".repeat(32)}\nId=${unit}\n` });
    expect(collectUnitInvocation(unit)).toBe("a".repeat(32));
    os.systemctl.mockReturnValue({ status: 0, stdout: `Id=${unit}\nInvocationID=${"a".repeat(32)}\nInvocationID=${"a".repeat(32)}\n` });
    expect(() => collectUnitInvocation(unit)).toThrow("evidence_invalid");
  });
});

import { parseScopedManagerJobs } from "../hosted-readonly-observations";
it("R7 accepts legal unrelated manager units and jobs before exact selection", () => {
  const jobs = parseScopedManagerJobs("1 dev-loop0.device start running\n2 dev-disk-by\\x2duuid.swap stop waiting\n3 a.automount nop waiting\n");
  expect(jobs.map(j => j.unit)).toEqual(["dev-loop0.device", "dev-disk-by\\x2duuid.swap", "a.automount"]);
});


describe("complete systemd and canonical hybrid cgroup evidence", () => {
  it.each(["0::/system.slice/trusted.service\n1:name=systemd:/\n", "1:name=systemd:/\n0::/system.slice/trusted.service\n"])("selects only the unified row with the exact legacy root", raw => {
    os.files.set("/proc/123/cgroup", raw); os.files.set("/proc/self/cgroup", raw);
    expect(collectProcessCgroup("123")).toBe("0::/system.slice/trusted.service");
    expect(collectSelfCgroup()).toBe("0::/system.slice/trusted.service");
  });
  it.each([
    "0::/owned\n0::/foreign\n", "0::/owned\n1:name=systemd:/foreign\n",
    "0::/owned\n1:name=systemd:/\n1:name=systemd:/\n", "1:name=systemd:/\n",
    "0::/owned\n2:cpu:/\n", "0::/owned\n\n", " 0::/owned\n", "0::/owned/../foreign\n",
    "0::/owned\r\n", "0::/owned\nforeign\n",
  ])("rejects malformed, duplicate and foreign cgroup evidence %j", raw => {
    os.files.set("/proc/123/cgroup", raw); os.files.set("/proc/self/cgroup", raw);
    expect(() => collectProcessCgroup("123")).toThrow("evidence_invalid");
    expect(() => collectSelfCgroup()).toThrow("evidence_invalid");
  });
  it("requests all properties so an empty DropInPaths remains observed evidence", () => {
    os.systemctl.mockImplementation((_command: string, args: string[]) => ({ status: 0,
      stdout: (args.includes("--all") ? show : show.replace("DropInPaths=\n", "")) +
        (args.includes("--property=Id,FragmentPath,DropInPaths,ControlGroup,MainPID,Delegate") ? "Delegate=no\n" : "") }));
    expect(collectUnitShow(unit).DropInPaths).toBe("");
    expect(collectNonDelegatedUnitShow(unit)).toMatchObject({ DropInPaths: "", Delegate: "no" });
    expect(os.systemctl.mock.calls.every(([, args]) => args.includes("--all"))).toBe(true);
  });
});


it("pidfd fence uses the same complete hybrid membership rule before owned birth checks", async () => {
  os.systemctl.mockReturnValue({ status: 0, stdout: JSON.stringify({ pidBirth: "123:456", controlGroup: group, exitObserved: true }) });
  fenceScopedSubmitter("123:456", group, 1000);
  const [command, args] = os.systemctl.mock.calls[0]!;
  expect(command).toBe("/usr/bin/python3");
  const source: string = args[2];
  expect(source).toContain("fd=os.pidfd_open(pid,0)");
  expect(source).toContain("signal.pidfd_send_signal(fd,signal.SIGTERM)");
  expect(source).toContain("actual!=birth or membership(open('/proc/'+str(pid)+'/cgroup').read())!='0::'+group");
  const pure = source.slice(0, source.indexOf("fd=os.pidfd_open(pid,0)")) + "print(membership(sys.argv[5]))\n";
  const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  for (const raw of [`0::${group}\n`, `0::${group}\n1:name=systemd:/\n`, `1:name=systemd:/\n0::${group}\n`]) {
    const result = spawnSync("/usr/bin/python3", ["-I", "-c", pure, "123", "123:456", group, "1000", raw], { encoding: "utf8", timeout: 1000 });
    expect(result.status).toBe(0); expect(result.stdout.trimEnd()).toBe(`0::${group}`);
  }
  for (const raw of [`0::${group}\n0::/foreign\n`, `0::${group}\n1:name=systemd:/foreign\n`, `0::${group}\n1:name=systemd:/\n1:name=systemd:/\n`, "1:name=systemd:/\n", "0::/owned/../foreign\n", "0::/owned\n\n"]) {
    const result = spawnSync("/usr/bin/python3", ["-I", "-c", pure, "123", "123:456", group, "1000", raw], { encoding: "utf8", timeout: 1000 });
    expect(result.status).not.toBe(0);
  }
});


it("preserves the empty queued-job field when observing a future creator", () => {
  os.systemctl.mockImplementation((_command: string,args:string[]) => ({status:0,stdout:`Id=${unit}\nLoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n`+(args.includes("--all")?"Job=\n":"")}));
  expect(collectFutureCreatorShow(unit)).toContain("Job=\n");
});
