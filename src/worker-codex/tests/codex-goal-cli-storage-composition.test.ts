import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { JobStorageHomeStateRequirement, JobStorageIntentKind, JobStorageProducer, type JobStorageAdmissionPort } from "@vioxen/subscription-runtime/worker-core";
import { CodexSessionHomeProfileKind } from "../codex-session-home-profile";

const harness = vi.hoisted(() => ({ hosted: false, ordinary: false, roots: new Set<string>(),
  route: vi.fn<typeof import("../hosted-readonly-goal-launch")["routeHostedGoalLaunch"]>(async () => undefined) }));
// Replace only host discovery/delegation. The parser, scope guard, manifest
// branch and runner/storage admission remain actual code. These TEST cases
// qualify no native owner or successful provider execution.
vi.mock("../hosted-readonly-goal-launch", async original => ({
  ...await original<typeof import("../hosted-readonly-goal-launch")>(),
  isHostedGoalLaunch: () => harness.hosted,
  routeHostedGoalLaunch: harness.route,
}));
vi.mock("../hosted-installation-activation", async original => ({
  ...await original<typeof import("../hosted-installation-activation")>(),
  isHostedOrdinaryRuntime: () => harness.ordinary,
}));
vi.mock("../hosted-child-slot-files", async original => {
  const actual = await original<typeof import("../hosted-child-slot-files")>();
  return { ...actual,
    // Only tracked TEST roots and this suite's finite non-child variants may
    // skip installed policy discovery. Unknown configuration never gets origin.
    assertVerifiedHostedChildConfig(config: Parameters<typeof actual.assertVerifiedHostedChildConfig>[0]) {
      if (config.childLifetime !== undefined) throw new Error("TEST_child_origin_unsupported");
      const root = [...harness.roots].find(root => config.jobRootDir === join(root, "job"));
      if (root === undefined) throw new Error("TEST_non_child_config_unsupported");
      const data = config.storage === undefined && config.sessionHomeProfile === undefined ? {} :
        config.sessionHomeProfile?.kind === CodexSessionHomeProfileKind.OneShot
          ? { sessionHomeProfile: { kind: CodexSessionHomeProfileKind.OneShot }, storage: {
            generationId: "TEST-generation", intent: { kind: JobStorageIntentKind.NoResume,
              homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } } }
          : { sessionHomeProfile: profile, storage };
      const job = join(root, "job"), temp = join(job, "tmp"), agentTemp = join(temp, "agent");
      const output = config.storage === undefined ? job : join(job, "output");
      if (config.outputPath !== join(output, "TEST-task.latest-result.json") &&
          config.outputPath !== join(root, "explicit-output")) throw new Error("TEST_non_child_config_unsupported");
      expect(config).toStrictEqual({ ...data, jobRootDir: job, durableHandoffRootDir: join(job, "durable-handoffs"),
        authRootDir: join(root, "TEST-auth-unused"), workspacePath: join(root, "workspace"),
        promptPath: join(root, "prompt.md"), taskId: "TEST-task", accounts: [{ name: "TEST-account" }],
        outputPath: config.outputPath, progressPath: join(output, "TEST-task.progress.json"),
        model: "gpt-6-astra", reasoningEffort: "high", serviceTier: "default", executionEngine: "app-server-goal",
        codexBinaryPath: "codex", editMode: "allow-edits", allowDangerFullAccess: false,
        taskTimeoutMs: 259_200_000, progressHeartbeatMs: 60_000, maxAccountCycles: 5,
        allowDuplicateAccountIdentities: false, requireGitWorkspace: false, prewarmOnStart: false,
        sourceEnv: { SUBSCRIPTION_RUNTIME_JOB_ROOT: job, SUBSCRIPTION_RUNTIME_TMPDIR: temp,
          TMPDIR: agentTemp, TMP: agentTemp, TEMP: agentTemp },
      });
    },
  };
});

import { buildNoTmuxShellCommand, buildTmuxCommand, parseCodexGoalCliArgs, runCodexGoalCli, upsertRunCommandManifest, type CodexGoalCliIo } from "../codex-goal-cli";

