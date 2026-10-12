import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { readCodexGoalJob, type CodexGoalJobManifest } from "./codex-goal-jobs";
import { MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { hostedOrdinaryWriterAuthorityAbsent } from "./hosted-ordinary-writer-authority";
import { observeCompatibleProtectedCodexGoalJobBirth, protectedCodexGoalJobRuntimeProvenance, withProtectedCodexGoalJobBirthPublication } from "./protected-job-birth";
import { researchJobRuntimeNamespaceAbsent, researchJobRuntimeProvenance, type ResearchJobRuntimeProvenance } from "./research-job-runtime-provenance";
import { assertResearchDirectory, researchAuthorityRoot, researchCustody, researchDirectoryIdentity, researchHash, researchPublish, researchRead, researchRecord } from "./research-launch-files";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";
import { assertResearchInitialRoot } from "./research-launch-host";

export type HostedMimoRuntimeRouting = Readonly<{
  schemaVersion: 1 | 2; legacyRuntimeDirectory: string; legacyArtifactSha256: string;
  currentRuntimeDirectory?: string; currentArtifactSha256?: string;
}>;
type Binding = Readonly<{ registryRootDir: string; controllerJobId: string }>;
export type HostedMimoRuntimeSelection = Pick<MimoProjectBridgeRequest, "operation" | "jobId">;
const invalid = (): never => { throw new Error("mimo_project_runtime_routing_invalid"); };
function intentPath(binding: Binding, jobId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(jobId)) invalid();
  return join(dirname(binding.registryRootDir), "mimo-runtime-starts", jobId + ".json");
}
function intentValue(binding: Binding, job: CodexGoalJobManifest, runtimeDirectory: string, artifactSha256: string) {
  return { schemaVersion: 1, registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId,
    jobId: job.jobId, createdAt: job.createdAt, jobRootDir: job.jobRootDir, workspacePath: job.workspacePath, runtimeDirectory, artifactSha256 };
}
function readIntent(binding: Binding, job: CodexGoalJobManifest): ResearchJobRuntimeProvenance | undefined {
  const path = intentPath(binding, job.jobId);
  let bytes: Buffer;
  try { bytes = researchRead(path, true, 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const r = researchRecord(JSON.parse(bytes.toString()), "schemaVersion,registryRootDir,controllerJobId,jobId,createdAt,jobRootDir,workspacePath,runtimeDirectory,artifactSha256");
  const { runtimeDirectory, artifactSha256 } = r;
  if (typeof runtimeDirectory !== "string" || typeof artifactSha256 !== "string") throw new Error("mimo_project_runtime_routing_invalid");
  if (!isDeepStrictEqual(r, intentValue(binding, job, runtimeDirectory, artifactSha256))) invalid();
  assertQualifiedResearchRuntimeArtifact(runtimeDirectory, artifactSha256);
  return Object.freeze({ runtimeDirectory, artifactSha256,
    assertCurrent: () => { if (!researchRead(path, true, 4096).equals(bytes)) invalid(); } });
}

/** Explicit trusted Host recovery, never an automatic Start fallback. The
 * operator binds the prior intent and manifest bytes and supplies the already
 * qualified current routing composition and its metadata/pointer witness.
 * No execution authority, admission record or protected birth is changed. */
export async function recoverHostedMimoProjectPreEffectStartIntent(binding: Binding,
  selection: HostedMimoRuntimeSelection, expected: Readonly<{ intentSha256: string; manifestSha256: string }>,
  config: HostedMimoRuntimeRouting, assertCurrentWitness: () => void,
): Promise<Readonly<{ priorIntentSha256: string; intentSha256: string; archivePath: string }>> {
  assertResearchInitialRoot(true);
  if (selection.operation !== MimoProjectBridgeOperation.Start || config.schemaVersion !== 2 ||
      !config.currentRuntimeDirectory || !config.currentArtifactSha256 ||
      !/^[a-f0-9]{64}$/.test(expected.intentSha256) || !/^[a-f0-9]{64}$/.test(expected.manifestSha256)) invalid();
  const path = intentPath(binding, selection.jobId), manifestPath = join(binding.registryRootDir, selection.jobId, "job.json");
  const manifestBytes = researchRead(manifestPath), priorBytes = researchRead(path, true, 4096);
  if (researchHash(manifestBytes) !== expected.manifestSha256 || researchHash(priorBytes) !== expected.intentSha256) invalid();
  const job = await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: selection.jobId });
  const prior = readIntent(binding, job) ?? invalid();
  const directory = config.currentRuntimeDirectory!, digest = config.currentArtifactSha256!;
  if (prior.runtimeDirectory === directory && prior.artifactSha256 === digest) invalid();
  // Warm immutable old-origin artifact qualification before taking the shared
  // publication mutex; only the fresh read inside it supplies release proof.
  if ((await observeCompatibleProtectedCodexGoalJobBirth(job)).status !== "released") invalid();
  const root = researchDirectoryIdentity(job.jobRootDir);
  const effectPaths = [join(researchAuthorityRoot, "job-births", researchHash(job.jobRootDir) + ".first-effect.json"),
    join(researchAuthorityRoot, "job-births", `physical-${root.device}-${root.inode}.first-effect.json`)];
  const absent = (name: string): boolean => {
    researchCustody(dirname(name), true);
    try { lstatSync(name); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  };
  const assertUnexecuted = async (): Promise<void> => {
    assertResearchInitialRoot(true); assertCurrentWitness();
    assertQualifiedResearchRuntimeArtifact(directory, digest);
    assertResearchDirectory(root);
    if (!researchRead(manifestPath).equals(manifestBytes) ||
        !isDeepStrictEqual(await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: selection.jobId }), job) ||
        !researchJobRuntimeNamespaceAbsent(job.jobId) || !hostedOrdinaryWriterAuthorityAbsent(job.jobId) ||
        !effectPaths.every(absent) || (await observeCompatibleProtectedCodexGoalJobBirth(job)).status !== "released") invalid();
    assertCurrentWitness();
  };
  return await withProtectedCodexGoalJobBirthPublication(async () => {
    await assertUnexecuted(); prior.assertCurrent();
    if (!researchRead(path, true, 4096).equals(priorBytes)) invalid();
    const archiveRoot = join(dirname(path), "pre-effect-history");
    try { mkdirSync(archiveRoot, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    researchCustody(archiveRoot, true);
    const archivePath = join(archiveRoot, job.jobId + "." + expected.intentSha256 + ".json");
    let archiveFd: number | undefined;
    try {
      archiveFd = openSync(archivePath, "wx", 0o600);
      writeFileSync(archiveFd, priorBytes); fsyncSync(archiveFd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !researchRead(archivePath, true, 4096).equals(priorBytes)) throw error;
    } finally { if (archiveFd !== undefined) closeSync(archiveFd); }
    for (const directory of [archiveRoot, dirname(archiveRoot)]) {
      const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    await assertUnexecuted(); prior.assertCurrent();
    if (!researchRead(path, true, 4096).equals(priorBytes)) invalid();
    researchPublish(path, intentValue(binding, job, directory, digest));
    const replacement = readIntent(binding, job) ?? invalid();
    if (replacement.runtimeDirectory !== directory || replacement.artifactSha256 !== digest) invalid();
    await assertUnexecuted(); replacement.assertCurrent();
    if (!researchRead(archivePath, true, 4096).equals(priorBytes)) invalid();
    return Object.freeze({ priorIntentSha256: expected.intentSha256, intentSha256: researchHash(researchRead(path, true, 4096)), archivePath });
  });
}

/** Runtime selection is not writer admission. Unknown owners never become a
 * fresh Start. Native spec supersedes birth; an exclusive intent retains the
 * selected origin even when submission failed before a spec was published. */
export async function selectHostedMimoProjectRuntime(binding: Binding, selection: HostedMimoRuntimeSelection | undefined,
  config: HostedMimoRuntimeRouting): Promise<Readonly<{ directory: string; digest: string; assertOrigin(): void;
    prepareStart(jobId: string | undefined, assertCurrent: () => void): Promise<void> }>> {
  let provenance: ResearchJobRuntimeProvenance | undefined, execution: ResearchJobRuntimeProvenance | undefined;
  let intent: ResearchJobRuntimeProvenance | undefined, job: CodexGoalJobManifest | undefined, freshStart = false;
  let nativeAbsent = false;
  let directory = config.legacyRuntimeDirectory, digest = config.legacyArtifactSha256;
  if (config.schemaVersion !== 2 || !selection) {
    const controller = await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: binding.controllerJobId });
    provenance = protectedCodexGoalJobRuntimeProvenance(controller, binding.registryRootDir);
    directory = provenance?.runtimeDirectory ?? directory; digest = provenance?.artifactSha256 ?? digest;
  } else if (selection.operation === MimoProjectBridgeOperation.Create) {
    directory = config.currentRuntimeDirectory!; digest = config.currentArtifactSha256!;
  } else {
    job = await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: selection.jobId });
    provenance = protectedCodexGoalJobRuntimeProvenance(job, binding.registryRootDir);
    execution = researchJobRuntimeProvenance(job); intent = readIntent(binding, job);
    nativeAbsent = researchJobRuntimeNamespaceAbsent(job.jobId);
    if (!execution && !intent && !nativeAbsent) invalid();
    if (execution && intent && (execution.runtimeDirectory !== intent.runtimeDirectory || execution.artifactSha256 !== intent.artifactSha256)) invalid();
    const retained = execution ?? intent ?? provenance;
    directory = retained?.runtimeDirectory ?? directory; digest = retained?.artifactSha256 ?? digest;
    if (selection.operation === MimoProjectBridgeOperation.Start && !intent && researchJobRuntimeNamespaceAbsent(job.jobId) &&
        hostedOrdinaryWriterAuthorityAbsent(job.jobId) && (await observeCompatibleProtectedCodexGoalJobBirth(job)).status === "released") {
      directory = config.currentRuntimeDirectory!; digest = config.currentArtifactSha256!; freshStart = true;
    }
  }
  const assertOrigin = (): void => {
    provenance?.assertCurrent(); execution?.assertCurrent(); intent?.assertCurrent();
    if (!job) return;
    if (!intent && readIntent(binding, job)) invalid();
    if (intent) {
      const current = researchJobRuntimeProvenance(job);
      if (current && (current.runtimeDirectory !== directory || current.artifactSha256 !== digest)) invalid();
    }
    if (nativeAbsent && !researchJobRuntimeNamespaceAbsent(job.jobId)) {
      if (!intent) invalid();
      const arrived = researchJobRuntimeProvenance(job);
      if (!arrived || arrived.runtimeDirectory !== directory || arrived.artifactSha256 !== digest) invalid();
      arrived!.assertCurrent();
    }
  };
  return Object.freeze({ directory, digest, assertOrigin, prepareStart: async (jobId, assertCurrent) => {
    if (!freshStart) return;
    if (jobId !== job!.jobId) invalid();
    await withProtectedCodexGoalJobBirthPublication(async () => {
      assertCurrent();
      if (readIntent(binding, job!) || !researchJobRuntimeNamespaceAbsent(job!.jobId) || !hostedOrdinaryWriterAuthorityAbsent(job!.jobId) ||
          (await observeCompatibleProtectedCodexGoalJobBirth(job!)).status !== "released") invalid();
      const path = intentPath(binding, job!.jobId);
      researchCustody(dirname(dirname(path)), true);
      try {
        mkdirSync(dirname(path), { mode: 0o700 });
        const fd = openSync(dirname(dirname(path)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      researchCustody(dirname(path), true);
      researchPublish(path, intentValue(binding, job!, directory, digest), true);
      intent = readIntent(binding, job!); if (!intent) invalid();
    });
    freshStart = false;
  } });
}
