import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { loadJobLaunch } from "../application/codex-goal-job-launch-loader";
import { buildCodexGoalForegroundArgv } from "../application/codex-goal-foreground-command";
import { upsertCodexGoalLaunchManifest } from "../codex-goal-launch-manifest";
import { codexGoalJobManifestPath } from "../codex-goal-jobs";

describe("ordinary registered launch policy roundtrip", () => {
  it("retains finite no-child limits and canonical handoff through real registry reload and argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-ordinary-roundtrip-"));
    try {
      await mkdir(join(root, "workspace"));
      await writeFile(join(root, "prompt.txt"), "TEST metadata only; do not execute");
      const registryRootDir = join(root, "registry");
      const handoff = join(root, "job", "durable-handoffs");
      const launch = await goalLaunchInput({
        jobId: "test-finite", taskId: "test-finite", jobRootDir: join(root, "job"),
        authRootDir: join(root, "auth"), workspacePath: join(root, "workspace"),
        promptPath: join(root, "prompt.txt"), accounts: ["TEST-account"], cwd: root,
        durableHandoffRootDir: handoff, maxGoalTurns: 1,
        safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled" },
        taskTimeoutMs: 300000, maxAccountCycles: 1,
      });
      await upsertCodexGoalLaunchManifest({ registryRootDir, launch });
      const loaded = await loadJobLaunch({ registryRootDir, jobId: "test-finite" });
      expect(loaded.manifest).toMatchObject({ durableHandoffRootDir: handoff,
        maxGoalTurns: 1, safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled" } });
      expect(loaded.launch.config.childLifetime).toBeUndefined();
      expect(loaded.launch.config).toMatchObject({ durableHandoffRootDir: handoff,
        maxGoalTurns: 1, safeExecutionPolicy: { maxAttempts: 1, continuationMode: "disabled" },
        taskTimeoutMs: 300000, maxAccountCycles: 1 });
      const args = buildCodexGoalForegroundArgv(loaded.launch);
      expect(args).toEqual(buildCodexGoalForegroundArgv(launch));
      for (const [flag, literal] of [["--durable-handoff-root", handoff],
        ["--max-goal-turns", "1"], ["--max-attempts", "1"],
        ["--continuation-mode", "disabled"], ["--timeout-ms", "300000"],
        ["--max-account-cycles", "1"]]) {
        expect(args.filter(arg => arg === flag)).toHaveLength(1);
        expect(args[args.indexOf(flag!) + 1]).toBe(literal);
      }
      // Update uses the same original upsert EEXIST path, not an alternate metadata writer.
      await upsertCodexGoalLaunchManifest({ registryRootDir, launch: {
        ...launch, config: { ...launch.config, maxGoalTurns: 2,
          safeExecutionPolicy: { maxAttempts: 3, continuationMode: "packet_first", retryOnCapacity: false } },
      } });
      expect((await loadJobLaunch({ registryRootDir, jobId: "test-finite" })).launch.config)
        .toMatchObject({ maxGoalTurns: 2,
          safeExecutionPolicy: { maxAttempts: 3, continuationMode: "packet_first", retryOnCapacity: false } });
      const path = codexGoalJobManifestPath({ registryRootDir, jobId: "test-finite" });
      const disk: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...disk, safeExecutionPolicy: { maxAttempts: 1, continuationMode: "unknown" } }));
      await expect(loadJobLaunch({ registryRootDir, jobId: "test-finite" }))
        .rejects.toThrow("codex_goal_execution_policy_invalid");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves ordinary missing policy semantics and refuses malformed explicit policy before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "TEST-ordinary-optional-"));
    const base = { taskId: "test-optional", jobRootDir: join(root, "job"),
      workspacePath: join(root, "workspace"), promptPath: join(root, "prompt"), accounts: ["TEST-account"] };
    try {
      const ordinary = await goalLaunchInput(base);
      expect(ordinary.config.maxGoalTurns).toBeUndefined();
      expect(ordinary.config.safeExecutionPolicy).toBeUndefined();
      expect(buildCodexGoalForegroundArgv(ordinary)).not.toContain("--max-attempts");
      for (const input of [{ maxGoalTurns: 0 }, { maxGoalTurns: 1.5 },
        { safeExecutionPolicy: { maxAttempts: Number.MAX_SAFE_INTEGER + 1 } },
        { safeExecutionPolicy: { maxAttempts: "1" } },
        { safeExecutionPolicy: { continuationMode: "unknown" } },
        { safeExecutionPolicy: { retryOnCapacity: "false" } },
        { safeExecutionPolicy: { maxAttempts: 1, unknown: true } }]) {
        const configPath = join(root, "invalid-config.json");
        await writeFile(configPath, JSON.stringify(input));
        await expect(goalLaunchInput({ ...base, configPath })).rejects.toThrow("codex_goal_execution_");
      }
      // Partial ordinary policies remain partial; no synthesized defaults or child authority.
      const partial = await goalLaunchInput({ ...base, safeExecutionPolicy: { retryOnCapacity: false } });
      expect(partial.config.safeExecutionPolicy).toEqual({ retryOnCapacity: false });
      expect(partial.config.childLifetime).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
