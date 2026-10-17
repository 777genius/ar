import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { researchCustody, researchHash, researchJson, researchPath, researchPublish, researchRead } from "./research-launch-files";
import { hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { hostedMimoProjectOperationCold, observeHostedMimoProjectOperation, readPrivateHostedMimoOperationBytes as privateBytes } from "./hosted-mimo-project-bridge-operation";
import { assertNoWorkstreamRetirement } from "./job-retirement/job-retirement-records";
import { observePendingMimoFinalization, recoverOwnedMimoWorkerPreservation, researchProviderUnits } from "./research-launch-lifecycle";
import { researchCurrentStart } from "./research-launch-admission";
import { assertRegisteredResearchHandoffPin } from "./research-registered-handoff";

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const hexId = z.string().regex(/^[a-f0-9]{32}$/);
const causePattern = /^[a-z][a-z0-9_]{0,119}$/;
/** The plan pins one exact stuck finalization and its witness: the expected cause or the refusal receipt. */
const planSchema = z.object({ schemaVersion: z.literal(1), machineId: hexId, expectedBootId: hexId,
  projectId: id, workstreamId: id, jobId: id, startId: z.string().uuid(), specSha256: sha,
  candidateSha256: sha, bindingSha256: sha, action: z.enum(["preserve", "discard"]).default("preserve"),
  cause: z.string().regex(causePattern).optional(), refusalReceiptSha256: sha.optional() }).strict();
const refused = (): never => { throw new Error("mimo_finalization_recovery_refused"); };
const requireFact = (value: unknown): void => { if (!value) refused(); };
function absent(path: string): void {
  let parent = dirname(path);
  for (;;) {
    try { researchCustody(parent); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === "/") throw error; parent = dirname(parent); }
  }
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  refused();
}
function inactiveUnit(unit: string): boolean {
  const lines = researchCommand("/usr/bin/systemctl", ["show", unit, "--no-pager", "--property=Id,LoadState,ActiveState,MainPID"]);
  const fields = Object.fromEntries(lines.trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  return (fields.Id === unit || fields.LoadState === "not-found") && fields.MainPID === "0" &&
    ["inactive", "failed"].includes(fields.ActiveState ?? "") &&
    !researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]).trim().split("\n").some(line => line.trim().split(/\s+/)[1] === unit);
}

export type HostedMimoFinalizationRecovery = Readonly<{ ok: true; action: "preserve"; projectId: string; workstreamId: string;
  jobId: string; startId: string; status: string; receiptPath: string; dryRun?: true; alreadyRecovered?: true }>;

/** Root recovery of one stuck finalization, by explicit plan only. `preserve` drives the current
 * release's own preservation recovery, whose authority comes from the original release; nothing here
 * mints a release, edits an input or touches workspace bytes. `discard` stays closed until its
 * retirement output kind is agreed with the host-integration contract owners. */
