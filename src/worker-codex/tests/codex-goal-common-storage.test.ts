import { withProjectContinuationAccounts } from "../application/project-control/codex-goal-project-continuation-accounts";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { withCodexGoalMcpStorage } from "../codex-goal-mcp-inputs";
import { callToolJson } from "./codex-goal-mcp-test-support";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveCodexGoalPaths, resolveCodexGoalRunInput } from "../application/codex-goal-storage-paths";
import { goalLaunchInputFromRecord } from "../application/codex-goal-launch-input";
import { jobManifestInputFromArgs } from "../application/codex-goal-manifest-input";
import { buildCodexGoalForegroundArgv } from "../application/codex-goal-foreground-command";
import { codexGoalLaunchManifestInputFromLaunch } from "../codex-goal-launch-manifest";
import { codexGoalJobToArgs, createCodexGoalJob, readCodexGoalJob, resolveCodexGoalJobRegistryRoot } from "../codex-goal-jobs";
import { parseCodexGoalCliArgs, runCodexGoalCli, type CodexGoalCliIo } from "../codex-goal-cli";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { readOrCreateCodexGoalEncryptionKey, runCodexGoal } from "../codex-goal-runner";

const roots: string[] = [];
beforeEach(() => {
  for (const key of ["SUBSCRIPTION_RUNTIME_STORAGE_ROOT", "SUBSCRIPTION_RUNTIME_JOB_ROOT", "SUBSCRIPTION_RUNTIME_JOB_ID",
    "SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH", "SUBSCRIPTION_RUNTIME_WORKSPACE_PATH", "MEMO_STACK_GOAL_WORKSPACE_PATH"]) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function testRoot() {
  const root = await mkdtemp(join(tmpdir(), "TEST-goal-common-storage-"));
  roots.push(root);
  return root;
}
function io(root: string, env: Readonly<Record<string, string | undefined>> = {}) {
  let stdout = "";
  const value: CodexGoalCliIo = { cwd: () => root, env: () => env,
    writeStdout: text => { stdout += text; }, writeStderr: () => {} };
  return { value, stdout: () => stdout };
}

describe("Goal common storage boundaries", () => {
  it("keeps explicit grouped defaults and no-root errors, and validates both filename IDs", () => {
    const legacy = { jobRootDir: "/TEST/legacy", workspacePath: "/TEST/workspace", taskId: "task", sourceEnv: {} };
    expect(resolveCodexGoalPaths(legacy)).toEqual(legacy);
    const legacyLaunch = goalLaunchInputFromRecord({ ...legacy, promptPath: "/TEST/prompt.md", accounts: ["TEST-account"] }, "/TEST");
    expect(legacyLaunch.config).not.toHaveProperty("sourceEnv");
    expect(() => goalLaunchInputFromRecord({ storageRootDir: "", taskId: "task" }, "/TEST/cwd")).toThrow("storageRootDir");
    expect(resolveCodexGoalPaths({ ...legacy, storageRootDir: "/TEST/generic" })).toEqual({ ...legacy, storageRootDir: "/TEST/generic" });
    expect(() => resolveCodexGoalPaths({ taskId: "task", sourceEnv: {} })).toThrow("jobRootDir is required");
    expect(() => resolveCodexGoalPaths({ ...legacy, storageRootDir: "/" })).toThrow("storageRootDir");
    for (const taskId of ["../escape", "task\n"]) {
      expect(() => resolveCodexGoalPaths({ storageRootDir: "/TEST/root", jobId: "valid-job", taskId, sourceEnv: {} })).toThrow("taskId");
    }
    expect(() => resolveCodexGoalPaths({ storageRootDir: "/TEST/root", jobId: "job\n", taskId: "task", sourceEnv: {} })).toThrow("jobId");
  });

  it("keeps storage environment out of OpenAI capacity dependencies and retains MiMo credentials", async () => {
    const sourceEnv = { TEST_SECRET: "TEST-private", MIMO_TOKEN_PLAN_API_KEY: "TEST-key" };
    const launch = goalLaunchInputFromRecord({ storageRootDir: "/TEST/root", taskId: "task", promptPath: "/TEST/prompt.md",
      accounts: ["worker"] }, "/TEST", sourceEnv);
    for (const modelBackend of [undefined, CodexModelBackend.XiaomiMimoTokenPlan]) {
      const selected = { ...launch, config: { ...launch.config, ...(modelBackend === undefined ? {} : { modelBackend }) } };
      await expect(withProjectContinuationAccounts({ launch: selected, requestedAccounts: ["worker"],
        verifiedAdmittedInputPatchContinuation: true, immutableManifestAccountIds: ["worker"],
        excludedAccountIds: [], allowedAccountIds: ["worker"], listAccountStatuses: async args => {
          if (modelBackend === undefined) expect(args).not.toHaveProperty("sourceEnv");
          else expect(args.sourceEnv).toBe(selected.config.sourceEnv);
          return [];
        } })).rejects.toThrow("account_auth_unavailable");
    }
  });

  it("uses managed authority before generic defaults and rejects caller writable overrides", () => {
    const sourceEnv = { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1", SUBSCRIPTION_RUNTIME_JOB_ROOT: "/TEST/managed/jobs/job", SUBSCRIPTION_RUNTIME_JOB_ID: "job" };
    const input = { storageRootDir: "/TEST/generic", jobId: "job", taskId: "task", sourceEnv };
    expect(resolveCodexGoalPaths(input)).toMatchObject({ jobRootDir: "/TEST/managed/jobs/job", runtimeHomeRootDir: "/TEST/managed/jobs/job/home" });
    expect(resolveCodexGoalJobRegistryRoot(input)).toBe("/TEST/managed/jobs/job/state/registry");
    for (const key of ["jobRootDir", "runtimeHomeRootDir", "runtimeEventsPath", "agentTempRootDir", "logPath"] as const) {
      expect(() => resolveCodexGoalPaths({ ...input, [key]: "/TEST/escape" })).toThrow(key);
    }
    expect(() => resolveCodexGoalPaths({ ...input, storageRootDir: "/" })).toThrow("storageRootDir");
    expect(() => resolveCodexGoalPaths({ ...input, taskId: "task\n" })).toThrow("taskId");
  });

  it("rejects an unsafe root/task before SDK filesystem effects", async () => {
    const root = await testRoot();
    for (const input of [{ storageRootDir: "/", taskId: "task" }, { storageRootDir: join(root, "selected"), taskId: "../escape" }]) {
      await expect(runCodexGoal({ ...input, jobId: "valid-job", workspacePath: root,
        authRootDir: join(root, "unused-auth"), promptPath: join(root, "missing-prompt"), accounts: [], sourceEnv: {} })).rejects.toThrow(/storageRootDir|taskId/);
    }
    await expect(access(join(root, "selected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round trips home/key/state/output/log/events/temp/handoff through manifest and foreground transport", async () => {
    const root = await testRoot();
    const launch = goalLaunchInputFromRecord({ storageRootDir: root, jobId: "job", taskId: "task", promptPath: join(root, "prompt.md"), accounts: ["TEST-account"] }, root);
    const expectedJob = join(root, "jobs", "job");
    expect(launch.config).toMatchObject({ jobRootDir: expectedJob, workspacePath: join(expectedJob, "workspace"),
      stateRootDir: join(expectedJob, "state"), runtimeHomeRootDir: join(expectedJob, "home"),
      encryptionKeyPath: join(expectedJob, "state", "encryption-key.hex"), outputPath: join(expectedJob, "output", "task.latest-result.json"),
      progressPath: join(expectedJob, "output", "task.progress.json"), runtimeEventsPath: join(expectedJob, "output", "task.events.jsonl"),
      agentTempRootDir: join(expectedJob, "tmp", "agent"), durableHandoffRootDir: join(expectedJob, "durable-handoffs") });
    expect(launch.logPath).toBe(join(expectedJob, "logs", "task.log"));
    const registryRootDir = resolveCodexGoalJobRegistryRoot({ storageRootDir: root });
    await createCodexGoalJob({ registryRootDir, manifest: codexGoalLaunchManifestInputFromLaunch(launch) });
    const manifest = await readCodexGoalJob({ registryRootDir, jobId: "job" });
    expect(manifest).not.toHaveProperty("storageRootDir");
    const key = "a".repeat(64);
    await mkdir(join(expectedJob, "state"), { recursive: true });
    await writeFile(launch.config.encryptionKeyPath!, `${key}\n`);
    for (const changed of [join(root, "other-root"), undefined]) {
      vi.stubEnv("SUBSCRIPTION_RUNTIME_STORAGE_ROOT", changed);
      vi.stubEnv("SUBSCRIPTION_RUNTIME_TMPDIR", join(root, "changed-tmp"));
      const restored = goalLaunchInputFromRecord(codexGoalJobToArgs(manifest), root);
      for (const field of ["jobRootDir", "runtimeHomeRootDir", "encryptionKeyPath", "stateRootDir", "workspacePath", "outputPath", "progressPath", "runtimeEventsPath", "agentTempRootDir", "durableHandoffRootDir"] as const) {
        expect(restored.config[field]).toBe(launch.config[field]);
      }
      expect(restored.logPath).toBe(launch.logPath);
      expect(Buffer.from(await readOrCreateCodexGoalEncryptionKey(restored.config.encryptionKeyPath!)).toString("hex")).toBe(key);
      expect(restored.config.sourceEnv).toMatchObject({ SUBSCRIPTION_RUNTIME_JOB_ROOT: expectedJob,
        SUBSCRIPTION_RUNTIME_TMPDIR: join(expectedJob, "tmp"), TMPDIR: join(expectedJob, "tmp", "agent") });
      const argv = buildCodexGoalForegroundArgv(restored);
      const command = parseCodexGoalCliArgs(argv.slice(restored.cliCommand.length), io(root).value);
      expect(command.kind).toBe("run");
      if (command.kind !== "run") throw new Error("expected foreground run");
      expect(command.config.encryptionKeyPath).toBe(launch.config.encryptionKeyPath);
      expect(command.config.runtimeHomeRootDir).toBe(launch.config.runtimeHomeRootDir);
      expect(command.logPath).toBe(launch.logPath);
      expect(resolveCodexGoalRunInput(command.config).sourceEnv?.TMPDIR).toBe(join(expectedJob, "tmp", "agent"));
    }
  });

  it("finds root-selected registry through an actual CLI shortcut and captured MCP resource", async () => {
    const root = await testRoot();
    const registryRootDir = resolveCodexGoalJobRegistryRoot({ storageRootDir: root });
    await createCodexGoalJob({ registryRootDir, manifest: jobManifestInputFromArgs({ storageRootDir: root,
      jobId: "job", taskId: "task", promptPath: join(root, "prompt.md"), accounts: ["TEST-account"] }) });
    const cli = io(root);
    expect(await runCodexGoalCli(["overview", "--storage-root", root, "--format", "json"], cli.value)).toBe(0);
    expect(cli.stdout()).toContain('"jobId": "job"');
    const env = { SUBSCRIPTION_RUNTIME_STORAGE_ROOT: root, TEST_SERVER_SECRET: "TEST-secret-must-stay-in-env" };
    const remoteArgs = { mimoProjectId: "TEST-project", mimoWorkstreamId: "TEST-stream", jobId: "job" };
    expect(withCodexGoalMcpStorage({ sourceEnv: env }, args => args)(remoteArgs)).toBe(remoteArgs);
    const server = createCodexGoalMcpServer({ sourceEnv: env });
    env.SUBSCRIPTION_RUNTIME_STORAGE_ROOT = join(root, "changed");
    const client = new Client({ name: "TEST-common-storage", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = JSON.stringify(await callToolJson(client, "codex_goal_list_jobs", {}));
      expect(listed).toContain('"jobId":"job"');
      expect(listed).not.toContain(env.TEST_SERVER_SECRET);
      await callToolJson(client, "codex_goal_create_job", { jobId: "server-job", taskId: "server-task",
        promptPath: join(root, "prompt.md"), accounts: ["TEST-account"] });
      const stored = await readCodexGoalJob({ registryRootDir, jobId: "server-job" });
      expect(JSON.stringify(stored)).not.toContain(env.TEST_SERVER_SECRET);
      expect(stored).toMatchObject({
        jobRootDir: join(root, "jobs", "server-job"), runtimeHomeRootDir: join(root, "jobs", "server-job", "home") });
      expect(JSON.stringify(await callToolJson(client, "codex_goal_get_job", { jobId: "server-job" }))).toContain(join(root, "jobs", "server-job"));
      expect((await client.listResources()).resources).toContainEqual(expect.objectContaining({ uri: "codex-goal://jobs/job" }));
      const resource = await client.readResource({ uri: "codex-goal://jobs/job" });
      expect(resource.contents).toContainEqual(expect.objectContaining({ text: expect.stringContaining('"jobId": "job"') }));
    } finally {
      await client.close(); await server.close();
    }
    expect(resolveCodexGoalJobRegistryRoot({ storageRootDir: root, registryRootDir: join(root, "explicit") })).toBe(join(root, "explicit"));
  });
});
