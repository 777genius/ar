import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ProbeInventory, ProbeAdmission, ProbeBranch, ProbeMaterialization, ProbeCustody, ProbePrefix, ProbeStep, NativeProbeKind, NativeProbeProfile, intersectCutoffs, validateOriginalAttempt, type NativeProbeAllocation } from "../../src/worker-core/hosted-custody/domain/native-probe.js";
import { decodeNativeProbeRequest, readNativeProbeRequest } from "../../src/hosted-native-probe/protocol.js";
const client = process.env.NP_CLIENT, fixtures = process.env.NP_FIXTURES;
assert.ok(client && fixtures, "run through the owned source contract harness");
const exec = promisify(execFile);
function decode(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function native(...args: string[]): Promise<Record<string, unknown>> {
  const result = await exec(client!, args, { timeout: 5000, maxBuffer: 8192 });
  return decode(result.stdout.trim());
}
async function fixture(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(fixtures!, "disposable-"));
  try { await mkdir(join(root, "staging"), { mode: 0o700 }); await mkdir(join(root, "units"), { mode: 0o700 }); await body(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function observedNumber(value: unknown): number { assert.ok(typeof value === "number" && Number.isSafeInteger(value)); return value; }
async function publication(mode: string, root: string, inspect: (facts: Record<string, unknown>, child: ChildProcessWithoutNullStreams) => Promise<string>): Promise<Record<string, unknown>> {
  const child = spawn(client!, [mode, root], { stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(5000) });
  let errors = ""; child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const exited = new Promise<void>((accept, reject) => { child.once("error", reject); child.once("close", code => code === 0 ? accept() : reject(new Error(`owned native client failed ${code}: ${errors}`))); });
  const lines = createInterface({ input: child.stdout }); const iterator = lines[Symbol.asyncIterator]();
  try {
    const first = await iterator.next(); assert.equal(first.done, false);
    const command = await inspect(decode(first.value!), child); child.stdin.end(command);
    const last = await iterator.next(); assert.equal(last.done, false); const result = decode(last.value!);
    await exited; return result;
  } finally { child.stdin.end("x"); lines.close(); await exited; }
}
const locator = "a".repeat(64), target = `subscription-runtime-retain-${locator}.target`, staged = `.native-probe-${locator}.stage`;
const expected = `[Unit]\nDescription=Subscription Runtime retained resource\nDefaultDependencies=no\nRequires=subscription-runtime-hosted-${locator}.slice\nAfter=subscription-runtime-hosted-${locator}.slice\nStopWhenUnneeded=no\n`;

// Red: SO_PEERCRED-only authentication or an open parent sending-end copy
// accepts forged topology. This executes the actual receiver against the same live birth across a single fixed exec.
test("real inherited seqpacket accepts the original live helper only", async () => {
  assert.deepEqual(await native("channel", "valid"), { accepted: true, secondRejected: false, lost: false, live: true, sequence: 1 });
});
// Red: a foreign descendant's automatic kernel credentials are accepted merely
// because it inherited a fault-fixture endpoint. Such a topology has no handoff.
test("foreign sender, duplicate sequence, truncation and rights close the channel", async () => {
  for (const mode of ["foreign", "rights", "truncated"]) {
    const facts = await native("channel", mode); assert.equal(facts.accepted, false, mode); assert.equal(facts.lost, true); assert.equal(facts.live, true);
  }
  const duplicate = await native("channel", "duplicate"); assert.equal(duplicate.accepted, true); assert.equal(duplicate.secondRejected, true); assert.equal(duplicate.sequence, 1);
});
// Red: explicit credentials attribute a capability-free fixture's message to
// another process. This checks real sendmsg kernel rejection, before decoding.
test("kernel rejects explicit foreign PID credentials without capabilities", async () => {
  assert.deepEqual(await native("forgery"), { kernelRejected: true, error: 1 });
});
// Red: TSYNC silently excludes existing threads, unchecked clone3 creates a
// process, or the checked libc fallback cannot create an ordinary same-tgid thread.
test("actual synchronized filter covers existing and new libc threads", async () => {
  assert.deepEqual(await native("filter"), { clone3: true, fork: true, dup: true, fcntl: true, namespace: true, export: true, flags: true, existingThread: true, newThread: true });
  assert.deepEqual(await native("profile"), { refused: true });
});
// Red: a delayed observation creates a new receipt-time allowance. These are
// actual retained nsfs descriptors and original CLOCK_MONOTONIC samples.
test("common clock retains original issuance ends while observation delay is charged", async () => {
  const facts = await native("clock"); const anchor = BigInt(observedNumber(facts.anchor));
  assert.equal(BigInt(observedNumber(facts.preparationEnd)) - anchor, 120000000000n);
  assert.equal(BigInt(observedNumber(facts.cleanupEnd)) - anchor, 180000000000n);
  assert.ok(observedNumber(facts.elapsed) >= 15000000); assert.equal(facts.unchanged, true);
});
// Red: canonical bytes differ, rename replaces an existing leaf, durability is
// inferred from a pathname, or the native original inode is discarded on success.
test("native no-replace fragment publication retains the independently observed inode", async () => {
  await fixture(async root => {
    const result = await publication("publish", root, async facts => {
      assert.equal(facts.published, true); assert.equal(facts.stage, 8); assert.equal(facts.uncertain, false);
      const file = join(root, "units", target), stat = await lstat(file, { bigint: true });
      assert.equal(stat.ino, BigInt(observedNumber(facts.inode))); assert.equal(stat.dev, BigInt(observedNumber(facts.device)));
      assert.equal(await readFile(file, "utf8"), expected); assert.equal(Number(stat.mode & 0o777n), 0o644);
      await assert.rejects(lstat(join(root, "staging", staged)), { code: "ENOENT" }); return "x";
    });
    assert.deepEqual(result, { repeated: false, error: 114 });
  });
});
// Red: a preexisting final name is adopted or overwritten; an expired final
// boundary still creates a staged file. Check actual filesystem effects.
test("conflict and final-boundary expiry dispatch no publication", async () => {
  await fixture(async root => {
    const final = join(root, "units", target); await writeFile(final, "foreign\n"); const original = await lstat(final);
    await publication("publish", root, async facts => {
      assert.equal(facts.published, false); assert.equal(facts.stage, 0); assert.equal(facts.inode, 0);
      assert.equal((await lstat(final)).ino, original.ino); assert.equal(await readFile(final, "utf8"), "foreign\n");
      await assert.rejects(lstat(join(root, "staging", staged)), { code: "ENOENT" }); return "x";
    });
  });
  await fixture(async root => {
    await publication("expired", root, async facts => {
      assert.equal(facts.published, false); assert.equal(facts.stage, 0); assert.equal(facts.error, 110);
      await assert.rejects(lstat(join(root, "units", target)), { code: "ENOENT" });
      await assert.rejects(lstat(join(root, "staging", staged)), { code: "ENOENT" }); return "x";
    });
  });
});
// Red: the real RLIMIT_FSIZE short-write prefix loses its held inode, appears
// never-created, or a JOIN/repeated invocation repairs its bytes.
test("real partial write retains original custody and refuses a second publication", async () => {
  await fixture(async root => {
    const result = await publication("partial", root, async facts => {
      assert.equal(facts.published, false); assert.equal(facts.stage, 1); assert.equal(facts.uncertain, true);
      const path = join(root, "staging", staged), stat = await lstat(path, { bigint: true });
      assert.equal(stat.ino, BigInt(observedNumber(facts.inode))); assert.equal(stat.size, 128n); assert.equal(facts.size, 128);
      assert.equal(await readFile(path, "utf8"), expected.slice(0, 128)); await assert.rejects(lstat(join(root, "units", target)), { code: "ENOENT" }); return "x";
    });
    assert.deepEqual(result, { repeated: false, error: 114 }); assert.equal((await lstat(join(root, "staging", staged))).size, 128);
  });
});
// Red: a substituted name rebinds custody while the original inode remains held,
// or a symlink ancestor is admitted by lexical pathname checks.
test("replaced fragment and symlink ancestry refuse without adopting replacement", async () => {
  await fixture(async root => {
    let held = 0;
    const result = await publication("publish", root, async facts => {
      held = observedNumber(facts.inode); const replacement = join(root, "units", "replacement"); await writeFile(replacement, expected);
      await rename(replacement, join(root, "units", target)); assert.notEqual((await lstat(join(root, "units", target))).ino, held); return "v";
    });
    assert.deepEqual(result, { verified: false, inode: held, links: 0 });
  });
  await fixture(async root => {
    await rm(join(root, "staging"), { recursive: true }); await symlink(join(root, "units"), join(root, "staging"));
    assert.deepEqual(await native("symlink", root), { refused: true });
  });
});

function allocation(targets = 1): NativeProbeAllocation {
  return {
    version: 1, kind: NativeProbeKind.NativeProbe, profile: NativeProbeProfile.OriginalFoundationV1,
    jobId: "disposable", machineId: "0".repeat(32), installationDigest: "1".repeat(64), profileDigest: "2".repeat(64), manifestDigest: "3".repeat(64),
    issuanceAnchorNs: "1000", preparationEndNs: "120000001000", absoluteCleanupEndNs: "180000001000", cleanupReservation: "original-reservation",
    declarations: [{ identity: "root", ordinal: 0, lifetime: "main", parent: null, workEndNs: "120000001000", cleanupEndNs: "180000001000" }, { identity: "future", ordinal: 1, lifetime: "later", parent: "root", workEndNs: "100000001000", cleanupEndNs: "150000001000" }],
    limits: { infrastructureTasks: 64, infrastructureThreads: 16, messages: 128, journalEntries: 256, declarations: 2, targets },
  };
}
// Red: unresolved rows disappear from zero-effect close, later materialization
// reopens creation, or repeated close changes its immutable identity. Policy only.
test("complete raw inventory survives close and late materialization", () => {
  const original = new ProbeInventory(allocation()); original.close("original-close"); original.materialize("future"); original.close("different-close");
  const rows = original.snapshot(); assert.equal(rows.length, 2); assert.equal(rows[0]?.materialization, ProbeMaterialization.AwaitingClosed);
  assert.equal(rows[1]?.creationAdmission, ProbeAdmission.Closed); assert.equal(rows[1]?.closeIdentity, "original-close"); assert.equal(rows[1]?.debt, true);
  assert.throws(() => original.select("future", ProbeBranch.Prepare, "operation", "intent", 2000n));
});
// Red: a resource step precedes its durable intent/obligation or a lost original
// outcome can be retried. This checks finite bookkeeping, never native authority.
test("finite policy retains lost prefixes and joins without new dispatch", () => {
  const original = new ProbeInventory(allocation()); original.materialize("root"); original.select("root", ProbeBranch.Prepare, "operation", "intent", 2000n);
  assert.throws(() => original.dispatch("root", ProbeStep.TargetStart, 2100n));
  original.dispatch("root", ProbeStep.Intent, 2100n); original.observe("root", ProbeStep.Intent, ProbePrefix.Retained, 2200n);
  original.dispatch("root", ProbeStep.Obligation, 2300n); original.observe("root", ProbeStep.Obligation, ProbePrefix.Uncertain, 2400n);
  const before = original.snapshot(); assert.deepEqual(original.snapshot(), before); assert.equal(before[0]?.prefixes[ProbeStep.Obligation], ProbePrefix.Uncertain);
  assert.throws(() => original.dispatch("root", ProbeStep.Subscribe, 2500n));
});

// Red: a successful in-flight descriptor reply restores Retained after owner
// loss. Ordinary closure with live custody must still retain that acquisition.
for (const step of [ProbeStep.Directory, ProbeStep.Events]) for (const lost of [true, false]) {
  test(`${step} in-flight success preserves ${lost ? "owner loss" : "live closed custody"}`, () => {
    const original = new ProbeInventory(allocation()); original.materialize("root"); original.select("root", ProbeBranch.Prepare, "operation", "intent", 2000n);
    const predecessors: ProbeStep[] = [ProbeStep.Intent, ProbeStep.Obligation, ProbeStep.Subscribe, ProbeStep.SliceStart, ProbeStep.SliceReference];
    if (step === ProbeStep.Events) predecessors.push(ProbeStep.Directory);
    let now = 2100n;
    for (const predecessor of predecessors) { original.dispatch("root", predecessor, now++); original.observe("root", predecessor, ProbePrefix.Retained, now++); }
    original.dispatch("root", step, now++); original.close("original-close", lost);
    original.observe("root", step, ProbePrefix.Retained, now++); original.close("replacement-close");
    const row = original.snapshot()[0]!;
    assert.equal(original.admission, lost ? ProbeAdmission.Lost : ProbeAdmission.Closed);
    assert.equal(row.directory, lost ? ProbeCustody.Lost : ProbeCustody.Retained);
    assert.equal(row.events, step === ProbeStep.Events ? (lost ? ProbeCustody.Lost : ProbeCustody.Retained) : ProbeCustody.NeverAcquired);
    assert.equal(row.prefixes[step], ProbePrefix.Retained); assert.equal(row.closeIdentity, "original-close"); assert.equal(row.debt, true);
    assert.throws(() => original.dispatch("root", ProbeStep.StageCreate, now));
  });
}

// Red: two distinct Prepare reservations fit an immutable one-target capacity,
// or exhaustion drops a declaration/debt or associates the refused operation.
test("first Prepare reservation consumes target capacity before any dispatch", () => {
  const original = new ProbeInventory(allocation()); original.materialize("root"); original.materialize("future");
  original.select("root", ProbeBranch.Prepare, "operation-root", "intent-root", 2000n);
  assert.throws(() => original.select("future", ProbeBranch.Prepare, "operation-future", "intent-future", 2100n), /target capacity/);
  const rows = original.snapshot(); assert.equal(original.admission, ProbeAdmission.Closed);
  assert.deepEqual(rows.map(row => row.identity), ["root", "future"]);
  assert.deepEqual(original.allocation.declarations.map(row => [row.identity, row.parent, row.ordinal]), [["root", null, 0], ["future", "root", 1]]);
  assert.equal(rows[0]?.operationIdentity, "operation-root"); assert.equal(rows[1]?.branch, ProbeBranch.Unselected);
  assert.equal(rows[1]?.operationIdentity, null); assert.equal(rows[1]?.intentIdentity, null);
  for (const row of rows) { assert.equal(row.creationAdmission, ProbeAdmission.Closed); assert.equal(row.closeIdentity, "target-capacity-exhausted"); assert.equal(row.debt, true); assert.equal(row.prefixes[ProbeStep.Intent], ProbePrefix.Unsent); }
});

// Red: completing the first Prepare or observational reads recycle its consumed
// slot, admitting a second target while the original allocation allows only one.
test("completed preparation and observation do not recycle target capacity", () => {
  const original = new ProbeInventory(allocation()); original.materialize("root"); original.select("root", ProbeBranch.Prepare, "operation-root", "intent-root", 2000n);
  let now = 2100n;
  for (const step of Object.values(ProbeStep)) { original.dispatch("root", step, now++); original.observe("root", step, ProbePrefix.Retained, now++); }
  const completed = original.snapshot(); assert.equal(completed[0]?.prefixes[ProbeStep.Transfer], ProbePrefix.Retained);
  assert.equal(original.admission, ProbeAdmission.Open); assert.deepEqual(original.snapshot(), completed);
  original.materialize("future");
  assert.throws(() => original.select("future", ProbeBranch.Prepare, "operation-future", "intent-future", now), /target capacity/);
  assert.equal(original.allocation.limits.targets, 1); assert.equal(original.snapshot()[0]?.prefixes[ProbeStep.Transfer], ProbePrefix.Retained);
  assert.equal(original.snapshot()[0]?.directory, ProbeCustody.Retained); assert.equal(original.snapshot()[0]?.events, ProbeCustody.Retained);
});

// Red: rejected branch admission or the zero-only Declared branch consumes a
// target slot, or an inventory with an admitted two-target capacity still refuses.
test("target reservations respect branch admission and the admitted capacity", () => {
  const original = new ProbeInventory(allocation()); original.materialize("root"); original.materialize("future");
  assert.throws(() => original.select("root", ProbeBranch.Prepare, "operation-root", "", 2000n));
  original.select("root", ProbeBranch.Declared, "operation-root", "intent-root", 2100n);
  original.select("future", ProbeBranch.Prepare, "operation-future", "intent-future", 2200n);
  assert.equal(original.snapshot()[0]?.creationAdmission, ProbeAdmission.Closed); assert.equal(original.snapshot()[1]?.branch, ProbeBranch.Prepare);
  const twoTargets = new ProbeInventory(allocation(2)); twoTargets.materialize("root"); twoTargets.materialize("future");
  twoTargets.select("root", ProbeBranch.Prepare, "operation-root", "intent-root", 2000n);
  twoTargets.select("future", ProbeBranch.Prepare, "operation-future", "intent-future", 2100n);
  assert.equal(twoTargets.admission, ProbeAdmission.Open); assert.deepEqual(twoTargets.snapshot().map(row => row.branch), [ProbeBranch.Prepare, ProbeBranch.Prepare]);
});
// Red: tighter operational restrictions rewrite the immutable V2 end or JOIN
// extends cutoffs. Expected times are literal independent test data.
test("original attempt formula remains separate from effective native cutoffs", () => {
  const attempt = { reservation: "original-reservation", originalCleanupDeadlineEpochMs: 180000, originalAttemptAllowanceMs: 60000, original: { originalAuthorityDigest: "4".repeat(64), attemptId: "11111111-1111-1111-1111-111111111111", startedAtEpochMs: 2000, endEpochMs: 62000, joinDigest: "5".repeat(64) } };
  validateOriginalAttempt(attempt); assert.throws(() => validateOriginalAttempt({ ...attempt, original: { ...attempt.original, endEpochMs: 5000 } }));
  const cutoffs = intersectCutoffs({ preparationNs: "120000001000", cleanupNs: "60000002000", observationNs: "180000001000" }, { preparationNs: "4000", cleanupNs: "5000", observationNs: "6000" });
  assert.deepEqual(cutoffs, { preparationNs: "4000", cleanupNs: "5000", observationNs: "6000" }); assert.equal(attempt.original.endEpochMs, 62000);
});

// Red: the exact formula admits a literal 60001 ms original allowance. Refusal
// must leave the original attempt slot available for the unchanged 60000 ms bound.
test("original attempt allowance refuses 60001 and preserves 60000 exactly", () => {
  const attempt = { reservation: "original-reservation", originalCleanupDeadlineEpochMs: 180000, originalAttemptAllowanceMs: 60000, original: { originalAuthorityDigest: "4".repeat(64), attemptId: "11111111-1111-1111-1111-111111111111", startedAtEpochMs: 2000, endEpochMs: 62000, joinDigest: "5".repeat(64) } };
  const oversized = { ...attempt, originalAttemptAllowanceMs: 60001, original: { ...attempt.original, endEpochMs: 62001 } };
  assert.throws(() => validateOriginalAttempt(oversized), /allowance exceeds profile/);
  const original = new ProbeInventory(allocation()); assert.throws(() => original.associateAttempt("root", oversized));
  assert.equal(original.snapshot()[0]?.attempt, null); validateOriginalAttempt(attempt); original.associateAttempt("root", attempt);
  original.tighten("root", { preparationNs: "4000", cleanupNs: "5000", observationNs: "6000" });
  assert.deepEqual(original.snapshot()[0]?.attempt, attempt); assert.equal(original.snapshot()[0]?.attempt?.originalAttemptAllowanceMs, 60000);
  assert.equal(original.snapshot()[0]?.attempt?.original.endEpochMs, 62000); assert.equal(oversized.original.endEpochMs, 62001);
});

// Red: mutation of caller-owned allocation data replaces the original cleanup
// reservation or capacity after admission. It must not change subsequent joins.
test("caller data mutation cannot replace original allocation or cleanup reservation", () => {
  const input = { ...allocation(), limits: { ...allocation().limits }, declarations: allocation().declarations.map(row => ({ ...row })) };
  const original = new ProbeInventory(input); input.cleanupReservation = "replacement"; input.limits.messages = 65536; input.declarations[0]!.workEndNs = "180000001000";
  assert.equal(original.allocation.cleanupReservation, "original-reservation"); assert.equal(original.allocation.limits.messages, 128);
  assert.throws(() => original.associateAttempt("root", { reservation: "replacement", originalCleanupDeadlineEpochMs: 180000, originalAttemptAllowanceMs: 60000, original: { originalAuthorityDigest: "4".repeat(64), attemptId: "11111111-1111-1111-1111-111111111111", startedAtEpochMs: 2000, endEpochMs: 62000, joinDigest: "5".repeat(64) } }));
});

// Red: idle bootstrap identity, caller commands/FDs/budgets or duplicate wire
// fields, noncanonical encoding/LF, invalid field types or oversized identifiers
// are accepted as a NativeProbe request. This checks decoding, not authority.
test("NativeProbe ingress data grammar excludes bootstrap and all effect selectors", () => {
  const request = { allocationDigest: "a".repeat(64), jobId: "disposable", kind: "NativeProbe", machineId: "0".repeat(32), operation: "status" };
  const bytes = '{"allocationDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","jobId":"disposable","kind":"NativeProbe","machineId":"00000000000000000000000000000000","operation":"status"}';
  assert.deepEqual(readNativeProbeRequest(bytes), request);
  assert.equal(Object.isFrozen(readNativeProbeRequest(bytes)), true);
  // Red: parser diagnostics include private caller DATA or preserve its cause.
  const privateMarker = "private-test-json-marker";
  assert.throws(() => readNativeProbeRequest(`{"${privateMarker}":`), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "Error");
    assert.equal(error.message, "invalid NativeProbe request JSON");
    assert.equal("cause" in error, false);
    assert.equal(String(error).includes(privateMarker), false);
    assert.equal(error.stack?.includes(privateMarker) ?? false, false);
    return true;
  });
  assert.throws(() => readNativeProbeRequest("é".repeat(32769)), /capacity exceeded/);
  for (const malformed of [bytes + "\n", " " + bytes, bytes.replace(':"status"', ': "status"'), bytes.replace('"jobId"', '"job\\u0049d"'), bytes.replace('"jobId":"disposable"', '"jobId":"disposable","job\\u0049d":"disposable"'), bytes.slice(0, -1), "[]", "null", " ".repeat(65537)]) assert.throws(() => readNativeProbeRequest(malformed));
  for (const jobId of ["", "Upper", "1start", "under_score", "a".repeat(33), "a".repeat(49), 1, null]) assert.throws(() => decodeNativeProbeRequest({ ...request, jobId }));
  for (const allocationDigest of ["A".repeat(64), "a".repeat(63), 1, null]) assert.throws(() => decodeNativeProbeRequest({ ...request, allocationDigest }));
  for (const machineId of ["A".repeat(32), "0".repeat(31), 1, null]) assert.throws(() => decodeNativeProbeRequest({ ...request, machineId }));
  for (const operation of ["prepare", "STATUS", 1, null]) assert.throws(() => decodeNativeProbeRequest({ ...request, operation }));
  for (const kind of ["ControllerQualification", 1, null]) assert.throws(() => decodeNativeProbeRequest({ ...request, kind }));
  for (const operation of ["start", "status", "stop"]) assert.equal(readNativeProbeRequest(bytes.replace('"operation":"status"', `"operation":"${operation}"`)).operation, operation);
  assert.equal(decodeNativeProbeRequest({ ...request, jobId: "a".repeat(32) }).jobId.length, 32);
  for (const field of ["argv", "environment", "fd", "pid", "manager", "path", "unit", "declarations", "budget"]) assert.throws(() => decodeNativeProbeRequest({ ...request, [field]: "caller-controlled" }));
  assert.throws(() => decodeNativeProbeRequest({ ...request, kind: "NativeTestBootstrap" }));
  assert.throws(() => readNativeProbeRequest(bytes.replace('"operation":"status"', '"operation":"status","operation":"status"')));
});

// Red: real Node worker/V8 or libuv setup fails under the admitted thread filter,
// or existing/new Node threads can still fork or export the inherited endpoint.
// A ring acquired before sealing also makes natural Node/libuv shutdown fail;
// all three ring syscalls must refuse before exec and on every probed thread.
// This uses the actual production filter and one genuine native-parent channel;
// it does not attest the unavailable fixed UID/capability/installed Source profile.
test("real Node threads operate under TSYNC and refuse process/endpoint escape", async () => {
  const script = process.env.NP_NODE_SCRIPT, addon = process.env.NP_NODE_ADDON; assert.ok(script && addon);
  const facts = await native("node-contract", process.execPath, script, addon);
  assert.equal(facts.node, process.version); assert.ok(observedNumber(facts.originalThreads) >= 3);
  assert.equal(facts.tsync, true); assert.equal(facts.existingWorker, true); assert.equal(facts.freshWorker, true);
  assert.equal(facts.libuvPool, true); assert.equal(facts.endpointRetained, true);
  assert.equal(facts.ioUringRefused, true); assert.equal(facts.ioUringCustodyAbsent, true);
});

// Red: ordinary files with kernel-property names are mistaken for an owned
// delegated cgroup-v2 resource. This tests actual filesystem-type refusal only.
test("lookalike cgroup files cannot create a retained resource view", async () => {
  await fixture(async root => {
    await writeFile(join(root, "cgroup.controllers"), "cpu pids\n");
    await writeFile(join(root, "cgroup.subtree_control"), "cpu pids\n");
    await writeFile(join(root, "cpu.weight"), "100\n");
    await writeFile(join(root, "cgroup.events"), "populated 0\n");
    assert.deepEqual(await native("resource-refusal", root), { refused: true, originalDescriptorRetained: true, resourceExposed: false });
    assert.equal(await readFile(join(root, "cgroup.events"), "utf8"), "populated 0\n");
  });
});

// Red: matching namespace/UID or a supplied original PID substitutes for the
// actual private stream peer, allowing any authentication or manager traffic.
// A real owned stream has a different kernel peer birth and must remain silent.
test("private manager connection refuses a foreign kernel peer before traffic", async () => {
  assert.deepEqual(await native("manager-refusal"), { refused: true, noAuthenticationTraffic: true, originalSocketRetained: true, managerBirthLive: true });
});

// Red: later association consumes a new, otherwise valid attempt with the same
// reservation. Original consumption must survive unresolved close and late Target
// association without renewing its identity, start, allowance or exact V2 end.
test("late declaration association cannot renew the original consumed attempt", () => {
  const original = new ProbeInventory(allocation());
  const attempt = { reservation: "original-reservation", originalCleanupDeadlineEpochMs: 180000, originalAttemptAllowanceMs: 60000, original: { originalAuthorityDigest: "4".repeat(64), attemptId: "11111111-1111-1111-1111-111111111111", startedAtEpochMs: 2000, endEpochMs: 62000, joinDigest: "5".repeat(64) } };
  original.associateAttempt("root", attempt); original.close("original-close"); original.materialize("future");
  assert.throws(() => original.associateAttempt("future", { ...attempt, original: { ...attempt.original, attemptId: "22222222-2222-2222-2222-222222222222", startedAtEpochMs: 3000, endEpochMs: 63000 } }));
  original.associateAttempt("future", attempt);
  assert.deepEqual(original.snapshot()[1]?.attempt, attempt);
  assert.equal(original.snapshot()[1]?.closeIdentity, "original-close");
  assert.equal(original.snapshot()[1]?.creationAdmission, ProbeAdmission.Closed);
});

// Red: unavailable proc access to a nondumpable original child is skipped and
// matching PID/retained namespace metadata is accepted as renewed association.
// Actual descriptors and live birth survive the refusal; this deliberately
// leaves the committed immutable-seal Source handoff seam unqualified.
test("nondumpable original child retains custody while proc revalidation refuses", async () => {
  assert.deepEqual(await native("nondumpable"), { procRevalidationRefused: true, originalBirthLive: true, originalNamespacesRetained: true });
});
