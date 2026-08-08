import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckRunStatus,
  CheckWorkspaceIntegrityDisposition,
  IntegrationAttemptStatus,
  ReviewDecisionStatus,
  SecretScanStatus,
  markChecksRunning,
  markCommitCreated,
  markWorkerOutputApplied,
  openIntegrationAttempt,
  recordCheckRuns,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalIntegrationAttemptStore } from
  "@vioxen/subscription-runtime/store-local-file";
import {
  applyStaleIntegrationReconciliation as applyStaleIntegrationReconciliationRaw,
  previewStaleIntegrationReconciliationPlan,
} from "../application/project-control/codex-goal-stale-integration-reconciliation";
import {
  LocalReviewedWorkerOutputStore,
  reviewedWorkerOutputFormat,
  reviewedWorkerOutputIdentityPayload,
  reviewedWorkerOutputRoot,
} from "../reviewed-worker-output";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

type ApplyInput = Parameters<typeof applyStaleIntegrationReconciliationRaw>[0];

async function applyStaleIntegrationReconciliation(
  input: Omit<ApplyInput, "runAfterControllerScopeRevalidation"> &
    Partial<Pick<ApplyInput, "runAfterControllerScopeRevalidation">>,
) {
  return await applyStaleIntegrationReconciliationRaw({
    runAfterControllerScopeRevalidation: async (effect) => await effect(),
    ...input,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })
  ));
});

