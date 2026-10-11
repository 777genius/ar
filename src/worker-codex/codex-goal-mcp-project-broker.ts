import { isProjectMimoWorkerLaunch, launchProjectMimoWorker, stopProjectMimoWorker } from "./project-mimo-worker-launch";
import { recordProtectedCodexGoalJobFirstEffect, type ProtectedCodexGoalJobBirthPreparation } from "./protected-job-birth";
import { fastForwardExistingProjectWorktree } from "./project-worktree-fast-forward";
export { fastForwardExistingProjectWorktree } from "./project-worktree-fast-forward";
import { admitHostedControllerLaunch } from "./hosted-readonly-controller-admission";
import { isHostedGoalLaunch, isHostedActivatedGoalLaunch, stopHostedGoalLaunch, routeHostedGoalLaunch } from "./hosted-readonly-goal-launch";
import { CodexGoalLaunchState, buildCodexGoalNoTmuxCommand } from "./codex-goal-ops";
import { appendFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AccessBoundary,
  ProjectControlBroker,
  ProjectOperation,
  ProjectControlSubmissionUncertainError,
  type ProjectAccessScope,
  type ProjectControlBrokerEvent,
  type ProjectControlBrokerPorts,
  type ProjectControlOperationResult,
} from "@vioxen/subscription-runtime/worker-core";
import {
  createCodexGoalJob,
  type CodexGoalJobManifest,
  type CodexGoalJobManifestInput,
} from "./codex-goal-jobs";
import {
  collectCodexGoalStatus,
  doctorCodexGoal,
  prepareCodexGoalLaunchPaths,
  resolveCodexGoalWorkerLiveness,
  startCodexGoalTmux,
  type CodexGoalLaunchInput,
} from "./codex-goal-ops";
import { writeCodexGoalReviewMarker } from "./codex-goal-mcp-lifecycle-markers";
import { buildCodexGoalBrief } from "./codex-goal-mcp-brief";
import { codexGoalStatusInputFromLaunch as statusInput } from "./codex-goal-mcp-status-input";
import type { CodexProjectAdmissionDeps } from "./application/project-control/codex-goal-project-admission";
import {
  createProjectBrokerAdmission,
  type ProjectCreationAdmissionProof,
} from "./application/project-control/codex-goal-project-broker-admission";
import {
  assertAdmissionStoredLaunchIdentity,
  boundCreationTargetIdentity,
  revalidateAdmissionCreatedWorktree,
  type ProjectAdmissionTargetBinding,
} from "./application/project-control/codex-goal-project-admission-target";
import {
  authorizeProjectPreStartAdmissionLaunch,
  readCurrentAuthorizedProjectPreStartLaunchReceipt,
  rollbackProjectPreStartAdmissionLaunch,
  type ProjectPreStartAdmissionLaunchAuthorization,
} from "./application/project-control/codex-goal-project-pre-start-launch-authorization";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./application/project-control/codex-goal-project-pre-start-admission";
import {
  assertPendingInputPatchTerminalFree,
  type ValidatedPendingInputPatchAdmission,
} from "./application/project-control/codex-goal-project-pending-input-patch-admission";
import { assertCodexGoalProjectJobNotTerminal } from "./application/project-control/codex-goal-consumed-output-ledger-io";
import {
  decideCodexGoalProjectStop,
  isCodexGoalProjectTerminalCapacityPause,
} from "./application/project-control/codex-goal-project-stop-policy";
import type {
  CaptureReviewedWorkerOutputInput,
  ReviewedWorkerOutputSnapshot,
} from "./reviewed-worker-output";
import {
  assertReviewedWorkerOutputStillMatchesLocked,
  captureReviewedWorkerOutputLocked,
  commitReviewedWorkerOutputReviewAttestation,
  localReviewedWorkerOutputDeps,
  reviewedWorkerOutputRoot,
} from "./reviewed-worker-output";
import { LocalProjectAuthorityTupleStore } from
  "../worker-local/project-authority-tuple-local-adapter";
