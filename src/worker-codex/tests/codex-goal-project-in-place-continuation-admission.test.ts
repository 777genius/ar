import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AccessBoundary,
  ProjectControlBroker,
  type ProjectAccessScope,
  type ProjectAdmissionGate,
  type ProjectControlBrokerPorts,
} from "@vioxen/subscription-runtime/worker-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";
import { assertCodexGoalProjectJobNotTerminal } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import {
  assertProjectControlledRuntimeInPlaceContinuation,
  resolveProjectControlledRuntimeInPlaceContinuation,
} from "../application/project-control/codex-goal-project-in-place-continuation";
import {
  planProjectPreStartAdmission,
  prepareProjectPreStartAdmission,
} from "../application/project-control/codex-goal-project-pre-start-admission";
import { authorizeProjectPreStartAdmissionLaunch } from "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import { materializeCodexGoalHandoffArtifacts } from "../codex-goal-handoff-artifacts";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import {
  createCodexProjectControlBroker,
  type CodexProjectControlBrokerInput,
} from "../codex-goal-mcp-project-broker";
import { recordRejectedUncapturedOutput } from "../codex-goal-mcp-project-control-reviewed-rejection";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import {
  cleanupProjectPreStartAdmissionFixtures,
  createBuiltinFixture,
  withOwnershipBoundWorkKey,
} from "./codex-goal-project-pre-start-admission-fixture";
import { localProjectControlEvidenceCustodySupported } from
  "../../worker-local/project-control-evidence-custody-local-adapter";

afterEach(cleanupProjectPreStartAdmissionFixtures);

