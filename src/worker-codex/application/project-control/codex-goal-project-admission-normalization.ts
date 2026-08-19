import {
  ProjectDebtReason,
  ProjectOperation,
  projectAdmissionDebtCounts,
  type ProjectAdmissionRequest,
  type ProjectAdmissionSnapshot,
  type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";

import { admissionWorkspacePathsMatch } from "./codex-goal-project-admission-paths";

export type ProjectAdmissionJobWorkspaceBinding = {
  readonly jobId: string;
  readonly workspacePath: string;
};

export type ProjectAdmissionInPlaceContinuationBinding =
  ProjectAdmissionJobWorkspaceBinding & {
    readonly ownedPaths: readonly string[];
  };

export async function withoutInPlaceContinuationSelfDebt(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly request: ProjectAdmissionRequest;
  readonly binding?: ProjectAdmissionInPlaceContinuationBinding;
}): Promise<ProjectAdmissionSnapshot> {
  const { binding, request } = input;
  if (
    !binding ||
    request.operation !== ProjectOperation.StartWorker ||
    request.jobId !== binding.jobId ||
    !request.workspacePath ||
    !sameStrings(request.ownedPaths, binding.ownedPaths) ||
    !await admissionWorkspacePathsMatch(
      request.workspacePath,
      binding.workspacePath,
    )
  ) {
    return input.snapshot;
  }
  const debt: ProjectDebtItem[] = [];
  for (const item of input.snapshot.debt) {
    const selfInactiveWorkspace =
      item.reason === ProjectDebtReason.InactiveDirtyWorkspace &&
      await admissionWorkspacePathsMatch(item.subject, binding.workspacePath);
    const selfDirtyWithoutRunner =
      item.reason === ProjectDebtReason.ActiveWriterConflict &&
      item.subject === binding.jobId &&
      item.evidence.includes("dirty_workspace_without_worker");
    if (!selfInactiveWorkspace && !selfDirtyWithoutRunner) debt.push(item);
  }
  return withNormalizedDebt(input.snapshot, debt);
}

export async function withoutCapacityContinuationSiblingDebt(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly request: Pick<
    ProjectAdmissionRequest,
    "operation" | "jobId" | "workspacePath"
  >;
  readonly binding?: ProjectAdmissionJobWorkspaceBinding;
}): Promise<ProjectAdmissionSnapshot> {
  const { binding, request } = input;
  if (
    !binding ||
    request.operation !== ProjectOperation.StartWorker ||
    request.jobId !== binding.jobId ||
    !request.workspacePath ||
    !await admissionWorkspacePathsMatch(
      request.workspacePath,
      binding.workspacePath,
    )
  ) {
    return input.snapshot;
  }
  const debt: ProjectDebtItem[] = [];
  for (const item of input.snapshot.debt) {
    const selfInactiveWorkspace =
      item.reason === ProjectDebtReason.InactiveDirtyWorkspace &&
      await admissionWorkspacePathsMatch(item.subject, binding.workspacePath);
    const selfDirtyWithoutRunner =
      item.reason === ProjectDebtReason.ActiveWriterConflict &&
      item.subject === binding.jobId &&
      item.evidence.includes("dirty_workspace_without_worker");
    if (!selfInactiveWorkspace && !selfDirtyWithoutRunner) {
      debt.push(item);
    }
  }
  return withNormalizedDebt(input.snapshot, debt);
}

export async function withoutAdmittedInputPatchDebt(input: {
  readonly snapshot: ProjectAdmissionSnapshot;
  readonly request: ProjectAdmissionRequest | undefined;
  readonly binding?: ProjectAdmissionJobWorkspaceBinding;
}): Promise<ProjectAdmissionSnapshot> {
  const { binding, request } = input;
  if (
    !binding || !request ||
    (request.operation !== ProjectOperation.StartWorker &&
      request.operation !== ProjectOperation.CreateWorktree &&
      request.operation !== ProjectOperation.CreateJob) ||
    request.jobId !== binding.jobId ||
    !request.workspacePath ||
    !await admissionWorkspacePathsMatch(
      request.workspacePath,
      binding.workspacePath,
    )
  ) {
    return input.snapshot;
  }
  const debt: ProjectDebtItem[] = [];
  for (const item of input.snapshot.debt) {
    const selfOrphanWorkspace =
      item.reason === ProjectDebtReason.OrphanLegacyWorkspace &&
      await admissionWorkspacePathsMatch(item.subject, binding.workspacePath);
    if (request.operation === ProjectOperation.CreateJob) {
      if (!selfOrphanWorkspace) debt.push(item);
      continue;
    }
    const selfInactiveWorkspace =
      item.reason === ProjectDebtReason.InactiveDirtyWorkspace &&
      await admissionWorkspacePathsMatch(item.subject, binding.workspacePath);
    const selfDirtyWithoutRunner =
      item.reason === ProjectDebtReason.ActiveWriterConflict &&
      item.subject === binding.jobId &&
      item.evidence.includes("dirty_workspace_without_worker");
    if (
      !selfInactiveWorkspace &&
      !selfOrphanWorkspace &&
      !selfDirtyWithoutRunner
    ) {
      debt.push(item);
    }
  }
  return withNormalizedDebt(input.snapshot, debt);
}

function withNormalizedDebt(
  snapshot: ProjectAdmissionSnapshot,
  debt: readonly ProjectDebtItem[],
): ProjectAdmissionSnapshot {
  return {
    ...snapshot,
    debt,
    counts: projectAdmissionDebtCounts(debt),
  };
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[],
): boolean {
  return left !== undefined && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
