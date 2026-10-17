import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import { installedResearchRuntimeDirectory, researchCurrentStart, researchJobAuthority } from "./research-launch-admission";
import { parseResearchStartSpec } from "./research-launch-contract";
import { assertResearchInitialRoot } from "./research-launch-host";
import { researchAuthorityRoot, researchCustody, researchHash, researchRead, researchRecord } from "./research-launch-files";
import { assertQualifiedResearchRuntimeArtifact } from "./research-runtime-artifact";

export type ResearchJobRuntimeProvenance = Readonly<{
  runtimeDirectory: string; artifactSha256: string; assertCurrent(): void;
}>;
/** Positive namespace absence only. Malformed/hidden owners retain uncertainty. */
export function researchJobRuntimeNamespaceAbsent(jobId: string): boolean {
  try {
    assertResearchInitialRoot(true);
    researchCustody(dirname(researchAuthorityRoot));
    try { researchCustody(researchAuthorityRoot, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    try { lstatSync(researchJobAuthority(jobId)); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  } catch { return false; }
}

/** Exact protected execution origin supersedes birth when a later runtime
 * started a never-run job. This reader cannot authorize release or a new start. */
export function researchJobRuntimeProvenance(manifest: CodexGoalJobManifest): ResearchJobRuntimeProvenance | undefined {
  return readResearchJobRuntimeProvenance(manifest, false);
}

/** Writer classification only: a same-installed origin was always discarded by
 * the caller, even when artifact qualification failed. Foreign origins retain
 * complete qualification; this reader never supplies current writer authority. */
export function researchForeignWriterRuntimeProvenance(manifest: CodexGoalJobManifest): ResearchJobRuntimeProvenance | undefined {
  return readResearchJobRuntimeProvenance(manifest, true);
}

function readResearchJobRuntimeProvenance(manifest: CodexGoalJobManifest,
  foreignWriterOnly: boolean): ResearchJobRuntimeProvenance | undefined {
  try {
    assertResearchInitialRoot(true);
    const authority = researchJobAuthority(manifest.jobId);
    const activePath = join(authority, "active.json");
    const activeBytes = (): Buffer | undefined => {
      try { return researchRead(activePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
    };
    const active = activeBytes(), terminal = active === undefined;
    const terminalPath = join(authority, "last-terminal.json"), terminalBytes = terminal ? researchRead(terminalPath) : undefined;
    const read = () => {
      if (!terminal) return researchCurrentStart(manifest.jobId);
      // Origin qualification is a cold byte witness, never terminal release or
      // lifecycle reconciliation. The original writer reader owns that proof.
      const slot = researchRecord(JSON.parse(researchRead(join(authority, "last-terminal.json")).toString()), "schemaVersion,startId,specSha256");
      if (slot.schemaVersion !== 1 || typeof slot.startId !== "string" || !/^[a-f0-9-]{36}$/.test(slot.startId)) throw new Error("mimo_project_runtime_routing_invalid");
      const directory = join(authority, "starts", slot.startId), bytes = researchRead(join(directory, "spec.json"));
      const spec = parseResearchStartSpec(JSON.parse(bytes.toString()));
      if (spec.request.jobId !== manifest.jobId || spec.startId !== slot.startId || researchHash(bytes) !== slot.specSha256) throw new Error("mimo_project_runtime_routing_invalid");
      return { directory, bytes, spec };
    };
    const current = read();
    const { spec } = current, r = spec.request;
    if (r.jobId !== manifest.jobId || r.taskId !== manifest.taskId || r.jobRootDir !== manifest.jobRootDir ||
        r.workspacePath !== manifest.workspacePath || r.promptPath !== manifest.promptPath || r.modelBackend !== manifest.modelBackend ||
        (!spec.registeredHandoff && !spec.projectLaunchBinding)) return undefined;
    const grantPath = join(researchJobAuthority(manifest.jobId), "grant.json"), grant = researchRead(grantPath);
    if (researchHash(grant) !== spec.grantSha256) return undefined;
    const ignoredInstalledOrigin = foreignWriterOnly && spec.runtimeDirectory === installedResearchRuntimeDirectory();
    if (!ignoredInstalledOrigin) assertQualifiedResearchRuntimeArtifact(spec.runtimeDirectory, spec.artifactSha256);
    const assertCurrent = (): void => {
      assertResearchInitialRoot(true);
      const freshActive = activeBytes();
      if (terminal ? freshActive !== undefined || !researchRead(terminalPath).equals(terminalBytes!) :
          freshActive === undefined || !freshActive.equals(active!)) throw new Error("mimo_project_runtime_routing_invalid");
      const fresh = read();
      if (fresh.directory !== current.directory || !fresh.bytes.equals(current.bytes) || !researchRead(grantPath).equals(grant) ||
          !researchRead(join(current.directory, "spec.json")).equals(current.bytes)) throw new Error("mimo_project_runtime_routing_invalid");
    };
    assertCurrent();
    return ignoredInstalledOrigin ? undefined : Object.freeze({ runtimeDirectory: spec.runtimeDirectory, artifactSha256: spec.artifactSha256, assertCurrent });
  } catch { return undefined; }
}
