import { strict as assert } from "node:assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { prepareHostScratchCaches, prepareHostScratchTemp } from "../dist/worker-codex/host-scratch-temp.js";
import { enterScratchPrivateMountNamespace, hostNamespaceInvocation } from "../dist/worker-codex/scratch-mount-namespace.js";

// Disposable privileged container ONLY, started with this script as PID 1 (docker run --privileged --tmpfs /tmp
// <image with node >= 22.15, util-linux, e2fsprogs> node --experimental-strip-types <this file>).
// PID 1's mount namespace plays the host. Never run on a production host: it mounts a loop filesystem.
const SCRATCH_ROOT = "/srv/workers", POLICY = "/etc/subscription-runtime/scratch-temp.json";
const UUID = "d0f2cac1-2009-4e9d-a710-e156f417938f";
const JOBS = "/var/TEST-scratch-jobs";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const run = (file: string, ...args: string[]) => execFileSync(file, args, { stdio: "pipe", timeout: 120_000 });

type JobPaths = { job: string; home: string; tmp: string; caches: readonly string[]; sources: readonly string[] };
function jobPaths(name: string): JobPaths {
  const job = `${JOBS}/${name}`, home = `${job}/home`;
  const caches = [`${home}/plugins/cache`, `${home}/cache/remote_plugin_catalog`];
  return { job, home, tmp: `${job}/tmp`, caches,
    sources: [`${SCRATCH_ROOT}/runtime-tmp/${sha(job)}`, ...caches.map(target => `${SCRATCH_ROOT}/runtime-caches/${sha(target)}`)] };
}

// Mount points under a job root in one /proc/<pid>/mountinfo table.
function mountsUnder(pid: number | "self", job: string): string[] {
  let table: string;
  try { table = readFileSync(`/proc/${pid}/mountinfo`, "utf8"); }
  catch (error) { if (["ENOENT", "ESRCH", "EACCES", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) return []; throw error; }
  return table.split("\n").map(line => line.split(" ")[4] ?? "").filter(target => target === job || target.startsWith(job + "/"));
}
function mountsInAnyNamespace(job: string): string[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(pid => mountsUnder(Number(pid), job).map(target => `${pid}:${target}`));
}

// Runner role: the real production entry sequence (no injected host).
async function runner(name: string, mode: string): Promise<void> {
  const paths = jobPaths(name);
  if (mode !== "unguarded") enterScratchPrivateMountNamespace();
  if (mode === "hostexec") {
    // The tmux server must start in the host namespace even when launched from a runner namespace.
    const invocation = hostNamespaceInvocation("/bin/readlink", ["/proc/self/ns/mnt"]);
    const hostNs = execFileSync(invocation.command, [...invocation.args], { encoding: "utf8" }).trim();
    process.stdout.write(JSON.stringify({ pid: process.pid, event: "hostexec", ownNs: readlinkSync("/proc/self/ns/mnt"), spawnedNs: hostNs }) + "\n");
    return;
  }
  if (mode === "nested") {
    // A child of a runner inherits its namespace and marker (tmux server pane, MCP child): it must get its own.
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "runner", name, "plain"], { stdio: ["pipe", "pipe", "inherit"] });
    const line = await new Promise<string>(resolve => createInterface({ input: child.stdout }).once("line", resolve));
    process.stdout.write(JSON.stringify({ pid: process.pid, event: "nested", ownNs: readlinkSync("/proc/self/ns/mnt"), child: JSON.parse(line) as object }) + "\n");
    process.stdin.on("end", () => { child.stdin.end(); child.once("exit", () => process.exit(0)); }).resume();
    setInterval(() => undefined, 1 << 30);
    return;
  }
  const own = readlinkSync("/proc/self/ns/mnt");
  let pid1: string | undefined;
  try { pid1 = readlinkSync("/proc/1/ns/mnt"); } catch { /* unreadable without capabilities */ }
  const report = (value: object) => process.stdout.write(JSON.stringify({ pid: process.pid, ...value }) + "\n");
  try {
    await prepareHostScratchTemp(paths.job, {});
    await prepareHostScratchCaches(paths.home, {});
  } catch (error) {
    report({ event: "refused", message: (error as Error).message, sameAsPid1: own === pid1 });
    return;
  }
  mkdirSync(`${paths.tmp}/agent`, { recursive: true });
  writeFileSync(`${paths.tmp}/agent/data`, "kept");
  report({ event: "ready", sameAsPid1: own === pid1, ns: own });
  // Keep the session alive; a child shares the private namespace like a sandbox would.
  if (mode === "tree") spawn("sleep", ["600"], { stdio: "ignore" });
  process.stdin.on("end", () => process.exit(0)).resume();
  setInterval(() => undefined, 1 << 30);
}

