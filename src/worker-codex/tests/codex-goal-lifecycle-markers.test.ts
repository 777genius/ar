import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewDecisionStatus } from "@vioxen/subscription-runtime/worker-core";
import type { ReviewedWorkerOutputSnapshot } from "../reviewed-worker-output";
import {
  readCodexGoalLifecycleMarkers,
  writeCodexGoalReviewMarker,
} from "../application/codex-goal-lifecycle-markers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-marker-test-"));
  roots.push(root);
  return {
    root,
    reviewPath: join(root, "job-1.review.json"),
    input: {
      jobId: "job-1",
      taskId: "job-1",
      jobRootDir: root,
      note: "new review",
      status: { state: "stopped" },
      reviewedOutput: {
        format: "reviewed-worker-output",
        formatRevision: 1,
        reviewedOutputId: "a".repeat(64),
        projectId: "project-1",
        controllerJobId: "controller-1",
        workerJobId: "job-1",
        taskId: "job-1",
        sourceWorkspacePath: root,
        patchSha256: "b".repeat(64),
        patchByteLength: 4,
        patchPath: join(root, "output.patch"),
        baseCommit: "c".repeat(40),
        changedFiles: ["file.txt"],
        reviewDecision: {
          reviewedBy: "owner",
          decision: ReviewDecisionStatus.Approved,
          reason: "Reviewed exact output",
          approvedFiles: ["file.txt"],
          requiredChecks: [],
        },
        capturedAt: "2026-09-28T00:00:00.000Z",
      } satisfies ReviewedWorkerOutputSnapshot,
    },
  };
}

function beforeimagePath(root: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex");
  return join(root, `job-1.review.${digest}.json`);
}

function outputVersionPath(reviewPath: string, outputId: string): string {
  return `${reviewPath}.output-${outputId}.json`;
}

