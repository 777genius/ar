/** Read-only TEST telemetry, never Ready/baseline/drain/release authority. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { types } from "node:util";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { readHostedPrivateBytes } from "../../dist/worker-codex/hosted-readonly-inputs.js";
import { hostedDependencyInstallerRoot } from "../../dist/worker-codex/hosted-dependency-installer-recipe.js";
import { assertInstallerTerminalUnit } from "../../dist/worker-codex/hosted-dependency-installer-unit.js";
import { observeInstallerCgroupEmpty } from "../../dist/worker-codex/hosted-dependency-installer-cgroup.js";
import { collectJobs, withScopedCollectionBudget } from "../../dist/worker-codex/hosted-readonly-linux-collector.js";
import { parseScopedManagerJobs } from "../../dist/worker-codex/hosted-readonly-observations.js";
import { digest } from "./common.ts";
export enum NativeInstallerTraceState { Measured = "measured", Unknown = "unknown", NotInitialized = "not_initialized" }
export enum NativeInstallerUnitState { Observed = "observed", Pending = "pending", Missing = "missing", Unknown = "unknown" }
export enum FullContentCaptureMeasurement { Unavailable = "unavailable" }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>;
}
function read(path: string, max = 65536) {
  const bytes = readHostedPrivateBytes(path, max); assert(bytes); return { bytes, value: object(JSON.parse(bytes.toString("utf8"))) };
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
/** Pure finite parser. Duplicate/malformed/missing properties never count a
 * launch; neither messages, paths nor arbitrary systemd data are returned. */