describe("stale integration reconciliation", () => {
  it.each([
    [false, "patch_absent"],
    [true, "patch_incorporated"],
  ] as const)("proves and rejects a stale attempt (incorporated=%s)", async (
    incorporated,
    proof,
  ) => {
    const fixture = await reconciliationFixture({ incorporated });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ eligible: true, proof });

    const receipt = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(receipt).toMatchObject({
      status: "completed",
      reconciled: [fixture.attemptId],
    });
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Rejected,
    );
  });

  it("fails closed when target workspace is dirty", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    await writeFile(join(fixture.targetPath, "untracked.txt"), "dirty\n");
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: "target_workspace_dirty",
    });
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_refused_entries_present");
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
  });

  it("fails closed when the signed live remote head drifts after preview", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await writeFile(join(fixture.seedPath, "remote-drift.txt"), "drift\n");
    await git(fixture.seedPath, ["add", "remote-drift.txt"]);
    await git(fixture.seedPath, ["commit", "-m", "chore: remote drift"]);
    await git(fixture.seedPath, ["push", "origin", "main"]);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_entry_drift");
  });

  it("fails the attempt hash and status CAS when state changes after preview", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const attemptPath = plan.entries[0]!.attemptPath;
    const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
    await writeFile(attemptPath, `${JSON.stringify({
      ...attempt,
      externallyObserved: true,
    }, null, 2)}\n`);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_attempt_cas_mismatch");
  });

  it.each([
    ["targetRemote", "-origin", "project_control_targetRemote_invalid"],
    ["targetBranch", "-main", "project_control_targetBranch_invalid"],
  ] as const)("rejects unsafe %s before invoking Git", async (
    field,
    value,
    error,
  ) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attemptPath = fixture.attemptPath;
    const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
    await writeFile(attemptPath, `${JSON.stringify({
      ...attempt,
      [field]: value,
      targetWorkspacePath: join(fixture.root, "not-a-repository"),
    }, null, 2)}\n`);
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow(error);
  });

  it("binds exact patch custody metadata and refuses denied evidence", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]?.patchEvidence).toMatchObject({
      declaredPath: fixture.patchPath,
      canonicalPath: await realpath(fixture.patchPath),
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const denied = await reconciliationFixture({ incorporated: false });
    const deniedPlan = await previewStaleIntegrationReconciliationPlan({
      ...denied.scope,
      deniedRoots: [denied.reviewedRoot],
    });
    expect(deniedPlan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("patch_outside_custody"),
    });

    const escaped = await reconciliationFixture({ incorporated: false });
    const escapedPatch = join(escaped.root, "outside.patch");
    await writeFile(escapedPatch, await readFile(escaped.patchPath));
    const escapedAttempt = JSON.parse(await readFile(escaped.attemptPath, "utf8"));
    await writeFile(escaped.attemptPath, `${JSON.stringify({
      ...escapedAttempt,
      workerOutput: { ...escapedAttempt.workerOutput, patchPath: escapedPatch },
    }, null, 2)}\n`);
    const escapedPlan = await previewStaleIntegrationReconciliationPlan(
      escaped.scope,
    );
    expect(escapedPlan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("patch_outside_reviewed_store"),
    });
  });

  it("requires reviewed-output project, controller, and worker ownership", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...attempt,
      workerJobId: "foreign-worker-v1",
      workerOutput: {
        ...attempt.workerOutput,
        workerJobId: "foreign-worker-v1",
      },
    }, null, 2)}\n`);
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("reviewed_output_scope_mismatch"),
    });
  });

  it.each([
    ["base commit", (attempt: IntegrationAttempt) => ({
      ...attempt,
      workerOutput: { ...attempt.workerOutput, baseCommit: "f".repeat(40) },
    })],
    ["canonical merge absence", (attempt: IntegrationAttempt) => ({
      ...attempt,
      merge: {
        sourceRemote: "origin",
        sourceBranch: "reviewed-feature",
        sourceCommit: "f".repeat(40),
        expectedTargetCommit: attempt.workerOutput.baseCommit!,
      },
    })],
  ] as const)("refuses reviewed-output %s mismatch before proof", async (
    _label,
    mutate,
  ) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = (await fixture.store.get(fixture.attemptId))!;
    await fixture.store.update(mutate(attempt));
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("reviewed_output_scope_mismatch"),
    });
  });

  it.each([
    IntegrationAttemptStatus.Opened,
    IntegrationAttemptStatus.Applied,
    IntegrationAttemptStatus.ChecksRunning,
    IntegrationAttemptStatus.ChecksFailed,
    IntegrationAttemptStatus.ChecksPassed,
    IntegrationAttemptStatus.CommitCreated,
  ])("accepts a domain-valid historical %s attempt", async (status) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const opened = (await fixture.store.get(fixture.attemptId))!;
    await fixture.store.update(historicalAttemptAtStatus(opened, status));
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    expect(plan.entries[0]).toMatchObject({ eligible: true, status });
  });

  it.each([
    ["opened with commit", (attempt: IntegrationAttempt) => ({
      ...attempt,
      commitCandidate: commitCandidate(),
    })],
    ["checks passed with failed rollup", (attempt: IntegrationAttempt) => ({
      ...historicalAttemptAtStatus(
        attempt,
        IntegrationAttemptStatus.ChecksPassed,
      ),
      checkRuns: [failedCheckRun()],
    })],
    ["commit status without candidate", (attempt: IntegrationAttempt) => {
      const committed = historicalAttemptAtStatus(
        attempt,
        IntegrationAttemptStatus.CommitCreated,
      );
      const { commitCandidate: _removed, ...inconsistent } = committed;
      return inconsistent as IntegrationAttempt;
    }],
  ] as const)("rejects domain-inconsistent %s attempt", async (
    _label,
    mutate,
  ) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = (await fixture.store.get(fixture.attemptId))!;
    await fixture.store.update(mutate(attempt));
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow("stale_integration_reconciliation_attempt_structure_invalid");
  });

  it("refuses symlink patch evidence and detects bound-byte drift", async () => {
    const symlinked = await reconciliationFixture({ incorporated: false });
    const realPatch = join(symlinked.root, "real.patch");
    await rename(symlinked.patchPath, realPatch);
    await symlink(realPatch, symlinked.patchPath);
    const symlinkPlan = await previewStaleIntegrationReconciliationPlan(
      symlinked.scope,
    );
    expect(symlinkPlan.entries[0]).toMatchObject({
      eligible: false,
      refusalReason: expect.stringContaining("artifact_unsafe"),
    });

    const drifted = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(drifted.scope);
    await writeFile(drifted.patchPath, "drift\n");
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: drifted.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_entry_drift");
  });

  it("rejects duplicate persisted bindings before progress or mutation", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    const { planSha256: _ignored, ...unsigned } = plan;
    const duplicateUnsigned = { ...unsigned, entries: [
      ...unsigned.entries,
      unsigned.entries[0]!,
    ] };
    const duplicateSha = createHash("sha256")
      .update(JSON.stringify(duplicateUnsigned)).digest("hex");
    const artifactRoot = join(
      fixture.controllerJobRootDir,
      "project-integration",
      "stale-attempt-reconciliation",
    );
    await writeFile(join(artifactRoot, `${duplicateSha}.plan.json`), JSON.stringify({
      ...duplicateUnsigned,
      planSha256: duplicateSha,
    }));
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: duplicateSha,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_attempt_binding_duplicate");
    await expect(access(join(artifactRoot, `${duplicateSha}.progress.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
  });

  it("rejects a noncanonical attempt directory before proof execution", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    await rename(
      join(fixture.attemptPath, ".."),
      join(fixture.controllerJobRootDir, "project-integration", "integration-attempts", "bad"),
    );
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow("stale_integration_reconciliation_attempt_binding_noncanonical");
  });

  it("resumes after a crash partway through 17 exact updates and replays receipt", async () => {
    const fixture = await reconciliationFixture({
      incorporated: false,
      attemptCount: 17,
    });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      crashAfterCompletedCount: 8,
    })).rejects.toThrow("stale_integration_reconciliation_simulated_crash");
    const partial = await Promise.all(fixture.attemptIds.map(async (attemptId) =>
      (await fixture.store.get(attemptId))?.status
    ));
    expect(partial.filter((status) =>
      status === IntegrationAttemptStatus.Rejected
    )).toHaveLength(8);

    const resumed = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(resumed).toMatchObject({
      idempotentReplay: false,
      reconciled: [...fixture.attemptIds].sort(),
    });
    const replay = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(replay).toEqual({ ...resumed, idempotentReplay: true });
  });

  it("resumes from a durable pending exact post-image", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      crashAfterPreparedCount: 1,
    })).rejects.toThrow("stale_integration_reconciliation_simulated_prepare_crash");
    expect((await fixture.store.get(fixture.attemptId))?.status).toBe(
      IntegrationAttemptStatus.Opened,
    );
    const receipt = await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    });
    expect(receipt.reconciled).toEqual([fixture.attemptId]);
  });

  it("rejects exact post-image drift after a completed crash", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      crashAfterCompletedCount: 1,
    })).rejects.toThrow("stale_integration_reconciliation_simulated_crash");
    const rejected = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...rejected,
      updatedAt: "2026-08-08T00:00:09.000Z",
    }, null, 2)}\n`);
    await expect(applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
    })).rejects.toThrow("stale_integration_reconciliation_progress_attempt_drift");
  });

  it.each([
    ["invalid status", { status: "invented_status" }],
    ["partial shape", { reviewDecision: { decision: "approved" } }],
  ])("rejects %s before proof or mutation", async (_label, patch) => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const attempt = JSON.parse(await readFile(fixture.attemptPath, "utf8"));
    await writeFile(fixture.attemptPath, `${JSON.stringify({
      ...attempt,
      ...patch,
    }, null, 2)}\n`);
    await expect(previewStaleIntegrationReconciliationPlan(fixture.scope))
      .rejects.toThrow("stale_integration_reconciliation_attempt_structure_invalid");
  });

  it("runs scope revalidation only after the maintenance fence is present", async () => {
    const fixture = await reconciliationFixture({ incorporated: false });
    const plan = await previewStaleIntegrationReconciliationPlan(fixture.scope);
    let observedFence = false;
    await applyStaleIntegrationReconciliation({
      expectedPlanSha256: plan.planSha256,
      controllerJobRootDir: fixture.controllerJobRootDir,
      runAfterControllerScopeRevalidation: async (effect) => {
        await access(join(
          fixture.controllerJobRootDir,
          ".controller-maintenance-fence.json",
        ));
        observedFence = true;
        return await effect();
      },
    });
    expect(observedFence).toBe(true);
  });
});

function historicalAttemptAtStatus(
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

function passedCheckRun() {
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

function failedCheckRun() {
  return {
    ...passedCheckRun(),
    status: CheckRunStatus.Failed,
    exitCode: 1,
  } as const;
}

function commitCandidate() {
  return {
    commitSha: "e".repeat(40),
    message: "fix: historical candidate",
    files: ["value.txt"],
    secretScanStatus: SecretScanStatus.Passed,
    createdAt: "2026-08-08T00:00:04.000Z",
  } as const;
}

async function reconciliationFixture(input: {
  readonly incorporated: boolean;
  readonly attemptCount?: number;
}) {
  const root = await mkdtemp(join(tmpdir(), "stale-integration-reconciliation-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worker = join(root, "worker");
  const targetPath = join(root, "target");
  const controllerJobRootDir = join(root, "controller");
  const registryRootDir = join(root, "registry");
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
  const reviewedStore = new LocalReviewedWorkerOutputStore({
    rootDir: reviewedRoot,
  });
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
  const attemptIds = Array.from({ length: input.attemptCount ?? 1 }, (_, index) =>
    `stale-attempt-${index + 1}`
  );
  const store = new LocalIntegrationAttemptStore({
    rootDir: join(controllerJobRootDir, "project-integration"),
  });
  for (const attemptId of attemptIds) await store.create(openIntegrationAttempt({
    attemptId,
    projectId: "social-monitor",
    controllerJobId: "social-monitor-controller-v4",
    sourceWorkspacePath: worker,
    targetWorkspacePath: targetPath,
    targetBranch: "main",
    targetRemote: "origin",
    workerOutput: {
      workerJobId: "social-monitor-worker-v1",
      workspacePath: worker,
      patchPath: reviewedSnapshot.patchPath,
      patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
      baseCommit,
      changedFiles: ["value.txt"],
    },
    reviewDecision,
    now: "2026-08-08T00:00:00.000Z",
  }));
  return {
    root,
    attemptId: attemptIds[0]!,
    attemptIds,
    controllerJobRootDir,
    workerPath: worker,
    patchPath: reviewedSnapshot.patchPath,
    reviewedRoot,
    attemptPath: join(
      controllerJobRootDir,
      "project-integration",
      "integration-attempts",
      createHash("sha256").update(attemptIds[0]!).digest("hex"),
      "attempt.json",
    ),
    seedPath: seed,
    targetPath,
    store,
    scope: {
      controllerJobId: "social-monitor-controller-v4",
      projectId: "social-monitor",
      registryRootDir,
      controllerJobRootDir,
      controllerManifestSha256: "a".repeat(64),
      controllerScopeEpochSha256: "b".repeat(64),
      targetWorkspaceRoots: [targetPath, worker],
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
