import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  InMemoryAttemptJournal,
  type ProjectControlBroker,
} from "@vioxen/subscription-runtime/worker-core";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import {
  codexGoalJobManifestPath,
  readCodexGoalJob,
} from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  projectControlStartStoredJobView,
  type CodexGoalMcpProjectControlActionsDeps,
} from "../codex-goal-mcp-project-control-actions";
import { assertProjectPreStartAdmissionLaunchBinding } from "../application/project-control/codex-goal-project-pre-start-admission";
import { authorizeProjectPreStartAdmissionLaunch } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import {
  git,
  gitInitRepository,
  gitStdout,
} from "./codex-goal-mcp-test-support";
import {
  createControllerJob,
  createProducerJob,
  directoryEntries,
  prepareVerifier,
  projectScope,
  recordUnavailableAttempt,
  revision,
  stagedPatchSha256,
} from "./codex-goal-mcp-project-prepare-verifier-test-support";

describe("project verifier continuation", () => {
  it("continues the same prepared verifier with the admitted immutable patch", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "verifier-capacity-continuation-"),
    );
    const registryRootDir = join(root, "worker-jobs", "registry");
    const controllerJobRoot = join(root, "worker-jobs", "controller");
    const producerJobRoot = join(root, "worker-jobs", "producer");
    const sourceWorkspacePath = join(root, "workspaces", "canonical");
    const producerWorkspacePath = join(root, "worktrees", "producer");
    const verifierWorkspacePath = join(root, "worktrees", "verifier");
    const remotePath = join(root, "remote.git");
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await git(root, ["init", "--bare", remotePath]);
      await Promise.all([
        mkdir(sourceWorkspacePath, { recursive: true }),
        mkdir(join(root, "control", "consumed-output-ledger", "items"), {
          recursive: true,
        }),
      ]);
      await gitInitRepository(sourceWorkspacePath);
      await Promise.all([
        writeFile(join(sourceWorkspacePath, "README.md"), "base\n"),
        writeFile(join(sourceWorkspacePath, "controller.md"), "controller\n"),
        writeFile(join(sourceWorkspacePath, "lane.md"), "lane\n"),
        writeFile(join(sourceWorkspacePath, "feature.txt"), "base\n"),
        mkdir(join(sourceWorkspacePath, "checks")),
      ]);
      await writeFile(join(sourceWorkspacePath, "checks", ".keep"), "");
      await git(sourceWorkspacePath, ["add", "."]);
      await git(sourceWorkspacePath, ["commit", "-m", "test: base"]);
      const canonicalSha = await revision(sourceWorkspacePath);
      await git(sourceWorkspacePath, ["remote", "add", "origin", remotePath]);
      await git(sourceWorkspacePath, ["push", "-u", "origin", "HEAD:main"]);

      await git(root, ["clone", sourceWorkspacePath, producerWorkspacePath]);
      await git(producerWorkspacePath, [
        "config",
        "user.email",
        "test@example.com",
      ]);
      await git(producerWorkspacePath, ["config", "user.name", "Test User"]);
      await writeFile(join(producerWorkspacePath, "feature.txt"), "producer\n");
      await writeFile(join(producerWorkspacePath, "added.txt"), "added\n");
      const handoff = await materializeCodexGoalHandoffArtifacts({
        workerJobId: "project-producer",
        taskId: "project-producer",
        workspacePath: producerWorkspacePath,
        jobRootDir: producerJobRoot,
      });
      if (!handoff) throw new Error("expected producer handoff");
      await writeFile(
        join(producerJobRoot, "project-producer.latest-result.json"),
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

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await createProducerJob({
        client,
        root,
        registryRootDir,
        producerJobRoot,
        producerWorkspacePath,
      });
      const allowedAccountIds = ["account-c", "account-g"];
      await createControllerJob({
        client,
        root,
        registryRootDir,
        controllerJobRoot,
        sourceWorkspacePath,
        allowedAccountIds,
      });
      await prepareVerifier({
        client,
        root,
        registryRootDir,
        sourceWorkspacePath,
        verifierWorkspacePath,
        producerBase: canonicalSha,
        canonicalSha,
        patchSha256: handoff.manifest.artifacts.patch.sha256,
        executionMode: "sync",
        accounts: ["account-c"],
        ownedPaths: ["feature.txt", "added.txt"],
      });

      const verifierManifestPath = codexGoalJobManifestPath({
        registryRootDir,
        jobId: "project-verifier",
      });
      const initialVerifierManifest = await readCodexGoalJob({
        registryRootDir,
        jobId: "project-verifier",
      });
      const controller = await readCodexGoalJob({
        registryRootDir,
        jobId: "project-controller",
      });
      const scope = projectScope({
        root,
        registryRootDir,
        sourceWorkspacePath,
        allowedAccountIds,
      });
      await authorizeProjectPreStartAdmissionLaunch({
        manifest: initialVerifierManifest,
        scope,
        workspaceMode: "admitted_input_patch",
      });
      expect(await stagedPatchSha256(verifierWorkspacePath)).not.toBe(
        handoff.manifest.artifacts.patch.sha256,
      );
      const latestResultPath = join(
        initialVerifierManifest.jobRootDir,
        `${initialVerifierManifest.taskId}.latest-result.json`,
      );
      const accountUnavailableResult = `${JSON.stringify({
        status: "blocked",
        reason: "account_unavailable",
        changedFiles: [],
        evidence: ["safe_execution_status:waiting_capacity"],
        blockers: ["account_unavailable"],
        nextAction: "wait",
      })}\n`;
      await writeFile(latestResultPath, accountUnavailableResult);
      const journal = new InMemoryAttemptJournal();
      await recordUnavailableAttempt({
        journal,
        taskId: initialVerifierManifest.taskId,
        workspacePath: await realpath(initialVerifierManifest.workspacePath),
        accountId: "account-c",
      });

      const verifierManifest = initialVerifierManifest;
      const stagedPatchBefore = await stagedPatchSha256(verifierWorkspacePath);
      const manifestBefore = await readFile(verifierManifestPath, "utf8");
      const registryEntriesBefore = await directoryEntries(registryRootDir);
      const worktreesBefore = await gitStdout(sourceWorkspacePath, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      let brokerCalls = 0;
      let reservedLaunch: CodexGoalLaunchInput | undefined;
      let startManifest = verifierManifest;
      let startAdmissionWorkspaceMode: string | undefined;
      const deps: CodexGoalMcpProjectControlActionsDeps = {
        loadProjectControlController: async () => ({
          registryRootDir,
          controller,
          scope,
        }),
        loadJobLaunch: async () => {
          throw new Error("unexpected_load_job_launch");
        },
        safeExecutionJournal: journal,
        listAccountStatuses: async (input) => {
          expect(input).toEqual({ authRootDir: join(root, "auth") });
          return allowedAccountIds.map((accountId) => ({
            name: accountId,
            authJsonPath: join(root, "auth", accountId, "auth.json"),
            status: "ready" as const,
            availability: "available" as const,
            schedulerEligible: true,
            recommendedAction: "none" as const,
            warnings: [],
            safeMessage: "ready",
          }));
        },
        dependencyBootstrap: async () => ({
          mode: "install",
          workspacePath: verifierWorkspacePath,
          nodeModulesPath: join(verifierWorkspacePath, "node_modules"),
          nodeModulesExists: true,
          binaryChecks: [],
          fingerprintInputs: [],
          status: "installed",
          warnings: [],
        }),
        codexProjectControlBroker: (input) => {
          brokerCalls += 1;
          if (!input.startLaunch || !input.startManifest) {
            throw new Error("expected_start_binding");
          }
          reservedLaunch = input.startLaunch;
          startManifest = input.startManifest;
          startAdmissionWorkspaceMode = input.startAdmissionWorkspaceMode;
          return {
            startWorker: async () => {
              await authorizeProjectPreStartAdmissionLaunch({
                manifest: input.startManifest!,
                scope,
                ...(input.startAdmissionWorkspaceMode
                  ? { workspaceMode: input.startAdmissionWorkspaceMode }
                  : {}),
              });
              return { status: "started" };
            },
          } as unknown as ProjectControlBroker;
        },
      };
      const startArgs = {
        registryRootDir,
        controllerJobId: controller.jobId,
        jobId: verifierManifest.jobId,
        continuationAccounts: ["account-g"],
        confirmStart: true,
      };
      await writeFile(
        latestResultPath,
        `${JSON.stringify({
          status: "blocked",
          reason: "quota_limited",
          changedFiles: [],
          evidence: ["safe_execution_status:waiting_capacity"],
          blockers: ["quota_limited"],
          nextAction: "wait",
        })}\n`,
      );
      await expect(
        projectControlStartStoredJobView(startArgs, deps),
      ).rejects.toThrow(
        "project_control_continuation_attempt_history_required",
      );
      expect(brokerCalls).toBe(0);
      await writeFile(latestResultPath, accountUnavailableResult);
      const started = await projectControlStartStoredJobView(startArgs, deps);

      expect(started).toMatchObject({
        ok: true,
        accountReservation: { accountId: "account-g" },
      });
      expect(brokerCalls).toBe(1);
      expect(startAdmissionWorkspaceMode).toBe(
        "admitted_input_patch_continuation",
      );
      expect(startManifest.jobId).toBe(verifierManifest.jobId);
      expect(startManifest.taskId).toBe(verifierManifest.taskId);
      expect(startManifest.workspacePath).toBe(verifierManifest.workspacePath);
      expect(reservedLaunch?.config.taskId).toBe(verifierManifest.taskId);
      expect(reservedLaunch?.config.workspacePath).toBe(
        await realpath(verifierManifest.workspacePath),
      );
      expect(reservedLaunch?.config.accounts).toEqual([{
        name: "account-g",
        authJsonPath: join(root, "auth", "account-g", "auth.json"),
      }]);
      expect(await stagedPatchSha256(verifierWorkspacePath)).toBe(
        stagedPatchBefore,
      );
      expect(stagedPatchBefore).not.toBe(
        handoff.manifest.artifacts.patch.sha256,
      );
      expect(await readFile(verifierManifestPath, "utf8")).toBe(manifestBefore);
      expect(await directoryEntries(registryRootDir)).toEqual(
        registryEntriesBefore,
      );
      expect(await gitStdout(sourceWorkspacePath, [
        "worktree",
        "list",
        "--porcelain",
      ])).toBe(worktreesBefore);
      const receipt = JSON.parse(
        await readFile(
          verifierManifest.projectPreStartAdmission!.receiptPath,
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(receipt.launchAuthorizationCount).toBe(2);

      await writeFile(join(verifierWorkspacePath, "UNTRACKED.txt"), "drift\n");
      await expect(
        projectControlStartStoredJobView(startArgs, deps),
      ).rejects.toThrow("project_control_pre_start_launch_binding_mismatch");
      expect(brokerCalls).toBe(1);
      expect(await readFile(verifierManifestPath, "utf8")).toBe(manifestBefore);
      expect(await directoryEntries(registryRootDir)).toEqual(
        registryEntriesBefore,
      );
      expect(await gitStdout(sourceWorkspacePath, [
        "worktree",
        "list",
        "--porcelain",
      ])).toBe(worktreesBefore);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
