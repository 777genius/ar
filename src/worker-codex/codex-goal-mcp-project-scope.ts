import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifestInput } from "./codex-goal-jobs";
import type {
  DependencyBootstrapMode,
  DependencyPreflightResult,
} from "./dependency-bootstrap";
import { assertSafeGitRefName } from "./application/project-control/codex-goal-project-git";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";
export {
  projectControlCanonicalWorkspacePath,
  projectControlRealPathIfExists,
  projectControlRealPathOutsideReadScope,
  projectControlRealPathOutsideWorkspaceScope,
} from "./application/project-control/codex-goal-project-workspace-scope";
import {
  matchesProjectControlPrefix,
  pathInsideAnyProjectRoot,
  pathInsideOrEqual,
  uniqueProjectControlStrings,
} from "./codex-goal-mcp-project-utils";
import {
  requiredString,
  resolvePath,
  stringValue,
} from "./codex-goal-mcp-values";

const PROJECT_CONTROL_SCOPE_REPAIR_IMMUTABLE_FIELDS = [
  "projectId",
  "projectSlug",
  "readRoots",
  "observedWorkspaceRoots",
  "isolatedWorkspaceRoot",
  "workspaceRoots",
  "commitIdentity",
  "worktreeRoots",
  "registryRoot",
  "authRoot",
  "deniedRoots",
  "jobIdPrefixes",
  "tmuxSessionPrefixes",
  "allowedBranches",
  "allowedGitRemotes",
  "allowedAccountIds",
  "allowForcePush",
  "preStartAdmission",
] as const satisfies readonly (keyof ProjectAccessScope)[];

export function projectControlChildScope(
  parent: ProjectAccessScope,
  workspacePath: string,
): ProjectAccessScope {
  return {
    projectId: parent.projectId,
    ...(parent.projectSlug ? { projectSlug: parent.projectSlug } : {}),
    readRoots: uniqueProjectControlStrings([
      ...(parent.readRoots ?? []),
      workspacePath,
      ...(parent.registryRoot ? [parent.registryRoot] : []),
    ]),
    isolatedWorkspaceRoot: workspacePath,
    workspaceRoots: [workspacePath],
    ...(parent.registryRoot ? { registryRoot: parent.registryRoot } : {}),
    ...(parent.authRoot ? { authRoot: parent.authRoot } : {}),
    ...(parent.deniedRoots ? { deniedRoots: parent.deniedRoots } : {}),
    ...(parent.allowedAccountIds
      ? { allowedAccountIds: parent.allowedAccountIds }
      : {}),
  };
}

export function assertProjectControlScopeRepairAllowed(input: {
  readonly existing: ProjectAccessScope;
  readonly proposed: ProjectAccessScope;
}): void {
  for (const field of PROJECT_CONTROL_SCOPE_REPAIR_IMMUTABLE_FIELDS) {
    if (
      field === "allowedAccountIds" &&
      projectControlAllowedAccountIdsAppendAllowed({
        existing: input.existing.allowedAccountIds,
        proposed: input.proposed.allowedAccountIds,
      })
    ) {
      continue;
    }
    if (
      field === "allowedBranches" &&
      projectControlAllowedBranchesAppendAllowed({
        existing: input.existing.allowedBranches,
        proposed: input.proposed.allowedBranches,
      })
    ) {
      continue;
    }
    if (
      field === "preStartAdmission" &&
      (projectControlPreStartAdmissionUpgradeAllowed({
        existing: input.existing.preStartAdmission,
        proposed: input.proposed.preStartAdmission,
      }) ||
        projectControlPreStartAdmissionEquivalent({
          existing: input.existing.preStartAdmission,
          proposed: input.proposed.preStartAdmission,
        }))
    ) {
      continue;
    }
    if (
      projectScopeFieldFingerprint(input.existing[field]) !==
      projectScopeFieldFingerprint(input.proposed[field])
    ) {
      throw new Error(`project_control_scope_${field}_repair_denied`);
    }
  }
  const allowedRoots = uniqueProjectControlStrings([
    ...(input.existing.readRoots ?? []),
    ...(input.existing.workspaceRoots ?? []),
    ...(input.existing.worktreeRoots ?? []),
    ...(input.existing.observedWorkspaceRoots ?? []),
    ...(input.existing.isolatedWorkspaceRoot
      ? [input.existing.isolatedWorkspaceRoot]
      : []),
    ...(input.existing.registryRoot ? [input.existing.registryRoot] : []),
  ]);
  const deniedRoots = input.existing.deniedRoots ?? [];
  for (const root of input.proposed.consumedOutputLedgerRoots ?? []) {
    if (!pathInsideAnyProjectRoot(root, allowedRoots)) {
      throw new Error(
        "project_control_consumed_output_ledger_root_outside_scope",
      );
    }
    if (deniedRoots.some((denied) => pathsOverlap(root, denied))) {
      throw new Error("project_control_consumed_output_ledger_root_denied");
    }
  }
  const existingEvidenceRoots =
    input.existing.consumedOutputEvidenceRoots ?? [];
  for (const root of input.proposed.consumedOutputEvidenceRoots ?? []) {
    if (!isAbsolute(root) || resolve(root) === dirname(resolve(root))) {
      throw new Error("project_control_consumed_output_evidence_root_invalid");
    }
    if (!pathInsideAnyProjectRoot(root, allowedRoots)) {
      throw new Error("project_control_consumed_output_evidence_root_outside_scope");
    }
    if (deniedRoots.some((denied) => pathsOverlap(root, denied))) {
      throw new Error("project_control_consumed_output_evidence_root_denied");
    }
  }
  const proposedEvidenceRoots = input.proposed.consumedOutputEvidenceRoots ?? [];
  if (
    proposedEvidenceRoots.length < existingEvidenceRoots.length ||
    existingEvidenceRoots.some(
      (root, index) => proposedEvidenceRoots[index] !== root,
    )
  ) {
    throw new Error("project_control_consumed_output_evidence_roots_repair_denied");
  }
}

/**
 * Evidence custody may be appended during a repair, but only as an exact,
 * existing archive directory. Lexical/physical identity rejects leaf and
 * ancestor symlinks and prevents granting a broad cache or home root.
 */
export async function assertProjectControlEvidenceRootsCanonical(
  roots: readonly string[],
  scope?: ProjectAccessScope,
): Promise<void> {
  const seen = new Set<string>();
  for (const input of roots) {
    if (!isAbsolute(input) || basename(resolve(input)) !== "archives") {
      throw new Error("project_control_consumed_output_evidence_root_not_narrow");
    }
    const resolved = resolve(input);
    if (scope) {
      const ownedRoots = uniqueProjectControlStrings([
        ...(scope.readRoots ?? []), ...(scope.workspaceRoots ?? []),
        ...(scope.worktreeRoots ?? []), ...(scope.observedWorkspaceRoots ?? []),
        ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
        ...(scope.registryRoot ? [scope.registryRoot] : []),
      ]).map((root) => resolve(root));
      if (!pathInsideAnyProjectRoot(resolved, ownedRoots)) {
        throw new Error("project_control_consumed_output_evidence_root_outside_scope");
      }
      if ((scope.deniedRoots ?? []).some((denied) =>
        pathsOverlap(resolved, resolve(denied)))) {
        throw new Error("project_control_consumed_output_evidence_root_denied");
      }
    }
    if (seen.has(resolved)) {
      throw new Error("project_control_consumed_output_evidence_root_duplicate");
    }
    seen.add(resolved);
    const [physical, metadata] = await Promise.all([
      realpath(resolved),
      lstat(resolved),
    ]);
    if (
      physical !== resolved || metadata.isSymbolicLink() || !metadata.isDirectory()
    ) {
      throw new Error("project_control_consumed_output_evidence_root_noncanonical");
    }
  }
}

