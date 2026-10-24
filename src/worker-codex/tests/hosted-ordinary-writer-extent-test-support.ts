import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import { workerPoolSlotId, type HostedOrdinaryCreator } from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId, codexProviderEgressPolicy } from "@vioxen/subscription-runtime/provider-codex";
import { CodexWorkerCacheSessionMaterializer, codexWorkerCacheRoot, codexWorkerCacheSlotKey } from "../../provider-codex/codex-session-materializer";
import { sessionArtifactFromCodexAuthJson } from "../../provider-codex/codex-auth-json-codec";
import { assertHostedOrdinaryEffectPaths, parseHostedOrdinaryWriterExtent } from "../../provider-codex/app-server/adapters/hosted-ordinary-writer-extent";
import { spawnCodexAppServerProcess } from "../../provider-codex/app-server/adapters/node-app-server-process";
import { inspectKernelPathBacking } from "../../provider-codex/app-server/adapters/kernel-path-backing";
import { codexSafeExecutorId } from "../codex-account-identity";
import { codexSessionHomeCacheKey } from "../codex-session-home-profile";
import { parseFlags } from "../codex-goal-cli-support";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { runCodexGoal } from "../codex-goal-runner";
import { runCodexGoalCli } from "../codex-goal-cli";
import { buildCodexGoalForegroundArgv, HostedGoalLifecycleOperation } from "../application/codex-goal-foreground-command";
import { goalLaunchInputFromRecord } from "../application/codex-goal-launch-input";
import { prepareCodexGoalLaunchPaths } from "../codex-goal-ops";
import { codexGoalJobToArgs, createCodexGoalJob, updateCodexGoalJob, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { tryMaterializeTerminalCodexGoalHandoff } from "../codex-goal-terminal-handoff-materialization";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { observeHostedOrdinaryJobWriterAuthority } from "../hosted-ordinary-writer-authority";
import { codexAuthJsonForAccount } from "./file-backend-codex-worker-test-support";

type Context = {
  fixture: { root: string; runtimeUnit: string; group: string; spawn: ReturnType<typeof vi.fn>; kernelMountInfoSnapshot: string };
  creator: () => HostedOrdinaryCreator;
  runtimeDirectory: string;
  read: (name: string) => Record<string, unknown>;
  put: (name: string, value: unknown) => void;
};

/** Real tmpfs paths keep FD-selected backing meaningful even when the runner's
 * /tmp is overlay. Only the parent suite's finite proc/systemd facts are synthetic. */
export function modernOrdinaryFixture(context: Context, sharedPublication = false, lifecycle?: HostedGoalLifecycleOperation) {
  const allocated = mkdtempSync("/dev/shm/TEST-ordinary-extent-"), jobId = "ordinary-job";
  // Native FD readers and file readers consume the same private, captured Linux
  // mount DATA while retaining real directory descriptors, devices and IDs.
  context.fixture.kernelMountInfoSnapshot = join(context.fixture.root, "kernel-mountinfo.DATA");
  const jobRootDir = join(allocated, "jobs", jobId), workspacePath = join(jobRootDir, "workspace"), promptPath = join(jobRootDir, "prompt.md");
  try {
    mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
    writeFileSync(promptPath, "Offline modern ordinary extent", { mode: 0o600 });
    const registryRootDir = join(allocated, "registry"), durableHandoffRootDir = join(registryRootDir, "durable-handoffs");
    const sourceEnv = { SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" };
    const launch = { command: process.execPath, args: [join(context.runtimeDirectory, "dist/worker-codex/codex-goal-cli.js"), "run",
      "--job-id", jobId, "--task-id", jobId, "--job-root", jobRootDir, "--workspace", workspacePath, "--prompt", promptPath,
      ...(sharedPublication ? ["--registry-root", registryRootDir, "--durable-handoff-root", durableHandoffRootDir] : []),
      "--auth-root", join(allocated, "auth"), "--accounts", "fake-a,fake-b", "--max-account-cycles", "1", "--no-require-git-workspace", "--no-tmux"], cwd: workspacePath };
    let config = runConfigFromFlags(parseFlags(launch.args.slice(2)), sourceEnv, workspacePath, jobRootDir, jobId);
    const bound = { ...context.creator(), jobRootDir, workspacePath, launch };
    const manifest: CodexGoalJobManifest = { schemaVersion: 1, jobId, taskId: jobId, jobRootDir, workspacePath, promptPath,
      accounts: ["fake-a", "fake-b"], createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
      ...(lifecycle ? { authRootDir: config.authRootDir, durableHandoffRootDir, maxAccountCycles: 1,
        requireGitWorkspace: false, tmuxSession: "TEST-stored-session", cwd: workspacePath, logPath: join(jobRootDir, `${jobId}.log`) } : {}) };
    if (lifecycle) {
      mkdirSync(join(registryRootDir, jobId), { recursive: true, mode: 0o700 });
      writeFileSync(join(registryRootDir, jobId, "job.json"), JSON.stringify(manifest), { mode: 0o600 });
      const stored = goalLaunchInputFromRecord(codexGoalJobToArgs(manifest), workspacePath);
      launch.args = buildCodexGoalForegroundArgv({ ...stored, registryRootDir,
        cliCommand: [join(context.runtimeDirectory, "dist/worker-codex/codex-goal-cli.js")] },
      { operation: lifecycle, jobId, confirmed: false, skipDoctor: true, forceStart: true });
      config = runConfigFromFlags(parseFlags(launch.args.slice(2)), sourceEnv, workspacePath, jobRootDir, jobId);
    }
    context.put("readonly-inventory.json", { ...context.read("readonly-inventory.json"), ordinaryCreators: [bound] });
    return { allocated, config, bound, sourceEnv, manifest, registryRootDir, durableHandoffRootDir, cleanup: () => rmSync(allocated, { recursive: true, force: true }) };
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
    // RED: generated stored-lifecycle argv gets no seal, current stored config
    // can drift before the actual inner operation, or exact terminal is ignored.
    it.each(Object.values(HostedGoalLifecycleOperation))("seals actual stored %s and rejects reloaded configuration drift", async operation => {
      const f = modernOrdinaryFixture(context, true, operation);
      try {
        const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary(f.bound.creatorId); store.resumeOrdinary();
        store.runOrdinaryRuntimeLaunch(f.bound.launch.command, f.bound.launch.args, f.bound.launch.cwd, () => undefined, undefined, f.sourceEnv);
        const row = store.read().ordinaryStarts[0]!;
        context.fixture.runtimeUnit = row.unit; context.fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${row.unit}`;
        expect((await observeHostedOrdinaryJobWriterAuthority(f.manifest)).status).toBe("allocated");
        let stdout = "", stderr = "";
        const io = { cwd: () => f.config.workspacePath, env: () => f.sourceEnv,
          writeStdout: (text: string) => { stdout += text; }, writeStderr: (text: string) => { stderr += text; } };
        expect(await runCodexGoalCli(f.bound.launch.args.slice(1), io)).toBe(1);
        expect(stderr).toBe("");
        expect(stdout).toContain(operation === HostedGoalLifecycleOperation.Start ? "confirm_start_required"
          : operation === HostedGoalLifecycleOperation.Continue ? "confirmContinue_required" : "confirmRecover_required");
        const planned = { config: f.config, cwd: f.config.workspacePath, cliCommand: [process.execPath],
          registryRootDir: f.registryRootDir, logPath: join(f.config.jobRootDir, `${f.manifest.taskId}.log`) };
        expect(existsSync(planned.logPath)).toBe(false);
        await expect(prepareCodexGoalLaunchPaths({ ...planned, config: { ...f.config, model: "TEST-unsealed-model" } }))
          .rejects.toThrow("hosted_ordinary_writer_extent_invalid");
        expect(existsSync(planned.logPath)).toBe(false);
        const manifestPath = join(f.registryRootDir, f.manifest.jobId, "job.json"), original = readFileSync(manifestPath);
        const outside = join(f.allocated, "TEST-lifecycle-outside"); mkdirSync(outside, { mode: 0o700 });
        writeFileSync(manifestPath, JSON.stringify({ ...f.manifest, outputPath: join(outside, "result.json") }));
        stdout = ""; stderr = "";
        expect(await runCodexGoalCli(f.bound.launch.args.slice(1), io)).toBe(2);
        expect(stderr).toContain("hosted_ordinary_writer_extent_invalid"); expect(readdirSync(outside)).toEqual([]);
        writeFileSync(manifestPath, original);
        await expect(prepareCodexGoalLaunchPaths({ ...planned, logPath: join(outside, "TEST.log") }))
          .rejects.toThrow("hosted_ordinary_writer_extent_invalid");
        expect(readdirSync(outside)).toEqual([]);
        const updated = await updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: f.manifest.jobId,
          patch: { description: "TEST authorized metadata update" } });
        await prepareCodexGoalLaunchPaths(planned); expect(existsSync(planned.logPath)).toBe(true);
        expect((await observeHostedOrdinaryJobWriterAuthority(updated)).status).toBe("allocated");
        context.fixture.group = "/system.slice/trusted.service"; context.fixture.runtimeUnit = "";
        store.recordOrdinaryRuntimeWaitCompletion(); store.enterExclusive(); store.finishClosed();
        expect(await observeHostedOrdinaryJobWriterAuthority(updated)).toEqual({ status: "released" });
        expect(await observeHostedOrdinaryJobWriterAuthority({ ...updated, model: "TEST-unsealed-model" })).toEqual({ status: "unknown" });
        expect(context.fixture.spawn).not.toHaveBeenCalled();
      } finally { f.cleanup(); }
    });
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
          .rejects.toThrow("hosted_ordinary_writer_extent_invalid");
        expect(prepareHome).toHaveBeenCalledTimes(fault === "home" ? 0 : 1);
        const home = fault === "home" ? outside : extent.homes[0]!.home;
        expect(() => spawnCodexAppServerProcess({ command: "/TEST/codex", args: ["app-server"], cwd: home,
          env: { ...f.sourceEnv, HOME: home, CODEX_HOME: fault === "home" ? outside : codexHome,
            SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE: CodexProviderEgressProfileId.FullInternetV1 } }))
          .toThrow(fault === "home" ? "hosted_activation_evidence_invalid" : "hosted_ordinary_writer_extent_invalid");
        expect(store.read().ordinaryStarts).toHaveLength(1);
        expect(existsSync(join(codexHome, "auth.json"))).toBe(false); expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
        expect(readdirSync(outside)).toEqual([]); expect(context.fixture.spawn).not.toHaveBeenCalled();
      } finally { f.cleanup(); }
    });
    it("materializes both configured account slots within the original lifetime seal", async () => {
      const f = modernOrdinaryFixture(context);
      try {
        const { retained, extent } = reserve(f); enter(retained.start);
        const materializedHomes: string[] = [];
        for (const [index, account] of f.config.accounts.entries()) {
          const cacheKey = codexSessionHomeCacheKey({ profile: f.config.sessionHomeProfile,
            providerInstanceId: `${f.config.taskId}-${account.name}`,
            workerId: workerPoolSlotId(codexSafeExecutorId(f.config.workspacePath), index) });
          const materializer = new CodexWorkerCacheSessionMaterializer({
            cacheKey: codexWorkerCacheSlotKey(cacheKey, 0), rootDir: join(f.config.jobRootDir, "state/codex-session-cache"),
            providerEgressPolicy: codexProviderEgressPolicy(CodexProviderEgressProfileId.FullInternetV1) });
          const authJson = codexAuthJsonForAccount(`TEST-refresh-${index}`, `TEST-account-${index}`);
          try {
            const home = await materializer.materialize({ redactor: new DefaultRedactor(), session: sessionArtifactFromCodexAuthJson(authJson) });
            try {
              expect({ home: home.home, codexHome: home.codexHome }).toEqual(extent.homes[index]);
              expect(JSON.parse(readFileSync(join(home.codexHome, "auth.json"), "utf8"))).toEqual(JSON.parse(authJson));
              expect(readFileSync(join(home.codexHome, "config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
              materializedHomes.push(home.codexHome);
            } finally { await home.release(); }
          } finally { await materializer.dispose(); }
        }
        expect(new Set(materializedHomes)).toEqual(new Set(extent.homes.map(home => home.codexHome)));
        expect(context.fixture.spawn).not.toHaveBeenCalled();
      } finally { f.cleanup(); }
    });
    // RED: shared directories become provider roots, the ordinary terminal owner
    // omits its genuine lease, or a post-await publication skips the cold guard.
    it.each(["none", "retarget", "seal-lost"] as const)("guards actual shared stored publication (%s)", async fault => {
      const f = modernOrdinaryFixture(context, true);
      try {
        const git = promisify(execFile);
        const runGit = async (args: string[]) => { await git("git", args, { cwd: f.config.workspacePath, timeout: 5_000 }); };
        await runGit(["init", "--quiet", "--initial-branch=main"]);
        await runGit(["config", "user.name", "TEST"]); await runGit(["config", "user.email", "test@example.com"]);
        writeFileSync(join(f.config.workspacePath, "tracked.txt"), "TEST base\n");
        await runGit(["add", "."]); await runGit(["commit", "--quiet", "-m", "TEST base"]);
        const store = new HostedInstallationActivationStore(); store.install(); store.enrollOrdinary(f.bound.creatorId); store.resumeOrdinary();
        store.runOrdinaryRuntimeLaunch(f.bound.launch.command, f.bound.launch.args, f.bound.launch.cwd, () => undefined, undefined, f.sourceEnv);
        const first = store.read().ordinaryStarts[0]!;
        context.fixture.runtimeUnit = first.unit;
        context.fixture.group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${first.unit}`;
        const manifest = await createCodexGoalJob({ registryRootDir: f.registryRootDir,
          manifest: { ...f.manifest, authRootDir: f.config.authRootDir, durableHandoffRootDir: f.durableHandoffRootDir } });
        const manifestPath = join(f.registryRootDir, manifest.jobId, "job.json"), before = readFileSync(manifestPath);
        expect(() => assertHostedOrdinaryEffectPaths([f.registryRootDir, f.durableHandoffRootDir])).toThrow("hosted_ordinary_writer_extent_invalid");
        await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir,
          manifest: { ...manifest, jobId: "TEST-foreign-job" } })).rejects.toThrow("hosted_ordinary_writer_extent_invalid");
        expect(existsSync(join(f.registryRootDir, "TEST-foreign-job"))).toBe(false);
        const foreignRoot = join(f.allocated, "TEST-foreign-root"), foreign = { ...manifest, jobId: "TEST-foreign-job",
          jobRootDir: foreignRoot, workspacePath: join(foreignRoot, "workspace") };
        mkdirSync(join(f.registryRootDir, foreign.jobId), { mode: 0o700 });
        writeFileSync(join(f.registryRootDir, foreign.jobId, "job.json"), JSON.stringify(foreign));
        await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: foreign, overwrite: true }))
          .rejects.toThrow("hosted_ordinary_writer_extent_invalid");
        expect(existsSync(foreignRoot)).toBe(false);
        const observation = await observeHostedOrdinaryJobWriterAuthority(manifest), shared = inspectKernelPathBacking(f.registryRootDir);
        expect(observation.status).toBe("allocated");
        if (observation.status === "allocated") expect(observation.roots.some(root => root.device === shared.device &&
          (shared.backingPath === root.backingPath || shared.backingPath.startsWith(root.backingPath + "/")))).toBe(false);
        if (fault !== "none") {
          const outside = join(f.allocated, "TEST-outside"); mkdirSync(outside, { mode: 0o700 });
          await expect(updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: manifest.jobId,
            patch: { description: "TEST changed" }, beforeManifestPublication: async () => {
              if (fault === "retarget") { renameSync(f.registryRootDir, f.registryRootDir + "-retained"); symlinkSync(outside, f.registryRootDir); }
              else rmSync(join(context.fixture.root, `ordinary-starts/${first.startId}.extent.json`));
            } })).rejects.toThrow("hosted_ordinary_writer_extent_invalid");
          expect(readFileSync(join(fault === "retarget" ? f.registryRootDir + "-retained" : f.registryRootDir, manifest.jobId, "job.json"))).toEqual(before);
          expect(readdirSync(outside)).toEqual([]);
          expect((await observeHostedOrdinaryJobWriterAuthority(manifest)).status).toBe("unknown");
        } else {
          await updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: manifest.jobId, patch: { description: "TEST changed" } });
          writeFileSync(join(f.config.workspacePath, "tracked.txt"), "TEST dirty\n");
          const handoff = await tryMaterializeTerminalCodexGoalHandoff({ jobId: manifest.jobId, taskId: manifest.taskId,
            jobRootDir: manifest.jobRootDir, workspacePath: manifest.workspacePath,
            ...(manifest.durableHandoffRootDir === undefined ? {} : { durableHandoffRootDir: manifest.durableHandoffRootDir }) });
          expect(handoff.errorCode).toBeUndefined(); expect(handoff.packetPath?.startsWith(f.durableHandoffRootDir + "/")).toBe(true);
          expect(readFileSync(join(handoff.packetPath!, "worktree.patch"), "utf8")).toContain("TEST dirty");
          context.fixture.group = "/system.slice/trusted.service"; context.fixture.runtimeUnit = "";
          store.recordOrdinaryRuntimeWaitCompletion(); store.enterExclusive(); store.finishClosed();
          expect(await observeHostedOrdinaryJobWriterAuthority(manifest)).toEqual({ status: "released" });
        }
        expect(context.fixture.spawn).not.toHaveBeenCalled();
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
