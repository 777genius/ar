import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readHostedFdRecipeImages } from "../../../../dist/provider-codex/app-server/adapters/hosted-fd-recipe-images.js";
import { hostedFdNamespacePrefix, assertHostedFdNamespaceAncestry } from "../../../../dist/provider-codex/app-server/adapters/hosted-fd-namespace-stages.js";
import type { HostedFdProcess } from "../../app-server/adapters/hosted-fd-observation.js";
const self = fileURLToPath(import.meta.url), repo = realpathSync(join(dirname(self), "../../../.."));
const root = "/var/lib/subscription-runtime-host-policy/dependency-provider-roots/01234567-89ab-cdef-0123-456789abcdef";
const leaves = ["provider-codex/app-server/adapters/hosted-fd-recipe-images.js", "provider-codex/app-server/adapters/hosted-fd-namespace-stages.js",
  "provider-codex/app-server/adapters/hosted-dependency-systemd-command.js", "provider-codex/app-server/domain/app-server-observer-failure.js",
  "provider-codex/app-server/domain/app-server-namespace-failure.js", "core/host-infrastructure/process-cgroup.js"] as const;
// TEST-only closed transport: nested stderr is never forwarded. A complete,
// validated fact survives the private setup/chroot boundaries; arbitrary text
// contributes at most a fixed bootstrap/command category.
const stages = ["entry", "closure", "outer_setup", "setup_runtime", "setup_proc", "setup_leaves", "setup_fixture", "setup_package", "setup_maps", "setup_observe", "observe_runtime", "observe_pins", "positive_ready", "positive_collect", "positive_main", "positive_image", "positive_namespace", "positive_revalidate", "positive_raw_rejoin", "positive_maps", "positive_stop", "foreign_bind", "negative_ready", "negative_collect", "negative_image", "negative_stop", "diagnostic_case"] as const;
const primitives = ["none", "mount_bind", "mount_ro", "mount_proc", "node_import", "chroot_observe", "outer_unshare", "diagnostic_child"] as const;
const names = ["Unknown", "Error", "AssertionError", "TypeError", "RangeError", "SyntaxError"] as const;
const errnos = ["none", "EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "EROFS", "EIO", "EBADF", "ENOSPC", "ETIMEDOUT"] as const;
const stderrCodes = ["none", "unknown", "module_missing", "syntax", "loader_missing", "read_only", "permission", "missing"] as const;
const operators = ["none", "strictEqual", "notStrictEqual", "deepStrictEqual", "ok", "throws", "match"] as const;
const scalars = ["unknown", "undefined", "null", "number", "string", "true", "false", "object"] as const;
const signals = ["none", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"] as const;
const modes = ["outer", "setup", "observe", "closure", "diagnostic", "unknown"] as const;
let stage: typeof stages[number] = "entry", primitive: typeof primitives[number] = "none", commandIndex = 0;
let nestedFailure: Failure | undefined;
interface Failure { schemaVersion: 1; mode: typeof modes[number]; stage: typeof stages[number]; primitive: typeof primitives[number]; commandIndex: number;
  name: typeof names[number]; errno: typeof errnos[number]; status: number; signal: typeof signals[number]; stderrCode: typeof stderrCodes[number];
  operator: typeof operators[number]; actual: typeof scalars[number]; actualNumber: number; expected: typeof scalars[number]; expectedNumber: number; }
const failurePrefix = "TEST-root-failure ";
function own(value: unknown, key: string): unknown { try { return value !== null && (typeof value === "object" || typeof value === "function") ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; } catch { return undefined; } }
function member<T extends string>(values: readonly T[], value: unknown, fallback: T): T { return typeof value === "string" && values.includes(value as T) ? value as T : fallback; }
function bounded(value: unknown, limit = 65535): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : -1; }
function scalar(value: unknown): typeof scalars[number] { return value === undefined ? "undefined" : value === null ? "null" : value === true ? "true" : value === false ? "false" : typeof value === "number" ? "number" : typeof value === "string" ? "string" : "object"; }
function failure(error: unknown): Failure {
  const name = error instanceof assert.AssertionError ? "AssertionError" : error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof SyntaxError ? "SyntaxError" : error instanceof Error ? "Error" : "Unknown";
  return { schemaVersion: 1, mode: !process.argv[2] ? "outer" : process.argv[2] === "--setup" ? "setup" : process.argv[2] === "--observe" ? "observe" : process.argv[2] === "--closure" ? "closure" : process.argv[2] === "--diagnostic-case" ? "diagnostic" : "unknown",
    stage, primitive, commandIndex, name, errno: member(errnos, own(error, "code"), "none"), status: -1, signal: "none", stderrCode: "none",
    operator: member(operators, own(error, "operator"), "none"), actual: scalar(own(error, "actual")), actualNumber: bounded(own(error, "actual")), expected: scalar(own(error, "expected")), expectedNumber: bounded(own(error, "expected")) };
}
function parseFailure(text: string): Failure | undefined {
  if (text.length > 2048 || !text.startsWith(failurePrefix) || !text.endsWith("\n") || /[^\x20-\x7e\n]/.test(text) || text.slice(0, -1).includes("\n")) return undefined;
  try {
    const v = JSON.parse(text.slice(failurePrefix.length)), keys = ["schemaVersion", "mode", "stage", "primitive", "commandIndex", "name", "errno", "status", "signal", "stderrCode", "operator", "actual", "actualNumber", "expected", "expectedNumber"];
    if (!v || Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key)) || v.schemaVersion !== 1) return undefined;
    for (const [key, values] of [["mode", modes], ["stage", stages], ["primitive", primitives], ["name", names], ["errno", errnos], ["signal", signals], ["stderrCode", stderrCodes], ["operator", operators], ["actual", scalars], ["expected", scalars]] as const) if (!(values as readonly unknown[]).includes(v[key])) return undefined;
    for (const key of ["commandIndex", "status", "actualNumber", "expectedNumber"]) if (v[key] !== -1 && bounded(v[key], key === "status" ? 255 : 65535) !== v[key]) return undefined;
    return v as Failure;
  } catch { return undefined; }
}
function commandFailure(result: { error?: Error; signal: string | null; status: number | null; stderr: string }): void {
  nestedFailure = parseFailure(result.stderr);
  if (!nestedFailure) {
    const f = failure(result.error); f.status = bounded(result.status, 255); f.signal = member(signals, result.signal, "none");
    // Classification of private fixed-command output, never returned text.
    f.stderrCode = result.stderr.includes("ERR_MODULE_NOT_FOUND") ? "module_missing" : result.stderr.includes("SyntaxError:") ? "syntax" : result.stderr.includes("error while loading shared libraries:") ? "loader_missing" : result.stderr.includes("Read-only file system") ? "read_only" : result.stderr.includes("permission denied") || result.stderr.includes("Permission denied") ? "permission" : result.stderr.includes("No such file or directory") ? "missing" : result.stderr ? "unknown" : "none";
    nestedFailure = f;
  }
}
function command(path: string, args: readonly string[], operation: typeof primitives[number]): string {
  primitive = operation; commandIndex = Math.min(65535, commandIndex + 1);
  const result = spawnSync(path, args, { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
  if (result.error || result.signal || result.status !== 0) commandFailure(result);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, "TEST fixed namespace setup command failed"); primitive = "none"; return result.stdout;
}
function directory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function bind(source: string, target: string, isDirectory: boolean): void {
  directory(dirname(target));
  if (isDirectory) directory(target); else if (!existsSync(target)) writeFileSync(target, "", { flag: "wx", mode: 0o600 });
  command("/usr/bin/mount", ["--bind", source, target], "mount_bind"); command("/usr/bin/mount", ["-o", "remount,bind,ro", target], "mount_ro");
}
function runtime(target: string): void {
  bind("/usr", target + "/usr", true);
  for (const alias of ["/bin", "/sbin", "/lib", "/lib64"]) if (existsSync(alias)) bind(realpathSync(alias), target + alias, true);
  bind(process.execPath, target + process.execPath, false);
}
function maps(pid: number): readonly string[] {
  return [...new Set(readFileSync(`/proc/${pid}/maps`, "utf8").split("\n").flatMap(line => {
    const fields = line.trim().split(/\s+/); return fields.length >= 6 && fields[5]!.startsWith("/") ? [fields[5]!] : [];
  }))];
}
function checkedMaps(text: string): string {
  assert.ok(text.startsWith("TEST-node-maps ") && text.endsWith("\n") && text.length < 256);
  const fact = JSON.parse(text.slice("TEST-node-maps ".length)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fact).sort(), ["aliasLibraries", "aliasNode", "exactLibraries", "exactNode", "otherFiles", "schemaVersion"]);
  assert.equal(fact.schemaVersion, 1); assert.equal(typeof fact.exactNode, "boolean"); assert.equal(typeof fact.aliasNode, "boolean");
  for (const key of ["exactLibraries", "aliasLibraries", "otherFiles"]) assert.ok(typeof fact[key] === "number" && Number.isSafeInteger(fact[key]) && Number(fact[key]) >= 0 && Number(fact[key]) <= 64);
  return text;
}
async function main(): Promise<void> {
if (process.argv[2] === "--diagnostic-case") {
  stage = "diagnostic_case";
  if (process.argv[3] === "native") throw Object.assign(Error("TEST-private-native-canary /private/TEST-auth-file"), { code: "EROFS" });
  if (process.argv[3] === "assertion") assert.equal(23, 18);
  if (process.argv[3] === "string") assert.equal("TEST-private-actual-canary", "TEST-private-expected-canary");
  if (process.argv[3] === "nested_assertion") command(process.execPath, [self, "--diagnostic-case", "assertion"], "diagnostic_child");
  if (process.argv[3] === "nested") command(process.execPath, [self, "--diagnostic-case", "native"], "diagnostic_child");
  if (process.argv[3] === "poison" || process.argv[3] === "bootstrap") {
    const text = process.argv[3] === "poison" ? 'TEST-root-failure {"private":"TEST-private-poison-canary"}\n' : "Error [ERR_MODULE_NOT_FOUND]: /private/TEST-bootstrap-canary\n";
    command(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(text)});process.exitCode=1`], "diagnostic_child");
  }
  throw Error("TEST fixed diagnostic case failed");
} else if (process.argv[2] === "--closure") {
  stage = "closure";
  const temporary = mkdtempSync(join(tmpdir(), "TEST-wrapper-closure-"));
  try {
    const allowed = new Set(leaves.map(leaf => resolve(repo, "dist", leaf)));
    for (const leaf of leaves) {
      const source = resolve(repo, "dist", leaf), bytes = readFileSync(source), text = bytes.toString("utf8");
      assert.ok(!/\bimport\s*\(|\brequire\s*\(/.test(text));
      for (const match of text.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
        const specifier = match[1]!; assert.ok(specifier.startsWith("node:") || specifier.startsWith(".") && allowed.has(resolve(dirname(source), specifier)));
      }
      const target = join(temporary, "dist", leaf); directory(dirname(target)); writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    writeFileSync(join(temporary, "package.json"), '{"type":"module"}\n', { flag: "wx", mode: 0o600 });
    const imports = leaves.slice(0, 2).map(leaf => `await import(${JSON.stringify(pathToFileURL(join(temporary, "dist", leaf)).href)})`).join(";");
    assert.equal(command(process.execPath, ["--input-type=module", "-e", imports], "node_import"), "");
    process.stdout.write("TEST finite root closure complete\n");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else if (!process.argv[2]) {
  const available = process.platform === "linux" && process.getuid?.() === 0 && ["/usr/bin/unshare", "/usr/bin/tini", "/usr/bin/mount", "/usr/sbin/chroot", "/bin/bash", "/bin/sh"].every(existsSync);
  const probe = available ? spawnSync("/usr/bin/unshare", ["--mount", "--propagation=private", "--", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5000 }) : undefined;
  if (!available || probe?.status !== 0) { process.stdout.write("TEST root namespace capability unavailable\n"); process.exitCode = 77; }
  else {
    const temp = mkdtempSync(join(tmpdir(), "TEST-wrapper-root-"));
    try {
      stage = "outer_setup"; primitive = "outer_unshare";
      const result = spawnSync("/usr/bin/unshare", ["--mount", "--propagation=private", "--", process.execPath, self, "--setup", temp + "/outer"],
        { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 30000, maxBuffer: 4096 });
      if (result.error || result.signal || result.status !== 0) commandFailure(result);
      assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, "TEST private RootDirectory probe failed");
      const suffix = "TEST owned RootDirectory image projection accepted\n";
      assert.ok(result.stdout.endsWith(suffix)); checkedMaps(result.stdout.slice(0, -suffix.length)); process.stdout.write(result.stdout);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
} else if (process.argv[2] === "--setup") {
  stage = "setup_runtime";
  const outer = process.argv[3]!; directory(outer);
  // unshare --propagation=private changes "/" and EINVALs unless the chroot
  // root is a mount root, so outer must be a mount point before runtime binds.
  command("/usr/bin/mount", ["--bind", outer, outer], "mount_bind");
  runtime(outer);
  stage = "setup_proc"; directory(outer + "/proc"); command("/usr/bin/mount", ["-t", "proc", "proc", outer + "/proc"], "mount_proc");
  stage = "setup_leaves";
  for (const relative of leaves) bind(repo + "/dist/" + relative, outer + repo + "/dist/" + relative, false);
  stage = "setup_fixture"; bind(self, outer + self, false); directory(outer + repo);
  stage = "setup_package";
  writeFileSync(outer + repo + "/package.json", '{"type":"module"}\n', { flag: "wx", mode: 0o600 });
  stage = "setup_maps"; const expected = maps(process.pid); assert.ok(expected.length > 0 && expected.length <= 64);
  writeFileSync(outer + "/TEST-node-map-input.json", JSON.stringify(expected), { flag: "wx", mode: 0o600 });
  stage = "setup_observe"; process.stdout.write(checkedMaps(command("/usr/sbin/chroot", [outer, process.execPath, self, "--observe"], "chroot_observe")));
  process.stdout.write("TEST owned RootDirectory image projection accepted\n");
} else if (process.argv[2] === "--observe") {
  stage = "observe_runtime"; directory(root);
  // The owned image must be a mount root so the entry can move that mount;
  // runtime binds attach below it and travel with the moved subtree.
  command("/usr/bin/mount", ["--bind", root, root], "mount_bind");
  runtime(root); directory(root + "/proc");
  // mount(8) resolves its userspace mount table at /run/mount/utab from inside
  // the chroot and fails the entry move with rc=16 when the directory is absent.
  directory("/run/mount");
  const argv = [...hostedFdNamespacePrefix, process.execPath, "-e", "process.stdout.write('TEST-ready\\n');process.stdin.resume()"];
  stage = "observe_pins"; const pins = ["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini", "/usr/bin/systemd-run"].map(path => ({ path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), elfFiles: [] }));
  async function withChild(negative: boolean, action: (rows: readonly HostedFdProcess[], pid: number) => void): Promise<void> {
    stage = negative ? "negative_ready" : "positive_ready";
    // The kernel denies CLONE_NEWUSER to chrooted processes (create_user_ns ->
    // current_chrooted), and current_chrooted only passes when the image mount
    // is the deepest mount on the namespace root dentry. mount(8) canonicalizes
    // the /proc/<pid>/root magic link to "/" before mount(2), which would move
    // the image onto this wrapper's fs root instead; --no-canonicalize keeps the
    // magic link so the kernel resolves it to the unchrooted setup process's fs
    // root (the namespace root). exec through the /bin->/usr/bin alias bind with
    // a canonical argv[0] keeps the raw exe spelling non-canonical.
    const alias = "/bin" + argv[0]!.slice("/usr/bin".length);
    const entry = 'cd "$1" || exit 9\n/usr/bin/mount --no-canonicalize --move . "/proc/$2/root" || exit 10\nalias="$3"\nshift 3\nexec /usr/sbin/chroot . /bin/bash -c \'exec -a "$1" "$2" "${@:3}"\' TEST-chain "$1" "$alias" "${@:2}"';
    const child = spawn("/bin/bash", ["-c", entry, "TEST-entry", root, String(process.ppid), alias, ...argv],
      { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: "pipe" });
    let ready = false, stderr = "", stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes <= 4096) stderr += chunk.toString("utf8"); else stderr = ""; });
    const closed = once(child, "close"); const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const first = await Promise.race([once(child.stdout, "data"), closed.then(([code, signal]) => { if (!ready) { commandFailure({ status: typeof code === "number" ? code : null, signal: typeof signal === "string" ? signal : null, stderr }); throw Error("TEST child closed before ready"); } return []; })]);
      ready = true; assert.equal(String(first[0]), "TEST-ready\n");
      stage = negative ? "negative_collect" : "positive_collect";
      const rows: HostedFdProcess[] = [];
      function collect(pid: number): void {
        assert.ok(rows.length < 16);
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), end = raw.lastIndexOf(") "), fields = raw.slice(end + 2).trim().split(/\s+/);
        const args = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0"); assert.equal(args.pop(), "");
        const group = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(line => line.startsWith("0::"))!;
        rows.push({ pid, parentPid: Number(fields[1]), birth: `${pid}:${fields[19]}`, exe: readlinkSync(`/proc/${pid}/exe`), argv: args, group,
          net: "", user: "", mount: "", pidNamespace: "", uidMap: "", gidMap: "", status: "", descriptors: [] });
        for (const next of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) collect(Number(next));
      }
      collect(child.pid!); action(rows, child.pid!);
      stage = negative ? "negative_stop" : "positive_stop";
      child.stdin.end(); const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  }
  const deadline = Date.now() + 10000, remaining = () => { const left = deadline - Date.now(); assert.ok(left > 0); return left; };
  await withChild(false, (rows, pid) => {
    stage = "positive_main"; const main = rows.find(row => row.pid === pid)!;
    // Raw exe spelling is not canonical under the /bin->/usr/bin alias bind;
    // the projection normalizes it to pin.path. This measured non-canonical
    // spelling is what makes line "positive_namespace" meaningful after
    // projection, and keeps the raw ancestry rejection below exercised.
    assert.equal(main.exe, "/bin/unshare");
    assert.throws(() => assertHostedFdNamespaceAncestry(argv, rows, pid), /hosted_fd_namespace_stage_unresolved/);
    stage = "positive_image"; const images = readHostedFdRecipeImages(rows, pins, root, remaining);
    stage = "positive_namespace"; assertHostedFdNamespaceAncestry(argv, images.processes, pid);
    stage = "positive_revalidate"; images.revalidate(); stage = "positive_raw_rejoin"; assert.equal(main.exe, "/bin/unshare");
    stage = "positive_maps"; const expected = JSON.parse(readFileSync("/TEST-node-map-input.json", "utf8")) as string[], leaf = rows.find(row => row.argv[0] === process.execPath)!;
    const observed = maps(leaf.pid), libraries = expected.filter(path => path !== process.execPath);
    process.stdout.write("TEST-node-maps " + JSON.stringify({ schemaVersion: 1, exactNode: observed.includes(process.execPath), aliasNode: observed.includes(root + process.execPath),
      exactLibraries: libraries.filter(path => observed.includes(path)).length, aliasLibraries: libraries.filter(path => observed.includes(root + path)).length,
      otherFiles: observed.filter(path => !expected.includes(path) && !expected.some(source => path === root + source)).length }) + "\n");
  });
  stage = "foreign_bind"; const foreign = "/TEST-identical-unshare"; writeFileSync(foreign, readFileSync("/usr/bin/unshare"), { flag: "wx", mode: 0o755 });
  // The positive child moved the whole image subtree into its private mount
  // namespace, taking the runtime binds with it. Rebuild the image mount root
  // and runtime binds so the foreign bind attaches inside the new /usr bind
  // and travels with the negative child's moved subtree.
  command("/usr/bin/mount", ["--bind", root, root], "mount_bind");
  runtime(root);
  bind(foreign, root + "/usr/bin/unshare", false);
  // A new owned child inherits this mount. Changing the observer's private
  // mount tree cannot retroactively alter the first child's private mount tree.
  await withChild(true, (rows, pid) => {
    stage = "negative_image";
    assert.throws(() => { const images = readHostedFdRecipeImages(rows, pins, root, remaining); assertHostedFdNamespaceAncestry(argv, images.processes, pid); }, /hosted_fd_namespace_stage_unresolved/);
  });
} else throw Error("TEST unknown fixed mode");

}
try { await main(); } catch (error) { process.stderr.write(failurePrefix + JSON.stringify(nestedFailure ?? failure(error)) + "\n"); process.exitCode = 1; }
