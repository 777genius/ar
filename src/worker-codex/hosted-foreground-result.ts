import { selectedRequest, storedRequestPlan, installedInventory, assertHostedForegroundPriorOutput, type HostedForegroundRequest } from "./hosted-foreground-request-custody";
export { requireHostedForegroundRequest, closeHostedForegroundRequest, recheckHostedForegroundRequest, type HostedForegroundRequest } from "./hosted-foreground-request-custody";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { assertHostedActivationFence, withHostedActivationFence, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { assertHostedForegroundResult, HostedForegroundArtifactKind, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { assertReadonlyHostOperator, decodePrivateJson } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { readonlySupervisorRoot } from "./hosted-readonly-custody";
import { completionBytes, completionPath, ordinaryCompletionBytes, ordinaryCompletionPath, HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "./hosted-readonly-host-kernel";
import { HostedCustodyReservationState, parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { isHostedOrdinaryRuntime, readHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { HostedReadonlyEpochStore } from "./hosted-readonly-epoch-store";
import { parseStoredProjectStartArgs, parseStoredProjectStartBinding,
  resolveStoredProjectStartPlan, type StoredProjectStartPlan } from "./stored-start-planning";
import type { ProjectControlMcpArgs } from "./codex-goal-mcp-inputs";

const published = new WeakSet<object>();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function denied(): never { throw new Error("hosted_foreground_result_unresolved"); }
function ancestry(path: string): void {
  for (let directory = dirname(path);; directory = dirname(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) denied();
    if (directory === "/") break;
  }
}
function stableBytes(path: string, expected?: { dev: string; ino: string; byteLength: number; sha256: string }): Buffer {
  ancestry(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), entry = lstatSync(path);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o077) ||
        before.size > 64 * 1024 * 1024 || entry.dev !== before.dev || entry.ino !== before.ino) denied();
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    if (bytes.length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.dev !== before.dev || current.ino !== before.ino || current.ctimeMs !== after.ctimeMs ||
        expected && (String(before.dev) !== expected.dev || String(before.ino) !== expected.ino ||
          bytes.length !== expected.byteLength || hash(bytes) !== expected.sha256)) denied();
    return bytes;
  } finally { closeSync(fd); }
}

/** Only the actual retained ordinary runtime selects this start. Equality
 * supplied in tool JSON is never an alternative to that original origin. */
export function hostedStoredProjectStartPlan(args: ProjectControlMcpArgs): StoredProjectStartPlan | undefined {
  if (!isHostedOrdinaryRuntime()) return undefined;
  return withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryRuntime(fence);
    if (origin.launch.args[1] !== "tool") return undefined;
    const plan = storedRequestPlan(origin.launch.args, origin.launch.cwd);
    const actual = parseStoredProjectStartArgs(JSON.stringify(args));
    const sameArgs = (value: ProjectControlMcpArgs) => JSON.stringify(Object.keys(value).sort().map(key =>
      [key, key === "storedStartBinding" ? parseStoredProjectStartBinding(value.storedStartBinding) : value[key as keyof ProjectControlMcpArgs]]));
    if (sameArgs(actual) !== sameArgs(plan.args) || origin.creator.jobId !== plan.jobId ||
        origin.creator.jobRootDir !== plan.jobRoot || origin.creator.workspacePath !== plan.workspace) denied();
    return resolveStoredProjectStartPlan(origin.launch.args[4]!, origin.launch.cwd);
  });
}
function selectOutputPath(path: string): void {
  const { inventory } = installedInventory();
  const launches = [inventory.runtimeLaunch, ...inventory.ordinaryCreators.map(row => row.launch)];
  if (!launches.some(launch => {
    try { return selectedRequest(launch.args, launch.cwd).path === path; } catch { return false; }
  })) denied();
}
/** Runs synchronously inside the existing actual owner's terminal fence. It
 * preserves the existing result and artifacts, adding data refs, not authority. */
