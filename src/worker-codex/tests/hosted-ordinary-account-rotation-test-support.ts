import { expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexProviderEgressProfileId, withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedOrdinaryCreator } from "@vioxen/subscription-runtime/worker-core";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";
import { FileBackendCodexSafeExecutor } from "../file-backend-codex-safe-executor";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server";
import { codexAuthJsonForAccount, StaticRunner } from "./file-backend-codex-worker-test-support";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { assertHostedNetworkLaunch } from "./hosted-network-launch-assertions";

// Reuse the installation suite's live fixture and lifecycle hooks. Only test
// registration moves; production admission and account rotation remain real.
export function registerOrdinaryAccountRotationTests({ fixture, creator, hash, read, put }: {
  fixture: { root: string; runtimeUnit: string; group: string; spawn: ReturnType<typeof vi.fn>;
    onStop: (() => void) | undefined };
  creator: () => HostedOrdinaryCreator;
  hash: (bytes: Buffer | string) => string;
  read: (name: string) => Record<string, unknown>;
  put: (name: string, value: unknown) => void;
}): void {
it.each(["internet", "npm", "npm-grant-deleted", "research", "research-grant-deleted", "research-grant-mutated"])("real ordinary runner and default factory revalidate on quota account switch: %s", async mode => {
  const config = { jobId: "ordinary-job", taskId: "ordinary-job", jobRootDir: join(fixture.root, "jobs/ordinary-job"),
    workspacePath: join(fixture.root, "jobs/ordinary-job/workspace"), promptPath: join(fixture.root, "prompt"),
    authRootDir: join(fixture.root, "unused-synthetic-auth"), accounts: codexGoalAccountSlots(["fake-a", "fake-b"]),
    maxAccountCycles: 1, sourceEnv: { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" } };
  mkdirSync(config.jobRootDir, { recursive: true, mode: 0o700 }); mkdirSync(config.workspacePath); writeFileSync(config.promptPath, "Offline rotation");
  const bound = { ...creator(), jobRootDir: config.jobRootDir, workspacePath: config.workspacePath,
    launch: { ...creator().launch, cwd: config.workspacePath } };
  put("readonly-inventory.json", { ...read("readonly-inventory.json"), ordinaryCreators: [bound] });
  const grant = `grants/${hash(config.jobId)}.json`;
  const selectedProfile = mode.startsWith("research") ? CodexProviderEgressProfileId.PublicResearchV1 : mode === "internet" ? CodexProviderEgressProfileId.FullInternetV1 : CodexProviderEgressProfileId.TestNpmQualification;
  if (mode !== "internet") put(grant, { schemaVersion: 1, jobId: config.jobId, jobRootDir: config.jobRootDir,
    workspacePath: config.workspacePath, profileId: selectedProfile });
  const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary(bound.creatorId); store.resumeOrdinary();
  const prepared = store.serialized(fence => store.reserveOrdinaryRuntime(fence, bound.launch.command, bound.launch.args, bound.launch.cwd, undefined, undefined, config.sourceEnv));
  fixture.runtimeUnit = prepared.start.unit; fixture.group = prepared.start.controlGroup;
  const fakes = [new FakeAppServerFactory({ emitTopLevelErrorOnTurn: "You've hit your usage limit",
    onRequest: request => { if (request.method === "turn/start" && mode.endsWith("grant-deleted")) rmSync(join(fixture.root, grant));
      if (request.method === "turn/start" && mode.endsWith("grant-mutated")) {
        // Same valid semantic grant, different bytes: fallback must still refuse.
        writeFileSync(join(fixture.root, grant), readFileSync(join(fixture.root, grant), "utf8") + "\n", { mode: 0o600 });
      } } }), new FakeAppServerFactory()];
  const frames: { env: Record<string, string>; args: string[] }[] = [];
  fixture.spawn.mockImplementation((command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 2)).toEqual(["/opt/subscription-runtime/managed-launcher/launch.mjs", "provider"]);
    expect(options.cwd).toBe(options.env.HOME);
    expect(options.cwd).not.toBe(config.workspacePath);
    expect(store.read().ordinaryStarts).toHaveLength(frames.length + 2);
    expect(() => withHostedActivationFence(() => {})).toThrow();
    const request = JSON.parse(args[2]!);
    expect(request).toEqual({ operation: "provider", jobId: config.jobId,
      unit: store.read().ordinaryStarts[frames.length + 1]!.unit,
      payload: [process.execPath, expect.stringMatching(/\/hosted-app-server-launcher\.js$/)] });
    expect(request.readonlyPaths).toBeUndefined();
    const child = fakes[frames.length]!.create({ ...options, args });
    const write = child.stdin.write; let bootstrap = true;
    child.stdin.write = chunk => {
      if (bootstrap) { frames.push(JSON.parse(String(chunk))); bootstrap = false; return true; }
      return write(chunk);
    };
    return child;
  });
  fixture.onStop = () => { for (const fake of fakes) for (const child of fake.processes) child.kill(); };
  const clock = { now: () => new Date("2026-05-31T00:05:00.000Z"), monotonicMs: () => performance.now() };
  const result = await runCodexGoal(config, {
    createExecutor: options => new FileBackendCodexSafeExecutor({
    ...options, requireGitWorkspace: false, prewarmOnStart: false, clock,
    accounts: options.accounts.map((account, index) => ({
      codexAuthJson: codexAuthJsonForAccount(`synthetic-refresh-${index}`, `synthetic-account-${index}`),
      worker: { ...account.worker, clock, warmupPrompt: false, runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }) },
    })),
  }) });
  expect(fixture.spawn).toHaveBeenCalledTimes(mode.includes("-grant-") ? 1 : 2);
  expect(result.attempts[0]?.failureReason, result.attempts[0]?.failureMessage).toBe("quota_limited");
  expect(frames.every(frame => frame.env.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE ===
    selectedProfile)).toBe(true);
  assertHostedNetworkLaunch(frames, selectedProfile, fakes);
  if (mode.includes("-grant-")) expect(result.status).not.toBe("completed");
  else { expect(result.status).toBe("completed"); expect(new Set(frames.map(frame => frame.env.CODEX_HOME)).size).toBe(2); }
});
}