const profile = { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "TEST-session" };
const storage = { generationId: "TEST-generation", intent: { kind: JobStorageIntentKind.Continuation, sessionId: profile.sessionId } };
const roots: string[] = [];
afterEach(async () => {
  harness.hosted = false; harness.ordinary = false; harness.route.mockReset();
  harness.route.mockResolvedValue(undefined); harness.roots.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function testInput() {
  const root = await mkdtemp(join(tmpdir(), "TEST-ordinary-cli-storage-")); roots.push(root); harness.roots.add(root);
  let stdout = "", stderr = "";
  const io: CodexGoalCliIo & { readonly stdout: string; readonly stderr: string } = {
    cwd: () => root, env: () => ({}),
    writeStdout: chunk => { stdout += chunk; }, writeStderr: chunk => { stderr += chunk; },
    get stdout() { return stdout; }, get stderr() { return stderr; },
  };
  const args = ["run", "--job-root", join(root, "job"), "--auth-root", join(root, "TEST-auth-unused"),
    "--workspace", join(root, "workspace"), "--prompt", join(root, "prompt.md"),
    "--task-id", "TEST-task", "--accounts", "TEST-account", "--no-require-git-workspace"];
  return { root, io, args };
}

function newStorageArgs() {
  return ["--session-home-profile-json", JSON.stringify(profile), "--storage-json", JSON.stringify(storage)];
}

describe("actual CLI trusted storage composition", () => {
  it("reaches the actual local runner admission with immutable parsed data", async () => {
    const { root, io, args } = await testInput();
    const actualRoute = await vi.importActual<typeof import("../hosted-readonly-goal-launch")>("../hosted-readonly-goal-launch");
    harness.route.mockImplementationOnce(actualRoute.routeHostedGoalLaunch);
    let requestSeen: Parameters<JobStorageAdmissionPort["withAdmittedLifetime"]>[0] | undefined;
    const port: JobStorageAdmissionPort = { async withAdmittedLifetime(request) {
      requestSeen = request;
      throw new Error("TEST_storage_admission_refused");
    } };
    const egress = vi.fn(async () => { throw new Error("TEST_unexpected_egress"); });
    // The old CLI call dropped this object and returned native-authority-required
    // instead. The port deliberately refuses; no descriptive receipt passes.
    expect(await runCodexGoalCli([...args, ...newStorageArgs()], io,
      { runDeps: { storageAdmission: port, admitProviderEgress: egress } })).toBe(2);
    expect(io.stderr).toBe("TEST_storage_admission_refused\n");
    expect(requestSeen).toMatchObject({ jobId: "TEST-task", taskId: "TEST-task", generationId: storage.generationId,
      producerId: JobStorageProducer.CodexGoalRunner, intent: storage.intent,
      layout: { jobRoot: join(root, "job"), workspace: join(root, "workspace"),
        state: join(root, "job", "state"), home: join(root, "job", "home"), tmp: join(root, "job", "tmp") },
      providerBindingSha256: createHash("sha256").update(JSON.stringify({ backend: CodexModelBackend.OpenAiChatGpt,
        engine: "app-server-goal", accounts: ["TEST-account"], profile })).digest("hex"),
    });
    expect(Object.isFrozen(requestSeen)).toBe(true);
    expect(Object.isFrozen(requestSeen?.intent)).toBe(true);
    expect(egress).not.toHaveBeenCalled();
    expect(harness.route).not.toHaveBeenCalled();
    expect(io.stdout).toBe("");
    await expect(access(join(root, "job"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Actual ordinary-positive forwarding requires an owned host origin and is
  // still unqualified here. A discovery projection cannot replace that proof.
  // Linux UID0 must obtain separate nonoperator Source coverage for this case.
  it.runIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "refuses at the actual ordinary admission guard delegated from the CLI", async () => {
      expect(process.platform !== "linux" || process.getuid?.() !== 0).toBe(true);
      const { root, io, args } = await testInput();
      harness.hosted = true; harness.ordinary = true;
      // The actual CLI read-only owner branch must refuse before the storage
      // port; the raw router is not a substitute for that original authority.
      const admission = vi.fn(async () => { throw new Error("TEST_unexpected_admission"); });
      const egress = vi.fn(async () => { throw new Error("TEST_unexpected_egress"); });
      expect(await runCodexGoalCli([...args, ...newStorageArgs()], io, { runDeps: {
        storageAdmission: { withAdmittedLifetime: admission }, admitProviderEgress: egress,
      } })).toBe(2);
      expect(io.stderr).toBe("hosted_readonly_host_operator_required\n");
      expect(io.stdout).toBe("");
      expect(harness.route).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled(); expect(egress).not.toHaveBeenCalled();
      await expect(access(join(root, "job"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps NEW admission unavailable when the trusted port is absent", async () => {
    const { root, io, args } = await testInput();
    expect(await runCodexGoalCli([...args, ...newStorageArgs()], io)).toBe(2);
    expect(io.stderr).toBe("job_storage_lifetime_authority_required\n");
    await expect(access(join(root, "job"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps OneShot disposal unqualified even with a trusted port", async () => {
    const { io, args } = await testInput();
    const admission = vi.fn(async () => { throw new Error("TEST_unexpected_admission"); });
    const exit = await runCodexGoalCli([...args, "--session-home-profile-json", JSON.stringify({ kind: CodexSessionHomeProfileKind.OneShot }),
      "--storage-json", JSON.stringify({ generationId: "TEST-generation", intent: { kind: JobStorageIntentKind.NoResume,
        homeStateRequirement: JobStorageHomeStateRequirement.NoneRequired } })], io,
    { runDeps: { storageAdmission: { withAdmittedLifetime: admission } } });
    expect(exit).toBe(2); expect(io.stderr).toBe("job_storage_one_shot_disposal_unqualified\n");
    expect(admission).not.toHaveBeenCalled();
  });

  it.each(["tmux", "lifecycle", "hosted"])("refuses authority loss before the %s process boundary", async boundary => {
    const { root, io, args } = await testInput();
    const extra = boundary === "tmux" ? ["--tmux-session", "TEST-tmux"] : boundary === "lifecycle"
      ? ["--hosted-lifecycle", "start", "--lifecycle-job-id", "TEST-task", "--registry-root", join(root, "registry")] : [];
    harness.hosted = boundary === "hosted";
    const admission = vi.fn(async () => { throw new Error("TEST_unexpected_admission"); });
    expect(await runCodexGoalCli([...args, ...newStorageArgs(), ...extra], io,
      { runDeps: { storageAdmission: { withAdmittedLifetime: admission } } })).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_trusted_run_process_boundary_unsupported\n");
    expect(harness.route).not.toHaveBeenCalled(); expect(admission).not.toHaveBeenCalled();
    await expect(access(join(root, "job"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, "registry"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses NEW storage data alone before outer delegation", async () => {
    const { io, args } = await testInput(); harness.hosted = true;
    expect(await runCodexGoalCli([...args, ...newStorageArgs()], io)).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_trusted_run_process_boundary_unsupported\n");
    expect(harness.route).not.toHaveBeenCalled();
  });

  it("refuses trusted dependencies alone before outer delegation", async () => {
    const { io, args } = await testInput(); harness.hosted = true;
    expect(await runCodexGoalCli(args, io, { runDeps: { storageAdmission: {
      async withAdmittedLifetime() { throw new Error("TEST_unexpected_admission"); },
    } } })).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_trusted_run_process_boundary_unsupported\n");
    expect(harness.route).not.toHaveBeenCalled();
  });

  it("rejects trusted run dependencies on a different command before any effect", async () => {
    const { io } = await testInput();
    expect(await runCodexGoalCli(["help"], io, { runDeps: { storageAdmission: {
      async withAdmittedLifetime() { throw new Error("TEST_unexpected_admission"); },
    } } })).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_trusted_run_command_required\n");
    expect(io.stdout).toBe("");
  });

  it("refuses NEW registration before storing a manifest that could reload as legacy", async () => {
    const { root, io, args } = await testInput();
    const registeredArgs = [...args, ...newStorageArgs(), "--registry-root", join(root, "registry")];
    expect(await runCodexGoalCli(registeredArgs, io)).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_storage_registry_unsupported\n");
    const command = parseCodexGoalCliArgs(registeredArgs, io);
    expect(command.kind).toBe("run"); if (command.kind !== "run") return;
    await expect(upsertRunCommandManifest(command)).rejects.toThrow("codex_goal_cli_storage_registry_unsupported");
    expect(harness.route).not.toHaveBeenCalled();
    await expect(access(join(root, "registry"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves ordinary legacy delegation with absent or empty composition", async () => {
    const { io, args } = await testInput(); harness.hosted = true; harness.route.mockResolvedValue(17);
    expect(await runCodexGoalCli(args, io)).toBe(17);
    expect(await runCodexGoalCli(args, io, { runDeps: {} })).toBe(17);
    expect(harness.route).toHaveBeenCalledTimes(2); expect(io.stderr).toBe("");
  });

  it("keeps legacy previews pure and refuses a misleading NEW preview", async () => {
    const { io, args } = await testInput();
    const deps = { storageAdmission: { async withAdmittedLifetime() { throw new Error("TEST_must_not_serialize_this_authority"); } } };
    expect(await runCodexGoalCli([...args, "--dry-run"], io, { runDeps: deps })).toBe(0);
    expect(io.stdout).toContain("--task-id"); expect(io.stdout).not.toContain("TEST_must_not_serialize_this_authority");
    expect(await runCodexGoalCli([...args, ...newStorageArgs(), "--print-command"], io, { runDeps: deps })).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_storage_preview_unsupported\n");
    expect(harness.route).not.toHaveBeenCalled();
  });

  it("parses only closed storage data and preserves explicit paths for runner validation", async () => {
    const { root, io, args } = await testInput();
    const parsed = parseCodexGoalCliArgs([...args, ...newStorageArgs(), "--output", join(root, "explicit-output")], io);
    expect(parsed.kind).toBe("run"); if (parsed.kind !== "run") return;
    expect(parsed.config).toMatchObject({ sessionHomeProfile: profile, storage,
      outputPath: join(root, "explicit-output"), progressPath: join(root, "job", "output", "TEST-task.progress.json") });
    expect(await runCodexGoalCli([...args, ...newStorageArgs(), "--output", join(root, "explicit-output")], io)).toBe(2);
    expect(io.stderr).toBe("codex_goal_storage_layout_invalid\n");
  });

  it("refuses direct exported builders that cannot preserve NEW storage data", async () => {
    const { io, args } = await testInput();
    const command = parseCodexGoalCliArgs([...args, ...newStorageArgs(), "--tmux-session", "TEST-tmux"], io);
    expect(command.kind).toBe("run"); if (command.kind !== "run") return;
    expect(() => buildNoTmuxShellCommand(command)).toThrow("codex_goal_cli_storage_preview_unsupported");
    expect(() => buildTmuxCommand(command)).toThrow("codex_goal_cli_storage_preview_unsupported");
    const legacy = parseCodexGoalCliArgs([...args, "--tmux-session", "TEST-tmux"], io);
    expect(legacy.kind).toBe("run"); if (legacy.kind !== "run") return;
    expect(buildNoTmuxShellCommand(legacy)).toContain("--task-id");
    expect(buildTmuxCommand(legacy).preview).toContain("TEST-tmux");
    expect(harness.route).not.toHaveBeenCalled();
  });

  it.each([
    { ...storage, qualified: true }, { ...storage, receipt: { pinId: "TEST-fake-pin" } },
    { ...storage, intent: { ...storage.intent, storageAdmission: {} } },
    { ...storage, generationId: "../escape" }, { ...storage, intent: { ...storage.intent, sessionId: "different" } },
    null, [], { ...storage, generationId: "x".repeat(4096) },
  ].map(value => ({ value })))("rejects invalid or authority-bearing storage JSON %j", async ({ value }) => {
    const { io, args } = await testInput();
    expect(() => parseCodexGoalCliArgs([...args, "--session-home-profile-json", JSON.stringify(profile),
      "--storage-json", JSON.stringify(value)], io)).toThrow("codex_goal_cli_storage_data_invalid");
  });

  it.each([
    ["--storage-json"], ["--session-home-profile-json"], ["--storage-json", JSON.stringify(storage)],
    ["--session-home-profile-json", JSON.stringify(profile)],
  ].map(flags => ({ flags })))("rejects incomplete storage opt-in instead of falling back to legacy: %j", async ({ flags }) => {
    const { io, args } = await testInput();
    expect(() => parseCodexGoalCliArgs([...args, ...flags], io)).toThrow(/codex_goal_cli_storage_(?:data_invalid|profile_required)/);
  });

  it.each([
    [`--session-home-profile-json=${JSON.stringify(profile)}`, `--storage-json=${JSON.stringify(storage)}`],
    ["--session-home-profile-json", JSON.stringify(profile), `--storage-json=${JSON.stringify(storage)}`],
    [`--session-home-profile-json=${JSON.stringify(profile)}`, "--storage-json", JSON.stringify(storage)],
    ["--storage-json="], ["--session-home-profile-json="],
    [...newStorageArgs(), "--storage-json="], [...newStorageArgs(), "--session-home-profile-json"],
    // The generic parser stores an equals spelling as a value-map key if the
    // next token is positional, so both of its representations must fail.
    [`--storage-json=${JSON.stringify(storage)}`, "TEST-positional"],
  ].map(flags => ({ flags })))("refuses malformed NEW opt-in before a legacy launch: %j", async ({ flags }) => {
    const { root, io, args } = await testInput();
    const admission = vi.fn(async () => { throw new Error("TEST_storage_admission_refused"); });
    const egress = vi.fn(async () => { throw new Error("TEST_unexpected_legacy_egress"); });
    expect(await runCodexGoalCli([...args, ...flags], io, { runDeps: {
      storageAdmission: { withAdmittedLifetime: admission }, admitProviderEgress: egress,
    } })).toBe(2);
    expect(io.stderr).toBe("codex_goal_cli_storage_data_invalid\n");
    expect(io.stdout).toBe("");
    expect(harness.route).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled(); expect(egress).not.toHaveBeenCalled();
    await expect(access(join(root, "job"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
