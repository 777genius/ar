// Run ONLY in a fresh explicitly authorized NEW TEST private mount namespace.
// Compile this fixture and the actual production adapter together; no mocked host.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { prepareHostScratchCaches, prepareHostScratchTemp, resolveHostScratchTempRoot,
  resolvePreparedHostScratchBinds } from "../host-scratch-temp.js";

enum Phase { Initial = "initial", Prepared = "prepared", Covered = "covered", Rebound = "rebound", Refusals = "refusals", Complete = "complete" }
enum Step { Initial = "initial", PrepareInitial = "prepare-initial", ResolveInitial = "resolve-initial", ObservePrepared = "observe-prepared",
  CoverParent = "cover-parent", ObserveCovered = "observe-covered", PrepareCovered = "prepare-covered", ResolveCovered = "resolve-covered",
  CountCovered = "count-covered", ObserveRebound = "observe-rebound", PrepareIdempotent = "prepare-idempotent",
  RefusalUnknown = "refusal-unknown", RefusalNonempty = "refusal-nonempty", RefusalSourceIdentity = "refusal-source-identity", Complete = "complete" }
enum Observation { None = "none", SourceIdentity = "scratch-source-identity", Unspecified = "unspecified" }
let phase = Phase.Initial, failureStep = Step.Initial;
const deadline = performance.now() + 120000; // New unexecuted fixture; external unit must be bounded150s.
const observations: unknown[] = [];
let evidenceRoot: { path: string; dev: number; ino: number; namespace: string } | undefined;
function observation(error: unknown): Observation {
  // Intrinsic proxy/native-error checks avoid arbitrary getters or proxy traps.
  if (!error || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return Observation.Unspecified;
  const message = Object.getOwnPropertyDescriptor(error, "message");
  return message && "value" in message && message.value === "Prepared scratch source identity changed"
    ? Observation.SourceIdentity : Observation.Unspecified;
}
function deny(): never { throw new Error("NEW_TEST_scratch_visible_mount_denied"); }
function small(path: string, bound: number): string {
  const bytes = readFileSync(path); if (bytes.length > bound) return deny(); return bytes.toString();
}
function command(binary: string, args: string[]): string {
  const remaining = Math.floor(deadline - performance.now()); if (remaining <= 0) return deny();
  return execFileSync(binary, args, { encoding: "utf8", timeout: Math.min(2000, remaining), killSignal: "SIGKILL",
    maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function custody(path: string): void {
  for (let p = path;; p = dirname(p)) {
    const info = lstatSync(p);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || info.mode & 0o022 || realpathSync(p) !== p) deny();
    if (p === "/") return;
  }
}
function absent(path: string): void {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  deny();
}
function privateNamespace(): void {
  const rows = small("/proc/self/mountinfo", 8 * 1024 * 1024).trim().split("\n");
  if (rows.some(line => {
    const fields = line.split(" "), separator = fields.indexOf("-");
    return separator < 6 || fields.slice(6, separator).some(word => /^(shared|master|propagate_from):/.test(word));
  })) deny();
}
function named(path: string) {
  const fd = openSync(path, 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { return opened(fd); } finally { closeSync(fd); }
}
function opened(fd: number) {
  const s = fstatSync(fd), ids = [...small(`/proc/self/fdinfo/${fd}`, 4096).matchAll(/^mnt_id:\s+([1-9]\d*)$/gm)];
  if (!s.isDirectory() || ids.length !== 1) return deny();
  const mountId = Number(ids[0]![1]); if (!Number.isSafeInteger(mountId)) return deny();
  return { dev: s.dev, ino: s.ino, mountId };
}
try {
  const [root, selfDigest] = process.argv.slice(2), self = fileURLToPath(import.meta.url);
  const suffix = root && /^\/var\/lib\/subscription-runtime-new-test\/scratch-visible-mount-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(root)?.[1];
  if (process.argv.length !== 4 || !root || !suffix || !selfDigest || !/^[a-f0-9]{64}$/.test(selfDigest) || process.platform !== "linux" ||
      process.getuid?.() !== 0 || process.getgid?.() !== 0 || process.geteuid?.() !== 0 || process.getegid?.() !== 0) deny();
  for (const n of ["user", "pid", "net"]) if (readlinkSync(`/proc/self/ns/${n}`) !== readlinkSync(`/proc/1/ns/${n}`)) deny();
  const namespace = readlinkSync("/proc/self/ns/mnt");
  if (namespace === readlinkSync("/proc/1/ns/mnt")) deny();
  for (const map of ["uid", "gid"]) if (!/^0\s+0\s+4294967295$/.test(small(`/proc/self/${map}_map`, 256).trim())) deny();
  privateNamespace(); // BEFORE all fixture filesystem and mount effects.
  custody(dirname(root)); custody(dirname(self));
  const selfInfo = lstatSync(self);
  if (!selfInfo.isFile() || selfInfo.isSymbolicLink() || selfInfo.uid !== 0 || selfInfo.gid !== 0 || selfInfo.nlink !== 1 ||
      (selfInfo.mode & 0o7777) !== 0o600 || createHash("sha256").update(small(self, 128 * 1024)).digest("hex") !== selfDigest) deny();
  absent(root); mkdirSync(root, { mode: 0o700 });
  custody(root); const rootInfo = lstatSync(root);
  if ((rootInfo.mode & 0o7777) !== 0o700) deny();
  evidenceRoot = { path: root, dev: rootInfo.dev, ino: rootInfo.ino, namespace };
  const job = join(root, "job"), home = join(job, "home"), pin = join(root, "pin"), target = join(job, "tmp");
  for (const path of [job, home, pin]) mkdirSync(path, { mode: 0o700 });
  const layout = resolveHostScratchTempRoot(job);
  if (!layout || !/^\/srv\/workers\/runtime-tmp\/[a-f0-9]{64}$/.test(layout.source)) deny();
  const cacheTargets = [join(home, "plugins/cache"), join(home, "cache/remote_plugin_catalog")];
  const sources = [layout.source, ...cacheTargets.map(path => `/srv/workers/runtime-caches/${createHash("sha256").update(path).digest("hex")}`)];
  for (const source of sources) { custody(dirname(source)); absent(source); absent(`${source}.lock`); }
  function stable(): void {
    if (performance.now() >= deadline || readlinkSync("/proc/self/ns/mnt") !== namespace) deny();
    privateNamespace();
  }
  async function prepare(): Promise<void> {
    stable(); await prepareHostScratchTemp(job, {}); stable(); await prepareHostScratchCaches(home, {}); stable();
  }
  function observe() {
    stable(); const a = openSync(layout!.source, 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let b: number | undefined;
    try {
      b = openSync(target, 0x200000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const source = opened(a), mounted = opened(b);
      const raw: unknown = JSON.parse(command("/usr/bin/findmnt", ["--json", "--mountpoint", target, "--output", "ID,TARGET,UUID,FSROOT"]));
      if (!raw || typeof raw !== "object" || !("filesystems" in raw) || !Array.isArray(raw.filesystems)) deny();
      const rows = raw.filesystems.map((r: unknown) => {
        if (!r || typeof r !== "object" || !("id" in r) || !("target" in r) || !("uuid" in r) || !("fsroot" in r)) deny();
        const id = Number(r.id); if (!Number.isSafeInteger(id) || id <= 0) deny();
        return { id, exact: r.target === target, expected: r.uuid === layout!.uuid && r.fsroot === layout!.fsroot, visible: id === mounted.mountId };
      });
      for (const [fd, path] of [[a, layout!.source], [b, target]] as const) {
        const held = opened(fd), named = lstatSync(path);
        if (held.dev !== named.dev || held.ino !== named.ino) deny();
      }
      stable(); const equal = source.dev === mounted.dev && source.ino === mounted.ino;
      const value = { phase, source, target: mounted, equal, rows };
      observations.push(value); return value;
    } finally { if (b !== undefined) closeSync(b); closeSync(a); }
  }
  failureStep = Step.PrepareInitial; await prepare(); phase = Phase.Prepared;
  failureStep = Step.ResolveInitial; const initial = resolvePreparedHostScratchBinds(job, home); assert.equal(initial.length, 3);
  failureStep = Step.ObservePrepared; assert.equal(observe().equal, true);
  failureStep = Step.CoverParent; stable(); command("/usr/bin/mount", ["--bind", job, pin]); stable(); command("/usr/bin/mount", ["--bind", pin, job]);
  phase = Phase.Covered; failureStep = Step.ObserveCovered; const covered = observe();
  assert.equal(covered.equal, false); assert.equal(covered.rows.length, 1);
  assert.ok(covered.rows[0]?.exact && covered.rows[0].expected && !covered.rows[0].visible);
  // OLD RED: tuple-only preparation skips the hidden leaf; resolver rejects source identity.
  failureStep = Step.PrepareCovered; await prepare();
  failureStep = Step.ResolveCovered; const resolved = resolvePreparedHostScratchBinds(job, home);
  failureStep = Step.CountCovered; assert.equal(resolved.length, 3);
  phase = Phase.Rebound; failureStep = Step.ObserveRebound; const rebound = observe(); assert.equal(rebound.equal, true); assert.equal(rebound.rows.length, 2);
  assert.equal(rebound.rows.filter(r => r.visible && r.exact && r.expected).length, 1);
  failureStep = Step.PrepareIdempotent; await prepare(); assert.equal(observe().target.mountId, rebound.target.mountId);
  phase = Phase.Refusals;
  // Unknown visible mount and nonempty ordinary directory must retain their identities.
  for (const scenario of ["unknown", "nonempty"] as const) {
    failureStep = scenario === "unknown" ? Step.RefusalUnknown : Step.RefusalNonempty;
    const otherJob = join(root, `job-${scenario}`), otherTarget = join(otherJob, "tmp");
    mkdirSync(otherJob, { mode: 0o700 }); mkdirSync(otherTarget, { mode: 0o700 });
    const otherSource = resolveHostScratchTempRoot(otherJob)!.source;
    absent(otherSource); absent(`${otherSource}.lock`);
    if (scenario === "unknown") {
      const foreign = join(root, "foreign-owned-fixture"); mkdirSync(foreign, { mode: 0o700 });
      stable(); command("/usr/bin/mount", ["--bind", foreign, otherTarget]);
    } else writeFileSync(join(otherTarget, "NEW_TEST_marker"), "NEW_TEST\n", { flag: "wx", mode: 0o600 });
    const before = named(otherTarget);
    await assert.rejects(prepareHostScratchTemp(otherJob, {}), scenario === "unknown" ? /Unknown mount at scratch target/ : /Refusing to hide nonempty/);
    assert.deepEqual(named(otherTarget), before); absent(otherSource);
  }
  // A replaced physical source must not authorize repairing the valid old visible bind.
  failureStep = Step.RefusalSourceIdentity; stable(); const replacement = join(root, "physical-source-replacement"); mkdirSync(replacement, { mode: 0o701 });
  command("/usr/bin/mount", ["--bind", replacement, layout.source]);
  const before = observe().target;
  await assert.rejects(prepareHostScratchTemp(job, {}), /Prepared scratch source identity changed/);
  assert.throws(() => resolvePreparedHostScratchBinds(job, home), /Prepared scratch source identity changed/);
  const after = observe().target; assert.deepEqual(after, before);
  phase = Phase.Complete; failureStep = Step.Complete; stable();
  writeFileSync(join(root, "native-observation.json"), JSON.stringify({ schemaVersion: 1, result: "passed", phase, failureStep, observation: Observation.None, pid: process.pid, namespace, observations,
    realProductionAdapter: true, preparedCount: 3, refusalsPassed: true, providerStarted: false, accountUsed: false }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  // Retain only owned fixture directories/evidence; natural namespace exit releases its mounts.
} catch (error) {
  const category = observation(error);
  const diagnostic = { schemaVersion: 1, result: "failed", phase, failureStep, observation: category, observations,
    realProductionAdapter: true, providerStarted: false, accountUsed: false };
  // No evidence write on early namespace/custody refusal or an unowned/replaced root.
  try {
    if (evidenceRoot && performance.now() < deadline) {
      privateNamespace(); custody(evidenceRoot.path); const info = lstatSync(evidenceRoot.path);
      if (info.dev === evidenceRoot.dev && info.ino === evidenceRoot.ino && (info.mode & 0o7777) === 0o700 &&
          readlinkSync("/proc/self/ns/mnt") === evidenceRoot.namespace) {
        writeFileSync(join(evidenceRoot.path, "native-observation.json"), JSON.stringify({ ...diagnostic, pid: process.pid,
          namespace: evidenceRoot.namespace }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      }
    }
  } catch { /* Preserve the original refusal; never overwrite evidence. */ }
  process.stderr.write("NEW_TEST_scratch_visible_mount_denied\n" + JSON.stringify({ schemaVersion: 1, phase, failureStep, observation: category }) + "\n");
  process.exitCode = 70;
}
