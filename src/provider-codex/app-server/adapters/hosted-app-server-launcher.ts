import { spawn } from "node:child_process";
import { setInheritedStdioBlocking } from "./hosted-blocking-output";
import { managedProviderScratchLaunch } from "./managed-provider-scratch-environment";
import { assertHostedProcessDescriptors, assertHostedFdPreludeDescriptors } from "./hosted-process-descriptors";
import { announceHostedFdPrelude } from "./hosted-fd-prelude";
import {
  decodeHostedAppServerLaunchFrame,
  hostedResearchSetupTimeoutMs,
  type HostedAppServerLaunchFrame,
} from "./hosted-app-server-launch-frame";

const maximumFrameBytes = 4 * 1024 * 1024;
let buffered = Buffer.alloc(0);
let launched = false;
// Closed installed-launcher mode; ordinary/MiMo launches pass no argument.
const researchReady = process.argv.length === 3 && process.argv[2] === "--research-ready-v1";
const fdReady = process.argv.length === 3 && process.argv[2] === "--fd-ready-v1";
let stopFdPrelude: (() => void) | undefined;
let bootstrapDeadline: ReturnType<typeof setTimeout> | undefined;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(70);
}

function onInput(chunk: Buffer): void {
  if (launched) return;
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length > maximumFrameBytes) {
    fail("hosted_app_server_launch_frame_too_large");
  }
  const separator = buffered.indexOf(0x0a);
  if (separator < 0) return;
  launched = true;
  stopFdPrelude?.();
  if (bootstrapDeadline) clearTimeout(bootstrapDeadline);
  process.stdin.off("data", onInput);

  let frame: HostedAppServerLaunchFrame;
  try {
    frame = decodeHostedAppServerLaunchFrame(
      buffered.subarray(0, separator).toString("utf8"),
    );
  } catch {
    fail("hosted_app_server_launch_frame_invalid");
  }
  const pendingInput = buffered.subarray(separator + 1);
  buffered = Buffer.alloc(0);

  try { if (fdReady) assertHostedFdPreludeDescriptors(); else assertHostedProcessDescriptors(); }
  catch { fail("hosted_app_server_descriptor_boundary_invalid"); }

  let launch: ReturnType<typeof managedProviderScratchLaunch>;
  try { launch = managedProviderScratchLaunch(frame.env, frame.args); }
  catch { fail("hosted_provider_scratch_boundary_invalid"); }
  try { setInheritedStdioBlocking(); }
  catch { fail("hosted_app_server_blocking_output_failed"); }
  const child = spawn(frame.command, launch.args, {
    cwd: frame.cwd,
    env: launch.environment,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.on("error", () => fail("hosted_app_server_child_spawn_failed"));
  child.stdin.on("error", (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
      fail("hosted_app_server_child_stdin_failed");
    }
  });
  child.on("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal as NodeJS.Signals);
      return;
    }
    process.exit(code ?? 1);
  });
  if (pendingInput.length > 0) child.stdin.write(pendingInput);
  process.stdin.pipe(child.stdin);
}

if (process.argv.length !== 2 && !researchReady && !fdReady) fail("hosted_app_server_launch_mode_invalid");
if (researchReady) {
  // Runs only after the fixed unshare/setpriv/Tini chain has entered confinement.
  // Native provider/user code does not exist yet and cannot emit this frame.
  try { assertHostedProcessDescriptors(); }
  catch { fail("hosted_app_server_descriptor_boundary_invalid"); }
  bootstrapDeadline = setTimeout(() => fail("hosted_app_server_research_bootstrap_timeout"), hostedResearchSetupTimeoutMs);
  process.stdout.on("error", () => fail("hosted_app_server_research_ready_failed"));
  process.stdout.write("subscription-runtime-research-provider-ready-v1\n");
  process.stdin.on("error", () => fail("hosted_app_server_research_input_failed"));
}
process.stdin.on("data", onInput);
process.stdin.on("end", () => {
  if (!launched) fail("hosted_app_server_launch_frame_missing");
});
if (fdReady) {
  try { assertHostedFdPreludeDescriptors(); }
  catch { fail("hosted_app_server_descriptor_boundary_invalid"); }
  stopFdPrelude = announceHostedFdPrelude();
}
