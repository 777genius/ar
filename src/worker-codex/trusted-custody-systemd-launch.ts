import { HostedMimoProfile } from "../provider-codex/hosted-mimo-profile";
import { readOriginalUsableGuestFunding } from "./hosted-ordinary-usable-guest-funding";
import { decodeHostedInventoryBytes, parseHostedInventoryV5, type HostedInventorySupervisor } from "../core/host-infrastructure/host-inventory";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseResearchStartSpec, researchProviderSetupTimeoutMs, researchProviderSetupAllowanceMs, type ResearchStartSpec } from "./research-launch-contract";
import { researchDescription, researchProviderUnitPattern } from "./research-launch-host";
import { researchInvalid, researchName, researchPath, researchHash, researchRecord, researchCustody } from "./research-launch-files";
import type { ResearchOperatorBinding } from "./research-operator-binding";
import { researchProviderRootSeal, type ResearchProviderRootPlan } from "./research-provider-root";
import { hostedDependencyInstallerProperties, hostedDependencyInstallerBootstrapCommand, type HostedDependencyInstallerPlan } from "./hosted-dependency-installer-recipe";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { hostedFdSystemdProperties } from "../provider-codex/app-server/adapters/hosted-fd-prelude";

import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";

export const trustedCustodySystemdRunExecutable = "/usr/bin/systemd-run";
enum OrdinaryArgumentExpansion { Disabled = "disabled", Stock252Literal = "stock_252_literal" }
/** Fixed, help-only capability reads create no manager job. An unsupported
 * flag never permits expansion of caller DATA: stock 252 is accepted only
 * for the closed original recipes' dollar-free command operands. */
function ordinaryArgumentExpansion(): OrdinaryArgumentExpansion {
  const inspect = (args: readonly string[]) => spawnSync(trustedCustodySystemdRunExecutable, [...args], {
    encoding: "utf8", timeout: 2000, maxBuffer: 32 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" },
  });
  const help = inspect(["--expand-environment=no", "--help"]);
  if (!help.error && help.signal === null && help.status === 0 && help.stderr === "" && help.stdout.includes("--expand-environment="))
    return OrdinaryArgumentExpansion.Disabled;
  if (help.error || help.signal !== null || help.status !== 1 || help.stdout !== "" ||
      help.stderr !== "/usr/bin/systemd-run: unrecognized option '--expand-environment=no'\n")
    throw new Error("ordinary_launcher_qualification_held");
  const version = inspect(["--version"]);
  if (version.error || version.signal !== null || version.status !== 0 || version.stderr !== "" ||
      !/^systemd 252(?: \([A-Za-z0-9.+~:_-]{1,80}\))?$/.test(version.stdout.split("\n")[0] ?? ""))
    throw new Error("ordinary_launcher_qualification_held");
  return OrdinaryArgumentExpansion.Stock252Literal;
}
function ordinaryLiteralArgumentOptions(operands: readonly string[]): readonly string[] {
  if (ordinaryArgumentExpansion() === OrdinaryArgumentExpansion.Disabled) return ["--expand-environment=no"];
  if (!operands.length || operands.some(value => typeof value !== "string" || value.length < 1 || value.length > 4096 || /[$\0\r\n]/.test(value)))
    throw new Error("ordinary_launcher_qualification_held");
  return [];
}

const ordinaryRecipeId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function assertOrdinaryRecipeId(id: string): void {
  if (!ordinaryRecipeId.test(id)) throw new Error("hosted_ordinary_installation_held");
}

/** Fixed DATA plans only. The original callers retain funding, profile and
 * physical input admission, clocks, synchronous spawn and actual child custody. */
