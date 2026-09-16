import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AccessBoundary,
  NetworkAccessMode,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import {
  createCodexGoalJob,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import { assertCodexGoalProjectJobNotTerminal } from
  "../application/project-control/codex-goal-consumed-output-ledger-io";
import { verifyTerminalHandoffRecovery } from
  "../application/project-control/codex-goal-project-terminal-handoff-recovery";
import { recordRejectedUncapturedOutput } from
  "../codex-goal-mcp-project-control-reviewed-rejection";
import { localReviewedWorkerOutputDeps } from "../reviewed-worker-output";
import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

export async function recoveryFixture(roots: string[]) {
  const root = await mkdtemp(
    join(tmpdir(), "subscription-runtime-terminal-recovery-pinned-"),
  );
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const jobRootDir = join(root, "job");
  const jobId = "project-worker";
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(jobRootDir, { recursive: true }),
  ]);
  await gitInitRepository(workspacePath);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 1;\n");
  await git(workspacePath, ["add", "owned.ts"]);
  await git(workspacePath, ["commit", "-m", "test: base"]);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 2;\n");
  const handoff = await materializeCodexGoalHandoffArtifacts({
    workerJobId: jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  });
  if (!handoff) throw new Error("expected handoff");
  await writeTerminalResult(jobRootDir, jobId, handoff);
  const producer = {
    jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  } as CodexGoalJobManifest;
  const snapshotter = localReviewedWorkerOutputDeps({
    rootDir: join(root, "reviewed-output"),
  }).snapshotter;
  return {
    workspacePath,
    jobRootDir,
    jobId,
    verifyInput: { producer, workspacePath, snapshotter },
  };
}

export async function writeTerminalResult(
  jobRootDir: string,
  taskId: string,
  handoff: NonNullable<
    Awaited<ReturnType<typeof materializeCodexGoalHandoffArtifacts>>
  >,
): Promise<void> {
  await writeFile(
    join(jobRootDir, `${taskId}.latest-result.json`),
    `${JSON.stringify({
      status: "done",
      changedFiles: handoff.changedPaths,
      evidence: [],
      blockers: [],
      nextAction: "review_completed",
      artifacts: handoff.artifacts,
      details: { baseCommit: handoff.baseCommit },
    })}\n`,
  );
}

export async function recoveryActionFixture(
  roots: string[],
  options: {
    readonly controllerHasEmptyLedgerRoots?: boolean;
    readonly controllerHasEmptyEvidenceRoots?: boolean;
    readonly controllerAppendsEvidenceRoot?: boolean;
    readonly controllerHasEvidenceRoots?: boolean;
    readonly controllerHasLedgerRoots?: boolean;
    readonly producerHasProjectScope?: boolean;
  } = {},
) {
  const root = await realpath(
    await mkdtemp(
      join(tmpdir(), "subscription-runtime-terminal-recovery-action-"),
    ),
  );
  roots.push(root);
  const registryRootDir = join(root, "registry");
  const worktreeRoot = join(root, "worktrees");
  const workspacePath = join(worktreeRoot, "project-worker");
  const canonicalWorkspacePath = join(root, "canonical");
  const jobRootDir = join(root, "jobs", "project-worker");
  const promptPath = join(jobRootDir, "prompt.md");
  const jobId = "project-worker";
  const ledgerRoot = join(
    canonicalWorkspacePath,
    "custody",
    "consumed-output-ledger",
  );
  const evidenceRoot = join(canonicalWorkspacePath, "custody", "archives");
  const activeEvidenceRoot = join(
    canonicalWorkspacePath,
    "custody-v2",
    "archives",
  );
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(canonicalWorkspacePath, { recursive: true }),
    mkdir(jobRootDir, { recursive: true }),
    mkdir(join(ledgerRoot, "items"), { recursive: true }),
    mkdir(evidenceRoot, { recursive: true }),
    mkdir(activeEvidenceRoot, { recursive: true }),
  ]);
  await gitInitRepository(workspacePath);
  await gitInitRepository(canonicalWorkspacePath);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 1;\n");
  await git(workspacePath, ["add", "owned.ts"]);
  await git(workspacePath, ["commit", "-m", "test: base"]);
  await writeFile(join(workspacePath, "owned.ts"), "export const value = 2;\n");
  await writeFile(promptPath, "Run checks only.\n");
  const handoff = await materializeCodexGoalHandoffArtifacts({
    workerJobId: jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
  });
  if (!handoff) throw new Error("expected handoff");
  await writeTerminalResult(jobRootDir, jobId, handoff);
  const scopeWithoutCustodyRoots: ProjectAccessScope = {
    projectId: "project",
    workspaceRoots: [canonicalWorkspacePath],
    worktreeRoots: [worktreeRoot],
    registryRoot: registryRootDir,
    jobIdPrefixes: ["project-"],
    tmuxSessionPrefixes: ["project-"],
    allowedAccountIds: ["account-a", "account-b"],
    allowedBranches: ["main"],
    allowedGitRemotes: ["origin"],
  };
  const scope: ProjectAccessScope = {
    ...scopeWithoutCustodyRoots,
    consumedOutputLedgerRoots: [ledgerRoot],
    consumedOutputEvidenceRoots: [evidenceRoot],
  };
  const controllerScope: ProjectAccessScope = {
    ...scopeWithoutCustodyRoots,
    ...(options.controllerHasLedgerRoots === false
      ? {}
      : {
          consumedOutputLedgerRoots: options.controllerHasEmptyLedgerRoots
            ? []
            : [ledgerRoot],
        }),
    ...(options.controllerHasEvidenceRoots === false
      ? {}
      : {
          consumedOutputEvidenceRoots: options.controllerHasEmptyEvidenceRoots
            ? []
            : options.controllerAppendsEvidenceRoot
              ? [evidenceRoot, activeEvidenceRoot]
              : [evidenceRoot],
        }),
  };
  await createCodexGoalJob({
    registryRootDir,
    manifest: {
      jobId,
      jobRootDir,
      authRootDir: join(root, "auth"),
      workspacePath,
      promptPath,
      taskId: jobId,
      accounts: ["account-a"],
      tmuxSession: jobId,
      ...(options.producerHasProjectScope === false
        ? {}
        : {
            accessBoundary: AccessBoundary.ProjectScopedControl,
            projectAccessScope: scope,
          }),
      networkAccess: NetworkAccessMode.Restricted,
    },
  });
  const controller = {
    schemaVersion: 1,
    jobId: "project-controller",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    jobRootDir: join(root, "jobs", "project-controller"),
    workspacePath: canonicalWorkspacePath,
    promptPath: join(root, "jobs", "project-controller", "prompt.md"),
    taskId: "project-controller",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.ProjectScopedControl,
    projectAccessScope: controllerScope,
  } as CodexGoalJobManifest;
  const producer = {
    jobId,
    taskId: jobId,
    workspacePath,
    jobRootDir,
    ...(options.producerHasProjectScope === false
      ? {}
      : { projectAccessScope: scope }),
  } as CodexGoalJobManifest;
  const snapshotter = localReviewedWorkerOutputDeps({
    rootDir: join(root, "reviewed-output"),
  }).snapshotter;
  return {
    registryRootDir,
    workspacePath,
    jobRootDir,
    jobId,
    ledgerRoot,
    evidenceRoot,
    activeEvidenceRoot,
    scope,
    controllerScope,
    controller,
    producer,
    snapshotter,
    startArgs: {
      registryRootDir,
      controllerJobId: controller.jobId,
      jobId,
      confirmStart: true,
      forceStart: true,
      dependencyBootstrap: "install" as const,
      confirmDependencyBootstrap: true,
    },
    deps: (duringBootstrap: () => Promise<void>) => ({
      loadProjectControlController: async () => ({
        registryRootDir,
        controller,
        scope: controllerScope,
      }),
      loadJobLaunch: async () => {
        throw new Error("unexpected loadJobLaunch");
      },
      codexProjectControlBroker: () => {
        throw new Error("unexpected broker start");
      },
      dependencyBootstrap: async () => {
        await duringBootstrap();
        return {
          mode: "install" as const,
          workspacePath,
          nodeModulesPath: join(workspacePath, "node_modules"),
          nodeModulesExists: true,
          binaryChecks: [],
          fingerprintInputs: [],
          status: "installed" as const,
          warnings: [],
        };
      },
    }),
  };
}