export function publishHostedForegroundResult(request: HostedForegroundRequest, result: HostedForegroundResult,
  owner: { jobRootDir: string; args: readonly string[]; fence: HostedActivationFence }): HostedForegroundResult {
  assertReadonlyHostOperator(); assertHostedForegroundResult(result);
  assertHostedActivationFence(owner.fence);
  const origin = foregroundOrigin(result.unit, result.exitCode);
  if (origin.jobRoot !== owner.jobRootDir || JSON.stringify(origin.args) !== JSON.stringify(owner.args) ||
      selectedRequest(origin.args, `${origin.jobRoot}/workspace`).path !== request.path) denied();
  if (published.has(result) || request.jobRoot !== owner.jobRootDir || JSON.stringify(request.args) !== JSON.stringify(owner.args)) denied();
  const original = stableBytes(request.path), value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original));
  assertHostedForegroundPriorOutput(request, lstatSync(request.path));
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const envelope = value as Record<string, unknown>;
  if (!["done", "partial", "blocked", "failed"].includes(envelope.status as string) ||
      ![envelope.changedFiles, envelope.evidence, envelope.blockers].every(a => Array.isArray(a) && a.every(s => typeof s === "string")) ||
      typeof envelope.nextAction !== "string" || envelope.artifacts !== undefined && !Array.isArray(envelope.artifacts) ||
      envelope.details !== undefined && (!envelope.details || typeof envelope.details !== "object" || Array.isArray(envelope.details))) denied();
  const details = envelope.details as Record<string, unknown> | undefined;
  if (details?.hostedForegroundUnit === result.unit) denied();
  if ((envelope.artifacts as Record<string, unknown>[] | undefined)?.some(row =>
      result.artifacts.some(artifact => row?.kind === artifact.kind && row?.path === artifact.path))) denied();
  for (const artifact of result.artifacts) stableBytes(artifact.path, artifact);
  const next = Buffer.from(JSON.stringify({ ...envelope, details: { ...details, hostedForegroundUnit: result.unit,
    hostedForegroundExitCode: String(result.exitCode) }, artifacts: [...(envelope.artifacts as unknown[] ?? []), ...result.artifacts] }) + "\n");
  if (next.length > 64 * 1024 * 1024) denied();
  const temporary = `${request.path}.foreground-${result.startId}.next`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, next); fsyncSync(fd); } finally { closeSync(fd); }
  if (!stableBytes(request.path).equals(original)) denied();
  renameSync(temporary, request.path);
  if (!stableBytes(request.path).equals(next)) denied();
  const outputStat = lstatSync(request.path);
  const attestation = Buffer.from(JSON.stringify({ schemaVersion: 1, unit: result.unit, startId: result.startId,
    startSha256: origin.startSha256, outputPath: request.path, outputDev: String(outputStat.dev), outputIno: String(outputStat.ino),
    outputSha256: hash(next), exitCode: result.exitCode }) + "\n");
  const receiptFd = openSync(resultReceiptPath(result.unit), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(receiptFd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077)) denied();
    writeFileSync(receiptFd, attestation); fsyncSync(receiptFd);
  } finally { closeSync(receiptFd); }
  if (!stableBytes(resultReceiptPath(result.unit)).equals(attestation)) denied();
  published.add(result); return result;
}
export function hostedForegroundExitCode(result: number | HostedForegroundResult): number {
  if (typeof result === "number") return result;
  if (!published.has(result)) denied();
  return result.exitCode;
}
export function readHostedForegroundResultRecord(path: string): Readonly<{ value: Record<string, unknown>;
  output: Readonly<{ unit: string; exitCode: number; stdout: string; stderr: string }> }> {
  return withHostedActivationFence(() => {
  selectOutputPath(path);
  const bytes = stableBytes(path);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) denied();
  const output = readPayload(path, bytes, value as Record<string, unknown>);
  if (!output || !stableBytes(path).equals(bytes)) denied();
  return Object.freeze({ value: value as Record<string, unknown>, output });
  });
}

/** Existing result/status adapter calls this port. Serialized refs alone never
 * authorize root IO: the actual protected installation/start/output tuple must
 * select the same two fixed log paths first. */
