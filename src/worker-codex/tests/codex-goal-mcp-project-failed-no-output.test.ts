import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  AccessBoundary,
  NetworkAccessMode,
  ReviewDecisionStatus,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexGoalJob, type CodexGoalProjectPreStartAdmission } from "../codex-goal-jobs";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import {
  codexGoalOutputPath,
  codexGoalProgressPath,
  codexGoalRuntimeEventsPath,
} from "../codex-goal-runner";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  codexProjectControlBroker,
  loadJobLaunch,
  loadProjectControlController,
} from "../codex-goal-mcp-project-control-deps";
import {
  projectControlRecordFailedNoOutputView,
} from "../codex-goal-mcp-project-control-terminal-output";
import {
  assertCodexGoalProjectJobNotTerminal,
  readCodexGoalConsumedOutputLedgers,
} from "../application/project-control/codex-goal-consumed-output-ledger-io";
import type { ReviewedWorkerOutputSnapshot } from "../reviewed-worker-output";
import { localProjectControlEvidenceCustodySupported } from
  "../../worker-local/project-control-evidence-custody-local-adapter";
import { git, gitInitRepository } from "./codex-goal-mcp-test-support";

describe("project failed_no_output lifecycle", () => {
  it.runIf(localProjectControlEvidenceCustodySupported)(
    "closes only a never-started exact input patch with immutable evidence",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "subscription-runtime-prestart-close-"));
      const outside = await mkdtemp(join(tmpdir(), "subscription-runtime-outside-"));
      const registryRootDir = join(root, "worker-jobs", "registry");
      const ledgerRoot = join(root, "control", "ledger");
      const evidenceRoot = join(root, "control", "archives");
      const worktreeRoot = join(root, "worktrees");
      const controllerJobId = "project-controller-prestart";
      const deps = { loadProjectControlController, loadJobLaunch, codexProjectControlBroker };
      try {
        await mkdir(join(root, "auth"), { recursive: true });
        await createCleanWorkspace(join(root, "repo"));
        await createStoredJob({
          registryRootDir, root, authRoot: join(root, "auth"),
          jobId: controllerJobId, workspacePath: join(root, "repo"),
          accessBoundary: AccessBoundary.ProjectScopedControl,
          projectAccessScope: {
            projectId: "project", readRoots: [root],
            workspaceRoots: [join(root, "repo")], worktreeRoots: [worktreeRoot],
            registryRoot: registryRootDir,
            consumedOutputLedgerRoots: [ledgerRoot],
            consumedOutputEvidenceRoots: [evidenceRoot],
            jobIdPrefixes: ["project-"], tmuxSessionPrefixes: ["project-"],
            allowedAccountIds: ["account-a"],
          },
        });
        const prepare = async (name: string, descriptor?: CodexGoalProjectPreStartAdmission) => {
          const jobId = `project-${name}`;
          const workspacePath = join(worktreeRoot, jobId);
          await createCleanWorkspace(workspacePath);
          await writeFile(join(workspacePath, "README.md"), "imported input\n");
          await writeFile(join(workspacePath, "binary.dat"), Buffer.from([0, 255, 1, 2]));
          await createStoredJob({
            registryRootDir, root, authRoot: join(root, "auth"), jobId,
            workspacePath, ...(descriptor ? { projectPreStartAdmission: descriptor } : {}),
          });
          const patch = await captureGitWorkspacePatch({ workspacePath });
          const sha256 = createHash("sha256").update(patch).digest("hex");
          const patchPath = join(root, "worker-jobs", jobId, "imported.patch");
          await writeFile(patchPath, patch);
          return {
            jobId, workspacePath, patch, sha256, patchPath,
            args: {
              registryRootDir, controllerJobId, jobId,
              terminalAttemptId: `terminal-${name}`,
              failureCategory: "infrastructure", failureCode: "prestart_failure",
              confirmFailedNoOutput: true, confirmPreexistingWorkspacePatch: true,
              preexistingWorkspacePatchPath: patchPath,
              preexistingWorkspacePatchSha256: sha256,
            },
          };
        };
        const exact = await prepare("exact");
        expect(exact.patch).toContain("README.md");
        expect(exact.patch).toContain("binary.dat");
        await expect(projectControlRecordFailedNoOutputView({
          ...exact.args, confirmPreexistingWorkspacePatch: false,
        }, deps)).resolves.toMatchObject({
          ok: false, reason: "confirm_preexisting_workspace_patch_required",
        });
        const recorded = await projectControlRecordFailedNoOutputView(exact.args, deps);
        expect(recorded).toMatchObject({
          ok: true,
          decision: {
            status: "failed_no_output",
            output: { authoredChanges: false, workspaceDirty: false },
            preexistingWorkspacePatch: { sha256: exact.sha256 },
          },
        });
        const decision = recorded.decision as {
          readonly preexistingWorkspacePatch: { readonly path: string };
          readonly backup: { readonly statusPath: string; readonly patchPath: string };
        };
        await expect(readFile(decision.preexistingWorkspacePatch.path, "utf8"))
          .resolves.toBe(exact.patch);
        await expect(readFile(decision.backup.statusPath, "utf8"))
          .resolves.toContain("README.md");
        await expect(readFile(decision.backup.patchPath, "utf8"))
          .resolves.toBe("");
        const ledger = await readCodexGoalConsumedOutputLedgers({
          roots: [ledgerRoot], evidenceRoots: [evidenceRoot],
        });
        expect(ledger.byJobId.get(exact.jobId)).toMatchObject({
          valid: true, status: "failed_no_output",
        });
        await expect(projectControlRecordFailedNoOutputView(exact.args, deps))
          .resolves.toMatchObject({ ok: true, alreadyTerminal: true, idempotentReplay: true });

        const mismatch = await prepare("mismatch");
        await writeFile(join(mismatch.workspacePath, "README.md"), "authored after import\n");
        await expect(projectControlRecordFailedNoOutputView(mismatch.args, deps))
          .rejects.toThrow("failed_no_output_preexisting_patch_workspace_sha256_mismatch");

        for (const kind of ["log", "result", "progress", "events"] as const) {
          const artifact = await prepare(`artifact-${kind}`);
          const jobRootDir = join(root, "worker-jobs", artifact.jobId);
          const config = { jobRootDir, taskId: artifact.jobId };
          const artifactPath = kind === "log"
            ? join(jobRootDir, `${artifact.jobId}.log`)
            : kind === "result"
            ? codexGoalOutputPath(config)
            : kind === "progress"
            ? codexGoalProgressPath(config)
            : codexGoalRuntimeEventsPath(config);
          await writeFile(artifactPath, "");
          await expect(projectControlRecordFailedNoOutputView(artifact.args, deps))
            .rejects.toThrow("failed_no_output_worker_launch_artifacts_present");
        }

        const marker = await prepare("marker");
        await writeFile(join(root, "worker-jobs", marker.jobId, `${marker.jobId}.stop-event.json`), "{}");
        await expect(projectControlRecordFailedNoOutputView(marker.args, deps))
          .rejects.toThrow("failed_no_output_worker_launch_artifacts_present");

        const escaped = await prepare("escaped");
        const outsidePatchPath = join(outside, "imported.patch");
        await writeFile(outsidePatchPath, escaped.patch);
        await expect(projectControlRecordFailedNoOutputView({
          ...escaped.args, preexistingWorkspacePatchPath: outsidePatchPath,
        }, deps)).rejects.toThrow("project_control_failed_no_output_backup_denied");

        const descriptorJobId = "project-descriptor";
        const descriptor = {
          schemaVersion: 1 as const, mode: "serial-builtin" as const,
          contractPath: join(root, "worker-jobs", descriptorJobId, "contract.json"),
          statePath: join(root, "worker-jobs", descriptorJobId, "state.json"),
          receiptPath: join(root, "worker-jobs", descriptorJobId, "receipt.json"),
        };
        const guarded = await prepare("descriptor", descriptor);
        await expect(projectControlRecordFailedNoOutputView(guarded.args, deps))
          .rejects.toThrow();

        const admissionControllerId = "project-controller-admission";
        await createStoredJob({
          registryRootDir, root, authRoot: join(root, "auth"),
          jobId: admissionControllerId, workspacePath: join(root, "repo"),
          accessBoundary: AccessBoundary.ProjectScopedControl,
          projectAccessScope: {
            projectId: "project", readRoots: [root],
            workspaceRoots: [join(root, "repo")], worktreeRoots: [worktreeRoot],
            registryRoot: registryRootDir,
            consumedOutputLedgerRoots: [ledgerRoot],
            consumedOutputEvidenceRoots: [evidenceRoot],
            jobIdPrefixes: ["project-"], tmuxSessionPrefixes: ["project-"],
            allowedAccountIds: ["account-a"],
            preStartAdmission: { required: true, mode: "serial-builtin" },
          },
        });
        const policyGuarded = await prepare("policy-guarded");
        await expect(projectControlRecordFailedNoOutputView({
          ...policyGuarded.args, controllerJobId: admissionControllerId,
        }, deps)).rejects.toThrow("project_control_pre_start_admission_required");
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  );
  it("publishes the project-scoped MCP tool", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "failed-no-output-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) =>
        tool.name === "codex_goal_project_record_failed_no_output"
      )).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "corrects empty rejected output append-only and rejects dirty workspaces",
    async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-failed-no-output-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const ledgerRoot = join(root, "control", "consumed-output-ledger");
    const evidenceRoot = join(root, "control", "archives");
    const worktreeRoot = join(root, "worktrees");
    const controllerWorkspace = join(root, "repo");
    const authRoot = join(root, "auth");
    const controllerJobId = "project-controller-v1";
    const freshWorkerJobId = "project-worker-fresh-v1";
    const freshDirtyWorkerJobId = "project-worker-fresh-dirty-v1";
    const workerJobId = "project-worker-v1";
    const dirtyWorkerJobId = "project-worker-dirty-v1";
    const verifierJobId = "project-verifier-v1";

    try {
      await mkdir(authRoot, { recursive: true });
      await createCleanWorkspace(controllerWorkspace);
      await createCleanWorkspace(join(worktreeRoot, freshWorkerJobId));
      await createCleanWorkspace(join(worktreeRoot, freshDirtyWorkerJobId));
      await createCleanWorkspace(join(worktreeRoot, workerJobId));
      await createCleanWorkspace(join(worktreeRoot, dirtyWorkerJobId));
      await createCleanWorkspace(join(worktreeRoot, verifierJobId));
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: controllerJobId,
        workspacePath: controllerWorkspace,
        accessBoundary: AccessBoundary.ProjectScopedControl,
        projectAccessScope: {
          projectId: "project",
          readRoots: [root],
          workspaceRoots: [controllerWorkspace],
          worktreeRoots: [worktreeRoot],
          registryRoot: registryRootDir,
          consumedOutputLedgerRoots: [ledgerRoot],
          consumedOutputEvidenceRoots: [evidenceRoot],
          jobIdPrefixes: ["project-"],
          tmuxSessionPrefixes: ["project-"],
          allowedAccountIds: ["account-a"],
        },
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: freshWorkerJobId,
        workspacePath: join(worktreeRoot, freshWorkerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: freshDirtyWorkerJobId,
        workspacePath: join(worktreeRoot, freshDirtyWorkerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: workerJobId,
        workspacePath: join(worktreeRoot, workerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: dirtyWorkerJobId,
        workspacePath: join(worktreeRoot, dirtyWorkerJobId),
      });
      await createStoredJob({
        registryRootDir,
        root,
        authRoot,
        jobId: verifierJobId,
        workspacePath: join(worktreeRoot, verifierJobId),
      });
      await writeMislabeledNoOutput({
        root,
        ledgerRoot,
        jobId: workerJobId,
        archiveRoot: evidenceRoot,
      });
      await writeMislabeledNoOutput({
        root,
        ledgerRoot,
        jobId: dirtyWorkerJobId,
        archiveRoot: evidenceRoot,
      });

      const deps = {
        loadProjectControlController,
        loadJobLaunch,
        codexProjectControlBroker,
      };
      const args = {
        registryRootDir,
        controllerJobId,
        jobId: workerJobId,
        terminalAttemptId: "terminalize-project-worker-v1",
        failureCategory: "infrastructure",
        failureCode: "prewarm_failed_before_task",
      };
      const freshArgs = {
        ...args,
        jobId: freshWorkerJobId,
        terminalAttemptId: "terminalize-project-worker-fresh-v1",
        failureCode: "stale_source_before_task",
      };
      await expect(projectControlRecordFailedNoOutputView(freshArgs, deps)).resolves
        .toMatchObject({
          ok: false,
          reason: "confirm_failed_no_output_required",
          sourceRecord: null,
          decisionPreview: {
            status: "failed_no_output",
            failure: {
              category: "infrastructure",
              code: "stale_source_before_task",
            },
          },
        });
      const freshRecorded = await projectControlRecordFailedNoOutputView({
        ...freshArgs,
        confirmFailedNoOutput: true,
      }, deps);
      expect(freshRecorded).toMatchObject({
        ok: true,
        mode: "project_control_record_failed_no_output",
        decision: {
          jobId: freshWorkerJobId,
          status: "failed_no_output",
          failure: {
            category: "infrastructure",
            code: "stale_source_before_task",
          },
          output: { authoredChanges: false, workspaceDirty: false },
        },
      });
      const freshDecision = freshRecorded.decision as {
        readonly archivePath: string;
        readonly backup: {
          readonly statusPath: string;
          readonly patchPath: string;
          readonly numstatPath: string;
        };
      };
      await expect(readFile(freshDecision.backup.statusPath, "utf8")).resolves.toBe("");
      await expect(readFile(freshDecision.backup.patchPath, "utf8")).resolves.toBe("");
      await expect(readFile(freshDecision.backup.numstatPath, "utf8")).resolves.toBe("");
      expect(freshDecision.archivePath).toContain(
        `${freshWorkerJobId}-failed-no-output-terminalize-project-worker-fresh-v1`,
      );
      await expect(assertCodexGoalProjectJobNotTerminal({
        roots: [ledgerRoot],
        evidenceRoots: [evidenceRoot],
        projectId: "project",
        controllerJobId,
        jobId: freshWorkerJobId,
        taskId: freshWorkerJobId,
        workspacePath: join(worktreeRoot, freshWorkerJobId),
        reviewedContinuation: rejectedContinuationSnapshot({
          projectId: "project",
          controllerJobId,
          workerJobId: freshWorkerJobId,
          taskId: freshWorkerJobId,
          sourceWorkspacePath: join(worktreeRoot, freshWorkerJobId),
        }),
      })).rejects.toThrow(
        "project_control_terminal_job_start_denied:failed_no_output",
      );
      await expect(assertCodexGoalProjectJobNotTerminal({
        roots: [ledgerRoot],
        evidenceRoots: [evidenceRoot],
        projectId: "project",
        controllerJobId,
        jobId: freshWorkerJobId,
        taskId: freshWorkerJobId,
        workspacePath: join(worktreeRoot, freshWorkerJobId),
        capacityContinuation: true,
      })).resolves.toBeUndefined();
      await expect(projectControlRecordFailedNoOutputView({
        ...freshArgs,
        confirmFailedNoOutput: true,
      }, deps)).resolves.toMatchObject({
        ok: true,
        alreadyTerminal: true,
        idempotentReplay: true,
      });
      await writeFile(
        join(worktreeRoot, freshDirtyWorkerJobId, "dirty.txt"),
        "unarchived output\n",
      );
      await expect(projectControlRecordFailedNoOutputView({
        ...freshArgs,
        jobId: freshDirtyWorkerJobId,
        terminalAttemptId: "terminalize-project-worker-fresh-dirty-v1",
        confirmFailedNoOutput: true,
      }, deps)).rejects.toThrow("failed_no_output_clean_workspace_required");
      const unadmittedPatchPath = join(
        root,
        "worker-jobs",
        freshDirtyWorkerJobId,
        "unadmitted.patch",
      );
      const unadmittedPatch = "unadmitted input patch\n";
      await writeFile(unadmittedPatchPath, unadmittedPatch);
      await expect(projectControlRecordFailedNoOutputView({
        ...freshArgs,
        jobId: freshDirtyWorkerJobId,
        terminalAttemptId: "terminalize-unadmitted-dirty-v1",
        confirmFailedNoOutput: true,
        preexistingWorkspacePatchPath: unadmittedPatchPath,
        preexistingWorkspacePatchSha256: createHash("sha256")
          .update(unadmittedPatch)
          .digest("hex"),
        confirmPreexistingWorkspacePatch: true,
      }, deps)).rejects.toThrow("failed_no_output_preexisting_patch_workspace_sha256_mismatch");

      await expect(projectControlRecordFailedNoOutputView(args, deps)).resolves
        .toMatchObject({
          ok: false,
          reason: "confirm_failed_no_output_required",
        });
      const recorded = await projectControlRecordFailedNoOutputView({
        ...args,
        confirmFailedNoOutput: true,
      }, deps);
      expect(recorded).toMatchObject({
        ok: true,
        mode: "project_control_record_failed_no_output",
        decision: {
          status: "failed_no_output",
          output: { authoredChanges: false, workspaceDirty: false },
        },
      });
      await expect(readFile(String(recorded.ledgerPath), "utf8")).resolves
        .toContain('"status": "failed_no_output"');

      const ledger = await readCodexGoalConsumedOutputLedgers({
        roots: [ledgerRoot],
        evidenceRoots: [evidenceRoot],
      });
      expect(ledger.byJobId.get(workerJobId)).toMatchObject({
        status: "failed_no_output",
        valid: true,
      });
      await expect(projectControlRecordFailedNoOutputView({
        ...args,
        confirmFailedNoOutput: true,
      }, deps)).resolves.toMatchObject({
        ok: true,
        alreadyTerminal: true,
        idempotentReplay: true,
      });

      await writeFile(
        join(worktreeRoot, dirtyWorkerJobId, "dirty.txt"),
        "not authored evidence\n",
      );
      await expect(projectControlRecordFailedNoOutputView({
        ...args,
        jobId: dirtyWorkerJobId,
        terminalAttemptId: "terminalize-project-worker-dirty-v1",
        confirmFailedNoOutput: true,
      }, deps)).rejects.toThrow("failed_no_output_clean_workspace_required");

      const baseline = await writeBaselineFailedNoOutput({
        root,
        ledgerRoot,
        jobId: verifierJobId,
      });
      await writeFile(join(worktreeRoot, verifierJobId, "README.md"), "producer output\n");
      const verifierArgs = {
        ...args,
        jobId: verifierJobId,
        terminalAttemptId: "terminalize-project-verifier-v1",
        confirmFailedNoOutput: true,
        preexistingWorkspacePatchPath: baseline.path,
        preexistingWorkspacePatchSha256: baseline.sha256,
      };
      await expect(projectControlRecordFailedNoOutputView(verifierArgs, deps)).resolves
        .toMatchObject({
          ok: false,
          reason: "confirm_preexisting_workspace_patch_required",
        });
      await expect(projectControlRecordFailedNoOutputView({
        ...verifierArgs,
        confirmPreexistingWorkspacePatch: true,
      }, deps)).rejects.toThrow("failed_no_output_preexisting_patch_workspace_sha256_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    },
  );
});

