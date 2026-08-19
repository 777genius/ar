import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary,
  ProjectAdmissionWorkerRole,
  ProjectControlBroker,
  ProjectDebtReason,
  ProjectOperation,
  type ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";
import {
  codexProjectAdmissionGate,
  type CodexProjectAdmissionDeps,
} from "../application/project-control/codex-goal-project-admission";
import {
  assertPendingInputPatchTerminalFree,
  readCurrentExpectedPendingInputPatchReceipt,
  readValidatedInputPatchWorkerLaunchSpec,
} from "../application/project-control/codex-goal-project-pending-input-patch-admission";
import { prepareProjectPreStartAdmission } from
  "../application/project-control/codex-goal-project-pre-start-admission";
import { withProjectPreStartAdmissionLaunchAuthorization } from
  "../application/project-control/codex-goal-project-pre-start-launch-authorization";
import {
  codexGoalJobManifestPath,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import {
  projectControlStartStoredJobView,
  type CodexGoalMcpProjectControlActionsDeps,
} from "../codex-goal-mcp-project-control-actions";
import {
  cleanupProjectPreStartAdmissionFixtures,
  createBuiltinFixture,
  declarativeContract,
  sha256,
} from "./codex-goal-project-pre-start-admission-fixture";

const execFileAsync = promisify(execFile);

afterEach(cleanupProjectPreStartAdmissionFixtures);

describe("pending admitted input-patch admission", () => {
  it("reserves verified changed paths and fails closed for unreadable or stale receipts", async () => {
    const fixture = await pendingInputPatchFixture();
    const gate = () => codexProjectAdmissionGate({
      registryRootDir: fixture.registryRootDir,
      controllerJobId: "project-controller",
      scope: fixture.scope,
      deps: fixture.deps,
    });
    const request = (ownedPaths: readonly string[]) => ({
      operation: ProjectOperation.StartWorker,
      jobId: "project-next",
      workerRole: ProjectAdmissionWorkerRole.Producer,
      workspacePath: join(fixture.root, "next"),
      ownedPaths,
    });

    await expect(gate().evaluate(request(["src/other.ts"]))).resolves.toMatchObject({
      allowed: true,
      debt: [],
    });
    await expect(gate().evaluate(request(["src/example.ts"]))).resolves.toMatchObject({
      allowed: false,
      debt: [expect.objectContaining({
        reason: ProjectDebtReason.ActiveWriterConflict,
        subject: fixture.manifest.jobId,
        affectedPaths: ["src/example.ts"],
        pathDisjointProducerEligible: true,
      })],
    });
    await expect(readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    })).resolves.toMatchObject({
      ownedPaths: ["src/"],
      affectedPaths: ["src/example.ts"],
      attestationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const receiptPath = fixture.manifest.projectPreStartAdmission!.receiptPath;
    const receiptBody = await readFile(receiptPath, "utf8");
    await writeFile(receiptPath, "not-json\n");
    await expect(gate().evaluate(request(["src/other.ts"]))).resolves.toMatchObject({
      allowed: false,
      reason: "output_debt_present",
    });

    const staleReceipt = {
      ...JSON.parse(receiptBody),
      status: "launch_authorized",
    };
    await writeFile(receiptPath, `${JSON.stringify(staleReceipt)}\n`);
    await expect(gate().evaluate(request(["src/other.ts"]))).resolves.toMatchObject({
      allowed: false,
      reason: "output_debt_present",
    });
  });

  it("rejects a staged path outside declared ownership", async () => {
    const fixture = await pendingInputPatchFixture({
      ownedPaths: ["docs/"],
    });
    await expect(readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    })).rejects.toThrow(
      "project_control_pre_start_pending_patch_ownership_mismatch",
    );
    await expect(codexProjectAdmissionGate({
      registryRootDir: fixture.registryRootDir,
      controllerJobId: "project-controller",
      scope: fixture.scope,
      deps: fixture.deps,
    }).evaluate({
      operation: ProjectOperation.StartWorker,
      jobId: "project-next",
      workerRole: ProjectAdmissionWorkerRole.Producer,
      workspacePath: join(fixture.root, "next"),
      ownedPaths: ["unrelated.ts"],
    })).resolves.toMatchObject({
      allowed: false,
      reason: "output_debt_present",
    });
  });

  it("requires terminal-free overview evidence", async () => {
    const fixture = await pendingInputPatchFixture();
    const terminalCases = [
      { resultExists: true },
      { resultStatus: "failed" },
      { recommendedAction: "review_completed" },
      { lifecycleMarkerTypes: ["review"] },
    ];
    for (const terminal of terminalCases) {
      const deps: CodexProjectAdmissionDeps = {
        ...fixture.deps,
        buildOverviewItems: async () => [{
          ...fixture.targetOverview,
          ...terminal,
        }],
      };
      await expect(codexProjectAdmissionGate({
        registryRootDir: fixture.registryRootDir,
        controllerJobId: "project-controller",
        scope: fixture.scope,
        deps,
      }).evaluate({
        operation: ProjectOperation.StartWorker,
        jobId: "project-next",
        workerRole: ProjectAdmissionWorkerRole.Producer,
        workspacePath: join(fixture.root, "next"),
        ownedPaths: ["src/other.ts"],
      })).resolves.toMatchObject({
        allowed: false,
        reason: "output_debt_present",
      });
    }
  });

  it("binds the inspected attestation through final authorization", async () => {
    const fixture = await pendingInputPatchFixture();
    const expected = await readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    });
    const descriptor = fixture.manifest.projectPreStartAdmission!;
    const contract = JSON.parse(await readFile(descriptor.contractPath, "utf8"));
    const swappedContract = `${JSON.stringify(contract, null, 4)}\n`;
    const receipt = JSON.parse(await readFile(descriptor.receiptPath, "utf8"));
    let providerCalls = 0;

    await expect(withProjectPreStartAdmissionLaunchAuthorization({
      manifest: fixture.manifest,
      scope: fixture.scope,
      workspaceMode: "admitted_input_patch",
      expectedPendingInputPatch: expected,
      assertLaunchEligible: async () => {
        await writeFile(descriptor.contractPath, swappedContract);
        await writeFile(descriptor.receiptPath, `${JSON.stringify({
          ...receipt,
          contractSha256: sha256(Buffer.from(swappedContract)),
        }, null, 2)}\n`);
      },
    }, async () => {
      providerCalls += 1;
    })).rejects.toThrow("project_control_pre_start_pending_attestation_mismatch");
    expect(providerCalls).toBe(0);
  });

  it("rechecks terminal state immediately before launch authorization", async () => {
    const fixture = await pendingInputPatchFixture();
    const expected = await readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    });
    let providerCalls = 0;

    await expect(withProjectPreStartAdmissionLaunchAuthorization({
      manifest: fixture.manifest,
      scope: fixture.scope,
      workspaceMode: "admitted_input_patch",
      expectedPendingInputPatch: expected,
      assertLaunchEligible: async () =>
        assertPendingInputPatchTerminalFree({
          resultExists: true,
          resultStatus: "failed",
          recommendedAction: "review_completed",
        }),
    }, async () => {
      providerCalls += 1;
    })).rejects.toThrow("project_control_pending_input_patch_terminal_state");
    expect(providerCalls).toBe(0);
    await expect(readFile(
      fixture.manifest.projectPreStartAdmission!.receiptPath,
      "utf8",
    )).resolves.toContain('"status": "validated_not_launched"');
  });

  it("checks descriptor confinement before bounded artifact reads", async () => {
    const fixture = await pendingInputPatchFixture();
    const descriptor = fixture.manifest.projectPreStartAdmission!;
    const outsideReceipt = join(fixture.root, "outside-receipt.json");
    await writeFile(outsideReceipt, "x".repeat(65 * 1024));
    const escapedManifest: CodexGoalJobManifest = {
      ...fixture.manifest,
      projectPreStartAdmission: {
        ...descriptor,
        receiptPath: outsideReceipt,
      },
    };
    await expect(readValidatedInputPatchWorkerLaunchSpec({
      manifest: escapedManifest,
      scope: fixture.scope,
    })).rejects.toThrow("project_control_pre_start_receiptPath_invalid");

    await writeFile(descriptor.receiptPath, "x".repeat(65 * 1024));
    await expect(readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    })).rejects.toThrow("project_control_pre_start_receipt_invalid");
  });

  it("rejects symlinked expected artifact leaves without following them", async () => {
    const fixture = await pendingInputPatchFixture();
    const expected = await readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    });
    const receiptPath = fixture.manifest.projectPreStartAdmission!.receiptPath;
    const outsideReceipt = join(fixture.root, "outside-valid-receipt.json");
    await writeFile(outsideReceipt, await readFile(receiptPath));
    await unlink(receiptPath);
    await symlink(outsideReceipt, receiptPath);

    await expect(readCurrentExpectedPendingInputPatchReceipt({
      manifest: fixture.manifest,
      expected,
    })).rejects.toThrow("artifact_leaf_not_regular");
  });

  it("rejects an oversized expected artifact before an unbounded read", async () => {
    const fixture = await pendingInputPatchFixture();
    const expected = await readValidatedInputPatchWorkerLaunchSpec({
      manifest: fixture.manifest,
      scope: fixture.scope,
    });
    await writeFile(
      fixture.manifest.projectPreStartAdmission!.receiptPath,
      Buffer.alloc((64 * 1024) + 1, 0x20),
    );

    await expect(readCurrentExpectedPendingInputPatchReceipt({
      manifest: fixture.manifest,
      expected,
    })).rejects.toThrow("size_limit_exceeded");
  });

  it("carries the exact attestation and owned paths through later start", async () => {
    const fixture = await pendingInputPatchFixture();
    const manifestPath = codexGoalJobManifestPath({
      registryRootDir: fixture.registryRootDir,
      jobId: fixture.manifest.jobId,
    });
    await mkdir(join(fixture.registryRootDir, fixture.manifest.jobId), {
      recursive: true,
    });
    await writeFile(manifestPath, `${JSON.stringify(fixture.manifest)}\n`);
    const controller: CodexGoalJobManifest = {
      schemaVersion: 1,
      jobId: "project-controller",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      jobRootDir: join(fixture.root, "controller"),
      workspacePath: fixture.workspacePath,
      promptPath: join(fixture.root, "controller", "prompt.md"),
      taskId: "project-controller",
      accounts: ["account-a"],
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: fixture.scope,
    };
    await mkdir(controller.jobRootDir, { recursive: true });
    let brokerInput:
      | Parameters<CodexGoalMcpProjectControlActionsDeps["codexProjectControlBroker"]>[0]
      | undefined;
    let startRequest: Readonly<Record<string, unknown>> | undefined;
    const deps: CodexGoalMcpProjectControlActionsDeps = {
      loadProjectControlController: async () => ({
        registryRootDir: fixture.registryRootDir,
        controller,
        scope: fixture.scope,
      }),
      loadJobLaunch: async () => {
        throw new Error("unexpected_load_job_launch");
      },
      dependencyBootstrap: async () => ({
        mode: "off",
        workspacePath: fixture.workspacePath,
        nodeModulesPath: join(fixture.workspacePath, "node_modules"),
        nodeModulesExists: false,
        binaryChecks: [],
        fingerprintInputs: [],
        status: "off",
        warnings: [],
      }),
      codexProjectControlBroker: (input) => {
        brokerInput = input;
        return {
          startWorker: async (request: Readonly<Record<string, unknown>>) => {
            startRequest = request;
            return { status: "started" };
          },
        } as unknown as ProjectControlBroker;
      },
    };

    await expect(projectControlStartStoredJobView({
      registryRootDir: fixture.registryRootDir,
      controllerJobId: controller.jobId,
      jobId: fixture.manifest.jobId,
      confirmStart: true,
      forceStart: true,
      skipDoctor: true,
    }, deps)).resolves.toMatchObject({ ok: true });
    expect(brokerInput?.startPendingInputPatchAdmission).toMatchObject({
      ownedPaths: ["src/"],
      affectedPaths: ["src/example.ts"],
      attestationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(startRequest?.ownedPaths).toEqual(["src/"]);
  });

  it("keeps unrelated debt blocking before the provider port", async () => {
    const fixture = await pendingInputPatchFixture();
    const unrelatedWorkspace = join(fixture.root, "unrelated");
    await mkdir(unrelatedWorkspace);
    const unrelatedSummary = summary(
      "project-unrelated",
      unrelatedWorkspace,
      fixture.root,
    );
    const deps: CodexProjectAdmissionDeps = {
      ...fixture.deps,
      listJobs: async () => [
        ...(await fixture.deps.listJobs()),
        unrelatedSummary,
      ],
      buildOverviewItems: async () => [
        ...(await fixture.deps.buildOverviewItems()),
        {
          ok: true,
          jobId: unrelatedSummary.jobId,
          workspacePath: unrelatedWorkspace,
          workspaceDirty: true,
          workerAlive: false,
          activeWriterRisk: "dirty_workspace_without_worker",
          activeWriterRiskReasons: ["dirty_workspace_without_worker"],
          resultStatus: "completed",
          recommendedAction: "review_completed",
          lifecycleMarkerTypes: ["review"],
        },
      ],
    };
    const admission = codexProjectAdmissionGate({
      registryRootDir: fixture.registryRootDir,
      controllerJobId: "project-controller",
      scope: fixture.scope,
      deps,
      admittedInputPatchTarget: {
        jobId: fixture.manifest.jobId,
        workspacePath: fixture.manifest.workspacePath,
      },
    });
    let providerCalls = 0;
    const broker = testBroker(fixture.scope, admission, () => {
      providerCalls += 1;
    });

    await expect(broker.startWorker({
      jobId: fixture.manifest.jobId,
      registryRoot: fixture.registryRootDir,
      workspacePath: fixture.manifest.workspacePath,
      tmuxSession: fixture.manifest.jobId,
      accounts: ["account-a"],
      workerRole: ProjectAdmissionWorkerRole.Producer,
      ownedPaths: ["src/"],
    })).rejects.toThrow("project_control_admission_denied:output_debt_present");
    expect(providerCalls).toBe(0);
  });
});

