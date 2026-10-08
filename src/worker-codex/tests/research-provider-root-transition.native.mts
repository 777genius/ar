import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit hosted-only operator primitive. No grants, account reads, model,
// request/admission records or READY token; this is not full adapter proof.
type Prelude = Pick<typeof import("../research-provider-root-assembler"), "researchProviderRootTransition">;
type DescriptorGuard = Pick<typeof import("../../provider-codex/app-server/adapters/hosted-process-descriptors"), "assertHostedProcessDescriptors">;
type Mode = "clean" | "file" | "directory";
type Expected = Readonly<{ schemaVersion: 1; hostUser: string; hostPid: string; outside: string; sentinelSha256: string; inside: string }>;
const script = fileURLToPath(import.meta.url), env = { PATH: "/usr/bin:/usr/sbin", LANG: "C", LC_ALL: "C", NODE_DISABLE_COMPILE_CACHE: "1", NODE_NO_WARNINGS: "1" };
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const requireFact = (fact: unknown): void => { if (!fact) throw new Error("TEST_root_transition_denied"); };
const path = (value: string): string => {
  requireFact(/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) && realpathSync(value) === value); return value;
};
const info = (name: string): readonly number[] => { const stat = lstatSync(name); return [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size]; };
const tree = (root: string): string => JSON.stringify((function walk(name: string): unknown[] {
  const stat = lstatSync(name); return [name, info(name), stat.isSymbolicLink() ? readlinkSync(name) : stat.isDirectory() ? readdirSync(name).sort().map(child => walk(join(name, child))) : sha(readFileSync(name))];
})(root));
function trusted(name: string): void {
  path(name);
  for (let current = name;; current = dirname(current)) {
    const stat = lstatSync(current); requireFact(stat.uid === 0 && !(stat.mode & 0o022) && !stat.isSymbolicLink());
    if (current === "/") break;
  }
}
function call(command: string, args: readonly string[], deadline: number, fds: readonly number[] = []) {
  requireFact(Number.isSafeInteger(deadline) && deadline > Number(process.hrtime.bigint() / 1_000_000n));
  return spawnSync(command, args, { cwd: "/", env, stdio: ["pipe", "pipe", "pipe", ...fds], input: Buffer.alloc(0),
    timeout: deadline - Number(process.hrtime.bigint() / 1_000_000n), killSignal: "SIGKILL", maxBuffer: 16384 });
}
function mount(args: readonly string[], deadline: number, fds: readonly number[] = []): void {
  const result = call("/usr/bin/mount", ["--no-canonicalize", "--no-mtab", ...args], deadline, fds);
  requireFact(!result.error && !result.signal && result.status === 0);
}

