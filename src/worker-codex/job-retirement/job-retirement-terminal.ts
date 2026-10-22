import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codexGoalJobToArgs, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { collectCodexGoalStatus } from "../codex-goal-ops";
import { codexGoalOutputPath, codexGoalProgressPath, codexGoalRuntimeEventsPath } from "../codex-goal-runner";
import { goalLaunchInput } from "../application/codex-goal-launch-input";
import { codexGoalStatusInputFromLaunch } from "../application/codex-goal-status-input";
import { hostedOrdinaryWriterAuthorityAbsent } from "../hosted-ordinary-writer-authority";
import { observeCompatibleProtectedCodexGoalJobBirth, protectedCodexGoalJobBirthNamespacePresent } from "../protected-job-birth";
import { researchJobAuthority } from "../research-launch-admission";
import { researchHash, researchRead } from "../research-launch-files";
import { terminalResearchStart } from "../research-launch-lifecycle";
import { researchJobRuntimeNamespaceAbsent } from "../research-job-runtime-provenance";
import { prepareResearchJobWriterObservation } from "../research-writer-observation";
import { JobRetirementAuthorityProof, JobRetirementRefusal, JobRetirementRole, JobTerminalKind, refuseRetirement,
  type JobTerminalProof } from "./job-retirement-contract";

const eventsTailBytes = 65536;
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
const guarded = async <T>(reason: JobRetirementRefusal, effect: () => T | Promise<T>): Promise<T> => {
  try { return await effect(); } catch { return refuseRetirement(reason); }
};
export type TerminalProofInput = Readonly<{
  manifest: CodexGoalJobManifest; role: JobRetirementRole;
  /** A bridge Start that settled successfully: the job ran even if no record says so now. */
  startedByBridge: boolean;
}>;

/** Explicit runtime records only; nothing is inferred from age or quiet time.
 * Every kind also requires the account reservation to be released. */
export async function proveJobTerminal(input: TerminalProofInput): Promise<JobTerminalProof> {
  const { manifest } = input;
  if (present(join(manifest.jobRootDir, "account-reservation.json"))) refuseRetirement(JobRetirementRefusal.AccountReserved);
  // The prepared reader is the one that certifies a terminal native start as
  // released; it is read-only (no closure receipt is issued from here).
  const writer = async () => (await guarded(JobRetirementRefusal.WriterNotReleased,
    async () => await (await prepareResearchJobWriterObservation(manifest))())).status;
  if (input.role === JobRetirementRole.Controller) {
    if (await writer() === "released") return { kind: JobTerminalKind.ControllerClosed, writer: JobRetirementAuthorityProof.Released };
    if (authorityAbsent(manifest)) return { kind: JobTerminalKind.ControllerClosed, writer: JobRetirementAuthorityProof.Absent };
    return refuseRetirement(JobRetirementRefusal.WriterNotReleased);
  }
  if (!researchJobRuntimeNamespaceAbsent(manifest.jobId)) return await nativeTerminal(manifest, writer);
  const launch = await guarded(JobRetirementRefusal.ManifestInvalid, () => goalLaunchInput(codexGoalJobToArgs(manifest)));
  const eventsPath = codexGoalRuntimeEventsPath(launch.config);
  if (present(eventsPath)) {
    if (!hostedOrdinaryWriterAuthorityAbsent(manifest.jobId) && await writer() !== "released") refuseRetirement(JobRetirementRefusal.WriterNotReleased);
    const lastEvent = await guarded(JobRetirementRefusal.RunnerNotDisposed, () => lastRunnerEvent(eventsPath, manifest.jobId));
    const status = await guarded(JobRetirementRefusal.WorkerAlive, () => collectCodexGoalStatus({ ...codexGoalStatusInputFromLaunch(launch),
      ...(manifest.tmuxSession ? { tmuxSession: manifest.tmuxSession } : {}) }));
    if (status.tmuxAlive === true || status.progressProcessAlive === true || status.appServerProcessAlive === true)
      refuseRetirement(JobRetirementRefusal.WorkerAlive);
    return { kind: JobTerminalKind.RunnerDisposed, eventsPath, lastEventSha256: researchHash(lastEvent) };
  }
  // Never started: no runtime ever wrote anything a run leaves behind.
  if (input.startedByBridge || present(codexGoalProgressPath(launch.config)) || present(codexGoalOutputPath(launch.config)) ||
      !hostedOrdinaryWriterAuthorityAbsent(manifest.jobId) || !preStartAdmissionUnlaunched(manifest))
    refuseRetirement(JobRetirementRefusal.NeverStartedUnproven);
  if (!protectedCodexGoalJobBirthNamespacePresent(manifest.jobRootDir)) return { kind: JobTerminalKind.NeverStarted, birth: JobRetirementAuthorityProof.Absent };
  // A released compatible birth is the protected proof that no first effect happened.
  if ((await observeCompatibleProtectedCodexGoalJobBirth(manifest)).status !== "released") refuseRetirement(JobRetirementRefusal.NeverStartedUnproven);
  return { kind: JobTerminalKind.NeverStarted, birth: JobRetirementAuthorityProof.Released };
}

