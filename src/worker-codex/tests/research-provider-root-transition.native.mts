import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Explicit hosted-only operator primitive. No grants, account reads, model,
// request/admission records or READY token; this is not full adapter proof.
// Its operator tuple qualifies the compiled context guard's mechanics only.
type Prelude = Pick<typeof import("../research-provider-root-assembler"), "researchProviderRootTransition">;
type AssemblyRecipe = Pick<typeof import("../trusted-custody-systemd-launch"), "researchProviderAssemblyCapabilityBoundingSet">;
type ContextGuard = Pick<typeof import("../research-launch-host"), "assertResearchProviderInitialRoot">;
type DescriptorGuard = Pick<typeof import("../../provider-codex/app-server/adapters/hosted-process-descriptors"), "assertHostedFdPreludeDescriptors">;
type Mode = "clean" | "unmounted" | "file" | "directory";
type Expected = Readonly<{ schemaVersion: 1; hostUser: string; hostPid: string; initialHostContext: import("../research-launch-host").ResearchInitialHostContext; outside: string; sentinelSha256: string; inside: string }>;
const phases = ["arguments", "custody", "initial-caps", "no-new-privileges", "cold-root-witness", "provider-context", "import", "bind", "remount", "transition", "child-oracle", "oracle-inputs", "oracle-isolation", "oracle-nested-userns", "oracle-descriptors", "receipt", "userns-capset", "userns-root", "private-proc"] as const;
type Target = "none" | "operator" | "root" | "runtime" | "expected" | "proc" | "usr" | "node" | "probe" | "guard" | "bin" | "sbin" | "lib" | "lib64" | "outside-file" | "outside-directory";
let phase: typeof phases[number] = "arguments", target: Target = "none", role: "operator" | "assembler" | "oracle" = "operator", activeMode: Mode | null = null;
let failedCommand: ReturnType<typeof spawnSync> | undefined;
const mark = (next: typeof phases[number], selected: Target = "none"): true => { phase = next; target = selected; failedCommand = undefined; return true; };
const errno = (error: unknown) => (["ENOENT", "EACCES", "EPERM", "EINVAL", "ENOTDIR", "ELOOP", "EBADF", "EIO", "ETIMEDOUT", "EINTR", "ENOMEM", "ENOSPC", "ENOSYS"] as const).find(code => code === (error as NodeJS.ErrnoException | undefined)?.code) ?? null;
const mountFailure = (): "fstab-lookup" | "permission" | "invalid-argument" | "other" | null => {
  if (!failedCommand || (phase !== "bind" && phase !== "remount")) return null;
  const stderr = failedCommand.stderr?.toString("utf8") ?? "";
  return /can't find in (?:\/etc\/)?fstab|not found in (?:\/etc\/)?fstab/.test(stderr) ? "fstab-lookup" : /permission denied|operation not permitted|must be superuser/.test(stderr) ? "permission" : /invalid argument|bad option/.test(stderr) ? "invalid-argument" : "other";
};
const failure = (error: unknown) => ({ schemaVersion: 1, mode: activeMode, primitiveFailed: true, role, phase, target, errno: errno(error) ?? errno(failedCommand?.error),
  exitCode: Number.isSafeInteger(failedCommand?.status) && failedCommand!.status! >= 0 && failedCommand!.status! <= 255 ? failedCommand!.status : null,
  signal: (["SIGKILL", "SIGTERM", "SIGINT", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGPIPE", "SIGILL"] as const).find(value => value === failedCommand?.signal) ?? null, mountFailure: mountFailure() });
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
  if (result.error || result.signal || result.status !== 0) failedCommand = result;
  requireFact(!result.error && !result.signal && result.status === 0);
}

async function oracle(mode: Mode): Promise<void> {
  role = "oracle"; activeMode = mode; mark("oracle-inputs", "expected");
  const expected = JSON.parse(readFileSync("/expected.json", "utf8")) as Expected;
  requireFact(mode === "clean" && expected.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(expected.sentinelSha256));
  mark("oracle-isolation", "root");
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
  // A real CLONE_NEWUSER after the final zero-capability transition rejects
  // the former chroot recipe. This is not proof of Codex/bubblewrap behavior.
  mark("oracle-nested-userns", "root");
  const nested = spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "/usr/bin/true"], {
    cwd: "/", env, stdio: ["ignore", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL", maxBuffer: 4096,
  });
  requireFact(!nested.error && !nested.signal && nested.status === 0 && nested.stdout.length === 0 && nested.stderr.length === 0);
  mark("oracle-descriptors", "guard");
  const guard = await import(pathToFileURL("/guard.mjs").href) as DescriptorGuard;
  guard.assertHostedFdPreludeDescriptors();
  process.stdout.write(JSON.stringify({ schemaVersion: 1, mode, insideReadable, rootClosed, pidPrivate, userPrivate, mapsCorrect, capabilitiesZero, noNewPrivileges: true,
    nestedUserNamespace: true, descriptorsAccepted: true, leakAccessible: false, leakDenied: false }) + "\n");
}

async function assemble(root: string, runtime: string, expectedPath: string, mode: Mode, deadline: number): Promise<void> {
  role = "assembler"; activeMode = mode;
  mark("custody", "root"); trusted(root); mark("custody", "runtime"); trusted(runtime); mark("custody", "expected"); trusted(expectedPath);
  mark("initial-caps", "root");
  const ownStatus = readFileSync("/proc/self/status", "utf8");
  requireFact(/^CapBnd:\s+0000000080280100$/m.test(ownStatus) && mark("no-new-privileges", "root") && /^NoNewPrivs:\s+1$/m.test(ownStatus));
  mark("import", "runtime");
  const transitionModule = join(runtime, "dist/worker-codex/research-provider-root-assembler.js"), transitionSha256 = sha(readFileSync(transitionModule));
  const module = await import(pathToFileURL(transitionModule).href) as Prelude;
  const hostGuardModule = join(runtime, "dist/worker-codex/research-launch-host.js"), hostGuardSha256 = sha(readFileSync(hostGuardModule));
  const guard = await import(pathToFileURL(hostGuardModule).href) as ContextGuard, expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expected;
  mark("provider-context", "root"); guard.assertResearchProviderInitialRoot(expected.initialHostContext);
  // Regression: uid0 alone cannot cross PID1's proc magic-link ptrace gate.
  // The same cold-root route guards registered durable source and pin custody.
  mark("cold-root-witness", "root");
  const coldRoot = lstatSync("/proc/1/root" + root), directRoot = lstatSync(root);
  requireFact(coldRoot.dev === directRoot.dev && coldRoot.ino === directRoot.ino && coldRoot.uid === 0 && coldRoot.isDirectory());
  if (mode !== "unmounted") {
    mark("bind", "root");
    const lower = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { mount(["--bind", "/proc/self/fd/3", "/proc/self/fd/3"], deadline, [lower]); } finally { closeSync(lower); }
  }
  const bind = (source: string, target: string, directory: boolean, selected: Target): void => {
    mark("custody", selected);
    trusted(source); const destination = join(root, target.slice(1));
    mark("bind", selected);
    const a = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const b = openSync(destination, 0x200000 | constants.O_NOFOLLOW);
    try { mount(["--bind", "/proc/self/fd/3", "/proc/self/fd/4"], deadline, [a, b]); } finally { closeSync(a); closeSync(b); }
    const fd = openSync(destination, 0x200000 | constants.O_NOFOLLOW);
    try {
      const bound = fstatSync(fd), original = lstatSync(source);
      requireFact(bound.dev === original.dev && bound.ino === original.ino && bound.isDirectory() === directory);
      mark("remount", selected); mount(["-o", "remount,bind,ro,nosuid,nodev", "/proc/self/fd/3"], deadline, [fd]);
    } finally { closeSync(fd); }
  };
  // This primitive applies only a small public closure, not the production
  // provider's complete captured graph/API/device/protected policy.
  bind("/usr", "/usr", true, "usr");
  if (!process.execPath.startsWith("/usr/")) bind(process.execPath, process.execPath, false, "node");
  bind(script, "/probe.mts", false, "probe"); bind(expectedPath, "/expected.json", false, "expected");
  bind(join(runtime, "dist/provider-codex/app-server/adapters/hosted-process-descriptors.js"), "/guard.mjs", false, "guard");
  for (const alias of ["bin", "sbin", "lib", "lib64"] as const) {
    mark("custody", alias);
    const source = "/" + alias;
    try { lstatSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!lstatSync(source).isSymbolicLink()) bind(source, source, true, alias);
  }
  // Match the trusted bootstrap proc needed for mapping after pivot. The final
  // --mount-proc must still replace it before the existing child oracle runs.
  mark("private-proc", "proc");
  const procPath = join(root, "proc"); trusted(procPath);
  const proc = openSync(procPath, 0x200000 | constants.O_NOFOLLOW);
  try { mount(["-t", "proc", "-o", "nosuid,nodev,noexec", "proc", "/proc/self/fd/3"], deadline, [proc]); }
  finally { closeSync(proc); }
  mark("transition", "root");
  const transition = module.researchProviderRootTransition(root);
  mark("child-oracle", mode === "file" ? "outside-file" : mode === "directory" ? "outside-directory" : "root");
  const mountedRoot = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let held: number | undefined;
  try {
    if (mode === "file" || mode === "directory") held = openSync(mode === "file" ? expected.outside : dirname(expected.outside), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (held !== undefined) requireFact(sha(readFileSync(mode === "file" ? held : expected.outside)) === expected.sentinelSha256);
    if (mode !== "unmounted") {
      mark("remount", "root"); mount(["-o", "remount,bind,ro,nosuid,nodev", "/proc/self/fd/3"], deadline, [mountedRoot]);
    }
    requireFact(sha(readFileSync(transitionModule)) === transitionSha256 && sha(readFileSync(hostGuardModule)) === hostGuardSha256);
    mark("child-oracle", "root");
    const result = call(transition.command, [...transition.args, process.execPath, "/probe.mts", "oracle", mode], deadline, held === undefined ? [mountedRoot] : [mountedRoot, held]);
    // Missing pivot mount or a real outside FD must reject before any oracle
    // runs. Reaching any oracle output instead makes these negatives red.
    if (mode !== "clean") {
      requireFact(!result.error && !result.signal && result.status === 70 && result.stdout.length === 0 && result.stderr.length === 0);
      process.stdout.write(JSON.stringify({ schemaVersion: 1, mode, transitionDenied: true, descriptorsAccepted: false,
        runtime, transitionSha256, hostGuardSha256 }) + "\n"); return;
    }
    if (result.status !== 0 || result.error || result.signal) {
      failedCommand = result;
      const stderr = result.stderr?.toString("utf8") ?? "";
      const phase = /capset failed/.test(stderr) ? "userns-capset" : /cannot change root/.test(stderr) ? "userns-root" : /mount .*proc.* failed/.test(stderr) ? "private-proc" : "child-oracle";
      let oracleFailure: { phase: typeof phases[number]; errno: ReturnType<typeof errno> } | undefined;
      try { if (result.stdout.length < 4096) { const child = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
        const selected = phases.find(value => value === child.phase); if (child.primitiveFailed === true && child.role === "oracle" && selected?.startsWith("oracle-")) oracleFailure = { phase: selected, errno: errno({ code: child.errno }) }; } } catch { /* Closed diagnostic only. */ }
      process.stdout.write(JSON.stringify({ ...failure(result.error), phase, oracleFailure }) + "\n"); process.exitCode = 70; return;
    }
    // Pivot also changes this trusted supervisor's root/cwd. All filesystem
    // currentness checks precede it; the independent operator rechecks hashes.
    requireFact(result.stdout.length < 4096);
    const report = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
    process.stdout.write(JSON.stringify({ ...report, runtime, transitionSha256, hostGuardSha256 }) + "\n");
  } finally { try { closeSync(mountedRoot); } finally { if (held !== undefined) closeSync(held); } }
}

async function run(operator: string, runtime: string, negativesOnly = false): Promise<void> {
  mark("custody", "operator");
  requireFact(process.platform === "linux" && process.getuid?.() === 0 && readFileSync("/etc/machine-id", "utf8").trim() === "d856d40da5ad4e23b4f67773e5942842");
  trusted(operator); trusted(runtime); requireFact(lstatSync(operator).dev === 66305 && (lstatSync(operator).mode & 0o777) === 0o700);
  const scratchDevice = lstatSync(realpathSync("/dev/disk/by-uuid/d0f2cac1-2009-4e9d-a710-e156f417938f"));
  requireFact(scratchDevice.isBlockDevice() && scratchDevice.rdev === lstatSync(operator).dev && realpathSync("/srv/workers") === "/srv/workers" && lstatSync("/srv/workers").dev === 66305);
  const transitionSha256 = sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))), fixtureSha256 = sha(readFileSync(script));
  const hostGuardSha256 = sha(readFileSync(join(runtime, "dist/worker-codex/research-launch-host.js")));
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
    initialHostContext: { bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), machineId: readFileSync("/etc/machine-id", "utf8").trim(),
      namespaces: { user: readlinkSync("/proc/1/ns/user"), mnt: readlinkSync("/proc/1/ns/mnt"), pid: readlinkSync("/proc/1/ns/pid"), net: readlinkSync("/proc/1/ns/net") } },
    outside: sentinel, sentinelSha256: sha(readFileSync(sentinel)), inside: "PUBLIC-TEST-inside-root\n" };
  writeFileSync(expectedPath, JSON.stringify(expected) + "\n", { mode: 0o600, flag: "wx" });
  const recipe = await import(pathToFileURL(join(runtime, "dist/worker-codex/trusted-custody-systemd-launch.js")).href) as AssemblyRecipe;
  const receipts: unknown[] = [];
  for (const mode of negativesOnly ? ["unmounted", "file", "directory"] as const : ["clean", "unmounted", "file", "directory"] as const) {
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
    requireFact(sha(readFileSync(script)) === fixtureSha256 && sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))) === transitionSha256 &&
      sha(readFileSync(join(runtime, "dist/worker-codex/research-launch-host.js"))) === hostGuardSha256);
    const before = resources(); requireFact(before.rootFreeBytes >= 5 * 1024 ** 3 && before.scratchFreeBytes >= 5 * 1024 ** 3 && before.memAvailableKiB >= 1024 ** 2);
    writeFileSync(join(directory, "dispatch-" + mode + ".json"), JSON.stringify({ unit, mode, deadline }) + "\n", { mode: 0o600, flag: "wx" });
    const result = call("/usr/bin/systemd-run", ["--quiet", "--wait", "--pipe", "--collect", "--service-type=exec", "--expand-environment=no", "--working-directory=/", "--unit=" + unit,
      "--property=KillMode=control-group", "--property=SendSIGKILL=yes", "--property=Restart=no", "--property=Delegate=no", "--property=TimeoutStartSec=300s", "--property=RuntimeMaxSec=90s",
      "--property=MemoryMax=1G", "--property=TasksMax=128", "--property=CPUQuota=200%", "--property=MemorySwapMax=0", "--property=LimitCORE=0", "--property=NoNewPrivileges=yes",
      "--property=" + recipe.researchProviderAssemblyCapabilityBoundingSet, "--property=AmbientCapabilities=", "--property=DevicePolicy=closed", "--property=SystemCallFilter=~@raw-io @module",
      "--", "/usr/bin/unshare", "--mount", "--propagation", "private", process.execPath, script, "assemble", root, runtime, expectedPath, mode, String(deadline)], deadline);
    const creatorUnchanged = tree(root) === baseline && !readFileSync("/proc/self/mountinfo", "utf8").split("\n").some(row => row.split(" ")[4]?.startsWith(root));
    mark("receipt", "root");
    let report: Record<string, unknown> | undefined;
    try { if (result.stdout.length < 4096) report = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>; } catch { /* Empty output still retains a finite failed attempt receipt below. */ }
    receipts.push({ unit, mode, before, exitCode: result.status, signal: result.signal, transportError: Boolean(result.error), creatorUnchanged, report });
    writeFileSync(join(directory, "receipt-" + mode + ".json"), JSON.stringify(receipts.at(-1)) + "\n", { mode: 0o600, flag: "wx" });
    if (result.error || result.signal || result.status !== 0) failedCommand = result;
    requireFact(!result.error && !result.signal && result.status === 0 && creatorUnchanged && report?.mode === mode && report.runtime === runtime && report.transitionSha256 === transitionSha256 && report.hostGuardSha256 === hostGuardSha256);
    requireFact(report !== undefined && (mode === "clean" ? report.insideReadable === true && report.rootClosed === true && report.capabilitiesZero === true && report.userPrivate === true && report.pidPrivate === true &&
      report.mapsCorrect === true && report.noNewPrivileges === true && report.nestedUserNamespace === true && report.descriptorsAccepted === true : report.transitionDenied === true && report.descriptorsAccepted === false));
    requireFact(sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))) === transitionSha256 && sha(readFileSync(join(runtime, "dist/worker-codex/research-launch-host.js"))) === hostGuardSha256);
  }
  requireFact(sha(readFileSync(script)) === fixtureSha256 && sha(readFileSync(join(runtime, "dist/worker-codex/research-provider-root-assembler.js"))) === transitionSha256 &&
    sha(readFileSync(join(runtime, "dist/worker-codex/research-launch-host.js"))) === hostGuardSha256);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, directory, runtime, fixtureSha256, transitionSha256, hostGuardSha256, descriptorGuardSha256: sha(readFileSync(join(runtime, "dist/provider-codex/app-server/adapters/hosted-process-descriptors.js"))), receipts }) + "\n");
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run" && args.length === 2) await run(path(args[0]!), path(args[1]!));
  else if (command === "run-negatives" && args.length === 2) await run(path(args[0]!), path(args[1]!), true);
  else if (command === "assemble" && args.length === 5 && ["clean", "unmounted", "file", "directory"].includes(args[3]!)) await assemble(path(args[0]!), path(args[1]!), path(args[2]!), args[3] as Mode, Number(args[4]));
  else if (command === "oracle" && args.length === 1 && args[0] === "clean") await oracle("clean");
  else throw new Error("TEST_root_transition_arguments_invalid");
} catch (error) { process.stdout.write(JSON.stringify(failure(error)) + "\n"); process.exitCode = 70; }