export function trustedOrdinaryInstallationSupervisorLaunch(operationId: string, workMs: number, cleanupMs: number):
  { command: string; args: string[] } {
  assertOrdinaryRecipeId(operationId);
  const unit = `subscription-runtime-installation-${operationId}.service`;
  const managerProperties = ordinaryInstallationManagerProperties(workMs, cleanupMs);
  const operands = [process.execPath, fileURLToPath(new URL("./hosted-ordinary-installation-bootstrap.js", import.meta.url)), "--operation", operationId];
  return { command: trustedCustodySystemdRunExecutable, args: ["--quiet", "--wait", "--pipe", "--unit=" + unit, "--service-type=exec", ...ordinaryLiteralArgumentOptions(operands),
    "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group", "--property=Delegate=no",
    "--property=SendSIGKILL=yes", ...managerProperties.map(p => "--property=" + p), "--working-directory=/",
    "--", ...operands] };
}
function ordinaryQualificationArgs(unit: string, workMs: number, stopMs: number, operands: readonly string[]): string[] {
  if (!Number.isSafeInteger(workMs) || workMs < 1 || !Number.isSafeInteger(stopMs) || stopMs < 1 || stopMs > 30_000) {
    throw new Error("ordinary_launcher_qualification_held");
  }
  return ["--quiet", "--wait", "--pipe", "--unit=" + unit, "--service-type=exec", ...ordinaryLiteralArgumentOptions(operands),
    "--property=Slice=subscription-runtime-hosted.slice", "--property=Restart=no", "--property=KillMode=control-group",
    "--property=Delegate=no", "--property=SendSIGKILL=yes", "--property=RuntimeMaxSec=" + workMs / 1000,
    "--property=TimeoutStopSec=" + stopMs / 1000, "--working-directory=/", "--"];
}
export function trustedOrdinaryQualificationOuterLaunch(testId: string, rootfsPath: string, workMs: number, stopMs: number):
  { command: string; args: string[] } {
  assertOrdinaryRecipeId(testId);
  if (!/^\/srv\/workers\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(rootfsPath) || rootfsPath.length > 4096 ||
      rootfsPath.split("/").some(part => part === "." || part === "..")) throw new Error("ordinary_launcher_qualification_held");
  const operands = ["/usr/bin/systemd-nspawn", "--directory=" + rootfsPath, "--machine=ordinary-test-" + testId,
    "--boot", "--private-users=no", "--private-network", "--register=no", "--settings=no", "--link-journal=no"];
  return { command: trustedCustodySystemdRunExecutable, args: [...ordinaryQualificationArgs(`subscription-runtime-ordinary-${testId}.service`, workMs, stopMs, operands), ...operands] };
}
export function trustedOrdinaryQualificationWorkerLaunch(workerId: string, workMs: number, stopMs: number):
  { command: string; args: string[] } {
  assertOrdinaryRecipeId(workerId);
  const operands = [process.execPath, fileURLToPath(new URL("./hosted-ordinary-installation-qualification-guest.js", import.meta.url)), "worker"];
  return { command: trustedCustodySystemdRunExecutable, args: [...ordinaryQualificationArgs(`subscription-runtime-hosted-${workerId}.service`, workMs, stopMs, operands), ...operands] };
}

export function trustedOrdinaryUsableGuestWorkerLaunch(workerId: string, workMs: number, stopMs: number): { command: string; args: string[] } {
  assertOrdinaryRecipeId(workerId);
  const operands = [process.execPath, fileURLToPath(new URL("./hosted-ordinary-installation-usable-guest.js", import.meta.url)), "worker"];
  return { command: trustedCustodySystemdRunExecutable, args: [...ordinaryQualificationArgs(`subscription-runtime-hosted-${workerId}.service`, workMs, stopMs, operands), ...operands] };
}

/** Only the fixed original broker owner supplies its retained namespace FDs.
 * Descriptor numbers are part of this private recipe, never caller DATA. */
export function trustedOrdinaryGuestSeedReaderLaunch(node: string, runtimeDirectory: string): { command: string; args: string[] } {
  if (node !== process.execPath || !/^\/srv\/workers\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(runtimeDirectory) ||
      runtimeDirectory.split("/").some(part => part === "." || part === "..")) throw new Error("ordinary_launcher_qualification_held");
  return { command: "/usr/bin/nsenter", args: ["--mount=/proc/self/fd/5", "--pid=/proc/self/fd/6", "--net=/proc/self/fd/7",
    "--root=/proc/self/fd/4", "--wdns=/", "--", node,
    runtimeDirectory + "/dist/worker-codex/hosted-ordinary-installation-seed-reader.js", "--capture-original-seed"] };
}
export function trustedOrdinaryGuestNetworkLaunch(): { command: string; args: string[] } {
  return { command: "/usr/bin/slirp4netns", args: ["--configure", "--mtu=65520", "--disable-host-loopback", "--netns-type=path",
    "--ready-fd=3", "--exit-fd=4", "/proc/self/fd/5", "tap0"] };
}

