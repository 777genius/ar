import { trustedResearchProviderLaunch } from "./trusted-custody-systemd-launch";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assertResearchProviderNotCancelled, readResearchProviderReservation, ResearchProviderSubmissionState,
  signalResearchProvider } from "./research-launch-lifecycle";
import { captureResearchRuntime, researchCurrentStart } from "./research-launch-admission";
import { researchInvalid, researchPublish } from "./research-launch-files";
import { researchExecutableDigest, researchProcessIdentity, researchProviderUnitPattern, researchServiceIdentity } from "./research-launch-host";

/** The first bytes belong solely to the fixed confined launcher, before it has
 * bootstrap input or a native provider. Never forward readiness into JSON-RPC. */
function awaitResearchReady(proxy: ReturnType<typeof spawn>, assertPermission: () => void, deadline: number): Promise<void> {
  const stream = proxy.stdout;
  if (!stream) researchInvalid();
  const expected = Buffer.from("subscription-runtime-research-provider-ready-v1\n");
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      clearInterval(timer);
      stream.off("data", onData); stream.off("end", denied); stream.off("close", denied); stream.off("error", denied);
      proxy.off("exit", denied); proxy.off("error", denied);
    };
    const denied = (): void => { cleanup(); reject(new Error("hosted_research_launch_denied")); };
    const check = (): boolean => {
      try { assertPermission(); if (performance.now() >= deadline || proxy.exitCode !== null || proxy.signalCode !== null) researchInvalid(); }
      catch { denied(); return false; }
      return true;
    };
    const onData = (chunk: Buffer): void => {
      if (!check()) return;
      // A fixed prefix bounds both partial frames and newline-free streams.
      if (buffered.length + chunk.length > expected.length) { denied(); return; }
      buffered = Buffer.concat([buffered, chunk]);
      if (!expected.subarray(0, buffered.length).equals(buffered)) { denied(); return; }
      if (buffered.length === expected.length) { stream.pause(); cleanup(); resolve(); }
    };
    const timer = setInterval(check, 25); // Fence/timeout polling, never proof of readiness.
    stream.on("data", onData); stream.once("end", denied); stream.once("close", denied); stream.once("error", denied);
    proxy.once("exit", denied); proxy.once("error", denied);
    check();
  });
}

/** Invoked only as a direct child of the authenticated runtime MainPID. The
 * provider gets separate PID/user/mount namespaces and no host authority. */
export async function runResearchProviderService(jobId: string, unit: string, selectedCodexHome: string): Promise<void> {
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const { spec, directory } = researchCurrentStart(jobId), request = spec.request;
  const captured = captureResearchRuntime(request, process.ppid);
  const reservation = readResearchProviderReservation(directory, unit);
  assertResearchProviderNotCancelled(directory, unit);
  const launch = trustedResearchProviderLaunch(spec, unit, selectedCodexHome);
  for (const path of [launch.command, "/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini"]) researchExecutableDigest(path);
  const assertForwardPermission = (): void => {
    captured.assertCurrent(); assertResearchProviderNotCancelled(directory, unit);
  };
  assertForwardPermission();
  const submissionPath = join(directory, "providers", unit + ".submission.json");
  const publishSubmission = (state: ResearchProviderSubmissionState, exclusive = false): void =>
    researchPublish(submissionPath, { schemaVersion: 1, unit, specSha256: reservation.specSha256, state }, exclusive);
  // Persist uncertainty before crossing the asynchronous systemd transport.
  publishSubmission(ResearchProviderSubmissionState.Pending, true);
  let child: ReturnType<typeof spawn> | undefined, proxyExited = false;
  try {
    assertForwardPermission(); // Cancellation can race the pending publication.
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
    let retained = false;
    const deadline = performance.now() + 5000;
    const assertTransportPermission = (): void => {
      assertForwardPermission();
      if (performance.now() >= deadline || proxyExited || transportFailed || proxy.stdin.destroyed || proxy.stdout.destroyed || proxy.stdout.readableEnded) researchInvalid();
    };
    try {
      await awaitResearchReady(proxy, assertTransportPermission, deadline);
      for (let attempt = 0; attempt < 100 && performance.now() < deadline && proxy.exitCode === null; attempt++) {
        assertTransportPermission();
        try {
          const service = researchServiceIdentity(unit), identity = researchProcessIdentity(service.mainPid);
          if (service.description !== reservation.description || identity.controlGroup !== service.controlGroup) researchInvalid();
          // Corroborate settled ownership after readiness, including namespaces.
          // Type=exec's first MainPID observation before unshare is insufficient.
          if (JSON.stringify(researchServiceIdentity(unit)) !== JSON.stringify(service) ||
              JSON.stringify(researchProcessIdentity(service.mainPid)) !== JSON.stringify(identity)) researchInvalid();
          assertTransportPermission();
          researchPublish(join(directory, "providers", unit + ".owner.json"), { schemaVersion: 1, process: identity, service }, true);
          retained = true; break;
        } catch (error) {
          if (attempt === 99) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (!retained) researchInvalid();
      assertTransportPermission(); // An accepted start is not permission to send auth.
      proxy.stdout.pipe(process.stdout);
      inputReleased = true;
      process.stdin.pipe(proxy.stdin);
      await terminal;
    } finally { clearTimeout(terminalTimer); }
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