import {
  withProjectAdmissionPublicationLock,
  type ProjectControlWorkspaceLease,
} from "./codex-goal-project-workspace-lock";
import {
  noopOperationResult,
  type CodexGoalProjectCreateWorktreeInput,
} from "./application/project-control/codex-goal-project-control-contracts";
import {
  durableHandoffStopEvidence,
  preserveTerminalCodexGoalHandoffBeforeStop,
} from "./codex-goal-preserve-before-stop";
import { projectControlRealPathOutsideWorkspaceScope } from "./application/project-control/codex-goal-project-workspace-scope";
import {
  applyVerifiedInputPatch,
  assertGitCurrentBranch,
  execGit,
  execGitStdout,
  fastForwardMaterializedWorktreeBranch,
  isGitAncestor,
} from "./codex-goal-mcp-project-git";
import { pushProjectBranch } from "./application/project-control/codex-goal-project-external-rewrite-recovery";
import {
  assertProjectControlledRuntimeInPlaceContinuation,
  type ProjectControlledRuntimeInPlaceContinuation,
} from "./application/project-control/codex-goal-project-in-place-continuation";

export type { CodexGoalProjectCreateWorktreeInput } from "./application/project-control/codex-goal-project-control-contracts";

export type CodexGoalProjectIntegrateCommitInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly commitSha: string;
};

export type CodexGoalProjectPushBranchInput = {
  readonly workspacePath: string;
  readonly realWorkspacePath?: string;
  readonly branch: string;
  readonly remote: string;
  readonly force: boolean;
  readonly expectedRemoteCommit?: string;
  readonly expectedLocalCommit?: string;
  readonly confirmExternalRewriteRecovery?: boolean;
};

export async function resolveBoundProjectWorktreeSource(input: {
  readonly sourceWorkspacePath: string;
  readonly expectedSourceRealPath: string;
  readonly scope: ProjectAccessScope;
}): Promise<string> {
  const sourceRealPath = await realpath(input.sourceWorkspacePath);
  if (sourceRealPath !== input.expectedSourceRealPath) {
    throw new Error("project_control_source_workspace_real_path_changed");
  }
  const outsideScope = await projectControlRealPathOutsideWorkspaceScope(
    sourceRealPath,
    input.scope,
  );
  if (outsideScope) {
    throw new Error("project_control_source_workspace_real_path_outside_scope");
  }
  return sourceRealPath;
}
export type CodexProjectControlBrokerInput = {
  readonly registryRootDir: string;
  readonly controller: CodexGoalJobManifest;
  readonly scope: ProjectAccessScope;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly createManifest?: CodexGoalJobManifestInput;
  readonly protectedBirthPreparation?: ProtectedCodexGoalJobBirthPreparation;
  readonly createReviewedOutputAggregate?: ProjectAdmissionTargetBinding["createReviewedOutputAggregate"];
  readonly createOverwrite?: boolean;
  readonly createWorktreeInput?: CodexGoalProjectCreateWorktreeInput;
  readonly admittedInputPatchTarget?: {
    readonly jobId: string;
    readonly workspacePath: string;
  };
  readonly integrateCommitInput?: CodexGoalProjectIntegrateCommitInput;
  readonly pushBranchInput?: CodexGoalProjectPushBranchInput;
  readonly startLaunch?: CodexGoalLaunchInput;
  readonly startManifest?: CodexGoalJobManifest;
  readonly startAdmissionWorkspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
  readonly startPendingInputPatchAdmission?: ValidatedPendingInputPatchAdmission;
  readonly startWorkspaceLease?: ProjectControlWorkspaceLease;
  readonly revalidateStartPublication?: (workspace: ProjectControlWorkspaceLease) => Promise<void>;
  readonly startSkipDoctor?: boolean;
  readonly controlledRuntimeInPlaceContinuation?: ProjectControlledRuntimeInPlaceContinuation;
  readonly stopLaunch?: CodexGoalLaunchInput;
  readonly forceStopAfterMaterializationFailure?: boolean;
  readonly reviewLaunch?: CodexGoalLaunchInput;
  readonly reviewWorkspaceLease?: ProjectControlWorkspaceLease;
  readonly reviewNote?: string;
  readonly reviewedOutputCapture?: Omit<
    CaptureReviewedWorkerOutputInput,
    "workerJobId" | "taskId" | "workspacePath"
  >;
  readonly reviewedContinuation?: ReviewedWorkerOutputSnapshot;
  readonly rejectedUncapturedTerminalHandoffRecovery?:
    { readonly patchSha256: string } | undefined;
};

