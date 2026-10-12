import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSubscriptionAgentRuntimeTaskCli, type AgentRuntimeTaskWorkerFactoryInput } from "../agent-runtime-task-runner-cli";
import { fakeAgentRuntimeTaskCliIo as fakeIo, fakeAgentRuntimeTaskWorkerFactory as fakeFactory } from "./agent-runtime-task-runner-cli-test-support";

describe("common storage CLI precedence and owned cleanup", () => {
  it("allocates unique ephemeral roots ahead of state env, preserves explicit state and durable siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-common-agent-storage-"));
    const sibling = join(root, "tmp", "owned-by-other-job");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "sentinel"), "retained");
    const envState = join(root, "existing-state"), explicitState = join(root, "explicit-state");
    await mkdir(envState); await mkdir(explicitState);
    await writeFile(join(explicitState, "sentinel"), "retained");
    const observed: string[] = [];
    const request = JSON.stringify({ protocolVersion: 1, task: { kind: "review", prompt: "TEST review" } });
    const env = { SUBSCRIPTION_RUNTIME_STORAGE_ROOT: root, SUBSCRIPTION_RUNTIME_STATE_ROOT: envState,
      SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
    const run = async (flags: string[], sourceEnv: Readonly<Record<string, string | undefined>> = env) => {
      const calls: { factory?: AgentRuntimeTaskWorkerFactoryInput } = {};
      const delegate = fakeFactory(calls);
      return runSubscriptionAgentRuntimeTaskCli(["--provider", "codex", ...flags], fakeIo({ stdin: request, cwd: root, env: sourceEnv }), input => {
        observed.push(input.stateRootDir);
        return delegate(input);
      });
    };
    try {
      expect(await Promise.all([run(["--ephemeral"]), run(["--ephemeral"])] )).toEqual([0, 0]);
      const temporary = [...observed];
      expect(new Set(temporary).size).toBe(2);
      for (const path of temporary) {
        expect(path.startsWith(join(root, "tmp", "subscription-runtime-agent-runtime-task-"))).toBe(true);
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await run(["--ephemeral", "--state-root", explicitState])).toBe(0);
      expect(observed.at(-1)).toBe(explicitState);
      expect(await readFile(join(explicitState, "sentinel"), "utf8")).toBe("retained");
      expect(await run([])).toBe(0);
      expect(observed.at(-1)).toBe(envState);
      expect(await run([], { ...env, SUBSCRIPTION_RUNTIME_STATE_ROOT: undefined })).toBe(0);
      expect(observed.at(-1)).toBe(join(root, "state", "agent-runtime-task", "codex"));
      expect(await readFile(join(sibling, "sentinel"), "utf8")).toBe("retained");
      const stderr: string[] = [];
      expect(await runSubscriptionAgentRuntimeTaskCli(["--provider", "codex", "--storage-root", "/", "--state-root", explicitState,
        "--input", join(root, "missing-request.json")], fakeIo({ stdin: request, cwd: root, env, stderr }), fakeFactory({}))).toBe(2);
      expect(stderr.join("")).toContain("Invalid runtime storageRootDir");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
