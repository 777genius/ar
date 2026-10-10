import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute, resolve } from "node:path";
import type { CodexGoalJobManifest } from "../../codex-goal-jobs";
import { durablePublishJsonFile } from "../../project-control-operation-file-store";
import { recordProtectedCodexGoalJobFirstEffect } from "../../protected-job-birth";

const originName = ".controller-state-origin.json";
const locationName = ".controller-state-location.json";
const identity = (job: CodexGoalJobManifest) => ({ schemaVersion: 1, jobId: job.jobId, createdAt: job.createdAt });
const guardedIdentity = (job: CodexGoalJobManifest) => ({ ...identity(job), schemaVersion: 2 });
const rawOrigin = JSON.stringify({ schemaVersion: 2, rawStartObserved: true });

/** Permanent history only, never an executable grant. Exclusive publication of
 * the final leaf arbitrates with controller creation before any raw effect.
 * A crashed/partial publication stays Unknown; it is never deleted or repaired.
 * Call only after the existing storage/host admission has authorized this root. */
export function recordRawGoalStateOrigin(jobRootDir: string): void {
  recordProtectedCodexGoalJobFirstEffect(jobRootDir);
  // Guarded v2 history is Linux-only. Other platforms retain legacy history
  // and cannot use it as fresh physical no-allocation authority.
  if (process.platform !== "linux") return;
  const deny = (): never => { throw new Error("controller_origin_raw_launch_denied"); };
  if (!isAbsolute(jobRootDir) || resolve(jobRootDir) !== jobRootDir || jobRootDir === "/") deny();
  mkdirSync(jobRootDir, { recursive: true, mode: 0o700 });
  if (realpathSync(jobRootDir) !== jobRootDir) deny();
  const root = openSync(jobRootDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const rootIdentity = fstatSync(root, { bigint: true });
    const path = join(jobRootDir, originName);
    let fd: number, created = true;
    try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      created = false;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    try {
      if (created) writeFileSync(fd, rawOrigin + "\n");
      let validated;
      {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > 1024n) deny();
        const bytes = Buffer.alloc(1025);
        let size = 0;
        while (size < bytes.length) {
          const read = readSync(fd, bytes, size, bytes.length - size, size);
          if (read === 0) break;
          size += read;
        }
        if (size > 1024 || JSON.stringify(JSON.parse(bytes.subarray(0, size).toString("utf8"))) !== rawOrigin) deny();
        const after = fstatSync(fd, { bigint: true });
        if (before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs) deny();
        validated = after;
      }
      const assertCurrent = () => {
        if (realpathSync(jobRootDir) !== jobRootDir) deny();
        const namedRoot = openSync(jobRootDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const named = fstatSync(namedRoot, { bigint: true });
          if (named.dev !== rootIdentity.dev || named.ino !== rootIdentity.ino) deny();
        } finally { closeSync(namedRoot); }
        const namedLeaf = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const actual = fstatSync(fd, { bigint: true }), named = fstatSync(namedLeaf, { bigint: true });
          if (!actual.isFile() || actual.nlink !== 1n || named.nlink !== 1n ||
              actual.dev !== validated.dev || actual.ino !== validated.ino || actual.size !== validated.size ||
              actual.ctimeNs !== validated.ctimeNs || actual.mtimeNs !== validated.mtimeNs ||
              actual.dev !== named.dev || actual.ino !== named.ino || actual.size !== named.size ||
              actual.ctimeNs !== named.ctimeNs || actual.mtimeNs !== named.mtimeNs) deny();
        } finally { closeSync(namedLeaf); }
      };
      assertCurrent();
      // Identical replay must also finish a concurrent producer's durability.
      fsyncSync(fd);
      syncOriginAncestry(jobRootDir);
      assertCurrent();
    } finally { closeSync(fd); }
  } finally { closeSync(root); }
}

function syncOriginAncestry(jobRootDir: string): void {
  for (let path = jobRootDir;; path = dirname(path)) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (dirname(path) === path) break;
  }
}

/** The owner has already authenticated this exact immutable invocation. Never
 * infer raw execution from caller environment or import the transport parser. */
export function recordInventoriedRawGoalStateOrigin(launch: Readonly<{ command: string; args: readonly string[] }>, jobRootDir: string): void {
  const runtimeDirectory = fileURLToPath(new URL("../../../../", import.meta.url));
  const cli = join(runtimeDirectory, "dist/worker-codex/codex-goal-cli.js");
  const args = launch.command === cli ? launch.args
    : launch.command === process.execPath && launch.args[0] === cli ? launch.args.slice(1) : undefined;
  if (!args) return; // Legacy/non-CLI inventory acquires no guarded-history proof.
  // Controlled supervisor inventory also invalidates never-started authority
  // before bootstrap; it retains its separate public origin history.
  recordProtectedCodexGoalJobFirstEffect(jobRootDir);
  // These exact inventoried entrypoints keep the controller's restricted tool
  // surface. Other CLI entrypoints cannot acquire controller-root write rights.
  if (args[0] === "controller-supervise" || args[0] === "project-controller-supervise") return;
  recordRawGoalStateOrigin(jobRootDir);
}

/** Creation only, before publishing a new manifest. Existing roots prove nothing. */
export async function initializeControllerStateOrigin(job: CodexGoalJobManifest, freshJobRoot = false): Promise<void> {
  if (!freshJobRoot) {
    await mkdir(dirname(job.jobRootDir), { recursive: true });
    try { await mkdir(job.jobRootDir, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
  }
  const origin = process.platform === "linux" ? guardedIdentity(job) : identity(job);
  await durablePublishJsonFile({ path: join(job.jobRootDir, originName), value: origin });
  if (JSON.stringify(await readJson(join(job.jobRootDir, originName))) !== JSON.stringify(origin)) {
    throw new Error("controller_creation_origin_conflict");
  }
  if (process.platform === "linux") syncOriginAncestry(job.jobRootDir);
}

/** Called under the controller activity lease before any provider/state write.
 * Immutable publication arbitrates concurrent starts, including different paths.
 * Legacy starts may bind a location but cannot manufacture complete history.
 */
export async function bindControllerStateLocation(job: CodexGoalJobManifest, stateDir: string): Promise<string> {
  recordProtectedCodexGoalJobFirstEffect(job.jobRootDir);
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
  if (JSON.stringify(origin) !== JSON.stringify(identity(job)) &&
      JSON.stringify(origin) !== JSON.stringify(guardedIdentity(job))) {
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