export async function writeRejectedUncapturedReview(
  fixture: Awaited<ReturnType<typeof recoveryActionFixture>>,
  scope: ProjectAccessScope = fixture.scope,
) {
  const receipt = await recordRejectedUncapturedOutput({
    scope,
    jobId: fixture.jobId,
    jobRootDir: fixture.jobRootDir,
    workspacePath: fixture.workspacePath,
    closedAt: "2026-07-21T00:00:00.000Z",
    reason: "Rejected for same-job remediation.",
  });
  await writeRecoveryReviewMarker(fixture, {});
  return receipt;
}

export async function writeRecoveryReviewMarker(
  fixture: Awaited<ReturnType<typeof recoveryActionFixture>>,
  overrides: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(fixture.jobRootDir, `${fixture.jobId}.review.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: fixture.jobId,
      taskId: fixture.jobId,
      reviewedAt: "2026-07-21T00:00:00.000Z",
      note: "FORMAL REJECT",
      status: { resultStatus: "done", workspaceDirty: true },
      ...overrides,
    })}\n`,
  );
}

export async function assertTerminalRecoveryAdmission(
  fixture: Awaited<ReturnType<typeof recoveryActionFixture>>,
  patchSha256: string,
): Promise<void> {
  await assertCodexGoalProjectJobNotTerminal({
    roots: [fixture.ledgerRoot],
    evidenceRoots: fixture.scope.consumedOutputEvidenceRoots ?? [],
    projectId: fixture.scope.projectId,
    controllerJobId: fixture.controller.jobId,
    jobId: fixture.jobId,
    taskId: fixture.jobId,
    workspacePath: fixture.workspacePath,
    rejectedUncapturedContinuationPatchSha256: patchSha256,
  });
}

export async function verifyActionFixture(
  fixture: Awaited<ReturnType<typeof recoveryActionFixture>>,
  roots: readonly string[] = [fixture.ledgerRoot],
  evidenceRoots: readonly string[] =
    fixture.scope.consumedOutputEvidenceRoots ?? [],
) {
  return await verifyTerminalHandoffRecovery({
    producer: fixture.producer,
    workspacePath: fixture.workspacePath,
    snapshotter: fixture.snapshotter,
    consumedOutputLedgerRoots: roots,
    consumedOutputEvidenceRoots: evidenceRoots,
  });
}
