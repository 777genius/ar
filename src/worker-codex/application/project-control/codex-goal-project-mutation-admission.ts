import { isDeepStrictEqual } from "node:util";
import { evaluateProjectAdmission, type ProjectAdmissionGate, type ProjectAdmissionRequest, type ProjectAdmissionSnapshot, type ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import { buildCodexProjectAdmissionSnapshot, type CodexProjectMutationAdmissionInput } from "./codex-goal-project-admission";
import { withoutAdmittedInputPatchDebt, withoutCapacityContinuationSiblingDebt, withoutInPlaceContinuationSelfDebt } from "./codex-goal-project-admission-normalization";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { prepareCodexProjectScopedAdmission } from "./codex-goal-project-scoped-admission";
import { admissionNeedsFreshCreateJobTarget } from "./codex-goal-project-admission-target";
import { adoptionGitReadRecipe, readPlannedProjectAdoptionProof } from "./codex-goal-project-adoption-target";
import { researchJobWriterOwnerNamespacePresent } from "../../research-writer-observation";

export function codexProjectAdmissionGate(
  input: CodexProjectMutationAdmissionInput,
): ProjectAdmissionGate {
  const observe = async (request: ProjectAdmissionRequest): Promise<ProjectAdmissionSnapshot> => {
      // Admission protects a mutation. A cached pre-launch snapshot can no
      // longer prove that another writer did not start in the meantime.
      const observedSnapshot = await buildCodexProjectAdmissionSnapshot({
        ...input,
        targetRequest: request,
        ...(input.targetBinding?.plannedAdoption ? { guardedOrphanGitRead: { workspacePath: input.targetBinding.plannedAdoption.target.expectedRealPath!, recipe: adoptionGitReadRecipe } } : {}),
        ...(request.workspacePath
          ? { requestedWorkspacePath: request.workspacePath }
          : {}),
        blockAnyLiveWriter: request.ownedPaths !== undefined ||
          request.workspacePath === undefined,
        ...(input.admittedInputPatchTarget
          ? { admittedInputPatchRequest: request }
          : {}),
      });
      const snapshot = await withoutCapacityContinuationSiblingDebt({
        snapshot: observedSnapshot,
        request,
        ...(input.capacityContinuationTarget
          ? { binding: input.capacityContinuationTarget }
          : {}),
      });
      const continuationSnapshot = await withoutInPlaceContinuationSelfDebt({
        snapshot,
        request,
        ...(input.inPlaceContinuationTarget
          ? { binding: input.inPlaceContinuationTarget }
          : {}),
      });
      return continuationSnapshot;
  };
  const evaluatePrepared = async (
    request: ProjectAdmissionRequest,
    continuationSnapshot: ProjectAdmissionSnapshot,
    deps = input.deps,
  ) => {
      let freshControlledTarget = false;
      if (await admissionNeedsFreshCreateJobTarget(input.targetBinding) && input.controllerJobId &&
        deps.readJob && deps.readWriterWritableRoots) {
        try {
          const controller = await deps.readJob({ registryRootDir: input.registryRootDir, jobId: input.controllerJobId });
          freshControlledTarget = controller.jobId !== input.controllerJobId || researchJobWriterOwnerNamespacePresent(controller);
        } catch { freshControlledTarget = true; }
      }
      const hasScopedBinding = Boolean(input.targetBinding?.createWorktree ||
        input.targetBinding?.createManifest?.projectPreStartAdmission ||
        input.targetBinding?.createBirthPreparation !== undefined ||
        freshControlledTarget ||
        input.targetBinding?.start?.manifest.projectPreStartAdmission);
      const scoped = hasScopedBinding ? await prepareCodexProjectScopedAdmission({
        registryRootDir: input.registryRootDir,
        scope: input.scope,
        ...(input.controllerJobId ? { controllerJobId: input.controllerJobId } : {}),
        request,
        snapshot: continuationSnapshot,
        ...(input.targetBinding ? { targetBinding: input.targetBinding } : {}),
        deps,
      }) : undefined;
      return evaluateProjectAdmission({
        ...(scoped ? { scoped } : {}),
        request: {
          ...request,
          projectId: request.projectId ?? input.scope.projectId,
        },
        snapshot: continuationSnapshot,
      });
  };
  const evaluateAdoption = async (request: ProjectAdmissionRequest, deps = input.deps) => {
    const adoption = input.targetBinding!.plannedAdoption!;
    const proofInput = { registryRootDir: input.registryRootDir, controllerJobId: input.controllerJobId, scope: input.scope, request, adoption };
    const before = await readPlannedProjectAdoptionProof(proofInput);
    const snapshot = await withoutAdmittedInputPatchDebt({ snapshot: await observe(request), request,
      binding: { jobId: before.jobId, workspacePath: before.workspacePath }, orphanOnly: true });
    const decision = await evaluatePrepared(request, snapshot, deps);
    if (!isDeepStrictEqual(before, await readPlannedProjectAdoptionProof(proofInput))) throw new Error("project_control_adoption_target_changed");
    return decision;
  };
  return {
    async prepare(request) {
      // Adoption's exact target proof must precede even its status observation,
      // under publication + the current leaf. Other callers retain preparation.
      const snapshot = input.targetBinding?.plannedAdoption ? undefined : await observe(request);
      let deps = input.deps;
      const prepareWriter = input.deps.createWriterObservationPreparer?.() ?? input.deps.prepareWriterObservation;
      if (prepareWriter && input.deps.readJob) {
        const prepared = new Map<string, { manifest: CodexGoalJobManifest;
          read: () => Promise<ProjectAdmissionWriterObservation> }>();
        const summaries = await input.deps.listJobs({ registryRootDir: input.registryRootDir }).catch(() => []);
        for (const summary of summaries) {
          try {
            const manifest = await input.deps.readJob({ registryRootDir: input.registryRootDir, jobId: summary.jobId });
            prepared.set(manifest.jobId, { manifest, read: await prepareWriter(manifest) });
          } catch { /* Final census retains unknown for incomplete owner evidence. */ }
        }
        deps = { ...input.deps, readWriterWritableRoots: async manifest => {
          const owner = prepared.get(manifest.jobId);
          if (owner && isDeepStrictEqual(owner.manifest, manifest)) return await owner.read();
          return await input.deps.readWriterWritableRoots?.(manifest) ?? { status: "unknown" };
        } };
      }
      return {
        async evaluate(currentRequest) {
          if (!isDeepStrictEqual(currentRequest, request)) {
            throw new Error("project_control_prepared_admission_request_changed");
          }
          return input.targetBinding?.plannedAdoption ? await evaluateAdoption(currentRequest, deps) : await evaluatePrepared(currentRequest, snapshot!, deps);
        },
      };
    },
    async evaluate(request) {
      return input.targetBinding?.plannedAdoption ? await evaluateAdoption(request) : await evaluatePrepared(request, await observe(request));
    },
  };
}
