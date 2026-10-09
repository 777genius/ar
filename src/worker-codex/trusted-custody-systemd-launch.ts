import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseResearchStartSpec, researchProviderSetupTimeoutMs, researchProviderSetupAllowanceMs, type ResearchStartSpec } from "./research-launch-contract";
import { researchDescription, researchProviderUnitPattern } from "./research-launch-host";
import { researchInvalid, researchName, researchPath } from "./research-launch-files";
import { assertResearchProviderRoot, researchProviderProtectedPaths, ResearchRootMountAccess, type ResearchProviderRootPlan } from "./research-provider-root";
import { hostedDependencyInstallerProperties, hostedDependencyInstallerBootstrapCommand, type HostedDependencyInstallerPlan } from "./hosted-dependency-installer-recipe";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { hostedFdSystemdProperties } from "../provider-codex/app-server/adapters/hosted-fd-prelude";

export enum TrustedCustodyLaunchRole { Outer = "outer", Ordinary = "ordinary", Installer = "installer" }

/** Custody services retain their independent authority/cgroup contract. This
 * adapter accepts no executable, payload, environment or systemd properties. */
export function trustedCustodySystemdLaunch(role: TrustedCustodyLaunchRole, startId: string, cwd: string, installer?: HostedDependencyInstallerPlan):
  { command: string; args: readonly string[] } {
  if (!/^[a-f0-9-]{36}$/.test(startId) || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(cwd)) {
    throw new Error("hosted_custody_kernel_evidence_invalid");
  }
  let bootstrap: readonly string[];
  if (role === TrustedCustodyLaunchRole.Installer) {
    if (!installer || installer.startId !== startId || cwd !== installer.stagingDirectory) throw new Error("hosted_custody_kernel_evidence_invalid");
    const properties = hostedDependencyInstallerProperties(installer);
    return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", `--unit=subscription-runtime-installer-${startId}.service`,
      "--service-type=exec", "--expand-environment=no", "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
      "--property=SendSIGKILL=yes", "--property=Delegate=no", "--working-directory=/", ...properties.map(p => "--property=" + p),
      "--", ...hostedDependencyInstallerBootstrapCommand(installer)] };
  }
  if (installer) throw new Error("hosted_custody_kernel_evidence_invalid");
  switch (role) {
    case TrustedCustodyLaunchRole.Outer:
      bootstrap = [fileURLToPath(new URL("./hosted-readonly-runtime-bootstrap.js", import.meta.url))];
      break;
    case TrustedCustodyLaunchRole.Ordinary:
      bootstrap = [fileURLToPath(new URL("./hosted-readonly-host-launch-cli.js", import.meta.url)), "ordinary-bootstrap"];
      break;
    default: throw new Error("hosted_custody_kernel_evidence_invalid");
  }
  return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", "--collect",
    `--unit=subscription-runtime-${role}-${startId}.service`, "--service-type=exec",
    "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes", "--property=Delegate=no", `--working-directory=${cwd}`,
    "--", process.execPath, ...bootstrap] };
}

/** Effect composition reads the real installed profile. The pure legacy recipe
 * remains usable without host IO; no caller flag selects FD qualification. */
export function hostedFdCustodySystemdLaunch(role: TrustedCustodyLaunchRole, startId: string, cwd: string, installer?: HostedDependencyInstallerPlan):
  { command: string; args: readonly string[] } {
  const launch = trustedCustodySystemdLaunch(role, startId, cwd, installer);
  if (!readHostedFdProfile()) return launch;
  const at = launch.args.indexOf("--");
  if (at < 0) throw new Error("hosted_custody_kernel_evidence_invalid");
  return { command: launch.command, args: [...launch.args.slice(0, at),
    ...hostedFdSystemdProperties.map(p => "--property=" + p), ...launch.args.slice(at),
    ...(role === TrustedCustodyLaunchRole.Installer ? ["--fd-ready-v1"] : [])] };
}

/** Closed research-specific service plans. Callers supply a validated private
 * start spec, never payloads, environments or arbitrary systemd properties. */