export async function assertProjectControlCustodyScopeCanonical(
  scope: ProjectAccessScope,
): Promise<void> {
  await assertProjectControlEvidenceRootsCanonical(
    scope.consumedOutputEvidenceRoots ?? [],
    scope,
  );
  const ownedRoots = uniqueProjectControlStrings([
    ...(scope.readRoots ?? []), ...(scope.workspaceRoots ?? []),
    ...(scope.worktreeRoots ?? []), ...(scope.observedWorkspaceRoots ?? []),
    ...(scope.isolatedWorkspaceRoot ? [scope.isolatedWorkspaceRoot] : []),
    ...(scope.registryRoot ? [scope.registryRoot] : []),
  ]).map((root) => resolve(root));
  const seen = new Set<string>();
  for (const input of scope.consumedOutputLedgerRoots ?? []) {
    const lexical = resolve(input);
    if (seen.has(lexical)) {
      throw new Error("project_control_consumed_output_ledger_root_duplicate");
    }
    seen.add(lexical);
    if (!pathInsideAnyProjectRoot(lexical, ownedRoots) ||
      (scope.deniedRoots ?? []).some((denied) =>
        pathsOverlap(lexical, resolve(denied)))) {
      throw new Error("project_control_consumed_output_ledger_root_outside_scope");
    }
    const [physical, metadata] = await Promise.all([
      realpath(lexical), lstat(lexical),
    ]);
    if (physical !== lexical || metadata.isSymbolicLink() ||
      !metadata.isDirectory()) {
      throw new Error("project_control_consumed_output_ledger_root_noncanonical");
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathInsideOrEqual(resolve(left), resolve(right)) ||
    pathInsideOrEqual(resolve(right), resolve(left));
}

export function projectControlConsumedOutputEvidenceRoot(
  scope: ProjectAccessScope,
): string {
  const roots = scope.consumedOutputEvidenceRoots ?? [];
  // Scope repair preserves historical read roots and appends the active writer.
  const activeRoot = roots.at(-1);
  if (!activeRoot) {
    throw new Error("project_control_consumed_output_evidence_root_required");
  }
  return resolve(activeRoot);
}

function projectControlAllowedBranchesAppendAllowed(input: {
  readonly existing: ProjectAccessScope["allowedBranches"];
  readonly proposed: ProjectAccessScope["allowedBranches"];
}): boolean {
  if (input.proposed === undefined) return input.existing === undefined;
  const existing = input.existing ?? ["main"];
  const proposed = input.proposed;
  const added = proposed.slice(existing.length);
  return (
    proposed.length >= existing.length &&
    existing.every((branch, index) => proposed[index] === branch) &&
    new Set(proposed).size === proposed.length &&
    added.every(isSafeExactBranchName)
  );
}

function isSafeExactBranchName(value: string): boolean {
  if (
    value.length === 0 ||
    value === "@" ||
    value.includes("@{") ||
    value.includes("\\") ||
    value.split("/").some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".lock"),
    )
  ) {
    return false;
  }
  try {
    assertSafeGitRefName(value, "allowed_branch");
    return true;
  } catch {
    return false;
  }
}

function projectControlAllowedAccountIdsAppendAllowed(input: {
  readonly existing: ProjectAccessScope["allowedAccountIds"];
  readonly proposed: ProjectAccessScope["allowedAccountIds"];
}): boolean {
  const existing = input.existing ?? [];
  const proposed = input.proposed ?? [];
  return (
    proposed.length >= existing.length &&
    existing.every((accountId, index) => proposed[index] === accountId) &&
    new Set(proposed).size === proposed.length
  );
}

export function projectControlAddedAllowedAccountIds(input: {
  readonly existing: ProjectAccessScope["allowedAccountIds"];
  readonly proposed: ProjectAccessScope["allowedAccountIds"];
}): readonly string[] {
  const existing = new Set(input.existing ?? []);
  return (input.proposed ?? []).filter((accountId) => !existing.has(accountId));
}

function projectControlPreStartAdmissionUpgradeAllowed(input: {
  readonly existing: ProjectAccessScope["preStartAdmission"];
  readonly proposed: ProjectAccessScope["preStartAdmission"];
}): boolean {
  return (
    input.existing === undefined &&
    input.proposed?.required === true &&
    input.proposed.mode === "serial-builtin"
  );
}

