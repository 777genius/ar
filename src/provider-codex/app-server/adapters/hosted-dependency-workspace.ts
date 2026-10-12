import type { DependencyParentRecipeReader } from "../../../core/dependency-environment/dependency-parent-recipe-reader";
import { decodeHostedInventoryBytes, parseHostedInventoryV5 } from "../../../core/host-infrastructure/host-inventory";
import { parseHostedInstallation } from "../../../core/host-infrastructure/hosted-installation";
import { parseHostedReadonlyHostInventory } from "../../../core/host-infrastructure/readonly-host-inventory";
import { assertConfiguredAuthAttachmentPhysical } from "./hosted-configured-auth-attachment";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyOwnerPhase,
  sameDependencyWorkspace, parseDependencyOwner, isDependencyConsumerOwner, readSystemBusInfrastructureField, readFdCollectorProfileField,
  type DependencyWorkspaceIdentity, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
import { verifySystemBusInfrastructure } from "./system-bus-infrastructure";
import { readHostedFdProfile } from "./hosted-fd-observation";
import { dependencyToolCachePath, parseDependencyToolProfile, type DependencyToolProfile } from "../../../core/dependency-environment/dependency-tool-profile";
import { readHostedDependencyParentRecipe } from "./hosted-dependency-parent-recipe";
import { assertHostedActivationOperator, decodeHostedActivationBytes, readHostedActivationBytes } from "./hosted-process-activation";

export const hostedDependencyPolicyRoot = "/var/lib/subscription-runtime-host-policy";
export const hostedDependencyJobsRoot = `${hostedDependencyPolicyRoot}/dependency-test-jobs/jobs`;
export const hostedDependencyBindingRoot = `${hostedDependencyPolicyRoot}/dependency-bindings`;
export const hostedDependencyOwnerRoot = `${hostedDependencyPolicyRoot}/dependency-owners`;
type HostedDependencyBindingFields = {
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspace: DependencyWorkspaceIdentity;
  readonly installationId: string;
  readonly runtimeSha: string;
  readonly grantDigest: string;
};
export enum HostedDependencyReferenceKind { LegacyRegistryV1 = "legacy_registry_reference_v1", LegacyLocalNoLifecycleV1 = "legacy_local_no_lifecycle_reference_v1" }
export type HostedDependencyBinding = HostedDependencyBindingFields & (
  | { readonly version: 1 }
  | { readonly version: 2; readonly toolProfile: DependencyToolProfile }
  | { readonly version: 3; readonly reference: { readonly kind: HostedDependencyReferenceKind; readonly operationId: string } }
);
/** Closed configuration compatibility only. Revisions4/5 are necessary for v2/v3;
 * actual installation/profile/fence proofs are separately required below. */
