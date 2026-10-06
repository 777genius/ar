import { createHash } from "node:crypto";
import { DependencyNpmLockName, dependencyTestNpmArgv, validateDependencyTestNpmInputs, type DependencyTestNpmToolchain } from "../worker-core/dependency-environment/domain/dependency-install-key";
import { dependencyLocalNpmArgv, qualifyDependencyNpmLocalClosure } from "../worker-core/dependency-environment/domain/dependency-local-closure";
import { buildTestNpmLocalDependencyInstallKey, encodeDependencyLocalInputCommitment, validateDependencyTestNpmToolchain } from "../worker-local/dependency-environment/build-test-npm-dependency-install-key";
import { revalidateNpmLocalClosure, type QualifiedNpmLocalInputs } from "../worker-local/dependency-environment/capture-npm-local-closure";
import { NpmInputCaptureStatus } from "../worker-local/dependency-environment/capture-npm-install-inputs";
import { describeHostedDependencyLocalStage, type HostedDependencyLocalStage, type HostedDependencyLocalStageFile } from "./hosted-dependency-installer-local-stage";

export enum HostedDependencyInstallerRecipe { NpmRegistryNoScriptsV1 = "npm_registry_no_scripts_v1", NpmLocalNoLifecycleV1 = "npm_local_no_lifecycle_v1" }
export const hostedDependencyInstallerArgv = dependencyTestNpmArgv;
export type HostedDependencyInstallerInputs = {
  readonly lockName: DependencyNpmLockName; readonly packageBytes: Buffer; readonly lockBytes: Buffer; readonly sha256: string;
};
export type HostedDependencyLocalInstallerInputs = HostedDependencyInstallerInputs & {
  readonly recipe: HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1; readonly capture: QualifiedNpmLocalInputs;
  readonly installKey: string; readonly installArgv: readonly string[]; readonly stage: HostedDependencyLocalStage;
  readonly files: readonly HostedDependencyLocalStageFile[];
};
export type HostedDependencyInstallerQualifiedInputs = HostedDependencyInstallerInputs | HostedDependencyLocalInstallerInputs;
export function isHostedDependencyLocalInstallerInputs(inputs: HostedDependencyInstallerQualifiedInputs): inputs is HostedDependencyLocalInstallerInputs {
  return "recipe" in inputs && inputs.recipe === HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1;
}
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

/** Factual local qualification only. The real installer captures its own source
 * and calls this under genuine admission; no supplied installKey/digest can
 * select a start. Revalidation checks the original pins/bytes/membership. */
export function qualifyHostedDependencyLocalInstallerInputs(captured: QualifiedNpmLocalInputs,
  profile: DependencyTestNpmToolchain): HostedDependencyLocalInstallerInputs {
  const capture = structuredClone(captured);
  if (capture.status !== NpmInputCaptureStatus.Qualified ||
      revalidateNpmLocalClosure({ capture, maxDurationMs: 10000 }).status !== NpmInputCaptureStatus.Qualified) fail();
  const toolchain = projectHostedDependencySelectionToolchain(profile);
  if (capture.selectionToolchain && JSON.stringify(validateDependencyTestNpmToolchain(capture.selectionToolchain)) !== JSON.stringify(toolchain)) fail();
  const closure = qualifyDependencyNpmLocalClosure({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes,
    packages: capture.closure.packages, ...(capture.selectionToolchain ? { selectionToolchain: toolchain } : {}) });
  const { commitment, sha256 } = encodeDependencyLocalInputCommitment({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes,
    lockName: capture.lockName, closure, ...(capture.selectionToolchain ? { selectionToolchain: toolchain } : {}) });
  if (JSON.stringify(closure) !== JSON.stringify(capture.closure) || capture.closureDigest !== sha256) fail();
  const key = buildTestNpmLocalDependencyInstallKey({ packageBytes: capture.packageBytes, lockBytes: capture.lockBytes,
    lockName: capture.lockName, closure, toolchain, maxInputBytes: 64 * 1024 * 1024, maxCanonicalBytes: 8 * 1024 * 1024 });
  const files: HostedDependencyLocalStageFile[] = [{ path: "package.json", mode: 0o644, bytes: capture.packageBytes },
    { path: capture.lockName, mode: 0o644, bytes: capture.lockBytes }];
  for (const local of closure.packages) {
    files.push({ path: local.path + "/package.json", mode: 0o644, bytes: local.packageBytes });
    for (const file of local.files) files.push({ path: local.path + "/" + file.path, mode: file.mode, bytes: file.bytes });
  }
  return { recipe: HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1, lockName: capture.lockName,
    packageBytes: Buffer.from(capture.packageBytes), lockBytes: Buffer.from(capture.lockBytes), sha256, capture,
    installKey: key.installKey, installArgv: dependencyLocalNpmArgv(closure.layout), files, stage: describeHostedDependencyLocalStage(commitment, files) };
}

/** Finite logical projection; caller independently authenticates the protected profile. */
export function projectHostedDependencySelectionToolchain(profile: DependencyTestNpmToolchain): DependencyTestNpmToolchain {
  return validateDependencyTestNpmToolchain({ nodePath: profile.nodePath, nodeSha256: profile.nodeSha256, nodeVersion: profile.nodeVersion,
    nodeAbi: profile.nodeAbi, platform: profile.platform, arch: profile.arch, npmCliPath: profile.npmCliPath, npmSha256: profile.npmSha256,
    npmVersion: profile.npmVersion, npmRootPath: profile.npmRootPath, npmRootSha256: profile.npmRootSha256, libc: profile.libc, toolRoots: profile.toolRoots });
}