function rejectedContinuationSnapshot(input: {
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly sourceWorkspacePath: string;
}): ReviewedWorkerOutputSnapshot {
  return {
    format: "reviewed-worker-output",
    formatRevision: 1,
    reviewedOutputId: "a".repeat(64),
    ...input,
    patchPath: join(input.sourceWorkspacePath, "worker-output.patch"),
    patchSha256: "b".repeat(64),
    patchByteLength: 1,
    baseCommit: "c".repeat(40),
    changedFiles: ["output.txt"],
    reviewDecision: {
      reviewedBy: "project-reviewer",
      decision: ReviewDecisionStatus.Rejected,
      reason: "Same-job remediation required.",
      approvedFiles: ["output.txt"],
      requiredChecks: [],
    },
    capturedAt: "2026-07-14T19:00:00.000Z",
  };
}

async function createCleanWorkspace(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await gitInitRepository(path);
  await writeFile(join(path, "README.md"), "base\n");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "test: base"]);
}

async function writeBaselineFailedNoOutput(input: {
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

async function createStoredJob(input: {
  readonly registryRootDir: string;
  readonly root: string;
  readonly authRoot: string;
  readonly jobId: string;
  readonly workspacePath: string;
  readonly accessBoundary?: AccessBoundary;
  readonly projectPreStartAdmission?: CodexGoalProjectPreStartAdmission;
  readonly projectAccessScope?: {
    readonly projectId: string;
    readonly readRoots: readonly string[];
    readonly workspaceRoots: readonly string[];
    readonly worktreeRoots: readonly string[];
    readonly registryRoot: string;
    readonly consumedOutputLedgerRoots: readonly string[];
    readonly consumedOutputEvidenceRoots: readonly string[];
    readonly jobIdPrefixes: readonly string[];
    readonly tmuxSessionPrefixes: readonly string[];
    readonly allowedAccountIds: readonly string[];
    readonly preStartAdmission?: { readonly required: boolean; readonly mode: "serial-builtin" };
  };
}): Promise<void> {
  const jobRootDir = join(input.root, "worker-jobs", input.jobId);
  await mkdir(jobRootDir, { recursive: true });
  await writeFile(join(jobRootDir, "prompt.md"), "test prompt\n");
  await createCodexGoalJob({
    registryRootDir: input.registryRootDir,
    manifest: {
      jobId: input.jobId,
      jobRootDir,
      authRootDir: input.authRoot,
      workspacePath: input.workspacePath,
      promptPath: join(jobRootDir, "prompt.md"),
      taskId: input.jobId,
      accounts: ["account-a"],
      ...(input.accessBoundary ? { accessBoundary: input.accessBoundary } : {}),
      ...(input.projectAccessScope
        ? { projectAccessScope: input.projectAccessScope }
        : {}),
      ...(input.projectPreStartAdmission
        ? { projectPreStartAdmission: input.projectPreStartAdmission }
        : {}),
      networkAccess: NetworkAccessMode.Restricted,
    },
  });
}

async function writeMislabeledNoOutput(input: {
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
