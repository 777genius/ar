import { captureLegacyDependencyWriterInput, assertLegacyDependencyWriterWorkspace } from "./hosted-dependency-legacy-writer-boundary";
import { inspectNodeDependencyMetadata, dependencyRootIsUnsafe, pathWithin } from "./dependency-environment-inspection";
import { legacyDependencyInspectionFiles } from "./dependency-inspection-files";
import { lstatSync, unlinkSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type NodeDependencyEnvironmentInspection = {
  readonly dependencyRoots: readonly string[];
  readonly unsafeDependencyRoots: readonly string[];
};

type InternalNodeDependencyEnvironmentInspection = {
  readonly workspaceRealPath: string;
  readonly dependencyRoots: readonly string[];
  readonly unsafeDependencyRoots: readonly string[];
};

export async function inspectNodeDependencyEnvironment(input: {
  readonly workspacePath: string;
}): Promise<NodeDependencyEnvironmentInspection> {
  input = captureLegacyDependencyWriterInput(input);
  const inspection = await inspectNodeDependencyEnvironmentInternal(input);
  return {
    dependencyRoots: inspection.dependencyRoots.map((path) =>
      relative(inspection.workspaceRealPath, path),
    ),
    unsafeDependencyRoots: inspection.unsafeDependencyRoots.map((path) =>
      relative(inspection.workspaceRealPath, path),
    ),
  };
}

async function inspectNodeDependencyEnvironmentInternal(input: {
  readonly workspacePath: string;
}): Promise<InternalNodeDependencyEnvironmentInspection> {
  const workspaceRealPath = await realpath(input.workspacePath);
  assertLegacyDependencyWriterWorkspace(input.workspacePath);
  const inspection = await inspectNodeDependencyMetadata(workspaceRealPath, legacyDependencyInspectionFiles);
  return { workspaceRealPath,
    dependencyRoots: inspection.dependencyRoots.map(path => join(workspaceRealPath, path)),
    unsafeDependencyRoots: inspection.unsafeDependencyRoots.map(path => join(workspaceRealPath, path)) };
}

export async function sanitizeNodeDependencyEnvironment(input: {
  readonly workspacePath: string;
}): Promise<{ readonly removedPaths: readonly string[] }> {
  input = captureLegacyDependencyWriterInput(input);
  const inspection = await inspectNodeDependencyEnvironmentInternal(input);
  const removedPaths: string[] = [];
  for (const dependencyRoot of inspection.unsafeDependencyRoots) {
    if (
      !(await dependencyRootIsUnsafe(
        dependencyRoot,
        inspection.workspaceRealPath,
        legacyDependencyInspectionFiles,
      ))
    ) {
      continue;
    }
    if (assertLegacyDependencyWriterWorkspace(input.workspacePath) !== inspection.workspaceRealPath) {
      throw new Error("dependency_environment_workspace_changed");
    }
    const leaf = lstatSync(dependencyRoot, { bigint: true });
    if (leaf.isSymbolicLink()) {
      // Classify its actual owning directory, never the external or missing
      // target. The final no-follow identity check and unlink have no await.
      const parent = dirname(dependencyRoot);
      if (assertLegacyDependencyWriterWorkspace(parent) !== parent ||
          !pathWithin(inspection.workspaceRealPath, parent)) {
        throw new Error("dependency_environment_root_invalid");
      }
      const current = lstatSync(dependencyRoot, { bigint: true });
      if (!current.isSymbolicLink() || current.dev !== leaf.dev || current.ino !== leaf.ino ||
          current.mode !== leaf.mode || current.uid !== leaf.uid || current.gid !== leaf.gid ||
          current.nlink !== leaf.nlink || current.size !== leaf.size ||
          current.mtimeNs !== leaf.mtimeNs || current.ctimeNs !== leaf.ctimeNs) {
        throw new Error("dependency_environment_root_changed");
      }
      unlinkSync(dependencyRoot);
    } else {
      assertLegacyDependencyWriterWorkspace(dependencyRoot);
      await rm(dependencyRoot, { recursive: true, force: false });
    }
    removedPaths.push(relative(inspection.workspaceRealPath, dependencyRoot));
  }
  return { removedPaths: removedPaths.sort() };
}
