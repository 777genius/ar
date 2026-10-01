import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { admittedResearchCodexProcessFactory, CodexModelBackend, CodexProviderEgressProfileId,
  type CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedTestEgressIdentity } from "./hosted-test-egress-contract";
import type { CodexWorkerExecutionEngine } from "./file-backend-codex-runtime-factory";
import { parseResearchGrant, parseResearchStartSpec, type ResearchStartBinding, type ResearchStartSpec } from "./research-launch-contract";
import { assertResearchDirectory, researchArtifactDigest, researchAuthorityRoot, researchHash,
  researchId, researchInvalid, researchJson, researchName, researchPublish, researchRead, researchRecord, researchCustody, researchPath } from "./research-launch-files";
import { assertResearchInitialRoot, assertResearchServiceOwner, assertResearchSharedHost,
  researchDescription, researchExecutableDigest, researchProcessIdentity, researchServiceIdentity,
  researchUnitFromCurrentProcess } from "./research-launch-host";
import { researchProviderUnits, signalResearchProvider } from "./research-launch-lifecycle";

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
export function assertResearchStartMaterial(spec: ResearchStartSpec): void {
  assertResearchInitialRoot(); assertResearchSharedHost();
  researchCustody(spec.request.authRootDir);
  if (spec.runtimeDirectory !== installedResearchRuntimeDirectory() ||
      researchArtifactDigest(spec.runtimeDirectory) !== spec.artifactSha256 ||
      researchExecutableDigest(process.execPath) !== spec.nodeSha256 ||
      researchExecutableDigest(spec.request.codexBinaryPath) !== spec.codexSha256) researchInvalid();
  const grantBytes = researchRead(join(researchJobAuthority(spec.request.jobId), "grant.json"));
  const grant = parseResearchGrant(researchJson(grantBytes));
  if (researchHash(grantBytes) !== spec.grantSha256 || grant.jobId !== spec.request.jobId ||
      grant.jobRootDir !== spec.request.jobRootDir || grant.workspacePath !== spec.request.workspacePath ||
      JSON.stringify(grant.jobDirectory) !== JSON.stringify(spec.jobDirectory) ||
      JSON.stringify(grant.workspaceDirectory) !== JSON.stringify(spec.workspaceDirectory)) researchInvalid();
  assertResearchDirectory(spec.jobDirectory); assertResearchDirectory(spec.workspaceDirectory);
  const pins = join(researchJobAuthority(spec.request.jobId), "starts", spec.startId, "pins");
  assertResearchDirectory(spec.jobDirectory, join(pins, "job"));
  assertResearchDirectory(spec.workspaceDirectory, join(pins, "workspace"));
}
/** Capture real MainPID/birth/boot/InvocationID only from the new individually
 * owned service. The explicit initial-root operator staged its closed spec. */
export function bindResearchRuntime(jobId: string, startId: string): ResearchStartSpec {
  assertResearchInitialRoot(); assertResearchSharedHost();
  const { directory, spec, bytes } = researchCurrentStart(jobId);
  if (spec.startId !== startId || existsSync(join(directory, "closing.json"))) researchInvalid();
  assertResearchStartMaterial(spec);
  const identity = researchProcessIdentity(), service = researchServiceIdentity(spec.unit);
  assertResearchServiceOwner(identity, service, researchDescription(jobId, researchHash(bytes)));
  researchPublish(join(directory, "binding.json"), {
    schemaVersion: 1, specSha256: researchHash(bytes), process: identity, service,
  } satisfies ResearchStartBinding, true);
  return spec;
}
export function captureResearchRuntime(identity: HostedTestEgressIdentity, ownerPid = process.pid): {
  readonly spec: ResearchStartSpec; readonly directory: string; readonly assertCurrent: () => void;
} {
  assertResearchInitialRoot(); assertResearchSharedHost();
  const initial = researchCurrentStart(identity.jobId), bindingBytes = researchRead(join(initial.directory, "binding.json"));
  const binding = readResearchStartBinding(initial.directory), { spec } = initial;
  if (spec.request.jobRootDir !== identity.jobRootDir || spec.request.workspacePath !== identity.workspacePath ||
      binding.specSha256 !== researchHash(initial.bytes) || binding.process.pid !== ownerPid || binding.service.unit !== spec.unit) researchInvalid();
  const assertCurrent = (): void => {
    const fresh = researchCurrentStart(identity.jobId);
    if (existsSync(join(initial.directory, "closing.json")) || fresh.directory !== initial.directory || !fresh.bytes.equals(initial.bytes) ||
        !researchRead(join(initial.directory, "binding.json")).equals(bindingBytes)) researchInvalid();
    assertResearchStartMaterial(spec);
    const current = researchProcessIdentity(ownerPid), service = researchServiceIdentity(spec.unit);
    assertResearchServiceOwner(current, service, researchDescription(identity.jobId, researchHash(initial.bytes)));
    if (JSON.stringify(current) !== JSON.stringify(binding.process) || JSON.stringify(service) !== JSON.stringify(binding.service) ||
        researchProcessIdentity().controlGroup !== current.controlGroup) researchInvalid();
  };
  assertCurrent();
  return Object.freeze({ spec, directory: initial.directory, assertCurrent });
}

export function researchProviderAdmissionGuard(factory: CodexAppServerProcessFactory | undefined): (() => void) | undefined {
  return factory ? factoryGuards.get(factory) : undefined;
}
export function admitResearchRuntime(identity: HostedTestEgressIdentity): CodexProviderEgressProfileId | undefined {
  if (!researchUnitFromCurrentProcess()) return undefined;
  captureResearchRuntime(identity);
  return CodexProviderEgressProfileId.PublicResearchV1;
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
  return factory;
}
/** A marker cannot select this branch, but also cannot hide an actual service. */
export function assertResearchRuntimeEngine(input: { executionEngine?: CodexWorkerExecutionEngine; modelBackend?: CodexModelBackend }): void {
  if ((input.executionEngine ?? "app-server-goal") !== "app-server-goal" ||
      (input.modelBackend !== undefined && input.modelBackend !== CodexModelBackend.OpenAiChatGpt)) researchInvalid();
}