export async function recoverHostedMimoFinalization(planPath: string, options?: { readonly dryRun?: boolean }): Promise<HostedMimoFinalizationRecovery> {
  assertResearchInitialRoot(true); assertResearchSharedHost(); researchPath(planPath);
  const planBytes = privateBytes(planPath, 65536), plan = planSchema.parse(researchJson(planBytes));
  requireFact((plan.cause === undefined) !== (plan.refusalReceiptSha256 === undefined));
  if (plan.action !== "preserve") throw new Error("mimo_finalization_recovery_discard_refused");
  requireFact(hostedMimoBridgeMetadataBytes("/etc/machine-id", 1024).toString().trim() === plan.machineId &&
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replaceAll("-", "") === plan.expectedBootId);
  // The installed binding, not the plan's own strings, is what names the state root.
  const stateRoot = parseHostedMimoProjectBinding(researchJson(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${plan.projectId}/${plan.workstreamId}.json`)),
    { kind: "MimoProject", schemaVersion: 1, machineId: plan.machineId, projectId: plan.projectId, workstreamId: plan.workstreamId,
      operation: MimoProjectBridgeOperation.Status, jobId: plan.jobId }).stateRoot;
  assertNoWorkstreamRetirement(stateRoot, "mimo_project_bridge_retirement_pending");
  absent(join(stateRoot, ".controller-recovery.json"));
  const request = (operation: MimoProjectBridgeOperation): MimoProjectBridgeRequest =>
    ({ kind: "MimoProject", schemaVersion: 1, machineId: plan.machineId, projectId: plan.projectId, workstreamId: plan.workstreamId, operation, jobId: plan.jobId });
  for (const operation of Object.values(MimoProjectBridgeOperation)) {
    const observed = observeHostedMimoProjectOperation(request(operation)) as { state: string; result?: unknown };
    requireFact(observed.state === "settled" || observed.state === "absent" ||
      observed.state === "unresolved" && hostedMimoProjectOperationCold(request(operation)));
  }
  if (plan.cause !== undefined) {
    const settled = observeHostedMimoProjectOperation(request(MimoProjectBridgeOperation.Status)) as { state: string; result?: unknown };
    const row = settled.result as { ok?: unknown; error?: unknown; cause?: unknown } | undefined;
    requireFact(settled.state === "settled" && row?.ok === false && (row.error === plan.cause || row.cause === plan.cause));
  }
  const current = researchCurrentStart(plan.jobId);
  requireFact(current.spec.startId === plan.startId && researchHash(current.bytes) === plan.specSha256 &&
    researchHash(researchRead(join(current.directory, "mimo-candidate.json"))) === plan.candidateSha256 &&
    researchHash(researchRead(join(current.directory, "binding.json"))) === plan.bindingSha256);
  if (plan.refusalReceiptSha256 !== undefined) {
    const receipts = readdirSync(current.directory).filter(name => name.startsWith("preservation-refusal.") && name.endsWith(".json"));
    requireFact(receipts.some(name => researchHash(researchRead(join(current.directory, name))) === plan.refusalReceiptSha256));
  }
  const waiting = observePendingMimoFinalization(plan.jobId);
  requireFact(waiting && waiting.startId === plan.startId && waiting.candidateSha256 === plan.candidateSha256 &&
    inactiveUnit(current.spec.unit) && researchProviderUnits(current.directory).every(inactiveUnit));
  assertRegisteredResearchHandoffPin(current.spec, current.directory);
  const receiptPath = join(stateRoot, "finalization-recoveries", plan.jobId + ".json");
  const expectedReceipt = { schemaVersion: 1, planSha256: researchHash(planBytes), machineId: plan.machineId,
    projectId: plan.projectId, workstreamId: plan.workstreamId, jobId: plan.jobId, startId: plan.startId,
    specSha256: plan.specSha256, candidateSha256: plan.candidateSha256, action: "preserve" };
  const previous = existsSync(receiptPath) ? researchRead(receiptPath) : undefined;
  if (previous) {
    // The published receipt carries the recovery status; the plan alone proves its identity.
    const prior = researchJson(previous) as Record<string, unknown>;
    const priorStatus = typeof prior.status === "string" ? prior.status : refused();
    requireFact(isDeepStrictEqual(prior, { ...expectedReceipt, status: priorStatus, complete: true }));
    return { ok: true, action: "preserve", projectId: plan.projectId, workstreamId: plan.workstreamId,
      jobId: plan.jobId, startId: plan.startId, status: priorStatus, receiptPath, alreadyRecovered: true };
  }
  const outcome: Omit<HostedMimoFinalizationRecovery, "status"> = { ok: true, action: "preserve", projectId: plan.projectId, workstreamId: plan.workstreamId,
    jobId: plan.jobId, startId: plan.startId, receiptPath, ...(options?.dryRun ? { dryRun: true as const } : {}) };
  if (options?.dryRun) return { ...outcome, status: "pending" };
  const fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: stateRoot, owner: "finalization-recovery:" + researchHash(planBytes) });
  try {
    requireFact(!existsSync(receiptPath));
    const recovered = await recoverOwnedMimoWorkerPreservation({ jobId: plan.jobId, startId: plan.startId,
      specSha256: plan.specSha256, requestSha256: current.spec.requestSha256 });
    requireFact(recovered.startId === plan.startId);
    const root = dirname(receiptPath);
    try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    researchCustody(root, true);
    researchPublish(receiptPath, { ...expectedReceipt, status: recovered.status, complete: true }, true);
    requireFact(isDeepStrictEqual(researchJson(researchRead(receiptPath)), { ...expectedReceipt, status: recovered.status, complete: true }));
    return { ...outcome, status: recovered.status };
  } finally {
    await releaseLocalControllerMaintenanceFence(fence);
  }
}