async function pendingInputPatchFixture(
  options: { readonly ownedPaths?: readonly string[] } = {},
) {
  const fixture = await createBuiltinFixture();
  await mkdir(join(fixture.workspacePath, "src"), { recursive: true });
  await writeFile(
    join(fixture.workspacePath, "src", "example.ts"),
    "export const pending = true;\n",
  );
  await execFileAsync("git", ["add", "src/example.ts"], {
    cwd: fixture.workspacePath,
  });
  const stagedPatch = (await execFileAsync(
    "git",
    ["diff", "--cached", "--binary", "HEAD", "--"],
    { cwd: fixture.workspacePath },
  )).stdout;
  const artifactSha256 = sha256(Buffer.from("reviewed immutable input"));
  const plan = fixture.plan({
    contract: {
      ...declarativeContract(fixture.contract),
      inputPatchHash: artifactSha256,
      reviewKind: "remediation",
      ownedPaths: options.ownedPaths ?? ["src/"],
    },
    state: undefined,
  });
  const manifest: CodexGoalJobManifest = {
    ...fixture.storedManifest,
    authRootDir: join(fixture.root, "auth"),
    tmuxSession: fixture.storedManifest.jobId,
    tags: ["project-control-refill", "worker-role-producer"],
    projectPreStartAdmission: plan.descriptor,
  };
  await mkdir(manifest.authRootDir!, { recursive: true });
  const scope: ProjectAccessScope = {
    ...fixture.scope,
    worktreeRoots: [fixture.workspacePath],
    jobIdPrefixes: ["project-"],
    tmuxSessionPrefixes: ["project-"],
    allowedAccountIds: ["account-a"],
  };
  await prepareProjectPreStartAdmission({
    plan,
    manifest,
    scope,
    verifiedInputPatchArtifactSha256: artifactSha256,
    verifiedInputPatchStagedSha256: sha256(Buffer.from(stagedPatch)),
  });
  const targetSummary = summary(manifest.jobId, manifest.workspacePath, fixture.root);
  const targetOverview = {
    ok: true,
    jobId: manifest.jobId,
    workspacePath: manifest.workspacePath,
    workspaceDirty: true,
    workerAlive: false,
    activeWriterRisk: "dirty_workspace_without_worker",
    activeWriterRiskReasons: ["dirty_workspace_without_worker"],
    resultExists: false,
    recommendedAction: "inspect_dirty_workspace",
    lifecycleMarkerTypes: [],
  };
  return {
    ...fixture,
    manifest,
    scope,
    registryRootDir: join(fixture.root, "registry"),
    targetOverview,
    deps: {
      listJobs: async () => [targetSummary],
      buildOverviewItems: async () => [targetOverview],
      readJob: async () => manifest,
    } satisfies CodexProjectAdmissionDeps,
  };
}

function summary(jobId: string, workspacePath: string, root: string) {
  return {
    jobId,
    tags: ["worker-role-producer"],
    taskId: jobId,
    workspacePath,
    promptPath: join(root, `${jobId}.md`),
    accountNames: ["account-a"],
    updatedAt: "2026-08-19T00:00:00.000Z",
    manifestPath: join(root, `${jobId}.json`),
  };
}

function testBroker(
  scope: ProjectAccessScope,
  admission: ReturnType<typeof codexProjectAdmissionGate>,
  providerCall: () => void,
): ProjectControlBroker {
  const applied = async () => ({ status: "applied" as const });
  return new ProjectControlBroker({
    boundary: AccessBoundary.ProjectScopedControl,
    scope,
  }, {
    admission,
    registry: { createJob: applied, writeReviewMarker: applied },
    supervisor: {
      startWorker: async () => {
        providerCall();
        return await applied();
      },
      stopWorker: applied,
    },
    workspace: { createWorktree: applied },
    git: { integrateCommit: applied, pushBranch: applied },
  });
}
