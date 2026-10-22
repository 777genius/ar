import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { CodexAppServerClient } from "../../app-server/application/app-server-client";
import { AppServerLaunchStderrFact, appServerLaunchStderrCauseFact, createAppServerLaunchStderrObservation } from "../../app-server/application/app-server-launch-stderr";
import { resolveCodexExecutionProfile } from "../../codex-execution-profile";
import { classifyCodexFailure } from "../../failure-classifier";
import { codexDriverFailure } from "../../codex-driver-failure";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { AppServerUsageError } from "../../app-server/domain/app-server-usage-error";

const label = "hosted_app_server_descriptor_boundary_invalid\n";
const fact = "app_server_stderr label=descriptor_boundary_invalid";

it("observes a fixed whole label across every stream split without returning raw stderr", () => {
  for (let split = 0; split <= label.length; split++) {
    const observation = createAppServerLaunchStderrObservation();
    observation.observe(label.slice(0, split)); observation.observe(label.slice(split));
    expect(observation.snapshotCause()?.message).toBe(fact);
    expect(observation.snapshotCause()?.message).not.toContain("hosted_app_server_");
  }
});

it("permanently refuses unknown, partial, multiline, control, nonASCII and oversized streams", () => {
  for (const chunks of [[label.slice(0, -1)], [label, "TEST-secret-canary"], ["TEST-secret-canary", label],
    [label, label], [label.replace("\n", "\r\n")], [label + "\0"], ["é", label], ["a".repeat(129), label],
    ["Bearer TEST-secret-canary\n", label], ["TEST_provider_protocol_or_probe_failed\n"], [undefined, label]]) {
    const observation = createAppServerLaunchStderrObservation();
    for (const chunk of chunks) observation.observe(chunk);
    expect(observation.snapshotCause()).toBeUndefined();
  }
});

it("snapshots only already observed bytes without claiming stream EOF", () => {
  const observation = createAppServerLaunchStderrObservation(); observation.observe(label);
  const exited = observation.snapshotCause(); observation.observe("TEST-late-secret-canary");
  expect(exited?.message).toBe(fact); expect(observation.snapshotCause()).toBeUndefined();
});

it("preserves provider classification for every genuine closed fact", () => {
  const original = classifyCodexFailure(new Error("codex_app_server_exited:70"));
  for (const value of Object.values(AppServerLaunchStderrFact)) {
    const wire = value === AppServerLaunchStderrFact.ResearchBootstrapDeadline ? "hosted_app_server_research_bootstrap_timeout"
      : value === AppServerLaunchStderrFact.ScratchBoundaryInvalid ? "hosted_provider_scratch_boundary_invalid"
      : value === AppServerLaunchStderrFact.OriginalStorageInvalid ? "original_provider_storage_context_invalid" : `hosted_app_server_${value}`;
    const observation = createAppServerLaunchStderrObservation(); observation.observe(wire + "\n");
    const cause = observation.snapshotCause(); expect(cause).toBeInstanceOf(Error);
    const result = classifyCodexFailure(new Error("codex_app_server_exited:70", { cause }));
    expect(result).toEqual({ ...original, details: { ...original.details,
      rawCause: `codex_app_server_exited:70 <- app_server_stderr label=${value}` } });
  }
});

async function actualExit(stderr: string, signal = false): Promise<Error> {
  const client = new CodexAppServerClient({ codexBinaryPath: "/TEST/unused", sourceEnv: {},
    processFactory: () => spawn(process.execPath, ["-e", `require('node:fs').writeSync(2, ${JSON.stringify(stderr)});process.stdin.resume();setTimeout(()=>${signal ? "process.kill(process.pid,'SIGTERM')" : "process.exit(70)"},50);`], { stdio: "pipe" }),
    signalChildProcess: (child, value) => { child.kill(value); },
    session: { home: process.cwd(), codexHome: process.cwd(), env: {}, release: async () => undefined },
    workspacePath: process.cwd(), executionProfile: resolveCodexExecutionProfile(undefined),
    timeoutMs: 3000, startupTimeoutMs: 3000, reconnectGraceMs: 100, maxOutputBytes: 4096,
    abortSignal: new AbortController().signal });
  try { return await client.start().then(() => { throw new Error("TEST unexpected initialization"); }, error => error as Error); }
  finally { await client.stop(); }
}

it("preserves a real child exit error and adds only the closed observed cause", async () => {
  const error = await actualExit(label);
  expect(error.message).toBe("codex_app_server_exited:70"); expect((error.cause as Error).message).toBe(fact);
  const original = classifyCodexFailure(new Error(error.message)), projected = classifyCodexFailure(error);
  expect(projected).toEqual({ ...original, details: { ...original.details, rawCause: `${error.message} <- ${fact}` } });
  const result = codexDriverFailure({ error, evidenceError: error, redactor: new DefaultRedactor(), startedAt: Date.now() });
  expect(result.status).toBe("failed"); expect(result.failure).toEqual(projected);
  expect(classifyCodexFailure(new AppServerUsageError(error))).toEqual(projected);
});

it("keeps real unknown or truncated stderr private and preserves signal spelling", async () => {
  for (const text of ["Authorization: Bearer TEST-secret-canary\n", label.slice(0, -1), label + "TEST-secret-canary"]) {
    const error = await actualExit(text); expect(error.message).toBe("codex_app_server_exited:70");
    expect(error.cause).toBeUndefined(); expect(String(error)).not.toContain("TEST-secret-canary");
  }
  const signaled = await actualExit(label, true);
  expect(signaled.message).toBe("codex_app_server_exited:SIGTERM"); expect((signaled.cause as Error).message).toBe(fact);
});

it("projects only genuine snapshot identity without reading arbitrary cause messages or getters", () => {
  const original = new Error("codex_app_server_exited:70"), before = classifyCodexFailure(original);
  const forged = new Error(original.message, { cause: new Error(fact + " TEST-secret-canary") });
  expect(classifyCodexFailure(forged)).toEqual(before);
  const matching = new Error(original.message, { cause: new Error(fact) });
  expect(classifyCodexFailure(matching)).toEqual(before);
  const observation = createAppServerLaunchStderrObservation(); observation.observe(label);
  const cause = observation.snapshotCause()!; cause.message = "TEST-secret-canary";
  expect(classifyCodexFailure(new Error(original.message, { cause })).details?.rawCause).toBe(`${original.message} <- ${fact}`);
  const getter = Object.defineProperty(new Error(original.message), "cause", { get() { throw new Error("TEST-secret-canary"); } });
  expect(appServerLaunchStderrCauseFact(getter)).toBeUndefined();
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("TEST-secret-canary"); } });
  expect(appServerLaunchStderrCauseFact(proxy)).toBeUndefined();
  expect(appServerLaunchStderrCauseFact(new Error(original.message, { cause: new Proxy(cause, {}) }))).toBeUndefined();
});
