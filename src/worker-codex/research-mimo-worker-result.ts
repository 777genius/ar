import { join, relative } from "node:path";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildRuntimeResultEnvelope, type RuntimeResultEnvelope, type RuntimeResultEnvelopeInput } from "@vioxen/subscription-runtime/worker-core";
import type { CodexAppServerProcessFactory } from "@vioxen/subscription-runtime/provider-codex";
import { assertResearchMimoProviderHome, ownedMimoWorkerStart, researchCurrentStart, researchProviderAdmissionGuard } from "./research-launch-admission";
import { researchDirectoryIdentity, assertResearchDirectory, researchCustody, researchHash, researchInvalid, researchJson, researchPublish, researchRead, researchRecord } from "./research-launch-files";
import { prepareHostScratchCaches } from "./host-scratch-temp";

/** Minted from the real owned Worker factory, never serialized in run config.
 * Retention transfers storage to the outside owner, not provider termination. */
export function researchMimoWorkerLifecycle(factory: CodexAppServerProcessFactory | undefined) {
  const spec = ownedMimoWorkerStart(factory);
  if (!spec) return undefined;
  const guard = researchProviderAdmissionGuard(factory)!;
  const current = researchCurrentStart(spec.request.jobId), specSha256 = researchHash(current.bytes);
  const assertCurrent = (): void => {
    guard();
    if (!researchCurrentStart(spec.request.jobId).bytes.equals(current.bytes)) researchInvalid();
  };
  const homePath = join(current.directory, "mimo-home.json");
  return Object.freeze({
    home: Object.freeze({
      async prepareHome(path: string): Promise<void> {
        assertCurrent();
        if (!/^mimo-[A-Za-z0-9]+\/codex-home$/.test(relative(join(spec.request.jobRootDir, "home"), path))) researchInvalid();
        const identity = researchDirectoryIdentity(path);
        researchPublish(homePath, { schemaVersion: 1, specSha256, identity }, true);
        // Persist ownership before preparation, including any partial mount failure.
        await prepareHostScratchCaches(path, {});
        assertCurrent(); assertResearchDirectory(identity);
      },
      async retainHome(path: string): Promise<void> {
        assertCurrent();
        assertResearchMimoProviderHome(spec, path);
      },
    }),
    stage(input: RuntimeResultEnvelopeInput): void {
      assertCurrent();
      if (input.runId !== spec.request.jobId || input.taskId !== spec.request.taskId) researchInvalid();
      researchPublish(join(current.directory, "mimo-candidate.json"), { schemaVersion: 1,
        jobId: spec.request.jobId, taskId: spec.request.taskId, startId: spec.startId, specSha256,
        bindingSha256: researchHash(researchRead(join(current.directory, "binding.json"))),
        result: buildRuntimeResultEnvelope(input) }, true);
    },
  });
}

/** Root-private normalized candidate; caller paths and payloads are never accepted. */
export function readResearchMimoCandidate(current: ReturnType<typeof researchCurrentStart>): RuntimeResultEnvelope {
  const value = researchRecord(researchJson(researchRead(join(current.directory, "mimo-candidate.json"))),
    "schemaVersion,jobId,taskId,startId,specSha256,bindingSha256,result");
  if (value.schemaVersion !== 1 || value.jobId !== current.spec.request.jobId || value.taskId !== current.spec.request.taskId ||
      value.startId !== current.spec.startId || value.specSha256 !== researchHash(current.bytes) ||
      value.bindingSha256 !== researchHash(researchRead(join(current.directory, "binding.json")))) researchInvalid();
  const result = value.result as RuntimeResultEnvelope;
  if (!result || result.schemaVersion !== 1 || result.provider !== "codex" || result.runId !== value.jobId || result.taskId !== value.taskId ||
      !["done", "partial", "blocked", "failed"].includes(result.status) || typeof result.updatedAt !== "string") researchInvalid();
  const normalized = buildRuntimeResultEnvelope({ ...result, updatedAt: new Date(result.updatedAt) });
  if (JSON.stringify(normalized) !== JSON.stringify(result)) researchInvalid();
  return result;
}

export function assertResearchMimoResultDirectories(current: ReturnType<typeof researchCurrentStart>): void {
  for (const [name, identity] of [["job", current.spec.jobDirectory], ["workspace", current.spec.workspaceDirectory]] as const) {
    assertResearchDirectory(identity); assertResearchDirectory(identity, join(current.directory, "pins", name));
  }
}
/** Synchronous final effects through the protected job pin. No async gap can
 * release the exact reservation between final corroboration and publication. */
export function publishResearchMimoJobArtifact(current: ReturnType<typeof researchCurrentStart>, suffix: "latest-result" | "progress", value: unknown): void {
  assertResearchMimoResultDirectories(current);
  const root = join(current.directory, "pins/job"); researchCustody(root);
  const path = join(root, current.spec.request.taskId + "." + suffix + ".json"), temp = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  assertResearchMimoResultDirectories(current); renameSync(temp, path);
  const directoryFd = openSync(root, "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}