async function nativeTerminal(manifest: CodexGoalJobManifest, writer: () => Promise<string>): Promise<JobTerminalProof> {
  const authority = researchJobAuthority(manifest.jobId);
  if (present(join(authority, "active.json"))) refuseRetirement(JobRetirementRefusal.ActiveStart);
  // Matches last-terminal.json to its spec and proves runtime and provider units inactive.
  const terminal = await guarded(JobRetirementRefusal.TerminalUnproven, () => terminalResearchStart(manifest.jobId));
  if (terminal.spec.request.jobRootDir !== manifest.jobRootDir || terminal.spec.request.workspacePath !== manifest.workspacePath)
    refuseRetirement(JobRetirementRefusal.TerminalUnproven);
  const starts = join(authority, "starts");
  for (const startId of readdirSync(starts)) {
    const directory = join(starts, startId);
    if (present(join(directory, "mimo-candidate.json")) && !present(join(directory, "mimo-publication.json")))
      refuseRetirement(JobRetirementRefusal.CandidateUnpublished);
  }
  if (await writer() !== "released") refuseRetirement(JobRetirementRefusal.WriterNotReleased);
  return { kind: JobTerminalKind.NativeReleased, startId: terminal.spec.startId, specSha256: researchHash(terminal.bytes),
    lastTerminalSha256: researchHash(researchRead(join(authority, "last-terminal.json"))) };
}
/** A closed native job on replay: its pins may already be gone, so the writer
 * reader can no longer certify it. The exact records the close was based on
 * must still hold; after a reboot the reboot itself proves that no unit or pin
 * of the closing boot runs, and only absent run-state is accepted. Every other
 * kind is proven again in full by the caller. */
export function assertClosedNativeTerminalCurrent(manifest: CodexGoalJobManifest, proof: JobTerminalProof, closedBootId: string, bootId: string): void {
  if (proof.kind !== JobTerminalKind.NativeReleased) return;
  if (present(join(manifest.jobRootDir, "account-reservation.json"))) refuseRetirement(JobRetirementRefusal.AccountReserved);
  if (closedBootId !== bootId && researchJobRuntimeNamespaceAbsent(manifest.jobId)) return;
  const authority = researchJobAuthority(manifest.jobId);
  if (present(join(authority, "active.json"))) refuseRetirement(JobRetirementRefusal.ActiveStart);
  let lastTerminal: Buffer, spec: Buffer;
  try {
    lastTerminal = researchRead(join(authority, "last-terminal.json"));
    spec = researchRead(join(authority, "starts", proof.startId, "spec.json"));
  } catch { return refuseRetirement(JobRetirementRefusal.TerminalUnproven); }
  if (researchHash(lastTerminal) !== proof.lastTerminalSha256 || researchHash(spec) !== proof.specSha256)
    refuseRetirement(JobRetirementRefusal.TerminalUnproven);
}
function authorityAbsent(manifest: CodexGoalJobManifest): boolean {
  return researchJobRuntimeNamespaceAbsent(manifest.jobId) && hostedOrdinaryWriterAuthorityAbsent(manifest.jobId) &&
    !protectedCodexGoalJobBirthNamespacePresent(manifest.jobRootDir);
}
/** The goal runner writes `runner_disposed` last, after its executor is disposed. */
function lastRunnerEvent(path: string, jobId: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let tail: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("runner_events_invalid");
    const length = Math.min(stat.size, eventsTailBytes);
    tail = Buffer.alloc(length);
    if (readSync(fd, tail, 0, length, stat.size - length) !== length) throw new Error("runner_events_invalid");
  } finally { closeSync(fd); }
  const last = tail.toString("utf8").split("\n").filter(line => line.trim()).at(-1);
  const event = last ? JSON.parse(last) as { event?: unknown; attributes?: { jobId?: unknown } } : undefined;
  if (event?.event !== "runner_disposed" || event.attributes?.jobId !== jobId) throw new Error("runner_not_disposed");
  return last!;
}
/** The admission receipt of a never-launched job says so explicitly. */
function preStartAdmissionUnlaunched(manifest: CodexGoalJobManifest): boolean {
  const descriptor = manifest.projectPreStartAdmission;
  if (!descriptor) return true;
  try {
    const receipt = JSON.parse(readFileSync(descriptor.receiptPath, "utf8")) as { status?: unknown; launchAuthorizationCount?: unknown };
    return receipt.status === "validated_not_launched" && (receipt.launchAuthorizationCount === undefined || receipt.launchAuthorizationCount === 0);
  } catch { return false; } // A missing or unreadable receipt is doubt, not absence of a launch.
}