export function readHostedForegroundPayload(path: string): Readonly<{ unit: string; exitCode: number; stdout: string; stderr: string }> | undefined {
  return withHostedActivationFence(() => {
    selectOutputPath(path);
    const bytes = stableBytes(path), value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    return readPayload(path, bytes, value);
  });
}
function readPayload(path: string, bytes: Buffer, value: Record<string, unknown>) {
  const details = value.details as Record<string, unknown> | undefined;
  if (details?.hostedForegroundUnit === undefined) return undefined;
    assertReadonlyHostOperator();
    const unit = details.hostedForegroundUnit;
    if (typeof unit !== "string" || !Array.isArray(value.artifacts)) denied();
    const receiptBytes = stableBytes(resultReceiptPath(unit));
    const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes)) as Record<string, unknown>;
    const outputStat = lstatSync(path);
    if (Object.keys(receipt).sort().join(",") !== "exitCode,outputDev,outputIno,outputPath,outputSha256,schemaVersion,startId,startSha256,unit" ||
        receipt.schemaVersion !== 1 || receipt.unit !== unit || receipt.outputPath !== path || receipt.outputSha256 !== hash(bytes) ||
        receipt.outputDev !== String(outputStat.dev) || receipt.outputIno !== String(outputStat.ino) ||
        !Number.isInteger(receipt.exitCode) || (receipt.exitCode as number) < 0 || (receipt.exitCode as number) > 255 ||
        details.hostedForegroundExitCode !== String(receipt.exitCode)) denied();
    const { jobRoot, args, startSha256 } = foregroundOrigin(unit, receipt.exitCode as number);
    if (receipt.startSha256 !== startSha256 || receipt.startId !== unit.replace(/^subscription-runtime-(?:outer|ordinary)-/, "").replace(/\.service$/, "") ||
        selectedRequest(args, `${jobRoot}/workspace`).path !== path) denied();
    const read = (kind: HostedForegroundArtifactKind): string => {
      const selected = value.artifacts as Record<string, unknown>[];
      const logPath = `/var/lib/subscription-runtime-host-policy/foreground-output/${unit}.${kind === HostedForegroundArtifactKind.Stdout ? "stdout" : "stderr"}`;
      const records = selected.filter(row => row?.kind === kind && row.path === logPath);
      if (records.length !== 1) denied();
      const row = records[0]!;
      if (Object.keys(row).sort().join(",") !== "byteLength,dev,ino,kind,path,sha256" ||
          typeof row.dev !== "string" || typeof row.ino !== "string" || typeof row.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.byteLength)) denied();
      return new TextDecoder("utf-8", { fatal: true }).decode(stableBytes(logPath,
        { dev: row.dev, ino: row.ino, byteLength: row.byteLength as number, sha256: row.sha256 }));
    };
    const result = Object.freeze({ unit, exitCode: receipt.exitCode as number,
      stdout: read(HostedForegroundArtifactKind.Stdout), stderr: read(HostedForegroundArtifactKind.Stderr) });
    if (!stableBytes(path).equals(bytes)) denied();
    return result;
}
function resultReceiptPath(unit: string): string {
  if (!/^subscription-runtime-(ordinary|outer)-[a-f0-9-]{36}\.service$/.test(unit)) denied();
  return `${readonlySupervisorRoot}/foreground-output/${unit}.result.json`;
}
function foregroundOrigin(unit: string, exitCode: number): { jobRoot: string; args: readonly string[]; startSha256: string } {
    const match = /^subscription-runtime-(ordinary|outer)-([a-f0-9-]{36})\.service$/.exec(unit);
    if (!match) denied();
    const { installation, activation, inventory } = installedInventory();
    const kernel = new HostedReadonlyHostKernel();
    const startBytes = readHostedPrivateBytes(`${readonlySupervisorRoot}/${match[1] === "ordinary" ? `ordinary-starts/${match[2]}.json` : `readonly-outer-start-${match[2]}.json`}`, 64 * 1024);
    if (!startBytes) denied();
    const start = decodePrivateJson(startBytes) as Record<string, unknown>;
    let jobRoot: string, args: readonly string[];
    if (match[1] === "ordinary") {
      const ordinary = parseHostedOrdinaryStart(start);
      if (ordinary.unit !== unit || ordinary.installationId !== installation.installationId) denied();
      const reservation = activation.ordinaryStarts.find(row => row.startId === match[2]);
      if (!reservation || reservation.unit !== unit || reservation.creatorId !== ordinary.creatorId || reservation.originSha256 !== ordinary.originSha256) denied();
      if (exitCode === 0) {
        if (!readHostedPrivateBytes(ordinaryCompletionPath(match[2]!), 4096)?.equals(ordinaryCompletionBytes(match[2]!, hash(startBytes)))) denied();
        kernel.fenceOrdinaryCreator(reservation, ordinary.bootId, hash(startBytes));
      }
      kernel.drainOrdinaryQueue(reservation); kernel.confirmOrdinaryDescendants(reservation);
      const creator = inventory.ordinaryCreators.find(row => row.creatorId === ordinary.creatorId);
      if (!creator || creator.jobId !== ordinary.jobId || creator.jobRootDir !== ordinary.jobRootDir) denied(); jobRoot = creator.jobRootDir; args = creator.launch.args;
    } else {
      const epoch = new HostedReadonlyEpochStore().readEpoch();
      const reservation = { startId: match[2]!, creatorId: match[2]!, unit, state: HostedCustodyReservationState.Terminal };
      if (Object.keys(start).sort().join(",") !== "bootId,creatorId,generation,hostId,jobId,schemaVersion,startId,unit" ||
          start.schemaVersion !== 1 || start.hostId !== epoch.hostId || start.creatorId !== match[2] ||
          typeof start.bootId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(start.bootId) ||
          !Number.isSafeInteger(start.generation) || (start.generation as number) < 1 || (start.generation as number) > epoch.generation ||
          start.unit !== unit || start.startId !== match[2] || start.jobId !== epoch.identity.jobId) denied();
      if (exitCode === 0) {
        if (!readHostedPrivateBytes(completionPath(reservation), 4096)?.equals(completionBytes(reservation, 0))) denied();
        kernel.fenceCreator(reservation, start.bootId as string);
      }
      kernel.drainQueuedStart(reservation); kernel.confirmTerminalDescendants(reservation);
      jobRoot = epoch.identity.jobRootDir; args = inventory.runtimeLaunch.args;
    }
    return { jobRoot, args, startSha256: hash(startBytes) };
}