export enum TrustedCustodyLaunchRole { Outer = "outer", Ordinary = "ordinary", Installer = "installer", Remover = "remover" }

/** Protected original clocks only limit an existing operation. These bytes do
 * not import the issuer's private funding/qualification/Store authority. */
export function ordinaryInstallationRemainingMs(supervisor: HostedInventorySupervisor, cleanup = false): number {
  function held(): never { throw new Error("hosted_ordinary_installation_held"); }
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(supervisor.operationId)) held();
  const root = "/var/lib/subscription-runtime-host-policy", guestEntry = "/dist/worker-codex/hosted-ordinary-installation-qualification-guest.js";
  const guest = supervisor.bootstrap.path.endsWith(guestEntry);
  const usableGuest = supervisor.bootstrap.path.endsWith("/dist/worker-codex/hosted-ordinary-installation-usable-guest.js");
  const bytes = usableGuest ? readOriginalUsableGuestFunding(supervisor) : readHostedPrivateBytes(guest ? root + "/ordinary-qualification/funded-operation.json" :
    `${root}/ordinary-installations/${supervisor.operationId}/operation.json`, 65536);
  if (!bytes || !guest && !usableGuest && !readHostedPrivateBytes(`${root}/ordinary-installations/${supervisor.operationId}.json`, 65536)?.equals(bytes)) held();
  const packet = JSON.parse(bytes.toString("utf8")) as { schemaVersion: number; operationId: string; hostId: string; bootId: string;
    issuedEpochMs: number; issuedMonotonicNs: string; workEndEpochMs: number; cleanupEndEpochMs: number; runtimeDirectory: string;
    node: { path: string; sha256: string }; bootstrap: { path: string; sha256: string };
    preparedFixture: { guestMachineId: string; guestHostname: string; guestEntrySha256: string; inputSha256: string } };
  if (packet.schemaVersion !== 2 || packet.operationId !== supervisor.operationId ||
      packet.workEndEpochMs !== supervisor.workEndEpochMs || packet.cleanupEndEpochMs !== supervisor.cleanupEndEpochMs ||
      !Number.isSafeInteger(packet.issuedEpochMs) || !Number.isSafeInteger(packet.workEndEpochMs) || !Number.isSafeInteger(packet.cleanupEndEpochMs) ||
      packet.issuedEpochMs >= packet.workEndEpochMs || packet.workEndEpochMs >= packet.cleanupEndEpochMs ||
      typeof packet.issuedMonotonicNs !== "string" || !/^[0-9]{1,30}$/.test(packet.issuedMonotonicNs) ||
      packet.node?.path !== supervisor.executable.path || packet.node.sha256 !== supervisor.executable.sha256) held();
  if (guest) {
    const input = readHostedPrivateBytes(root + "/ordinary-qualification/input.json", 65536), fixture = packet.preparedFixture;
    if (supervisor.bootstrap.path !== packet.runtimeDirectory + guestEntry || !fixture || supervisor.bootstrap.sha256 !== fixture.guestEntrySha256 ||
        readFileSync("/etc/machine-id", "utf8").trim() !== fixture.guestMachineId || readFileSync("/etc/hostname", "utf8").trim() !== fixture.guestHostname ||
        !input || createHash("sha256").update(input).digest("hex") !== fixture.inputSha256) held();
    const projection = JSON.parse(input.toString("utf8")) as { operation?: { operationId: string; workEndEpochMs: number; cleanupEndEpochMs: number } };
    if (projection.operation?.operationId !== packet.operationId || projection.operation.workEndEpochMs !== packet.workEndEpochMs || projection.operation.cleanupEndEpochMs !== packet.cleanupEndEpochMs) held();
  } else if (!usableGuest && (supervisor.bootstrap.path !== packet.runtimeDirectory + "/dist/worker-codex/hosted-ordinary-installation-bootstrap.js" ||
      packet.bootstrap?.path !== supervisor.bootstrap.path || packet.bootstrap.sha256 !== supervisor.bootstrap.sha256 ||
      readFileSync("/etc/machine-id", "utf8").trim() !== packet.hostId || readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== packet.bootId)) held();
  const now = Date.now(), elapsed = Number((process.hrtime.bigint() - BigInt(packet.issuedMonotonicNs)) / 1_000_000n);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0 || now < packet.issuedEpochMs || now < packet.issuedEpochMs + elapsed - 1000) held();
  const end = cleanup ? packet.cleanupEndEpochMs : packet.workEndEpochMs, ms = Math.min(end - now, end - packet.issuedEpochMs - elapsed);
  if (ms < 1) held(); return Math.floor(ms);
}
/** Relative manager fallback reserves its complete start/job and stop allowance.
 * The original owner's absolute work timer remains decisive, not closure proof. */
