import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedCommand } from "./newtest-bootstrap.mjs";

interface OriginalEnds { readonly timeNamespace: string; readonly workEndNs: bigint; readonly cleanupEndNs: bigint }
interface Reservation { readonly workNs: bigint; readonly cleanupNs: bigint }
interface LauncherContract {
  parseOriginalEnds(raw: string, namespace: string): OriginalEnds;
  parseLauncherArguments(args: readonly string[], namespace?: string): { request: unknown; ends: OriginalEnds | null };
  originalJobReservation(request: unknown): Reservation;
  assertOriginalReservation(ends: OriginalEnds, reservation: Reservation, anchor: bigint, now: bigint): void;
}
// Inspect the actual staged launcher; no fake builder/default admission is used.
const loaded: unknown = await import(new URL("../managed-launcher/launch.mjs", import.meta.url).href);
if (!loaded || typeof loaded !== "object" ||
    !("parseOriginalEnds" in loaded) || typeof loaded.parseOriginalEnds !== "function" ||
    !("parseLauncherArguments" in loaded) || typeof loaded.parseLauncherArguments !== "function" ||
    !("originalJobReservation" in loaded) || typeof loaded.originalJobReservation !== "function" ||
    !("assertOriginalReservation" in loaded) || typeof loaded.assertOriginalReservation !== "function") {
  throw new Error("missing staged original-ends contract");
}
const launcher = loaded as LauncherContract;
const namespace = "time:[123]";
const job = Object.freeze({ operation: "job", unit: "subscription-job-" + "a".repeat(64) + ".service",
  payload: ["/opt/subscription-runtime/runtime/node", "/opt/native-newtest/refusal.mjs"],
  jobId: "original-ends-test", fingerprint: "b".repeat(64),
  limits: { runtimeSeconds: 60, stopSeconds: 10, memoryMiB: 512, tasksMax: 64, cpuPercent: 100 } });
const transport = (work: bigint, cleanup: bigint): string => JSON.stringify({ version: 1, kind: "ManagedOriginalEnds",
  timeNamespace: namespace, workEndNs: work.toString(), cleanupEndNs: cleanup.toString() });

// Red: parsing silently overwrites duplicate keys, changes a clock epoch, or
// accepts a transport-selected mode/lifetime outside the finite job contract.
test("original ends require canonical exact fields and same clock namespace", () => {
  const raw = transport(400_000_000_000n, 500_000_000_000n);
  const ends = launcher.parseOriginalEnds(raw, namespace);
  assert.deepEqual(ends, { timeNamespace: namespace, workEndNs: 400_000_000_000n, cleanupEndNs: 500_000_000_000n });
  assert.equal(Object.isFrozen(ends), true);
  const decoded = JSON.parse(raw) as Record<string, unknown>;
  for (const invalid of [raw + " ", "[]", "null", JSON.stringify({ ...decoded, authority: "Root" }),
    raw.replace('"version":1', '"version":1,"version":1'),
    JSON.stringify({ ...decoded, timeNamespace: "time:[0123]" }),
    JSON.stringify({ ...decoded, workEndNs: "0400000000000" }),
    JSON.stringify({ ...decoded, workEndNs: 400_000_000_000 }),
    JSON.stringify({ ...decoded, workEndNs: "0" }),
    JSON.stringify({ ...decoded, workEndNs: "-1" }),
    JSON.stringify({ ...decoded, cleanupEndNs: "9223372036854775808" }),
    transport(400_000_000_000n, 400_000_000_000n), transport(500_000_000_000n, 400_000_000_000n),
    JSON.stringify({ kind: "ManagedOriginalEnds", version: 1, timeNamespace: namespace,
      workEndNs: "400000000000", cleanupEndNs: "500000000000" })]) {
    assert.throws(() => launcher.parseOriginalEnds(invalid, namespace));
  }
  assert.throws(() => launcher.parseOriginalEnds(raw, "time:[124]"));
});

