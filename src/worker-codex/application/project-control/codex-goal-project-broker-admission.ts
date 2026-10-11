import {
  ProjectOperation,
  type ProjectAccessScope,
  type ProjectAdmissionGate,
} from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest, CodexGoalJobManifestInput } from "../../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../../codex-goal-ops";
import type { ProjectControlWorkspaceLease } from "../../codex-goal-project-workspace-lock";
import { codexProjectAdmissionGate, type CodexProjectAdmissionDeps } from "./codex-goal-project-admission";
import { boundCreationTargetIdentity, type ProjectAdmissionTargetBinding } from "./codex-goal-project-admission-target";
import type { ProjectAdmissionJobWorkspaceBinding } from "./codex-goal-project-admission-normalization";
import type { CodexGoalProjectCreateWorktreeInput } from "./codex-goal-project-control-contracts";
import type { ProjectControlledRuntimeInPlaceContinuation } from "./codex-goal-project-in-place-continuation";
import type { ProjectPreStartAdmissionLaunchWorkspaceMode } from "./codex-goal-project-pre-start-admission";
import type { ProtectedCodexGoalJobBirthPreparation } from "../../protected-job-birth";

type BrokerAdmissionInput = {
  readonly registryRootDir: string;
  readonly controller: Pick<CodexGoalJobManifest, "jobId">;
  readonly scope: ProjectAccessScope;
  readonly admissionDeps: CodexProjectAdmissionDeps;
  readonly createManifest?: CodexGoalJobManifestInput;
  readonly protectedBirthPreparation?: ProtectedCodexGoalJobBirthPreparation;
  readonly createReviewedOutputAggregate?: ProjectAdmissionTargetBinding["createReviewedOutputAggregate"];
  readonly createWorktreeInput?: CodexGoalProjectCreateWorktreeInput;
  readonly plannedAdoption?: import("./codex-goal-project-adoption-target").PlannedProjectAdoption;
  readonly startLaunch?: CodexGoalLaunchInput;
  readonly startManifest?: CodexGoalJobManifest;
  readonly startAdmissionWorkspaceMode?: ProjectPreStartAdmissionLaunchWorkspaceMode;
  readonly startWorkspaceLease?: ProjectControlWorkspaceLease;
  readonly controlledRuntimeInPlaceContinuation?: ProjectControlledRuntimeInPlaceContinuation;
};
export type ProjectCreationAdmissionProof = {
  readonly missing: boolean;
  readonly identity: string | undefined;
};

export function createProjectBrokerAdmission(
  input: BrokerAdmissionInput,
  admittedInputPatchTarget: ProjectAdmissionJobWorkspaceBinding | undefined,
  pathExists: (path: string) => Promise<boolean>,
  adoptionWorkspaceLease: () => ProjectControlWorkspaceLease | undefined = () => undefined,
): {
  readonly gate: ProjectAdmissionGate;
  readonly creationProof: () => ProjectCreationAdmissionProof | undefined;
} {
  // One mutation port retains its original admission proof. A second create
  // cannot replace it while the first asynchronous operation is in flight.
  let admittedCreation: ProjectCreationAdmissionProof | undefined;
  const mutationGate = codexProjectAdmissionGate({
      registryRootDir: input.registryRootDir,
      scope: input.scope,
      controllerJobId: input.controller.jobId,
      deps: input.admissionDeps,
      targetBinding: {
        ...(input.createWorktreeInput ? { createWorktree: input.createWorktreeInput } : {}),
        ...(input.plannedAdoption ? { plannedAdoption: { ...input.plannedAdoption, workspaceLease: adoptionWorkspaceLease } } : {}),
        ...(input.createManifest ? { createManifest: input.createManifest } : {}),
        ...(input.protectedBirthPreparation !== undefined ? { createBirthPreparation: input.protectedBirthPreparation } : {}),
        ...(input.createReviewedOutputAggregate !== undefined ? { createReviewedOutputAggregate: input.createReviewedOutputAggregate } : {}),
        ...(input.startManifest && input.startLaunch && input.startWorkspaceLease ? {
          start: { manifest: input.startManifest, launch: input.startLaunch, workspaceLease: input.startWorkspaceLease,
            ...(input.startAdmissionWorkspaceMode ? { workspaceMode: input.startAdmissionWorkspaceMode } : {}),
            ...(input.controlledRuntimeInPlaceContinuation ? { continuation: input.controlledRuntimeInPlaceContinuation } : {}),
          },
        } : {}),
      },
      ...((input.startAdmissionWorkspaceMode ===
        "admitted_input_patch_continuation" ||
        input.startAdmissionWorkspaceMode ===
          "admitted_input_patch_runtime_continuation" ||
        input.startAdmissionWorkspaceMode ===
          "clean_capacity_continuation") &&
      input.startManifest &&
      input.startWorkspaceLease
        ? {
            capacityContinuationTarget: {
              jobId: input.startManifest.jobId,
              workspacePath: input.startWorkspaceLease.canonicalWorkspacePath,
            },
          }
        : {}),
      ...(input.controlledRuntimeInPlaceContinuation &&
      input.startManifest &&
      input.startWorkspaceLease
        ? {
            inPlaceContinuationTarget: {
              jobId: input.startManifest.jobId,
              workspacePath: input.startWorkspaceLease.canonicalWorkspacePath,
              ownedPaths:
                input.controlledRuntimeInPlaceContinuation.ownedPaths,
            },
          }
        : {}),
      ...(admittedInputPatchTarget ? { admittedInputPatchTarget } : {}),
      });
  const evaluateBound: ProjectAdmissionGate["evaluate"] = async (request) => {
    return await evaluateWithGate(request, mutationGate);
  };
  const evaluateWithGate = async (
    request: Parameters<ProjectAdmissionGate["evaluate"]>[0],
    gate: ProjectAdmissionGate,
  ) => {
      let creation: typeof admittedCreation;
      if (request.operation === ProjectOperation.CreateWorktree && input.createWorktreeInput) {
        if (admittedCreation) throw new Error("project_control_creation_broker_already_admitted");
        if (request.workspacePath !== input.createWorktreeInput.path || request.jobId !== input.createWorktreeInput.jobId) {
          throw new Error("project_control_creation_request_binding_mismatch");
        }
        const missing = !await pathExists(input.createWorktreeInput.path);
        const identity = missing ? await boundCreationTargetIdentity({ target: input.createWorktreeInput, scope: input.scope }) : undefined;
        if (missing && !identity) throw new Error("project_control_creation_target_unproved");
        creation = { missing, identity };
      }
      const decision = await gate.evaluate(request);
      if (decision.allowed && creation) {
        if (admittedCreation) throw new Error("project_control_creation_broker_already_admitted");
        admittedCreation = creation;
      }
      return decision;
  };
  return {
    creationProof: () => admittedCreation,
    gate: {
      async prepare(request) {
        const prepared = mutationGate.prepare
          ? await mutationGate.prepare(request)
          : mutationGate;
        return { evaluate: async (current) => await evaluateWithGate(current, prepared) };
      },
      evaluate: evaluateBound,
    },
  };
}
