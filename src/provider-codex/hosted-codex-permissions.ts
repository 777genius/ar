import type { CodexSandboxMode } from "./codex-json-execution-engine";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId, type CodexProviderEgressPolicy } from "./codex-provider-egress-policy";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { dependencyToolCachePath, dependencyToolGuestConfigPath, parseDependencyToolGuestConfig, type DependencyToolGuestConfig } from "../core/dependency-environment/dependency-tool-profile";

export enum HostedCodexPermissionProfileId {
  ReadOnly = "hosted-project-read",
  WorkspaceWrite = "hosted-project-write",
}

export function hostedCodexPermissionProfileId(input: {
  readonly sandboxMode?: CodexSandboxMode;
}): HostedCodexPermissionProfileId {
  switch (input.sandboxMode ?? "read-only") {
    case "read-only": return HostedCodexPermissionProfileId.ReadOnly;
    case "workspace-write": return HostedCodexPermissionProfileId.WorkspaceWrite;
    default: throw new Error("hosted_permission_profile_sandbox_mode_unsupported");
  }
}

export function hostedCodexExecutableReadPath(input: {
  readonly codexBinaryPath: string;
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
}): string | undefined {
  const source = input.sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job"
    ? input.sourceEnv.SUBSCRIPTION_RUNTIME_GLOBAL_SCAN_GUARD_CODEX_SOURCE ?? input.codexBinaryPath
    : input.codexBinaryPath;
  const candidates = isAbsolute(source) ? [source] :
    (input.sourceEnv.PATH ?? process.env.PATH ?? "").split(sep === "\\" ? ";" : ":")
      .filter(Boolean).map(directory => join(directory, source));
  for (const candidate of candidates) {
    let executable: string;
    try { executable = realpathSync(candidate); }
    catch { continue; }
    try {
      const info = statSync(executable);
      if (!info.isFile() || (info.mode & 0o111) === 0) continue;
    } catch { continue; }
    const packageRoot = dirname(dirname(executable));
    if (basename(dirname(executable)) === "bin" &&
        basename(packageRoot) === "codex" &&
        trustedCodexInstallationPath(packageRoot)) {
      try {
        const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: string };
        if (metadata.name === "@openai/codex") return packageRoot;
      } catch { /* A missing or malformed package cannot expand the read root. */ }
    }
    if (trustedCodexInstallationPath(executable)) return executable;
  }
  return undefined;
}

export interface HostedCodexExecutableReadClosure {
  readonly paths: readonly string[];
  readonly companion?: Readonly<{ path: string; sha256: string }>;
}
const companionHashes = new Map<string, { signature: string; sha256: string }>();
const companionSignature = (info: Stats): string =>
  [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.ctimeMs, info.mtimeMs].join(":");

/** Native Codex resolves Code Mode beside itself. Keep npm-wrapper admission
 * unchanged, but never promote a native vendor/bin directory to a read root. */
export function hostedCodexExecutableReadClosure(input: Parameters<typeof hostedCodexExecutableReadPath>[0]):
  HostedCodexExecutableReadClosure | undefined {
  const path = hostedCodexExecutableReadPath(input);
  if (!path) return undefined;
  const nativeLayout = /\/node_modules\/@openai\/codex-(linux-x64|linux-arm64)\/vendor\/([^/]+)\/bin\/codex$/.exec(path);
  if (!nativeLayout) return Object.freeze({ paths: Object.freeze([path]) });
  const target = nativeLayout[1] === "linux-x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
  if (nativeLayout[2] !== target) throw new Error("hosted_codex_native_companion_invalid");
  const companion = join(dirname(path), "codex-code-mode-host"), sha256 = nativeCompanionDigest(companion);
  if (!sha256) throw new Error("hosted_codex_native_companion_invalid");
  return Object.freeze({ paths: Object.freeze([path, companion]), companion: Object.freeze({ path: companion, sha256 }) });
}