// Red: transport modifies fingerprinted job DATA, accepts an env-like option,
// becomes a provider/custody mode, or starts requiring a budget for legacy CLI.
test("optional deadline CLI preserves exact job identity and legacy envelope", () => {
  const request = JSON.stringify(job), raw = transport(400_000_000_000n, 500_000_000_000n);
  assert.deepEqual(launcher.parseLauncherArguments(["job", request]), { request: job, ends: null });
  const accepted = launcher.parseLauncherArguments(["job", request, "--original-ends-v1", raw], namespace);
  assert.deepEqual(accepted.request, job);
  assert.equal(JSON.stringify(accepted.request), request);
  assert.deepEqual(accepted.ends, launcher.parseOriginalEnds(raw, namespace));
  assert.equal(Object.isFrozen(accepted.request), true);
  for (const invalid of [["job", request, "--original-ends-v1"],
    ["job", request, "--original-ends-v2", raw], ["job", request, "--original-ends-v1", raw, "extra"],
    ["provider", JSON.stringify({ ...job, operation: "provider" }), "--original-ends-v1", raw],
    ["custody", JSON.stringify({ ...job, operation: "custody" }), "--original-ends-v1", raw],
    ["job", request + " ", "--original-ends-v1", raw],
    ["job", request.replace('"operation":"job"', '"operation":"job","operation":"job"'), "--original-ends-v1", raw]]) {
    assert.throws(() => launcher.parseLauncherArguments(invalid, namespace));
  }
});

// Independent policy expectation: fixed 600s startup + 60s runtime + 10s stop.
// Red: fixed startup or request runtime/stop stops being funded, exact equality
// passes, or a reversed monotonic sample extends the original allowance.
test("actual fixed job limits fund startup runtime and stop with strict original ends", () => {
  const reservation = launcher.originalJobReservation(job);
  assert.deepEqual(reservation, { workNs: 660_000_000_000n, cleanupNs: 670_000_000_000n });
  const anchor = 1_000_000_000n, now = anchor + 1n;
  const fit = launcher.parseOriginalEnds(transport(now + 660_000_000_001n, now + 670_000_000_001n), namespace);
  assert.doesNotThrow(() => launcher.assertOriginalReservation(fit, reservation, anchor, now));
  assert.throws(() => launcher.assertOriginalReservation(fit, reservation, anchor, anchor - 1n));
  for (const ends of [launcher.parseOriginalEnds(transport(now + 660_000_000_000n, now + 670_000_000_001n), namespace),
    launcher.parseOriginalEnds(transport(now + 660_000_000_001n, now + 670_000_000_000n), namespace)]) {
    assert.throws(() => launcher.assertOriginalReservation(ends, reservation, anchor, now));
  }
  const longer = { ...job, limits: { ...job.limits, runtimeSeconds: 61, stopSeconds: 11 } };
  assert.deepEqual(launcher.originalJobReservation(longer), { workNs: 661_000_000_000n, cleanupNs: 672_000_000_000n });
  assert.throws(() => launcher.assertOriginalReservation(fit, launcher.originalJobReservation(longer), anchor, now));
});

// Red: a final veto renews ends or ignores time consumed by a real awaited
// preparer. This checks the pure contract only, not actual default admission
// ordering; that stronger no-manager-effect fixture remains a physical gate.
test("real asynchronous preparation consumes the same original deadline margin", async () => {
  const anchor = process.hrtime.bigint(), reservation = launcher.originalJobReservation(job);
  const ends = launcher.parseOriginalEnds(transport(anchor + 660_100_000_000n, anchor + 670_100_000_000n), namespace);
  assert.doesNotThrow(() => launcher.assertOriginalReservation(ends, reservation, anchor, anchor));
  const prepared = await boundedCommand(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('prepared'),250)"],
    anchor + 5_000_000_000n, undefined, {}, anchor + 10_000_000_000n);
  assert.equal(prepared.code, 0); assert.equal(prepared.signal, null);
  assert.equal(prepared.naturalClose, true); assert.equal(prepared.stdout.toString(), "prepared");
  assert.throws(() => launcher.assertOriginalReservation(ends, reservation, anchor, process.hrtime.bigint()));
  assert.equal(ends.workEndNs, anchor + 660_100_000_000n);
  assert.equal(ends.cleanupEndNs, anchor + 670_100_000_000n);
});
