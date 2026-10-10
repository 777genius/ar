import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { admittedResearchCodexProcessFactory, CodexModelBackend, CodexProviderEgressProfileId,
  type CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
import { parseResearchGrant, parseResearchStartSpec, researchRunConfig, type ResearchStartBinding, type ResearchStartSpec } from "./research-launch-contract";
import { assertResearchDirectory, researchArtifactDigest, researchAuthorityRoot, researchHash,
  researchId, researchInvalid, researchJson, researchName, researchPublish, researchRead, researchRecord, researchCustody, researchPath } from "./research-launch-files";
import { assertResearchInitialRoot, assertResearchServiceOwner, assertResearchSharedHost,
  researchDescription, researchExecutableDigest, researchProcessIdentity, researchServiceIdentity,
  researchUnitFromCurrentProcess } from "./research-launch-host";
import { researchProviderUnits, signalResearchProvider } from "./research-launch-lifecycle";
import { assertRegisteredResearchHandoffCurrent, assertRegisteredResearchHandoffPin, withRegisteredResearchHandoffPublication } from "./research-registered-handoff";
import { annotateResearchMaterialFailure, ResearchMaterialRole } from "./research-launch-diagnostics";
import { assertResearchProviderAssemblyContext, type ResearchProviderAssemblyRoot } from "./research-provider-root";

const mimoWorkerFactories = new WeakMap<CodexAppServerProcessFactory, ResearchStartSpec>();
const factoryGuards = new WeakMap<CodexAppServerProcessFactory, () => void>();
export const installedResearchRuntimeDirectory = (): string => fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const researchJobAuthority = (jobId: string): string => join(researchAuthorityRoot, researchName(researchId(jobId)));
export function researchCurrentStart(jobId: string): { directory: string; spec: ResearchStartSpec; bytes: Buffer } {
  const job = researchJobAuthority(jobId);
  const active = researchRecord(researchJson(researchRead(join(job, "active.json"))), "schemaVersion,startId,specSha256");
  if (active.schemaVersion !== 1 || typeof active.startId !== "string" || !/^[a-f0-9-]{36}$/.test(active.startId)) researchInvalid();
  const directory = join(job, "starts", active.startId), bytes = researchRead(join(directory, "spec.json"));
  const spec = parseResearchStartSpec(researchJson(bytes));
  if (spec.request.jobId !== jobId || spec.startId !== active.startId || researchHash(bytes) !== active.specSha256) researchInvalid();
  return { directory, spec, bytes };
}
export function readResearchStartBinding(directory: string): ResearchStartBinding {
  const r = researchRecord(researchJson(researchRead(join(directory, "binding.json"))), "schemaVersion,specSha256,process,service");
  if (r.schemaVersion !== 1 || typeof r.specSha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.specSha256)) researchInvalid();
  const p = researchRecord(r.process, "pid,birthTicks,bootId,machineId,controlGroup,namespaces");
  researchRecord(p.namespaces, "user,mnt,pid,net");
  researchRecord(r.service, "unit,mainPid,controlGroup,invocationId,description,fragmentSha256");
  return r as ResearchStartBinding;
}
/** Mutable authority and pinned identities remain current even while the
 * confined launcher is inert. This never traverses executable/artifact bytes. */