type Started = { child: ChildProcess; first: Promise<Record<string, unknown>> };
function start(name: string, mode: string): Started {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "runner", name, mode],
    { stdio: ["pipe", "pipe", "inherit"], detached: true });
  const first = new Promise<Record<string, unknown>>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", line => resolve(JSON.parse(line) as Record<string, unknown>));
    child.once("exit", code => reject(new Error(`runner exited early with ${code}`)));
  });
  return { child, first };
}
const exited = (child: ChildProcess) => new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve()));

async function driver(): Promise<void> {
  assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 0); assert.equal(process.pid, 1, "run as PID 1 of a disposable container");
  // Loop-mounted ext4 with a stable UUID is the scratch filesystem the policy requires.
  // Like a systemd host: PID 1's mounts are shared. Docker's default private root would hide propagation bugs.
  run("mount", "--make-rshared", "/");
  mkdirSync(SCRATCH_ROOT, { recursive: true }); mkdirSync("/etc/subscription-runtime", { recursive: true });
  run("truncate", "-s", "9G", "/var/TEST-scratch.img");
  run("mkfs.ext4", "-q", "-F", "-U", UUID, "-O", "^has_journal", "/var/TEST-scratch.img");
  run("mount", "-o", "loop", "/var/TEST-scratch.img", SCRATCH_ROOT);
  for (const family of ["runtime-tmp", "runtime-caches"]) { mkdirSync(`${SCRATCH_ROOT}/${family}`, { mode: 0o711 }); run("chmod", "0711", `${SCRATCH_ROOT}/${family}`); }
  writeFileSync(POLICY, JSON.stringify({ schemaVersion: 1, root: SCRATCH_ROOT, uuid: UUID }), { mode: 0o600 });
  const names = ["normal", "killed", "unguarded", "legacy", "nested", "nested-child", "hostexec", "nocaps"];
  for (const name of names) mkdirSync(jobPaths(name).home, { recursive: true, mode: 0o755 });

  const evidence: Record<string, unknown> = { hostNamespace: readlinkSync("/proc/1/ns/mnt") };

  // Slave propagation: a bind visible from the host (legacy) must disappear from a live runner when the host unmounts it.
  const legacy = jobPaths("legacy");
  mkdirSync(`${legacy.job}/legacy-src`, { recursive: true }); mkdirSync(`${legacy.job}/legacy-target`);
  run("mount", "--bind", `${legacy.job}/legacy-src`, `${legacy.job}/legacy-target`);
  const watcher = start("legacy", "tree"); assert.equal((await watcher.first).event, "ready");
  assert.ok(mountsUnder(watcher.child.pid!, legacy.job).includes(`${legacy.job}/legacy-target`), "runner inherits host binds");
  run("umount", `${legacy.job}/legacy-target`);
  assert.ok(!mountsUnder(watcher.child.pid!, legacy.job).includes(`${legacy.job}/legacy-target`), "host unmount propagates into the runner");
  process.kill(-watcher.child.pid!, "SIGKILL"); await exited(watcher.child);

  // Invariant 1 and the normal-exit half of invariant 2.
  const normal = jobPaths("normal"), a = start("normal", "plain");
  const ready = await a.first;
  assert.equal(ready.event, "ready", JSON.stringify(ready)); assert.equal(ready.pid, a.child.pid, "execve keeps the PID");
  assert.equal(ready.sameAsPid1, false);
  assert.deepEqual(mountsUnder("self", normal.job), [], "no per-session mount in the host namespace");
  assert.deepEqual(mountsUnder(a.child.pid!, normal.job).sort(), [normal.tmp, ...normal.caches].sort(), "runner namespace holds exactly the 3 binds");
  assert.deepEqual(mountsInAnyNamespace(normal.job).filter(entry => !entry.startsWith(`${a.child.pid}:`)), []);
  assert.equal(readFileSync(`${normal.sources[0]}/agent/data`, "utf8"), "kept", "data lands on the scratch source");
  a.child.stdin!.end(); await exited(a.child);
  assert.deepEqual(mountsInAnyNamespace(normal.job), [], "no mount in any namespace after normal exit");
  assert.equal(readFileSync(`${normal.sources[0]}/agent/data`, "utf8"), "kept", "source data survives exit");
  evidence.normal = { runnerPid: a.child.pid, bindsInRunner: 3, hostMounts: 0, afterExit: 0 };

  // SIGKILL of the whole runner tree (runner plus its sandbox-like child).
  const killed = jobPaths("killed"), b = start("killed", "tree");
  assert.equal((await b.first).event, "ready");
  assert.deepEqual(mountsUnder("self", killed.job), []);
  process.kill(-b.child.pid!, "SIGKILL"); await exited(b.child);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(mountsInAnyNamespace(killed.job), [], "no mount in any namespace after SIGKILL");
  assert.ok(existsSync(`${killed.sources[0]}/agent/data`), "source data survives SIGKILL");
  evidence.sigkill = { hostMounts: 0, afterKill: 0 };

  // Inherited namespace (tmux server pane, MCP child): the child must get its own namespace, not share the parent's.
  const nested = jobPaths("nested-child"), d = start("nested", "nested");
  const outer = await d.first; const inner = outer.child as Record<string, unknown>;
  assert.equal(inner.event, "ready");
  assert.notEqual(inner.ns, outer.ownNs, "child runner has its own namespace");
  assert.notEqual(inner.ns, evidence.hostNamespace);
  assert.deepEqual(mountsUnder("self", nested.job), []);
  assert.deepEqual(mountsUnder(d.child.pid!, nested.job), [], "the parent namespace holds none of the child's binds");
  d.child.stdin!.end(); await exited(d.child);
  for (let i = 0; i < 50 && mountsInAnyNamespace(nested.job).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(mountsInAnyNamespace(nested.job), [], "no mount in any namespace after the nested runner exits");
  evidence.inheritedNamespace = "own namespace per runner";

  // The tmux server is launched into the host namespace from a runner namespace.
  const e = start("hostexec", "hostexec"); const hostexec = await e.first; await exited(e.child);
  assert.equal(hostexec.spawnedNs, evidence.hostNamespace); assert.notEqual(hostexec.ownNs, evidence.hostNamespace);
  evidence.tmuxHostNamespace = "host";

  // Codex sandbox (root without capabilities): no re-exec, no crash, no bind (guard refuses).
  const g = spawn("setpriv", ["--bounding-set=-all", "--inh-caps=-all", process.execPath, ...process.execArgv, process.argv[1]!, "runner", "nocaps", "plain"],
    { stdio: ["pipe", "pipe", "inherit"], detached: true });
  const sandboxed = await new Promise<Record<string, unknown>>(resolve => createInterface({ input: g.stdout }).once("line", line => resolve(JSON.parse(line) as Record<string, unknown>)));
  await exited(g);
  assert.equal(sandboxed.event, "refused"); assert.match(String(sandboxed.message), /requires a private mount namespace/);
  assert.deepEqual(mountsInAnyNamespace(jobPaths("nocaps").job), []);
  evidence.sandbox = "degrades without bind";

  // Fail-closed end to end: an entry that skips the helper must refuse, not bind in the host namespace.
  const unguarded = jobPaths("unguarded"), c = start("unguarded", "unguarded");
  const refused = await c.first; await exited(c.child);
  assert.equal(refused.event, "refused"); assert.equal(refused.sameAsPid1, true);
  assert.match(String(refused.message), /requires a private mount namespace/);
  assert.deepEqual(mountsInAnyNamespace(unguarded.job), []);
  evidence.unguardedEntry = "refused";
  process.stdout.write(JSON.stringify({ status: "passed", ...evidence }) + "\n");
}

if (process.argv[2] === "runner") await runner(process.argv[3]!, process.argv[4]!);
else await driver();
