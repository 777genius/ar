import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CheckRunStatus,
  CheckWorkspaceIntegrityDisposition,
  IntegrationAttemptStatus,
  SecretScanStatus,
  markChecksRunning,
  markCommitCreated,
  markWorkerOutputApplied,
  recordCheckRuns,
  type IntegrationAttempt,
  ReviewDecisionStatus,
  openIntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalIntegrationAttemptStore } from
  "@vioxen/subscription-runtime/store-local-file";
import { codexGoalJobManifestPath } from "../codex-goal-jobs";
import {
  LocalReviewedWorkerOutputStore,
  reviewedWorkerOutputFormat,
  reviewedWorkerOutputIdentityPayload,
  reviewedWorkerOutputRoot,
} from "../reviewed-worker-output";

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

export async function cleanupReconciliationFixtures(): Promise<void> {
  await Promise.all(fixtureRoots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
}

export async function reconciliationFixture(input: {
  readonly incorporated: boolean;
  readonly attemptCount?: number;
  readonly incidentEnvelope?: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), "stale-integration-reconciliation-"));
  fixtureRoots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worker = join(root, "worker");
  const targetPath = join(root, "target");
  const controllerJobRootDir = join(root, "controller");
  const registryRootDir = join(root, "registry");
  const controllerManifestPath = codexGoalJobManifestPath({
    registryRootDir,
    jobId: "social-monitor-controller-v4",
  });
  await mkdir(join(controllerManifestPath, ".."), { recursive: true });
  const controllerManifestBytes = Buffer.from("{\"fixture\":true}\n");
  await writeFile(controllerManifestPath, controllerManifestBytes);
  const workerManifestPath = codexGoalJobManifestPath({
    registryRootDir,
    jobId: "social-monitor-worker-v1",
  });
  const workerJobRoot = join(root, "worker-job");
  const workerResultPath = join(workerJobRoot, "worker-task.latest-result.json");
  await mkdir(join(workerManifestPath, ".."), { recursive: true });
  await mkdir(workerJobRoot, { recursive: true });
  await writeFile(workerResultPath, `${JSON.stringify({ status: "done" })}\n`);
  await writeFile(workerManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    jobId: "social-monitor-worker-v1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T01:00:00.000Z",
    jobRootDir: workerJobRoot,
    workspacePath: worker,
    promptPath: join(workerJobRoot, "prompt.md"),
    taskId: "worker-task",
    accounts: ["account-test"],
    outputPath: workerResultPath,
  }, null, 2)}\n`);
  await git(root, ["init", "--bare", remote]);
  await mkdir(seed, { recursive: true });
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["config", "user.name", "Test"]);
  await git(seed, ["config", "user.email", "test@example.com"]);
  await writeFile(join(seed, "value.txt"), "before\n");
  await git(seed, ["add", "value.txt"]);
  await git(seed, ["commit", "-m", "chore: seed"]);
  await git(seed, ["remote", "add", "origin", remote]);
  await git(seed, ["push", "-u", "origin", "main"]);
  await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["clone", remote, worker]);
  await writeFile(join(worker, "value.txt"), "after\n");
  const patchPath = join(worker, "worker.patch");
  const patchBytes = Buffer.from(await gitOutput(worker, ["diff", "--binary"]));
  await writeFile(patchPath, patchBytes);
  if (input.incorporated) {
    await git(seed, ["apply", patchPath]);
    await git(seed, ["add", "value.txt"]);
    await git(seed, ["commit", "-m", "fix: incorporate worker patch"]);
    await git(seed, ["push", "origin", "main"]);
  }
  await git(root, ["clone", remote, targetPath]);
  const reviewDecision = {
    reviewedBy: "social-monitor-reviewer-v1",
    decision: ReviewDecisionStatus.Approved,
    reason: "test fixture",
    approvedFiles: ["value.txt"],
    requiredChecks: [],
  } as const;
  const baseCommit = (await gitOutput(worker, ["rev-parse", "HEAD"])).trim();
  const reviewedRoot = reviewedWorkerOutputRoot(registryRootDir);
  const reviewedStore = new LocalReviewedWorkerOutputStore({ rootDir: reviewedRoot });
  const reviewedIdentity = {
    format: reviewedWorkerOutputFormat as typeof reviewedWorkerOutputFormat,
    formatRevision: 1 as const,
    projectId: "social-monitor",
    controllerJobId: "social-monitor-controller-v4",
    workerJobId: "social-monitor-worker-v1",
    taskId: "social-monitor-task-v1",
    sourceWorkspacePath: worker,
    baseCommit,
    patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
    changedFiles: ["value.txt"],
    reviewDecision,
  } as const;
  const reviewedOutputId = createHash("sha256")
    .update(reviewedWorkerOutputIdentityPayload(reviewedIdentity)).digest("hex");
  const reviewedSnapshot = await reviewedStore.create({
    snapshot: {
      ...reviewedIdentity,
      reviewedOutputId,
      patchByteLength: patchBytes.length,
      capturedAt: "2026-08-08T00:00:00.000Z",
    },
    patch: patchBytes.toString("utf8"),
  });
  const reviewMarkerContent = `${JSON.stringify({ reviewedOutputId })}\n`;
  await reviewedStore.commitReviewAttestation({
    attestation: {
      format: "reviewed-worker-output-review-attestation",
      formatRevision: 1,
      reviewedOutputId,
      reviewMarkerPath: join(root, "review-marker.json"),
      reviewMarkerSha256: createHash("sha256")
        .update(reviewMarkerContent).digest("hex"),
      committedAt: "2026-08-08T00:00:00.000Z",
    },
    reviewMarkerContent,
  });
  const incidentEnvelope = input.incidentEnvelope === true;
  const attemptCount = incidentEnvelope ? 17 : input.attemptCount ?? 1;
  const attemptIds = Array.from({ length: attemptCount }, (_, index) =>
    `stale-attempt-${index + 1}`
  );
  const targetPaths = [targetPath];
  if (incidentEnvelope) {
    for (let index = 1; index < attemptCount; index += 1) {
      const path = join(root, `target-${index + 1}`);
      await git(root, ["clone", remote, path]);
      targetPaths.push(path);
    }
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(targetPaths[index]!, "legacy-dirty.txt"), "legacy\n");
    }
    for (let index = 3; index < 10; index += 1) {
      const path = targetPaths[index]!;
      const partialRemote = join(root, `partial-remote-${index + 1}.git`);
      await git(root, ["init", "--bare", partialRemote]);
      await git(path, ["config", "user.name", "Test"]);
      await git(path, ["config", "user.email", "test@example.com"]);
      await writeFile(join(path, "value.txt"), "ambiguous\n");
      await git(path, ["add", "value.txt"]);
      await git(path, ["commit", "-m", "test: ambiguous target state"]);
      await git(path, ["remote", "set-url", "origin", partialRemote]);
      await git(path, ["push", "-u", "origin", "main"]);
    }
  }
  const outsidePatchPath = join(root, "outside-reviewed-store.patch");
  if (incidentEnvelope) await writeFile(outsidePatchPath, patchBytes);
  const store = new LocalIntegrationAttemptStore({
    rootDir: join(controllerJobRootDir, "project-integration"),
  });
  for (const [index, attemptId] of attemptIds.entries()) {
    const outside = incidentEnvelope && index >= 10 && index < 15;
    await store.create(openIntegrationAttempt({
      attemptId,
      projectId: "social-monitor",
      controllerJobId: "social-monitor-controller-v4",
      sourceWorkspacePath: worker,
      targetWorkspacePath: targetPaths[index] ?? targetPath,
      targetBranch: "main",
      targetRemote: "origin",
      workerOutput: {
        workerJobId: "social-monitor-worker-v1",
        workspacePath: worker,
        patchPath: outside ? outsidePatchPath : reviewedSnapshot.patchPath,
        patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
        baseCommit,
        changedFiles: ["value.txt"],
      },
      reviewDecision,
      now: "2026-08-08T00:00:00.000Z",
    }));
  }
  return {
    root,
    attemptId: attemptIds[0]!,
    attemptIds,
    controllerJobRootDir,
    controllerManifestPath,
    workerPath: worker,
    patchPath: reviewedSnapshot.patchPath,
    reviewedRoot,
    attemptPath: join(controllerJobRootDir, "project-integration",
      "integration-attempts", createHash("sha256").update(attemptIds[0]!)
        .digest("hex"), "attempt.json"),
    eventsPath: join(controllerJobRootDir, "project-integration",
      "integration-attempts", createHash("sha256").update(attemptIds[0]!)
        .digest("hex"), "events.jsonl"),
    seedPath: seed,
    targetPath,
    store,
    scope: {
      controllerJobId: "social-monitor-controller-v4",
      projectId: "social-monitor",
      registryRootDir,
      controllerJobRootDir,
      controllerManifestSha256: createHash("sha256")
        .update(controllerManifestBytes).digest("hex"),
      controllerScopeEpochSha256: "b".repeat(64),
      targetWorkspaceRoots: [...targetPaths, worker],
      allowedGitRemotes: ["origin"],
      allowedBranches: ["main"],
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

export function historicalAttemptAtStatus(
  opened: IntegrationAttempt,
  status: IntegrationAttemptStatus,
): IntegrationAttempt {
  if (status === IntegrationAttemptStatus.Opened) return opened;
  let attempt = markWorkerOutputApplied(opened, {
    changedFiles: opened.workerOutput.changedFiles,
    now: "2026-08-08T00:00:01.000Z",
  });
  if (status === IntegrationAttemptStatus.Applied) return attempt;
  attempt = markChecksRunning(attempt, "2026-08-08T00:00:02.000Z");
  if (status === IntegrationAttemptStatus.ChecksRunning) return attempt;
  attempt = recordCheckRuns(attempt, {
    checkRuns: status === IntegrationAttemptStatus.ChecksFailed
      ? [failedCheckRun()]
      : [passedCheckRun()],
    now: "2026-08-08T00:00:03.000Z",
  });
  if (status === IntegrationAttemptStatus.ChecksFailed ||
    status === IntegrationAttemptStatus.ChecksPassed) return attempt;
  if (status === IntegrationAttemptStatus.CommitCreated) {
    return markCommitCreated(attempt, {
      commitCandidate: commitCandidate(),
      now: "2026-08-08T00:00:04.000Z",
    });
  }
  throw new Error(`unsupported historical status ${status}`);
}

export function passedCheckRun() {
  return {
    checkId: "focused",
    command: ["npm", "test"],
    status: CheckRunStatus.Passed,
    startedAt: "2026-08-08T00:00:02.000Z",
    completedAt: "2026-08-08T00:00:03.000Z",
    exitCode: 0,
    workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged,
  } as const;
}

export function failedCheckRun() {
  return {
    ...passedCheckRun(),
    status: CheckRunStatus.Failed,
    exitCode: 1,
  } as const;
}

export function commitCandidate() {
  return {
    commitSha: "e".repeat(40),
    message: "fix: historical candidate",
    files: ["value.txt"],
    secretScanStatus: SecretScanStatus.Passed,
    createdAt: "2026-08-08T00:00:04.000Z",
  } as const;
}
