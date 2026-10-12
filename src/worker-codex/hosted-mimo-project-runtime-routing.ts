import { lstatSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchArtifactDigest, researchCustody, researchRead, researchRecord } from "./research-launch-files";
import { protectedCodexGoalJobRuntimeProvenance } from "./protected-job-birth";
import { readCodexGoalJob } from "./codex-goal-jobs";
import { projectControlRefillWorkerFromSealedSource, projectControlStartStoredJob, projectControlStopStoredJob } from "./codex-goal-mcp-project-control-tool-handlers";
import { loadProjectControlController, loadJobLaunch } from "./codex-goal-mcp-project-control-deps";
import { collectRegisteredCodexGoalJobStatus } from "./application/codex-goal-registered-job-observation";

const local = { projectControlRefillWorkerFromSealedSource, projectControlStartStoredJob, projectControlStopStoredJob,
  loadProjectControlController, loadJobLaunch, collectRegisteredCodexGoalJobStatus };
export type HostedMimoProjectRuntime = Readonly<typeof local>;
const routingPath = "/etc/subscription-runtime/mimo-project-runtime-routing.json";
const invalid = (): never => { throw new Error("mimo_project_runtime_routing_invalid"); };
function metadataBytes(): Buffer {
  researchCustody(dirname(routingPath));
  const before = lstatSync(routingPath);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o077)) invalid();
  const bytes = researchRead(routingPath, false, 4096), after = lstatSync(routingPath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== bytes.length ||
      before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) invalid();
  return bytes;
}
function assertArtifact(directory: string, digest: string): void {
  if (!/^\/opt\/subscription-runtime\/releases\/[a-f0-9]{40}$/.test(directory) || !/^[a-f0-9]{64}$/.test(digest) ||
      realpathSync(directory) !== directory) invalid();
  researchCustody(directory);
  if (researchArtifactDigest(directory) !== digest) invalid();
}

/** Trusted Host composition, never a request field. Routing cannot manufacture
 * release authority: every operation runs the selected runtime's original guards.
 * No birth publication lock spans a call into another module composition. */
export async function hostedMimoProjectRuntime(binding: Readonly<{ registryRootDir: string; controllerJobId: string }>,
  importModule: (url: string) => Promise<Record<string, unknown>> = async url => await import(url)): Promise<HostedMimoProjectRuntime> {
  assertResearchInitialRoot(true);
  let bytes: Buffer;
  try { bytes = metadataBytes(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return local; throw error; }
  const config = researchRecord(JSON.parse(bytes.toString("utf8")), "schemaVersion,legacyRuntimeDirectory,legacyArtifactSha256");
  if (config.schemaVersion !== 1 || typeof config.legacyRuntimeDirectory !== "string" || typeof config.legacyArtifactSha256 !== "string") return invalid();
  const { legacyRuntimeDirectory, legacyArtifactSha256 } = config;
  assertArtifact(legacyRuntimeDirectory, legacyArtifactSha256);
  const controller = await readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: binding.controllerJobId });
  const provenance = protectedCodexGoalJobRuntimeProvenance(controller, binding.registryRootDir);
  const directory = provenance?.runtimeDirectory ?? legacyRuntimeDirectory;
  const digest = provenance?.artifactSha256 ?? legacyArtifactSha256;
  const assertCurrent = (): void => {
    assertResearchInitialRoot(true);
    if (!metadataBytes().equals(bytes)) invalid();
    provenance?.assertCurrent();
    assertArtifact(directory, digest);
    provenance?.assertCurrent();
  };
  assertCurrent(); // Executable bytes must be verified before any import.
  const modules = await Promise.all([
    "dist/worker-codex/codex-goal-mcp-project-control-tool-handlers.js",
    "dist/worker-codex/codex-goal-mcp-project-control-deps.js",
    "dist/worker-codex/application/codex-goal-registered-job-observation.js",
  ].map(path => importModule(pathToFileURL(join(directory, path)).href)));
  assertCurrent();
  const selected = { projectControlRefillWorkerFromSealedSource: modules[0]!.projectControlRefillWorkerFromSealedSource,
    projectControlStartStoredJob: modules[0]!.projectControlStartStoredJob, projectControlStopStoredJob: modules[0]!.projectControlStopStoredJob,
    loadProjectControlController: modules[1]!.loadProjectControlController, loadJobLaunch: modules[1]!.loadJobLaunch,
    collectRegisteredCodexGoalJobStatus: modules[2]!.collectRegisteredCodexGoalJobStatus };
  if (Object.values(selected).some(value => typeof value !== "function")) invalid();
  const runtime = selected as HostedMimoProjectRuntime;
  return Object.freeze({
    projectControlRefillWorkerFromSealedSource: async (...args) => { assertCurrent(); return await runtime.projectControlRefillWorkerFromSealedSource(...args); },
    projectControlStartStoredJob: async (...args) => { assertCurrent(); return await runtime.projectControlStartStoredJob(...args); },
    projectControlStopStoredJob: async (...args) => { assertCurrent(); return await runtime.projectControlStopStoredJob(...args); },
    loadProjectControlController: async (...args) => { assertCurrent(); return await runtime.loadProjectControlController(...args); },
    loadJobLaunch: async (...args) => { assertCurrent(); return await runtime.loadJobLaunch(...args); },
    collectRegisteredCodexGoalJobStatus: async (...args) => { assertCurrent(); return await runtime.collectRegisteredCodexGoalJobStatus(...args); },
  });
}
