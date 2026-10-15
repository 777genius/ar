import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { admittedResearchCodexProcessFactory, CodexModelBackend, CodexProviderEgressProfileId, HostedMimoProfile,
  type CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
import { assertResearchMimoProfileMatch, parseResearchGrant, parseResearchStartSpec, researchRunConfig, type ResearchStartBinding, type ResearchStartSpec } from "./research-launch-contract";
import { assertResearchDirectory, researchDirectoryIdentity, researchArtifactDigest, researchAuthorityRoot, researchHash,
  researchId, researchInvalid, researchJson, researchName, researchPublish, researchRead, researchRecord, researchCustody, researchPath } from "./research-launch-files";
import { assertResearchInitialRoot, assertResearchServiceOwner, assertResearchSharedHost,
  researchDescription, researchExecutableDigest, researchProcessIdentity, researchServiceIdentity,
  researchUnitFromCurrentProcess } from "./research-launch-host";
import { researchProviderReservationLimit, researchProviderUnits, signalResearchProvider } from "./research-launch-lifecycle";
import { assertRegisteredResearchHandoffCurrent, assertRegisteredResearchHandoffPin, withRegisteredResearchHandoffPublication } from "./research-registered-handoff";
import { annotateResearchMaterialFailure, ResearchMaterialRole } from "./research-launch-diagnostics";
import { assertResearchProviderAssemblyContext, type ResearchProviderAssemblyRoot } from "./research-provider-root";
import { assertResearchProjectLaunchBindingCurrent } from "./research-project-launch-authorization";
import { researchAdmissionObservation, researchAdmissionMeasure, ResearchAdmissionFailureStage, type ResearchAdmissionTiming } from "./research-launch-admission-diagnostics";

const mimoWorkerFactories = new WeakMap<CodexAppServerProcessFactory, ResearchStartSpec>();
const factoryGuards = new WeakMap<CodexAppServerProcessFactory, () => ResearchAdmissionTiming | void>();
const projectAuthorityWitnesses = new Map<string, { readonly bytes: Buffer; readonly spec: string; readonly assertAuthorityBytes: () => void }>();
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
/** A revoked project grant remains protected origin evidence. A successor's
 * different grant hash cannot be revoked by an earlier exact-grant request. */
export function assertResearchProjectGrantNotRevoked(jobId: string, grantSha256: string): void {
  const path = join(researchJobAuthority(jobId), "revoked-project-grant.json");
  if (!existsSync(path)) return;
  const revoked = researchRecord(researchJson(researchRead(path)), "schemaVersion,grantSha256");
  if (revoked.schemaVersion !== 1 || typeof revoked.grantSha256 !== "string" || !/^[a-f0-9]{64}$/.test(revoked.grantSha256) ||
      revoked.grantSha256 === grantSha256) researchInvalid();
}
/** Each trusted process prepares its own current-byte reader. This is neither
 * a portable permit nor a cached authority decision: every effect rereads the
 * exact protected project documents through the retained synchronous reader. */
export async function prepareResearchProjectLaunchAuthority(jobId: string, startId: string,
  assertRoot: () => void = assertResearchInitialRoot): Promise<void> {
  assertRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(jobId), binding = initial.spec.projectLaunchBinding;
  if (initial.spec.startId !== startId) researchInvalid();
  if (!binding) return;
  const assertAuthorityBytes = await assertResearchProjectLaunchBindingCurrent(binding, initial.spec.request, assertRoot);
  assertRoot(); assertResearchSharedHost();
  const fresh = researchCurrentStart(jobId), grantBytes = researchRead(join(researchJobAuthority(jobId), "grant.json"));
  if (!fresh.bytes.equals(initial.bytes) || fresh.directory !== initial.directory || existsSync(join(initial.directory, "closing.json")) ||
      researchHash(grantBytes) !== initial.spec.grantSha256 ||
      JSON.stringify(parseResearchGrant(researchJson(grantBytes)).projectLaunchBinding) !== JSON.stringify(binding)) researchInvalid();
  assertResearchProjectGrantNotRevoked(jobId, initial.spec.grantSha256);
  assertAuthorityBytes();
  projectAuthorityWitnesses.set(initial.directory, { bytes: Buffer.from(initial.bytes), spec: JSON.stringify(initial.spec), assertAuthorityBytes });
}
function assertResearchProjectLaunchAuthorityBytes(spec: ResearchStartSpec): void {
  if (!spec.projectLaunchBinding && !spec.registeredHandoff) return;
  const current = researchCurrentStart(spec.request.jobId), witness = projectAuthorityWitnesses.get(current.directory);
  if (!witness || !current.bytes.equals(witness.bytes) || witness.spec !== JSON.stringify(spec)) researchInvalid();
  if (spec.projectLaunchBinding) assertResearchProjectGrantNotRevoked(spec.request.jobId, spec.grantSha256);
  witness.assertAuthorityBytes();
}
/** Registered workers keep their exact scoped receipt live in each trusted
 * process. A new process prepares a reader; it inherits no decision or permit. */
export async function prepareResearchRegisteredHandoffAuthority(jobId: string, startId: string,
  assertRoot: () => void = assertResearchInitialRoot, allowClosing = false): Promise<void> {
  assertRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(jobId), binding = initial.spec.registeredHandoff;
  if (initial.spec.startId !== startId || !binding) researchInvalid();
  const assertAuthorityBytes = await assertRegisteredResearchHandoffCurrent(binding, initial.spec.request, assertRoot);
  assertRoot(); assertResearchSharedHost();
  const fresh = researchCurrentStart(jobId), grantBytes = researchRead(join(researchJobAuthority(jobId), "grant.json"));
  if (!fresh.bytes.equals(initial.bytes) || fresh.directory !== initial.directory || (!allowClosing && existsSync(join(initial.directory, "closing.json"))) ||
      researchHash(grantBytes) !== initial.spec.grantSha256 ||
      JSON.stringify(parseResearchGrant(researchJson(grantBytes)).registeredHandoff) !== JSON.stringify(binding)) researchInvalid();
  assertAuthorityBytes();
  projectAuthorityWitnesses.set(initial.directory, { bytes: Buffer.from(initial.bytes), spec: JSON.stringify(initial.spec), assertAuthorityBytes });
}
/** The exclusive home record bounds later MiMo provider preparations to the
 * original allocation. A same-job path or a parsed caller plan is insufficient. */
export function assertResearchMimoProviderHome(spec: ResearchStartSpec, path: string): void {
  if (spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) return;
  const current = researchCurrentStart(spec.request.jobId);
  if (JSON.stringify(current.spec) !== JSON.stringify(spec) ||
      !/^mimo-[A-Za-z0-9]+\/codex-home$/.test(relative(join(spec.request.jobRootDir, "home"), path))) researchInvalid();
  const retained = researchRecord(researchJson(researchRead(join(current.directory, "mimo-home.json"))), "schemaVersion,specSha256,identity");
  const identity = researchRecord(retained.identity, "path,device,inode");
  if (retained.schemaVersion !== 1 || retained.specSha256 !== researchHash(current.bytes) || identity.path !== path ||
      JSON.stringify(identity) !== JSON.stringify(researchDirectoryIdentity(path))) researchInvalid();
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
      JSON.stringify(grant.projectLaunchBinding) !== JSON.stringify(spec.projectLaunchBinding) ||
      JSON.stringify(grant.workspaceDirectory) !== JSON.stringify(spec.workspaceDirectory)) researchInvalid();
  if ((spec.request.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) !== (grant.profileId === CodexProviderEgressProfileId.MimoTokenPlan)) researchInvalid();
  assertResearchMimoProfileMatch(spec.request, grant);
  assertResearchDirectory(spec.jobDirectory); assertResearchDirectory(spec.workspaceDirectory);
  const pins = join(researchJobAuthority(spec.request.jobId), "starts", spec.startId, "pins");
  assertResearchDirectory(spec.jobDirectory, join(pins, "job"));
  assertResearchDirectory(spec.workspaceDirectory, join(pins, "workspace"));
  assertRegisteredResearchHandoffPin(spec, join(pins, ".."));
  assertResearchProjectLaunchAuthorityBytes(spec);
  if (!researchRead(join(researchJobAuthority(spec.request.jobId), "grant.json")).equals(grantBytes)) researchInvalid();
}
function assertResearchMaterialBytes(spec: ResearchStartSpec, observe?: (role: ResearchMaterialRole, elapsedMs: number) => void): void {
  if (spec.runtimeDirectory !== installedResearchRuntimeDirectory()) researchInvalid();
  const assertDigest = (role: Exclude<ResearchMaterialRole, ResearchMaterialRole.Unknown>, read: () => string, expected: string): void => {
    try { if ((observe ? researchAdmissionMeasure(read, elapsed => observe(role, elapsed)) : read()) !== expected) researchInvalid(); }
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
  assertResearchProjectLaunchAuthorityBytes(initial.spec);
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
  await prepareResearchRegisteredHandoffAuthority(jobId, startId);
  return bindResearchRuntimeInternal(jobId, startId, initial.bytes);
}
export async function bindProjectResearchRuntime(jobId: string, startId: string): Promise<ResearchStartSpec> {
  const initial = researchCurrentStart(jobId);
  if (initial.spec.startId !== startId || !initial.spec.projectLaunchBinding) researchInvalid();
  await prepareResearchProjectLaunchAuthority(jobId, startId);
  return bindResearchRuntimeInternal(jobId, startId, initial.bytes);
}
function bindResearchRuntimeInternal(jobId: string, startId: string, registeredBytes?: Buffer): ResearchStartSpec {
  assertResearchInitialRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(jobId), { directory, spec, bytes } = initial;
  if (registeredBytes ? !registeredBytes.equals(bytes) : spec.registeredHandoff !== undefined || spec.projectLaunchBinding !== undefined) researchInvalid();
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
  readonly spec: ResearchStartSpec; readonly directory: string; readonly profileId: CodexProviderEgressProfileId; readonly assertCurrent: () => ResearchAdmissionTiming | void;
  readonly assertAuthorityCurrent: () => void; readonly assertInertAuthorityCurrent: () => void;
} {
  assertResearchInitialRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(identity.jobId), bindingBytes = researchRead(join(initial.directory, "binding.json"));
  const binding = readResearchStartBinding(initial.directory), { spec } = initial;
  if (spec.request.jobRootDir !== identity.jobRootDir || spec.request.workspacePath !== identity.workspacePath ||
      binding.specSha256 !== researchHash(initial.bytes) || binding.process.pid !== ownerPid || binding.service.unit !== spec.unit) researchInvalid();
  const observe = researchAdmissionObservation(initial.directory, initial.bytes, bindingBytes);
  // The confined startup holds bootstrap/auth while systemd may be busy
  // constructing its namespace. Poll fresh authority and kernel identity here;
  // this check grants no effect permission and deliberately avoids the manager.
  const assertInertAuthorityCurrent = (): void => {
    assertResearchCurrentAuthority(identity.jobId, initial, bindingBytes);
    const current = researchProcessIdentity(ownerPid);
    if (JSON.stringify(current) !== JSON.stringify(binding.process) ||
        researchProcessIdentity().controlGroup !== current.controlGroup) researchInvalid();
    assertResearchCurrentAuthority(identity.jobId, initial, bindingBytes);
  };
  const checkAuthorityCurrent = (observeService?: (elapsedMs: number) => void): void => observe(ResearchAdmissionFailureStage.AuthorityCurrent, () => {
    assertInertAuthorityCurrent();
    const service = observeService ? researchAdmissionMeasure(() => researchServiceIdentity(spec.unit), observeService) : researchServiceIdentity(spec.unit);
    assertResearchServiceOwner(binding.process, service, researchDescription(identity.jobId, researchHash(initial.bytes)));
    if (JSON.stringify(service) !== JSON.stringify(binding.service)) researchInvalid();
    assertInertAuthorityCurrent();
  });
  const assertAuthorityCurrent = (): void => checkAuthorityCurrent();
  // Full effect guards retain their existing meaning. Recheck mutable authority
  // after a slow byte walk as well, immediately before the caller's effect.
  const assertCurrent = (): ResearchAdmissionTiming | void => observe(ResearchAdmissionFailureStage.MaterialCurrent, () => {
    let admissionAuthorityElapsedMs = 0, admissionArtifactElapsedMs = 0, admissionExecutableElapsedMs = 0, samples = 0;
    let admissionAuthorityServiceElapsedMs = 0, serviceSamples = 0;
    const authority = (): void => { researchAdmissionMeasure(() => checkAuthorityCurrent(elapsed => {
      admissionAuthorityServiceElapsedMs += elapsed; serviceSamples++;
    }), elapsed => { admissionAuthorityElapsedMs += elapsed; samples++; }); };
    authority();
    assertResearchMaterialBytes(spec, (role, elapsed) => {
      if (role === ResearchMaterialRole.RuntimeArtifact) admissionArtifactElapsedMs += elapsed;
      else admissionExecutableElapsedMs += elapsed;
      samples++;
    });
    authority();
    if (samples === 5) return Object.freeze({ admissionAuthorityElapsedMs, admissionArtifactElapsedMs,
      admissionExecutableElapsedMs, ...(serviceSamples === 2 && Number.isFinite(admissionAuthorityServiceElapsedMs) &&
        admissionAuthorityServiceElapsedMs <= admissionAuthorityElapsedMs ? { admissionAuthorityServiceElapsedMs } : {}) });
  });
  const profileId = parseResearchGrant(researchJson(researchRead(join(researchJobAuthority(identity.jobId), "grant.json")))).profileId;
  assertCurrent();
  return Object.freeze({ spec, directory: initial.directory, profileId, assertCurrent, assertAuthorityCurrent, assertInertAuthorityCurrent });
}

export function researchProviderAdmissionGuard(factory: CodexAppServerProcessFactory | undefined): (() => ResearchAdmissionTiming | void) | undefined {
  return factory ? factoryGuards.get(factory) : undefined;
}
export function admitResearchRuntime(identity: HostedTestEgressIdentity): CodexProviderEgressProfileId | undefined {
  if (!researchUnitFromCurrentProcess()) return undefined;
  return captureResearchRuntime(identity).profileId;
}
export function admitResearchProcessFactory(identity: HostedTestEgressIdentity): CodexAppServerProcessFactory {
  const captured = captureResearchRuntime(identity);
  const factory = admittedResearchCodexProcessFactory({ jobId: identity.jobId,
    ...(captured.spec.request.hostedProfile === HostedMimoProfile.CodingV1
      ? { hostedProfile: HostedMimoProfile.CodingV1 } : {}),
    launchValidation: { codexBinaryPath: captured.spec.request.codexBinaryPath,
      workspacePath: identity.workspacePath, homeRoot: join(identity.jobRootDir, "home") },
    launcherPath: join(captured.spec.runtimeDirectory, "host-integration", "research-provider-launch.mjs"),
    submit: (unit, effect) => {
      captured.assertCurrent();
      // Reserve space for reservation, ownership, submission and cancel facts;
      // helpers cannot grow the existing 1,024-file bound after admission.
      if (researchProviderUnits(captured.directory).length >= researchProviderReservationLimit) researchInvalid();
      researchPublish(join(captured.directory, "providers", unit + ".json"), {
        schemaVersion: 1, unit, runtimeUnit: captured.spec.unit,
        specSha256: researchHash(researchRead(join(captured.directory, "spec.json"))),
        description: `subscription-runtime-research-provider:${captured.spec.startId}:${unit}`,
      }, true);
      return effect();
    },
    signal: (unit, signal) => signalResearchProvider(captured.directory, unit, signal),
  });
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
