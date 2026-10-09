import { isDeepStrictEqual } from "node:util";
import { evaluateProjectAdmission, type ProjectAdmissionGate, type ProjectAdmissionRequest, type ProjectAdmissionSnapshot, type ProjectAdmissionWriterObservation } from "@vioxen/subscription-runtime/worker-core";
import { buildCodexProjectAdmissionSnapshot, type CodexProjectMutationAdmissionInput } from "./codex-goal-project-admission";
import { withoutCapacityContinuationSiblingDebt, withoutInPlaceContinuationSelfDebt } from "./codex-goal-project-admission-normalization";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { prepareCodexProjectScopedAdmission } from "./codex-goal-project-scoped-admission";

export function codexProjectAdmissionGate(
  input: CodexProjectMutationAdmissionInput,
): ProjectAdmissionGate {
  const observe = async (request: ProjectAdmissionRequest): Promise<ProjectAdmissionSnapshot> => {
      // Admission protects a mutation. A cached pre-launch snapshot can no
      // longer prove that another writer did not start in the meantime.
      const observedSnapshot = await buildCodexProjectAdmissionSnapshot({
        ...input,
        targetRequest: request,
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
      const hasScopedBinding = Boolean(input.targetBinding?.createWorktree ||
        input.targetBinding?.createManifest?.projectPreStartAdmission ||
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
  return {
    async prepare(request) {
      const snapshot = await observe(request);
      let deps = input.deps;
      if (input.deps.prepareWriterObservation && input.deps.readJob) {
        const prepared = new Map<string, { manifest: CodexGoalJobManifest;
          read: () => Promise<ProjectAdmissionWriterObservation> }>();
        const summaries = await input.deps.listJobs({ registryRootDir: input.registryRootDir }).catch(() => []);
        for (const summary of summaries) {
          try {
            const manifest = await input.deps.readJob({ registryRootDir: input.registryRootDir, jobId: summary.jobId });
            prepared.set(manifest.jobId, { manifest, read: await input.deps.prepareWriterObservation(manifest) });
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
          return await evaluatePrepared(currentRequest, snapshot, deps);
        },
      };
    },
    async evaluate(request) {
      return await evaluatePrepared(request, await observe(request));
    },
  };
}
