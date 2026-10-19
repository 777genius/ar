import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { AppServerProviderSetupStage as Stage, AppServerProviderSetupCheckpoint as Checkpoint, AppServerProviderSetupCode as Code,
  appServerProviderSetupCode, retainAppServerProviderSetupFailure, appServerProviderSetupFailureCause,
  appServerProviderSetupCauseFact, type AppServerProviderSetupFact } from "../../app-server/domain/app-server-provider-setup-observation";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { classifyCodexFailure } from "../../failure-classifier";
import { turnFailureError } from "../../app-server/application/app-server-turn-failure";
import { codexDriverFailure } from "../../codex-driver-failure";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AppServerObserverPoint as Point, AppServerObserverCode as ObserverCode, AppServerObserverErrno as Errno,
  closedObserverFailure, retainObserverFailure } from "../../app-server/domain/app-server-observer-failure";

const base: AppServerProviderSetupFact = { stage: Stage.Observing, checkpoint: Checkpoint.PeerJoin, code: Code.Boundary,
  ready: true, released: false, elapsedMsCapped: 4346, limitMs: 4346 };
const fact = (child: object) => appServerProviderSetupFailureCause(child)?.message;
it("transports only branded deepest observer facts and bounded timing, without generic causes or accessors", () => {
  const original = Object.assign(new Error("TEST-private-path-auth-canary"), { code: "EACCES", path: "TEST-private-path-auth-canary" });
  retainObserverFailure(original, Point.BusProcess, 17);
  const wrapped = new Error("system_bus_infrastructure_unqualified"); retainObserverFailure(original, Point.UnitArrays, 20, wrapped);
  const observer = closedObserverFailure(wrapped, Point.Native, 25);
  expect(observer).toEqual({ point: Point.BusProcess, code: ObserverCode.Unknown, errno: Errno.EACCES, elapsedMsCapped: 17 });
  const child = {}; retainAppServerProviderSetupFailure(child, { ...base, observer, collectAttempts: 3,
    firstCollectElapsedMsCapped: 7, checkpointEntryElapsedMsCapped: 4123, budgetExpired: true });
  expect(fact(child)).toContain("attempts=3 first_collect_ms=7 checkpoint_entry_ms=4123 budget_expired=1");
  expect(fact(child)).toContain("observer=bus_process observer_code=unknown errno=EACCES observer_ms_capped=17");
  expect(fact(child)).not.toContain("canary");
  expect(closedObserverFailure(new Error(wrapped.message, { cause: wrapped }), Point.Native, 1).point).toBe(Point.Native);
  let reads = 0;
  const getter = Object.defineProperty({}, "code", { get() { reads++; throw Error("TEST-secret-canary"); } });
  expect(closedObserverFailure(getter, Point.Native, 0).errno).toBe(Errno.None); expect(reads).toBe(0);
  for (const change of [{ observer: { ...observer, point: "TEST-secret-canary" } }, { collectAttempts: 65536 },
    { firstCollectElapsedMsCapped: -1 }, { checkpointEntryElapsedMsCapped: 60001 }, { budgetExpired: "TEST-secret-canary" }]) {
    const rejected = {}; retainAppServerProviderSetupFailure(rejected, { ...base, observer, collectAttempts: 1,
      firstCollectElapsedMsCapped: 1, checkpointEntryElapsedMsCapped: 1, budgetExpired: false, ...change } as AppServerProviderSetupFact);
    expect(fact(rejected)).toBeUndefined();
  }
});
it("retains at most three closed rejection samples without invoking nested getters or exporting caller data", () => {
  const sample = { checkpoint: Checkpoint.Unit, code: Code.Unknown, elapsedMsCapped: 17, checkpointEntryElapsedMsCapped: 7,
    observer: { point: Point.BusArrays, code: ObserverCode.Bus, errno: Errno.EACCES, elapsedMsCapped: 10 }, count: 3 };
  const child = {}; retainAppServerProviderSetupFailure(child, { ...base, rejections: [sample], omittedRejections: 2 });
  sample.observer.point = Point.Native;
  expect(fact(child)).toContain("rejection1=unit,unknown,17,7,bus_arrays,bus,EACCES,10,3 omitted_rejections=2");
  let reads = 0;
  const getter = Object.defineProperty({ ...sample }, "checkpoint", { get() { reads++; return Checkpoint.Unit; } });
  const arrayGetter = Object.defineProperty([sample], "0", { get() { reads++; return sample; } });
  for (const change of [{ rejections: [sample, sample, sample, sample] }, { rejections: [getter] }, { rejections: arrayGetter },
    { rejections: [{ ...sample, count: 0 }] }, { rejections: [{ ...sample, elapsedMsCapped: 60001 }] },
    { rejections: [{ ...sample, code: "TEST-secret-canary" }] }, { rejections: [{ ...sample, observer: { ...sample.observer, errno: "TEST-secret-canary" } }] },
    { omittedRejections: 65536 }, { omittedRejections: -1 }, { rejections: new Proxy([], { getOwnPropertyDescriptor() { throw Error("TEST-secret-canary"); } }) }]) {
    const rejected = {}; retainAppServerProviderSetupFailure(rejected, { ...base, rejections: [sample], omittedRejections: 0, ...change } as AppServerProviderSetupFact);
    expect(fact(rejected)).toBeUndefined();
  }
  expect(reads).toBe(0);
});
it("retains only the first closed snapshot with bounded numbers and no caller getters", () => {
  const child = {}; retainAppServerProviderSetupFailure(child, base);
  retainAppServerProviderSetupFailure(child, { ...base, checkpoint: Checkpoint.Unit });
  expect(fact(child)).toBe("app_server_setup stage=observing checkpoint=peer_join code=fd_boundary ready=1 released=0 elapsed_ms_capped=4346 limit_ms=4346");
  for (const change of [{ stage: "TEST-secret-canary" }, { checkpoint: "TEST-secret-canary" }, { code: "TEST-secret-canary" },
    { elapsedMsCapped: -1 }, { elapsedMsCapped: 60001 }, { limitMs: 0 }, { limitMs: 60001 }, { ready: "TEST-secret-canary" }]) {
    const rejected = {}; retainAppServerProviderSetupFailure(rejected, { ...base, ...change } as AppServerProviderSetupFact);
    expect(fact(rejected)).toBeUndefined();
  }
  let reads = 0;
  const getter = Object.defineProperty({ ...base }, "stage", { get() { reads++; return Stage.Observing; } });
  retainAppServerProviderSetupFailure({}, getter); expect(reads).toBe(0);
  expect(() => retainAppServerProviderSetupFailure({}, new Proxy(base, { ownKeys() { throw new Error("TEST-secret-canary"); } }))).not.toThrow();
});
it("accepts only exact fixed original error codes and genuine one-hop snapshot identity", () => {
  expect(appServerProviderSetupCode(new Error("hosted_fd_namespace_stage_unresolved"))).toBe(Code.Namespace);
  for (const text of ["hosted_fd_boundary_unresolved TEST-secret-canary", "Bearer TEST-secret-canary", "a".repeat(100000)])
    expect(appServerProviderSetupCode(new Error(text))).toBe(Code.Unknown);
  expect(appServerProviderSetupCode(Object.defineProperty({}, "message", { get() { throw Error("TEST-secret-canary"); } }))).toBe(Code.Unknown);
  const child = {}; retainAppServerProviderSetupFailure(child, base);
  const cause = appServerProviderSetupFailureCause(child)!; cause.message = "TEST-secret-canary";
  const original = new Error("codex_app_server_exited:70");
  expect(appServerProviderSetupCauseFact(new Error(original.message, { cause }))).toBe(fact(child));
  expect(appServerProviderSetupCauseFact(new Error(original.message, { cause: new Error(fact(child)) }))).toBeUndefined();
  expect(appServerProviderSetupCauseFact(Object.defineProperty(original, "cause", { get() { throw Error("TEST-secret-canary"); } }))).toBeUndefined();
  expect(appServerProviderSetupCauseFact(new Proxy({}, { getOwnPropertyDescriptor() { throw Error("TEST-secret-canary"); } }))).toBeUndefined();
});
it("keeps provider classification invariant for all stages/checkpoints and HTTP-like counts", () => {
  const original = new Error("codex_app_server_exited:70"), before = classifyCodexFailure(original);
  for (const stage of Object.values(Stage)) for (const checkpoint of Object.values(Checkpoint)) for (const count of [401, 403, 429, 502, 503]) {
    const child = {}; retainAppServerProviderSetupFailure(child, { ...base, stage, checkpoint, elapsedMsCapped: count, limitMs: count });
    const cause = appServerProviderSetupFailureCause(child)!;
    expect(classifyCodexFailure(new Error(original.message, { cause }))).toEqual({ ...before,
      details: { ...before.details, rawCause: `${original.message} <- ${cause.message}` } });
  }
});
it("keeps the setup fact across the turn error wrapper without widening the closed lookup", () => {
  const child = {}; retainAppServerProviderSetupFailure(child, base);
  const cause = appServerProviderSetupFailureCause(child)!;
  const exit = new Error("codex_app_server_exited:70", { cause });
  const turn = turnFailureError(exit, { phase: "turn_error_before_output", turnNumber: 1, elapsedMs: 5 });
  expect(classifyCodexFailure(turn).details?.rawCause).toContain(` <- ${cause.message}`);
  expect(classifyCodexFailure(turn).details?.rawCause).not.toContain("TEST-secret-canary");
  const shallow = turnFailureError(new Error("codex_app_server_exited:70", { cause: new Error(cause.message) }),
    { phase: "turn_error_before_output", turnNumber: 1, elapsedMs: 5 });
  expect(classifyCodexFailure(shallow).details?.rawCause).toBe(shallow.message);
});
it("projects setup facts before teardown into the unchanged real client exit and final failed result", async () => {
  const client = new CodexAppServerClient({ codexBinaryPath: "/TEST/unused", sourceEnv: {},
    processFactory: () => {
      const child = spawn(process.execPath, ["-e", "process.stdin.resume();setTimeout(()=>{require('node:fs').writeSync(2,'hosted_app_server_launch_frame_missing\\n');process.exit(70)},50)"], { stdio: "pipe" });
      retainAppServerProviderSetupFailure(child, base); return child;
    }, signalChildProcess: (child, signal) => { child.kill(signal); },
    session: { home: process.cwd(), codexHome: process.cwd(), env: {}, release: async () => undefined }, workspacePath: process.cwd(),
    executionProfile: resolveCodexExecutionProfile(undefined), timeoutMs: 3000, startupTimeoutMs: 3000,
    reconnectGraceMs: 100, maxOutputBytes: 4096, abortSignal: new AbortController().signal });
  try {
    const error = await client.start().then(() => { throw Error("TEST unexpected startup"); }, error => error as Error);
    expect(error.message).toBe("codex_app_server_exited:70");
    const result = codexDriverFailure({ error, evidenceError: error, redactor: new DefaultRedactor(), startedAt: Date.now() });
    expect(result.status).toBe("failed"); expect(result.failure.details?.rawCause)
      .toBe(`${error.message} <- app_server_setup stage=observing checkpoint=peer_join code=fd_boundary ready=1 released=0 elapsed_ms_capped=4346 limit_ms=4346`);
  } finally { await client.stop(); }
});
