import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackendCodexWorker } from "../file-backend-codex-worker";
import { StaticRunner, validAuthJson } from "./file-backend-codex-worker-test-support";
import { parseCodexGoalCliArgs } from "../codex-goal-cli";
import { describe, expect, it } from "vitest";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { jobManifestInputFromArgs } from "../application/codex-goal-manifest-input";

const input = {
  jobId: "fake-default-profile", taskId: "fake-task", jobRootDir: "/tmp/fake-default-profile",
  workspacePath: "/tmp/fake-workspace", promptPath: "/tmp/fake-prompt.md", accounts: ["fake-account"],
};
describe("public Codex worker defaults", () => {
  it.each([false, true])("uses the same model/effort in plain-exec command and capacity (override=%s)", async (override) => {
    const root = await mkdtemp(join(tmpdir(), "fake-worker-defaults-"));
    const workspace = await mkdtemp(join(tmpdir(), "fake-worker-default-workspace-"));
    const runner = new StaticRunner({ exitCode: 0, stdout: "fake output", stderr: "" });
    const model = override ? "gpt-5.6-sol" : "gpt-6-astra";
    const reasoningEffort = override ? "medium" : "high";
    const worker = new FileBackendCodexWorker({
      codexBinaryPath: "fake-codex",
      providerInstanceId: "codex:fake-defaults", stateRootDir: root, workspacePath: workspace,
      encryptionKey: new Uint8Array(32).fill(13), executionEngine: "plain-exec", runner,
      ...(override ? { model, reasoningEffort } : {}),
    });
    try {
      await worker.start();
      await worker.seedCodexAuthJson(validAuthJson);
      expect(worker.capacity().details).toMatchObject({ capacityModel: model, capacityReasoningEffort: reasoningEffort });
      await worker.run({ prompt: "fake test", controls: { editMode: "allow-edits" } });
      expect(runner.lastArgs).toEqual(expect.arrayContaining(["--model", model, "--config", `model_reasoning_effort="${reasoningEffort}"`]));
    } finally {
      await worker.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it("forwards opaque watch cursors through both CLI aliases", () => {
    for (const command of ["run-watch", "agent-run-watch"]) {
      const parsed = parseCodexGoalCliArgs([command, "--cursor", "opaque-watch-cursor"], {
        writeStdout() {}, writeStderr() {}, cwd: () => "/tmp", env: () => ({}),
      });
      expect(parsed.kind).toBe("mcp-tool");
      if (parsed.kind !== "mcp-tool") throw new Error("wrong_command");
      expect(JSON.parse(parsed.argsJson ?? "{}")).toMatchObject({ cursor: "opaque-watch-cursor" });
    }
  });
  it("defaults both launch and manifest inputs to exact Astra/high", async () => {
    expect((await goalLaunchInput(input)).config).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "high" });
    expect(jobManifestInputFromArgs(input)).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "high" });
  });
  it("preserves explicit model and reasoning overrides", async () => {
    const override = { ...input, model: "gpt-5.6-sol", reasoningEffort: "medium" as const };
    expect((await goalLaunchInput(override)).config).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
    expect(jobManifestInputFromArgs(override)).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium" });
  });
});