async function oracle(mode: Mode): Promise<void> {
  const expected = JSON.parse(readFileSync("/expected.json", "utf8")) as Expected;
  requireFact(expected.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(expected.sentinelSha256));
  const status = readFileSync("/proc/self/status", "utf8");
  const capabilitiesZero = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(key => new RegExp(`^${key}:\\s+0+$`, "m").test(status));
  const insideReadable = readFileSync("/inside.txt", "utf8") === expected.inside;
  const mapsCorrect = ["uid", "gid"].every(kind => /^65532\s+0\s+1$/.test(readFileSync(`/proc/self/${kind}_map`, "utf8").trim()));
  const denied = (name: string): boolean => { try { readFileSync(name); return false; } catch (error) { return ["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); } };
  const rootClosed = readlinkSync("/proc/self/root") === "/" && readlinkSync("/proc/self/cwd") === "/" && process.cwd() === "/" &&
    denied(expected.outside) && denied("../../" + expected.outside.slice(1)) && denied("/proc/1/root" + expected.outside);
  const pidPrivate = readlinkSync("/proc/self/ns/pid") !== expected.hostPid && readFileSync("/proc/1/comm", "utf8").trim() === "tini";
  const userPrivate = readlinkSync("/proc/self/ns/user") !== expected.hostUser;
  requireFact(process.getuid?.() === 65532 && process.getgid?.() === 65532 && mapsCorrect && capabilitiesZero && /^NoNewPrivs:\s+1$/m.test(status) && insideReadable && rootClosed && pidPrivate && userPrivate);
  let leakAccessible = false;
  if (mode !== "clean") {
    // The negative is a real retained outside TEST object, not a mocked guard.
    const bytes = readFileSync(mode === "file" ? "/proc/self/fd/3" : "/proc/self/fd/3/sentinel.txt");
    leakAccessible = sha(bytes) === expected.sentinelSha256; requireFact(leakAccessible);
  }
  const guard = await import(pathToFileURL("/guard.mjs").href) as DescriptorGuard;
  let leakDenied = false;
  try { guard.assertHostedProcessDescriptors(); }
  catch (error) { if ((error as Error).message !== "hosted_custody_inherited_handle_denied") throw error; leakDenied = true; }
  requireFact(leakDenied === (mode !== "clean"));
  process.stdout.write(JSON.stringify({ schemaVersion: 1, mode, insideReadable, rootClosed, pidPrivate, userPrivate, mapsCorrect, capabilitiesZero, noNewPrivileges: true,
    descriptorsAccepted: !leakDenied, leakAccessible, leakDenied }) + "\n");
}

async function assemble(root: string, runtime: string, expectedPath: string, mode: Mode, deadline: number): Promise<void> {
  trusted(root); trusted(runtime); trusted(expectedPath);
  const ownStatus = readFileSync("/proc/self/status", "utf8");
  requireFact(/^CapBnd:\s+0000000080200100$/m.test(ownStatus) && /^NoNewPrivs:\s+1$/m.test(ownStatus) &&
    readlinkSync("/proc/self/ns/mnt") !== readlinkSync("/proc/1/ns/mnt") &&
    !readFileSync("/proc/self/mountinfo", "utf8").split("\n").some(row => /(?: shared:| master:| propagate_from:)/.test(row.split(" - ")[0]!)));
  const transitionModule = join(runtime, "dist/worker-codex/research-provider-root-assembler.js"), transitionSha256 = sha(readFileSync(transitionModule));
  const module = await import(pathToFileURL(transitionModule).href) as Prelude;
  const bind = (source: string, target: string, directory: boolean): void => {
    trusted(source); const destination = join(root, target.slice(1));
    const a = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const b = openSync(destination, 0x200000 | constants.O_NOFOLLOW);
    try { mount(["--bind", "/proc/self/fd/3", "/proc/self/fd/4"], deadline, [a, b]); } finally { closeSync(a); closeSync(b); }
    const fd = openSync(destination, 0x200000 | constants.O_NOFOLLOW);
    try {
      const bound = fstatSync(fd), original = lstatSync(source);
      requireFact(bound.dev === original.dev && bound.ino === original.ino && bound.isDirectory() === directory);
      mount(["-o", "remount,bind,ro,nosuid,nodev", "/proc/self/fd/3"], deadline, [fd]);
    } finally { closeSync(fd); }
  };
  // This primitive applies only a small public closure, not the production
  // provider's complete captured graph/API/device/protected policy.
  bind("/usr", "/usr", true);
  if (!process.execPath.startsWith("/usr/")) bind(process.execPath, process.execPath, false);
  bind(script, "/probe.mts", false); bind(expectedPath, "/expected.json", false);
  bind(join(runtime, "dist/provider-codex/app-server/adapters/hosted-process-descriptors.js"), "/guard.mjs", false);
  for (const alias of ["bin", "sbin", "lib", "lib64"]) {
    const source = "/" + alias;
    try { lstatSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!lstatSync(source).isSymbolicLink()) bind(source, source, true);
  }
  const transition = module.researchProviderRootTransition(root), expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expected;
  const held = mode === "clean" ? undefined : openSync(mode === "file" ? expected.outside : dirname(expected.outside), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const result = call(transition.command, [...transition.args, process.execPath, "/probe.mts", "oracle", mode], deadline, held === undefined ? [] : [held]);
    if (result.status !== 0 || result.error || result.signal) {
      const stderr = result.stderr?.toString("utf8") ?? "";
      const phase = /capset failed/.test(stderr) ? "userns-capset" : /cannot change root/.test(stderr) ? "userns-root" : /mount .*proc.* failed/.test(stderr) ? "private-proc" : "child-oracle";
      process.stdout.write(JSON.stringify({ schemaVersion: 1, mode, primitiveFailed: true, phase, exitCode: result.status, signal: result.signal }) + "\n"); process.exitCode = 70; return;
    }
    requireFact(result.stdout.length < 4096 && sha(readFileSync(transitionModule)) === transitionSha256);
    const report = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
    process.stdout.write(JSON.stringify({ ...report, runtime, transitionSha256 }) + "\n");
  } finally { if (held !== undefined) closeSync(held); }
}

async function run(operator: string, runtime: string): Promise<void> {
  requireFact(process.platform === "linux" && process.getuid?.() === 0 && readFileSync("/etc/machine-id", "utf8").trim() === "d856d40da5ad4e23b4f67773e5942842");
  trusted(operator); trusted(runtime); requireFact(lstatSync(operator).dev === 66305 && (lstatSync(operator).mode & 0o777) === 0o700);
  const scratchDevice = lstatSync(realpathSync("/dev/disk/by-uuid/d0f2cac1-2009-4e9d-a710-e156f417938f"));
  requireFact(scratchDevice.isBlockDevice() && scratchDevice.rdev === lstatSync(operator).dev && realpathSync("/srv/workers") === "/srv/workers" && lstatSync("/srv/workers").dev === 66305);
  const transitionSha256 = sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))), fixtureSha256 = sha(readFileSync(script));
  const resources = (): Readonly<{ observedAt: string; rootFreeBytes: number; scratchFreeBytes: number; memAvailableKiB: number; swapUsedKiB: number }> => {
    const root = statfsSync("/"), scratch = statfsSync(operator), memory = readFileSync("/proc/meminfo", "utf8");
    const value = (key: string): number => { const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(memory); requireFact(match); return Number(match![1]); };
    return { observedAt: new Date().toISOString(), rootFreeBytes: root.bavail * root.bsize, scratchFreeBytes: scratch.bavail * scratch.bsize,
      memAvailableKiB: value("MemAvailable"), swapUsedKiB: value("SwapTotal") - value("SwapFree") };
  };
  const directory = join(operator, "root-transition-" + randomUUID()); mkdirSync(directory, { mode: 0o700 });
  const outside = join(directory, "outside"); mkdirSync(outside, { mode: 0o700 });
  const sentinel = join(outside, "sentinel.txt"); writeFileSync(sentinel, "PUBLIC-TEST-outside-root\n", { mode: 0o600, flag: "wx" });
  const expectedPath = join(directory, "expected.json"), expected: Expected = { schemaVersion: 1, hostUser: readlinkSync("/proc/self/ns/user"), hostPid: readlinkSync("/proc/self/ns/pid"),
    outside: sentinel, sentinelSha256: sha(readFileSync(sentinel)), inside: "PUBLIC-TEST-inside-root\n" };
  writeFileSync(expectedPath, JSON.stringify(expected) + "\n", { mode: 0o600, flag: "wx" });
  const receipts: unknown[] = [];
  for (const mode of ["clean", "file", "directory"] as const) {
    const root = join(directory, mode); mkdirSync(root, { mode: 0o755 });
    for (const target of ["usr", "proc"]) mkdirSync(join(root, target), { mode: 0o755 });
    for (const target of ["probe.mts", "expected.json", "guard.mjs"]) writeFileSync(join(root, target), "", { mode: 0o644, flag: "wx" });
    writeFileSync(join(root, "inside.txt"), expected.inside, { mode: 0o644, flag: "wx" });
    if (!process.execPath.startsWith("/usr/")) { mkdirSync(dirname(join(root, process.execPath)), { recursive: true, mode: 0o755 }); writeFileSync(join(root, process.execPath), "", { mode: 0o644, flag: "wx" }); }
    for (const alias of ["bin", "sbin", "lib", "lib64"]) {
      try { const stat = lstatSync("/" + alias); if (stat.isSymbolicLink()) { const link = readlinkSync("/" + alias); requireFact(link === "usr/" + alias || link === "/usr/" + alias); symlinkSync("usr/" + alias, join(root, alias)); } else mkdirSync(join(root, alias), { mode: 0o755 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const baseline = tree(root), unit = "subscription-runtime-TEST-root-transition-" + randomUUID() + ".service", deadline = Number(process.hrtime.bigint() / 1_000_000n) + 300_000;
    requireFact(sha(readFileSync(script)) === fixtureSha256 && sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))) === transitionSha256);
    const before = resources(); requireFact(before.rootFreeBytes >= 5 * 1024 ** 3 && before.scratchFreeBytes >= 5 * 1024 ** 3 && before.memAvailableKiB >= 1024 ** 2);
    const result = call("/usr/bin/systemd-run", ["--quiet", "--wait", "--pipe", "--collect", "--service-type=exec", "--expand-environment=no", "--working-directory=/", "--unit=" + unit,
      "--property=KillMode=control-group", "--property=SendSIGKILL=yes", "--property=Restart=no", "--property=Delegate=no", "--property=TimeoutStartSec=300s", "--property=RuntimeMaxSec=90s",
      "--property=MemoryMax=1G", "--property=TasksMax=128", "--property=CPUQuota=200%", "--property=MemorySwapMax=0", "--property=LimitCORE=0", "--property=NoNewPrivileges=yes",
      "--property=CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP", "--property=AmbientCapabilities=", "--property=DevicePolicy=closed", "--property=SystemCallFilter=~@raw-io @module",
      "--", "/usr/bin/unshare", "--mount", "--propagation", "private", process.execPath, script, "assemble", root, runtime, expectedPath, mode, String(deadline)], deadline);
    const creatorUnchanged = tree(root) === baseline && !readFileSync("/proc/self/mountinfo", "utf8").split("\n").some(row => row.split(" ")[4]?.startsWith(root));
    let report: Record<string, unknown> | undefined;
    try { if (result.stdout.length < 4096) report = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>; } catch { /* Empty output still retains a finite failed attempt receipt below. */ }
    receipts.push({ unit, mode, before, exitCode: result.status, signal: result.signal, transportError: Boolean(result.error), creatorUnchanged, report });
    writeFileSync(join(directory, "receipt-" + mode + ".json"), JSON.stringify(receipts.at(-1)) + "\n", { mode: 0o600, flag: "wx" });
    requireFact(!result.error && !result.signal && result.status === 0 && creatorUnchanged && report?.mode === mode && report.runtime === runtime && report.transitionSha256 === transitionSha256 &&
      report.insideReadable === true && report.rootClosed === true && report.capabilitiesZero === true && report.userPrivate === true && report.pidPrivate === true && report.mapsCorrect === true && report.noNewPrivileges === true &&
      report.leakDenied === (mode !== "clean") && report.leakAccessible === (mode !== "clean"));
  }
  requireFact(sha(readFileSync(script)) === fixtureSha256 && sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))) === transitionSha256);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, directory, runtime, fixtureSha256, transitionSha256, descriptorGuardSha256: sha(readFileSync(join(runtime, "dist/provider-codex/app-server/adapters/hosted-process-descriptors.js"))), receipts }) + "\n");
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run" && args.length === 2) await run(path(args[0]!), path(args[1]!));
  else if (command === "assemble" && args.length === 5 && ["clean", "file", "directory"].includes(args[3]!)) await assemble(path(args[0]!), path(args[1]!), path(args[2]!), args[3] as Mode, Number(args[4]));
  else if (command === "oracle" && args.length === 1 && ["clean", "file", "directory"].includes(args[0]!)) await oracle(args[0] as Mode);
  else throw new Error("TEST_root_transition_arguments_invalid");
} catch { process.exitCode = 70; }