function assertResearchStartAuthority(spec: ResearchStartSpec, assertRoot: () => void = assertResearchInitialRoot): void {
  assertRoot(); assertResearchSharedHost();
  researchCustody(spec.request.authRootDir);
  const grantBytes = researchRead(join(researchJobAuthority(spec.request.jobId), "grant.json"));
  const grant = parseResearchGrant(researchJson(grantBytes));
  if (researchHash(grantBytes) !== spec.grantSha256 || grant.jobId !== spec.request.jobId ||
      grant.jobRootDir !== spec.request.jobRootDir || grant.workspacePath !== spec.request.workspacePath ||
      JSON.stringify(grant.jobDirectory) !== JSON.stringify(spec.jobDirectory) ||
      JSON.stringify(grant.registeredHandoff) !== JSON.stringify(spec.registeredHandoff) ||
      JSON.stringify(grant.workspaceDirectory) !== JSON.stringify(spec.workspaceDirectory)) researchInvalid();
  if ((spec.request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) !== (grant.profileId === CodexProviderEgressProfileId.MimoTokenPlan)) researchInvalid();
  assertResearchDirectory(spec.jobDirectory); assertResearchDirectory(spec.workspaceDirectory);
  const pins = join(researchJobAuthority(spec.request.jobId), "starts", spec.startId, "pins");
  assertResearchDirectory(spec.jobDirectory, join(pins, "job"));
  assertResearchDirectory(spec.workspaceDirectory, join(pins, "workspace"));
  assertRegisteredResearchHandoffPin(spec, join(pins, ".."));
  if (!researchRead(join(researchJobAuthority(spec.request.jobId), "grant.json")).equals(grantBytes)) researchInvalid();
}
function assertResearchMaterialBytes(spec: ResearchStartSpec): void {
  if (spec.runtimeDirectory !== installedResearchRuntimeDirectory()) researchInvalid();
  const assertDigest = (role: Exclude<ResearchMaterialRole, ResearchMaterialRole.Unknown>, read: () => string, expected: string): void => {
    try { if (read() !== expected) researchInvalid(); }
    catch (error) { throw annotateResearchMaterialFailure(error, role); }
  };
  assertDigest(ResearchMaterialRole.RuntimeArtifact, () => researchArtifactDigest(spec.runtimeDirectory), spec.artifactSha256);
  assertDigest(ResearchMaterialRole.NodeExecutable, () => researchExecutableDigest(process.execPath), spec.nodeSha256);
  assertDigest(ResearchMaterialRole.CodexExecutable, () => researchExecutableDigest(spec.request.codexBinaryPath), spec.codexSha256);
}
export function assertResearchStartMaterial(spec: ResearchStartSpec): void {
  assertResearchStartMaterialInternal(spec, assertResearchInitialRoot);
}
function assertResearchStartMaterialInternal(spec: ResearchStartSpec, assertRoot: () => void): void {
  assertResearchStartAuthority(spec, assertRoot);
  assertResearchMaterialBytes(spec);
  assertResearchStartAuthority(spec, assertRoot);
}
export function assertResearchProviderStartMaterial(root: ResearchProviderAssemblyRoot): void {
  assertResearchStartMaterialInternal(root.spec, () => assertResearchProviderAssemblyContext(root));
}
/** Blocking Host observations can overlap a separate operator's revoke/cancel.
 * Recheck only mutable documents and pinned identities at the effect boundary. */
function assertResearchCurrentAuthorityBytes(jobId: string, initial: ReturnType<typeof researchCurrentStart>, bindingBytes?: Buffer, allowClosing = false): void {
  const fresh = researchCurrentStart(jobId);
  if ((!allowClosing && existsSync(join(initial.directory, "closing.json"))) || fresh.directory !== initial.directory || !fresh.bytes.equals(initial.bytes) ||
      (bindingBytes !== undefined && !researchRead(join(initial.directory, "binding.json")).equals(bindingBytes)) ||
      researchHash(researchRead(join(researchJobAuthority(jobId), "grant.json"))) !== initial.spec.grantSha256) researchInvalid();
}
export function assertResearchCurrentAuthority(jobId: string, initial: ReturnType<typeof researchCurrentStart>, bindingBytes?: Buffer, allowClosing = false): void {
  assertResearchCurrentAuthorityInternal(jobId, initial, bindingBytes, allowClosing, assertResearchInitialRoot);
}
function assertResearchCurrentAuthorityInternal(jobId: string, initial: ReturnType<typeof researchCurrentStart>, bindingBytes: Buffer | undefined,
  allowClosing: boolean, assertRoot: () => void): void {
  assertResearchCurrentAuthorityBytes(jobId, initial, bindingBytes, allowClosing);
  assertResearchStartAuthority(initial.spec, assertRoot);
  // No blocking observations follow the final mutable authority read.
  assertResearchCurrentAuthorityBytes(jobId, initial, bindingBytes, allowClosing);
}
export function assertResearchProviderCurrentAuthority(jobId: string, initial: ReturnType<typeof researchCurrentStart>,
  root: ResearchProviderAssemblyRoot, bindingBytes?: Buffer): void {
  if (root.spec.request.jobId !== jobId || JSON.stringify(root.spec) !== JSON.stringify(initial.spec)) researchInvalid();
  assertResearchCurrentAuthorityInternal(jobId, initial, bindingBytes, false, () => assertResearchProviderAssemblyContext(root));
}
/** Capture real MainPID/birth/boot/InvocationID only from the new individually
 * owned service. The explicit initial-root operator staged its closed spec. */
