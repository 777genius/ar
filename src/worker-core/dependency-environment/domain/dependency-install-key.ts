import { detectSecretLikeContent } from "../../secret-detection";

// v2 requires the qualified numeric UID-drop launcher. Older launch profiles
// cannot share a Ready install key even when npm inputs and toolchain match.
export enum DependencyInstallProfile {
  TestNpmQualification = "test_npm_qualification_v2",
  TestNpmLocalNoLifecycleV1 = "test_npm_local_no_lifecycle_v1",
}
export enum DependencyNpmLockName { PackageLock = "package-lock.json", Shrinkwrap = "npm-shrinkwrap.json" }
export enum DependencyToolRootKind { File = "file", Directory = "directory" }
export enum DependencyLibcFamily { Glibc = "glibc", Musl = "musl" }
export enum DependencyInstallArchitecture { X64 = "x64", Arm64 = "arm64" }

// One versioned, intentionally closed recipe. No effective inherited npm
// configuration, auth, undeclared environment, workspace or lifecycle closure.
export const dependencyTestNpmArgv: readonly string[] = Object.freeze([
  "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--install-strategy=hoisted",
  "--install-links=true", "--include=dev", "--include=optional", "--include=peer",
  "--strict-peer-deps=false", "--legacy-peer-deps=false", "--workspaces=false",
]);
export const dependencyTestNpmEnvironment: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/installer", LANG: "C", LC_ALL: "C",
  npm_config_cache: "/cache", npm_config_userconfig: "/runtime/npmrc", npm_config_globalconfig: "/runtime/global-npmrc",
  npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true",
  npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
});
export const dependencyTestNpmUmask = 0o022;
export const dependencyTestNpmConfig = "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nstrict-ssl=true\n";

// Supplied by trusted composition from actual pinned tools, not discovered by
// the pure key builder. npmRoot digest is the canonical full-tree manifest
// digest; file tool roots and libc use SHA256 of exact bytes. Library closure is
// explicitly bound, never represented by an unobserved broad /usr/lib mount.
export type DependencyTestNpmToolchain = {
  readonly nodePath: string; readonly nodeSha256: string; readonly nodeVersion: string; readonly nodeAbi: string;
  readonly platform: "linux"; readonly arch: DependencyInstallArchitecture;
  readonly npmCliPath: string; readonly npmSha256: string; readonly npmVersion: string;
  readonly npmRootPath: string; readonly npmRootSha256: string;
  readonly libc: { readonly family: DependencyLibcFamily; readonly version: string; readonly path: string; readonly sha256: string };
  readonly toolRoots: readonly { readonly path: string; readonly sha256: string; readonly kind: DependencyToolRootKind.File }[];
};

export type DependencyTestNpmInstallKeyInput = {
  readonly packageBytes: Uint8Array; readonly lockBytes: Uint8Array;
  readonly lockName: DependencyNpmLockName; readonly toolchain: DependencyTestNpmToolchain;
};
export type DependencyInstallKey = { readonly profile: DependencyInstallProfile.TestNpmQualification;
  readonly canonicalBytes: Uint8Array; readonly installKey: string };

export enum DependencyInstallKeyFailure {
  UnsupportedProfile = "unsupported_profile", UnsupportedClosure = "unsupported_closure", InvalidInputs = "invalid_inputs",
}

export class DependencyInstallKeyError extends Error {
  constructor(readonly reason: DependencyInstallKeyFailure) { super(`dependency_install_key:${reason}`); }
}

/** Pure closure qualification shared with the fixed installer. It never emits
 * input contents; unknown config, scripts and non-registry inputs are refused.
 */
