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
function command(path: string, args: readonly string[]): string {
  const result = spawnSync(path, args, { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, "TEST fixed namespace setup command failed"); return result.stdout;
}
function directory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function bind(source: string, target: string, isDirectory: boolean): void {
  directory(dirname(target));
  if (isDirectory) directory(target); else if (!existsSync(target)) writeFileSync(target, "", { flag: "wx", mode: 0o600 });
  command("/usr/bin/mount", ["--bind", source, target]); command("/usr/bin/mount", ["-o", "remount,bind,ro", target]);
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
if (process.argv[2] === "--closure") {
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
    assert.equal(command(process.execPath, ["--input-type=module", "-e", imports]), "");
    process.stdout.write("TEST finite root closure complete\n");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else if (!process.argv[2]) {
  const available = process.platform === "linux" && process.getuid?.() === 0 && ["/usr/bin/unshare", "/usr/bin/tini", "/usr/bin/mount", "/usr/sbin/chroot"].every(existsSync);
  const probe = available ? spawnSync("/usr/bin/unshare", ["--mount", "--propagation=private", "--", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8", timeout: 5000 }) : undefined;
  if (!available || probe?.status !== 0) { process.stdout.write("TEST root namespace capability unavailable\n"); process.exitCode = 77; }
  else {
    const temp = mkdtempSync(join(tmpdir(), "TEST-wrapper-root-"));
    try {
      const result = spawnSync("/usr/bin/unshare", ["--mount", "--propagation=private", "--", process.execPath, self, "--setup", temp + "/outer"],
        { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 30000, maxBuffer: 4096 });
      assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, "TEST private RootDirectory probe failed");
      const suffix = "TEST owned RootDirectory image projection accepted\n";
      assert.ok(result.stdout.endsWith(suffix)); checkedMaps(result.stdout.slice(0, -suffix.length)); process.stdout.write(result.stdout);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
} else if (process.argv[2] === "--setup") {
  const outer = process.argv[3]!; directory(outer); runtime(outer);
  directory(outer + "/proc"); command("/usr/bin/mount", ["-t", "proc", "proc", outer + "/proc"]);
  for (const relative of leaves) bind(repo + "/dist/" + relative, outer + repo + "/dist/" + relative, false);
  bind(self, outer + self, false); directory(outer + repo);
  writeFileSync(outer + repo + "/package.json", '{"type":"module"}\n', { flag: "wx", mode: 0o600 });
  const expected = maps(process.pid); assert.ok(expected.length > 0 && expected.length <= 64);
  writeFileSync(outer + "/TEST-node-map-input.json", JSON.stringify(expected), { flag: "wx", mode: 0o600 });
  process.stdout.write(checkedMaps(command("/usr/sbin/chroot", [outer, process.execPath, self, "--observe"])));
  process.stdout.write("TEST owned RootDirectory image projection accepted\n");
} else if (process.argv[2] === "--observe") {
  directory(root); runtime(root); directory(root + "/proc");
  const argv = [...hostedFdNamespacePrefix, process.execPath, "-e", "process.stdout.write('TEST-ready\\n');process.stdin.resume()"];
  const pins = ["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini", "/usr/bin/systemd-run"].map(path => ({ path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), elfFiles: [] }));
  async function withChild(action: (rows: readonly HostedFdProcess[], pid: number) => void): Promise<void> {
    const child = spawn("/usr/sbin/chroot", [root, ...argv], { env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: "pipe" });
    const closed = once(child, "close"); const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      const first = await Promise.race([once(child.stdout, "data"), closed.then(() => { throw Error("TEST child closed before ready"); })]);
      assert.equal(String(first[0]), "TEST-ready\n");
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
      child.stdin.end(); const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  }
  const deadline = Date.now() + 10000, remaining = () => { const left = deadline - Date.now(); assert.ok(left > 0); return left; };
  await withChild((rows, pid) => {
    const main = rows.find(row => row.pid === pid)!; assert.equal(main.exe, root + "/usr/bin/unshare");
    assert.throws(() => assertHostedFdNamespaceAncestry(argv, rows, pid), /hosted_fd_namespace_stage_unresolved/);
    const images = readHostedFdRecipeImages(rows, pins, root, remaining);
    assertHostedFdNamespaceAncestry(argv, images.processes, pid); images.revalidate(); assert.equal(main.exe, root + "/usr/bin/unshare");
    const expected = JSON.parse(readFileSync("/TEST-node-map-input.json", "utf8")) as string[], leaf = rows.find(row => row.argv[0] === process.execPath)!;
    const observed = maps(leaf.pid), libraries = expected.filter(path => path !== process.execPath);
    process.stdout.write("TEST-node-maps " + JSON.stringify({ schemaVersion: 1, exactNode: observed.includes(process.execPath), aliasNode: observed.includes(root + process.execPath),
      exactLibraries: libraries.filter(path => observed.includes(path)).length, aliasLibraries: libraries.filter(path => observed.includes(root + path)).length,
      otherFiles: observed.filter(path => !expected.includes(path) && !expected.some(source => path === root + source)).length }) + "\n");
  });
  const foreign = "/TEST-identical-unshare"; writeFileSync(foreign, readFileSync("/usr/bin/unshare"), { flag: "wx", mode: 0o755 });
  bind(foreign, root + "/usr/bin/unshare", false);
  // A new owned child inherits this mount. Changing the observer's private
  // mount tree cannot retroactively alter the first child's private mount tree.
  await withChild((rows, pid) => {
    assert.throws(() => { const images = readHostedFdRecipeImages(rows, pins, root, remaining); assertHostedFdNamespaceAncestry(argv, images.processes, pid); }, /hosted_fd_namespace_stage_unresolved/);
  });
} else throw Error("TEST unknown fixed mode");
