import { join } from "node:path";
import { expect } from "vitest";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { buildCodexGoalForegroundArgv } from "../application/codex-goal-foreground-command";
import { parseFlags } from "../codex-goal-cli-support";
import { runConfigFromFlags } from "../codex-goal-cli-run-config";
import { readCodexGoalJob } from "../codex-goal-jobs";
import { buildCodexGoalExecutorOptions } from "../codex-goal-runner";

export async function assertRefilledWorkerCheckpointRequired(input: {
  readonly registryRootDir: string;
  readonly root: string;
  readonly phaseStartSha: string;
  readonly childJobId: string;
}): Promise<void> {
  const manifest = await readCodexGoalJob({ registryRootDir: input.registryRootDir,
    jobId: input.childJobId });
  expect(manifest.checkpointRequired).toBe(true);
  const launch = await goalLaunchInput(manifest);
  const argv = buildCodexGoalForegroundArgv(launch);
  expect(argv).toContain("--require-turn-checkpoint");
  expect(argv).not.toContain("--checkpoint-publisher-socket");
  const flags = parseFlags(argv.slice(launch.cliCommand.length + 2));
  const config = runConfigFromFlags(flags, {}, input.root, manifest.jobRootDir, manifest.taskId);
  expect(config.checkpointRequired).toBe(true);
  expect(() => buildCodexGoalExecutorOptions({ config,
    initialBaseCommit: input.phaseStartSha, stateRootDir: join(input.root, "state"),
    encryptionKey: new Uint8Array(32) })).toThrow("checkpoint_publisher_required");
}
