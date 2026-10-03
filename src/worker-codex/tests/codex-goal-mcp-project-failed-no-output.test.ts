import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
import { inspectCodexGoalTmuxSession } from "../codex-goal-doctor";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import {
  codexGoalOutputPath,
  codexGoalProgressPath,
  codexGoalRuntimeEventsPath,
} from "../codex-goal-runner";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  codexProjectControlBroker,
  codexProjectAdmissionDeps,
  loadJobLaunch,
  loadProjectControlController,
} from "../codex-goal-mcp-project-control-deps";
import { buildCodexProjectAdmissionSnapshot } from "../application/project-control/codex-goal-project-admission";
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
import { callToolJson, git, gitInitRepository, gitStdout } from "./codex-goal-mcp-test-support";

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
        const prepare = async (
          name: string,
          descriptor?: CodexGoalProjectPreStartAdmission,
          options: { readonly managedOutput?: boolean; readonly tmuxSession?: string; readonly unborn?: boolean; readonly oddPath?: boolean; readonly diffDriver?: boolean } = {},
        ) => {
          const jobId = `project-${name}`;
          const workspacePath = join(worktreeRoot, jobId);
          if (options.unborn) {
            await mkdir(workspacePath, { recursive: true });
            await gitInitRepository(workspacePath);
          } else {
            await createCleanWorkspace(workspacePath);
          }
          if (options.diffDriver) {
            await writeFile(join(workspacePath, "runtime-authored.dat"), Buffer.from([0, 1, 2]));
            await git(workspacePath, ["add", "runtime-authored.dat"]);
            await git(workspacePath, ["commit", "-m", "test: initialize TEST driver baseline"]);
          }
          await writeFile(join(workspacePath, "README.md"), "imported input\n");
          await writeFile(join(workspacePath, "binary.dat"), Buffer.from([0, 255, 1, 2]));
          if (options.oddPath) {
            await writeFile(join(workspacePath, "space and\nnewline.txt"), "imported odd path\n");
            await symlink("README.md", join(workspacePath, "linked input"));
          }
          const jobRootDir = join(root, "worker-jobs", jobId);
          await createStoredJob({
            registryRootDir, root, authRoot: join(root, "auth"), jobId,
            workspacePath, ...(descriptor ? { projectPreStartAdmission: descriptor } : {}),
            ...(options.managedOutput
              ? { outputPath: join(jobRootDir, "output", `${jobId}.latest-result.json`) }
              : {}),
            ...(options.tmuxSession ? { tmuxSession: options.tmuxSession } : {}),
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

        const hiddenDiffJobIds: string[] = [];
        for (const driverKind of ["command", "textconv"] as const) {
          for (const authored of [false, true]) {
            const fixture = await prepare("diff-" + driverKind + (authored ? "-authored" : "-unchanged"), undefined, { diffDriver: true });
            const driverPath = join(root, "hide-" + driverKind);
            await writeFile(driverPath, driverKind === "command"
              ? "#!/bin/sh\nexit 0\n"
              : "#!/bin/sh\nprintf 'hidden\\n'\n", { mode: 0o700 });
            await writeFile(join(fixture.workspacePath, ".git", "info", "attributes"),
              "runtime-authored.dat diff=hide\n");
            await git(fixture.workspacePath, ["config", "diff.hide." + driverKind, driverPath]);
            if (authored) {
              hiddenDiffJobIds.push(fixture.jobId);
              await writeFile(join(fixture.workspacePath, "runtime-authored.dat"), Buffer.from([0, 255, 3, 4]));
              expect(await gitStdout(fixture.workspacePath, ["status", "--porcelain=v1"]))
                .toContain(" M runtime-authored.dat");
              await expect(projectControlRecordFailedNoOutputView(fixture.args, deps))
                .rejects.toThrow("failed_no_output_preexisting_patch_workspace_sha256_mismatch");
            } else {
              const unchanged = await projectControlRecordFailedNoOutputView(fixture.args, deps);
              expect(unchanged).toMatchObject({ ok: true, decision: { status: "failed_no_output" } });
              const unchangedDecision = unchanged.decision as {
                readonly preexistingWorkspacePatch: { readonly path: string };
              };
              await expect(readFile(unchangedDecision.preexistingWorkspacePatch.path, "utf8"))
                .resolves.toBe(fixture.patch);
              const unchangedLedger = await readCodexGoalConsumedOutputLedgers({
                roots: [ledgerRoot], evidenceRoots: [evidenceRoot],
              });
              expect(unchangedLedger.byJobId.get(fixture.jobId))
                .toMatchObject({ valid: true, status: "failed_no_output" });
            }
          }
        }

        const normalized = await prepare("clean-filter", undefined, { diffDriver: true });
        await writeFile(join(normalized.workspacePath, ".git", "info", "attributes"),
          "runtime-authored.dat filter=hide\n");
        await git(normalized.workspacePath, ["config", "filter.hide.clean", "printf '\\000\\001\\002'"]);
        await writeFile(join(normalized.workspacePath, "runtime-authored.dat"), Buffer.from([0, 255, 3, 4]));
        // Real Git normalizes the authored bytes back to the committed blob.
        expect(await captureGitWorkspacePatch({ workspacePath: normalized.workspacePath }))
          .toBe(normalized.patch);
        const controller = await loadProjectControlController(normalized.args);
        const aggregate = () => buildCodexProjectAdmissionSnapshot({
          registryRootDir, controllerJobId,
          scope: { ...controller.scope, jobIdPrefixes: [normalized.jobId] },
          deps: codexProjectAdmissionDeps,
        });
        const beforeNormalizationClosure = await aggregate();
        expect(beforeNormalizationClosure.counts?.inactiveDirtyWorkspaces).toBe(1);
        const closureError: unknown = await projectControlRecordFailedNoOutputView(normalized.args, deps)
          .then(() => undefined, (error: unknown) => error);
        expect((await aggregate()).counts?.inactiveDirtyWorkspaces)
          .toBe(beforeNormalizationClosure.counts?.inactiveDirtyWorkspaces);
        expect(closureError).toBeInstanceOf(Error);
        expect((closureError as Error).message).toBe("failed_no_output_git_conversion_unsupported");
        await expect(readFile(join(normalized.workspacePath, "runtime-authored.dat")))
          .resolves.toEqual(Buffer.from([0, 255, 3, 4]));
        hiddenDiffJobIds.push(normalized.jobId);
        // A driver can itself be named after check-attr's unset sentinel.
        await writeFile(join(normalized.workspacePath, ".git", "info", "attributes"),
          "runtime-authored.dat filter=unset\n");
        await git(normalized.workspacePath, ["config", "filter.unset.clean", "printf '\\000\\001\\002'"]);
        expect(await captureGitWorkspacePatch({ workspacePath: normalized.workspacePath }))
          .toBe(normalized.patch);
        await expect(projectControlRecordFailedNoOutputView(normalized.args, deps))
          .rejects.toThrow("failed_no_output_git_conversion_unsupported");

        const eolNormalized = await prepare("eol-normalized");
        await git(eolNormalized.workspacePath, ["config", "core.autocrlf", "input"]);
        await writeFile(join(eolNormalized.workspacePath, "README.md"), "imported input\r\n");
        expect(await captureGitWorkspacePatch({ workspacePath: eolNormalized.workspacePath }))
          .toBe(eolNormalized.patch);
        await expect(projectControlRecordFailedNoOutputView(eolNormalized.args, deps))
          .rejects.toThrow("failed_no_output_git_conversion_unsupported");
        hiddenDiffJobIds.push(eolNormalized.jobId);

        // Eligibility must not run either arbitrary clean or process commands.
        const noExecution = await prepare("filter-not-executed", undefined, { diffDriver: true });
        const filterMarker = join(root, "unexpected-filter-execution");
        await writeFile(join(noExecution.workspacePath, ".git", "info", "attributes"),
          "runtime-authored.dat filter=hide\n");
        await git(noExecution.workspacePath, ["config", "filter.hide.clean", `touch '${filterMarker}'`]);
        await git(noExecution.workspacePath, ["config", "filter.hide.process", `touch '${filterMarker}'`]);
        await expect(projectControlRecordFailedNoOutputView(noExecution.args, deps))
          .rejects.toThrow("failed_no_output_git_conversion_unsupported");
        await expect(readFile(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });
        hiddenDiffJobIds.push(noExecution.jobId);

        const managedClean = await prepare("managed-clean", undefined, { managedOutput: true });
        await expect(projectControlRecordFailedNoOutputView(managedClean.args, deps))
          .resolves.toMatchObject({ ok: true, decision: { status: "failed_no_output" } });
        await expect(projectControlRecordFailedNoOutputView(managedClean.args, deps))
          .resolves.toMatchObject({ ok: true, alreadyTerminal: true, idempotentReplay: true });
        const managedEvent = await prepare("managed-event", undefined, { managedOutput: true });
        const managedEventsPath = join(root, "worker-jobs", managedEvent.jobId, "output", `${managedEvent.jobId}.events.jsonl`);
        await mkdir(dirname(managedEventsPath), { recursive: true });
        await writeFile(managedEventsPath, "");
        await expect(projectControlRecordFailedNoOutputView(managedEvent.args, deps))
          .rejects.toThrow("failed_no_output_worker_launch_artifacts_present");

        const stagedDeleted = await prepare("staged-deleted");
        const stagedDeletedPath = join(stagedDeleted.workspacePath, "authored-staged.txt");
        await writeFile(stagedDeletedPath, "authored bytes absent from the archive\n");
        await git(stagedDeleted.workspacePath, ["add", "authored-staged.txt"]);
        await rm(stagedDeletedPath);
        expect(await gitStdout(stagedDeleted.workspacePath, ["status", "--short"]))
          .toContain("AD authored-staged.txt");
        expect(await captureGitWorkspacePatch({ workspacePath: stagedDeleted.workspacePath }))
          .toBe(stagedDeleted.patch);
        await expect(projectControlRecordFailedNoOutputView(stagedDeleted.args, deps))
          .rejects.toThrow("failed_no_output_staged_changes_present");

        const stagedModified = await prepare("staged-modified");
        await writeFile(join(stagedModified.workspacePath, "README.md"), "staged modification\n");
        await git(stagedModified.workspacePath, ["add", "README.md"]);
        await expect(projectControlRecordFailedNoOutputView(stagedModified.args, deps))
          .rejects.toThrow("failed_no_output_staged_changes_present");

        const stagedGitlink = await prepare("staged-gitlink");
        const nestedPath = join(stagedGitlink.workspacePath, "nested-repository");
        await mkdir(nestedPath);
        await gitInitRepository(nestedPath);
        await writeFile(join(nestedPath, "nested.txt"), "nested commit\n");
        await git(nestedPath, ["add", "nested.txt"]);
        await git(nestedPath, ["commit", "-m", "test: nested commit"]);
        await git(stagedGitlink.workspacePath, ["add", "nested-repository"]);
        await git(stagedGitlink.workspacePath, ["config", "diff.ignoreSubmodules", "all"]);
        expect(await gitStdout(stagedGitlink.workspacePath, ["ls-files", "--stage", "nested-repository"]))
          .toContain("160000");
        expect(await captureGitWorkspacePatch({ workspacePath: stagedGitlink.workspacePath }))
          .toBe(stagedGitlink.patch);
        await expect(projectControlRecordFailedNoOutputView(stagedGitlink.args, deps))
          .rejects.toThrow("failed_no_output_staged_changes_present");

        for (const [name, flag] of [["assume-unchanged", "--assume-unchanged"],
          ["skip-worktree", "--skip-worktree"]] as const) {
          const hidden = await prepare(name);
          await git(hidden.workspacePath, ["update-index", flag, "README.md"]);
          const hiddenReceipt = await captureGitWorkspacePatch({ workspacePath: hidden.workspacePath });
          await writeFile(hidden.patchPath, hiddenReceipt);
          await writeFile(join(hidden.workspacePath, "README.md"), "hidden authored bytes\n");
          expect(await captureGitWorkspacePatch({ workspacePath: hidden.workspacePath }))
            .toBe(hiddenReceipt);
          await expect(projectControlRecordFailedNoOutputView({
            ...hidden.args,
            preexistingWorkspacePatchSha256: createHash("sha256").update(hiddenReceipt).digest("hex"),
          }, deps))
            .rejects.toThrow("failed_no_output_git_index_flags_present");
        }

        const normalOddPath = await prepare("normal-odd-path", undefined, { oddPath: true });
        await expect(projectControlRecordFailedNoOutputView(normalOddPath.args, deps))
          .resolves.toMatchObject({ ok: true, decision: { status: "failed_no_output" } });

        const corruptHead = await prepare("corrupt-head");
        await writeFile(join(corruptHead.workspacePath, ".git", "HEAD"), "broken\n");
        await expect(projectControlRecordFailedNoOutputView(corruptHead.args, deps))
          .rejects.toThrow();

        const unbornExact = await prepare("unborn-exact", undefined, { unborn: true });
        await expect(projectControlRecordFailedNoOutputView(unbornExact.args, deps))
          .resolves.toMatchObject({ ok: true, decision: { status: "failed_no_output" } });
        await expect(projectControlRecordFailedNoOutputView(unbornExact.args, deps))
          .resolves.toMatchObject({ ok: true, alreadyTerminal: true, idempotentReplay: true });
        const unbornStaged = await prepare("unborn-staged", undefined, { unborn: true });
        await writeFile(join(unbornStaged.workspacePath, "new-staged.txt"), "staged after input\n");
        await git(unbornStaged.workspacePath, ["add", "new-staged.txt"]);
        await expect(projectControlRecordFailedNoOutputView(unbornStaged.args, deps))
          .rejects.toThrow("failed_no_output_staged_changes_present");

        const previousTmuxPath = process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH;
        try {
          const fakeTmux = join(root, "fake-tmux");
          process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = fakeTmux;
          const tmuxCrash = await prepare("tmux-crash", undefined, { tmuxSession: "project-tmux-crash" });
          await writeFile(fakeTmux, "#!/bin/sh\nprintf 'server exited unexpectedly\\n' >&2\nexit 1\n", { mode: 0o700 });
          await expect(inspectCodexGoalTmuxSession("project-tmux-crash"))
            .resolves.toEqual({ alive: false, warning: "codex_goal_tmux_inspection_uncertain" });
          await expect(projectControlRecordFailedNoOutputView(tmuxCrash.args, deps))
            .rejects.toThrow("failed_no_output_worker_launch_artifacts_present");
          const tmuxAbsent = await prepare("tmux-absent", undefined, { tmuxSession: "project-tmux-absent" });
          await writeFile(fakeTmux, "#!/bin/sh\nprintf \"can't find session: project-tmux-absent\\n\" >&2\nexit 1\n", { mode: 0o700 });
          await expect(inspectCodexGoalTmuxSession("project-tmux-absent"))
            .resolves.toEqual({ alive: false });
          await expect(projectControlRecordFailedNoOutputView(tmuxAbsent.args, deps))
            .resolves.toMatchObject({ ok: true, decision: { status: "failed_no_output" } });
          await expect(projectControlRecordFailedNoOutputView(tmuxAbsent.args, deps))
            .resolves.toMatchObject({ ok: true, alreadyTerminal: true, idempotentReplay: true });
        } finally {
          if (previousTmuxPath === undefined) delete process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH;
          else process.env.SUBSCRIPTION_RUNTIME_TMUX_PATH = previousTmuxPath;
        }
        const rejectedLedger = await readCodexGoalConsumedOutputLedgers({
          roots: [ledgerRoot], evidenceRoots: [evidenceRoot],
        });
        for (const jobId of [
          ...hiddenDiffJobIds, managedEvent.jobId, stagedDeleted.jobId, stagedModified.jobId,
          stagedGitlink.jobId, "project-assume-unchanged", "project-skip-worktree",
          corruptHead.jobId, unbornStaged.jobId, "project-tmux-crash",
        ]) {
          expect(rejectedLedger.byJobId.has(jobId)).toBe(false);
        }

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
  it.each([
    ["--assume-unchanged", false], ["--skip-worktree", false],
    ["--assume-unchanged", true], ["--skip-worktree", true],
  ] as const)("holds clean-looking closure with %s (prior rejection: %s)", async (flag, rejected) => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-TEST-hidden-source-"));
    const registryRootDir = join(root, "worker-jobs", "registry");
    const ledgerRoot = join(root, "control", "ledger");
    const evidenceRoot = join(root, "control", "archives");
    const workspacePath = join(root, "worktrees", "project-worker");
    const controllerWorkspace = join(root, "repo");
    const deps = { loadProjectControlController, loadJobLaunch, codexProjectControlBroker };
    try {
      await createCleanWorkspace(workspacePath);
      await createCleanWorkspace(controllerWorkspace);
      await mkdir(join(root, "auth"));
      await createStoredJob({
        registryRootDir, root, authRoot: join(root, "auth"), jobId: "project-controller",
        workspacePath: controllerWorkspace, accessBoundary: AccessBoundary.ProjectScopedControl,
        projectAccessScope: {
          projectId: "project", readRoots: [root], workspaceRoots: [controllerWorkspace],
          worktreeRoots: [join(root, "worktrees")], registryRoot: registryRootDir,
          consumedOutputLedgerRoots: [ledgerRoot], consumedOutputEvidenceRoots: [evidenceRoot],
          jobIdPrefixes: ["project-"], tmuxSessionPrefixes: ["project-"], allowedAccountIds: ["account-a"],
        },
      });
      await createStoredJob({ registryRootDir, root, authRoot: join(root, "auth"),
        jobId: "project-worker", workspacePath });
      if (rejected) await writeMislabeledNoOutput({ root, ledgerRoot,
        jobId: "project-worker", archiveRoot: evidenceRoot });
      const ledgerPath = join(ledgerRoot, "items", "project-worker.json");
      const priorLedger = rejected ? await readFile(ledgerPath, "utf8") : undefined;
      const sourcePatch = join(evidenceRoot, "project-worker-rejected-test", "worker-output.patch");
      await mkdir(join(evidenceRoot, "items"), { recursive: true });
      const archivesBefore = await readdir(evidenceRoot, { recursive: true });
      await writeFile(join(workspacePath, "README.md"), "value=1\n");
      await git(workspacePath, ["add", "README.md"]);
      await git(workspacePath, ["commit", "-m", "test: initialize TEST raw source"]);
      await git(workspacePath, ["update-index", flag, "README.md"]);
      await writeFile(join(workspacePath, "README.md"), "value=999\n");
      expect(await gitStdout(workspacePath, ["status", "--porcelain"])).toBe("");
      expect(await captureGitWorkspacePatch({ workspacePath })).toBe("");
      const indexBefore = await readFile(join(workspacePath, ".git", "index"));
      const args = { registryRootDir, controllerJobId: "project-controller", jobId: "project-worker",
        terminalAttemptId: "terminal-hidden", failureCategory: "infrastructure",
        failureCode: "prestart_failure", confirmFailedNoOutput: true };
      const server = createCodexGoalMcpServer();
      const client = new Client({ name: "TEST-hidden-source", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await expect(callToolJson(client, "codex_goal_project_record_failed_no_output", args))
          .resolves.toMatchObject({ ok: false, error: "failed_no_output_git_index_flags_present" });
      } finally { await client.close(); await server.close(); }
      expect(await readFile(join(workspacePath, "README.md"), "utf8")).toBe("value=999\n");
      expect(await readFile(join(workspacePath, ".git", "index"))).toEqual(indexBefore);
      expect(await readdir(evidenceRoot, { recursive: true }).catch(() => []))
        .toEqual(archivesBefore);
      if (rejected) {
        expect(await readFile(ledgerPath, "utf8")).toBe(priorLedger);
        expect(await readFile(sourcePatch, "utf8")).toBe("");
      } else await expect(readFile(ledgerPath)).rejects.toMatchObject({ code: "ENOENT" });
      // Clearing only the flag exposes authored output; closure must still reject.
      await git(workspacePath, ["update-index", flag === "--assume-unchanged"
        ? "--no-assume-unchanged" : "--no-skip-worktree", "README.md"]);
      await expect(projectControlRecordFailedNoOutputView(args, deps))
        .rejects.toThrow("failed_no_output_clean_workspace_required");
      await writeFile(join(workspacePath, "README.md"), "value=1\n");
      await expect(projectControlRecordFailedNoOutputView(args, deps))
        .resolves.toMatchObject({ ok: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
  readonly outputPath?: string;
  readonly tmuxSession?: string;
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
      ...(input.outputPath ? { outputPath: input.outputPath } : {}),
      ...(input.tmuxSession ? { tmuxSession: input.tmuxSession } : {}),
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
