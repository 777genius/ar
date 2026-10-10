import type { CodexSandboxMode } from "./codex-json-execution-engine";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId, type CodexProviderEgressPolicy } from "./codex-provider-egress-policy";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
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

/** Only immutable public DNS leaves already admitted by the outer fixed root. */
export function hostedCodexResolverReadPaths(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  nativeProjectBoundary = false,
): readonly string[] {
  const hosted = sourceEnv.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job";
  if (!hosted && !nativeProjectBoundary) return [];
  let info;
  try { info = lstatSync("/etc/resolv.conf"); }
  catch { throw new Error("hosted_permission_resolver_unavailable"); }
  if (info.isFile()) return []; // Already covered by the minimal /etc read root.
  if (!info.isSymbolicLink()) throw new Error("hosted_permission_resolver_custody_invalid");
  let target: string;
  try { target = realpathSync("/etc/resolv.conf"); }
  catch { throw new Error("hosted_permission_resolver_unavailable"); }
  if (!["/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve/resolv.conf"].includes(target)) {
    throw new Error("hosted_permission_resolver_path_invalid");
  }
  let leaf, canonical: string;
  try { leaf = lstatSync(target); canonical = realpathSync(target); }
  catch { throw new Error("hosted_permission_resolver_unavailable"); }
  // UID values differ across the provider's user namespace. The outer root
  // already admits these public regular files as immutable read-only snapshots.
  if (!leaf.isFile() || canonical !== target || (leaf.mode & 0o022) !== 0) {
    throw new Error("hosted_permission_resolver_custody_invalid");
  }
  if (!hosted) {
    let resolverUid = 0;
    if (leaf.uid !== 0) {
      const passwd = lstatSync("/etc/passwd");
      if (!passwd.isFile() || passwd.uid !== 0 || (passwd.mode & 0o022) !== 0 || passwd.size > 1024 * 1024) {
        throw new Error("hosted_permission_resolver_custody_invalid");
      }
      const records = readFileSync("/etc/passwd", "utf8").split("\n")
        .filter(line => line.startsWith("systemd-resolve:"));
      const uid = records.length === 1 ? records[0]!.split(":")[2] : undefined;
      if (!uid || !/^\d+$/.test(uid) || !Number.isSafeInteger(Number(uid)) || Number(uid) !== leaf.uid) {
        throw new Error("hosted_permission_resolver_custody_invalid");
      }
      resolverUid = Number(uid);
    }
    for (let current = target; current !== "/"; current = dirname(current)) {
      const entry = lstatSync(current);
      const expectedUid = current === target || current === "/run/systemd/resolve" ? resolverUid : 0;
      if (entry.uid !== expectedUid || (entry.mode & 0o022) !== 0 ||
          (current === target ? !entry.isFile() : !entry.isDirectory())) {
        throw new Error("hosted_permission_resolver_custody_invalid");
      }
    }
  }
  return [target];
}

export function hostedCodexPermissionProfilesToml(
  policy: CodexProviderEgressPolicy,
  executableReadPath?: string,
  privateKeyFilePath?: string,
  dependencyTools?: DependencyToolGuestConfig,
  resolverReadPaths: readonly string[] = [],
): string {
  if (resolverReadPaths.some(path => !["/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve/resolv.conf"].includes(path))) {
    throw new Error("hosted_permission_resolver_path_invalid");
  }
  const resolverRules = [...new Set(resolverReadPaths)].map(path => `${JSON.stringify(path)} = "read"`);
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
  const executableRules = [...new Set([executableReadPath, nodeExecutableReadPath]
    .filter((path): path is string => path !== undefined))]
    .map(path => `${JSON.stringify(path)} = "read"`);
  const privateRoot = "/etc/subscription-runtime/secrets";
  if (privateKeyFilePath && !isAbsolute(privateKeyFilePath)) {
    throw new Error("hosted_permission_private_key_path_invalid");
  }
  const privateFile = privateKeyFilePath ? resolve(privateKeyFilePath) : undefined;
  const privateRules = ["/var/lib/subscription-runtime-full-parent-live", "/run/TEST-full-flow-outbox", privateRoot, ...(privateFile &&
    privateFile !== privateRoot && !privateFile.startsWith(`${privateRoot}/`)
    ? [privateFile] : [])]
    .map(path => `${JSON.stringify(path)} = "deny"`);
  return [
    "# Bound native Codex tools to the admitted workspace and minimal system files.",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    ...executableRules,
    ...resolverRules,
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
    ...resolverRules,
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