export function assertHostedDependencyBindingInventoryRevision(binding: HostedDependencyBinding, revision: unknown): void {
  if ((revision !== 2 && revision !== 3 && revision !== 4 && revision !== 5) || binding.version !== 1 && revision !== 4 && revision !== 5) invalid();
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export function hostedDependencyJobRoot(jobId: string): string {
  if (!/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(jobId)) invalid();
  return `${hostedDependencyJobsRoot}/${jobId}`;
}
export function isHostedDependencyWorkspace(path: string): boolean {
  return path === hostedDependencyJobsRoot || path.startsWith(`${hostedDependencyJobsRoot}/`);
}
export function hostedDependencyBindingName(jobId: string): string {
  // Legacy ordinary identities can look up an absent binding without becoming
  // opted TEST workspaces. Creation/parser enforce the narrower TEST namespace.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId)) invalid();
  return `dependency-bindings/${hash(jobId)}.json`;
}
export function parseHostedDependencyBinding(value: unknown): HostedDependencyBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const v = value as HostedDependencyBinding;
  if ((v.version !== 1 && v.version !== 2 && v.version !== 3) || Object.keys(v).sort().join(",") !==
      (v.version === 2 ? "grantDigest,installationId,jobId,jobRootDir,runtimeSha,toolProfile,version,workspace" :
        v.version === 3 ? "grantDigest,installationId,jobId,jobRootDir,reference,runtimeSha,version,workspace" : "grantDigest,installationId,jobId,jobRootDir,runtimeSha,version,workspace") ||
      typeof v.jobId !== "string" || v.jobRootDir !== hostedDependencyJobRoot(v.jobId) ||
      !v.workspace || Object.keys(v.workspace).sort().join(",") !== "canonicalPath,dev,ino" ||
      v.workspace.canonicalPath !== `${v.jobRootDir}/workspace` ||
      typeof v.workspace.dev !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v.workspace.dev) ||
      typeof v.workspace.ino !== "string" || !/^[1-9][0-9]{0,19}$/.test(v.workspace.ino) ||
      typeof v.installationId !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.installationId) ||
      typeof v.runtimeSha !== "string" || !/^[a-f0-9]{40}$/.test(v.runtimeSha) ||
      typeof v.grantDigest !== "string" || !/^[a-f0-9]{64}$/.test(v.grantDigest)) invalid();
  if (v.version === 2) {
    const toolProfile = parseDependencyToolProfile(v.toolProfile);
    if (toolProfile.cache.canonicalPath !== dependencyToolCachePath(v.jobRootDir)) invalid();
    return Object.freeze({ ...v, workspace: Object.freeze({ ...v.workspace }), toolProfile });
  }
  if (v.version === 3) {
    if (!v.reference || typeof v.reference !== "object" || Array.isArray(v.reference) || Object.keys(v.reference).sort().join(",") !== "kind,operationId" ||
        (v.reference.kind !== HostedDependencyReferenceKind.LegacyRegistryV1 && v.reference.kind !== HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1) || typeof v.reference.operationId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.reference.operationId)) invalid();
    return Object.freeze({ ...v, workspace: Object.freeze({ ...v.workspace }), reference: Object.freeze({ ...v.reference }) });
  }
  return Object.freeze({ ...v, workspace: Object.freeze({ ...v.workspace }) });
}

/** Classification never grants admission. Actual launch and owner are checked
 * separately under the trusted host fence, immediately before every enqueue. */
