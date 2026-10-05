import { createHash } from "node:crypto";
import { DependencyNpmLockName, dependencyTestNpmArgv, validateDependencyTestNpmInputs } from "../worker-core/dependency-environment/domain/dependency-install-key";

export enum HostedDependencyInstallerRecipe { NpmRegistryNoScriptsV1 = "npm_registry_no_scripts_v1" }
export const hostedDependencyInstallerArgv = dependencyTestNpmArgv;
export type HostedDependencyInstallerInputs = {
  readonly lockName: DependencyNpmLockName; readonly packageBytes: Buffer; readonly lockBytes: Buffer; readonly sha256: string;
};
function fail(): never { throw new Error("dependency_installer_inputs_unsupported"); }
/** Narrow first profile: registry-only lock v3, no local packages, workspaces,
 * lifecycle scripts or config files. npm still validates package/lock coherence.
 * Isolation of source and protected state is supplied by the closed root recipe.
 */
export function qualifyHostedDependencyInstallerInputs(packageBytes: Buffer, lockBytes: Buffer,
  lockName: DependencyNpmLockName = DependencyNpmLockName.PackageLock): HostedDependencyInstallerInputs {
  if (!Object.values(DependencyNpmLockName).includes(lockName)) fail();
  if (![packageBytes, lockBytes].every(bytes => bytes.length > 0 && bytes.length <= 8 * 1024 * 1024)) fail();
  try { validateDependencyTestNpmInputs(packageBytes, lockBytes); } catch { fail(); }
  // Detach from the caller before capture. The key is length framed.
  const packageCopy = Buffer.from(packageBytes), lockCopy = Buffer.from(lockBytes);
  return { lockName, packageBytes: packageCopy, lockBytes: lockCopy, sha256: createHash("sha256")
    .update(String(Buffer.byteLength(lockName)) + ":").update(lockName)
    .update(String(packageCopy.length) + ":").update(packageCopy).update(String(lockCopy.length) + ":").update(lockCopy).digest("hex") };
}
