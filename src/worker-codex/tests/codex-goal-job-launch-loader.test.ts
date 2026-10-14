import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  codexGoalJobManifestPath,
  createCodexGoalJob,
} from "../codex-goal-jobs";
import { loadJobLaunch } from
  "../application/codex-goal-job-launch-loader";

describe("codex goal job launch loader", () => {
  it("defaults a legacy launch root without changing the stored manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-launch-"));
    const registryRootDir = join(root, "registry");
    try {
      const created = await createCodexGoalJob({
        registryRootDir,
        manifest: {
          jobId: "legacy-job",
          jobRootDir: join(root, "job"),
          authRootDir: join(root, "auth"),
          workspacePath: join(root, "workspace"),
          promptPath: join(root, "prompt.md"),
          taskId: "legacy-task",
          accounts: ["account-a"],
        },
      });
      const path = codexGoalJobManifestPath({
        registryRootDir,
        jobId: created.jobId,
      });
      const stored = JSON.parse(await readFile(path, "utf8")) as
        Record<string, unknown>;
      delete stored.durableHandoffRootDir;
      await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);

      const loaded = await loadJobLaunch({
        registryRootDir,
        jobId: created.jobId,
      });

      expect(loaded.manifest).not.toHaveProperty("durableHandoffRootDir");
      expect(loaded.launch.config.durableHandoffRootDir).toBe(
        join(registryRootDir, "durable-handoffs"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
