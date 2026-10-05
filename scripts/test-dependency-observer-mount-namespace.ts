import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url), source = realpathSync(join(dirname(self), ".."));
const namespaces = ["user", "mnt", "pid"] as const;
const testFile = "src/worker-local/dependency-environment/tests/observe-dependency-tree.test.ts";
const required = [
  "vetoes same-device directory and file bind mounts",
  "rejects post-close same-inode file bind mount",
  "closes real fixture descriptors after capture and current success/refusal",
] as const;
const evidencePath = join(source, "observer-mount-evidence", "result.json");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function runnerId(value: string | undefined) {
  assert.match(value ?? "", /^[1-9][0-9]{0,9}$/);
  const id = Number(value); assert.ok(Number.isSafeInteger(id) && id < 4294967295); return id;
}
const pin = (fd: number) => { const s = fstatSync(fd, { bigint: true }); return `${s.dev}:${s.ino}`; };
function closeAll(fds: readonly number[]) {
  let failure: unknown;
  for (const fd of [...fds].reverse()) { try { closeSync(fd); } catch (error) { failure = error; } }
  if (failure !== undefined) throw failure;
}
function openNamespaces() {
  const fds: number[] = [];
  try { for (const name of namespaces) fds.push(openSync(`/proc/self/ns/${name}`, constants.O_RDONLY)); return fds; }
  catch (error) { closeAll(fds); throw error; }
}
const read = (path: string, limit: number) => {
  const s = lstatSync(path); assert.ok(s.isFile() && !s.isSymbolicLink() && s.size <= limit);
  const value = readFileSync(path); assert.ok(value.length <= limit); return value;
};
function mounts() {
  const text = readFileSync("/proc/self/mountinfo", "utf8"); assert.ok(text.length <= 1024 ** 2);
  return text.trim().split("\n").map(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    assert.ok(fields.length >= 10 && separator >= 6);
    return { point: fields[4]!.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8))),
      optional: fields.slice(6, separator), line };
  });
}
const publish = (value: Record<string, unknown>) => {
  mkdirSync(dirname(evidencePath), { recursive: true, mode: 0o755 });
  writeFileSync(evidencePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o644 });
};
const common: Record<string, unknown> = { version: 1, status: "failed", scope: "observer-mount-TEST-only",
  nativeG1Proven: false, writerExclusionProven: false, sourceSha: process.env.TEST_SOURCE_SHA ?? "",
  nodeVersion: process.versions.node, requiredTests: required };
