import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { AppServerProviderSetupStage as Stage, AppServerProviderSetupCheckpoint as Checkpoint, AppServerProviderSetupCode as Code,
  appServerProviderSetupCode, retainAppServerProviderSetupFailure, appServerProviderSetupFailureCause,
  appServerProviderSetupCauseFact, type AppServerProviderSetupFact } from "../../app-server/domain/app-server-provider-setup-observation";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { classifyCodexFailure } from "../../failure-classifier";
import { codexDriverFailure } from "../../codex-driver-failure";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";

const base: AppServerProviderSetupFact = { stage: Stage.Observing, checkpoint: Checkpoint.PeerJoin, code: Code.Boundary,
  ready: true, released: false, elapsedMsCapped: 4346, limitMs: 4346 };
const fact = (child: object) => appServerProviderSetupFailureCause(child)?.message;
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
