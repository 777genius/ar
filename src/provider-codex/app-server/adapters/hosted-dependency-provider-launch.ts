import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "@vioxen/subscription-runtime/core";
import { hostedCodexExecutableReadPath } from "../../hosted-codex-permissions";
import { encodeHostedAppServerLaunchFrame } from "./hosted-app-server-launch-frame";
import { assertHostedActivationFence, readHostedOrdinaryProcessOrigin, readHostedActivationBytes,
  decodeHostedActivationBytes, type HostedActivationFence } from "./hosted-process-activation";
import { readHostedDependencyBinding, readHostedDependencyAttempt } from "./hosted-dependency-workspace";
import type { CodexAppServerProcessInvocation } from "./node-app-server-process";

/** Called inside the real private provider reservation fence, before enclosure.
 * The guest never reads host authority. No payload-selected mounts or root dirs.
 */
export function hostedDependencyProviderInvocation(fence: HostedActivationFence, unit: string,
  input: { readonly command: string; readonly args: readonly string[]; readonly cwd: string;
    readonly env: Readonly<Record<string, string>> }): CodexAppServerProcessInvocation | undefined {
  assertHostedActivationFence(fence);
  const { start, reservation } = readHostedOrdinaryProcessOrigin(fence);
  const binding = readHostedDependencyBinding(String(start.jobId));
  if (!binding) return undefined;
  readHostedDependencyAttempt(binding, start, String(reservation.startId));
  if (start.workspacePath !== binding.workspace.canonicalPath || start.jobRootDir !== binding.jobRootDir ||
      !/^subscription-runtime-hosted-[a-f0-9-]{36}\.service$/.test(unit)) invalid();
  const providerId = unit.slice("subscription-runtime-hosted-".length, -".service".length);
  const bytes = readHostedActivationBytes(`ordinary-starts/${providerId}.json`);
  if (!bytes) invalid();
  const provider = decodeHostedActivationBytes(bytes) as Record<string, unknown>;
  if (provider.unit !== unit || provider.creatorId !== start.creatorId || provider.originSha256 !== start.originSha256 ||
      provider.grantSha256 !== binding.grantDigest || provider.workspacePath !== binding.workspace.canonicalPath) invalid();

  const packageRoot = hostedCodexExecutableReadPath({ codexBinaryPath: input.command, sourceEnv: input.env });
  if (!packageRoot) invalid();
  const executable = resolveExecutable(input.command, input.env.PATH);
  const node = trusted(realpathSync(process.execPath));
  const launcher = trusted(fileURLToPath(new URL("./hosted-app-server-launcher.js", import.meta.url)));
  const root = `/var/lib/subscription-runtime-host-policy/dependency-provider-roots/${providerId}`;
  privateDirectory(dirname(root));
  // Each provider reservation gets a fresh finite root. Existing roots are
  // unresolved effects, not reusable descriptions or silently cleaned state.
  mkdirSync(root, { mode: 0o700 });
  const launcherSupport = ["hosted-process-descriptors.js", "hosted-app-server-launch-frame.js"]
    .map(name => trusted(`${dirname(launcher)}/${name}`));
  const readOnly = new Set<string>(["/usr", packageRoot, executable, node, launcher, ...launcherSupport]);
  for (const alias of ["/bin", "/sbin", "/lib", "/lib64"]) {
    let info;
    try { info = lstatSync(alias); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (info.isSymbolicLink()) {
      const target = readlinkSync(alias);
      if (realpathSync(alias).startsWith("/usr/")) { symlinkSync(target, join(root, alias)); continue; }
    }
    readOnly.add(trusted(alias));
  }
  const mounts: string[] = [];
  const mounted = [...readOnly].filter(path => ![...readOnly].some(parent => parent !== path && path.startsWith(parent + "/")));
  for (const source of mounted) {
    trusted(source);
    placeholder(root, source, lstatSync(source).isDirectory());
    mounts.push(`BindReadOnlyPaths=${source}:${source}:norbind`);
  }
  // This is a finite ESM closure, not a bind of the installed runtime tree.
  // Package resolution must not depend on a host package.json outside the root.
  writeFileSync(join(root, dirname(launcher), "package.json"), '{"type":"module"}\n', { flag: "wx", mode: 0o644 });
  // The finite skeleton supplies only parent directories. Host job metadata,
  // encryption keys/state/results are absent, not shared via a broad job bind.
  // ProtectSystem makes these skeleton parents read-only; only leaves write.
  placeholder(root, binding.jobRootDir, true);
  const home = input.env.HOME, codexHome = input.env.CODEX_HOME;
  if (!home || !codexHome || !home.startsWith(binding.jobRootDir + "/home/") ||
      home !== `${dirname(home)}/home` || codexHome !== `${dirname(home)}/codex-home`) invalid();
  for (const writable of [binding.workspace.canonicalPath, home, codexHome]) {
    trustedDirectory(writable);
    placeholder(root, writable, true);
    mounts.push(`BindPaths=${writable}:${writable}:norbind`);
  }
  const git = `${binding.workspace.canonicalPath}/.git`;
  placeholder(root, git, true);
  mounts.push(`BindReadOnlyPaths=${git}:${git}:norbind`);
  for (const name of ["resolv.conf", "hosts", "nsswitch.conf", "services"]) {
    publicSnapshot(root, `/etc/${name}`);
  }
  publicSnapshot(root, "/etc/ssl/certs/ca-certificates.crt", 1024 * 1024);
  placeholder(root, "/proc", true); placeholder(root, "/tmp", true); placeholder(root, "/var/tmp", true);
  syncDirectory(root);
  // The old launcher profiles hide this backing prefix wholesale. This finite
  // root exposes only the exact admitted job; host policy siblings do not exist.
  const properties = ["Slice=subscription-runtime-hosted.slice", "KillMode=control-group", "SendSIGKILL=yes",
    "Delegate=no", "Restart=no", "ProtectControlGroups=yes", "PrivateDevices=yes", "ProtectKernelModules=yes",
    "RestrictSUIDSGID=yes", "AmbientCapabilities=", "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP",
    "ProtectSystem=strict", "NoNewPrivileges=yes", "MemorySwapMax=0", "LimitCORE=0", "TimeoutStopSec=30s",
    "RuntimeMaxSec=8h", "TasksMax=512", "MemoryMax=4G", "CPUQuota=200%", `RootDirectory=${root}`,
    "MountAPIVFS=yes", ...mounts,
    `ReadWritePaths=${binding.workspace.canonicalPath} ${home} ${codexHome}`,
    "TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M /var/tmp:rw,nosuid,nodev,mode=1777,size=64M"];
  return { command: "/usr/bin/systemd-run", systemdUnit: unit,
    args: ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`, "--service-type=exec",
      "--expand-environment=no", `--working-directory=${input.cwd}`, ...properties.map(p => `--property=${p}`), "--",
      "/usr/bin/unshare", "--map-user=65532", "--map-group=65532", "--keep-caps", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL",
      "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
      "/usr/bin/tini", "--", node, launcher],
    stdinBootstrap: encodeHostedAppServerLaunchFrame({ schemaVersion: 1, ...input, command: executable, args: [...input.args] }) };
}
function resolveExecutable(command: string, path: string | undefined): string {
  for (const candidate of command.startsWith("/") ? [command] : (path ?? "").split(":").filter(Boolean).map(p => `${p}/${command}`)) {
    try {
      trustedDirectory(dirname(candidate));
      const target = trusted(realpathSync(candidate));
      const stat = lstatSync(target);
      if (stat.isFile() && (stat.mode & 0o111)) return target;
    } catch { /* An unresolved/untrusted PATH entry cannot expand the root. */ }
  }
  return invalid();
}
function trusted(path: string): string {
  if (!path.startsWith("/") || realpathSync(path) !== path) invalid();
  for (let current = path;; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.uid !== 0 || (info.mode & 0o022) || info.isSymbolicLink()) invalid();
    if (current === "/") break;
  }
  return path;
}
function trustedDirectory(path: string): void { trusted(path); if (!lstatSync(path).isDirectory()) invalid(); }
function privateDirectory(path: string): void {
  const paths: string[] = [];
  for (let p = path;; p = dirname(p)) { paths.unshift(p); if (p === "/") break; }
  for (const p of paths) {
    try { lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; mkdirSync(p, { mode: 0o700 }); }
    trustedDirectory(p);
  }
}
function placeholder(root: string, target: string, directory: boolean): void {
  const path = join(root, target);
  mkdirSync(directory ? path : dirname(path), { recursive: true, mode: 0o755 });
  if (!directory) writeFileSync(path, "", { flag: "wx", mode: 0o644 });
}
function publicSnapshot(root: string, source: string, max = 65536): void {
  const path = realpathSync(source);
  trusted(path);
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > max) invalid();
  placeholder(root, source, false);
  writeFileSync(join(root, source), readFileSync(path));
  const fd = openSync(join(root, source), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function invalid(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }
