import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  AccessBoundary,
  type InMemoryAttemptJournal,
  NetworkAccessMode,
  ReviewDecisionStatus,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  captureReviewedWorkerOutput,
  commitReviewedWorkerOutputReviewAttestation,
  localReviewedWorkerOutputDeps,
} from "../reviewed-worker-output";
import {
  callToolJson,
  git,
  gitStdout,
} from "./codex-goal-mcp-test-support";

export function projectScope(input: {
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly allowedAccountIds?: readonly string[];
}): ProjectAccessScope {
  return {
    projectId: "project",
    workspaceRoots: [input.sourceWorkspacePath],
    worktreeRoots: [join(input.root, "worktrees")],
    registryRoot: input.registryRootDir,
    consumedOutputLedgerRoots: [
      join(input.root, "control", "consumed-output-ledger"),
    ],
    authRoot: join(input.root, "auth"),
    jobIdPrefixes: ["project-"],
    tmuxSessionPrefixes: ["project-"],
    allowedBranches: ["main", "origin/main", "review/*"],
    allowedGitRemotes: ["origin"],
    allowedAccountIds: input.allowedAccountIds ?? ["account-a"],
    deniedRoots: [join(input.root, "real-user-project")],
    preStartAdmission: { required: true, mode: "serial-builtin" },
  };
}

