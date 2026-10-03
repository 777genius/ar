import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { durablePublishJsonFile } from "../../project-control-operation-file-store";

const originName = ".controller-state-origin.json";
const locationName = ".controller-state-location.json";
const identity = (job: CodexGoalJobManifest) => ({ schemaVersion: 1, jobId: job.jobId, createdAt: job.createdAt });

/** Creation only, before publishing a new manifest. Existing roots prove nothing. */
export async function initializeControllerStateOrigin(job: CodexGoalJobManifest): Promise<void> {
  await mkdir(dirname(job.jobRootDir), { recursive: true });
  try { await mkdir(job.jobRootDir, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  await durablePublishJsonFile({ path: join(job.jobRootDir, originName), value: identity(job) });
}

/** Called under the controller activity lease before any provider/state write.
 * Immutable publication arbitrates concurrent starts, including different paths.
 * Legacy starts may bind a location but cannot manufacture complete history.
 */
export async function bindControllerStateLocation(job: CodexGoalJobManifest, stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const canonical = await realpath(stateDir);
  const value = { ...identity(job), stateDir: canonical };
  const path = join(job.jobRootDir, locationName);
  await durablePublishJsonFile({ path, value });
  if (JSON.stringify(await readJson(path)) !== JSON.stringify(value)) {
    throw new Error("controller_state_location_conflict");
  }
  if (await realpath(stateDir) !== canonical) throw new Error("controller_state_location_changed");
  return canonical;
}

/** A missing default directory is never evidence of a never-started legacy job. */
export async function controllerStateLocationForRelocation(job: CodexGoalJobManifest, attestedNeverRun = false): Promise<string | undefined> {
  const origin = await readJson(join(job.jobRootDir, originName));
  if (attestedNeverRun) {
    // This assertion overrides ONLY missing creation history. Any admitted
    // start, including an uncertain provider effect, contradicts never-run.
    if (origin !== undefined || await readJson(join(job.jobRootDir, locationName)) !== undefined) {
      throw new Error("controller_relocation_attestation_history_conflict");
    }
    return undefined;
  }
  if (JSON.stringify(origin) !== JSON.stringify(identity(job))) {
    throw new Error("controller_relocation_state_location_unknown");
  }
  const location = await readJson(join(job.jobRootDir, locationName));
  if (location === undefined) return undefined; // Proven new identity, no admitted start.
  if (!location || typeof location !== "object" || !("stateDir" in location) ||
    typeof location.stateDir !== "string" || !isAbsolute(location.stateDir) ||
    JSON.stringify(location) !== JSON.stringify({ ...identity(job), stateDir: location.stateDir }) ||
    await realpath(location.stateDir) !== location.stateDir) {
    throw new Error("controller_relocation_state_location_unknown");
  }
  return location.stateDir;
}

async function readJson(path: string): Promise<unknown> {
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile()) throw new Error("controller_relocation_state_location_unknown");
  // Once metadata was observed, disappearance is indeterminate, not absence.
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