function projectControlPreStartAdmissionEquivalent(input: {
  readonly existing: ProjectAccessScope["preStartAdmission"];
  readonly proposed: ProjectAccessScope["preStartAdmission"];
}): boolean {
  return (
    input.existing !== undefined &&
    input.proposed !== undefined &&
    input.existing.mode === "serial-builtin" &&
    input.proposed.mode === "serial-builtin" &&
    input.existing.required === input.proposed.required &&
    input.existing.mode === input.proposed.mode
  );
}

export function projectScopeFieldFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((item) => String(item)));
  }
  return JSON.stringify(value ?? null);
}

export function projectControlWorkerRole(
  value: unknown,
): "producer" | "fastgate" | "reviewer" | "adoption" {
  const role = stringValue(value) ?? "producer";
  if (
    role === "producer" ||
    role === "fastgate" ||
    role === "reviewer" ||
    role === "adoption"
  ) {
    return role;
  }
  throw new Error("project_control_worker_role_invalid");
}

export function projectControlDependencyBootstrapMode(
  value: unknown,
): DependencyBootstrapMode {
  const mode = stringValue(value) ?? "preflight";
  if (mode === "off" || mode === "preflight" || mode === "install") {
    return mode;
  }
  throw new Error("project_control_dependency_bootstrap_mode_invalid");
}

export function assertProjectControlDependencyBootstrapReady(
  result: DependencyPreflightResult,
): void {
  if (result.status === "unsafe") {
    throw new Error(
      `project_control_dependency_environment_unsafe:${(
        result.unsafeDependencyPaths ?? []
      ).join(",")}`,
    );
  }
  if (result.mode === "install" && result.status === "install_failed") {
    throw new Error(
      `project_control_dependency_bootstrap_failed:${result.warnings.join(",")}`,
    );
  }
}

export function assertProjectControlCreateManifestPaths(input: {
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
  readonly manifest: CodexGoalJobManifestInput;
}): void {
  const jobRootBase = dirname(
    input.scope.registryRoot ?? input.registryRootDir,
  );
  if (!pathInsideOrEqual(input.manifest.jobRootDir, jobRootBase)) {
    throw new Error("project_control_job_root_outside_scope");
  }
  if (
    !matchesProjectControlPrefix(
      basename(input.manifest.jobRootDir),
      input.scope.jobIdPrefixes ?? [],
    )
  ) {
    throw new Error("project_control_job_root_prefix_denied");
  }
  if (
    !pathInsideAnyProjectRoot(input.manifest.workspacePath, [
      ...(input.scope.workspaceRoots ?? []),
      ...(input.scope.worktreeRoots ?? []),
      ...(input.scope.isolatedWorkspaceRoot
        ? [input.scope.isolatedWorkspaceRoot]
        : []),
    ])
  ) {
    throw new Error("project_control_workspace_outside_scope");
  }

  for (const [field, value] of [
    ["promptPath", input.manifest.promptPath],
    ["outputPath", input.manifest.outputPath],
    ["progressPath", input.manifest.progressPath],
    ["logPath", input.manifest.logPath],
    ["stateRootDir", input.manifest.stateRootDir],
  ] as const) {
    if (
      value &&
      !pathInsideAnyProjectRoot(value, [
        input.manifest.jobRootDir,
        input.manifest.workspacePath,
      ])
    ) {
      throw new Error(`project_control_${field}_outside_scope`);
    }
  }

  if (
    input.scope.authRoot &&
    input.manifest.authRootDir &&
    resolve(input.manifest.authRootDir) !== resolve(input.scope.authRoot)
  ) {
    throw new Error("project_control_auth_root_outside_scope");
  }
}

export function projectControlPathArg(
  args: ProjectControlMcpArgs,
  value: unknown,
  fieldName: string,
): string {
  const cwd = resolvePath(
    process.cwd(),
    stringValue(args.cwd) ?? process.cwd(),
  );
  return requiredString(value, fieldName, cwd);
}
