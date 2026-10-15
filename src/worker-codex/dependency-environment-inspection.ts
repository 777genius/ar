import { dirname, join, relative, resolve, sep } from "node:path";
import type { DependencyInspectionFiles } from "./dependency-inspection-files";
import type { NodeDependencyEnvironmentInspection } from "./dependency-environment-safety";

const MAX_PACKAGE_ROOTS_SCAN = 10_000;
const MAX_DEPENDENCY_ENTRIES_SCAN = 250_000;
const MAX_DIRECTORY_SCAN_CONCURRENCY = 32;
const MAX_LINK_RESOLUTION_CONCURRENCY = 32;
const PACKAGE_SCAN_EXCLUDED_DIRS = new Set([
  ".git",
  ".cache",
  ".pnpm-store",
  "dist",
  "node_modules",
]);

/** Shared observation only; the legacy or scoped adapter validates its read boundary. */
export async function inspectNodeDependencyMetadata(workspaceRealPath: string,
  files: DependencyInspectionFiles): Promise<NodeDependencyEnvironmentInspection> {
  const roots = await nodeDependencyRoots(workspaceRealPath, files);
  const unsafe: string[] = [];
  for (const root of roots) if (await dependencyRootIsUnsafe(root, workspaceRealPath, files)) unsafe.push(root);
  return { dependencyRoots: roots.map(path => relative(workspaceRealPath, path)),
    unsafeDependencyRoots: unsafe.sort().map(path => relative(workspaceRealPath, path)) };
}

async function nodeDependencyRoots(
  workspaceRealPath: string,
  files: DependencyInspectionFiles,
): Promise<readonly string[]> {
  const queue = [workspaceRealPath];
  const roots: string[] = [];
  let cursor = 0;
  let scanned = 0;
  while (cursor < queue.length) {
    if (scanned >= MAX_PACKAGE_ROOTS_SCAN) {
      throw new Error("dependency_environment_package_scan_limit_exceeded");
    }
    const directories = queue.slice(
      cursor,
      cursor +
        Math.min(
          MAX_DIRECTORY_SCAN_CONCURRENCY,
          MAX_PACKAGE_ROOTS_SCAN - scanned,
        ),
    );
    cursor += directories.length;
    scanned += directories.length;
    const batches = await Promise.all(
      directories.map(async (directory) => ({
        directory,
        entries: await files.readdir(directory),
      })),
    );
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        if (entry.name === "node_modules") {
          roots.push(join(directory, entry.name));
          continue;
        }
        if (!entry.isDirectory() || PACKAGE_SCAN_EXCLUDED_DIRS.has(entry.name))
          continue;
        queue.push(join(directory, entry.name));
      }
    }
  }
  return roots.sort();
}

export async function dependencyRootIsUnsafe(
  dependencyRoot: string,
  workspaceRealPath: string,
  files: DependencyInspectionFiles,
): Promise<boolean> {
  let status;
  try {
    status = await files.lstat(dependencyRoot);
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
  if (status.isSymbolicLink()) return true;
  if (!status.isDirectory()) {
    throw new Error("dependency_environment_root_invalid");
  }
  const dependencyRealPath = await files.realpath(dependencyRoot);
  if (!pathWithin(workspaceRealPath, dependencyRealPath)) return true;
  return dependencyTreeContainsEscapingLink(
    dependencyRoot,
    new DependencyLinkTargetResolver(workspaceRealPath, files),
    files,
  );
}

async function dependencyTreeContainsEscapingLink(
  dependencyRoot: string,
  linkTargetResolver: DependencyLinkTargetResolver,
  files: DependencyInspectionFiles,
): Promise<boolean> {
  const queue = [dependencyRoot];
  const linkPaths: string[] = [];
  let cursor = 0;
  let scanned = 0;
  while (cursor < queue.length) {
    const directories = queue.slice(
      cursor,
      cursor + MAX_DIRECTORY_SCAN_CONCURRENCY,
    );
    cursor += directories.length;
    const batches = await Promise.all(
      directories.map(async (directory) => ({
        directory,
        entries: await files.readdir(directory),
      })),
    );
    for (const { directory, entries } of batches) {
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_DEPENDENCY_ENTRIES_SCAN) {
          throw new Error("dependency_environment_tree_scan_limit_exceeded");
        }
        const entryPath = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          linkPaths.push(entryPath);
          continue;
        }
        if (entry.isDirectory()) queue.push(entryPath);
      }
    }
  }
  return linkTargetResolver.containsUnsafeLink(linkPaths);
}

class DependencyLinkTargetResolver {
  readonly #workspaceRealPath: string;
  readonly #files: DependencyInspectionFiles;
  readonly #targetRealPathCache = new Map<string, Promise<string>>();

  constructor(workspaceRealPath: string, files: DependencyInspectionFiles) {
    this.#workspaceRealPath = workspaceRealPath;
    this.#files = files;
  }

  async containsUnsafeLink(linkPaths: readonly string[]): Promise<boolean> {
    let cursor = 0;
    let unsafe = false;
    const workers = Array.from(
      {
        length: Math.min(MAX_LINK_RESOLUTION_CONCURRENCY, linkPaths.length),
      },
      async () => {
        while (!unsafe) {
          const linkPath = linkPaths[cursor++];
          if (!linkPath) return;
          if (await this.#linkIsUnsafe(linkPath)) {
            unsafe = true;
            return;
          }
        }
      },
    );
    await Promise.all(workers);
    return unsafe;
  }

  async #linkIsUnsafe(linkPath: string): Promise<boolean> {
    let rawTarget: string;
    try {
      rawTarget = await this.#files.readlink(linkPath);
    } catch (error) {
      if (isMissingError(error) || isInvalidSymlinkError(error)) return true;
      throw error;
    }

    const lexicalTargetPath = resolve(dirname(linkPath), rawTarget);
    let targetRealPath: string;
    try {
      targetRealPath = await this.#resolveTargetRealPath(lexicalTargetPath);
    } catch (error) {
      if (isMissingError(error)) return true;
      throw error;
    }
    return !pathWithin(this.#workspaceRealPath, targetRealPath);
  }

  #resolveTargetRealPath(lexicalTargetPath: string): Promise<string> {
    const cached = this.#targetRealPathCache.get(lexicalTargetPath);
    if (cached) return cached;
    const resolution = this.#files.realpath(lexicalTargetPath);
    this.#targetRealPathCache.set(lexicalTargetPath, resolution);
    return resolution;
  }
}

export function pathWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isInvalidSymlinkError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EINVAL";
}
