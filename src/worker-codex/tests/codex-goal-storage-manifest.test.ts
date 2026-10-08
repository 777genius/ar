import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import "./unmanaged-goal-host-fixture";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStorageHomeStateRequirement, JobStorageIntentKind } from "@vioxen/subscription-runtime/worker-core";
import { CodexSessionHomeProfileKind } from "../codex-session-home-profile";
import { codexGoalAccountSlots, runCodexGoal, type CodexGoalRunConfig } from "../codex-goal-runner";
import { codexGoalJobManifestPath, createCodexGoalJob, parseCodexGoalJobManifest,
  readCodexGoalJob, updateCodexGoalJob, type CodexGoalJobManifestPatch } from "../codex-goal-jobs";
import { codexGoalLaunchManifestInputFromLaunch, upsertCodexGoalLaunchManifest } from "../codex-goal-launch-manifest";
import { loadJobLaunch } from "../application/codex-goal-job-launch-loader";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { buildCodexGoalForegroundArgv } from "../application/codex-goal-foreground-command";
import { jobManifestInputFromArgs, jobManifestPatchFromArgs } from "../application/codex-goal-manifest-input";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { parseFlags } from "../codex-goal-cli-support";

const continuation = { sessionHomeProfile: { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "TEST-session" },
  storage: { generationId: "TEST-generation", intent: { kind: JobStorageIntentKind.Continuation, sessionId: "TEST-session" } } } as const;
const oneShot = { sessionHomeProfile: { kind: CodexSessionHomeProfileKind.OneShot },
  storage: { generationId: "TEST-generation", intent: { kind: JobStorageIntentKind.NoResume,
    homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } } } as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(data: Pick<CodexGoalRunConfig, "sessionHomeProfile" | "storage"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "TEST-storage-manifest-")); roots.push(root);
  const config = { jobId: "TEST-job", taskId: "TEST-task", jobRootDir: join(root, "job"),
    workspacePath: join(root, "workspace"), promptPath: join(root, "prompt.md"),
    authRootDir: join(root, "auth-unused"), accounts: codexGoalAccountSlots(["TEST-account"]),
    requireGitWorkspace: false, ...data };
  const launch = { config, cwd: root, logPath: join(root, "log"), cliCommand: ["node", "goal.js"] };
  return { root, launch, registryRootDir: join(root, "registry") };
}

