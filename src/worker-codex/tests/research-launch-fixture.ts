import { vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const fixture = vi.hoisted(() => ({ root: "", group: "/user.slice/TEST-session.scope", birth: "12345", boot: "a".repeat(8) + "-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  uidMap: "0 0 4294967295", namespaceRoot: false, global: false, projectParent: false, physicalPaths: false, foreign: new Set<string>(),
  fdPaths: new Map<number, string>(), pins: new Map<string, string>(), calls: [] as { command: string; args: string[] }[],
  units: new Map<string, { description: string; pid: number; invocation: string; active: boolean; pending?: boolean }>(),
  processGroups: new Map<number, string>(), killFailures: new Set<string>(), stopFailures: new Set<string>(),
  jobs: new Set<string>(), spawn: vi.fn(), authReads: 0 }));
export const host = fixture;
export function local(path: string): string {
  const authority = "/run/user/subscription-runtime-research-v1", artifact = "/TEST-artifact", project = "/TEST-project";
  for (const [pin, target] of fixture.pins) if (path === pin || path.startsWith(pin + "/")) return local(target + path.slice(pin.length));
  for (const [prefix, name] of [[authority, "authority"], [artifact, "artifact"], [project, "project"], ["/TEST-auth", "auth"], ["/TEST-operator", "operator"], ["/run/systemd/transient", "units"]]) {
    if (path === prefix || path.startsWith(prefix + "/")) return join(fixture.root, name!, path.slice(prefix!.length));
  }
  if (path === "/var/lib/subscription-runtime-host-policy" || path === "/run/user/0/subscription-runtime-host-policy") return join(fixture.root, fixture.global ? "global" : "absent");
  if (path.startsWith("/var/lib/subscription-runtime-host-policy/") || path.startsWith("/run/user/0/subscription-runtime-host-policy/")) return join(fixture.root, "absent", path.split("/").at(-1)!);
  if (path === process.execPath || path.startsWith("/usr/bin/")) return join(fixture.root, "executable");
  if (["/", "/run", "/run/systemd", "/run/user", "/run/user/0", "/var", "/var/lib", "/usr", "/usr/bin", "/opt"].includes(path) || process.execPath.startsWith(path + "/")) return fixture.root;
  return path;
}
vi.mock("node:url", async original => {
  const real = await original<typeof import("node:url")>();
  return { ...real, fileURLToPath: (url: URL | string) => {
    const path = real.fileURLToPath(url);
    return path === process.cwd() + "/" ? "/TEST-artifact/" : path;
  } };
});
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: string) => Object.assign(real.lstatSync(local(path)), { uid: fixture.foreign.has(path) || (fixture.projectParent && path === "/TEST-project") ? 999 : 0 }),
    fstatSync: (fd: number) => Object.assign(real.fstatSync(fd), { uid: fixture.foreign.has(fixture.fdPaths.get(fd) ?? "") ? 999 : 0 }),
    openSync: (path: string, flags: number | string, mode: number) => { const fd = real.openSync(local(path), flags, mode); fixture.fdPaths.set(fd, path); return fd; },
    existsSync: (path: string) => real.existsSync(local(path)),
    readFileSync: (path: string | number, opts: Parameters<typeof real.readFileSync>[1]) => {
      if (typeof path === "string" && path.startsWith("/proc/")) {
        if (path.endsWith("/uid_map") || path.endsWith("/gid_map")) return fixture.uidMap;
        if (path === "/proc/sys/kernel/random/boot_id") return fixture.boot;
        if (path.endsWith("/cgroup")) return `0::${fixture.processGroups.get(Number(path.split("/")[2])) ?? fixture.group}\n`;
        if (path.endsWith("/stat")) return `1 (TEST process) ` + ["S", ...Array(18).fill("0"), fixture.birth].join(" ");
        throw new Error("unexpected TEST proc read");
      }
      if (path === "/etc/machine-id") return "b".repeat(32);
      return real.readFileSync(typeof path === "string" ? local(path) : path, opts);
    },
    readlinkSync: (path: string) => path.startsWith("/proc/") ? (fixture.namespaceRoot && path.startsWith("/proc/self") ? "TEST-namespace" : "TEST-host") : real.readlinkSync(local(path)),
    realpathSync: (path: string) => { const target = real.realpathSync(local(path)); return target.startsWith(join(fixture.root, "artifact")) ? "/TEST-artifact" + target.slice(join(fixture.root, "artifact").length) : target; },
    readdirSync: (path: string, opts: Parameters<typeof real.readdirSync>[1]) => real.readdirSync(local(path), opts),
    mkdirSync: (path: string, opts: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), opts),
    renameSync: (from: string, to: string) => real.renameSync(local(from), local(to)),
    unlinkSync: (path: string) => real.unlinkSync(local(path)),
  };
});
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, readFile: (path: string, opts: Parameters<typeof real.readFile>[1]) => {
    if (path.endsWith("auth.json")) fixture.authReads++;
    return real.readFile(local(path), opts);
  }, lstat: (path: string) => real.lstat(local(path)),
  readlink: async (path: string) => path.startsWith("/proc/") ? "TEST-host" : real.readlink(local(path)),
  open: (path: string, flags: string | number) => real.open(local(path), flags),
  };
});
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...real, spawn: (...args: unknown[]) => fixture.spawn(...args), spawnSync: (command: string, args: string[]) => {
    fixture.calls.push({ command, args });
    if (command === "/usr/bin/mount") { if (args[0] === "--bind") fixture.pins.set(args[2]!, args[1]!); return { status: 0, stdout: "" }; }
    if (command === "/usr/bin/systemd-run") {
      const unit = args.find(a => a.startsWith("--unit="))!.slice(7);
      fixture.units.set(unit, { pid: process.pid, description: args.find(a => a.startsWith("--description="))!.slice(14), invocation: "c".repeat(32), active: true });
      fs.writeFileSync(local(`/run/systemd/transient/${unit}`), "TEST service fragment", { mode: 0o644 });
      return { status: 0, stdout: "" };
    }
    if (command !== "/usr/bin/systemctl") throw new Error("unexpected TEST process effect");
    const unit = args[1]!, service = fixture.units.get(unit);
    if (args[0] === "show") return { status: 0, stdout: service?.active ? `Id=${unit}\nMainPID=${service.pending ? 0 : service.pid}\nControlGroup=${service.pending ? "" : "/system.slice/" + unit}\nInvocationID=${service.pending ? "" : service.invocation}\nDescription=${service.description}\nActiveState=${service.pending ? "activating" : "active"}\nSubState=${service.pending ? "start" : "running"}\nTransient=yes\nFragmentPath=/run/systemd/transient/${unit}\nDropInPaths=\nKillMode=control-group\n` : `Id=${unit}\nLoadState=not-found\nMainPID=0\nActiveState=inactive\n` };
    if (args[0] === "stop") {
      const selected = args.at(-1)!;
      if (fixture.stopFailures.has(selected)) return { status: 1, stdout: "" };
      const stopped = fixture.units.get(selected);
      if (stopped) stopped.active = false;
      fixture.jobs.delete(selected);
      return { status: 0, stdout: "" };
    }
    if (args[0] === "kill") return { status: fixture.killFailures.has(args.at(-1)!) ? 1 : 0, stdout: "" };
    if (args[0] === "list-jobs") return { status: 0, stdout: [...fixture.jobs].map((name, i) => `${i + 1} ${name} start waiting`).join("\n") };
    throw new Error("unexpected TEST systemctl effect");
  } };
});
export const request = () => ({ schemaVersion: 1, jobId: "TEST-research-r7", taskId: "TEST-research-r7",
  jobRootDir: fixture.physicalPaths ? join(fixture.root, "project/jobs/TEST-research-r7") : "/TEST-project/jobs/TEST-research-r7",
  workspacePath: fixture.physicalPaths ? join(fixture.root, "project/jobs/TEST-research-r7/workspace") : "/TEST-project/jobs/TEST-research-r7/workspace",
  promptPath: fixture.physicalPaths ? join(fixture.root, "project/jobs/TEST-research-r7/prompt.md") : "/TEST-project/jobs/TEST-research-r7/prompt.md",
  authRootDir: fixture.physicalPaths ? join(fixture.root, "auth") : "/TEST-auth", accounts: ["TEST-a", "TEST-b"],
  codexBinaryPath: "/usr/bin/TEST-codex", model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default", taskTimeoutMs: 3600000 });
export function setupResearchFixture(): void {
  fixture.root = mkdtempSync(join(tmpdir(), "TEST-research-launch-r7-"));
  fixture.group = "/user.slice/TEST-session.scope"; fixture.birth = "12345"; fixture.uidMap = "0 0 4294967295";
  fixture.boot = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  fixture.namespaceRoot = false; fixture.global = false; fixture.projectParent = false; fixture.physicalPaths = false; fixture.foreign.clear(); fixture.fdPaths.clear(); fixture.pins.clear(); fixture.calls = []; fixture.units.clear(); fixture.processGroups.clear(); fixture.killFailures.clear(); fixture.stopFailures.clear(); fixture.jobs.clear(); fixture.spawn.mockReset(); fixture.authReads = 0;
  vi.spyOn(process, "getuid").mockReturnValue(0); vi.spyOn(process, "geteuid").mockReturnValue(0);
  for (const dir of ["global", "artifact/dist", "artifact/host-integration", "artifact/node_modules", "artifact/packages/dependency", "project/jobs/TEST-research-r7/workspace", "auth/TEST-a", "auth/TEST-b", "operator", "units"]) mkdirSync(join(fixture.root, dir), { recursive: true, mode: 0o700 });
  writeFileSync(join(fixture.root, "executable"), "TEST executable bytes", { mode: 0o755 });
  writeFileSync(local("/TEST-artifact/package.json"), '{"type":"module"}', { mode: 0o644 });
  writeFileSync(local("/TEST-artifact/dist/main.js"), "TEST runtime bytes", { mode: 0o644 });
  writeFileSync(local("/TEST-artifact/packages/dependency/index.js"), "TEST dependency bytes", { mode: 0o644 });
  writeFileSync(local(request().promptPath), "TEST public research prompt", { mode: 0o600 });
  writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(request()) + "\n", { mode: 0o600 });
  fixture.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }));
}
export function cleanupResearchFixture(): void { fixture.pins.clear(); rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); }
