import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { closeSync, constants, fsyncSync, mkdirSync, openSync } from "node:fs";
import { readCodexGoalJob, type CodexGoalJobManifest } from "./codex-goal-jobs";
import { MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { hostedOrdinaryWriterAuthorityAbsent } from "./hosted-ordinary-writer-authority";
import { observeCompatibleProtectedCodexGoalJobBirth, protectedCodexGoalJobRuntimeProvenance, withProtectedCodexGoalJobBirthPublication } from "./protected-job-birth";
import { researchJobRuntimeNamespaceAbsent, researchJobRuntimeProvenance, type ResearchJobRuntimeProvenance } from "./research-job-runtime-provenance";
import { researchCustody, researchPublish, researchRead, researchRecord } from "./research-launch-files";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";

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