export function ordinaryInstallationManagerProperties(workMs: number, cleanupMs: number): readonly string[] {
  if (!Number.isSafeInteger(workMs) || !Number.isSafeInteger(cleanupMs) || workMs < 2 || cleanupMs <= workMs) throw new Error("hosted_ordinary_installation_held");
  const setupMs = Math.min(300_000, Math.floor(workMs / 2)), stopMs = Math.min(30_000, cleanupMs - workMs);
  return [`JobTimeoutSec=${setupMs / 1000}`, `TimeoutStartSec=${setupMs / 1000}`, `RuntimeMaxSec=${(workMs - setupMs) / 1000}`,
    `TimeoutStopSec=${stopMs / 1000}`, "Restart=no"];
}

/** Custody services retain their independent authority/cgroup contract. This
 * adapter accepts no executable, payload, environment or systemd properties. */
export function trustedCustodySystemdLaunch(role: TrustedCustodyLaunchRole, startId: string, cwd: string, installer?: HostedDependencyInstallerPlan):
  { command: string; args: readonly string[] } {
  if (!/^[a-f0-9-]{36}$/.test(startId) || !(role === TrustedCustodyLaunchRole.Remover && cwd === "/") && !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(cwd)) {
    throw new Error("hosted_custody_kernel_evidence_invalid");
  }
  if (role === TrustedCustodyLaunchRole.Remover) {
    if (installer || cwd !== "/" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(startId)) throw new Error("hosted_custody_kernel_evidence_invalid");
    const bootstrap = fileURLToPath(new URL("./hosted-dependency-remover-bootstrap.js", import.meta.url)), profile = readHostedFdProfile();
    if (!profile || profile.node.path !== process.execPath || !profile.bootstraps.some(pin => pin.path === bootstrap)) throw new Error("dependency_remover_profile_unsupported");
    return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", `--unit=subscription-runtime-dependency-remove-${startId}.service`,
      "--service-type=exec", "--expand-environment=no", "--property=Slice=subscription-runtime-hosted.slice", "--property=KillMode=control-group",
      "--property=SendSIGKILL=yes", "--property=Delegate=no", "--property=Restart=no", "--working-directory=/", "--", profile.node.path, bootstrap, startId] };
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
  const bytes = readHostedActivationBytes("readonly-inventory.json"), inventory = bytes ? decodeHostedInventoryBytes(bytes) as Record<string, unknown> : undefined;
  const v5 = inventory?.schemaVersion === 5 ? parseHostedInventoryV5(inventory) : undefined;
  const originalProperties = v5 ? ordinaryInstallationManagerProperties(ordinaryInstallationRemainingMs(v5.supervisor),
    ordinaryInstallationRemainingMs(v5.supervisor, true)).map(p => role === TrustedCustodyLaunchRole.Installer && p.startsWith("RuntimeMaxSec=") ?
      `RuntimeMaxSec=${Math.min(1200, Number(p.slice("RuntimeMaxSec=".length)))}` : p).map(p => "--property=" + p) : [];
  return { command: launch.command, args: [...launch.args.slice(0, at).filter(arg => !v5 || arg !== "--collect" && !/^--property=(?:JobTimeoutSec|TimeoutStartSec|RuntimeMaxSec|TimeoutStopSec|Restart)=/.test(arg)), ...originalProperties,
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
  const properties = [...hostedFdSystemdProperties, "Slice=system.slice", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no", "Restart=no", "MountFlags=private",
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
/** Provider unit memory limits per hosted profile. CodingV1 runs builds and test runners inside the sandbox,
 * so it gets headroom; every other profile keeps the smaller limits. Swap stays disabled, so MemoryHigh sits close
 * to MemoryMax to keep throttling of a runaway allocation short. */
const providerMemoryLimits = {
  coding: { high: "7680M", max: "8G" },
  research: { high: "2G", max: "4G" },
} as const;
/** Keep the unit alive when the kernel kills one process in its cgroup; the command fails with exit 137
 * and the model sees it. systemd's default (stop) would end the whole job. */
const providerOomPolicy = "OOMPolicy=continue";
/** Trusted assembly needs PID1 cold-root witnesses. The fixed root transition
 * drops every capability before tini and any provider or workspace code. */
export const researchProviderAssemblyCapabilityBoundingSet = "CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SETPCAP CAP_SETFCAP CAP_SYS_PTRACE";
export function trustedResearchProviderLaunch(value: ResearchStartSpec, unit: string, selectedCodexHome: string,
  rootPlan: ResearchProviderRootPlan): { command: string; args: string[] } {
  const spec = parseResearchStartSpec(value), { request } = spec;
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const home = researchPath(selectedCodexHome);
  if (!rootPlan) researchInvalid();
  const memory = request.hostedProfile === HostedMimoProfile.CodingV1 ? providerMemoryLimits.coding : providerMemoryLimits.research;
  const seal = researchProviderRootSeal(rootPlan, spec, unit, home);
  // No filesystem-namespace property belongs here: PID1 must exec the finite
  // early-private adapter before copying or protecting the captured root.
  const properties = [...hostedFdSystemdProperties, "Slice=system.slice", "KillMode=control-group", "SendSIGKILL=yes", "Delegate=no", "Restart=no",
    `BindsTo=${spec.unit}`, `PartOf=${spec.unit}`, `After=${spec.unit}`, "CPUQuota=200%", `MemoryHigh=${memory.high}`, `MemoryMax=${memory.max}`, providerOomPolicy, "TasksMax=512",
    `TimeoutStartSec=${researchProviderSetupAllowanceMs(request) / 1000}s`,
    "RuntimeMaxSec=24h", "TimeoutStopSec=30s", "IOWeight=25", "MemorySwapMax=0", "LimitCORE=0",
    "DevicePolicy=closed", "DeviceAllow=/dev/tty rw", "DeviceAllow=/dev/ptmx rw", "DeviceAllow=char-pts rw",
    "SystemCallFilter=~@raw-io @module", "RestrictSUIDSGID=yes", "AmbientCapabilities=",
    researchProviderAssemblyCapabilityBoundingSet, "NoNewPrivileges=yes"];
  return { command: "/usr/bin/systemd-run", args: ["--quiet", "--wait", "--pipe", "--collect", `--unit=${unit}`,
    `--description=subscription-runtime-research-provider:${spec.startId}:${unit}`, "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...properties.map(p => `--property=${p}`), "--", "/usr/bin/unshare", "--mount", "--propagation", "private", process.execPath,
    join(spec.runtimeDirectory, "dist/worker-codex/research-provider-root-assembler.js"), request.jobId, unit, home, seal.sha256, String(seal.deadline)] };
}

/** Closed root MiMo operation recipe: fixed entry, exact durable request and
 * derived ownership only; no caller commands, environment or properties. */
export function trustedMimoProjectOperationLaunch(value: Readonly<{
  request: MimoProjectBridgeRequest; requestSha256: string; generation: number; unit: string; description: string;
  requestPath: string; entry: string; node: string; operationTimeoutMs: number;
}>): { command: string; args: string[] } {
  const data = researchRecord(value, "request,requestSha256,generation,unit,description,requestPath,entry,node,operationTimeoutMs");
  const request = parseMimoProjectBridgeRequest(data.request);
  const digest = researchHash(JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b)))));
  const generation = data.generation;
  if (data.requestSha256 !== digest || !Number.isSafeInteger(generation) || (generation as number) < 0 ||
      (![MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop, MimoProjectBridgeOperation.Start].includes(request.operation) && generation !== 0) ||
      !Number.isSafeInteger(data.operationTimeoutMs) || (data.operationTimeoutMs as number) < 1000 || (data.operationTimeoutMs as number) > 86400000)
    throw new Error("mimo_project_bridge_operation_invalid");
  const unitDigest = researchHash(digest + ":" + generation), unit = `subscription-runtime-mimo-project-${unitDigest}.service`;
  const requestPath = `/srv/worker-state/mimo-projects/${request.projectId}/${request.workstreamId}/mimo-bridge-operations/${request.jobId}.${request.operation}.request.json`;
  const description = `subscription-runtime MiMo project ${unitDigest}`;
  const entry = researchPath(data.entry), node = researchPath(data.node);
  if (data.unit !== unit || data.description !== description || data.requestPath !== requestPath ||
      !/^\/opt\/subscription-runtime\/releases\/[a-f0-9]{40}\/dist\/worker-codex\/hosted-mimo-project-bridge-cli\.js$/.test(entry) ||
      entry !== realpathSync(entry) || node !== realpathSync(process.execPath)) throw new Error("mimo_project_bridge_operation_invalid");
  researchCustody(entry); researchCustody(node);
  for (const path of [entry, node]) {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || (path === node && !(file.mode & 0o111)))
      throw new Error("mimo_project_bridge_operation_invalid");
  }
  return { command: trustedCustodySystemdRunExecutable, args: ["--quiet",
    ...(request.operation === MimoProjectBridgeOperation.Stop ? [] : ["--collect"]),
    "--unit=" + unit, "--description=" + description, "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...["KillMode=control-group", "Restart=no", "Delegate=no", "SendSIGKILL=yes",
      "RuntimeMaxSec=" + Math.ceil((data.operationTimeoutMs as number) / 1000), "TimeoutStopSec=30", "UMask=0077", "NoNewPrivileges=yes"].map(p => "--property=" + p),
    "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/root", "USER=root", "LOGNAME=root", node, entry, "--execute-owned", requestPath] };
}