/** Bind a trusted Host setting to the child command without persisting it in a manifest. */
export function bindProjectChildCheckpointPublisher(input: {
  readonly launch: CodexGoalLaunchInput;
  readonly controllerCheckpointRequired: boolean;
  readonly childCheckpointRequired: boolean;
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
}): CodexGoalLaunchInput {
  const socketPath = input.hostEnv.SUBSCRIPTION_RUNTIME_CHECKPOINT_PUBLISHER_SOCKET?.trim();
  if (socketPath && (!isAbsolute(socketPath) || socketPath.includes("\0"))) {
    throw new Error("checkpoint_socket_path_invalid");
  }
  const { checkpointPublisherSocketPath: _untrustedSocket, ...childConfig } = input.launch.config;
  const checkpointRequired = input.childCheckpointRequired || input.controllerCheckpointRequired ||
    childConfig.checkpointRequired === true || Boolean(socketPath);
  if (checkpointRequired && !socketPath) throw new Error("checkpoint_publisher_required");
  return { ...input.launch, config: {
    ...childConfig,
    ...(checkpointRequired ? { checkpointRequired: true } : {}),
    ...(socketPath ? { checkpointPublisherSocketPath: socketPath } : {}),
  } };
}

export function createCodexProjectControlBroker(
  input: CodexProjectControlBrokerInput,
): ProjectControlBroker {
  const runtimeContinuationMode =
    input.startAdmissionWorkspaceMode ===
    "admitted_input_patch_runtime_continuation";
  if (
    runtimeContinuationMode !==
      (input.controlledRuntimeInPlaceContinuation !== undefined) ||
    (runtimeContinuationMode &&
      (!input.startManifest || !input.startWorkspaceLease))
  ) {
    throw new Error("project_control_runtime_continuation_context_required");
  }
  const admittedInputPatchTarget =
    input.admittedInputPatchTarget ??
    ((input.startAdmissionWorkspaceMode === "admitted_input_patch" &&
      input.startManifest &&
      input.startWorkspaceLease) ||
    (input.createWorktreeInput?.inputPatch && input.createWorktreeInput.jobId)
      ? {
          jobId:
            input.startManifest?.jobId ??
            input.createWorktreeInput?.jobId ??
            "",
          workspacePath:
            input.startWorkspaceLease?.canonicalWorkspacePath ??
            input.createWorktreeInput?.path ??
            "",
        }
      : undefined);
  const authorityStore = new LocalProjectAuthorityTupleStore({
    rootDir: join(input.registryRootDir, ".project-authority"),
    projectId: input.scope.projectId,
  });
  const admission = createProjectBrokerAdmission(
    input, admittedInputPatchTarget, codexProjectControlPathExists,
  );
  return new ProjectControlBroker(
    {
      boundary: AccessBoundary.ProjectScopedControl,
      scope: input.scope,
    },
    {
      ...codexProjectControlPorts(input, authorityStore, admission.creationProof),
      admission: admission.gate,
    },
  );
}