try {
  assert.equal(process.platform, "linux"); assert.equal(process.env.CI, "true");
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.match(String(common.sourceSha), /^[a-f0-9]{40}$/);
  assert.equal(realpathSync(process.env.GITHUB_WORKSPACE ?? ""), source);
  assert.match(readFileSync("/etc/os-release", "utf8"), /VERSION_ID="24\.04"/);
  assert.match(process.versions.node, /^22\./);
  assert.equal(process.getuid?.(), 0); assert.equal(process.geteuid?.(), 0);
  const lockBytes = read(join(source, "package-lock.json"), 512 * 1024), lock: unknown = JSON.parse(lockBytes.toString("utf8"));
  assert.ok(object(lock) && object(lock.packages));
  const locked = lock.packages["node_modules/vitest"], installed: unknown = JSON.parse(read(join(source, "node_modules/vitest/package.json"), 65536).toString("utf8"));
  assert.ok(object(locked) && object(installed) && typeof locked.version === "string");
  assert.equal(installed.version, locked.version);
  common.lockSha256 = sha256(lockBytes); common.vitestVersion = locked.version;
  common.testSha256 = sha256(read(join(source, testFile), 65536));
  common.observerSha256 = sha256(read(join(source, "src/worker-local/dependency-environment/observe-dependency-tree.ts"), 65536));
  const parent = process.argv.length === 2;
  const uid = runnerId(process.env[parent ? "SUDO_UID" : "TEST_RUNNER_UID"]);
  const gid = runnerId(process.env[parent ? "SUDO_GID" : "TEST_RUNNER_GID"]);
  common.originalRunner = { uid, gid };
  const env = { PATH: "/usr/bin:/bin", CI: "true", GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: source,
    TEST_SOURCE_SHA: String(common.sourceSha), TEST_RUNNER_UID: String(uid), TEST_RUNNER_GID: String(gid), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  if (parent) {
    assert.match(readFileSync("/proc/self/uid_map", "utf8").trim(), /^0\s+0\s+4294967295$/);
    assert.equal(lstatSync(source).uid, uid, "checkout owner differs from genuine sudo caller");
    const ancestry: { path: string; uid: number; gid: number; mode: number }[] = [];
    for (let path = source; ; path = dirname(path)) {
      const info = lstatSync(path); assert.ok(info.isDirectory() && !info.isSymbolicLink() && ancestry.length < 64);
      ancestry.push({ path, uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 });
      if (path === dirname(path)) break;
    }
    common.parentSourceAncestry = ancestry;
    const root = realpathSync(mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP ?? ""), "observer-mount-TEST-")));
    chownSync(root, uid, gid); // Only the NEW private TEST root; never checkout/ancestor permissions.
    const targetRows = () => mounts().filter(row => row.point === root || row.point.startsWith(root + "/")).map(row => row.line);
    const beforeRows = targetRows(), fds = openNamespaces();
    const before = fds.map(pin);
    try {
      const run = spawnSync("/usr/bin/unshare", ["--user", "--map-root-user", "--mount", "--pid", "--fork",
        "--mount-proc", "--propagation", "private", "--kill-child=SIGKILL", "--", process.execPath,
        "--experimental-strip-types", self, "--inside", root], { cwd: source, env, uid, gid, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", ...fds], timeout: 180000, killSignal: "SIGKILL", maxBuffer: 1024 ** 2 });
      common.childStatus = run.status; common.childSignal = run.signal;
      if (run.error || run.status !== 0) { process.stderr.write((run.stderr ?? "").slice(0, 4096)); throw new Error("owned_namespace_or_required_TEST_failed"); }
      assert.deepEqual(fds.map(pin), before);
      for (const [index, name] of namespaces.entries()) {
        const fresh = openSync(`/proc/self/ns/${name}`, constants.O_RDONLY);
        try { assert.equal(pin(fresh), before[index]); } finally { closeSync(fresh); }
      }
      assert.deepEqual(targetRows(), beforeRows, "TEST mounts propagated into parent");
      const child: unknown = JSON.parse(read(evidencePath, 128 * 1024).toString("utf8"));
      assert.ok(object(child) && child.status === "passed" && child.sourceSha === common.sourceSha);
      publish({ ...child, parentSourceAncestry: ancestry, parentNamespacesBeforeAfter: before, parentTargetMountsUnchanged: true });
      rmSync(root, { recursive: true }); // Success only, after joined PID-namespace teardown.
    } finally { closeAll(fds); }
  } else {
    assert.equal(process.argv.length, 4); assert.equal(process.argv[2], "--inside");
    const root = realpathSync(process.argv[3]!); assert.ok(root.includes("/observer-mount-TEST-"));
    assert.equal(process.pid, 1); assert.match(readFileSync("/proc/self/uid_map", "utf8").trim(), new RegExp(`^0\\s+${uid}\\s+1$`));
    assert.match(readFileSync("/proc/self/gid_map", "utf8").trim(), new RegExp(`^0\\s+${gid}\\s+1$`));
    assert.equal(process.getgid?.(), 0); assert.equal(process.getegid?.(), 0);
    assert.deepEqual(process.getgroups?.(), [0], "unshare inherited supplementary groups"); // Node includes effective GID.
    assert.equal(lstatSync(source).uid, 0, "checkout owner was not mapped to namespace root");
    const original = namespaces.map((name, index) => {
      assert.match(readlinkSync(`/proc/self/fd/${index + 3}`), new RegExp(`^${name}:\\[[0-9]+\\]$`)); return pin(index + 3);
    });
    const owned = openNamespaces(), before = owned.map(pin);
    try {
      for (const [index, value] of before.entries()) assert.notEqual(value, original[index]);
      closeAll([3, 4, 5]); // Original namespace handles never reach Vitest.
      const privateMounts = () => assert.ok(mounts().every(row => row.optional.every(field =>
        !/^(?:shared|master|propagate_from):/.test(field))), "namespace propagation is not private");
      privateMounts(); mkdirSync(join(root, "tmp"), { mode: 0o700 }); mkdirSync(join(root, "home"), { mode: 0o700 });
      const reportPath = join(root, "vitest.json"), pattern = `(?:${required.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
      const run = spawnSync(process.execPath, [join(source, "node_modules/vitest/vitest.mjs"), "run", testFile,
        "--pool=forks", "--maxWorkers=1", "--testNamePattern", pattern, "--reporter=json", "--outputFile", reportPath],
      { cwd: source, env: { ...env, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), SUBSCRIPTION_RUNTIME_TEST_MOUNT_NAMESPACE: "1" },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, killSignal: "SIGKILL", maxBuffer: 1024 ** 2 });
      assert.ok(!run.error && run.status === 0, "actual focused Vitest did not pass");
      const bytes = read(reportPath, 128 * 1024), report: unknown = JSON.parse(bytes.toString("utf8"));
      assert.ok(object(report) && report.success === true && report.numPassedTests === required.length && report.numFailedTests === 0);
      assert.ok(Array.isArray(report.testResults) && report.testResults.length === 1);
      const file: unknown = report.testResults[0];
      assert.ok(object(file) && file.name === join(source, testFile) && Array.isArray(file.assertionResults) && file.assertionResults.length <= 128);
      for (const title of required) {
        const matches: unknown[] = file.assertionResults.filter((row: unknown) => object(row) && row.title === title);
        assert.equal(matches.length, 1, "required TEST missing or duplicated");
        assert.ok(object(matches[0]) && matches[0].status === "passed", "required TEST skipped/failed/todo");
      }
      privateMounts(); assert.deepEqual(owned.map(pin), before);
      for (const [index, name] of namespaces.entries()) {
        const fresh = openSync(`/proc/self/ns/${name}`, constants.O_RDONLY);
        try { assert.equal(pin(fresh), before[index]); } finally { closeSync(fresh); }
      }
      assert.equal(mounts().filter(row => row.point === root || row.point.startsWith(root + "/")).length, 0, "TEST mount survived cleanup");
      common.status = "passed"; common.originalNamespacePins = original; common.ownedNamespacesBeforeAfter = before;
      common.privatePropagationBeforeAfter = true; common.passedRequiredTests = required; common.vitestReportSha256 = sha256(bytes);
    } finally { closeAll(owned); }
    publish(common);
  }
} catch (error) {
  common.status = "failed"; common.errorName = error instanceof Error ? error.name : "Unknown";
  publish(common); process.exitCode = 1;
}