export function validateDependencyTestNpmInputs(packageBytes: Uint8Array, lockBytes: Uint8Array): void {
  function fail(reason: DependencyInstallKeyFailure = DependencyInstallKeyFailure.UnsupportedClosure): never {
    throw new DependencyInstallKeyError(reason);
  }
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(DependencyInstallKeyFailure.InvalidInputs);
    return value as Record<string, unknown>;
  };
  const allowed = (value: Record<string, unknown>, keys: readonly string[]): void => {
    if (Object.keys(value).some((key) => !keys.includes(key))) fail();
  };
  const specs = (value: Record<string, unknown>): void => {
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (value[key] === undefined) continue;
      for (const [name, spec] of Object.entries(object(value[key]))) {
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || typeof spec !== "string" ||
            !/^[0-9xX*~^<>=| .+-]+$/.test(spec) || !spec.trim()) fail();
      }
    }
  };
  const parse = (bytes: Uint8Array): Record<string, unknown> => {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return fail(DependencyInstallKeyFailure.InvalidInputs); }
    if (detectSecretLikeContent(text)) fail();
    let decoded: Record<string, unknown>;
    try { decoded = object(JSON.parse(text)); } catch { return fail(DependencyInstallKeyFailure.InvalidInputs); }
    const nameMaps = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin"]);
    const credentialKey = /(?:auth(?:token)?|authorization|cookie|credentials?|api[-_]?key|token|secret|password|passwd|private[-_]?key)$/i;
    const pending: { value: unknown; installRecord: boolean; packagesMap: boolean; namesMap: boolean }[] = [
      { value: decoded, installRecord: true, packagesMap: false, namesMap: false },
    ];
    while (pending.length > 0) {
      const frame = pending.pop()!, value = frame.value;
      if (typeof value === "string") {
        // Scan decoded values too: JSON escapes must not conceal a signature.
        if (detectSecretLikeContent(value)) fail();
        if (value.includes("://")) {
          let url: URL;
          try { url = new URL(value); } catch { continue; }
          if (url.username || url.password || [...url.searchParams.keys()].some((key) => /auth|token|secret|password|key/i.test(key))) fail();
        }
      } else if (Array.isArray(value)) {
        for (const item of value) pending.push({ value: item, installRecord: false, packagesMap: false, namesMap: false });
      } else if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (detectSecretLikeContent(key) || (!frame.namesMap && !frame.packagesMap && credentialKey.test(key))) fail();
          pending.push({ value: item, installRecord: frame.packagesMap,
            packagesMap: frame.installRecord && key === "packages", namesMap: frame.installRecord && nameMaps.has(key) });
        }
      }
    }
    return decoded;
  };
  const pkg = parse(packageBytes);
  allowed(pkg, ["name", "version", "private", "description", "license", "dependencies", "devDependencies", "optionalDependencies",
    "peerDependencies", "peerDependenciesMeta", "engines", "os", "cpu", "libc", "main", "module", "type", "exports", "files",
    "author", "repository", "keywords", "homepage", "bugs", "funding"]);
  const lock = parse(lockBytes);
  allowed(lock, ["name", "version", "lockfileVersion", "requires", "packages"]);
  if (lock.lockfileVersion !== 3) fail();
  const packages = object(lock.packages);
  if (!Object.hasOwn(packages, "")) fail();
  for (const [path, data] of Object.entries(packages)) {
    const entry = object(data);
    allowed(entry, ["name", "version", "resolved", "integrity", "dev", "optional", "devOptional", "peer", "license", "deprecated",
      "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "engines", "os", "cpu", "libc", "bin",
      "funding", "hasInstallScript"]);
    if (entry.hasInstallScript !== undefined && entry.hasInstallScript !== false) fail();
    if (path !== "") {
      if (!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/.test(path) ||
          path.split("/").some((part) => part === "." || part === "..") ||
          typeof entry.resolved !== "string" || typeof entry.integrity !== "string" ||
          !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) fail();
      let url: URL;
      try { url = new URL(entry.resolved); } catch { return fail(); }
      if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash ||
          !url.pathname.endsWith(".tgz")) fail();
    } else if (entry.resolved !== undefined || entry.integrity !== undefined) fail();
    specs(entry);
  }
  specs(pkg);
}
