import { trustedResearchProviderLaunch } from "./trusted-custody-systemd-launch";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assertResearchProviderNotCancelled, readResearchProviderReservation, ResearchProviderSubmissionState,
  signalResearchProvider } from "./research-launch-lifecycle";
import { captureResearchRuntime, researchCurrentStart } from "./research-launch-admission";
import { isResearchDenialObservation, researchInvalid, researchPublish, type ResearchDenialObservation } from "./research-launch-files";
import { researchExecutableDigest, researchProcessIdentity, researchProviderUnitPattern, researchServiceIdentity } from "./research-launch-host";
import { researchProviderSetupTimeoutMs } from "./research-launch-contract";
import { assertResearchProviderRoot, prepareResearchProviderRoot, researchProviderRootFailureCheck, type ResearchProviderRootCheck } from "./research-provider-root";

const denialChecks = ["assertResearchInitialRoot", "assertResearchSharedHost", "researchCustody", "researchRead",
  "researchCurrentStart", "researchServiceIdentity", "researchCommand", "researchProcessIdentity",
  "assertResearchServiceOwner", "assertResearchStartAuthority", "assertAuthorityCurrent", "captureResearchRuntime",
  "assertTransportPermission"] as const;
type DenialCheck = typeof denialChecks[number] | ResearchProviderRootCheck;
const observedChecks = new WeakMap<Error, DenialCheck>();
function ownErrorData(error: unknown, key: string): unknown {
  try {
    if (!(error instanceof Error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function denialObservation(error: unknown): ResearchDenialObservation | undefined {
  const cause = ownErrorData(error, "cause");
  return isResearchDenialObservation(cause) ? cause : undefined;
}
function denialCheck(error: unknown, legacyFrames = true): DenialCheck | undefined {
  const root = researchProviderRootFailureCheck(error);
  if (root) return root;
  // Root planning observations are identity-bound, never inferred from a stack
  // supplied by an adapter. Preserve legacy native frames in the other phases.
  if (!legacyFrames) return undefined;
  try {
    if (!(error instanceof Error)) return undefined;
    const observed = observedChecks.get(error);
    if (observed) return observed;
    const stack = error.stack;
    if (typeof stack !== "string" || stack.length > 65536) return undefined;
    return stack.split("\n").slice(1, 65).flatMap(line => denialChecks.filter(name =>
      [`at ${name} (`, `at Object.${name} (`].some(prefix => line.trimStart().startsWith(prefix))))[0];
  } catch { return undefined; }
}

/** The first bytes belong solely to the fixed confined launcher, before it has
 * bootstrap input or a native provider. Never forward readiness into JSON-RPC. */
function monitorResearchReady(proxy: ReturnType<typeof spawn>, assertPermission: () => void, deadline: number) {
  const stream = proxy.stdout;
  if (!stream) researchInvalid();
  const expected = Buffer.from("subscription-runtime-research-provider-ready-v1\n");
  let received = 0, failed = false, readyDeadline = deadline;
  let refusal: Error | undefined;
  let observation: ResearchDenialObservation | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Rejection alone has no effect once ready has resolved. Keep the failure
  // latched until the synchronous transition to native protocol forwarding.
  const denied = (error?: unknown): void => {
    observation = denialObservation(error) ?? observation;
    failed = true;
    refusal ??= new Error("hosted_research_launch_denied", { cause: observation });
    const check = denialCheck(error);
    if (check) observedChecks.set(refusal, check);
    rejectReady(refusal);
  };
  const check = (): boolean => {
    if (failed) return false;
    try { assertPermission(); if (performance.now() >= readyDeadline || proxy.exitCode !== null || proxy.signalCode !== null) researchInvalid(); }
    catch (error) { denied(error); return false; }
    return true;
  };
  const onData = (chunk: Buffer): void => {
    const observedAt = performance.now();
    if (!check()) return;
    // Match a bounded prefix without accumulating stream data. Every byte
    // after the exact frame is forbidden while bootstrap is still held.
    if (received + chunk.length > expected.length || !expected.subarray(received, received + chunk.length).equals(chunk)) { denied(); return; }
    received += chunk.length;
    if (received === expected.length) {
      // The fixed launcher allows ten seconds to receive bootstrap after ready.
      readyDeadline = Math.min(deadline, observedAt + 10_000);
      resolveReady();
    }
  };
  const timer = setInterval(check, 25); // Fence/timeout polling, never proof of readiness.
  stream.on("data", onData); stream.once("end", denied); stream.once("close", denied); stream.once("error", denied);
  proxy.once("exit", denied); proxy.once("error", denied);
  check();
  return {
    ready,
    assertCurrent: (): void => { if (!check()) { if (refusal) throw refusal; researchInvalid(observation); } },
    stop: (): void => {
      clearInterval(timer);
      stream.off("data", onData); stream.off("end", denied); stream.off("close", denied); stream.off("error", denied);
      proxy.off("exit", denied); proxy.off("error", denied);
    },
  };
}

/** Invoked only as a direct child of the authenticated runtime MainPID. The
 * provider gets separate PID/user/mount namespaces and no host authority. */
export async function runResearchProviderService(jobId: string, unit: string, selectedCodexHome: string): Promise<void> {
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const { directory } = researchCurrentStart(jobId);
  const state: { phase: ResearchProviderLaunchPhase } = { phase: "runtime-capture" };
  try { await runAdmittedResearchProvider(jobId, unit, selectedCodexHome, next => { state.phase = next; }); }
  catch (error) {
    const phase = state.phase;
    // Root-private observation only, never authority. Retain a finite phase;
    // raw stderr/errors can contain credentials and must remain private.
    // Fixed internal frame labels only, never arbitrary stack/error text.
    const check = denialCheck(error, phase !== "service-plan");
    const observation = denialObservation(error);
    try { researchPublish(join(directory, "provider-failure.json"), { schemaVersion: 1, unit, phase,
      ...(check ? { check } : {}),
      ...(observation ? { observation } : {}),
    }); }
    catch { /* Original denial remains authoritative when observation fails. */ }
    throw error;
  }
}

type ResearchProviderLaunchPhase = "runtime-capture" | "reservation" | "service-plan" | "executable-custody" |
  "submission-custody" | "systemd-submission" | "ready-and-owner" | "native-forwarding";
async function runAdmittedResearchProvider(jobId: string, unit: string, selectedCodexHome: string,
  phase: (next: ResearchProviderLaunchPhase) => void): Promise<void> {
  const { spec, directory } = researchCurrentStart(jobId), request = spec.request;
  const captured = captureResearchRuntime(request, process.ppid);
  phase("reservation");
  const reservation = readResearchProviderReservation(directory, unit);
  assertResearchProviderNotCancelled(directory, unit);
  phase("service-plan");
  const rootPlan = prepareResearchProviderRoot(spec, unit, selectedCodexHome);
  const launch = trustedResearchProviderLaunch(spec, unit, selectedCodexHome, rootPlan);
  phase("executable-custody");
  for (const path of [launch.command, "/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini"]) researchExecutableDigest(path);
  const assertForwardPermission = (): void => {
    captured.assertAuthorityCurrent(); assertResearchProviderNotCancelled(directory, unit);
  };
  phase("submission-custody");
  assertForwardPermission();
  const submissionPath = join(directory, "providers", unit + ".submission.json");
  const publishSubmission = (state: ResearchProviderSubmissionState, exclusive = false): void =>
    researchPublish(submissionPath, { schemaVersion: 1, unit, specSha256: reservation.specSha256, state }, exclusive);
  // Persist uncertainty before crossing the asynchronous systemd transport.
  publishSubmission(ResearchProviderSubmissionState.Pending, true);
  let child: ReturnType<typeof spawn> | undefined, proxyExited = false;
  try {
    // Material is checked at the actual launch boundary, never by readiness
    // polling. Cancellation can race both the pending publication and the walk.
    captured.assertCurrent();
    assertForwardPermission();
    assertResearchProviderRoot(rootPlan, spec, unit, selectedCodexHome);
    phase("systemd-submission");
    const proxy = spawn(launch.command, launch.args, { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
    child = proxy;
    // Hold the provider bootstrap frame until the actual service PID/birth/boot is
    // retained. No app-server/auth bootstrap runs before that ownership record.
    let terminalTimer: ReturnType<typeof setTimeout> | undefined, transportFailed = false, inputReleased = false;
    const terminal = new Promise<void>((resolve, reject) => {
      const failed = (): void => { transportFailed = true; reject(new Error("hosted_research_launch_denied")); };
      proxy.once("error", failed);
      proxy.once("exit", (code, signal) => { proxyExited = true; clearTimeout(terminalTimer); process.exitCode = signal ? 70 : code ?? 70; resolve(); });
      // systemd has its own maximum; bound this direct stream transport as well.
      terminalTimer = setTimeout(failed, request.taskTimeoutMs + 30_000);
      proxy.stdout.once("error", failed); proxy.stderr.once("error", failed);
      proxy.stdin.on("error", error => {
        if (!inputReleased || (error as NodeJS.ErrnoException).code !== "EPIPE") failed();
      });
    });
    proxy.stderr.pipe(process.stderr);
    void terminal.catch(() => {}); // Observed below; never an unhandled early exit.
    void terminal.finally(() => clearTimeout(terminalTimer)).catch(() => {});
    let assertRetainedOwner: (() => void) | undefined;
    // Selected TEST chains observed 98.7s; native systemd setup alone took 119.2s.
    // Bound OS setup and ownership together within the outer app-server
    // startup budget; retain all fences and hold bootstrap throughout.
    const deadline = performance.now() + researchProviderSetupTimeoutMs;
    const assertTransportPermission = (): void => {
      assertForwardPermission();
      if (performance.now() >= deadline || proxyExited || transportFailed || proxy.stdin.destroyed || proxy.stdout.destroyed || proxy.stdout.readableEnded) researchInvalid();
    };
    phase("ready-and-owner");
    const readiness = monitorResearchReady(proxy, assertTransportPermission, deadline);
    try {
      await readiness.ready;
      for (let attempt = 0; attempt < 100 && performance.now() < deadline && proxy.exitCode === null; attempt++) {
        readiness.assertCurrent();
        try {
          const service = researchServiceIdentity(unit), identity = researchProcessIdentity(service.mainPid);
          if (service.description !== reservation.description || identity.controlGroup !== service.controlGroup) researchInvalid();
          // Corroborate settled ownership after readiness, including namespaces.
          // Type=exec's first MainPID observation before unshare is insufficient.
          if (JSON.stringify(researchServiceIdentity(unit)) !== JSON.stringify(service) ||
              JSON.stringify(researchProcessIdentity(service.mainPid)) !== JSON.stringify(identity)) researchInvalid();
          readiness.assertCurrent();
          researchPublish(join(directory, "providers", unit + ".owner.json"), { schemaVersion: 1, process: identity, service }, true);
          assertRetainedOwner = (): void => {
            if (JSON.stringify(researchServiceIdentity(unit)) !== JSON.stringify(service) ||
                JSON.stringify(researchProcessIdentity(service.mainPid)) !== JSON.stringify(identity)) researchInvalid();
          };
          break;
        } catch (error) {
          if (attempt === 99) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (!assertRetainedOwner) researchInvalid();
      // Exactly one full material walk during handoff. It must finish within
      // both budgets; a file/artifact deadline remains a denial, never admission.
      captured.assertCurrent();
      const currentLaunch = trustedResearchProviderLaunch(spec, unit, selectedCodexHome, rootPlan);
      if (currentLaunch.command !== launch.command || JSON.stringify(currentLaunch.args) !== JSON.stringify(launch.args)) researchInvalid();
      // Keep the control guard attached through the walk and then yield once:
      // EOF/duplicates queued during synchronous Host I/O must latch before the
      // final synchronous authority/owner/transport check and stdin release.
      await new Promise<void>(resolve => setImmediate(resolve));
      const settledLaunch = trustedResearchProviderLaunch(spec, unit, selectedCodexHome, rootPlan);
      if (settledLaunch.command !== launch.command || JSON.stringify(settledLaunch.args) !== JSON.stringify(launch.args)) researchInvalid();
      assertRetainedOwner();
      readiness.assertCurrent(); // An accepted start is not permission to send auth.
      readiness.stop(); // No async gap between control consumption and forwarding.
      phase("native-forwarding");
      proxy.stdout.pipe(process.stdout);
      inputReleased = true;
      process.stdin.pipe(proxy.stdin);
      await terminal;
    } finally { readiness.stop(); clearTimeout(terminalTimer); }
  } catch (error) {
    if (child?.stdin) { process.stdin.unpipe(child.stdin); child.stdin.destroy(); }
    try { signalResearchProvider(directory, unit); } catch { /* Retained ownership is reconciled by operator cancel. */ }
    // Only our direct transport child; stopping it does not undo an accepted
    // service request. Its reservation and pending submission remain on doubt.
    child?.kill("SIGTERM");
    throw error;
  } finally {
    if (!child || proxyExited) publishSubmission(ResearchProviderSubmissionState.Settled);
  }
}