export function readHostedDependencyBinding(jobId: string): HostedDependencyBinding | null {
  assertHostedActivationOperator();
  try { lstatSync(hostedDependencyBindingRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const bytes = readHostedActivationBytes(hostedDependencyBindingName(jobId));
  return bytes ? parseHostedDependencyBinding(decodeHostedActivationBytes(bytes)) : null;
}

export function assertHostedDependencyPhysicalWorkspace(binding: HostedDependencyBinding): void {
  assertHostedActivationOperator();
  for (let path = binding.jobRootDir;; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(path) !== path) invalid();
    if (path === "/") break;
  }
  const workspace = lstatSync(binding.workspace.canonicalPath, { bigint: true });
  if (!workspace.isDirectory() || workspace.uid !== 0n || realpathSync(binding.workspace.canonicalPath) !== binding.workspace.canonicalPath ||
      workspace.dev.toString() !== binding.workspace.dev || workspace.ino.toString() !== binding.workspace.ino) invalid();
  const git = lstatSync(`${binding.workspace.canonicalPath}/.git`);
  if (!git.isDirectory() || git.uid !== 0 || (git.mode & 0o022) || git.isSymbolicLink() || realpathSync(`${binding.workspace.canonicalPath}/.git`) !== `${binding.workspace.canonicalPath}/.git` ||
      readdirSync(`${binding.workspace.canonicalPath}/.git`).includes("commondir")) invalid();
  // An explicitly installed one-shot auth role is the only finite exception.
  // Profile selection is original protected IO, never an exemption DTO.
  const inventoryBytes=readHostedActivationBytes("readonly-inventory.json"), installationBytes=readHostedActivationBytes("host-installation.json");
  let attachment: import("../../../core/host-infrastructure/configured-auth-attachment").HostedConfiguredAuthAttachment | undefined;
  const decodedInventory=inventoryBytes ? decodeHostedActivationBytes(inventoryBytes) : undefined;
  const hasAttachment=decodedInventory && typeof decodedInventory==="object" && "ordinaryCreators" in decodedInventory &&
    Array.isArray(decodedInventory.ordinaryCreators) && decodedInventory.ordinaryCreators.some((c:unknown)=>c && typeof c==="object" && "jobId" in c && c.jobId===binding.jobId && "authAttachment" in c);
  if(inventoryBytes && hasAttachment) {
    const inventory=parseHostedReadonlyHostInventory(decodeHostedActivationBytes(inventoryBytes));
    const creators=inventory.ordinaryCreators.filter(c=>c.jobId===binding.jobId);
    attachment=creators[0]?.authAttachment;
    if(attachment) {
      if(binding.version!==2 || creators.length!==1 || !installationBytes) invalid();
      const installed=parseHostedInstallation(decodeHostedActivationBytes(installationBytes));
      if(installed.inventorySha256!==hash(inventoryBytes.toString("utf8")) || installed.installationId!==binding.installationId || installed.runtimeSha!==binding.runtimeSha ||
        creators[0]!.jobRootDir!==binding.jobRootDir || creators[0]!.workspacePath!==binding.workspace.canonicalPath) invalid();
      assertConfiguredAuthAttachmentPhysical(attachment);
    }
  }
  let admitted=0;
  // All other mounts, including same-device binds, still veto this TEST profile.
  for (const line of readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 10 || !fields.includes("-")) invalid();
    const point = fields[4]!.replace(/\\([0-7]{3})/g, (_, code: string) => String.fromCharCode(parseInt(code, 8)));
    if (point === binding.jobRootDir || point.startsWith(`${binding.jobRootDir}/`)) {
      if(!attachment || line!==attachment.targetMount || ++admitted!==1) invalid();
    }
  }
  if(attachment) {
    if(admitted!==1 || !inventoryBytes || !installationBytes ||
      !readHostedActivationBytes("readonly-inventory.json")?.equals(inventoryBytes) ||
      !readHostedActivationBytes("host-installation.json")?.equals(installationBytes)) invalid();
    assertConfiguredAuthAttachmentPhysical(attachment);
  }
}

export function assertHostedDependencyStartAllowed(startId: string): void {
  if (!/^[a-f0-9-]{36}$/.test(startId) || readHostedActivationBytes(`dependency-attempt-fences/${startId}.json`)) invalid();
}

/** Restricts the already cold kernel-qualified installed creator set. This is
 * not live host inventory or a JSON substitute for that kernel gate. Mixed
 * legacy hosts stay unsupported: privileged project Git actors are not enclosed
 * by old guest InaccessiblePaths. Inventoried host operators remain trusted. */
