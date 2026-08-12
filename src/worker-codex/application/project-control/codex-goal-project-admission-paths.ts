import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

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