/** Fixed initial-root operator service; provider launch remains independently contained. */
export function trustedResearchOperatorLaunch(binding: ResearchOperatorBinding, ownerSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(ownerSha256)) throw new Error("research_operator_owner_invalid");
  const digest = researchHash(binding.jobId + ":" + ownerSha256);
  const unit = `subscription-runtime-research-operator-${digest}.service`;
  const description = `subscription-runtime research operator ${digest}`;
  const entry = join(binding.runtimeDirectory, "dist/worker-codex/research-operator-ingress-cli.js");
  researchCustody(entry); researchCustody(binding.node);
  return { unit, description, command: "/usr/bin/systemd-run", args: ["--quiet", "--unit=" + unit, "--description=" + description,
    "--service-type=exec", "--expand-environment=no", "--working-directory=/",
    ...["KillMode=control-group", "Restart=no", "Delegate=no", "SendSIGKILL=yes", "RuntimeMaxSec=600", "TimeoutStopSec=30", "MemoryMax=1G", "MemorySwapMax=0", "CPUQuota=100%", "TasksMax=128", "UMask=0077", "NoNewPrivileges=yes"].map(p => "--property=" + p),
    "--", "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/root", "USER=root", "LOGNAME=root", binding.node, entry,
    "--execute-owned", binding.jobId, ownerSha256] };
}
