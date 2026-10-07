import { createHash } from "node:crypto";
import { dependencyTestNpmArgv, validateDependencyTestNpmInputs } from "../worker-core/dependency-environment/domain/dependency-install-key";

export enum HostedDependencyInstallerRecipe { NpmRegistryNoScriptsV1 = "npm_registry_no_scripts_v1" }
export const hostedDependencyInstallerArgv = dependencyTestNpmArgv;
export type HostedDependencyInstallerInputs = {
  readonly packageBytes: Buffer; readonly lockBytes: Buffer; readonly sha256: string;
};
const fail = (): never => { throw new Error("dependency_installer_inputs_unsupported"); };
/** Narrow first profile: registry-only lock v3, no local packages, workspaces,
 * lifecycle scripts or config files. npm still validates package/lock coherence.
 * Isolation of source and protected state is supplied by the closed root recipe.
 */
export function qualifyHostedDependencyInstallerInputs(packageBytes: Buffer, lockBytes: Buffer): HostedDependencyInstallerInputs {
  if (![packageBytes, lockBytes].every(bytes => bytes.length > 0 && bytes.length <= 8 * 1024 * 1024)) fail();
  try { validateDependencyTestNpmInputs(packageBytes, lockBytes); } catch { fail(); }
  // Detach from the caller before capture. The key is length framed.
  const packageCopy = Buffer.from(packageBytes), lockCopy = Buffer.from(lockBytes);
  return { packageBytes: packageCopy, lockBytes: lockCopy, sha256: createHash("sha256")
    .update(String(packageCopy.length) + ":").update(packageCopy).update(String(lockCopy.length) + ":").update(lockCopy).digest("hex") };
}