export function assertHostedDependencyQualifiedInventory(parentRecipeReader?: DependencyParentRecipeReader): void {
  const installationBytes = readHostedActivationBytes("host-installation.json"), inventoryBytes = readHostedActivationBytes("readonly-inventory.json"),
    activationBytes = readHostedActivationBytes("host-activation.json");
  if (!installationBytes || !inventoryBytes || !activationBytes) invalid();
  const installation = object(decodeHostedActivationBytes(installationBytes)),
    inventory = object(decodeHostedInventoryBytes(inventoryBytes)), activation = object(decodeHostedActivationBytes(activationBytes));
  if (installation.inventorySha256 !== hash(inventoryBytes.toString("utf8")) || (inventory.schemaVersion !== 2 && inventory.schemaVersion !== 3 && inventory.schemaVersion !== 4 && inventory.schemaVersion !== 5) ||
      !Array.isArray(inventory.ordinaryCreators) || !inventory.ordinaryCreators.length || !Array.isArray(activation.ordinaryStarts)) invalid();
  // Revision 3 cannot be downgraded or smuggle an ignored infrastructure role
  // into the qualified installed-artifact hash. Revision 2 keeps its contract.
  const systemBusInfrastructure = readSystemBusInfrastructureField(inventory);
  const collectorProfile = readFdCollectorProfileField(inventory);
  if (collectorProfile && !readHostedFdProfile()) invalid();
  if (inventory.schemaVersion === 5) {
    parseHostedInventoryV5(inventory);
    if (!collectorProfile || !readHostedFdProfile()) invalid();
    verifySystemBusInfrastructure(systemBusInfrastructure!);
  }
  if (systemBusInfrastructure && inventory.schemaVersion !== 5) {
    if (Object.keys(inventory).sort().join(",") !== (collectorProfile ? "collectorProfile," : "") + "disabledCreators,hostId,ordinaryCreators,runtimeLaunch,schemaVersion,supervisorUnit,systemBusInfrastructure,units" ||
        inventory.supervisorUnit === "dbus.service" || !Array.isArray(inventory.units) || !inventory.units.length || inventory.units.length > 128 ||
        typeof inventory.hostId !== "string" || !/^[a-f0-9]{32}$/.test(inventory.hostId)) invalid();
    const units = inventory.units.map(value => {
      const row = object(value);
      if (Object.keys(row).sort().join(",") !== "controlGroup,fragmentSha256,name" || typeof row.name !== "string" ||
          !/^[A-Za-z0-9_@.-]+\.(service|scope)$/.test(row.name) || row.name.startsWith("subscription-runtime-hosted-") ||
          typeof row.controlGroup !== "string" || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(row.controlGroup) ||
          row.controlGroup.split("/").some(part => part === "." || part === "..") || typeof row.fragmentSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.fragmentSha256)) invalid();
      return row;
    });
    if (new Set(units.map(row => row.name)).size !== units.length || new Set(units.map(row => row.controlGroup)).size !== units.length ||
        !units.some(row => row.name === inventory.supervisorUnit) || !units.some(row => row.name === "dbus.service" &&
          row.controlGroup === systemBusInfrastructure.service.controlGroup && row.fragmentSha256 === systemBusInfrastructure.service.fragmentSha256) ||
        !Array.isArray(inventory.disabledCreators) || inventory.disabledCreators.length > 128 ||
        new Set(inventory.disabledCreators).size !== inventory.disabledCreators.length || inventory.disabledCreators.some(name =>
          typeof name !== "string" || name.length > 200 || !/^[A-Za-z0-9_@.-]+\.(service|socket|timer)$/.test(name) ||
          name === "dbus.socket" || units.some(row => row.name === name))) invalid();
    verifySystemBusInfrastructure(systemBusInfrastructure);
  }
  for (const value of inventory.ordinaryCreators) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const v = value as Record<string, unknown>;
    if (typeof v.jobId !== "string" || v.jobRootDir !== hostedDependencyJobRoot(v.jobId) ||
        v.workspacePath !== `${v.jobRootDir}/workspace` || v.childSlotSha256 !== undefined ||
        !v.launch || typeof v.launch !== "object" || Array.isArray(v.launch)) invalid();
    const launch = v.launch as Record<string, unknown>;
    if (launch.command !== process.execPath || launch.cwd !== v.workspacePath || !Array.isArray(launch.args) || launch.args.length < 2 ||
        launch.args[0] !== `${installation.runtimeDirectory}/dist/worker-codex/codex-goal-cli.js` ||
        (launch.args[1] !== "run" && launch.args[1] !== "tool") || launch.args.some(arg => typeof arg !== "string" ||
          /^--(?:tmux|tmux-session|dry-run|print-command|hosted-lifecycle|lifecycle(?:-[^=]+)?)(?:=|$)/.test(arg))) invalid();
    if (launch.args[1] === "tool") {
      readHostedDependencyParentRecipe(launch as unknown as import("../../../core/host-infrastructure/host-inventory").HostedInventoryLaunch,
        String(v.jobRootDir), String(v.workspacePath), parentRecipeReader);
    }
    for (const [index, arg] of launch.args.entries()) {
      if (arg === "--registry-root" && launch.args[index + 1] !== `${v.jobRootDir}/state/registry`) invalid();
      if (arg.startsWith("--registry-root=")) invalid(); // Not an accepted parser option form.
    }
    const binding = readHostedDependencyBinding(v.jobId);
    if (binding) assertHostedDependencyBindingInventoryRevision(binding, inventory.schemaVersion);
    if (binding && binding.version !== 1) {
      // This executes during enrollment/reservation, before the root CLI. A
      // legacy direct stdin.end(frame) must never reach an opted N3 writer.
      if (!collectorProfile || !readHostedFdProfile()) invalid();
      readHostedDependencyParentRecipe(launch as unknown as import("../../../core/host-infrastructure/host-inventory").HostedInventoryLaunch, binding.jobRootDir, binding.workspace.canonicalPath, parentRecipeReader);
    }
  }
  // The separately inventoried outer entry cannot provide a legacy bypass.
  const outer = object(inventory.runtimeLaunch);
  const outerArgs = outer.args;
  if (!Array.isArray(outerArgs)) invalid();
  if (!inventory.ordinaryCreators.some(value => {
    const launch = object(object(value).launch);
    return launch.command === outer.command && launch.cwd === outer.cwd && Array.isArray(launch.args) &&
      launch.args.length === outerArgs.length && launch.args.every((arg, index) => arg === outerArgs[index]);
  })) invalid();
  for (const value of activation.ordinaryStarts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const v = value as Record<string, unknown>;
    if (typeof v.startId !== "string") invalid();
    const bytes = readHostedActivationBytes(`ordinary-starts/${v.startId}.json`);
    if (!bytes) invalid();
    const start = object(decodeHostedActivationBytes(bytes));
    if (typeof start.jobId !== "string" || start.jobRootDir !== hostedDependencyJobRoot(start.jobId) ||
        start.workspacePath !== `${start.jobRootDir}/workspace`) invalid();
  }
}

