import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { workerPoolSlotId, type HostedOrdinaryCreator } from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId, codexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { CodexWorkerCacheSessionMaterializer, codexWorkerCacheRoot, codexWorkerCacheSlotKey } from "../../provider-codex/codex-session-materializer";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex/codex-auth-json-codec";
import { parseHostedOrdinaryWriterExtent } from "../../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { spawnCodexAppServerProcess } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { inspectKernelPathBacking } from "../../core/host-infrastructure/kernel-path-backing";
import { codexSafeExecutorId } from "../codex-account-identity";
import { codexSessionHomeCacheKey } from "../codex-session-home-profile";
import { parseFlags } from "../codex-goal-cli-support";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { runCodexGoal } from "../codex-goal-runner";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { observeHostedOrdinaryJobWriterAuthority } from "../hosted-ordinary-writer-authority";
import { codexAuthJsonForAccount } from "./file-backend-codex-worker-test-support";

type Context = {
  fixture: { root: string; runtimeUnit: string; group: string; spawn: ReturnType<typeof vi.fn> };
  creator: () => HostedOrdinaryCreator;
  runtimeDirectory: string;
  read: (name: string) => Record<string, unknown>;
  put: (name: string, value: unknown) => void;
};

/** Real tmpfs paths keep FD-selected backing meaningful even when the runner's
 * /tmp is overlay. Only the parent suite's finite proc/systemd facts are synthetic. */
