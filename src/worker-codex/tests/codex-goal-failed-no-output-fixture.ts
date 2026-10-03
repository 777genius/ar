import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

export async function createCleanWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await gitInitRepository(path);
  await writeFile(join(path, "README.md"), "base\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "test: base"]);
}

export async function writeBaselineFailedNoOutput(input: {
  readonly root: string;
  readonly ledgerRoot: string;
  readonly jobId: string;
}): Promise<{ readonly path: string; readonly sha256: string }> {
  const evidenceRoot = join(
    input.root,
    "worker-jobs",
    "archives",
    `${input.jobId}-failed-test`,
  );
  const workspace = join(input.root, "worktrees", input.jobId);
  await mkdir(join(input.ledgerRoot, "items"), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const statusPath = join(evidenceRoot, "git-status.txt");
  const patchPath = join(evidenceRoot, "verifier-output.patch");
  const baselinePath = join(
    input.root,
    "worker-jobs",
    input.jobId,
    "producer-output.patch",
  );
  const baseline = "diff --git a/README.md b/README.md\n";
  const baselineSha256 = createHash("sha256").update(baseline).digest("hex");
  await mkdir(dirname(baselinePath), { recursive: true });
  await writeFile(statusPath, " M README.md\n");
  await writeFile(patchPath, "");
  await writeFile(baselinePath, baseline);
  await writeFile(
    join(input.ledgerRoot, "items", `${input.jobId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: input.jobId,
      status: "failed_no_output",
      closedAt: "2026-07-13T20:00:00.000Z",
      failure: { category: "infrastructure", code: "terminal_result_missing" },
      output: { authoredChanges: false, workspaceDirty: false },
      preexistingWorkspacePatch: {
        path: baselinePath,
        sha256: baselineSha256,
      },
      note: "Verifier failed after the producer patch was applied.",
      backup: { workspace, statusPath, patchPath },
    }, null, 2)}\n`,
  );
  return {
    path: baselinePath,
    sha256: baselineSha256,
  };
}

export async function writeMislabeledNoOutput(input: {
  readonly root: string;
  readonly ledgerRoot: string;
  readonly jobId: string;
  readonly archiveRoot?: string;
}): Promise<void> {
  const evidenceRoot = join(
    input.archiveRoot ?? join(input.root, "worker-jobs", "archives"),
    `${input.jobId}-rejected-test`,
  );
  const workspace = join(input.root, "worktrees", input.jobId);
  await mkdir(join(input.ledgerRoot, "items"), { recursive: true });
  await mkdir(evidenceRoot, { recursive: true });
  const statusPath = join(evidenceRoot, "git-status.txt");
  const patchPath = join(evidenceRoot, "worker-output.patch");
  const numstatPath = join(evidenceRoot, "tracked.numstat");
  await writeFile(statusPath, "");
  await writeFile(patchPath, "");
  await writeFile(numstatPath, "");
  await writeFile(
    join(input.ledgerRoot, "items", `${input.jobId}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: input.jobId,
      status: "rejected",
      closedAt: "2026-07-13T20:00:00.000Z",
      note: "Incorrectly classified infrastructure failure.",
      backup: { workspace, statusPath, patchPath, numstatPath },
    }, null, 2)}\n`,
  );
}