export function parseNativeInstallerUnit(unit: string, text: string) {
  const unknown = { state: NativeInstallerUnitState.Unknown, invocationId: null } as const;
  if (typeof unit !== "string" || !/^subscription-runtime-installer-[a-f0-9-]{36}\.service$/.test(unit) ||
      typeof text !== "string" || Buffer.byteLength(text) > 4096) return unknown;
  const fields: Record<string, string> = {};
  for (const line of text.trimEnd().split("\n")) {
    const at = line.indexOf("="), key = line.slice(0, at);
    if (at < 1 || !["Id", "LoadState", "ActiveState", "InvocationID"].includes(key) || Object.hasOwn(fields, key)) return unknown;
    fields[key] = line.slice(at + 1);
  }
  if (Object.keys(fields).length !== 4 || fields.Id !== unit) return unknown;
  if (fields.LoadState === "not-found" && fields.InvocationID === "" && fields.ActiveState === "inactive")
    return { state: NativeInstallerUnitState.Missing, invocationId: null } as const;
  if (fields.LoadState === "loaded" && fields.InvocationID === "" && ["inactive", "activating"].includes(fields.ActiveState ?? ""))
    return { state: NativeInstallerUnitState.Pending, invocationId: null } as const;
  if (fields.LoadState !== "loaded" || !["active", "activating", "inactive", "deactivating", "failed"].includes(fields.ActiveState ?? "") ||
      !/^[a-f0-9]{32}$/.test(fields.InvocationID ?? "")) return unknown;
  return { state: NativeInstallerUnitState.Observed, invocationId: fields.InvocationID! } as const;
}
function nativeUnit(unit: string, timeoutMs: number) {
  const result = spawnSync("/usr/bin/systemctl", ["show", "--property=Id,LoadState,ActiveState,InvocationID", "--", unit],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" } });
  if (result.error || result.signal || result.status !== 0 && result.status !== 4)
    return { state: NativeInstallerUnitState.Unknown, invocationId: null } as const;
  return parseNativeInstallerUnit(unit, result.stdout);
}

/** Diagnostic reconciliation only: a sampled protected start cannot vanish,
 * change bytes, or count complete without an actual native invocation. */
export function retainedInstallerStartsComplete(seen: ReadonlyMap<string, string>,
    final: readonly { startId: string; startSha256: string; complete: boolean }[], native: ReadonlySet<string>, snapshotUncertain: boolean): boolean {
  return !snapshotUncertain && [...seen].every(([id, hash]) => final.some(row => row.startId === id && row.startSha256 === hash && row.complete) && native.has(id));
}
export enum NativeInstallerWorkspaceSelection { Selected = "selected", Foreign = "foreign", Unknown = "unknown" }
function workspaceFields(value: unknown) {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return null;
  const d = Object.getOwnPropertyDescriptors(value), path = d.canonicalPath?.value, dev = d.dev?.value, ino = d.ino?.value;
  if (Reflect.ownKeys(d).length !== 3 || Object.keys(d).sort().join(",") !== "canonicalPath,dev,ino" ||
      typeof path !== "string" || !/^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-[A-Za-z0-9_.-]{1,123}\/workspace$/.test(path) ||
      typeof dev !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(dev) || typeof ino !== "string" || !/^[1-9][0-9]{0,19}$/.test(ino)) return null;
  return { canonicalPath: path, dev, ino };
}
/** Closed physical scope selection is diagnostic only, never workspace authority. */
export function selectNativeInstallerWorkspace(value: unknown, expected: unknown): NativeInstallerWorkspaceSelection {
  const actual = workspaceFields(value), own = workspaceFields(expected);
  if (!actual || !own) return NativeInstallerWorkspaceSelection.Unknown;
  const samePath = actual.canonicalPath === own.canonicalPath, samePhysical = actual.dev === own.dev && actual.ino === own.ino;
  if (samePath && samePhysical) return NativeInstallerWorkspaceSelection.Selected;
  if (samePath || samePhysical) return NativeInstallerWorkspaceSelection.Unknown;
  return NativeInstallerWorkspaceSelection.Foreign;
}
type Start = { startId: string; unit: string; attemptId: string; directory: string; startBytes: Buffer; complete: boolean };
/** Snapshots ALL actual installer attempt leaves before selecting this physical
 * workspace. An orphan/unknown/new leaf cannot be silently skipped as count0. */
function starts(jobId: string): { initialized: boolean; rows: Start[] } {
  assert(typeof jobId === "string" && /^TEST-[A-Za-z0-9_.-]{1,123}$/.test(jobId));
  const binding = readHostedDependencyBinding(jobId); assert(binding && binding.version === 2);
  if (!existsSync(hostedDependencyInstallerRoot)) return { initialized: false, rows: [] };
  const before = lstatSync(hostedDependencyInstallerRoot); assert(before.isDirectory() && !before.isSymbolicLink() && before.uid === 0 &&
    before.gid === 0 && (before.mode & 0o7777) === 0o700);
  const names = readdirSync(hostedDependencyInstallerRoot).sort(); assert(names.length <= 4096);
  const directories = new Set<string>(), linked = new Set<string>(), rows: Start[] = [];
  for (const name of names) {
    if (uuid.test(name)) { directories.add(name); continue; }
    const match = /^attempt-([a-f0-9-]{36})\.json$/.exec(name); assert(match && uuid.test(match[1]!));
    const leaf = read(hostedDependencyInstallerRoot + "/" + name, 4096), attempt = object(leaf.value.attempt);
    assert(leaf.value.schemaVersion === 1 && attempt.attemptId === match[1] && typeof leaf.value.startId === "string" && uuid.test(leaf.value.startId));
    const startId = leaf.value.startId, unit = "subscription-runtime-installer-" + startId + ".service";
    assert.equal(leaf.value.unit, unit); assert(!linked.has(startId)); linked.add(startId);
    const directory = hostedDependencyInstallerRoot + "/" + startId, start = read(directory + "/start.json"), value = start.value;
    assert((value.schemaVersion === 1 || value.schemaVersion === 2) && value.startId === startId && value.unit === unit);
    assert.deepEqual(value.attempt, attempt);
    const workspace = object(value.workspace), launch = object(attempt.launch);
    const consumed = read(directory + "/consumed.json", 4096);
    assert(consumed.bytes.equals(encode({ schemaVersion: 1, startId, startSha256: digest(start.bytes) })));
    const selected = selectNativeInstallerWorkspace(workspace, binding.workspace);
    assert.notEqual(selected, NativeInstallerWorkspaceSelection.Unknown);
    if (selected === NativeInstallerWorkspaceSelection.Foreign) continue;
    assert(launch.installationId === binding.installationId && launch.runtimeSha === binding.runtimeSha);
    const completionBytes = readHostedPrivateBytes(directory + "/creator-completion.json", 4096);
    let complete = false;
    if (completionBytes) {
      const creator = read(directory + "/creator.json", 4096), creatorValue = creator.value;
      assert(creatorValue.schemaVersion === 1 && creatorValue.startId === startId && creatorValue.startSha256 === digest(start.bytes) &&
        typeof creatorValue.pidBirth === "string" && /^[1-9]\d*:[1-9]\d*$/.test(creatorValue.pidBirth) &&
        typeof creatorValue.controlGroup === "string" && creatorValue.controlGroup === "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + launch.unit);
      assert(completionBytes.equals(encode({ schemaVersion: 1, startId, startSha256: digest(start.bytes), creatorSha256: digest(creator.bytes), status: 0, creatorWaitReturned: true })));
      const revoked = read(directory + "/revoked.json", 4096), terminal = read(directory + "/terminal.json", 4096);
      assert(revoked.bytes.equals(encode({ schemaVersion: 1, startId, completionSha256: digest(completionBytes) })));
      assert(terminal.value.schemaVersion === 1 && terminal.value.startId === startId && terminal.value.completionSha256 === digest(completionBytes) &&
        typeof terminal.value.emptySha256 === "string" && hex.test(terminal.value.emptySha256));
      const output = object(terminal.value.output); assert(typeof output.dev === "string" && /^\d+$/.test(output.dev) && typeof output.ino === "string" && /^[1-9]\d*$/.test(output.ino));
      complete = true;
    }
    rows.push({ startId, unit, attemptId: match[1]!, directory, startBytes: start.bytes, complete });
  }
  assert.deepEqual([...directories].sort(), [...linked].sort());
  const after = lstatSync(hostedDependencyInstallerRoot);
  assert(after.dev === before.dev && after.ino === before.ino && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs);
  assert.deepEqual(readdirSync(hostedDependencyInstallerRoot).sort(), names);
  return { initialized: true, rows };
}
/** Start BEFORE the real ordinary cold route. The private diagnostic map only
 * retains actual native InvocationIDs; it never fences, launches or releases.
 * Missing sampled invocation or incomplete original chain => Unknown, never0. */
export function startNativeInstallerTrace(jobId: string, maximumMs: number) {
  assert(Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 27 * 60 * 1000);
  // Private before-effect window scope excludes authenticated historical starts,
  // never a caller-provided subset. Preserve their exact bytes through finish.
  const initial = starts(jobId), prior = new Map(initial.rows.map(row => [row.startId, digest(row.startBytes)] as const));
  assert(initial.rows.every(row => row.complete));
  const deadline = performance.now() + maximumMs, observed = new Map<string, string>(), seen = new Map<string, string>(); let uncertain = false, stopped = false;
  const remaining = (minimumMs = 1) => {
    const ms = Math.floor(deadline - performance.now()); assert(ms >= minimumMs); return ms;
  };
  const poll = () => {
    if (stopped) return;
    if (performance.now() >= deadline) { uncertain = true; return; }
    try {
      const rows = starts(jobId).rows;
      for (const row of rows) {
        if (prior.has(row.startId)) continue;
        const hash = digest(row.startBytes), previous = seen.get(row.startId);
        if (previous !== undefined && previous !== hash) uncertain = true;
        if (previous === undefined) seen.set(row.startId, hash);
      }
      for (const row of rows) {
        if (prior.has(row.startId)) continue;
        const remainingMs = Math.floor(deadline - performance.now());
        if (remainingMs <= 0) { uncertain = true; return; }
        const native = nativeUnit(row.unit, Math.min(5000, remainingMs));
        if (performance.now() >= deadline) { uncertain = true; return; }
        if (native.state === NativeInstallerUnitState.Observed) {
          const prior = observed.get(row.startId); if (prior !== undefined && prior !== native.invocationId) uncertain = true;
          observed.set(row.startId, native.invocationId);
        } else if (native.state === NativeInstallerUnitState.Unknown) uncertain = true;
      }
    } catch { uncertain = true; /* A partial or unreadable snapshot can never become count0. */ }
  };
  poll(); const timer = setInterval(poll, 500); timer.unref();
  return Object.freeze({
    finish() {
      assert(!stopped); poll(); stopped = true; clearInterval(timer);
      const unavailable = { fullContentCapture: { measurement: FullContentCaptureMeasurement.Unavailable, count: null } } as const;
      try {
        remaining(); const final = starts(jobId); remaining();
        if (!final.initialized) return { state: NativeInstallerTraceState.NotInitialized, launchedInstalls: null, completedInstalls: null, ...unavailable } as const;
        for (const [id, hash] of prior) assert(final.rows.some(row => row.startId === id && row.complete && digest(row.startBytes) === hash));
        assert(retainedInstallerStartsComplete(seen, final.rows.map(row => ({ startId: row.startId, startSha256: digest(row.startBytes), complete: row.complete })), new Set(observed.keys()), uncertain));
        const current = final.rows.filter(row => !prior.has(row.startId));
        if (uncertain || current.some(row => !row.complete || !observed.has(row.startId)))
          return { state: NativeInstallerTraceState.Unknown, launchedInstalls: null, completedInstalls: null, ...unavailable } as const;
        const invocations = new Set<string>();
        for (const row of current) {
          const id = observed.get(row.startId)!; assert(!invocations.has(id)); invocations.add(id);
          withScopedCollectionBudget(remaining(5000), () => assertInstallerTerminalUnit(row.unit)); remaining();
          const jobs = withScopedCollectionBudget(remaining(), () => collectJobs()); remaining();
          assert(!parseScopedManagerJobs(jobs).some(job => job.unit === row.unit));
          remaining(); observeInstallerCgroupEmpty("/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/" + row.unit); remaining();
        }
        const measured = { state: NativeInstallerTraceState.Measured, launchedInstalls: invocations.size, completedInstalls: current.length, excludedPriorStarts: prior.size,
          startIds: current.map(row => row.startId), invocationIds: [...invocations], ...unavailable } as const;
        remaining(); return measured;
      } catch { return { state: NativeInstallerTraceState.Unknown, launchedInstalls: null, completedInstalls: null, ...unavailable } as const; }
    },
  });
}
