import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { inspectKernelPathBacking, inspectKernelPathBackings, type KernelPathBacking } from "../../host-scratch-mount";

export async function admissionWorkspacePathsMatch(
  left: string,
  right: string,
): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  const [leftRealPath, rightRealPath] = await Promise.all([
    optionalRealPathForAdmission(left),
    optionalRealPathForAdmission(right),
  ]);
  return leftRealPath !== undefined &&
    rightRealPath !== undefined &&
    leftRealPath === rightRealPath;
}

export async function optionalRealPathForAdmission(
  path: string,
): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/** Physical identity of an existing or not-yet-created operation resource.
 * Walk only ENOENT ancestors; dangling aliases and other read failures deny.
 */
export async function prospectiveAdmissionResourcePath(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || path.includes("\u0000")) return undefined;
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      const physical = await realpath(current);
      const identity = await lstat(physical);
      if ((identity.isFile() && identity.nlink > 1) ||
        (suffix.length > 0 && !identity.isDirectory())) return undefined;
      return join(physical, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      try {
        await lstat(current);
        // An entry exists but its realpath failed, e.g. a dangling symlink.
        return undefined;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/** Future destinations inherit the existing ancestor's FD-selected backing.
 * Absence only permits an ancestor walk, never proves a writer was released.
 */
export async function prospectiveAdmissionResourceBacking(path: string): Promise<readonly KernelPathBacking[] | undefined> {
  const physical = await prospectiveAdmissionResourcePath(path);
  if (physical === undefined) return undefined;
  let current = physical;
  const suffix: string[] = [];
  for (;;) {
    let before: Awaited<ReturnType<typeof lstat>>;
    try { before = await lstat(current); }
    catch (error) {
      // Only absence at discovery permits the future-destination ancestor walk.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(basename(current)); current = parent;
      continue;
    }
    try {
      if (before.isSymbolicLink() || suffix.length > 0 && !before.isDirectory()) return undefined;
      const backings = suffix.length > 0 ? [inspectKernelPathBacking(current)] : inspectKernelPathBackings(current);
      const after = await lstat(current);
      if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs ||
          await prospectiveAdmissionResourcePath(path) !== physical) return undefined;
      if (suffix.length > 0) {
        try {
          await lstat(join(current, suffix[0]!));
          // A newly created intermediate bind changes future destination backing.
          return undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        }
        const [backing] = backings;
        if (!backing) return undefined;
        return [{ device: backing.device, backingPath: join(backing.backingPath, ...suffix) }];
      }
      return backings;
    } catch {
      // Once observed as existing, disappearance is uncertainty, not a future path.
      return undefined;
    }
  }
}
