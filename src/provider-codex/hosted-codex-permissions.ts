import type { CodexSandboxMode } from "./codex-json-execution-engine";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId, type CodexProviderEgressPolicy } from "./codex-provider-egress-policy";
import { readFileSync, realpathSync, statSync } from "node:fs";
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

export function hostedCodexPermissionProfilesToml(
  policy: CodexProviderEgressPolicy,
  executableReadPath?: string,
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
