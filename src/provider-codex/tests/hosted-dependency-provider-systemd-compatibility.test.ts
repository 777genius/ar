import { beforeEach, expect, it, vi } from "vitest";
import { hostedDependencyProviderInvocation } from "../app-server/adapters/hosted-dependency-provider-launch";
import type { HostedActivationFence } from "../app-server/adapters/hosted-process-activation";

// Adapter regression only: synthetic admission/filesystem ports never publish
// private authority or constitute a live qualification. The actual adapter
// constructs the complete invocation and performs its literal proof itself.
const fixture = vi.hoisted(() => ({ node: "/opt/TEST/bin/node", launcher: "/opt/TEST/hosted-app-server-launcher.js",
  mode: "modern", version: "systemd 252 (252.39-1~deb12u2)\n", directories: vi.fn(), inspect: vi.fn() }));
const id = "01234567-89ab-cdef-0123-456789abcdef", unit = `subscription-runtime-hosted-${id}.service`;
const job = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-provider", workspace = `${job}/workspace`;
vi.mock("node:child_process", () => ({ spawnSync: fixture.inspect }));
vi.mock("node:url", async original => ({ ...await original<typeof import("node:url")>(), fileURLToPath: () => fixture.launcher }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const directory = (path: string) => !(/\.(?:js|crt|conf)$/.test(path) || /\/(?:node|codex|hosts|services|nsswitch.conf)$/.test(path));
  return { ...actual, realpathSync: (path: string) => path === process.execPath ? fixture.node : path,
    lstatSync: (path: string) => ({ uid: 0, mode: 0o755, nlink: 1, size: 16,
      isSymbolicLink: () => false, isDirectory: () => directory(path), isFile: () => !directory(path) }),
    mkdirSync: fixture.directories, writeFileSync: vi.fn(), readFileSync: () => Buffer.from("TEST public snapshot"),
    openSync: () => 77, fsyncSync: vi.fn(), closeSync: vi.fn() };
});
vi.mock("../hosted-codex-permissions", () => ({ hostedCodexExecutableReadClosure: () => ({ paths: ["/usr/bin/codex"] }) }));
vi.mock("../app-server/adapters/hosted-process-activation", () => ({ assertHostedActivationFence: vi.fn(),
  readHostedOrdinaryProcessOrigin: () => ({ start: { jobId: "TEST-provider", workspacePath: workspace, jobRootDir: job,
    creatorId: "TEST-creator", originSha256: "origin" }, reservation: { startId: id } }),
  readHostedActivationBytes: () => Buffer.from("TEST admission"), decodeHostedActivationBytes: () => ({ unit,
    creatorId: "TEST-creator", originSha256: "origin", grantSha256: "grant", workspacePath: workspace }) }));
vi.mock("../app-server/adapters/hosted-dependency-workspace", () => ({
  readHostedDependencyBinding: () => ({ version: 1, jobRootDir: job, workspace: { canonicalPath: workspace }, grantDigest: "grant" }),
  readHostedDependencyAttempt: vi.fn() }));
vi.mock("../app-server/adapters/hosted-fd-observation", () => ({ readHostedFdProfile: () => undefined }));
vi.mock("../app-server/adapters/hosted-dependency-tool-plan", () => ({ abandonHostedDependencyToolPlan: vi.fn(),
  prepareHostedDependencyToolPlan: vi.fn(), retainHostedDependencyToolInvocation: vi.fn() }));
const input = { command: "/usr/bin/codex", args: ["app-server"], cwd: workspace,
  env: { PATH: "/usr/bin:/bin", HOME: `${job}/home/account/home`, CODEX_HOME: `${job}/home/account/codex-home` } };
const call = () => hostedDependencyProviderInvocation({} as HostedActivationFence, unit, input)!;
const done = (stdout: string, status = 0, stderr = "") => ({ stdout, status, stderr, signal: null });
beforeEach(() => {
  fixture.node = "/opt/TEST/bin/node"; fixture.launcher = "/opt/TEST/hosted-app-server-launcher.js";
  fixture.mode = "modern"; fixture.version = "systemd 252 (252.39-1~deb12u2)\n";
  fixture.directories.mockClear(); fixture.inspect.mockReset().mockImplementation((_file: string, args: string[]) => {
    if (fixture.mode === "modern") return done("  --expand-environment=BOOL\n");
    if (args.includes("--help")) return done("", 1, "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n");
    return done(fixture.version);
  });
});
it("stock252 constructs the identical dependency provider invocation except unsupported veto", () => {
  const modern = call(); fixture.mode = "legacy"; const old = call();
  expect(old).toEqual({ ...modern, args: modern.args.filter(arg => arg !== "--expand-environment=no") });
  expect(old.args.slice(old.args.indexOf("--") + 1).every(arg => !arg.includes("$"))).toBe(true);
  expect(old.args).toContain("--property=KillMode=control-group");
  expect(old.args).toContain("--property=CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP");
  for (const [file, args, options] of fixture.inspect.mock.calls) {
    expect(file).toBe("/usr/bin/systemd-run"); expect(args.every((arg: string) => ["--expand-environment=no", "--help", "--version"].includes(arg))).toBe(true);
    expect(options).toMatchObject({ timeout: 2000, maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
  }
});
it("legacy refuses every dynamic dollar operand before creating any provider root", () => {
  fixture.mode = "legacy";
  for (const dollar of ["$USER", "${USER}", "$$", "literal$tail"]) {
    fixture.node = `/opt/TEST/${dollar}/node`; expect(call).toThrow();
    fixture.node = "/opt/TEST/bin/node"; fixture.launcher = `/opt/TEST/${dollar}/hosted-app-server-launcher.js`; expect(call).toThrow();
    fixture.launcher = "/opt/TEST/hosted-app-server-launcher.js";
  }
  expect(fixture.directories).not.toHaveBeenCalled();
});
it("modern retains explicit veto and literal dollar command arguments", () => {
  fixture.node = "/opt/TEST/$USER/node"; fixture.launcher = "/opt/TEST/${USER}/hosted-app-server-launcher.js";
  const invocation = call(); expect(invocation.args).toContain("--expand-environment=no");
  expect(invocation.args).toContain(fixture.node); expect(invocation.args).toContain(fixture.launcher);
  expect(fixture.inspect).toHaveBeenCalledTimes(1);
});
it("unknown capability, read failure and foreign version refuse before root effects", () => {
  for (const response of [done("ambiguous"), done("", 1, "foreign error"), { ...done(""), signal: "SIGTERM" },
    { ...done(""), error: Error("TEST read failure") }]) {
    fixture.inspect.mockReturnValue(response); expect(call).toThrow();
  }
  fixture.inspect.mockImplementation((_file: string, args: string[]) => args.includes("--help")
    ? done("", 1, "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n") : done("systemd 253\n"));
  expect(call).toThrow(); expect(fixture.directories).not.toHaveBeenCalled();
});
