import { mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { assertResearchInitialRoot } from "./research-launch-host";
import { assertResearchDirectory, researchAuthorityRoot, researchCustody, researchDirectoryIdentity,
  researchId, researchInvalid, researchName, researchPrivateDirectory } from "./research-launch-files";

/** The same boot's crashed owner retains its mutex. No PID-based stale eviction
 * can admit a successor while an old publisher or submitter remains uncertain. */
function acquire(jobId: string, createAuthority: boolean): () => void {
  assertResearchInitialRoot(true);
  const job = join(researchAuthorityRoot, researchName(researchId(jobId)));
  if (createAuthority) {
    for (const path of [researchAuthorityRoot, job]) {
      try { researchPrivateDirectory(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      researchCustody(path, true);
      researchDirectoryIdentity(path);
    }
  } else {
    researchCustody(job, true);
    researchDirectoryIdentity(job);
  }
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) researchInvalid();
  const lock = join(job, `mutation.${boot}.lock`);
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("hosted_research_job_mutation_busy");
    throw error;
  }
  const identity = researchDirectoryIdentity(lock);
  return () => { researchCustody(lock, true); assertResearchDirectory(identity); rmdirSync(lock); };
}

export function withResearchJobMutation<T>(jobId: string, effect: () => T, createAuthority = false): T {
  const release = acquire(jobId, createAuthority);
  try { return effect(); } finally { release(); }
}

export async function withResearchJobMutationAsync<T>(jobId: string, effect: () => Promise<T>, createAuthority = false): Promise<T> {
  const release = acquire(jobId, createAuthority);
  try { return await effect(); } finally { release(); }
}