describe("controlled runtime in-place continuation admission", () => {
  it("fails closed when runtime continuation fencing context is absent", () => {
    expect(() => createCodexProjectControlBroker({
      startAdmissionWorkspaceMode:
        "admitted_input_patch_runtime_continuation",
    } as CodexProjectControlBrokerInput)).toThrow(
      "project_control_runtime_continuation_context_required",
    );
  });

  it("admits only exact owned paths through the real broker", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "subscription-runtime-in-place-continuation-"),
    );
    const registryRoot = join(root, "registry");
    const worktreeRoot = join(root, "worktrees");
    const workspacePath = join(worktreeRoot, "project-resume");
    const heldWorkspacePath = join(worktreeRoot, "project-held");
    try {
      await Promise.all([
        mkdir(registryRoot, { recursive: true }),
        mkdir(workspacePath, { recursive: true }),
        mkdir(heldWorkspacePath, { recursive: true }),
      ]);
      const scope: ProjectAccessScope = {
        projectId: "project",
        registryRoot,
        worktreeRoots: [worktreeRoot],
        jobIdPrefixes: ["project-"],
        tmuxSessionPrefixes: ["project-"],
        allowedAccountIds: ["account-a"],
      };
      const deps: CodexProjectAdmissionDeps = {
        listJobs: async () => [
          jobSummary({ root, registryRoot, workspacePath }),
          jobSummary({
            root,
            registryRoot,
            workspacePath: heldWorkspacePath,
            jobId: "project-held",
          }),
        ],
        buildOverviewItems: async () => [
          {
            ok: true,
            jobId: "project-resume",
            workspacePath,
            workspaceDirty: true,
            workerAlive: false,
            activeWriterRisk: "dirty_workspace_without_worker",
            activeWriterRiskReasons: ["dirty_workspace_without_worker"],
            resultStatus: "partial",
            recommendedAction: "inspect_dirty_failure",
            changedFiles: ["src/resume.ts"],
          },
          {
            ok: true,
            jobId: "project-held",
            workspacePath: heldWorkspacePath,
            workspaceDirty: true,
            workerAlive: false,
            activeWriterRisk: "dirty_workspace_without_worker",
            activeWriterRiskReasons: ["dirty_workspace_without_worker"],
            resultStatus: "completed",
            recommendedAction: "review_completed",
            lifecycleMarkerTypes: ["review"],
            changedFiles: ["docs/held.md"],
          },
        ],
      };
      const ownedPaths = ["src/resume.ts"];
      const gate = codexProjectAdmissionGate({
        registryRootDir: registryRoot,
        controllerJobId: "project-controller",
        scope,
        deps,
        inPlaceContinuationTarget: {
          jobId: "project-resume",
          workspacePath,
          ownedPaths,
        },
      });
      const starts: string[][] = [];
      const broker = new ProjectControlBroker(
        { boundary: AccessBoundary.ProjectScopedControl, scope },
        continuationBrokerPorts(gate, starts),
      );
      const start = (requestedOwnedPaths: readonly string[]) =>
        broker.startWorker({
          jobId: "project-resume",
          registryRoot,
          workspacePath,
          tmuxSession: "project-resume",
          accounts: ["account-a"],
          tags: ["worker-role-producer"],
          ownedPaths: requestedOwnedPaths,
        });

      await expect(start(ownedPaths)).resolves.toMatchObject({
        status: "applied",
      });
      expect(starts).toEqual([["src/resume.ts"]]);
      await expect(start(["src/"])).rejects.toMatchObject({
        decision: { allowed: false },
      });
      await expect(start(["docs/"])).rejects.toMatchObject({
        decision: { allowed: false },
      });
      expect(starts).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(localProjectControlEvidenceCustodySupported)(
    "binds the workspace fingerprint and exact rejected patch hash",
    async () => {
    const fixture = await createBuiltinFixture();
    await mkdir(join(fixture.root, "archives"), { recursive: true });
    const scope: ProjectAccessScope = {
      ...fixture.scope,
      consumedOutputLedgerRoots: [join(fixture.root, "ledger")],
      consumedOutputEvidenceRoots: [join(fixture.root, "archives")],
    };
    const contract = withOwnershipBoundWorkKey({
      ...fixture.contract,
      reviewKind: "implementation",
      inputPatchHash: null,
      ownedPaths: ["src/"],
    });
    const state = {
      ...fixture.state,
      records: fixture.state.records.map((record) => ({
        ...record,
        ...Object.fromEntries(
          ([
            "workKey",
            "baseSha",
            "phaseStartSha",
            "inputPatchHash",
            "reviewKind",
          ] as const).map((field) => [field, contract[field]]),
        ),
      })),
    };
    const plan = planProjectPreStartAdmission({
      value: { mode: "serial-builtin", contract, state },
      confirmed: true,
      scope,
      manifest: fixture.manifest,
    });
    if (!plan) throw new Error("expected admission plan");
    const manifest: CodexGoalJobManifest = {
      ...fixture.storedManifest,
      projectPreStartAdmission: plan.descriptor,
    };
    await prepareProjectPreStartAdmission({ plan, manifest, scope });
    await authorizeProjectPreStartAdmissionLaunch({ manifest, scope });

    await mkdir(join(manifest.workspacePath, "src"), { recursive: true });
    await writeFile(
      join(manifest.workspacePath, "src", "resume.ts"),
      "export const resumed = true;\n",
    );
    const handoff = await materializeCodexGoalHandoffArtifacts({
      workerJobId: manifest.jobId,
      taskId: manifest.taskId,
      workspacePath: manifest.workspacePath,
      jobRootDir: manifest.jobRootDir,
    });
    if (!handoff) throw new Error("expected interrupted handoff");
    await writeFile(
      join(manifest.jobRootDir, `${manifest.taskId}.latest-result.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: manifest.taskId,
        status: "partial",
        reason: "account_unavailable",
        updatedAt: "2026-08-12T00:00:00.000Z",
        changedFiles: handoff.changedPaths,
        evidence: ["safe_execution_status:partial"],
        blockers: ["account_unavailable"],
        nextAction: "switch_account",
        artifacts: handoff.artifacts,
      })}\n`,
    );
    const patch = await captureGitWorkspacePatch({
      workspacePath: manifest.workspacePath,
    });
    const rejectedPatchSha256 = createHash("sha256")
      .update(patch)
      .digest("hex");
    await recordRejectedUncapturedOutput({
      scope,
      jobId: manifest.jobId,
      jobRootDir: manifest.jobRootDir,
      workspacePath: manifest.workspacePath,
      closedAt: "2026-08-12T00:01:00.000Z",
      reason: "Rejected for exact continuation coverage.",
    });

    const binding = await resolveProjectControlledRuntimeInPlaceContinuation({
      manifest,
      scope,
      cause: { kind: "capacity", failureReason: "account_unavailable" },
      workspacePath: manifest.workspacePath,
    });
    expect(binding).toMatchObject({
      ownedPaths: contract.ownedPaths,
      workspaceFingerprintSha256: handoff.manifest.artifacts.patch.sha256,
      launchReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidence: {
        kind: "capacity",
        failureReason: "account_unavailable",
        resultSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      rejectedPatchSha256,
    });
    if (!binding.rejectedPatchSha256) {
      throw new Error("expected rejected continuation patch binding");
    }
    await expect(assertCodexGoalProjectJobNotTerminal({
      roots: scope.consumedOutputLedgerRoots ?? [],
      evidenceRoots: scope.consumedOutputEvidenceRoots ?? [],
      projectId: scope.projectId,
      controllerJobId: "project-controller",
      jobId: manifest.jobId,
      taskId: manifest.taskId,
      workspacePath: manifest.workspacePath,
      rejectedUncapturedContinuationPatchSha256:
        binding.rejectedPatchSha256,
    })).resolves.toBeUndefined();
    const receiptPath = manifest.projectPreStartAdmission!.receiptPath;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    await writeFile(receiptPath, `${JSON.stringify({
      ...receipt,
      launchAuthorizedAt: "2026-08-12T00:02:00.000Z",
    })}\n`);
    await expect(assertProjectControlledRuntimeInPlaceContinuation({
      manifest,
      scope,
      workspacePath: manifest.workspacePath,
      expected: binding,
    })).rejects.toThrow(
      "project_control_runtime_interruption_continuation_binding_mismatch",
    );
    },
  );
});

function jobSummary(input: {
  readonly root: string;
  readonly registryRoot: string;
  readonly workspacePath: string;
  readonly jobId?: string;
}) {
  const jobId = input.jobId ?? "project-resume";
  return {
    jobId,
    tags: ["worker-role-producer"],
    taskId: jobId,
    workspacePath: input.workspacePath,
    promptPath: join(input.root, `${jobId}.md`),
    accountNames: ["account-a"],
    updatedAt: "2026-08-12T00:00:00.000Z",
    manifestPath: join(input.registryRoot, `${jobId}.json`),
  };
}

function continuationBrokerPorts(
  admission: ProjectAdmissionGate,
  starts: string[][],
): ProjectControlBrokerPorts {
  const applied = (resourceId: string) => ({
    status: "applied" as const,
    resourceId,
  });
  return {
    admission,
    registry: {
      createJob: async (input) => applied(input.jobId),
      writeReviewMarker: async (input) => applied(input.jobId),
    },
    supervisor: {
      async startWorker(input) {
        starts.push([...(input.ownedPaths ?? [])]);
        return applied(input.jobId);
      },
      stopWorker: async (input) => applied(input.jobId),
    },
    workspace: {
      createWorktree: async (input) => applied(input.path),
    },
    git: {
      integrateCommit: async (input) =>
        applied(input.commitSha ?? input.branch),
      pushBranch: async (input) => applied(input.branch),
    },
  };
}