export function bindResearchRuntime(jobId: string, startId: string): ResearchStartSpec {
  return bindResearchRuntimeInternal(jobId, startId);
}
export async function bindRegisteredResearchRuntime(jobId: string, startId: string): Promise<ResearchStartSpec> {
  const initial = researchCurrentStart(jobId);
  if (initial.spec.startId !== startId || !initial.spec.registeredHandoff) researchInvalid();
  await assertRegisteredResearchHandoffCurrent(initial.spec.registeredHandoff, initial.spec.request);
  return bindResearchRuntimeInternal(jobId, startId, initial.bytes);
}
function bindResearchRuntimeInternal(jobId: string, startId: string, registeredBytes?: Buffer): ResearchStartSpec {
  assertResearchInitialRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(jobId), { directory, spec, bytes } = initial;
  if (registeredBytes ? !registeredBytes.equals(bytes) : spec.registeredHandoff !== undefined) researchInvalid();
  if (spec.startId !== startId || existsSync(join(directory, "closing.json"))) researchInvalid();
  assertResearchStartMaterial(spec);
  const identity = researchProcessIdentity(), service = researchServiceIdentity(spec.unit);
  assertResearchServiceOwner(identity, service, researchDescription(jobId, researchHash(bytes)));
  assertResearchCurrentAuthority(jobId, initial);
  researchPublish(join(directory, "binding.json"), {
    schemaVersion: 1, specSha256: researchHash(bytes), process: identity, service,
  } satisfies ResearchStartBinding, true);
  return spec;
}
/** Trusted terminal publication port. No serialized request can provide it. */
export function researchTerminalHandoffGuard(jobId: string, startId: string): () => Promise<void> {
  return registeredResearchHandoffGuard(jobId, startId, false);
}
export function researchHandoffPublicationLease(jobId: string, startId: string): <T>(effect: () => Promise<T>) => Promise<T> {
  const initial = researchCurrentStart(jobId);
  if (initial.spec.startId !== startId || !initial.spec.registeredHandoff) researchInvalid();
  return async effect => await withRegisteredResearchHandoffPublication(initial.spec.registeredHandoff!, initial.spec.request, effect);
}
/** Cancellation is allowed to preserve only after its creator is stopped; the
 * caller independently reconciles the exact runtime/provider units. */
export function researchCancellationHandoffGuard(jobId: string, startId: string): () => Promise<void> {
  return registeredResearchHandoffGuard(jobId, startId, true);
}
function registeredResearchHandoffGuard(jobId: string, startId: string, allowClosing: boolean): () => Promise<void> {
  const initial = researchCurrentStart(jobId);
  if (initial.spec.startId !== startId || !initial.spec.registeredHandoff) researchInvalid();
  return async () => {
    assertResearchCurrentAuthority(jobId, initial, undefined, allowClosing);
    await assertRegisteredResearchHandoffCurrent(initial.spec.registeredHandoff!, initial.spec.request);
    assertResearchCurrentAuthority(jobId, initial, undefined, allowClosing);
    assertRegisteredResearchHandoffPin(initial.spec, initial.directory);
    assertResearchDirectory(initial.spec.registeredHandoff!.durableDirectory, initial.spec.request.durableHandoffRootDir);
    assertResearchCurrentAuthorityBytes(jobId, initial, undefined, allowClosing);
  };
}
export function captureResearchRuntime(identity: HostedTestEgressIdentity, ownerPid = process.pid): {
  readonly spec: ResearchStartSpec; readonly directory: string; readonly profileId: CodexProviderEgressProfileId; readonly assertCurrent: () => void;
  readonly assertAuthorityCurrent: () => void;
} {
  assertResearchInitialRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(identity.jobId), bindingBytes = researchRead(join(initial.directory, "binding.json"));
  const binding = readResearchStartBinding(initial.directory), { spec } = initial;
  if (spec.request.jobRootDir !== identity.jobRootDir || spec.request.workspacePath !== identity.workspacePath ||
      binding.specSha256 !== researchHash(initial.bytes) || binding.process.pid !== ownerPid || binding.service.unit !== spec.unit) researchInvalid();
  const assertAuthorityCurrent = (): void => {
    assertResearchCurrentAuthority(identity.jobId, initial, bindingBytes);
    const current = researchProcessIdentity(ownerPid), service = researchServiceIdentity(spec.unit);
    assertResearchServiceOwner(current, service, researchDescription(identity.jobId, researchHash(initial.bytes)));
    if (JSON.stringify(current) !== JSON.stringify(binding.process) || JSON.stringify(service) !== JSON.stringify(binding.service) ||
        researchProcessIdentity().controlGroup !== current.controlGroup) researchInvalid();
    assertResearchCurrentAuthority(identity.jobId, initial, bindingBytes);
  };
  // Full effect guards retain their existing meaning. Recheck mutable authority
  // after a slow byte walk as well, immediately before the caller's effect.
  const assertCurrent = (): void => {
    assertAuthorityCurrent();
    assertResearchMaterialBytes(spec);
    assertAuthorityCurrent();
  };
  const profileId = parseResearchGrant(researchJson(researchRead(join(researchJobAuthority(identity.jobId), "grant.json")))).profileId;
  assertCurrent();
  return Object.freeze({ spec, directory: initial.directory, profileId, assertCurrent, assertAuthorityCurrent });
}

