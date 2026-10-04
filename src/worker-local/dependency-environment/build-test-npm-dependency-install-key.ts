import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  DependencyInstallArchitecture, DependencyInstallKeyFailure as Failure, DependencyInstallProfile,
  DependencyLibcFamily, DependencyNpmLockName, DependencyToolRootKind,
  dependencyTestNpmArgv, dependencyTestNpmEnvironment, dependencyTestNpmUmask, dependencyTestNpmConfig,
  DependencyInstallKeyError, validateDependencyTestNpmInputs,
  type DependencyInstallKey, type DependencyTestNpmInstallKeyInput, type DependencyTestNpmToolchain,
} from "../../worker-core/dependency-environment/domain/dependency-install-key";

export { DependencyInstallKeyError, validateDependencyTestNpmInputs };
function fail(reason: Failure): never { throw new DependencyInstallKeyError(reason); }
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(Failure.InvalidInputs);
  return value as Record<string, unknown>;
};
function allowed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(Failure.UnsupportedClosure);
}
function absolute(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("\0") ||
      Buffer.from(value).toString() !== value) fail(Failure.UnsupportedProfile);
}

/** Validates supplied trusted facts; it does not probe tools or discover a
 * hidden environment. Only the fixed, script-free TEST recipe is supported.
 */
export function validateDependencyTestNpmToolchain(input: DependencyTestNpmToolchain): DependencyTestNpmToolchain {
  const value = object(input);
  const keys = ["nodePath", "nodeSha256", "nodeVersion", "nodeAbi", "platform", "arch", "npmCliPath", "npmSha256",
    "npmVersion", "npmRootPath", "npmRootSha256", "libc", "toolRoots"];
  allowed(value, keys);
  if (Object.keys(value).length !== keys.length || value.platform !== "linux" ||
      input.arch !== DependencyInstallArchitecture.X64 ||
      !/^v\d+\.\d+\.\d+$/.test(input.nodeVersion) || !/^[1-9]\d*$/.test(input.nodeAbi) ||
      !/^\d+\.\d+\.\d+$/.test(input.npmVersion) ||
      ![input.nodeSha256, input.npmSha256, input.npmRootSha256].every(sha)) fail(Failure.UnsupportedProfile);
  for (const path of [input.nodePath, input.npmCliPath, input.npmRootPath]) {
    absolute(path);
    if (!/^\/(?:usr|opt)\//.test(path)) fail(Failure.UnsupportedProfile);
  }
  if (input.npmCliPath !== `${input.npmRootPath}/bin/npm-cli.js`) fail(Failure.UnsupportedProfile);
  const libc = object(input.libc);
  allowed(libc, ["family", "version", "path", "sha256"]);
  if (Object.keys(libc).length !== 4 || input.libc.family !== DependencyLibcFamily.Glibc ||
      !/^\d+\.\d+$/.test(input.libc.version) || !sha(input.libc.sha256)) fail(Failure.UnsupportedProfile);
  absolute(input.libc.path);
  if (!Array.isArray(input.toolRoots) || input.toolRoots.length > 32) fail(Failure.UnsupportedProfile);
  const toolRoots = input.toolRoots.map((root) => {
    const record = object(root);
    allowed(record, ["path", "sha256", "kind"]);
    absolute(root.path);
    if (Object.keys(record).length !== 3 || !root.path.startsWith("/usr/lib/") ||
        root.kind !== DependencyToolRootKind.File || !sha(root.sha256)) fail(Failure.UnsupportedProfile);
    return { path: root.path, sha256: root.sha256, kind: root.kind };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (new Set(toolRoots.map((root) => root.path)).size !== toolRoots.length ||
      !toolRoots.some((root) => root.path === input.libc.path && root.sha256 === input.libc.sha256)) fail(Failure.UnsupportedProfile);
  return { nodePath: input.nodePath, nodeSha256: input.nodeSha256, nodeVersion: input.nodeVersion, nodeAbi: input.nodeAbi,
    platform: "linux", arch: input.arch, npmCliPath: input.npmCliPath, npmSha256: input.npmSha256, npmVersion: input.npmVersion,
    npmRootPath: input.npmRootPath, npmRootSha256: input.npmRootSha256,
    libc: { family: input.libc.family, version: input.libc.version, path: input.libc.path, sha256: input.libc.sha256 }, toolRoots };
}

export function buildTestNpmDependencyInstallKey(input: DependencyTestNpmInstallKeyInput & {
  readonly maxInputBytes: number; readonly maxCanonicalBytes: number;
}): DependencyInstallKey {
  allowed(object(input), ["packageBytes", "lockBytes", "lockName", "toolchain", "maxInputBytes", "maxCanonicalBytes"]);
  if (![input.maxInputBytes, input.maxCanonicalBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
      !(input.packageBytes instanceof Uint8Array) || !(input.lockBytes instanceof Uint8Array) ||
      !input.packageBytes.length || !input.lockBytes.length ||
      input.packageBytes.length + input.lockBytes.length > input.maxInputBytes ||
      !Object.values(DependencyNpmLockName).includes(input.lockName)) fail(Failure.InvalidInputs);
  const packageBytes = Buffer.from(input.packageBytes), lockBytes = Buffer.from(input.lockBytes);
  validateDependencyTestNpmInputs(packageBytes, lockBytes);
  const toolchain = validateDependencyTestNpmToolchain(input.toolchain);
  const canonicalBytes = Buffer.from(JSON.stringify({ version: 1, profile: DependencyInstallProfile.TestNpmQualification,
    package: { bytes: packageBytes.length, sha256: digest(packageBytes) },
    lock: { name: input.lockName, bytes: lockBytes.length, sha256: digest(lockBytes) }, toolchain,
    argv: dependencyTestNpmArgv, effectiveConfig: {
      registry: "https://registry.npmjs.org/", ignoreScripts: true, audit: false, fund: false, updateNotifier: false,
      installStrategy: "hoisted", installLinks: true, include: ["dev", "optional", "peer"],
      strictPeerDeps: false, legacyPeerDeps: false, workspaces: false,
      strictSsl: true, userConfig: "fixed_runtime_npmrc_v1", globalConfig: "fixed_runtime_npmrc_v1",
      runtimeConfig: dependencyTestNpmConfig, projectConfig: "absent_isolated_input_root",
    }, umask: dependencyTestNpmUmask, environment: dependencyTestNpmEnvironment,
  }) + "\n");
  if (canonicalBytes.length > input.maxCanonicalBytes) fail(Failure.InvalidInputs);
  return { profile: DependencyInstallProfile.TestNpmQualification, canonicalBytes, installKey: digest(canonicalBytes) };
}