export function modernOrdinaryFixture(context: Context) {
  const allocated = mkdtempSync("/dev/shm/TEST-ordinary-extent-"), jobId = "ordinary-job";
  const jobRootDir = join(allocated, "jobs", jobId), workspacePath = join(jobRootDir, "workspace"), promptPath = join(jobRootDir, "prompt.md");
  try {
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    writeFileSync(promptPath, "Offline modern ordinary extent", { mode: 0o600 });
    const sourceEnv = { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" };
    const launch = { command: process.execPath, args: [join(context.runtimeDirectory, "dist/worker-codex/codex-goal-cli.js"), "run",
      "--job-id", jobId, "--task-id", jobId, "--job-root", jobRootDir, "--workspace", workspacePath, "--prompt", promptPath,
      "--auth-root", join(allocated, "auth"), "--accounts", "fake-a,fake-b", "--max-account-cycles", "1", "--no-require-git-workspace", "--no-tmux"], cwd: workspacePath };
    const config = runConfigFromFlags(parseFlags(launch.args.slice(2)), sourceEnv, workspacePath, jobRootDir, jobId);
    const bound = { ...context.creator(), jobRootDir, workspacePath, launch };
    context.put("readonly-inventory.json", { ...context.read("readonly-inventory.json"), ordinaryCreators: [bound] });
    const manifest: CodexGoalJobManifest = { schemaVersion: 1, jobId, taskId: jobId, jobRootDir, workspacePath, promptPath,
      accounts: ["fake-a", "fake-b"], createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z" };
    return { allocated, config, bound, sourceEnv, manifest, cleanup: () => rmSync(allocated, { recursive: true, force: true }) };
  } catch (error) { rmSync(allocated, { recursive: true, force: true }); throw error; }
}

export function registerOrdinaryWriterExtentTests(context: Context): void {
  describe.skipIf(process.platform !== "linux")("modern ordinary allocation lifetime", () => {
    function reserve(f: ReturnType<typeof modernOrdinaryFixture>) {
      const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary(f.bound.creatorId); store.resumeOrdinary();
      const retained = store.serialized(fence => store.reserveOrdinaryRuntime(fence, f.bound.launch.command,
        f.bound.launch.args, f.bound.launch.cwd, undefined, undefined, f.sourceEnv));
      const extent = parseHostedOrdinaryWriterExtent(context.read(`ordinary-starts/${retained.reservation.startId}.extent.json`));
      return { store, retained, extent };
    }
    function enter(start: { unit: string; controlGroup: string }): void {
      context.fixture.runtimeUnit = start.unit; context.fixture.group = start.controlGroup;
    }
    it.each(["config", "physical"] as const)("rejects %s drift before raw setup or executor effects", async fault => {
      const f = modernOrdinaryFixture(context);
      try {
        const { retained } = reserve(f); enter(retained.start);
        const outside = join(f.allocated, "TEST-outside"); mkdirSync(outside, { mode: 0o700 });
        if (fault === "physical") {
          renameSync(f.config.jobRootDir, f.config.jobRootDir + "-retained");
          mkdirSync(f.config.workspacePath, { recursive: true, mode: 0o700 });
        }
        const config = fault === "config" ? { ...f.config, outputPath: join(outside, "result.json") } : f.config;
        const createExecutor = vi.fn(() => { throw new Error("TEST unexpected executor"); });
        await expect(runCodexGoal(config, { createExecutor })).rejects.toThrow("hosted_ordinary_writer_extent_invalid");
        expect(existsSync(join(config.jobRootDir, ".controller-state-origin.json"))).toBe(false);
        expect(existsSync(join(config.jobRootDir, "state"))).toBe(false);
        expect(existsSync(config.progressPath!)).toBe(false); expect(readdirSync(outside)).toEqual([]);
        expect(createExecutor).not.toHaveBeenCalled(); expect(context.fixture.spawn).not.toHaveBeenCalled();
      } finally { f.cleanup(); }
    });
    it.each(["home", "cache"] as const)("refuses an unsealed %s before writing materialized credentials", async fault => {
      const f = modernOrdinaryFixture(context);
      try {
        const { store, retained, extent } = reserve(f); enter(retained.start);
        const cacheRoot = join(f.config.jobRootDir, "state/codex-session-cache");
        const plannedKey = codexWorkerCacheSlotKey(codexSessionHomeCacheKey({ profile: f.config.sessionHomeProfile,
          providerInstanceId: `${f.config.taskId}-${f.config.accounts[0]!.name}`,
          workerId: workerPoolSlotId(codexSafeExecutorId(f.config.workspacePath), 0) }), 0);
        const key = fault === "home" ? "TEST-unsealed-home" : plannedKey;
        const codexHome = join(codexWorkerCacheRoot(cacheRoot, key, CodexProviderEgressProfileId.FullInternetV1), "codex-home");
        if (fault === "cache") expect(codexHome).toBe(extent.homes[0]!.codexHome);
        const outside = join(f.allocated, "TEST-unsealed-cache"); mkdirSync(outside, { mode: 0o700 });
        const prepareHome = vi.fn(async (home: string) => {
          mkdirSync(join(home, "plugins"), { recursive: true, mode: 0o700 });
          symlinkSync(outside, join(home, "plugins/cache"));
        });
        const materializer = new CodexWorkerCacheSessionMaterializer({ cacheKey: key, rootDir: cacheRoot, prepareHome,
          providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.FullInternetV1) });
        await expect(materializer.materialize({ redactor: new DefaultRedactor(),
          session: sessionArtifactFromCodexAuthJson(codexAuthJsonForAccount("TEST-refresh", "TEST-account")) }))
          .rejects.toThrow();
        expect(prepareHome).toHaveBeenCalledTimes(fault === "home" ? 0 : 1);
        const home = fault === "home" ? outside : extent.homes[0]!.home;
        expect(() => spawnCodexAppServerProcess({ command: "/TEST/codex", args: ["app-server"], cwd: home,
          env: { ...f.sourceEnv, HOME: home, CODEX_HOME: fault === "home" ? outside : codexHome,
            SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: CodexProviderEgressProfileId.FullInternetV1 } })).toThrow();
        expect(store.read().ordinaryStarts).toHaveLength(1);
        expect(existsSync(join(codexHome, "auth.json"))).toBe(false); expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
        expect(readdirSync(outside)).toEqual([]); expect(context.fixture.spawn).not.toHaveBeenCalled();
      } finally { f.cleanup(); }
    });
    it("observes pending before heartbeat and keeps an exact-terminal predecessor from releasing its successor", async () => {
      const f = modernOrdinaryFixture(context);
      try {
        const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary(f.bound.creatorId); store.resumeOrdinary();
        store.runOrdinaryRuntimeLaunch(f.bound.launch.command, f.bound.launch.args, f.bound.launch.cwd, () => undefined, undefined, f.sourceEnv);
        const first = store.read().ordinaryStarts[0]!;
        const observation = await observeHostedOrdinaryJobWriterAuthority(f.manifest);
        const physical = inspectKernelPathBacking(f.config.jobRootDir);
        expect(observation.status).toBe("allocated");
        if (observation.status === "allocated") expect(observation.roots).toContainEqual(physical);
        expect(existsSync(f.config.progressPath!)).toBe(false); expect(context.fixture.spawn).not.toHaveBeenCalled();
        store.recordOrdinaryRuntimeWaitCompletion();
        const completion = readFileSync(join(context.fixture.root, `ordinary-completed/${first.startId}.json`));
        store.enterExclusive(); store.finishClosed();
        expect(await observeHostedOrdinaryJobWriterAuthority(f.manifest)).toEqual({ status: "released" });
        store.resumeOrdinary();
        const successor = store.serialized(fence => store.reserveOrdinaryRuntime(fence, f.bound.launch.command,
          f.bound.launch.args, f.bound.launch.cwd, undefined, undefined, f.sourceEnv));
        expect(successor.reservation.startId).not.toBe(first.startId);
        expect((await observeHostedOrdinaryJobWriterAuthority(f.manifest)).status).toBe("allocated");
        expect(readFileSync(join(context.fixture.root, `ordinary-completed/${first.startId}.json`))).toEqual(completion);
        expect(store.read().ordinaryStarts.map(row => row.state)).toEqual(["terminal", "reserved"]);
      } finally { f.cleanup(); }
    });
  });
}
