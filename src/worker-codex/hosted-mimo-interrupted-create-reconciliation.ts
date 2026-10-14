import { constants, openSync, closeSync, lstatSync, readFileSync, readdirSync, mkdirSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { InterruptedProjectCreateErrorCode,
  type InterruptedProjectCreateOutcome } from "@vioxen/subscription-runtime/worker-core";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { researchCustody, researchHash, researchJson, researchRecord, researchPath, researchPublish,
  researchDirectoryIdentity, assertResearchDirectory } from "./research-launch-files";
import { hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation } from "./hosted-mimo-project-bridge-contract";
import { readHostedMimoProjectOperationOwner, publishHostedMimoProjectOperationResult,
  type HostedMimoProjectOperationOwner, hostedMimoInterruptedCreateComplete, mimoInterruptedIntentSchema as intentSchema,
  mimoInterruptedReceiptSchema as receiptSchema, mimoInterruptedOutcome as outcome, mimoInterruptedFailureBytes as resultBytes,
  readPrivateHostedMimoOperationBytes as privateBytes } from "./hosted-mimo-project-bridge-operation";
import { assertProtectedCodexGoalJobBirthUnpublished, withProtectedCodexGoalJobBirthPublication } from "./protected-job-birth";
import { researchJobRuntimeNamespaceAbsent } from "./research-job-runtime-provenance";
import { hostedOrdinaryWriterAuthorityAbsent } from "./hosted-ordinary-writer-authority";
import { parseWorkerLaunchSpec, parseWorkerLaunchState } from "./application/project-control/worker-launch-spec";
import { workerLaunchSpecHasOwnershipBoundWorkKey } from "./application/project-control/codex-goal-project-builtin-pre-start-admission";

const sha = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const hexId = z.string().regex(/^[a-f0-9]{32}$/);
const planSchema = z.object({ schemaVersion: z.literal(1), machineId: hexId, projectId: id, workstreamId: id, jobId: id,
  expectedBindingSha256: sha, expectedOwnerSha256: sha, expectedRequestSha256: sha,
  expectedBootId: hexId, expectedInvocationId: hexId }).strict();
const refused = (): never => { throw new Error(InterruptedProjectCreateErrorCode.ReconciliationRefused); };
const requireFact = (value: unknown): void => { if (!value) refused(); };
type Witness = Readonly<{ unit: string; bootId: string; invocationId: string; startedMonotonicUs: string; failedMonotonicUs: string }>;
function absent(path: string): void {
  let parent = dirname(path);
  for (;;) {
    try { researchCustody(parent); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === "/") throw error; parent = dirname(parent); }
  }
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  refused();
}
function settlementPaths(current: HostedMimoProjectOperationOwner) {
  const root = join(dirname(current.root), "interrupted-create-settlements"), stem = join(root, current.retained.jobId);
  return { root, intent: stem + ".intent.json", receipt: stem + ".receipt.json" };
}