function nativeCompanionDigest(path: string): string | undefined {
  const deadline = performance.now() + 30_000;
  let fd: number | undefined;
  try {
    if (realpathSync(path) !== path || !trustedCodexInstallationPath(path)) return undefined;
    const expected = lstatSync(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd), signature = companionSignature(before);
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) || !(before.mode & 0o111) ||
        before.nlink !== 1 || before.size > 512 * 1024 * 1024 || signature !== companionSignature(expected)) return undefined;
    let sha256 = companionHashes.get(path)?.signature === signature ? companionHashes.get(path)!.sha256 : undefined;
    if (sha256 === undefined) {
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let used = 0;
      while (used < before.size) {
        if (performance.now() > deadline) return undefined;
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - used), used);
        if (!count) return undefined;
        hash.update(buffer.subarray(0, count)); used += count;
      }
      if (readSync(fd, buffer, 0, 1, used) !== 0) return undefined;
      sha256 = hash.digest("hex");
    }
    if (companionSignature(fstatSync(fd)) !== signature || companionSignature(lstatSync(path)) !== signature ||
        realpathSync(path) !== path || !trustedCodexInstallationPath(path) || performance.now() > deadline) return undefined;
    if (companionHashes.size >= 32 && !companionHashes.has(path)) companionHashes.clear();
    companionHashes.set(path, { signature, sha256 });
    return sha256;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function trustedCodexInstallationPath(path: string): boolean {
  if (!isAbsolute(path) || path === "/" ||
      !["/opt/", "/usr/local/", "/usr/lib/"].some(prefix => path.startsWith(prefix))) return false;
  for (let current = path; current !== "/"; current = dirname(current)) {
    let info;
    try { info = statSync(current); } catch { return false; }
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
  }
  return true;
}

export function hostedCodexPermissionProfilesToml(
  policy: CodexProviderEgressPolicy,
  executableReadPath?: string | readonly string[],
  privateKeyFilePath?: string,
  dependencyTools?: DependencyToolGuestConfig,
): string {
  const tools = dependencyTools === undefined ? undefined : parseDependencyToolGuestConfig(dependencyTools);
  if (tools && tools.profile.cache.canonicalPath !== dependencyToolCachePath(dirname(tools.workspace.canonicalPath))) {
    throw new Error("hosted_permission_tool_layout_invalid");
  }
  const toolRules = tools ? [
    ...new Set([...tools.profile.readonlyFiles.map(f => f.path), tools.profile.node.path, dependencyToolGuestConfigPath]),
  ].map(path => `${JSON.stringify(path)} = "read"`).concat([
    `${JSON.stringify(tools.profile.cache.canonicalPath)} = "write"`,
    `${JSON.stringify(join(tools.workspace.canonicalPath, "node_modules"))} = "read"`,
  ]) : [];
  const domains = codexProviderEgressPolicy(policy.profileId).domains.map(domain => `${JSON.stringify(domain)} = "allow"`).join(", ");
  let nodeExecutableReadPath: string | undefined;
  try {
    const resolved = realpathSync(process.execPath);
    const info = statSync(resolved);
    if (info.isFile() && (info.mode & 0o111) !== 0 &&
        trustedCodexInstallationPath(resolved)) nodeExecutableReadPath = resolved;
  } catch { /* An unresolved executable cannot expand the read boundary. */ }
  const executablePaths = typeof executableReadPath === "string" ? [executableReadPath] : executableReadPath ?? [];
  const executableRules = [...new Set([...executablePaths, nodeExecutableReadPath]
    .filter((path): path is string => path !== undefined))]
    .map(path => `${JSON.stringify(path)} = "read"`);
  const privateRoot = "/etc/subscription-runtime/secrets";
  if (privateKeyFilePath && !isAbsolute(privateKeyFilePath)) {
    throw new Error("hosted_permission_private_key_path_invalid");
  }
  const privateFile = privateKeyFilePath ? resolve(privateKeyFilePath) : undefined;
  const privateRules = [privateRoot, ...(privateFile &&
    privateFile !== privateRoot && !privateFile.startsWith(`${privateRoot}/`)
    ? [privateFile] : [])]
    .map(path => `${JSON.stringify(path)} = "deny"`);
  return [
    "# Bound native Codex tools to the admitted workspace and minimal system files.",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    ...executableRules,
    ...privateRules,
    ...toolRules,
    "",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem.\":workspace_roots\"]`,
    '"." = "read"',
    ...(tools ? ['"node_modules" = "read"'] : []),
    "",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.network]`,
    "enabled = true",
    ...(policy.profileId === CodexProviderEgressProfileId.FullInternetV1 ? [] : [`domains = { ${domains} }`]),
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    ...executableRules,
    ...privateRules,
    ...toolRules,
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.filesystem.\":workspace_roots\"]`,
    '"." = "write"',
    '".git" = "read"',
    '".codex" = "read"',
    ...(tools ? ['"node_modules" = "read"'] : []),
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.network]`,
    "enabled = true",
    ...(policy.profileId === CodexProviderEgressProfileId.FullInternetV1 ? [] : [`domains = { ${domains} }`]),
    "",
  ].join("\n");
}
