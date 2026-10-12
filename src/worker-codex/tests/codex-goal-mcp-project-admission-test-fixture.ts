import { host, setupResearchFixture, cleanupResearchFixture, researchScratchBackingPath } from "./research-launch-fixture";
import { mkdir } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeEach, afterEach, describe as testDescribe, expect } from "vitest";
import { readCodexGoalJob } from "../codex-goal-jobs";
import { observeProtectedCodexGoalJobBirth } from "../protected-job-birth";
import { observeResearchJobWriterAuthority } from "../research-writer-observation";
import { callToolJson as invokeTool } from "./codex-goal-mcp-test-support";

export const describe = testDescribe.skipIf(process.platform !== "linux");
beforeEach(() => setupResearchFixture({ nativeBackingFacts: true }));
afterEach(cleanupResearchFixture);
export const tmpdir = (): string => host.root;

/** Prepare only the create owner's prerequisites, never its fresh job root.
 * Real protected publication and cold owner observations establish release. */
export async function callToolJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === "codex_goal_create_job") {
    for (const path of [args.registryRootDir, args.workspacePath]) {
      if (typeof path !== "string" || researchScratchBackingPath(path) !== path) throw new Error("Unowned TEST create prerequisite");
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
  }
  const result = await invokeTool(client, name, args);
  if (name === "codex_goal_create_job" && result.ok === true) {
    const manifest = await readCodexGoalJob({ registryRootDir: String(args.registryRootDir), jobId: String(args.jobId) });
    expect(await observeProtectedCodexGoalJobBirth(manifest)).toEqual({ status: "released" });
    expect(await observeResearchJobWriterAuthority(manifest)).toEqual({ status: "released" });
  }
  return result;
}