describe("writeCodexGoalReviewMarker", () => {
  it("preserves a historic review byte for byte before accepting a new exact capture", async () => {
    const f = await fixture();
    const historic = '{"reviewedAt":"2026-09-01T00:00:00.000Z","note":"old review"}\n';
    await writeFile(f.reviewPath, historic, { mode: 0o600 });

    const acceptedPath = await writeCodexGoalReviewMarker(f.input);
    expect(acceptedPath).toBe(outputVersionPath(f.reviewPath, "a".repeat(64)));
    expect(JSON.parse(await readFile(acceptedPath, "utf8"))).toMatchObject({
      reviewedOutput: { reviewedOutputId: "a".repeat(64) },
    });
    expect(await readFile(beforeimagePath(f.root, historic), "utf8")).toBe(historic);
    expect(JSON.parse(await readFile(f.reviewPath, "utf8"))).toMatchObject({
      reviewedOutput: { reviewedOutputId: "a".repeat(64) },
    });
    expect((await readCodexGoalLifecycleMarkers({ jobRootDir: f.root, taskId: "job-1" }))[0])
      .toMatchObject({ type: "review", reviewedOutputId: "a".repeat(64) });

    const accepted = await readFile(f.reviewPath, "utf8");
    expect(await writeCodexGoalReviewMarker(f.input)).toBe(acceptedPath);
    expect(await readFile(f.reviewPath, "utf8")).toBe(accepted);
    expect(await readFile(acceptedPath, "utf8")).toBe(accepted);
    expect((await readdir(f.root)).filter((name) => /^job-1\.review\.[a-f0-9]{64}\.json$/.test(name)))
      .toHaveLength(1);

    const secondPath = await writeCodexGoalReviewMarker({
      ...f.input,
      reviewedOutput: {
        ...f.input.reviewedOutput,
        reviewedOutputId: "d".repeat(64),
      },
    });
    expect(secondPath).toBe(outputVersionPath(f.reviewPath, "d".repeat(64)));
    expect(await readFile(beforeimagePath(f.root, accepted), "utf8")).toBe(accepted);
    expect(await readFile(beforeimagePath(f.root, historic), "utf8")).toBe(historic);
    expect(JSON.parse(await readFile(f.reviewPath, "utf8"))).toMatchObject({
      reviewedOutput: { reviewedOutputId: "d".repeat(64) },
    });
    expect(await readFile(acceptedPath, "utf8")).toBe(accepted);
  });

  it("recovers after interruption between preserving the beforeimage and replacing the canonical marker", async () => {
    const f = await fixture();
    const historic = '{"note":"historic"}\n';
    await writeFile(f.reviewPath, historic, { mode: 0o600 });
    await link(f.reviewPath, beforeimagePath(f.root, historic));

    await writeCodexGoalReviewMarker(f.input);
    expect(await readFile(beforeimagePath(f.root, historic), "utf8")).toBe(historic);
    expect(JSON.parse(await readFile(f.reviewPath, "utf8"))).toMatchObject({
      reviewedOutput: { reviewedOutputId: "a".repeat(64) },
    });
  });

  it("keeps both exact capture versions when different IDs write concurrently", async () => {
    const f = await fixture();
    const historic = '{"note":"historic"}\n';
    await writeFile(f.reviewPath, historic, { mode: 0o600 });
    const second = {
      ...f.input,
      reviewedOutput: {
        ...f.input.reviewedOutput,
        reviewedOutputId: "d".repeat(64),
      },
    };

    const outcomes = await Promise.allSettled([
      writeCodexGoalReviewMarker(f.input),
      writeCodexGoalReviewMarker(second),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(await readFile(beforeimagePath(f.root, historic), "utf8")).toBe(historic);
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== "fulfilled") continue;
      const outputId = index === 0 ? "a".repeat(64) : "d".repeat(64);
      expect(outcome.value).toBe(outputVersionPath(f.reviewPath, outputId));
      expect(JSON.parse(await readFile(outcome.value, "utf8")))
        .toMatchObject({ reviewedOutput: { reviewedOutputId: outputId } });
    }
    const canonical = JSON.parse(await readFile(f.reviewPath, "utf8"));
    expect(["a".repeat(64), "d".repeat(64)])
      .toContain(canonical.reviewedOutput.reviewedOutputId);
  });

  it("rejects a conflicting immutable version without changing the canonical marker", async () => {
    const f = await fixture();
    const historic = '{"note":"historic"}\n';
    await writeFile(f.reviewPath, historic, { mode: 0o600 });
    const versionPath = outputVersionPath(f.reviewPath, "a".repeat(64));
    const conflict = '{"reviewedOutput":{"reviewedOutputId":"' + "a".repeat(64) +
      '","patchSha256":"wrong"}}\n';
    await writeFile(versionPath, conflict, { mode: 0o600 });

    await expect(writeCodexGoalReviewMarker(f.input)).rejects.toThrow(
      "codex_goal_review_marker_version_conflict",
    );
    expect(await readFile(f.reviewPath, "utf8")).toBe(historic);
    expect(await readFile(versionPath, "utf8")).toBe(conflict);
  });

  it("fails closed on a symlinked canonical marker without changing its target", async () => {
    const f = await fixture();
    const target = join(f.root, "target.json");
    await writeFile(target, '{"note":"untouched"}\n', { mode: 0o600 });
    await symlink(target, f.reviewPath);

    await expect(writeCodexGoalReviewMarker(f.input)).rejects.toThrow(
      "codex_goal_review_marker_unsafe",
    );
    expect(await readFile(target, "utf8")).toBe('{"note":"untouched"}\n');
  });

  it("rejects a marker with public permissions before preserving or replacing it", async () => {
    const f = await fixture();
    const historic = '{"note":"historic"}\n';
    await writeFile(f.reviewPath, historic, { mode: 0o644 });
    await chmod(f.reviewPath, 0o644);

    await expect(writeCodexGoalReviewMarker(f.input)).rejects.toThrow(
      "codex_goal_review_marker_unsafe",
    );
    expect(await readFile(f.reviewPath, "utf8")).toBe(historic);
  });
});