function codexProjectControlPorts(
  input: CodexProjectControlBrokerInput,
  authorityStore: LocalProjectAuthorityTupleStore,
  creationProof: () => ProjectCreationAdmissionProof | undefined,
): ProjectControlBrokerPorts {
  let preparedAuthorization: ProjectPreStartAdmissionLaunchAuthorization | undefined;
  return {
    authority: authorityStore,
    admissionCoordination: {
      withPublication: async (request, effect) => {
        if (request.operation === ProjectOperation.StartWorker && input.startWorkspaceLease) {
          if (input.startManifest && input.startLaunch) {
            await assertAdmissionStoredLaunchIdentity({
              registryRootDir: input.registryRootDir, manifest: input.startManifest, launch: input.startLaunch,
            });
          }
          const publish = input.startWorkspaceLease.withOrderedAdmissionPublication;
          if (!publish || !input.revalidateStartPublication) {
            throw new Error("project_control_ordered_start_publication_required");
          }
          return await publish({
            registryRootDir: input.registryRootDir,
            revalidate: input.revalidateStartPublication,
            effect,
          });
        }
        return await withProjectAdmissionPublicationLock({
          registryRootDir: input.registryRootDir,
          owner: `project-admission-publication:${input.controller.jobId}`,
          effect,
        });
      },
    },

    audit: {
      async record(event) {
        await appendProjectControlAuditEvent(input.controller, event);
      },
    },
    registry: {
      async createJob() {
        if (!input.createManifest) {
          throw new Error("project_control_create_manifest_required");
        }
        const created = await createCodexGoalJob({
          registryRootDir: input.registryRootDir,
          manifest: input.createManifest,
          overwrite: input.createOverwrite ?? false,
          ...(input.protectedBirthPreparation ? { protectedBirthPreparation: input.protectedBirthPreparation } : {}),
        });
        return operationResult(created.jobId);
      },
      async writeReviewMarker(marker) {
        if (!input.reviewLaunch) {
          throw new Error("project_control_review_launch_required");
        }
        if (
          !input.reviewWorkspaceLease ||
          input.reviewWorkspaceLease.canonicalWorkspacePath !==
            input.reviewLaunch.config.workspacePath
        ) {
          throw new Error("project_control_review_workspace_lease_required");
        }
        const status = await collectCodexGoalStatus(
          statusInput(input.reviewLaunch),
        );
        let reviewedOutput: ReviewedWorkerOutputSnapshot | undefined;
        const reviewedOutputDeps = localReviewedWorkerOutputDeps({
          rootDir: reviewedWorkerOutputRoot(input.registryRootDir),
        });
        if (input.reviewedOutputCapture) {
          assertReviewedOutputWorkerStopped(input.reviewLaunch, status);
          await reviewedOutputDeps.continuationEnvironment.sanitizeDependencyRootLinks(
            {
              workspacePath: input.reviewLaunch.config.workspacePath,
            },
          );
          reviewedOutput = await captureReviewedWorkerOutputLocked(
            reviewedOutputDeps,
            {
              ...input.reviewedOutputCapture,
              workerJobId: marker.jobId,
              taskId: input.reviewLaunch.config.taskId,
              workspacePath: input.reviewLaunch.config.workspacePath,
            },
            input.reviewWorkspaceLease.lease,
          );
          const statusAfterCapture = await collectCodexGoalStatus(
            statusInput(input.reviewLaunch),
          );
          assertReviewedOutputWorkerStopped(
            input.reviewLaunch,
            statusAfterCapture,
          );
        }
        const reviewPath = await writeCodexGoalReviewMarker({
          jobId: marker.jobId,
          taskId: input.reviewLaunch.config.taskId,
          jobRootDir: input.reviewLaunch.config.jobRootDir,
          note: input.reviewNote ?? marker.note ?? "project_control_reviewed",
          status,
          ...(reviewedOutput ? { reviewedOutput } : {}),
        });
        if (reviewedOutput) {
          await assertReviewedWorkerOutputStillMatchesLocked(
            reviewedOutputDeps,
            reviewedOutput,
            input.reviewWorkspaceLease.lease,
          );
          const statusBeforeAttestation = await collectCodexGoalStatus(
            statusInput(input.reviewLaunch),
          );
          assertReviewedOutputWorkerStopped(
            input.reviewLaunch,
            statusBeforeAttestation,
          );
          await commitReviewedWorkerOutputReviewAttestation({
            store: reviewedOutputDeps.store,
            markerVerifier: reviewedOutputDeps.markerVerifier,
            snapshot: reviewedOutput,
            reviewMarkerPath: reviewPath,
          });
        }
        return operationResult(reviewedOutput?.reviewedOutputId ?? reviewPath);
      },
    },
    supervisor: {
      async prepareStartWorker() {
        if (!input.startManifest || !input.startLaunch) return;
        preparedAuthorization = await authorizeProjectPreStartAdmissionLaunch({
          manifest: input.startManifest,
          scope: input.scope,
          ...(input.startAdmissionWorkspaceMode
            ? { workspaceMode: input.startAdmissionWorkspaceMode }
            : {}),
          ...(input.startPendingInputPatchAdmission
            ? { expectedPendingInputPatch: input.startPendingInputPatchAdmission }
            : {}),
          assertLaunchEligible: async () => {
            await assertAdmissionStoredLaunchIdentity({
              registryRootDir: input.registryRootDir,
              manifest: input.startManifest!,
              launch: input.startLaunch!,
            });
            if (input.startPendingInputPatchAdmission) {
              assertPendingInputPatchTerminalFree(
                await collectCodexGoalStatus(statusInput(input.startLaunch!)),
              );
            }
          },
          authorityStore,
        });
        // Original claim publication owns topology. Permanently invalidate the
        // exact root before release, so later sibling censuses cannot contend
        // with this already authorized launch's negative-history rechecks.
        recordProtectedCodexGoalJobFirstEffect(input.startManifest.jobRootDir);
      },
      async startWorker() {
        if (!input.startLaunch) {
          throw new Error("project_control_start_launch_required");
        }
        if (input.startManifest) await assertAdmissionStoredLaunchIdentity({
          registryRootDir: input.registryRootDir, manifest: input.startManifest, launch: input.startLaunch,
        });
        // Child env is filtered, so carry the Host socket through argv.
        const startLaunch = bindProjectChildCheckpointPublisher({
          launch: input.startLaunch,
          controllerCheckpointRequired: input.controller.checkpointRequired === true,
          childCheckpointRequired: input.startManifest?.checkpointRequired === true,
          hostEnv: process.env,
        });
        if (!input.startWorkspaceLease) {
          throw new Error("project_control_start_workspace_lease_required");
        }
        if (
          input.startWorkspaceLease.canonicalWorkspacePath !==
          startLaunch.config.workspacePath
        ) {
          throw new Error("project_control_start_workspace_lease_mismatch");
        }
        let submissionMayHaveOccurred = false;
        const start = async () => {
          if (input.controlledRuntimeInPlaceContinuation) {
            if (!input.startManifest) {
              throw new Error(
                "project_control_runtime_interruption_manifest_required",
              );
            }
            await assertProjectControlledRuntimeInPlaceContinuation({
              manifest: input.startManifest,
              scope: input.scope,
              workspacePath: startLaunch.config.workspacePath,
              expected: input.controlledRuntimeInPlaceContinuation,
            });
          }
          await assertCodexGoalProjectJobNotTerminal({
            roots: input.scope.consumedOutputLedgerRoots ?? [],
            evidenceRoots: input.scope.consumedOutputEvidenceRoots ?? [],
            projectId: input.scope.projectId,
            controllerJobId: input.controller.jobId,
            jobId: input.startManifest?.jobId ?? startLaunch.config.taskId,
            taskId: startLaunch.config.taskId,
            workspacePath: startLaunch.config.workspacePath,
            ...(input.reviewedContinuation
              ? { reviewedContinuation: input.reviewedContinuation }
              : {}),
            ...(input.startAdmissionWorkspaceMode ===
              "admitted_input_patch_continuation" ||
            input.startAdmissionWorkspaceMode ===
              "admitted_input_patch_runtime_continuation" ||
            input.startAdmissionWorkspaceMode === "clean_capacity_continuation"
              ? { capacityContinuation: true as const }
              : {}),
            ...(input.rejectedUncapturedTerminalHandoffRecovery
              ? {
                  rejectedUncapturedContinuationPatchSha256:
                    input.rejectedUncapturedTerminalHandoffRecovery.patchSha256,
                }
              : input.controlledRuntimeInPlaceContinuation?.rejectedPatchSha256
                ? {
                    rejectedUncapturedContinuationPatchSha256:
                      input.controlledRuntimeInPlaceContinuation
                        .rejectedPatchSha256,
                  }
                : {}),
          });
          if (!input.startManifest && input.scope.preStartAdmission?.required) {
            throw new Error("project_control_start_manifest_required");
          }
          // Broker authorization publishes a receipt. Managed broker requests
          // must already be enclosed by the fixed CLI outer command before it.
          if (!isProjectMimoWorkerLaunch(startLaunch)) await admitHostedControllerLaunch(startLaunch);
          const previousBrokeredStart =
            process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
          process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START = "1";
          const launchWorker = async () => {
            submissionMayHaveOccurred = true;
            if (isProjectMimoWorkerLaunch(startLaunch)) {
              const launched = await launchProjectMimoWorker({ registryRootDir: input.registryRootDir,
                controllerJobId: input.controller.jobId, reservedLaunch: input.startLaunch! });
              return { args: [], preview: `MiMo worker ${launched.jobId} (${launched.startId})`,
                launchState: CodexGoalLaunchState.Scheduled };
            }
            const outerStatus = await routeHostedGoalLaunch(startLaunch);
            // Undefined is the router's explicit no-submission/local outcome.
            // An exception remains uncertain and keeps the allocated claim.
            if (outerStatus === undefined) submissionMayHaveOccurred = false;
            if (outerStatus !== undefined) {
              return { args: [], preview: buildCodexGoalNoTmuxCommand(startLaunch), launchState: outerStatus === 0 ? CodexGoalLaunchState.Completed : CodexGoalLaunchState.Failed };
            }
          await prepareCodexGoalLaunchPaths(startLaunch);
          if (!input.startSkipDoctor) {
            const doctor = await doctorCodexGoal({
              config: startLaunch.config,
              ...(startLaunch.tmuxSession
                ? { tmuxSession: startLaunch.tmuxSession }
                : {}),
            });
            if (!doctor.ok) {
              throw new Error(
                `project_control_doctor_failed:${JSON.stringify(doctor)}`,
              );
            }
          }
            submissionMayHaveOccurred = true;
            return await startCodexGoalTmux(startLaunch);
          };
          let command: Awaited<ReturnType<typeof startCodexGoalTmux>>;
          try {
            if (input.startManifest?.projectPreStartAdmission) {
              const current = await readCurrentAuthorizedProjectPreStartLaunchReceipt(
                input.startManifest,
              );
              if (!preparedAuthorization ||
                !isDeepStrictEqual(current.receipt, preparedAuthorization.authorizedReceipt)) {
                throw new Error("project_control_prepared_launch_authorization_changed");
              }
            }
            command = await launchWorker();
          } finally {
            if (previousBrokeredStart === undefined) {
              delete process.env
                .SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START;
            } else {
              process.env.SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START =
                previousBrokeredStart;
            }
          }
          if (command.launchState === CodexGoalLaunchState.Failed) throw new Error("hosted_custody_foreground_failed_after_submission");
          return operationResult(`${command.launchState ?? CodexGoalLaunchState.Scheduled}: ${command.preview}`);
        };
        try {
          return await start();
        } catch (error) {
          if (!submissionMayHaveOccurred && preparedAuthorization) {
            try {
              await rollbackProjectPreStartAdmissionLaunch(preparedAuthorization);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "project_control_pre_start_launch_rollback_failed",
              );
            }
          }
          if (submissionMayHaveOccurred) {
            throw new ProjectControlSubmissionUncertainError(error);
          }
          throw error;
        }
      },
      async stopWorker() {
        if (!input.stopLaunch) {
          throw new Error("project_control_stop_launch_required");
        }
        const status = await collectCodexGoalStatus(
          statusInput(input.stopLaunch),
        );
        const brief = await buildCodexGoalBrief({
          jobId: input.stopLaunch.config.taskId,
          launch: input.stopLaunch,
          status,
          accounts: [],
          staleAfterMs: 10 * 60_000,
          tailLines: 20,
        });
        const capacityContinuation = isCodexGoalProjectTerminalCapacityPause(
          input.startAdmissionWorkspaceMode,
        );
        const stopPolicy = decideCodexGoalProjectStop({
          ...brief.workerHealth,
          terminalCapacityPause: capacityContinuation,
        });
        if (!stopPolicy.allowed) {
          throw new Error(stopPolicy.reason);
        }
        if (isProjectMimoWorkerLaunch(input.stopLaunch)) {
          const evidence = await stopProjectMimoWorker({ registryRootDir: input.registryRootDir,
            controllerJobId: input.controller.jobId, launch: input.stopLaunch });
          return operationResult("MiMo worker stopped with reconciled workspace", evidence);
        }
        if (isHostedActivatedGoalLaunch(input.stopLaunch)) {
          stopHostedGoalLaunch(input.stopLaunch);
          return operationResult("hosted stop requested; terminal custody remains unproven");
        }
        const { tmuxSession: _tmuxSession, ...foregroundLaunch } = input.stopLaunch;
        const preserved = await preserveTerminalCodexGoalHandoffBeforeStop({
          launch: isHostedGoalLaunch(input.stopLaunch) ? foregroundLaunch : input.stopLaunch,
          status,
          forceAfterMaterializationFailure: Boolean(
            input.forceStopAfterMaterializationFailure,
          ),
        });
        if (input.stopLaunch.tmuxSession && !isHostedGoalLaunch(input.stopLaunch)) {
          const evidence = durableHandoffStopEvidence(preserved);
          return status.tmuxAlive === false &&
            !("status" in preserved.stopResult &&
              preserved.stopResult.status === "terminated")
            ? noopOperationResult(
                preserved.stopResult.preview,
                "Worker process is already gone; durable handoff evidence was preserved.",
                evidence,
              )
            : operationResult(preserved.stopResult.preview, evidence);
        }
        const command = preserved.stopResult;
        const stopEvidence = durableHandoffStopEvidence(preserved);
        if ("status" in command && command.status === "terminated") {
          return operationResult(command.preview, stopEvidence);
        }
        if (
          "status" in command &&
          (command.status === "process_gone" || command.status === "pid_missing")
        ) {
          return noopOperationResult(
            command.preview,
            command.status === "process_gone"
              ? "Worker process is already gone."
              : "Worker has no direct process pid to stop.",
            stopEvidence,
          );
        }
        throw new Error("project_control_stop_untrusted_process");
      },
    },
    workspace: {
      async resolveRevision(worktreeInput) {
        const sourceWorkspacePath = await realpath(
          worktreeInput.sourceWorkspacePath ?? input.controller.workspacePath,
        );
        const outsideScope = await projectControlRealPathOutsideWorkspaceScope(
          sourceWorkspacePath,
          input.scope,
        );
        if (outsideScope) {
          throw new Error(
            "project_control_source_workspace_real_path_outside_scope",
          );
        }
        const sourceRef =
          worktreeInput.sourceRef ?? worktreeInput.baseBranch ?? "HEAD";
        const revision = (
          await execGitStdout([
            "-C",
            sourceWorkspacePath,
            "rev-parse",
            "--verify",
            `${sourceRef}^{commit}`,
          ])
        ).trim();
        return { revision, sourceRealPath: sourceWorkspacePath };
      },
      async createWorktree() {
        if (!input.createWorktreeInput) {
          throw new Error("project_control_worktree_input_required");
        }
        const proof = creationProof();
        if (!proof) throw new Error("project_control_creation_admission_missing");
        if (proof.missing && (!proof.identity || await boundCreationTargetIdentity({ target: input.createWorktreeInput, scope: input.scope }) !== proof.identity)) {
          throw new Error("project_control_creation_admission_changed");
        }
        if (
          await codexProjectControlPathExists(input.createWorktreeInput.path)
        ) {
          if (input.createWorktreeInput.fastForwardExisting) {
            const fastForwarded = await fastForwardExistingProjectWorktree({
              input: input.createWorktreeInput,
              scope: input.scope,
            });
            if (fastForwarded) {
              return operationResult(input.createWorktreeInput.path);
            }
          }
          return noopOperationResult(
            input.createWorktreeInput.path,
            "existing worktree candidate delegated for exact identity validation",
          );
        }
        const sourceWorkspacePath = await resolveBoundProjectWorktreeSource({
          sourceWorkspacePath: input.createWorktreeInput.sourceWorkspacePath,
          expectedSourceRealPath:
            input.createWorktreeInput.expectedSourceRealPath,
          scope: input.scope,
        });
        const admissionIdentity = proof.identity;
        if (!proof.missing || !admissionIdentity) throw new Error("project_control_creation_admission_changed");
        await mkdir(dirname(input.createWorktreeInput.path), {
          recursive: true,
          mode: 0o700,
        });
        const newBranch = input.createWorktreeInput.newBranch;
        const existingBranch = newBranch
          ? (
              await execGitStdout([
                "-C",
                sourceWorkspacePath,
                "for-each-ref",
                "--format=%(refname)",
                `refs/heads/${newBranch}`,
              ])
            ).trim()
          : "";
        const existingBranchRevision = existingBranch
          ? (
              await execGitStdout([
                "-C",
                sourceWorkspacePath,
                "rev-parse",
                "--verify",
                `${existingBranch}^{commit}`,
              ])
            ).trim()
          : undefined;
        const args = [
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          sourceWorkspacePath,
          "worktree",
          "add",
          ...(newBranch && !existingBranch ? ["-b", newBranch] : []),
          input.createWorktreeInput.path,
          ...(existingBranch && newBranch
            ? [newBranch]
            : newBranch
              ? [input.createWorktreeInput.expectedRevision]
              : input.createWorktreeInput.sourceRevisionPinned
                ? [input.createWorktreeInput.expectedRevision]
                : [
                    input.createWorktreeInput.sourceRef ??
                      input.createWorktreeInput.baseBranch ??
                      input.createWorktreeInput.expectedRevision,
                  ]),
        ];
        if (await boundCreationTargetIdentity({ target: input.createWorktreeInput, scope: input.scope }) !== admissionIdentity) {
          throw new Error("project_control_creation_admission_changed");
        }
        try {
          await execGit(args);
        } catch (error) {
          if (existingBranch) {
            throw new Error(
              "project_control_existing_branch_materialization_failed",
              { cause: error },
            );
          }
          throw error;
        }
        try {
          if (newBranch && existingBranchRevision) {
            await fastForwardMaterializedWorktreeBranch({
              workspacePath: input.createWorktreeInput.path,
              branch: newBranch,
              expectedCurrentRevision: existingBranchRevision,
              expectedNextRevision: input.createWorktreeInput.expectedRevision,
            });
          }
          if (input.createWorktreeInput.inputPatch) {
            await applyVerifiedInputPatch({
              workspacePath: input.createWorktreeInput.path,
              patchPath: input.createWorktreeInput.inputPatch.path,
              expectedSha256: input.createWorktreeInput.inputPatch.sha256,
              expectedBaseCommit:
                input.createWorktreeInput.inputPatch.baseCommit,
              expectedTargetCommit: input.createWorktreeInput.expectedRevision,
              changedPaths: input.createWorktreeInput.inputPatch.changedPaths,
            });
          }
          await revalidateAdmissionCreatedWorktree({
            expectedIdentity: admissionIdentity, target: input.createWorktreeInput, scope: input.scope,
          });
        } catch (error) {
          await execGit([
            "-C",
            sourceWorkspacePath,
            "worktree",
            "remove",
            "--force",
            admissionIdentity,
          ]);
          throw error;
        }
        return operationResult(input.createWorktreeInput.path);
      },
    },
    git: {
      async integrateCommit() {
        if (!input.integrateCommitInput) {
          throw new Error("project_control_integrate_commit_input_required");
        }
        await assertGitCurrentBranch({
          workspacePath: input.integrateCommitInput.workspacePath,
          branch: input.integrateCommitInput.branch,
        });
        const targetIsDescendant = await isGitAncestor({
          workspacePath: input.integrateCommitInput.workspacePath,
          ancestor: "HEAD",
          descendant: input.integrateCommitInput.commitSha,
        });
        await execGit([
          "-C",
          input.integrateCommitInput.workspacePath,
          ...(targetIsDescendant
            ? ["merge", "--ff-only", input.integrateCommitInput.commitSha]
            : ["cherry-pick", "--ff", input.integrateCommitInput.commitSha]),
        ]);
        return operationResult(input.integrateCommitInput.commitSha);
      },
      async pushBranch() {
        if (!input.pushBranchInput) {
          throw new Error("project_control_push_branch_input_required");
        }
        await pushProjectBranch(input.pushBranchInput);
        return operationResult(
          `${input.pushBranchInput.remote}/${input.pushBranchInput.branch}`,
        );
      },
    },
  };
}

