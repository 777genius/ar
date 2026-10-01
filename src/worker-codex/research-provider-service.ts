import { trustedResearchProviderLaunch } from "./trusted-custody-systemd-launch";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assertResearchProviderNotCancelled, readResearchProviderReservation, ResearchProviderSubmissionState,
  signalResearchProvider } from "./research-launch-lifecycle";
import { captureResearchRuntime, researchCurrentStart } from "./research-launch-admission";
import { researchInvalid, researchPublish } from "./research-launch-files";
import { researchExecutableDigest, researchProcessIdentity, researchProviderUnitPattern, researchServiceIdentity } from "./research-launch-host";

/** Invoked only as a direct child of the authenticated runtime MainPID. The
 * provider gets separate PID/user/mount namespaces and no host authority. */
export async function runResearchProviderService(jobId: string, unit: string): Promise<void> {
  if (!researchProviderUnitPattern.test(unit)) researchInvalid();
  const { spec, directory } = researchCurrentStart(jobId), request = spec.request;
  const captured = captureResearchRuntime(request, process.ppid);
  const reservation = readResearchProviderReservation(directory, unit);
  assertResearchProviderNotCancelled(directory, unit);
  const launch = trustedResearchProviderLaunch(spec, unit);
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
    const terminal = new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.once("exit", (code, signal) => { proxyExited = true; process.exitCode = signal ? 70 : code ?? 70; resolve(); });
    });
    proxy.stdout.pipe(process.stdout); proxy.stderr.pipe(process.stderr);
    void terminal.catch(() => {}); // Observed below; never an unhandled early exit.
    let retained = false;
    const deadline = performance.now() + 5000;
    for (let attempt = 0; attempt < 100 && performance.now() < deadline && proxy.exitCode === null; attempt++) {
      assertForwardPermission();
      try {
        const service = researchServiceIdentity(unit), identity = researchProcessIdentity(service.mainPid);
        if (service.description !== reservation.description || identity.controlGroup !== service.controlGroup) researchInvalid();
        researchPublish(join(directory, "providers", unit + ".owner.json"), { schemaVersion: 1, process: identity, service }, true);
        retained = true; break;
      } catch (error) {
        if (attempt === 99) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!retained) researchInvalid();
    assertForwardPermission(); // An accepted start is not permission to send auth.
    process.stdin.pipe(proxy.stdin);
    proxy.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") proxy.kill("SIGTERM"); });
    await terminal;
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
