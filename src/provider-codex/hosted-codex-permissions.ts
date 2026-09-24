import type { CodexSandboxMode } from "./codex-json-execution-engine";
import type { CodexProviderEgressPolicy } from "./codex-provider-egress-policy";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

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
): string {
  const domains = policy.domains.map(domain => `${JSON.stringify(domain)} = "allow"`).join(", ");
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
  return [
    "# Bound native Codex tools to the admitted workspace and minimal system files.",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    ...executableRules,
    "",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.filesystem.\":workspace_roots\"]`,
    '"." = "read"',
    "",
    `[permissions.${HostedCodexPermissionProfileId.ReadOnly}.network]`,
    "enabled = true",
    `domains = { ${domains} }`,
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    ...executableRules,
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.filesystem.\":workspace_roots\"]`,
    '"." = "write"',
    '".git" = "read"',
    '".codex" = "read"',
    "",
    `[permissions.${HostedCodexPermissionProfileId.WorkspaceWrite}.network]`,
    "enabled = true",
    `domains = { ${domains} }`,
    "",
  ].join("\n");
}
