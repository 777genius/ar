import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CodexModelBackend, HostedMimoProfile } from "@vioxen/subscription-runtime/provider-codex";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { parseStoredCodexGoalJobManifest } from "./codex-goal-jobs";
import { parseCodexGoalProjectAccessScope } from "./codex-goal-access-plan";
import { parseResearchGrant, assertResearchMimoProfileMatch, researchHashRequest, researchRunConfig } from "./research-launch-contract";
import { installedResearchRuntimeDirectory, researchJobAuthority, researchCurrentStart, readResearchStartBinding } from "./research-launch-admission";
import { researchProviderUnits, terminalResearchStart, readResearchProviderReservation } from "./research-launch-lifecycle";
import { assertResearchInitialRoot, parseResearchInitialHostContext, researchCommand, researchControlGroup, researchDescription, researchProcessIdentity,
  type ResearchProcessIdentity, type ResearchServiceIdentity } from "./research-launch-host";
import { assertResearchMimoResultDirectories, readResearchMimoCandidate } from "./research-mimo-worker-result";
import { assertRegisteredResearchHandoffPin, prepareRegisteredResearchTerminalAuthority } from "./research-registered-handoff";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import { researchArtifactDigest, researchFileDigest, researchHash, researchInvalid, researchJson, researchPublish, researchRead, researchRecord,
  researchCustody, researchDirectoryIdentity, assertResearchDirectory } from "./research-launch-files";
import { handoffPreservationBudget } from "./codex-goal-handoff-preservation-budget";
import { CODEX_GOAL_DURABLE_HANDOFF_PACKET_SCHEMA, durableCodexGoalHandoffPacketFiles, type DurableCodexGoalHandoffPacketManifest } from "./codex-goal-durable-handoff-packet";
import { assertSafeHandoffRelativePath } from "./codex-goal-handoff-artifact-guards";