describe("ordinary storage data manifest chain", () => {
  // Old serializers lose explicit NEW intent and reload as legacy. Real disk
  // publication/reopen, application loader and foreground parser catch that loss.
  it.each([continuation, oneShot])("roundtrips %j without reconstructing authority from data", async data => {
    const f = await fixture(data);
    const projected = codexGoalLaunchManifestInputFromLaunch(f.launch);
    expect(projected).toMatchObject(data);
    const created = await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch: f.launch });
    const path = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: created.jobId });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject(data);
    const loaded = await loadJobLaunch({ registryRootDir: f.registryRootDir, jobId: created.jobId });
    expect(loaded.manifest).toMatchObject(data);
    expect(loaded.launch.config).toMatchObject({ ...data, stateRootDir: join(f.root, "job", "state"),
      runtimeHomeRootDir: join(f.root, "job", "home"), durableHandoffRootDir: join(f.root, "job", "durable-handoffs"),
      outputPath: join(f.root, "job", "output", "TEST-task.latest-result.json"),
      progressPath: join(f.root, "job", "output", "TEST-task.progress.json") });
    const argv = buildCodexGoalForegroundArgv(loaded.launch);
    const parsed = runConfigFromFlags(parseFlags(argv.slice(loaded.launch.cliCommand.length + 1)), {}, f.root,
      loaded.launch.config.jobRootDir, loaded.launch.config.taskId);
    expect(parsed).toMatchObject(data);
    const createExecutor = vi.fn(() => { throw new Error("TEST_unexpected_executor"); });
    const admitProviderEgress = vi.fn(async () => { throw new Error("TEST_unexpected_egress"); });
    await expect(runCodexGoal(parsed, { createExecutor, admitProviderEgress })).rejects.toThrow(
      data.sessionHomeProfile.kind === CodexSessionHomeProfileKind.OneShot
        ? "job_storage_one_shot_disposal_unqualified" : "job_storage_lifetime_authority_required");
    expect(createExecutor).not.toHaveBeenCalled(); expect(admitProviderEgress).not.toHaveBeenCalled();
    await expect(access(join(f.root, "job"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).not.toMatch(/receiptSha256|pinId|assertCurrent|storageAdmission/);
  });

  it("preserves a nondefault NEW backend through real disk, loader and foreground parser", async () => {
    const f = await fixture(continuation);
    const launch = { ...f.launch, config: { ...f.launch.config, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan } };
    const created = await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch });
    expect(created.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
    const loaded = await loadJobLaunch({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    expect(loaded.launch.config.modelBackend).toBe(CodexModelBackend.XiaomiMimoTokenPlan);
    const argv = buildCodexGoalForegroundArgv(loaded.launch);
    const parsed = runConfigFromFlags(parseFlags(argv.slice(loaded.launch.cliCommand.length + 1)),
      { CODEX_MODEL_BACKEND: CodexModelBackend.OpenAiChatGpt }, f.root, launch.config.jobRootDir, "TEST-task");
    expect(parsed).toMatchObject({ ...continuation, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan });
    await expect(runCodexGoal(parsed)).rejects.toThrow("job_storage_lifetime_authority_required");
    await expect(access(launch.config.jobRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects NEW custom credential-slot configuration before projection, publication or foreground transport", async () => {
    const f = await fixture(continuation);
    const config = { ...f.launch.config, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      mimoAccounts: [{ name: "TEST-account", envVarName: "TEST_MIMO_KEY" }] };
    expect(() => codexGoalLaunchManifestInputFromLaunch({ ...f.launch, config }))
      .toThrow("codex_goal_storage_provider_transport_unsupported");
    expect(() => buildCodexGoalForegroundArgv({ ...f.launch, config }))
      .toThrow("codex_goal_storage_provider_transport_unsupported");
    await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir,
      manifest: { ...codexGoalLaunchManifestInputFromLaunch(f.launch), modelBackend: config.modelBackend, mimoAccounts: config.mimoAccounts } }))
      .rejects.toThrow("codex_goal_storage_provider_transport_unsupported");
    for (const account of [{ name: "TEST-account", envVarName: "TEST_MIMO_KEY" },
      { name: "TEST-account", authJsonPath: join(f.root, "untransported-auth") }]) {
      expect(() => codexGoalLaunchManifestInputFromLaunch({ ...f.launch, config: { ...f.launch.config, accounts: [account] } }))
        .toThrow("codex_goal_storage_provider_transport_unsupported");
    }
    await expect(access(f.registryRootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds NEW effective provider defaults against ambient CLI override", async () => {
    const f = await fixture(continuation), argv = buildCodexGoalForegroundArgv(f.launch);
    const parsed = runConfigFromFlags(parseFlags(argv.slice(f.launch.cliCommand.length + 1)),
      { CODEX_MODEL_BACKEND: CodexModelBackend.XiaomiMimoTokenPlan, CODEX_EXECUTION_ENGINE: "plain-exec" },
      f.root, f.launch.config.jobRootDir, "TEST-task");
    expect(parsed.modelBackend).toBe(CodexModelBackend.OpenAiChatGpt);
    expect(parsed.executionEngine).toBe("app-server-goal");
  });

  it("rejects provider, ordered-account and task/layout rebind with unchanged persisted bytes; legacy edits remain allowed", async () => {
    const f = await fixture(continuation);
    const launch = { ...f.launch, config: { ...f.launch.config, accounts: codexGoalAccountSlots(["TEST-account", "TEST-other"]) } };
    const stored = await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch });
    const path = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    // Explicit defaults and omission represent the same actual runner tuple.
    await updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job",
      patch: { modelBackend: CodexModelBackend.OpenAiChatGpt, executionEngine: "app-server-goal" } });
    const before = await readFile(path, "utf8");
    const changes: readonly CodexGoalJobManifestPatch[] = [{ modelBackend: CodexModelBackend.XiaomiMimoTokenPlan }, { executionEngine: "plain-exec" as const },
      { accounts: ["TEST-other", "TEST-account"] }, { taskId: "TEST-other-task" }, { workspacePath: join(f.root, "other-workspace") }];
    for (const patch of changes) {
      await expect(updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job", patch }))
        .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
      await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: { ...stored, ...patch }, overwrite: true }))
        .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
      expect(await readFile(path, "utf8")).toBe(before);
    }
    await expect(upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir,
      launch: { ...launch, config: { ...launch.config, modelBackend: CodexModelBackend.XiaomiMimoTokenPlan } } }))
      .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
    expect(await readFile(path, "utf8")).toBe(before);
    const legacy = await fixture();
    await upsertCodexGoalLaunchManifest({ registryRootDir: legacy.registryRootDir, launch: legacy.launch });
    expect(await updateCodexGoalJob({ registryRootDir: legacy.registryRootDir, jobId: "TEST-job",
      patch: { modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, accounts: ["TEST-other"] } }))
      .toMatchObject({ modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, accounts: ["TEST-other"] });
  });

  it("rejects top-level pair getters before actual create/update spreads and snapshots pair before the real update read", async () => {
    const f = await fixture(continuation), manifest = codexGoalLaunchManifestInputFromLaunch(f.launch);
    for (const key of ["storage", "sessionHomeProfile"] as const) {
      const hook = vi.fn(() => continuation[key]);
      const candidate = { ...manifest };
      Object.defineProperty(candidate, key, { get: hook });
      await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: candidate }))
        .rejects.toThrow("codex_goal_storage_data_invalid");
      expect(hook).not.toHaveBeenCalled();
      await expect(access(f.registryRootDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest });
    const path = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    const before = await readFile(path, "utf8");
    for (const key of ["storage", "sessionHomeProfile"] as const) {
      const hook = vi.fn(() => continuation[key]), patch = { ...continuation };
      Object.defineProperty(patch, key, { get: hook });
      await expect(updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job", patch }))
        .rejects.toThrow("codex_goal_storage_data_invalid");
      expect(hook).not.toHaveBeenCalled(); expect(await readFile(path, "utf8")).toBe(before);
    }
    const patch = structuredClone(continuation);
    const pending = updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job", patch });
    // Actual helper awaits readFile before the mutation effect. A later caller
    // mutation must not change the already captured immutable pair.
    Object.assign(patch.storage, { generationId: "TEST-mutated" });
    Object.assign(patch.sessionHomeProfile, { sessionId: "TEST-mutated" });
    expect(await pending).toMatchObject(continuation);
  });

  // Without the effective layout comparison, each actual publication succeeds
  // and replaces bytes that the later NEW runtime layout guard cannot accept.
  it("refuses four NEW layout rebindings through update, overwrite and upsert without changing manifest bytes", async () => {
    const f = await fixture(continuation), root = f.launch.config.jobRootDir;
    const defaults = { stateRootDir: join(root, "state"),
      outputPath: join(root, "output", "TEST-task.latest-result.json"),
      progressPath: join(root, "output", "TEST-task.progress.json"),
      durableHandoffRootDir: join(root, "durable-handoffs") };
    const stored = await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch: f.launch });
    const path = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    const before = await readFile(path, "utf8");
    for (const field of ["stateRootDir", "outputPath", "progressPath", "durableHandoffRootDir"] as const) {
      const patch: Pick<CodexGoalJobManifestPatch, keyof typeof defaults> = { [field]: join(root, "TEST-changed-" + field) };
      await expect(updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job", patch }))
        .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
      expect(await readFile(path, "utf8")).toBe(before);
      await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: { ...stored, ...patch }, overwrite: true }))
        .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
      expect(await readFile(path, "utf8")).toBe(before);
      await expect(upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir,
        launch: { ...f.launch, config: { ...f.launch.config, ...patch } } }))
        .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
      expect(await readFile(path, "utf8")).toBe(before);
    }
    expect(await updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job",
      patch: { ...defaults, description: "same effective NEW layout" } })).toMatchObject(defaults);
    expect((await loadJobLaunch({ registryRootDir: f.registryRootDir, jobId: "TEST-job" })).launch.config)
      .toMatchObject({ ...continuation, ...defaults });
  });

  // The real config-file await must not select a later caller-owned generation
  // or session, and malformed explicit input must fail before reading any file.
  it("captures the caller storage pair before config-file IO", async () => {
    const f = await fixture(), configPath = join(f.root, "TEST-config.json");
    await writeFile(configPath, JSON.stringify({ ...f.launch.config, accounts: ["TEST-account"] }));
    const args = { configPath, ...structuredClone(continuation) };
    const pending = goalLaunchInput(args);
    Object.assign(args.storage, { generationId: "TEST-mutated",
      intent: { kind: JobStorageIntentKind.Continuation, sessionId: "TEST-mutated" } });
    Object.assign(args.sessionHomeProfile, { sessionId: "TEST-mutated" });
    expect((await pending).config).toMatchObject(continuation);
    await expect(goalLaunchInput({ configPath: join(f.root, "TEST-missing.json"), storage: continuation.storage }))
      .rejects.toThrow("codex_goal_storage_data_profile_required");
  });

  it("keeps omitted legacy fields and defaults across publication, reload and argv", async () => {
    const f = await fixture();
    await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch: f.launch });
    const loaded = await loadJobLaunch({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    expect(loaded.manifest).not.toHaveProperty("storage");
    expect(loaded.manifest).not.toHaveProperty("sessionHomeProfile");
    expect(loaded.launch.config).not.toHaveProperty("runtimeHomeRootDir");
    expect(loaded.launch.config.outputPath).toBe(join(f.root, "job", "TEST-task.latest-result.json"));
    expect(loaded.launch.config.durableHandoffRootDir).toBe(join(f.registryRootDir, "durable-handoffs"));
    expect(buildCodexGoalForegroundArgv(loaded.launch)).not.toContain("--storage-json");
  });

  it("preserves identical data in upsert/update and refuses generation rebind, downgrade and legacy migration", async () => {
    const f = await fixture(continuation);
    await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch: f.launch });
    await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch: f.launch,
      metadata: { description: "same generation" } });
    expect(await readCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job" })).toMatchObject(continuation);
    const path = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    const before = await readFile(path, "utf8");
    await expect(updateCodexGoalJob({ registryRootDir: f.registryRootDir, jobId: "TEST-job",
      patch: { ...continuation, storage: { ...continuation.storage, generationId: "TEST-new-generation" } } }))
      .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
    const { storage: _storage, sessionHomeProfile: _profile, ...legacyConfig } = f.launch.config;
    const legacyProjection = codexGoalLaunchManifestInputFromLaunch({ ...f.launch, config: legacyConfig });
    await expect(upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir,
      launch: { ...f.launch, config: legacyConfig } })).rejects.toThrow("codex_goal_storage_manifest_binding_changed");
    await expect(createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: legacyProjection, overwrite: true }))
      .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
    expect(await readFile(path, "utf8")).toBe(before);
    const legacy = await fixture();
    await upsertCodexGoalLaunchManifest({ registryRootDir: legacy.registryRootDir, launch: legacy.launch });
    await expect(updateCodexGoalJob({ registryRootDir: legacy.registryRootDir, jobId: "TEST-job", patch: continuation }))
      .rejects.toThrow("codex_goal_storage_manifest_binding_changed");
  });

  it("snapshots caller-owned data for manifest projection and serializes no callback from the input", async () => {
    const f = await fixture();
    const data = structuredClone(continuation);
    const launch = { ...f.launch, config: { ...f.launch.config, ...data, storageAdmission: () => { throw new Error("TEST_callback"); } } };
    const projection = codexGoalLaunchManifestInputFromLaunch(launch);
    Object.assign(data.storage, { generationId: "TEST-mutated" });
    Object.assign(data.sessionHomeProfile, { sessionId: "TEST-mutated" });
    expect(projection).toMatchObject(continuation);
    expect(Object.isFrozen(projection.storage?.intent)).toBe(true);
    const stored = await createCodexGoalJob({ registryRootDir: f.registryRootDir, manifest: projection });
    expect(stored).not.toHaveProperty("storageAdmission");
    expect(JSON.stringify(stored)).not.toContain("TEST_callback");
  });

  it("forwards closed data through ordinary application create/update and config-file launch inputs", async () => {
    const f = await fixture();
    const input = { ...f.launch.config, accounts: ["TEST-account"], ...continuation };
    expect(jobManifestInputFromArgs(input)).toMatchObject(continuation);
    expect(jobManifestPatchFromArgs({ jobId: "TEST-job", ...continuation })).toMatchObject(continuation);
    const configPath = join(f.root, "config.json");
    await writeFile(configPath, JSON.stringify(input));
    expect((await goalLaunchInput({ configPath })).config).toMatchObject(continuation);
    await writeFile(configPath, JSON.stringify({ ...input, storage: null }));
    await expect(goalLaunchInput({ configPath, ...continuation })).rejects.toThrow("codex_goal_storage_data_invalid");
  });

  it.each([
    { sessionHomeProfile: continuation.sessionHomeProfile },
    { storage: continuation.storage },
    { ...continuation, storage: null },
    { ...continuation, storage: { ...continuation.storage, generationId: "../escape" } },
    { ...continuation, storage: { ...continuation.storage, receiptSha256: "a".repeat(64) } },
    { ...continuation, storage: { ...continuation.storage, qualified: true } },
    { ...continuation, storage: { ...continuation.storage, assertCurrent: () => undefined } },
    { ...continuation, storage: { ...continuation.storage, intent: { ...continuation.storage.intent, sessionId: "other" } } },
    { ...continuation, sessionHomeProfile: { ...continuation.sessionHomeProfile, nativeVerified: true } },
    { ...oneShot, storage: { ...oneShot.storage, intent: { kind: JobStorageIntentKind.NoResume, homeStateRequirement: "required" } } },
    { ...oneShot, sessionHomeProfile: { kind: CodexSessionHomeProfileKind.OneShot, sessionId: "forbidden" } },
  ])("rejects malformed storage binding instead of dropping it: %j", async malformed => {
    const f = await fixture();
    const manifest = { ...codexGoalLaunchManifestInputFromLaunch(f.launch), schemaVersion: 1,
      createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z", ...malformed };
    expect(() => parseCodexGoalJobManifest(manifest)).toThrow();
  });

  it("refuses a malformed persisted NEW manifest on reopen and does not evaluate serialization hooks", async () => {
    const f = await fixture(continuation);
    const stored = await upsertCodexGoalLaunchManifest({ registryRootDir: f.registryRootDir, launch: f.launch });
    const path = codexGoalJobManifestPath({ registryRootDir: f.registryRootDir, jobId: "TEST-job" });
    await writeFile(path, JSON.stringify({ ...stored, storage: { ...stored.storage, authority: { nativeVerified: true } } }));
    await expect(loadJobLaunch({ registryRootDir: f.registryRootDir, jobId: "TEST-job" })).rejects.toThrow("codex_goal_storage_data_invalid");
    const hook = vi.fn(() => continuation.storage.generationId);
    const storage = { ...continuation.storage };
    Object.defineProperty(storage, "generationId", { get: hook });
    expect(() => codexGoalLaunchManifestInputFromLaunch({ ...f.launch, config: { ...f.launch.config, storage } }))
      .toThrow("codex_goal_storage_data_invalid");
    expect(hook).not.toHaveBeenCalled();
  });
});