/** Only normalized, structured daemon fields can prove this termination. */
export function decodeHostedMimoCreateTimeoutJournal(text: string, expected: Readonly<{
  machineId: string; unit: string; bootId: string; invocationId: string; operationTimeoutMs: number;
}>): Witness {
  requireFact(Buffer.byteLength(text) <= 2 * 1024 * 1024 && text.endsWith("\n"));
  const lines = text.trimEnd().split("\n"); requireFact(lines.length > 0 && lines.length < 256);
  const manager: Record<string, unknown>[] = [];
  for (const line of lines) {
    const row = researchJson(Buffer.from(line)); requireFact(row && typeof row === "object" && !Array.isArray(row));
    const r = row as Record<string, unknown>;
    if (r._PID !== "1" || r._UID !== "0" || r._COMM !== "systemd" || r.UNIT !== expected.unit) continue;
    requireFact(r._TRANSPORT === "journal" && r._MACHINE_ID === expected.machineId && r._BOOT_ID === expected.bootId &&
      typeof r.__MONOTONIC_TIMESTAMP === "string" && /^[1-9][0-9]{0,19}$/.test(r.__MONOTONIC_TIMESTAMP));
    // Unit-scoped PID1 diagnostics can lack invocation/lifecycle metadata.
    // Ignore only absent keys; malformed or conflicting lifecycle rows refuse.
    if (["INVOCATION_ID", "MESSAGE_ID", "JOB_RESULT", "UNIT_RESULT"].every(key => !Object.hasOwn(r, key))) continue;
    requireFact(r.INVOCATION_ID === expected.invocationId);
    manager.push(r);
  }
  const starts = manager.filter(r => r.MESSAGE_ID === "39f53479d3a045ac8e11786248231fbf" && r.JOB_RESULT === "done");
  const failures = manager.filter(r => r.MESSAGE_ID === "d9b373ed55a64feb8242e02dbe79a49c" && r.UNIT_RESULT === "timeout");
  requireFact(starts.length === 1 && failures.length === 1 && manager.every(r => r.UNIT_RESULT === undefined || r.UNIT_RESULT === "timeout"));
  const start = starts[0]!, failure = failures[0]!;
  const startedMonotonicUs = start.__MONOTONIC_TIMESTAMP as string, failedMonotonicUs = failure.__MONOTONIC_TIMESTAMP as string;
  requireFact(Number.isSafeInteger(expected.operationTimeoutMs) && expected.operationTimeoutMs >= 1000 &&
    BigInt(failedMonotonicUs) - BigInt(startedMonotonicUs) >= BigInt(expected.operationTimeoutMs) * 1000n);
  return Object.freeze({ unit: expected.unit, bootId: expected.bootId, invocationId: expected.invocationId, startedMonotonicUs, failedMonotonicUs });
}
function physicalDeath(unit: string): void {
  const group = "/sys/fs/cgroup/system.slice/" + unit;
  const deadline = performance.now() + 5000;
  let count = 0;
  function scan(path: string): void {
    requireFact(++count <= 512 && performance.now() < deadline);
    const info = lstatSync(path); requireFact(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0);
    requireFact(/^populated 0$/m.test(readFileSync(join(path, "cgroup.events"), "utf8")));
    for (const child of readdirSync(path, { withFileTypes: true })) if (child.isDirectory()) scan(join(path, child.name));
  }
  try { scan(group); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const pids = readdirSync("/proc").filter(name => /^[1-9][0-9]*$/.test(name)); requireFact(pids.length <= 16384);
  for (const pid of pids) {
    requireFact(performance.now() < deadline);
    try {
      const text = readFileSync(`/proc/${pid}/cgroup`, "utf8");
      requireFact(!text.split("\n").some(line => line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1).split("/").includes(unit)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function terminalManager(current: HostedMimoProjectOperationOwner): void {
  const unit = current.value.unit as string;
  const raw = researchCommand("/usr/bin/systemctl", ["show", unit, "--property=Id,LoadState,Description,ActiveState,MainPID,ControlGroup"]);
  const rows = raw.trim().split("\n").map(line => { const at = line.indexOf("="); requireFact(at > 0); return [line.slice(0, at), line.slice(at + 1)] as const; });
  requireFact(new Set(rows.map(row => row[0])).size === 6);
  const state = Object.fromEntries(rows);
  requireFact(state.Id === unit && ["loaded", "not-found"].includes(state.LoadState ?? "") && ["inactive", "failed"].includes(state.ActiveState ?? "") &&
    state.MainPID === "0" && state.ControlGroup === "" && (state.LoadState === "not-found" || state.Description === current.value.description));
  const queue = researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]);
  requireFact(!queue.split("\n").some(line => line.trim().split(/\s+/).includes(unit)));
  physicalDeath(unit);
}
function partials(jobRoot: string, workspace: string, sourceCommit: string, jobId: string) {
  const paths = { prompt: join(jobRoot, "prompt.md"), contract: join(jobRoot, "pre-start-admission", "contract.json"),
    state: join(jobRoot, "pre-start-admission", "state.json"), receipt: join(jobRoot, "pre-start-admission", "receipt.json") };
  const bytes = { prompt: privateBytes(paths.prompt, 1024 * 1024), contract: privateBytes(paths.contract, 256 * 1024),
    state: privateBytes(paths.state, 1024 * 1024), receipt: privateBytes(paths.receipt, 65536) };
  const contract = parseWorkerLaunchSpec(researchJson(bytes.contract)), state = parseWorkerLaunchState(researchJson(bytes.state));
  const receipt = researchJson(bytes.receipt) as Record<string, unknown>;
  const hashes = { promptSha256: researchHash(bytes.prompt), contractSha256: researchHash(bytes.contract), stateSha256: researchHash(bytes.state), receiptSha256: researchHash(bytes.receipt) };
  requireFact(contract.jobId === jobId && contract.jobRoot === jobRoot && contract.promptPath === paths.prompt && contract.workspaceRoot === workspace &&
    contract.phaseStartSha === sourceCommit && contract.baseSha === sourceCommit && workerLaunchSpecHasOwnershipBoundWorkKey(contract) &&
    state.records.length === 1 && state.records[0]!.jobId === jobId && state.records[0]!.workKey === contract.workKey &&
    receipt.schemaVersion === 1 && receipt.status === "validated_not_launched" && receipt.validatorKind === "builtin" &&
    receipt.jobId === jobId && receipt.workKey === contract.workKey && receipt.workspaceHead === sourceCommit &&
    receipt.promptSha256 === hashes.promptSha256 && receipt.contractSha256 === hashes.contractSha256 && receipt.stateSha256 === hashes.stateSha256);
  return { hashes, assertCurrent: () => {
    for (const key of ["prompt", "contract", "state", "receipt"] as const) requireFact(privateBytes(paths[key], 1024 * 1024).equals(bytes[key]));
  } };
}
/** Explicit operator abandonment, never a replay/adoption of an interrupted Create. */
export async function reconcileHostedMimoInterruptedCreate(planPath: string): Promise<InterruptedProjectCreateOutcome> {
  assertResearchInitialRoot(true); assertResearchSharedHost(); researchPath(planPath);
  const planBytes = privateBytes(planPath, 65536), plan = planSchema.parse(researchJson(planBytes));
  requireFact(hostedMimoBridgeMetadataBytes("/etc/machine-id", 1024).toString().trim() === plan.machineId &&
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().replaceAll("-", "") === plan.expectedBootId);
  const stateRoot = `/srv/worker-state/mimo-projects/${plan.projectId}/${plan.workstreamId}`;
  const requestPath = join(stateRoot, "mimo-bridge-operations", plan.jobId + ".create.request.json");
  const request = researchJson(privateBytes(requestPath, 65536));
  const { parseMimoProjectBridgeRequest } = await import("./hosted-mimo-project-bridge-contract");
  const current = readHostedMimoProjectOperationOwner(parseMimoProjectBridgeRequest(request));
  requireFact(current.retained.operation === MimoProjectBridgeOperation.Create && current.value.generation === 0 && current.retained.jobId === plan.jobId &&
    current.retained.machineId === plan.machineId && current.retained.projectId === plan.projectId && current.retained.workstreamId === plan.workstreamId &&
    researchHash(current.ownerBytes) === plan.expectedOwnerSha256 && researchHash(current.requestBytes) === plan.expectedRequestSha256);
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${plan.projectId}/${plan.workstreamId}.json`;
  const bindingBytes = privateBytes(bindingPath, 65536), binding = parseHostedMimoProjectBinding(researchJson(bindingBytes), current.retained);
  requireFact(researchHash(bindingBytes) === plan.expectedBindingSha256 && current.retained.sourceCommit === binding.sourceCommit);
  const jobRoot = join(stateRoot, "jobs", plan.jobId), workspace = join(binding.scratchRoot, "workspaces", plan.jobId);
  const attemptPath = join(stateRoot, "mimo-bridge-attempts", plan.jobId + ".json"), attemptBytes = privateBytes(attemptPath, 4096);
  const attempt = researchRecord(researchJson(attemptBytes), "schemaVersion,requestSha256,projectId,workstreamId,jobId,jobRoot,workspace");
  requireFact(attempt.schemaVersion === 1 && attempt.requestSha256 === researchHash(JSON.stringify(current.retained)) &&
    attempt.projectId === plan.projectId && attempt.workstreamId === plan.workstreamId && attempt.jobId === plan.jobId &&
    attempt.jobRoot === jobRoot && attempt.workspace === workspace);
  const identities = [stateRoot, current.root, jobRoot, workspace, binding.registryRootDir].map(path => { researchCustody(path, true); return researchDirectoryIdentity(path); });
  const preserved = partials(jobRoot, workspace, binding.sourceCommit, plan.jobId), paths = settlementPaths(current);
  const assertBase = () => {
    assertResearchInitialRoot(true); assertResearchSharedHost();
    requireFact(privateBytes(planPath, 65536).equals(planBytes) && privateBytes(bindingPath, 65536).equals(bindingBytes) &&
      privateBytes(current.ownerPath, 65536).equals(current.ownerBytes) && privateBytes(requestPath, 65536).equals(current.requestBytes) &&
      privateBytes(attemptPath, 4096).equals(attemptBytes));
    for (const identity of identities) assertResearchDirectory(identity);
    preserved.assertCurrent(); physicalDeath(current.value.unit as string);
    const registryJob = join(binding.registryRootDir, plan.jobId);
    absent(join(registryJob, "job.json"));
    try { researchCustody(registryJob, true); requireFact(readdirSync(registryJob).length === 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    absent(join(stateRoot, "mimo-runtime-starts", plan.jobId + ".json"));
    requireFact(researchJobRuntimeNamespaceAbsent(plan.jobId) && hostedOrdinaryWriterAuthorityAbsent(plan.jobId));
    for (const name of readdirSync(current.root))
      requireFact(!["start", "repair-admission", "finalize-admission-repair"].some(operation => name.startsWith(plan.jobId + "." + operation + ".")));
  };
  absent(current.resultPath); absent(current.resultPath + ".tmp"); absent(paths.intent); absent(paths.receipt);
  const fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: stateRoot, owner: "interrupted-create:" + researchHash(planBytes) });
  try {
    assertBase(); terminalManager(current);
    const journal = researchCommand("/usr/bin/journalctl", ["--unit=" + current.value.unit, "--no-pager", "--all", "--output=json", "-n", "256"]);
    const witness = decodeHostedMimoCreateTimeoutJournal(journal, { machineId: plan.machineId, unit: current.value.unit as string,
      bootId: plan.expectedBootId, invocationId: plan.expectedInvocationId, operationTimeoutMs: binding.operationTimeoutMs });
    terminalManager(current); // Manager work is prepared before the short birth-publication section.
    const observedAt = performance.now();
    return await withProtectedCodexGoalJobBirthPublication(async () => {
      const assertFresh = () => requireFact(performance.now() - observedAt < 5000);
      const assertSafe = () => {
        assertFresh();
        requireFact((researchJson(privateBytes(fence.path, 65536)) as { ownerToken?: unknown }).ownerToken === fence.ownerToken);
        assertBase(); assertProtectedCodexGoalJobBirthUnpublished(jobRoot);
        assertFresh();
      };
      assertSafe(); absent(current.resultPath); absent(current.resultPath + ".tmp"); absent(paths.intent); absent(paths.receipt);
      try { mkdirSync(paths.root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      researchCustody(paths.root, true);
      const parent = openSync(dirname(paths.root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
      const intent = intentSchema.parse({ schemaVersion: 1, planSha256: researchHash(planBytes), machineId: plan.machineId,
        projectId: plan.projectId, workstreamId: plan.workstreamId, jobId: plan.jobId, ownerSha256: plan.expectedOwnerSha256,
        requestSha256: plan.expectedRequestSha256, bindingSha256: plan.expectedBindingSha256, resultSha256: researchHash(resultBytes),
        witness, partials: { ...preserved.hashes, attemptSha256: researchHash(attemptBytes) }, outcome, cpuCause: "unproven" });
      assertSafe(); researchPublish(paths.intent, intent, true);
      const intentBytes = privateBytes(paths.intent, 16384), receipt = { schemaVersion: 1, complete: false,
        intentSha256: researchHash(intentBytes), resultSha256: researchHash(resultBytes) };
      researchPublish(paths.receipt, receipt, true);
      const pendingReceipt = privateBytes(paths.receipt, 4096);
      const assertPublication = () => {
        assertSafe(); requireFact(privateBytes(paths.intent, 16384).equals(intentBytes) && privateBytes(paths.receipt, 4096).equals(pendingReceipt));
        assertFresh();
      };
      publishHostedMimoProjectOperationResult(current, resultBytes, assertPublication);
      assertPublication(); researchPublish(paths.receipt, { ...receipt, complete: true });
      requireFact(hostedMimoInterruptedCreateComplete(current)); preserved.assertCurrent();
      return outcome;
    });
  } finally { await releaseLocalControllerMaintenanceFence(fence); }
}