export function readHostedDependencyAttempt(binding: HostedDependencyBinding,
  start: Readonly<Record<string, unknown>>, startId: string, phase = DependencyOwnerPhase.Running, parentRecipeReader?: DependencyParentRecipeReader): DependencyAttempt {
  // Reference has no Running/provider entry. Its only supported owner is the
  // actual consumed Exclusive attempt used by the fixed materializer.
  if (binding.version === 3 && phase !== DependencyOwnerPhase.ExclusiveMutation) invalid();
  assertHostedDependencyQualifiedInventory(parentRecipeReader);
  assertHostedDependencyPhysicalWorkspace(binding);
  assertHostedDependencyStartAllowed(startId);
  if (start.installationId !== binding.installationId || start.grantSha256 !== binding.grantDigest ||
      start.unit !== `subscription-runtime-ordinary-${startId}.service`) invalid();
  const name = `dependency-owners/${binding.workspace.dev}-${binding.workspace.ino}`;
  if (readHostedActivationBytes(name + ".lock")) invalid();
  const bytes = readHostedActivationBytes(name + ".json");
  if (!bytes || bytes.length > 16384) invalid();
  const owner = parseDependencyOwner(decodeHostedActivationBytes(bytes));
  // The mutex protects unresolved publication too. No PID/TTL or "valid JSON"
  // exception may turn an uncertain store effect into admission.
  if (readHostedActivationBytes(name + ".lock")) invalid();
  assertHostedDependencyPhysicalWorkspace(binding);
  if (owner.version !== 2 || !sameDependencyWorkspace(owner.workspace, binding.workspace) ||
      !isDependencyConsumerOwner(owner.owner) || owner.owner.phase !== phase) invalid();
  const attempt = owner.owner.attempt;
  if (attempt.launch.startId !== startId || attempt.launch.unit !== start.unit || attempt.launch.bootId !== start.bootId ||
      attempt.launch.installationId !== binding.installationId || attempt.launch.runtimeSha !== binding.runtimeSha ||
      attempt.launch.grantDigest !== binding.grantDigest) invalid();
  return attempt;
}
function invalid(): never { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
