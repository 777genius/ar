import { relative, resolve, sep } from "node:path";
import type {
  ProjectAccessScope,
  ProjectControlEvidenceCustodyPort,
} from "@vioxen/subscription-runtime/worker-core";

export type FrozenOutputPathClass =
  | "project"
  | "read"
  | "registry"
  | "evidence"
  | "ledger";

export type FrozenOutputPathAuthorization = {
  readonly projectRoots: readonly string[];
  readonly readRoots: readonly string[];
  readonly registryRoot: string;
  readonly evidenceRoots: readonly string[];
  readonly ledgerRoots: readonly string[];
  readonly deniedRoots: readonly string[];
};

/** Builds lexical authority solely from controller configuration. No paths are opened. */
export function buildFrozenOutputPathAuthorization(input: {
  readonly scope: ProjectAccessScope;
  readonly registryRootDir: string;
}): FrozenOutputPathAuthorization {
  const projectRoots = unique([
    ...(input.scope.readRoots ?? []),
    ...(input.scope.workspaceRoots ?? []),
    ...(input.scope.worktreeRoots ?? []),
    ...(input.scope.observedWorkspaceRoots ?? []),
    ...(input.scope.isolatedWorkspaceRoot
      ? [input.scope.isolatedWorkspaceRoot]
      : []),
    ...(input.scope.registryRoot ? [input.scope.registryRoot] : []),
  ]);
  const readRoots = unique(input.scope.readRoots ?? []);
  const evidenceRoots = unique(input.scope.consumedOutputEvidenceRoots ?? []);
  const ledgerRoots = unique(input.scope.consumedOutputLedgerRoots ?? []);
  const deniedRoots = unique(input.scope.deniedRoots ?? []);
  const registryRoot = resolve(input.registryRootDir);
  if (projectRoots.length === 0 ||
    !projectRoots.some((root) => inside(registryRoot, root)) ||
    (input.scope.registryRoot !== undefined &&
      resolve(input.scope.registryRoot) !== registryRoot) ||
    intersectsDenied(registryRoot, deniedRoots)) {
    throw new Error("frozen_output_registry_outside_project_scope");
  }
  for (const root of [...evidenceRoots, ...ledgerRoots]) {
    if (!projectRoots.some((owned) => inside(root, owned)) ||
      intersectsDenied(root, deniedRoots)) {
      throw new Error("frozen_output_custody_root_outside_project_scope");
    }
  }
  return {
    projectRoots,
    readRoots,
    registryRoot,
    evidenceRoots,
    ledgerRoots,
    deniedRoots,
  };
}

/** Canonicalizes only already-configured authority roots, then re-proves containment. */
export async function canonicalFrozenOutputPathAuthorization(
  custody: ProjectControlEvidenceCustodyPort,
  lexical: FrozenOutputPathAuthorization,
): Promise<FrozenOutputPathAuthorization> {
  const [projectRoots, readRoots, registryRoot, evidenceRoots, ledgerRoots,
    deniedRoots] = await Promise.all([
    canonicalRoots(custody, lexical.projectRoots),
    canonicalRoots(custody, lexical.readRoots),
    custody.canonicalDirectory(lexical.registryRoot),
    canonicalRoots(custody, lexical.evidenceRoots),
    canonicalRoots(custody, lexical.ledgerRoots),
    canonicalRoots(custody, lexical.deniedRoots, true),
  ]);
  const canonical = {
    projectRoots: unique(projectRoots),
    readRoots: unique(readRoots),
    registryRoot,
    evidenceRoots: unique(evidenceRoots),
    ledgerRoots: unique(ledgerRoots),
    deniedRoots: unique(deniedRoots),
  };
  if (!canonical.projectRoots.some((root) => inside(registryRoot, root)) ||
    intersectsDenied(registryRoot, canonical.deniedRoots)) {
    throw new Error("frozen_output_registry_outside_project_scope");
  }
  for (const root of [...canonical.evidenceRoots, ...canonical.ledgerRoots]) {
    if (!canonical.projectRoots.some((owned) => inside(root, owned)) ||
      intersectsDenied(root, canonical.deniedRoots)) {
      throw new Error("frozen_output_custody_root_outside_project_scope");
    }
  }
  return canonical;
}

export function assertFrozenOutputReadAllowed(
  authorization: FrozenOutputPathAuthorization,
  path: string,
  pathClass: FrozenOutputPathClass,
  errorCode = "frozen_output_path_outside_project_scope",
): string {
  const candidate = resolve(path);
  const roots = rootsFor(authorization, pathClass);
  if (!roots.some((root) => inside(candidate, root)) ||
    authorization.deniedRoots.some((root) => inside(candidate, root))) {
    throw new Error(errorCode);
  }
  return candidate;
}

export function frozenOutputPathsEqual(
  left: FrozenOutputPathAuthorization,
  right: FrozenOutputPathAuthorization,
): boolean {
  return left.registryRoot === right.registryRoot &&
    same(left.projectRoots, right.projectRoots) &&
    same(left.readRoots, right.readRoots) &&
    same(left.evidenceRoots, right.evidenceRoots) &&
    same(left.ledgerRoots, right.ledgerRoots) &&
    same(left.deniedRoots, right.deniedRoots);
}

function rootsFor(
  authorization: FrozenOutputPathAuthorization,
  pathClass: FrozenOutputPathClass,
): readonly string[] {
  switch (pathClass) {
    case "project": return authorization.projectRoots;
    case "read": return authorization.readRoots;
    case "registry": return [authorization.registryRoot];
    case "evidence": return authorization.evidenceRoots;
    case "ledger": return authorization.ledgerRoots;
  }
}

function intersectsDenied(path: string, deniedRoots: readonly string[]): boolean {
  return deniedRoots.some((denied) => inside(path, denied) || inside(denied, path));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].sort();
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) =>
    item === right[index]);
}

async function canonicalRoots(
  custody: ProjectControlEvidenceCustodyPort,
  roots: readonly string[],
  allowMissing = false,
): Promise<string[]> {
  return await Promise.all(roots.map(async (root) =>
    await custody.canonicalDirectory(root, allowMissing)));
}
