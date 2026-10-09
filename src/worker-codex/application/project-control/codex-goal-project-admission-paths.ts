import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
