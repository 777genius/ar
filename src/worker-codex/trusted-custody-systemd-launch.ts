import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseResearchStartSpec, type ResearchStartSpec } from "./research-launch-contract";
import { researchDescription, researchProviderUnitPattern } from "./research-launch-host";
import { researchInvalid, researchName } from "./research-launch-files";

export enum TrustedCustodyLaunchRole { Outer = "outer", Ordinary = "ordinary" }

/** Custody services retain their independent authority/cgroup contract. This
 * adapter accepts no executable, payload, environment or systemd properties. */
export function trustedCustodySystemdLaunch(role: TrustedCustodyLaunchRole, startId: string, cwd: string):
  { command: string; args: readonly string[] } {
  if (!/^[a-f0-9-]{36}$/.test(startId) || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(cwd)) {
    throw new Error("hosted_custody_kernel_evidence_invalid");
  }
  let bootstrap: readonly string[];
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

/** Closed research-specific service plans. Callers supply a validated private
 * start spec, never payloads, environments or arbitrary systemd properties. */
export function trustedResearchRuntimeLaunch(value: ResearchStartSpec, specSha256: string): { command: string; args: string[] } {
  const spec = parseResearchStartSpec(value), { request } = spec;
  const directory = join("/run/user/subscription-runtime-research-v1", researchName(request.jobId), "starts", spec.startId);
  const properties = ["Slice=system.slice", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no", "Restart=no",
    "RuntimeMaxSec=24h", "TimeoutStopSec=30s", "MemoryMax=6G", "TasksMax=1024", "CPUQuota=300%", "MemorySwapMax=0", "LimitCORE=0",
    `BindPaths=${join(directory, "pins", "job")}:${request.jobRootDir}:norbind`,
    `BindPaths=${join(directory, "pins", "workspace")}:${request.workspacePath}:norbind`,
    "StandardOutput=journal", "StandardError=journal"];
  return { command: "/usr/bin/systemd-run", args: ["--quiet", `--unit=${spec.unit}`,
    `--description=${researchDescription(request.jobId, specSha256)}`, "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...properties.map(p => `--property=${p}`), "--", process.execPath,
    join(spec.runtimeDirectory, "host-integration", "research-runtime-launch.mjs"), request.jobId, spec.startId] };
}
export function trustedResearchProviderLaunch(value: ResearchStartSpec, unit: string): { command: string; args: string[] } {
  const spec = parseResearchStartSpec(value), { request } = spec;
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const pins = join("/run/user/subscription-runtime-research-v1", researchName(request.jobId), "starts", spec.startId, "pins");
  const properties = ["Slice=system.slice", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no", "Restart=no",
    `BindsTo=${spec.unit}`, `PartOf=${spec.unit}`, `After=${spec.unit}`, "CPUQuota=200%", "MemoryHigh=2G", "MemoryMax=4G", "TasksMax=512",
    "RuntimeMaxSec=24h", "TimeoutStopSec=30s", "IOWeight=25", "MemorySwapMax=0", "LimitCORE=0",
    "ProtectControlGroups=yes", "PrivateDevices=yes", "ProtectKernelModules=yes", "RestrictSUIDSGID=yes", "AmbientCapabilities=",
    "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP", "NoNewPrivileges=yes", "ProtectSystem=strict",
    `BindPaths=${join(pins, "job")}:${request.jobRootDir}:norbind`,
    `BindPaths=${join(pins, "workspace")}:${request.workspacePath}:norbind`,
    // Only the authenticated direct helper constructs this plan. The job pin
    // is nonrecursive: carry the parent's actual tmp view (including its scratch
    // child bind) explicitly, at the same logical path. Parent birth/boot/unit
    // are rechecked before submission and after readiness, before any input.
    `BindPaths=/proc/${process.ppid}/root${join(request.jobRootDir, "tmp")}:${join(request.jobRootDir, "tmp")}:norbind`,
    `ReadWritePaths=${request.jobRootDir} ${request.workspacePath}`,
    "TemporaryFileSystem=/tmp:rw,nosuid,nodev,mode=1777,size=256M /var/tmp:rw,nosuid,nodev,mode=1777,size=64M",
    `InaccessiblePaths=-/run/systemd/private -/run/systemd/journal -/dev/log -/run/dbus -/run/user -/var/lib/subscription-runtime-host-policy -/run/user/subscription-runtime-research-v1 -/run/docker.sock -/run/containerd/containerd.sock -/run/podman/podman.sock -/etc/subscription-runtime/secrets -${request.authRootDir}`];
  return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    `--description=subscription-runtime-research-provider:${spec.startId}:${unit}`, "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...properties.map(p => `--property=${p}`), "--", "/usr/bin/unshare", "--map-user=65532", "--map-group=65532", "--keep-caps", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL",
    "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--", process.execPath,
    join(spec.runtimeDirectory, "dist/provider-codex/app-server/adapters/hosted-app-server-launcher.js"), "--research-ready-v1"] };
}