export async function writeRejectedProducerLedger(input: {
  readonly root: string;
  readonly producerWorkspacePath: string;
}): Promise<void> {
  const ledgerRoot = join(input.root, "control", "consumed-output-ledger");
  const backupRoot = join(input.root, "control", "producer-rejection-backup");
  await mkdir(join(ledgerRoot, "items"), { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const statusPath = join(backupRoot, "status.txt");
  const patchPath = join(backupRoot, "tracked.patch");
  const numstatPath = join(backupRoot, "numstat.txt");
  await writeFile(statusPath, " M feature.txt\n");
  await writeFile(patchPath, "diff --git a/feature.txt b/feature.txt\n");
  await writeFile(numstatPath, "1\t1\tfeature.txt\n");
  await writeFile(
    join(ledgerRoot, "items", "project-producer.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: "project-producer",
      status: "rejected",
      closedAt: "2026-07-15T00:00:00.000Z",
      note: "Rejected producer output retained for bounded remediation.",
      backup: {
        workspace: input.producerWorkspacePath,
        statusPath,
        patchPath,
        numstatPath,
      },
    }, null, 2)}\n`,
  );
}

export async function directoryEntries(path: string): Promise<readonly string[]> {
  return (await readdir(path)).sort();
}

export async function recordUnavailableAttempt(input: {
  readonly journal: InMemoryAttemptJournal;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly accountId: string;
}): Promise<void> {
  const now = new Date("2026-07-14T00:00:00.000Z");
  await input.journal.startTask({
    taskId: input.taskId,
    workspaceRunId: "verifier-workspace-run",
    workspacePath: input.workspacePath,
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await input.journal.appendAttempt({
    taskId: input.taskId,
    attempt: {
      taskId: input.taskId,
      attemptNumber: 1,
      accountId: input.accountId,
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason: "account_unavailable",
      workspaceDirtyBefore: true,
      workspaceDirtyAfter: true,
      changedFiles: [],
    },
    now,
  });
  await input.journal.markPartial({
    taskId: input.taskId,
    status: "waiting_capacity",
    reason: "account_unavailable",
    now,
  });
}

export async function createApprovedReviewedOutput(input: {
  readonly root: string;
  readonly sourceWorkspacePath: string;
  readonly reviewedRoot: string;
  readonly workerJobId: string;
  readonly changedFile: string;
  readonly content: string;
  readonly advanceBase?: boolean;
}) {
  const workspacePath = join(input.root, "worktrees", input.workerJobId);
  await git(input.root, ["clone", input.sourceWorkspacePath, workspacePath]);
  if (input.advanceBase) {
    await git(workspacePath, ["config", "user.email", "test@example.com"]);
    await git(workspacePath, ["config", "user.name", "Test User"]);
    await writeFile(join(workspacePath, ".different-base"), "different\n");
    await writeFile(join(workspacePath, input.changedFile), "base\n");
    await git(workspacePath, ["add", ".different-base", input.changedFile]);
    await git(workspacePath, ["commit", "-m", "test: different base"]);
  }
  await writeFile(join(workspacePath, input.changedFile), input.content);
  const patch = await gitStdout(workspacePath, [
    "diff",
    "--binary",
    "HEAD",
    "--",
  ]);
  const deps = localReviewedWorkerOutputDeps({ rootDir: input.reviewedRoot });
  const snapshot = await captureReviewedWorkerOutput(deps, {
    projectId: "project",
    controllerJobId: "project-controller",
    workerJobId: input.workerJobId,
    taskId: input.workerJobId,
    workspacePath,
    expectedPatchSha256: createHash("sha256").update(patch).digest("hex"),
    decision: ReviewDecisionStatus.Approved,
    reviewedBy: "project-controller",
    reason: "approved",
    approvedFiles: [input.changedFile],
    requiredChecks: [],
  });
  const markerContent = `approved:${input.workerJobId}`;
  await commitReviewedWorkerOutputReviewAttestation({
    store: deps.store,
    markerVerifier: {
      async verify() {
        return {
          markerSha256: createHash("sha256")
            .update(markerContent)
            .digest("hex"),
          markerContent,
        };
      },
    },
    snapshot,
    reviewMarkerPath: `/evidence/${input.workerJobId}.json`,
  });
  return snapshot;
}

export async function createProducerJob(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly producerJobRoot: string;
  readonly producerWorkspacePath: string;
}): Promise<void> {
  const result = await callToolJson(input.client, "codex_goal_create_job", {
    registryRootDir: input.registryRootDir,
    jobId: "project-producer",
    jobRootDir: input.producerJobRoot,
    authRootDir: join(input.root, "auth"),
    workspacePath: input.producerWorkspacePath,
    promptPath: join(input.producerJobRoot, "prompt.md"),
    taskId: "project-producer",
    accounts: ["account-a"],
    accessBoundary: AccessBoundary.IsolatedWorkspaceWrite,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: {
      projectId: "project",
      workspaceRoots: [input.producerWorkspacePath],
      isolatedWorkspaceRoot: input.producerWorkspacePath,
      registryRoot: input.registryRootDir,
      authRoot: join(input.root, "auth"),
      allowedAccountIds: ["account-a"],
      deniedRoots: [join(input.root, "real-user-project")],
    },
  });
  if (result.ok !== true) throw new Error(JSON.stringify(result));
}

export async function createControllerJob(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly controllerJobRoot: string;
  readonly sourceWorkspacePath: string;
  readonly allowedAccountIds?: readonly string[];
}): Promise<void> {
  const result = await callToolJson(input.client, "codex_goal_create_job", {
    registryRootDir: input.registryRootDir,
    jobId: "project-controller",
    jobRootDir: input.controllerJobRoot,
    authRootDir: join(input.root, "auth"),
    workspacePath: input.sourceWorkspacePath,
    promptPath: join(input.controllerJobRoot, "prompt.md"),
    taskId: "project-controller",
    accounts: [input.allowedAccountIds?.[0] ?? "account-a"],
    accessBoundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: projectScope(input),
  });
  if (result.ok !== true) throw new Error(JSON.stringify(result));
}

export async function prepareVerifier(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly verifierWorkspacePath: string;
  readonly producerBase: string;
  readonly canonicalSha: string;
  readonly patchSha256: string;
  readonly executionMode: "sync" | "bounded";
  readonly jobId?: string;
  readonly baseBranch?: string;
  readonly expectedSourceCommit?: string;
  readonly accounts?: readonly string[];
  readonly ownedPaths?: readonly string[];
}): Promise<Record<string, unknown>> {
  const jobId = input.jobId ?? "project-verifier";
  const response = await input.client.callTool({
    name: "codex_goal_project_prepare_verifier",
    arguments: {
      registryRootDir: input.registryRootDir,
      controllerJobId: "project-controller",
      producerJobId: "project-producer",
      jobId,
      taskId: jobId,
      sourceWorkspacePath: input.sourceWorkspacePath,
      baseBranch: input.baseBranch ?? "origin/main",
      ...(input.expectedSourceCommit
        ? { expectedSourceCommit: input.expectedSourceCommit }
        : {}),
      newBranch: "review/verifier",
      workspacePath: input.verifierWorkspacePath,
      promptBody: "Review immutable producer output.\n",
      accounts: input.accounts ?? ["account-a"],
      workerRole: "reviewer",
      preStartAdmission: {
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha: input.canonicalSha,
          baseSha: input.producerBase,
          phaseStartSha: input.canonicalSha,
          packetRevision: "review-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-01",
          laneId: "review",
          inputPatchHash: input.patchSha256,
          reviewKind: "review",
          ownedPaths: input.ownedPaths ?? ["feature.txt"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [{
            id: "focused",
            cwd: "checks",
            command: "cd .. && git diff --check",
          }],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot: input.verifierWorkspacePath,
            forbiddenRealProjects: [join(input.root, "real-user-project")],
          },
        },
      },
      confirmPreStartAdmission: true,
      startWorker: false,
      executionMode: input.executionMode,
      confirmRefill: true,
    },
  });
  const text = (
    response as { readonly content?: readonly { readonly text?: string }[] }
  ).content?.[0]?.text;
  if (!text?.startsWith("{")) throw new Error(text ?? "missing response");
  const result = JSON.parse(text) as Record<string, unknown>;
  if (result.ok !== true) throw new Error(JSON.stringify(result));
  return result;
}

export async function prepareRemediation(input: {
  readonly client: Client;
  readonly root: string;
  readonly registryRootDir: string;
  readonly sourceWorkspacePath: string;
  readonly remediationWorkspacePath: string;
  readonly producerBase: string;
  readonly canonicalSha: string;
  readonly patchSha256: string;
}): Promise<Record<string, unknown>> {
  const response = await input.client.callTool({
    name: "codex_goal_project_refill_worker",
    arguments: {
      registryRootDir: input.registryRootDir,
      controllerJobId: "project-controller",
      producerJobId: "project-producer",
      jobId: "project-remediation",
      taskId: "project-remediation",
      sourceWorkspacePath: input.sourceWorkspacePath,
      baseBranch: "origin/main",
      newBranch: "review/remediation",
      workspacePath: input.remediationWorkspacePath,
      promptBody: "Remediate immutable rejected producer output.\n",
      accounts: ["account-a"],
      workerRole: "producer",
      preStartAdmission: {
        mode: "serial-builtin",
        contract: {
          kind: "worker-launch",
          format: 1,
          canonicalSha: input.canonicalSha,
          baseSha: input.producerBase,
          phaseStartSha: input.canonicalSha,
          packetRevision: "remediation-r1",
          controllerPacket: "controller.md",
          lanePacket: "lane.md",
          phaseId: "phase-01",
          laneId: "remediation",
          inputPatchHash: input.patchSha256,
          reviewKind: "implementation",
          ownedPaths: ["feature.txt"],
          mandatoryDocs: ["README.md", "controller.md", "lane.md"],
          mandatoryScripts: [],
          mandatoryFixtures: [],
          requiredChecks: [{
            id: "focused",
            cwd: "checks",
            command: "cd .. && git diff --check",
          }],
          executionPolicy: {
            mode: "sandbox-only",
            sandboxRoot: input.remediationWorkspacePath,
            forbiddenRealProjects: [join(input.root, "real-user-project")],
          },
        },
      },
      confirmPreStartAdmission: true,
      startWorker: false,
      executionMode: "sync",
      confirmRefill: true,
    },
  });
  const text = (
    response as { readonly content?: readonly { readonly text?: string }[] }
  ).content?.[0]?.text;
  if (!text?.startsWith("{")) throw new Error(text ?? "missing response");
  const result = JSON.parse(text) as Record<string, unknown>;
  if (result.ok !== true) throw new Error(JSON.stringify(result));
  return result;
}

export async function revision(workspacePath: string): Promise<string> {
  return (await gitStdout(workspacePath, ["rev-parse", "HEAD"])).trim();
}

export async function stagedPatchSha256(
  workspacePath: string,
): Promise<string> {
  const patch = await gitStdout(workspacePath, [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
  ]);
  return createHash("sha256").update(patch).digest("hex");
}
