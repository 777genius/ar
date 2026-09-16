import { spawn } from "node:child_process";
import { assertHostedProcessDescriptors } from "./hosted-process-descriptors";
import {
  decodeHostedAppServerLaunchFrame,
  type HostedAppServerLaunchFrame,
} from "./hosted-app-server-launch-frame";

const maximumFrameBytes = 4 * 1024 * 1024;
let buffered = Buffer.alloc(0);
let launched = false;

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

  try { assertHostedProcessDescriptors(); }
  catch { fail("hosted_app_server_descriptor_boundary_invalid"); }

  const child = spawn(frame.command, frame.args, {
    cwd: frame.cwd,
    env: frame.env,
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

process.stdin.on("data", onInput);
process.stdin.on("end", () => {
  if (!launched) fail("hosted_app_server_launch_frame_missing");
});