export function trustedResearchRuntimeLaunch(value: ResearchStartSpec, specSha256: string): { command: string; args: string[] } {
  const spec = parseResearchStartSpec(value), { request } = spec;
  const directory = join("/run/user/subscription-runtime-research-v1", researchName(request.jobId), "starts", spec.startId);
  // Captured roots consume explicit sources, never later Host mount propagation.
  // Recursive private propagation belongs to this service and ends with it.
  const properties = ["Slice=system.slice", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no", "Restart=no", "MountFlags=private",
    `TimeoutStartSec=${researchProviderSetupTimeoutMs / 1000}s`,
    "RuntimeMaxSec=24h", "TimeoutStopSec=30s", "MemoryMax=6G", "TasksMax=1024", "CPUQuota=300%", "MemorySwapMax=0", "LimitCORE=0",
    `BindPaths=${join(directory, "pins", "job")}:${request.jobRootDir}:norbind`,
    `BindPaths=${join(directory, "pins", "workspace")}:${request.workspacePath}:norbind`,
    ...(spec.registeredHandoff ? [`BindPaths=${join(directory, "pins", "durable-handoff")}:${spec.registeredHandoff.durableDirectory.path}:norbind`] : []),
    "StandardOutput=journal", "StandardError=journal"];
  return { command: "/usr/bin/systemd-run", args: ["--quiet", `--unit=${spec.unit}`,
    `--description=${researchDescription(request.jobId, specSha256)}`, "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...properties.map(p => `--property=${p}`), "--", process.execPath,
    join(spec.runtimeDirectory, "host-integration", "research-runtime-launch.mjs"), request.jobId, spec.startId] };
}
export function trustedResearchProviderLaunch(value: ResearchStartSpec, unit: string, selectedCodexHome: string,
  rootPlan: ResearchProviderRootPlan): { command: string; args: string[] } {
  const spec = parseResearchStartSpec(value), { request } = spec;
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const home = researchPath(selectedCodexHome);
  if (!rootPlan) researchInvalid();
  assertResearchProviderRoot(rootPlan, spec, unit, home);
  const properties = ["Slice=system.slice", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no", "Restart=no", "MountFlags=private",
    `BindsTo=${spec.unit}`, `PartOf=${spec.unit}`, `After=${spec.unit}`, "CPUQuota=200%", "MemoryHigh=2G", "MemoryMax=4G", "TasksMax=512",
    `TimeoutStartSec=${researchProviderSetupAllowanceMs(request) / 1000}s`,
    "RuntimeMaxSec=24h", "TimeoutStopSec=30s", "IOWeight=25", "MemorySwapMax=0", "LimitCORE=0",
    "ProtectControlGroups=yes", "PrivateDevices=yes", "ProtectKernelModules=yes", "RestrictSUIDSGID=yes", "AmbientCapabilities=",
    "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP", "NoNewPrivileges=yes", "ProtectSystem=strict",
    `RootDirectory=${rootPlan.fixedRootDirectory}`, "MountAPIVFS=yes",
    ...rootPlan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadOnly)
      .map(({ source, target }) => `BindReadOnlyPaths=${researchPath(source)}:${researchPath(target)}:norbind`),
    ...rootPlan.bindings.filter(bind => bind.access === ResearchRootMountAccess.ReadWrite)
      .map(({ source, target }) => `BindPaths=${researchPath(source)}:${researchPath(target)}:norbind`),
    `ReadWritePaths=${request.jobRootDir} ${request.workspacePath}`,
    "TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M /var/tmp:rw,nosuid,nodev,mode=1777,size=64M",
    `InaccessiblePaths=${researchProviderProtectedPaths(request.authRootDir).map(path => "-" + path).join(" ")}`];
  return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    `--description=subscription-runtime-research-provider:${spec.startId}:${unit}`, "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...properties.map(p => `--property=${p}`), "--", "/usr/bin/unshare", "--map-user=65532", "--map-group=65532", "--keep-caps", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL",
    "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--", process.execPath,
    join(spec.runtimeDirectory, "dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js"), "--research-ready-v1"] };
}