export function researchProviderAdmissionGuard(factory: CodexAppServerProcessFactory | undefined): (() => void) | undefined {
  return factory ? factoryGuards.get(factory) : undefined;
}
export function admitResearchRuntime(identity: HostedTestEgressIdentity): CodexProviderEgressProfileId | undefined {
  if (!researchUnitFromCurrentProcess()) return undefined;
  return captureResearchRuntime(identity).profileId;
}
export function admitResearchProcessFactory(identity: HostedTestEgressIdentity): CodexAppServerProcessFactory {
  const captured = captureResearchRuntime(identity);
  const spawn = admittedResearchCodexProcessFactory({ jobId: identity.jobId,
    launcherPath: join(captured.spec.runtimeDirectory, "host-integration", "research-provider-launch.mjs"),
    submit: (unit, effect) => {
      captured.assertCurrent();
      // Reserve space for reservation, ownership, submission and cancel facts;
      // helpers cannot grow the existing 1,024-file bound after admission.
      if (researchProviderUnits(captured.directory).length >= 256) researchInvalid();
      researchPublish(join(captured.directory, "providers", unit + ".json"), {
        schemaVersion: 1, unit, runtimeUnit: captured.spec.unit,
        specSha256: researchHash(researchRead(join(captured.directory, "spec.json"))),
        description: `subscription-runtime-research-provider:${captured.spec.startId}:${unit}`,
      }, true);
      return effect();
    },
    signal: (unit, signal) => signalResearchProvider(captured.directory, unit, signal),
  });
  const factory: CodexAppServerProcessFactory = launch => {
    const cwd = researchPath(launch.cwd), home = researchPath(launch.env.CODEX_HOME);
    const runtimeHome = join(identity.jobRootDir, "home");
    if (launch.command !== captured.spec.request.codexBinaryPath ||
        (cwd !== identity.workspacePath && !cwd.startsWith(runtimeHome + "/")) ||
        !home.startsWith(runtimeHome + "/")) researchInvalid();
    return spawn(launch);
  };
  factoryGuards.set(factory, captured.assertCurrent);
  if (captured.spec.request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) mimoWorkerFactories.set(factory, captured.spec);
  return factory;
}
/** A marker cannot select this branch, but also cannot hide an actual service. */
export function assertResearchRuntimeEngine(input: { executionEngine?: CodexWorkerExecutionEngine; modelBackend?: CodexModelBackend }, profileId?: CodexProviderEgressProfileId): void {
  const mimo = input.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan;
  if (profileId !== undefined && mimo !== (profileId === CodexProviderEgressProfileId.MimoTokenPlan)) researchInvalid();
  if ((input.executionEngine ?? "app-server-goal") !== (mimo ? "app-server" : "app-server-goal") ||
      (!mimo && input.modelBackend !== undefined && input.modelBackend !== CodexModelBackend.OpenAiChatGpt)) researchInvalid();
}

export function assertOwnedMimoWorkerFactory(factory: CodexAppServerProcessFactory | undefined): ResearchStartSpec {
  const guard = researchProviderAdmissionGuard(factory);
  if (!factory || !guard || !mimoWorkerFactories.has(factory)) throw new Error("hosted_mimo_activation_closed");
  guard();
  return mimoWorkerFactories.get(factory)!;
}
/** Only factories minted above can select the external-owner storage/result lifecycle. */
export function ownedMimoWorkerStart(factory: CodexAppServerProcessFactory | undefined): ResearchStartSpec | undefined {
  return factory && mimoWorkerFactories.has(factory) ? assertOwnedMimoWorkerFactory(factory) : undefined;
}

export function assertOwnedMimoWorkerConfig(factory: CodexAppServerProcessFactory | undefined, config: import("./codex-goal-runner").CodexGoalRunConfig): void {
  const spec = assertOwnedMimoWorkerFactory(factory), expected = researchRunConfig(spec.request);
  for (const key of ["jobId", "taskId", "workspacePath", "jobRootDir", "accounts", "model", "modelBackend", "executionEngine", "maxAccountCycles",
    "prewarmOnStart", "workerReportMode", "maxGoalTurns", "taskTimeoutMs", "safeExecutionPolicy", "maxReconnectRetriesPerAccount"] as const) {
    if (JSON.stringify(config[key]) !== JSON.stringify(expected[key])) researchInvalid();
  }
}
