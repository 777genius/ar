import { LocalIntegrationAttemptStore } from "../../store-local-file/integration-attempts/adapters/local-integration-attempt-store";
import { SimpleSecretScanner } from "../../worker-local/simple-secret-scanner";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { captureCodexGoalExactWorkspacePatch } from "../codex-goal-handoff-artifacts";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import { localProjectControlEvidenceCustodySupported } from
  "../../worker-local/project-control-evidence-custody-local-adapter";
import {
  callToolJson,
  git,
  gitInitRepository,
} from "./codex-goal-mcp-test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Codex project reviewed worker output", () => {
  it.runIf(localProjectControlEvidenceCustodySupported)(
    "captures through mark_reviewed and resolves through open_integration_attempt",
    async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-reviewed-mcp-"),
    );
    roots.push(root);
    const registryRootDir = join(root, "worker-jobs", "registry");
    const workerJobsRoot = join(root, "worker-jobs");
    const controlRoot = join(root, "control");
    const ledgerRoot = join(controlRoot, "consumed-output-ledger");
    const evidenceRoot = join(controlRoot, "archives");
    const controllerJobId = "project-controller";
    const workerJobId = "project-worker";
    const controllerJobRoot = join(root, "worker-jobs", controllerJobId);
    const workerJobRoot = join(root, "worker-jobs", workerJobId);
    const workerWorkspacePath = join(root, "worktrees", workerJobId);
    const targetWorkspacePath = join(root, "workspaces", "canonical");
    await Promise.all([
      mkdir(workerWorkspacePath, { recursive: true }),
      mkdir(targetWorkspacePath, { recursive: true }),
      mkdir(workerJobRoot, { recursive: true }),
      mkdir(controlRoot, { recursive: true }),
    ]);
    await gitInitRepository(workerWorkspacePath);
    await gitInitRepository(targetWorkspacePath);
    await mkdir(join(workerWorkspacePath, "docs"), { recursive: true });
    await Promise.all([
      writeFile(join(workerWorkspacePath, "docs", "packet.md"), "base\n"),
      writeFile(
        join(workerWorkspacePath, "package.json"),
        '{"private":true}\n',
      ),
      writeFile(join(workerWorkspacePath, ".gitignore"), "/node_modules\n"),
    ]);
    await git(workerWorkspacePath, ["add", "."]);
    await git(workerWorkspacePath, ["commit", "-m", "test: base"]);
    await writeFile(
      join(workerWorkspacePath, "docs", "packet.md"),
      "accepted output\n",
    );
    const patch = await captureGitWorkspacePatch({
      workspacePath: workerWorkspacePath,
    });
    const generatedDependencies = join(
      workerWorkspacePath,
      "mcp-server",
      "node_modules",
    );
    const foreignGeneratedDependencies = join(
      root,
      "foreign-generated-dependencies",
    );
    await Promise.all([
      mkdir(join(workerWorkspacePath, "mcp-server"), { recursive: true }),
      mkdir(foreignGeneratedDependencies, { recursive: true }),
    ]);
    await symlink(foreignGeneratedDependencies, generatedDependencies);

    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "reviewed-output-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: workerJobId,
        jobRootDir: workerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: workerWorkspacePath,
        promptPath: join(workerJobRoot, "prompt.md"),
        taskId: workerJobId,
        accounts: ["account-a"],
        tmuxSession: workerJobId,
        codexBinaryPath: join(root, "missing-codex"),
        networkAccess: NetworkAccessMode.Restricted,
      });
      await writeFile(
        join(workerJobRoot, "prompt.md"),
        "Continue reviewed remediation.\n",
      );
      const controller = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: controllerJobId,
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: targetWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: controllerJobId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "project",
          readRoots: [controlRoot, workerJobsRoot],
          workspaceRoots: [targetWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          consumedOutputLedgerRoots: [ledgerRoot],
          consumedOutputEvidenceRoots: [evidenceRoot],
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
          allowedBranches: ["main", "base/*"],
          allowedGitRemotes: ["origin"],
        },
      });

      expect(controller).toMatchObject({ ok: true });
      const reviewed = await callToolJson(
        client,
        "codex_goal_project_mark_reviewed",
        {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          captureReviewedOutput: true,
          reviewedOutputFileByteAllowance: 8 * 1024 * 1024,
          expectedPatchSha256: sha256(patch),
          reviewDecision: "approved",
          reviewedBy: controllerJobId,
          reviewReason: "Exact packet diff accepted.",
          approvedFiles: ["docs/packet.md"],
          requiredChecks: [],
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base/current",
            sourceCommit: "2".repeat(40),
            expectedTargetCommit: "3".repeat(40),
          },
          note: "ACCEPT",
        },
      );
      expect(reviewed).toMatchObject({
        ok: true,
        mode: "project_control_mark_reviewed",
        jobId: workerJobId,
      });
      const reviewedOutputId = String(reviewed.reviewedOutputId);
      expect(reviewedOutputId).toMatch(/^[a-f0-9]{64}$/);
      await expect(access(generatedDependencies)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(join(workerJobRoot, `${workerJobId}.result.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const marker = JSON.parse(
        await readFile(
          join(workerJobRoot, `${workerJobId}.review.json`),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(marker).toMatchObject({
        note: "ACCEPT",
        reviewedOutput: {
          reviewedOutputId,
          patchSha256: sha256(patch),
          changedFiles: ["docs/packet.md"],
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base/current",
            sourceCommit: "2".repeat(40),
            expectedTargetCommit: "3".repeat(40),
          },
        },
      });

      const preview = await callToolJson(
        client,
        "codex_goal_project_open_integration_attempt",
        {
          registryRootDir,
          controllerJobId,
          attemptId: "attempt-reviewed-output",
          reviewedOutputId,
          targetWorkspacePath,
          targetBranch: "main",
        },
      );
      expect(preview).toMatchObject({
        ok: false,
        reason: "confirm_open_required",
        attemptPreview: {
          workerOutput: {
            reviewedOutputFileByteAllowance: 8 * 1024 * 1024,
            reviewedOutputId,
            workerJobId,
            patchSha256: sha256(patch),
            changedFiles: ["docs/packet.md"],
            targetCommit: "3".repeat(40),
          },
          merge: {
            sourceRemote: "origin",
            sourceBranch: "base/current",
            sourceCommit: "2".repeat(40),
            expectedTargetCommit: "3".repeat(40),
          },
          reviewDecision: {
            reviewedBy: controllerJobId,
            reason: "Exact packet diff accepted.",
          },
        },
      });

      const rejected = await callToolJson(
        client,
        "codex_goal_project_mark_reviewed",
        {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          captureReviewedOutput: true,
          expectedPatchSha256: sha256(patch),
          reviewDecision: "rejected",
          reviewedBy: controllerJobId,
          reviewReason: "The same worker must remediate this exact patch.",
          approvedFiles: ["docs/packet.md"],
          requiredChecks: [],
          note: "REJECT",
        },
      );
      const rejectedOutputId = String(rejected.reviewedOutputId);
      expect(rejectedOutputId).toMatch(/^[a-f0-9]{64}$/);
      expect(rejectedOutputId).not.toBe(reviewedOutputId);
      expect(rejected, JSON.stringify(rejected)).toMatchObject({
        consumedOutputLedger: {
          decision: {
            jobId: workerJobId,
            attemptId: rejectedOutputId,
            status: "rejected",
          },
          idempotentReplay: false,
        },
      });
      const rejectedReplay = await callToolJson(
        client,
        "codex_goal_project_mark_reviewed",
        {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          captureReviewedOutput: true,
          expectedPatchSha256: sha256(patch),
          reviewDecision: "rejected",
          reviewedBy: controllerJobId,
          reviewReason: "The same worker must remediate this exact patch.",
          approvedFiles: ["docs/packet.md"],
          requiredChecks: [],
          note: "REJECT",
        },
      );
      expect(rejectedReplay).toMatchObject({
        reviewedOutputId: rejectedOutputId,
        consumedOutputLedger: {
          decision: {
            jobId: workerJobId,
            attemptId: rejectedOutputId,
            status: "rejected",
          },
          idempotentReplay: true,
        },
      });
      await expect(
        callToolJson(client, "codex_goal_project_open_integration_attempt", {
          registryRootDir,
          controllerJobId,
          attemptId: "attempt-rejected-output",
          reviewedOutputId: rejectedOutputId,
          targetWorkspacePath,
          targetBranch: "main",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_worker_output_not_approved",
      });

      await expect(
        callToolJson(client, "codex_goal_project_start", {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          forceStart: true,
          confirmStart: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "project_control_reviewed_dirty_continuation_output_required",
      });
      await expect(
        callToolJson(client, "codex_goal_project_start", {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          reviewedOutputId,
          forceStart: true,
          confirmStart: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_worker_output_rejected_continuation_required",
      });
      await writeFile(
        join(workerWorkspacePath, "docs", "packet.md"),
        "changed after review\n",
      );
      await expect(
        callToolJson(client, "codex_goal_project_start", {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          reviewedOutputId: rejectedOutputId,
          forceStart: true,
          confirmStart: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_worker_output_workspace_changed_after_capture",
      });
      await writeFile(
        join(workerWorkspacePath, "docs", "packet.md"),
        "accepted output\n",
      );
      const foreignDependencies = join(root, "foreign-node-modules");
      const workerDependencies = join(workerWorkspacePath, "node_modules");
      await Promise.all([
        mkdir(foreignDependencies, { recursive: true }),
        mkdir(workerDependencies, { recursive: true }),
      ]);
      await symlink(foreignDependencies, join(workerDependencies, ".pnpm"));
      await expect(
        callToolJson(client, "codex_goal_project_start", {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          reviewedOutputId: rejectedOutputId,
          forceStart: true,
          confirmStart: true,
        }),
      ).resolves.toMatchObject({
        ok: false,
        reason:
          "project_control_dependency_environment_sanitized_recapture_required",
        sanitizedPaths: ["node_modules"],
      });
      await expect(
        access(join(workerWorkspacePath, "node_modules")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const continuation = await callToolJson(
        client,
        "codex_goal_project_start",
        {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          reviewedOutputId: rejectedOutputId,
          forceStart: true,
          confirmStart: true,
        },
      );
      expect(continuation).toMatchObject({ ok: false });
      expect(String(continuation.error)).toContain("doctor");
    } finally {
      await client.close();
      await server.close();
    }
    },
  );

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "quarantines an over-limit rejected workspace without a reviewed snapshot",
    async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-rejected-uncaptured-mcp-"),
    );
    roots.push(root);
    const registryRootDir = join(root, "worker-jobs", "registry");
    const workerJobsRoot = join(root, "worker-jobs");
    const controlRoot = join(root, "control");
    const ledgerRoot = join(controlRoot, "consumed-output-ledger");
    const evidenceRoot = join(controlRoot, "archives");
    const controllerJobId = "project-controller";
    const workerJobId = "project-over-limit-worker";
    const controllerJobRoot = join(root, "worker-jobs", controllerJobId);
    const workerJobRoot = join(root, "worker-jobs", workerJobId);
    const workerWorkspacePath = join(root, "worktrees", workerJobId);
    const targetWorkspacePath = join(root, "workspaces", "canonical");
    await Promise.all([
      mkdir(workerWorkspacePath, { recursive: true }),
      mkdir(targetWorkspacePath, { recursive: true }),
      mkdir(workerJobRoot, { recursive: true }),
      mkdir(controlRoot, { recursive: true }),
    ]);
    await gitInitRepository(workerWorkspacePath);
    await gitInitRepository(targetWorkspacePath);
    await writeFile(join(workerWorkspacePath, "tracked.txt"), "base\n");
    await git(workerWorkspacePath, ["add", "."]);
    await git(workerWorkspacePath, ["commit", "-m", "test: base"]);
    await writeFile(join(workerWorkspacePath, "tracked.txt"), "changed\n");
    await mkdir(join(workerWorkspacePath, "untracked"), { recursive: true });
    await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        writeFile(
          join(
            workerWorkspacePath,
            "untracked",
            `${String(index).padStart(3, "0")}.txt`,
          ),
          `change ${index}\n`,
        ),
      ),
    );
    const changedFiles = [
      "tracked.txt",
      ...Array.from(
        { length: 256 },
        (_, index) => `untracked/${String(index).padStart(3, "0")}.txt`,
      ),
    ];
    await writeFile(
      join(workerJobRoot, `${workerJobId}.latest-result.json`),
      `${JSON.stringify({
        status: "done",
        updatedAt: "2026-07-17T00:00:00.000Z",
        changedFiles,
        evidence: [],
        blockers: [],
        nextAction: "review_completed",
      })}\n`,
    );
    const patch = await captureGitWorkspacePatch({
      workspacePath: workerWorkspacePath,
    });

    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "rejected-uncaptured-output-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: workerJobId,
        jobRootDir: workerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: workerWorkspacePath,
        promptPath: join(workerJobRoot, "prompt.md"),
        taskId: workerJobId,
        accounts: ["account-a"],
        tmuxSession: workerJobId,
        codexBinaryPath: join(root, "missing-codex"),
        networkAccess: NetworkAccessMode.Restricted,
      });
      const controller = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: controllerJobId,
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: targetWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: controllerJobId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "project",
          readRoots: [controlRoot, workerJobsRoot],
          workspaceRoots: [targetWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          consumedOutputLedgerRoots: [ledgerRoot],
          consumedOutputEvidenceRoots: [evidenceRoot],
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
          allowedBranches: ["main"],
          allowedGitRemotes: ["origin"],
        },
      });

      expect(controller).toMatchObject({ ok: true });
      await expect(
        callToolJson(client, "codex_goal_project_mark_reviewed", {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          captureReviewedOutput: false,
          reviewDecision: "approved",
          note: "invalid approval",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "project_control_reviewed_output_capture_required",
      });
      await expect(
        callToolJson(client, "codex_goal_project_mark_reviewed", {
          registryRootDir,
          controllerJobId,
          jobId: workerJobId,
          captureReviewedOutput: true,
          expectedPatchSha256: sha256(patch),
          reviewDecision: "rejected",
          reviewedBy: controllerJobId,
          reviewReason: "Over the reviewed snapshot path limit.",
          approvedFiles: changedFiles,
          requiredChecks: [],
          note: "REJECT over limit",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: "reviewed_worker_output_changed_file_limit_exceeded",
      });

      const rejectionArgs = {
        registryRootDir,
        controllerJobId,
        jobId: workerJobId,
        captureReviewedOutput: false,
        reviewDecision: "rejected",
        reviewedBy: controllerJobId,
        reviewReason: "Over-limit output quarantined without integration.",
        note: "FORMAL REJECT",
      };
      const rejected = await callToolJson(
        client,
        "codex_goal_project_mark_reviewed",
        rejectionArgs,
      );
      expect(rejected, JSON.stringify(rejected)).toMatchObject({
        ok: true,
        jobId: workerJobId,
        consumedOutputLedger: {
          decision: { jobId: workerJobId, status: "rejected" },
          idempotentReplay: false,
        },
      });
      expect(rejected).not.toHaveProperty("reviewedOutputId");
      const ledger = rejected.consumedOutputLedger as {
        decision: { backup: { patchPath: string } };
      };
      const archivedPatch = await readFile(
        ledger.decision.backup.patchPath,
        "utf8",
      );
      expect(archivedPatch).toContain("tracked.txt");
      expect(archivedPatch).toContain("untracked/000.txt");
      expect(archivedPatch).toContain("untracked/255.txt");
      expect(
        await captureGitWorkspacePatch({
          workspacePath: workerWorkspacePath,
        }),
      ).toBe(patch);

      const replay = await callToolJson(
        client,
        "codex_goal_project_mark_reviewed",
        rejectionArgs,
      );
      expect(replay).toMatchObject({
        consumedOutputLedger: { idempotentReplay: true },
      });
      const admission = await callToolJson(
        client,
        "codex_goal_project_admission_snapshot",
        {
          registryRootDir,
          controllerJobId,
          operation: "create_job",
          workerRole: "producer",
          includeDetails: true,
        },
      );
      expect(admission).toMatchObject({
        snapshot: {
          counts: {
            activeWriterConflicts: 0,
            unconsumedCompletedJobs: 0,
          },
        },
        decision: { allowed: true },
      });
    } finally {
      await client.close();
      await server.close();
    }
    },
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

it.runIf(localProjectControlEvidenceCustodySupported)("delivers a >4MiB reviewed report through public MCP", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-reviewed-mcp-"),
    );
    roots.push(root);
    const registryRootDir = join(root, "worker-jobs", "registry");
    const workerJobsRoot = join(root, "worker-jobs");
    const controlRoot = join(root, "control");
    const ledgerRoot = join(controlRoot, "consumed-output-ledger");
    const evidenceRoot = join(controlRoot, "archives");
    const controllerJobId = "project-controller";
    const workerJobId = "project-worker";
    const controllerJobRoot = join(root, "worker-jobs", controllerJobId);
    const workerJobRoot = join(root, "worker-jobs", workerJobId);
    const workerWorkspacePath = join(root, "worktrees", workerJobId);
    const targetWorkspacePath = join(root, "workspaces", "canonical");
    await Promise.all([
      mkdir(workerWorkspacePath, { recursive: true }),
      mkdir(targetWorkspacePath, { recursive: true }),
      mkdir(workerJobRoot, { recursive: true }),
      mkdir(controlRoot, { recursive: true }),
    ]);
    await gitInitRepository(workerWorkspacePath);

    await mkdir(join(workerWorkspacePath, "docs"), { recursive: true });
    await Promise.all([
      writeFile(join(workerWorkspacePath, "docs", "packet.md"), "base\n"),
      writeFile(
        join(workerWorkspacePath, "package.json"),
        '{"private":true}\n',
      ),
      writeFile(join(workerWorkspacePath, ".gitignore"), "/node_modules\n"),
    ]);
    await git(workerWorkspacePath, ["add", "."]);
    await git(workerWorkspacePath, ["commit", "-m", "test: base"]);
    await git(targetWorkspacePath, ["clone", workerWorkspacePath, "."]);
    await git(targetWorkspacePath, ["config", "user.name", "iliya"]);
    await git(targetWorkspacePath, ["config", "user.email", "iliyazelenkog@gmail.com"]);
    const hook = join(targetWorkspacePath, ".git", "hooks", "pre-commit");
    const authorHook = '#!/bin/sh\nset -eu\nfor kind in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do\n  ident=$(git var "$kind")\n  case "$ident" in "iliya <iliyazelenkog@gmail.com> "*) ;; *) exit 1 ;; esac\ndone\n';
    await writeFile(hook, authorHook, { mode: 0o700 });
    await writeFile(join(workerWorkspacePath, "package.json"), '{"sentinel":"configured scanner sentinel"}\n');
    const report = "Reviewed report line.\n".repeat(230000).slice(0, 4678817) + "\n";
    await writeFile(join(workerWorkspacePath, "docs", "packet.md"), report);
    const patch = (await captureCodexGoalExactWorkspacePatch({ workspacePath: workerWorkspacePath,
      limits: { maxFileBytes: 8 * 1024 * 1024 }, enforceSingleWorkspaceLayer: false }))!.patch;
    const generatedDependencies = join(
      workerWorkspacePath,
      "mcp-server",
      "node_modules",
    );
    const foreignGeneratedDependencies = join(
      root,
      "foreign-generated-dependencies",
    );
    await Promise.all([
      mkdir(join(workerWorkspacePath, "mcp-server"), { recursive: true }),
      mkdir(foreignGeneratedDependencies, { recursive: true }),
    ]);
    await symlink(foreignGeneratedDependencies, generatedDependencies);

    const server = createCodexGoalMcpServer();
    const client = new Client({
      name: "reviewed-output-test",
      version: "0.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: workerJobId,
        jobRootDir: workerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: workerWorkspacePath,
        promptPath: join(workerJobRoot, "prompt.md"),
        taskId: workerJobId,
        accounts: ["account-a"],
        tmuxSession: workerJobId,
        codexBinaryPath: join(root, "missing-codex"),
        networkAccess: NetworkAccessMode.Restricted,
      });
      await writeFile(
        join(workerJobRoot, "prompt.md"),
        "Continue reviewed remediation.\n",
      );
      const controller = await callToolJson(client, "codex_goal_create_job", {
        registryRootDir,
        jobId: controllerJobId,
        jobRootDir: controllerJobRoot,
        authRootDir: join(root, "auth"),
        workspacePath: targetWorkspacePath,
        promptPath: join(controllerJobRoot, "prompt.md"),
        taskId: controllerJobId,
        accounts: ["account-a"],
        accessBoundary: AccessBoundary.ProjectScopedControl,
        networkAccess: NetworkAccessMode.Restricted,
        projectAccessScope: {
          projectId: "project",
          readRoots: [controlRoot, workerJobsRoot],
          workspaceRoots: [targetWorkspacePath],
          worktreeRoots: [join(root, "worktrees")],
          registryRoot: registryRootDir,
          consumedOutputLedgerRoots: [ledgerRoot],
          consumedOutputEvidenceRoots: [evidenceRoot],
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
          allowedBranches: ["main", "base/*"],
          allowedGitRemotes: ["origin"],
        },
      });

      expect(controller).toMatchObject({ ok: true });

      const reviewed = await callToolJson(client, "codex_goal_project_mark_reviewed", {
        registryRootDir, controllerJobId, jobId: workerJobId, captureReviewedOutput: true,
        reviewedOutputFileByteAllowance: 8 * 1024 * 1024, expectedPatchSha256: sha256(patch),
        reviewDecision: "approved", reviewedBy: controllerJobId, reviewReason: "Exact report accepted.",
        approvedFiles: ["docs/packet.md", "package.json"], requiredChecks: [{ checkId: "report", command: [process.execPath, "-e", "process.exit(0)"] }], note: "ACCEPT",
      });
      expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
      const common = { registryRootDir, controllerJobId, attemptId: "large-mcp" };
      for (const [tool, args] of [
        ["open_integration_attempt", { reviewedOutputId: reviewed.reviewedOutputId, targetWorkspacePath, targetBranch: "main", confirmOpen: true }],
        ["apply_worker_output", { confirmApply: true }],
        ["run_required_checks", { confirmRunChecks: true }],
      ] as const) {
        const result = await callToolJson(client, `codex_goal_project_${tool}`, { ...common, ...args });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      }
      const commitArgs = { ...common, confirmCommit: true, message: "docs: reviewed report" };
      const commitTool = "codex_goal_project_commit_approved_changes";
      const head = async () => (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: targetWorkspacePath })).stdout.trim();
      const before = await head();
      await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      expect(await callToolJson(client, commitTool, commitArgs)).toMatchObject({ ok: false });
      expect(await head()).toBe(before);
      await writeFile(hook, '#!/bin/sh\nprintf "hook drift\\n" >> docs/packet.md\ngit add docs/packet.md\n', { mode: 0o700 });
      expect(await callToolJson(client, commitTool, commitArgs)).toMatchObject({ ok: false });
      expect(await head()).toBe(before);
      await writeFile(join(targetWorkspacePath, "docs", "packet.md"), report);
      await writeFile(hook, authorHook, { mode: 0o700 });
      await git(targetWorkspacePath, ["reset", "HEAD", "--", "package.json"]);
      const originalScan = SimpleSecretScanner.prototype.scanFiles;
      const scanned: string[][] = [];
      const scanSpy = vi.spyOn(SimpleSecretScanner.prototype, "scanFiles").mockImplementation(async function(input) {
        scanned.push([...input.files]);
        return originalScan.call(new SimpleSecretScanner({ patterns: [/configured scanner sentinel/] }), input);
      });
      try {
        for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
          await git(targetWorkspacePath, ["update-index", flag, "package.json"]);
          const status = (await promisify(execFile)("git", ["status", "--porcelain"], { cwd: targetWorkspacePath })).stdout;
          expect(status).not.toContain("package.json");
          expect(await callToolJson(client, commitTool, commitArgs)).toMatchObject({ ok: false });
          expect(scanned.at(-1)).toEqual(["docs/packet.md", "package.json"]);
          expect(await head()).toBe(before);
        }
      } finally { scanSpy.mockRestore(); }
      const originalUpdate = LocalIntegrationAttemptStore.prototype.update;
      let failedAfterPublication = false;
      const updateSpy = vi.spyOn(LocalIntegrationAttemptStore.prototype, "update").mockImplementation(async function(this: LocalIntegrationAttemptStore, attempt) {
        if (attempt.commitCandidate && !failedAfterPublication) {
          const durable = await this.get(attempt.attemptId);
          expect(durable?.preparedReviewedCommit?.candidate.commitSha).toBe(await head());
          expect(durable?.commitCandidate).toBeUndefined();
          failedAfterPublication = true;
          throw new Error("fixture_commit_created_persistence_failure");
        }
        return originalUpdate.call(this, attempt);
      });
      try {
        expect(await callToolJson(client, commitTool, commitArgs)).toMatchObject({ ok: false });
        expect(failedAfterPublication).toBe(true);
      } finally { updateSpy.mockRestore(); }
      const published = await head();
      expect(published).not.toBe(before);
      expect(await callToolJson(client, commitTool, commitArgs)).toMatchObject({ ok: true });
      expect(await head()).toBe(published);
      expect(await callToolJson(client, commitTool, commitArgs)).toMatchObject({ ok: true });
      expect(await head()).toBe(published);
      const committed = (await promisify(execFile)("git", ["rev-parse", "HEAD:docs/packet.md"], { cwd: targetWorkspacePath })).stdout.trim();
      const expected = (await promisify(execFile)("git", ["hash-object", "docs/packet.md"], { cwd: workerWorkspacePath })).stdout.trim();
      expect(committed).toMatch(/^[a-f0-9]{40,64}$/);
      expect(expected).toMatch(/^[a-f0-9]{40,64}$/);
      expect(committed).toBe(expected);
      expect(Buffer.byteLength(await readFile(join(targetWorkspacePath, "docs", "packet.md")))).toBe(4678818);
    } finally {
      await client.close();
      await server.close();
    }
});