const digest = (value: unknown): string => researchHash(JSON.stringify(value));
const intentName = "terminal-handoff-repair-intent.json", receiptName = "terminal-handoff-repair.json";
enum StoppedProviderReleaseKind { BeforeProvider = "stopped-before-provider" }
const stoppedIntentName = "stopped-before-provider-release-intent.json", stoppedReceiptName = "stopped-before-provider-release.json";
function optionalTerminalRepairBytes(path: string, privateFile = true): Buffer | undefined {
  try { return researchRead(path, privateFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
/** Physical closure is required in addition to the root-private original owner.
 * A reused PID is uncertainty too; neither expiry nor unit absence releases it. */
function assertColdOwner(unit: string, owner: { process: ResearchProcessIdentity; service: ResearchServiceIdentity }, description: string): void {
  const p = owner.process, s = owner.service, host = researchProcessIdentity();
  parseResearchInitialHostContext({ bootId: p.bootId, machineId: p.machineId, namespaces: p.namespaces });
  if (!Number.isSafeInteger(p.pid) || p.pid < 1 || typeof p.birthTicks !== "string" || !/^[1-9][0-9]*$/.test(p.birthTicks) ||
      p.machineId !== host.machineId || p.bootId !== host.bootId || s.mainPid !== p.pid || s.unit !== unit ||
      (["user", "pid", "net"] as const).some(kind => p.namespaces[kind] !== host.namespaces[kind]) ||
      !/^[a-f0-9]{32}$/.test(s.invocationId) || s.description !== description ||
      p.controlGroup !== researchControlGroup(unit) || s.controlGroup !== p.controlGroup || !/^[a-f0-9]{64}$/.test(s.fragmentSha256)) researchInvalid();
  try { lstatSync(`/proc/${p.pid}`); researchInvalid(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // The queued-job field is the same manager fact `list-jobs` reported per unit,
  // read in this one show snapshot alongside the unit's own state fields.
  const fields = Object.fromEntries(researchCommand("/usr/bin/systemctl", ["show", unit, "--no-pager",
    "--property=Id,LoadState,ActiveState,MainPID,ControlGroup,InvocationID,Description,FragmentPath,DropInPaths,KillMode,Job"])
    .trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.Id !== unit || fields.MainPID !== "0" || !["inactive", "failed"].includes(fields.ActiveState ?? "") ||
      !["loaded", "not-found"].includes(fields.LoadState ?? "")) researchInvalid();
  if (fields.LoadState === "loaded" && (fields.Description !== description || fields.InvocationID !== s.invocationId ||
      fields.FragmentPath !== `/run/systemd/transient/${unit}` || fields.DropInPaths !== "" || fields.KillMode !== "control-group" ||
      researchHash(researchRead(fields.FragmentPath, false)) !== s.fragmentSha256)) researchInvalid();
  if (fields.ControlGroup !== undefined && fields.ControlGroup !== "" && fields.ControlGroup !== p.controlGroup) researchInvalid();
  const group = "/sys/fs/cgroup" + p.controlGroup;
  let present = true;
  try { const stat = lstatSync(group); if (!stat.isDirectory() || stat.isSymbolicLink()) researchInvalid(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; present = false; }
  if (present) {
    const rows = readFileSync(join(group, "cgroup.events"), "utf8").split("\n").filter(row => /^populated\s/.test(row));
    if (rows.length !== 1 || rows[0] !== "populated 0") researchInvalid();
  }
  if (!Object.hasOwn(fields, "Job") || (fields.Job !== "" && fields.Job !== "no")) researchInvalid();
}
function retainedInputs(current: ReturnType<typeof researchCurrentStart>, candidate = true) {
  const { spec, directory } = current, root = researchJobAuthority(spec.request.jobId);
  const starts = readdirSync(join(root, "starts")).sort();
  if (starts.length > 1024 || !starts.includes(spec.startId) || starts.some(id => !/^[a-f0-9-]{36}$/.test(id))) researchInvalid();
  const paths = [join(root, "grant.json"), join(root, "project-worker-request.json"), join(directory, "spec.json"),
    join(directory, "binding.json"), ...(candidate ? [join(directory, "mimo-candidate.json")] : [])];
  const units = researchProviderUnits(directory), providerNames = readdirSync(join(directory, "providers")).sort();
  for (const unit of units) for (const name of providerNames) {
    if (name.startsWith(unit + ".")) paths.push(join(directory, "providers", name));
  }
  // Older registered starts seal the normalized request in spec/grant and do
  // not publish the later project adapter's optional standalone request copy.
  const rows = paths.map((path, index) => ({ path, sha256: index === 1
    ? ((bytes => bytes ? researchHash(bytes) : null)(optionalTerminalRepairBytes(path))) : researchHash(researchRead(path)) }));
  const grant = parseResearchGrant(researchJson(researchRead(paths[0]!)));
  if (rows[0]!.sha256 !== spec.grantSha256 || (rows[1]!.sha256 !== null && rows[1]!.sha256 !== spec.requestSha256) ||
      researchHashRequest(spec.request) !== spec.registeredHandoff?.requestSha256 ||
      grant.jobId !== spec.request.jobId || grant.jobRootDir !== spec.request.jobRootDir || grant.workspacePath !== spec.request.workspacePath ||
      !isDeepStrictEqual(grant.registeredHandoff, spec.registeredHandoff) || !isDeepStrictEqual(grant.jobDirectory, spec.jobDirectory) ||
      !isDeepStrictEqual(grant.workspaceDirectory, spec.workspaceDirectory)) researchInvalid();
  assertResearchMimoProfileMatch(spec.request, grant);
  const assertCurrent = (): void => {
    assertResearchInitialRoot(true);
    for (const row of rows) if (row.sha256 === null ? optionalTerminalRepairBytes(row.path) !== undefined
      : researchHash(researchRead(row.path)) !== row.sha256) researchInvalid();
    if (!isDeepStrictEqual(researchProviderUnits(directory), units) || !isDeepStrictEqual(readdirSync(join(root, "starts")).sort(), starts) ||
        !isDeepStrictEqual(readdirSync(join(directory, "providers")).sort(), providerNames)) researchInvalid();
    assertRegisteredResearchHandoffPin(spec, directory);
    if (candidate) { assertResearchMimoResultDirectories(current); readResearchMimoCandidate(current); }
    const owner = readResearchStartBinding(directory);
    if (owner.specSha256 !== researchHash(current.bytes)) researchInvalid();
    assertColdOwner(spec.unit, owner, researchDescription(spec.request.jobId, owner.specSha256));
    for (const unit of units) {
      const reservation = readResearchProviderReservation(directory, unit);
      const provider = researchRecord(researchJson(researchRead(join(directory, "providers", unit + ".owner.json"))), "schemaVersion,process,service");
      if (provider.schemaVersion !== 1 || reservation.specSha256 !== owner.specSha256) researchInvalid();
      researchRecord(provider.process, "pid,birthTicks,bootId,machineId,controlGroup,namespaces");
      researchRecord(provider.service, "unit,mainPid,controlGroup,invocationId,description,fragmentSha256");
      assertColdOwner(unit, provider as unknown as { process: ResearchProcessIdentity; service: ResearchServiceIdentity }, reservation.description);
    }
  };
  assertCurrent(); return { rows, starts, assertCurrent };
}
/** The complete record binds both canonical job files and every packet artifact;
 * changed bytes can never be read as release, even after a successful unlink. */
function publishedInputs(current: ReturnType<typeof researchCurrentStart>) {
  const path = join(current.directory, "mimo-publication.json"), bytes = researchRead(path);
  const publication = researchRecord(researchJson(bytes), "schemaVersion,specSha256,candidateSha256,result");
  const candidate = readResearchMimoCandidate(current), result = publication.result as typeof candidate;
  if (publication.schemaVersion !== 1 || publication.specSha256 !== researchHash(current.bytes) ||
      publication.candidateSha256 !== researchHash(researchRead(join(current.directory, "mimo-candidate.json"))) ||
      result.status !== candidate.status || result.taskId !== candidate.taskId || result.runId !== candidate.runId) researchInvalid();
  const rows = [{ path, sha256: researchHash(bytes) }];
  const job = join(current.directory, "pins/job"), resultBytes = researchRead(join(job, current.spec.request.taskId + ".latest-result.json"), false);
  if (!isDeepStrictEqual(researchJson(resultBytes), result)) researchInvalid();
  rows.push({ path: join(job, current.spec.request.taskId + ".latest-result.json"), sha256: researchHash(resultBytes) });
  const progress = join(job, current.spec.request.taskId + ".progress.json"), progressBytes = researchRead(progress, false);
  const progressValue = researchJson(progressBytes);
  if (!isDeepStrictEqual(progressValue, { schemaVersion: 1, taskId: result.taskId,
    status: result.status === "done" ? "completed" : result.status, updatedAt: result.updatedAt, pid: 0 })) {
    // Supported Stop may follow an already released partial/failed publication.
    // Preserve that independent control observation verbatim in this receipt;
    // neither its timestamp nor its status replaces the authenticated result.
    const stopped = researchRecord(progressValue, "schemaVersion,taskId,updatedAt,status");
    const time = typeof stopped.updatedAt === "string" ? Date.parse(stopped.updatedAt) : NaN;
    if ((result.status !== "partial" && result.status !== "failed") || stopped.schemaVersion !== 1 ||
        stopped.taskId !== result.taskId || stopped.status !== "stopped" || !Number.isFinite(time) ||
        new Date(time).toISOString() !== stopped.updatedAt ||
        optionalTerminalRepairBytes(join(researchJobAuthority(current.spec.request.jobId), "active.json")) ||
        !terminalResearchStart(current.spec.request.jobId).bytes.equals(current.bytes)) researchInvalid();
  }
  rows.push({ path: progress, sha256: researchHash(progressBytes) });
  const artifacts = result.artifacts ?? [];
  if (artifacts.length > 128) researchInvalid();
  for (const artifact of artifacts) {
    if (!artifact.path || !artifact.sha256 || !artifact.path.startsWith(current.spec.registeredHandoff!.durableDirectory.path + "/")) researchInvalid();
    const artifactPath = artifact.kind === "handoff_packet" ? join(artifact.path, "manifest.json") : artifact.path;
    if (researchFileDigest(artifactPath, { maxBytes: handoffPreservationBudget.packetFileBytes, deadline: performance.now() + 30_000,
      cache: new Map(), cacheEntries: 1 }) !== artifact.sha256) researchInvalid();
    rows.push({ path: artifactPath, sha256: artifact.sha256 });
  }
  const packet = result.details?.handoffPacketPath, packetSha = result.details?.handoffManifestSha256;
  if (packet !== undefined || packetSha !== undefined) {
    if (typeof packet !== "string" || typeof packetSha !== "string" ||
        !packet.startsWith(current.spec.registeredHandoff!.durableDirectory.path + "/") || researchHash(researchRead(join(packet, "manifest.json"), false)) !== packetSha) researchInvalid();
    rows.push({ path: join(packet, "manifest.json"), sha256: packetSha });
    const manifest = researchJson(researchRead(join(packet, "manifest.json"), false)) as DurableCodexGoalHandoffPacketManifest;
    if (manifest.schema !== CODEX_GOAL_DURABLE_HANDOFF_PACKET_SCHEMA || manifest.schemaVersion !== 1 ||
        manifest.workerJobId !== current.spec.request.jobId || manifest.taskId !== current.spec.request.taskId) researchInvalid();
    for (const { descriptor, maxBytes } of durableCodexGoalHandoffPacketFiles(manifest)) {
      const path = join(packet, assertSafeHandoffRelativePath(descriptor.path)), stat = lstatSync(path);
      if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0 || stat.size !== descriptor.byteLength ||
          researchFileDigest(path, { maxBytes, expected: stat, deadline: performance.now() + 30_000,
            cache: new Map(), cacheEntries: 1 }) !== descriptor.sha256) researchInvalid();
      rows.push({ path, sha256: descriptor.sha256 });
    }
  }
  return rows;
}
/** Ordinary closure facts only. Historical controller policy is deliberately
 * absent: a sealed terminal writer is independent of a later caller's rights. */
export function prepareRegisteredCodingTerminalObservation(manifest: CodexGoalJobManifest) {
  assertResearchInitialRoot(true);
  const current = terminalResearchStart(manifest.jobId), { spec } = current, binding = spec.registeredHandoff;
  if (!binding || spec.projectLaunchBinding || spec.request.hostedProfile !== HostedMimoProfile.CodingV1 ||
      spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan ||
      digest(parseStoredCodexGoalJobManifest(manifest)) !== binding.manifestSha256) researchInvalid();
  const root = researchJobAuthority(manifest.jobId);
  const absent = [join(root, "active.json"), join(root, intentName), join(root, stoppedIntentName),
    join(current.directory, receiptName), join(current.directory, stoppedReceiptName), join(current.directory, "unsubmitted-abort.json")];
  const retained = retainedInputs(current);
  const published = publishedInputs(current);
  const terminalPath = join(root, "last-terminal.json"), closingPath = join(current.directory, "closing.json");
  const terminal = researchRead(terminalPath), closing = researchRead(closingPath);
  if (!isDeepStrictEqual(researchJson(closing), { schemaVersion: 1, specSha256: researchHash(current.bytes) })) researchInvalid();
  const assertCurrent = (): void => {
    assertResearchInitialRoot(true);
    if (absent.some(path => optionalTerminalRepairBytes(path) !== undefined) ||
        !researchRead(terminalPath).equals(terminal) || !researchRead(closingPath).equals(closing) ||
        !terminalResearchStart(manifest.jobId).bytes.equals(current.bytes)) researchInvalid();
    retained.assertCurrent();
    if (!isDeepStrictEqual(publishedInputs(current), published)) researchInvalid();
    retained.assertCurrent();
    if (absent.some(path => optionalTerminalRepairBytes(path) !== undefined) ||
        !researchRead(terminalPath).equals(terminal) || !researchRead(closingPath).equals(closing)) researchInvalid();
  };
  assertCurrent();
  return { current, inputs: retained.rows, starts: retained.starts,
    providerUnits: researchProviderUnits(current.directory).sort(),
    providerFiles: readdirSync(join(current.directory, "providers")).sort(), published,
    terminalSlotSha256: researchHash(terminal), closingSha256: researchHash(closing), assertCurrent };
}
export async function prepareResearchTerminalHandoffRepair(current: ReturnType<typeof researchCurrentStart>, historicalScope: unknown) {
  assertResearchInitialRoot(true);
  const { spec } = current, binding = spec.registeredHandoff;
  if (!binding || spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan) researchInvalid();
  const producer = installedResearchRuntimeDirectory(), producerSha = researchArtifactDigest(producer);
  const qualify = (): void => { assertQualifiedResearchRuntimeArtifact(producer, producerSha);
    assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256); };
  qualify();
  const retained = retainedInputs(current), scope = parseCodexGoalProjectAccessScope(historicalScope);
  const authority = await prepareRegisteredResearchTerminalAuthority(binding, spec.request, scope);
  const intentPath = join(researchJobAuthority(spec.request.jobId), intentName), receiptPath = join(current.directory, receiptName);
  const intent = { schemaVersion: 1, jobId: spec.request.jobId, startId: spec.startId, specSha256: researchHash(current.bytes),
    historicalScope: scope, repairScopeSha256: digest(authority.scope), producerRuntimeDirectory: producer, producerArtifactSha256: producerSha,
    originalRuntimeDirectory: spec.runtimeDirectory, originalArtifactSha256: spec.artifactSha256, inputs: retained.rows, starts: retained.starts };
  const assertCurrent = (): void => { qualify(); retained.assertCurrent(); authority.assertCurrent();
    const previous = optionalTerminalRepairBytes(intentPath);
    const closing = optionalTerminalRepairBytes(join(current.directory, "closing.json"));
    if ((previous && !isDeepStrictEqual(researchJson(previous), intent)) ||
        (closing && !isDeepStrictEqual(researchJson(closing), { schemaVersion: 1, specSha256: researchHash(current.bytes) }))) researchInvalid(); };
  return { assertCurrent, assertPublished: (): void => { assertCurrent(); publishedInputs(current); assertCurrent(); },
    withPublication: async <T>(effect: () => Promise<T>): Promise<T> => await authority.withPublication(async () => {
      assertCurrent();
      // The job mutation + current publication fences provide the absent/same
      // CAS. Atomic durable rename prevents a torn complete record on crash.
      if (!optionalTerminalRepairBytes(intentPath)) researchPublish(intentPath, intent);
      if (!optionalTerminalRepairBytes(join(current.directory, "closing.json"))) researchPublish(join(current.directory, "closing.json"),
        { schemaVersion: 1, specSha256: researchHash(current.bytes) });
      assertCurrent(); const result = await effect(); assertCurrent();
      if (optionalTerminalRepairBytes(join(researchJobAuthority(spec.request.jobId), "active.json"))) researchInvalid();
      const terminal = terminalResearchStart(spec.request.jobId);
      if (!terminal.bytes.equals(current.bytes)) researchInvalid();
      const release = researchRead(join(researchJobAuthority(spec.request.jobId), "last-terminal.json"));
      const receipt = { schemaVersion: 1, intentSha256: researchHash(researchRead(intentPath)), releaseSha256: researchHash(release), published: publishedInputs(current) };
      const previous = optionalTerminalRepairBytes(receiptPath);
      if (previous && !isDeepStrictEqual(researchJson(previous), receipt)) researchInvalid();
      assertCurrent(); if (!previous) researchPublish(receiptPath, receipt); assertCurrent();
      return result;
    }),
  };
}
/** Present incomplete/invalid repair authority is Unknown, never legacy fallback.
 * Every read repeats the same immutable seals and physical owner closure. */
export async function prepareResearchTerminalRepairRelease(manifest: CodexGoalJobManifest): Promise<(() => void) | undefined> {
  const root = researchJobAuthority(manifest.jobId), stopped = optionalTerminalRepairBytes(join(root, stoppedIntentName));
  // Marker discovery must not run current-version lifecycle reconciliation for
  // an untouched foreign origin. Its own qualified reader still owns that path.
  const terminal = stopped ? undefined : optionalTerminalRepairBytes(join(root, "last-terminal.json"));
  const slot = terminal && researchJson(terminal) as { startId?: unknown } | undefined;
  const stoppedReceipt = slot && typeof slot.startId === "string" && /^[a-f0-9-]{36}$/.test(slot.startId)
    ? optionalTerminalRepairBytes(join(root, "starts", slot.startId, stoppedReceiptName)) : undefined;
  if (stopped || stoppedReceipt) {
    return await prepareStoppedProviderReleaseReader(manifest, stopped);
  }
  const intentPath = join(researchJobAuthority(manifest.jobId), intentName), bytes = optionalTerminalRepairBytes(intentPath);
  if (!bytes) return;
  const r = researchRecord(researchJson(bytes), "schemaVersion,jobId,startId,specSha256,historicalScope,repairScopeSha256,producerRuntimeDirectory,producerArtifactSha256,originalRuntimeDirectory,originalArtifactSha256,inputs,starts");
  if (r.schemaVersion !== 1 || r.jobId !== manifest.jobId || typeof r.producerRuntimeDirectory !== "string" || typeof r.producerArtifactSha256 !== "string") researchInvalid();
  assertQualifiedResearchRuntimeArtifact(r.producerRuntimeDirectory, r.producerArtifactSha256);
  const current = terminalResearchStart(manifest.jobId), binding = current.spec.registeredHandoff;
  if (!binding || digest(parseStoredCodexGoalJobManifest(manifest)) !== binding.manifestSha256 || r.startId !== current.spec.startId ||
      r.specSha256 !== researchHash(current.bytes) || r.originalRuntimeDirectory !== current.spec.runtimeDirectory || r.originalArtifactSha256 !== current.spec.artifactSha256) researchInvalid();
  const retained = retainedInputs(current);
  const authority = await prepareRegisteredResearchTerminalAuthority(binding, current.spec.request, r.historicalScope);
  if (digest(authority.scope) !== r.repairScopeSha256 || !isDeepStrictEqual(retained.rows, r.inputs) || !isDeepStrictEqual(retained.starts, r.starts)) researchInvalid();
  const receiptPath = join(current.directory, receiptName), receiptBytes = researchRead(receiptPath);
  const receipt = researchRecord(researchJson(receiptBytes), "schemaVersion,intentSha256,releaseSha256,published");
  const read = (): void => {
    assertResearchInitialRoot(true); authority.assertCurrent(); retained.assertCurrent();
    assertQualifiedResearchRuntimeArtifact(r.producerRuntimeDirectory as string, r.producerArtifactSha256 as string);
    assertQualifiedResearchRuntimeArtifact(current.spec.runtimeDirectory, current.spec.artifactSha256);
    if (optionalTerminalRepairBytes(join(researchJobAuthority(manifest.jobId), "active.json")) ||
        digest(parseStoredCodexGoalJobManifest(manifest)) !== binding.manifestSha256 ||
        !terminalResearchStart(manifest.jobId).bytes.equals(current.bytes) || !researchRead(intentPath).equals(bytes) ||
        !researchRead(receiptPath).equals(receiptBytes) || receipt.schemaVersion !== 1 || receipt.intentSha256 !== researchHash(bytes) ||
        receipt.releaseSha256 !== researchHash(researchRead(join(researchJobAuthority(manifest.jobId), "last-terminal.json"))) ||
        !isDeepStrictEqual(receipt.published, publishedInputs(current))) researchInvalid();
    if (!isDeepStrictEqual(researchJson(researchRead(join(current.directory, "closing.json"))),
      { schemaVersion: 1, specSha256: researchHash(current.bytes) })) researchInvalid();
    authority.assertCurrent();
  };
  read(); return read;
}

/** This historical route always durably reserved a provider before spawning its
 * native model process. Empty providers is evidence only for these exact bytes,
 * never a general claim that an arbitrary stopped runtime made no model call. */
async function stoppedProviderReleaseContext(current: ReturnType<typeof researchCurrentStart>, historicalScope: unknown,
  producer = { directory: installedResearchRuntimeDirectory(), artifact: researchArtifactDigest(installedResearchRuntimeDirectory()) }) {
  const { spec, directory } = current, root = researchJobAuthority(spec.request.jobId), binding = spec.registeredHandoff;
  const original = "/opt/subscription-runtime/releases/2a9ca732123b8b0054dae1a38f754680272de77e";
  if (!binding || spec.runtimeDirectory !== original ||
      spec.artifactSha256 !== "ebaf4fd6ff74224d247b35f0f5630735cd6881ab663bdfcefcede3717d8bd69c" ||
      spec.request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || spec.request.hostedProfile !== HostedMimoProfile.CodingV1 ||
      researchRunConfig(spec.request).executionEngine !== "app-server") researchInvalid();
  const qualify = (): void => {
    assertQualifiedResearchRuntimeArtifact(original, spec.artifactSha256);
    assertQualifiedResearchRuntimeArtifact(producer.directory, producer.artifact);
    if (researchHash(researchRead(join(original, "host-integration/research-runtime-launch.mjs"), false)) !==
        "4163a3e34967eb1207c66685f61e7b07e11aecefb535eaaf645d65c199ef664a") researchInvalid();
  };
  qualify();
  const retained = retainedInputs(current, false), scope = parseCodexGoalProjectAccessScope(historicalScope);
  const providerPath = join(directory, "providers"); researchCustody(providerPath, true);
  const providerDirectory = researchDirectoryIdentity(providerPath);
  const authority = await prepareRegisteredResearchTerminalAuthority(binding, spec.request, scope);
  const progress = join(spec.request.jobRootDir, spec.request.taskId + ".progress.json");
  const evidence = [join(root, "last-terminal.json"), join(directory, "closing.json"), progress]
    .map(path => ({ path, bytes: researchRead(path, path !== progress) }));
  const p = researchJson(evidence[2]!.bytes) as { taskId?: unknown; status?: unknown };
  if (p.taskId !== spec.request.taskId || p.status !== "stopped" ||
      !isDeepStrictEqual(researchJson(evidence[1]!.bytes), { schemaVersion: 1, specSha256: researchHash(current.bytes) })) researchInvalid();
  const latestResult = join(spec.request.jobRootDir, spec.request.taskId + ".latest-result.json");
  const absent = [join(root, "active.json"), join(directory, "mimo-candidate.json"), join(directory, "mimo-publication.json"),
    join(directory, "unsubmitted-abort.json"), join(root, intentName), join(directory, receiptName),
    latestResult];
  const intent = { schemaVersion: 1, kind: StoppedProviderReleaseKind.BeforeProvider,
    jobId: spec.request.jobId, startId: spec.startId, specSha256: researchHash(current.bytes), requestSha256: spec.requestSha256,
    historicalScope: scope, repairScopeSha256: digest(authority.scope), producerRuntimeDirectory: producer.directory,
    producerArtifactSha256: producer.artifact, originalRuntimeDirectory: original, originalArtifactSha256: spec.artifactSha256,
    inputs: retained.rows, starts: retained.starts, providerDirectory,
    evidence: evidence.map(row => ({ path: row.path, sha256: researchHash(row.bytes) })) };
  const assertCurrent = (): void => {
    assertResearchInitialRoot(true); qualify(); retained.assertCurrent(); authority.assertCurrent();
    researchCustody(providerPath, true); assertResearchDirectory(providerDirectory);
    if (!terminalResearchStart(spec.request.jobId).bytes.equals(current.bytes) ||
        readdirSync(providerPath).length !== 0 || absent.some(path => optionalTerminalRepairBytes(path, path !== latestResult) !== undefined) ||
        evidence.some(row => !researchRead(row.path, row.path !== progress).equals(row.bytes))) researchInvalid();
    const previous = optionalTerminalRepairBytes(join(root, stoppedIntentName));
    if (previous && !isDeepStrictEqual(researchJson(previous), intent)) researchInvalid();
    authority.assertCurrent();
  };
  assertCurrent(); return { intent, assertCurrent, authority };
}

/** Explicit reservation release only: native execution happened, but the exact
 * reviewed route never submitted a provider. No result/progress/workspace or
 * capacity bytes are written, and existing dirty-output debt remains visible. */
export async function releaseResearchStoppedBeforeProvider(current: ReturnType<typeof researchCurrentStart>, historicalScope: unknown) {
  const context = await stoppedProviderReleaseContext(current, historicalScope);
  return await context.authority.withPublication(async () => {
    context.assertCurrent();
    const intentPath = join(researchJobAuthority(current.spec.request.jobId), stoppedIntentName);
    const receiptPath = join(current.directory, stoppedReceiptName);
    if (!optionalTerminalRepairBytes(intentPath)) {
      if (optionalTerminalRepairBytes(receiptPath)) researchInvalid();
      researchPublish(intentPath, context.intent);
    }
    context.assertCurrent();
    const receipt = { schemaVersion: 1, kind: StoppedProviderReleaseKind.BeforeProvider,
      intentSha256: researchHash(researchRead(intentPath)) };
    const previous = optionalTerminalRepairBytes(receiptPath);
    if (previous && !isDeepStrictEqual(researchJson(previous), receipt)) researchInvalid();
    if (!previous) researchPublish(receiptPath, receipt);
    context.assertCurrent();
    return { jobId: current.spec.request.jobId, startId: current.spec.startId, reservationReleased: true as const };
  });
}

async function prepareStoppedProviderReleaseReader(manifest: CodexGoalJobManifest, intentBytes: Buffer | undefined) {
  if (!intentBytes) researchInvalid();
  const r = researchRecord(researchJson(intentBytes), "schemaVersion,kind,jobId,startId,specSha256,requestSha256,historicalScope,repairScopeSha256,producerRuntimeDirectory,producerArtifactSha256,originalRuntimeDirectory,originalArtifactSha256,inputs,starts,providerDirectory,evidence");
  if (typeof r.producerRuntimeDirectory !== "string" || typeof r.producerArtifactSha256 !== "string") researchInvalid();
  const current = terminalResearchStart(manifest.jobId);
  const matches = (): boolean => digest(parseStoredCodexGoalJobManifest(manifest)) === current.spec.registeredHandoff?.manifestSha256;
  if (!matches()) researchInvalid();
  const context = await stoppedProviderReleaseContext(current, r.historicalScope,
    { directory: r.producerRuntimeDirectory, artifact: r.producerArtifactSha256 });
  if (!isDeepStrictEqual(r, context.intent)) researchInvalid();
  const intentPath = join(researchJobAuthority(manifest.jobId), stoppedIntentName), receiptPath = join(current.directory, stoppedReceiptName);
  const receipt = researchRead(receiptPath);
  if (!isDeepStrictEqual(researchJson(receipt), { schemaVersion: 1, kind: StoppedProviderReleaseKind.BeforeProvider,
    intentSha256: researchHash(intentBytes) })) researchInvalid();
  const read = (): void => {
    context.assertCurrent();
    if (!matches() || !researchRead(intentPath).equals(intentBytes) || !researchRead(receiptPath).equals(receipt)) researchInvalid();
  };
  read(); return read;
}