async function codexProjectControlPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function assertReviewedOutputWorkerStopped(
  launch: CodexGoalLaunchInput,
  status: Awaited<ReturnType<typeof collectCodexGoalStatus>>,
): void {
  const progressStale =
    status.progressHeartbeatAgeMs !== undefined &&
    status.progressHeartbeatAgeMs > 10 * 60_000;
  const liveness = resolveCodexGoalWorkerLiveness({ status, progressStale });
  if (liveness.alive) {
    throw new Error("reviewed_worker_output_worker_still_running");
  }
  if (launch.tmuxSession && status.tmuxAlive === true) {
    throw new Error("reviewed_worker_output_worker_still_running");
  }
}

async function appendProjectControlAuditEvent(
  controller: CodexGoalJobManifest,
  event: ProjectControlBrokerEvent,
): Promise<void> {
  const auditPath = projectControlAuditPath(controller);
  await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
  await appendFile(auditPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function projectControlAuditPath(
  controller: CodexGoalJobManifest,
): string {
  return join(
    controller.jobRootDir,
    `${controller.taskId}.project-control-events.jsonl`,
  );
}

function operationResult(
  resourceId: string,
  evidence?: Readonly<Record<string, string>>,
): ProjectControlOperationResult {
  return {
    status: "applied",
    resourceId,
    ...(evidence ? { evidence } : {}),
  };
}
