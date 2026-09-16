import { once as onceEvent, type EventEmitter } from "node:events";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
} from "./app-server-process-port";

export async function stopAppServerProcess(input: {
  readonly child: CodexAppServerChildProcess | null;
  readonly exited: boolean;
  readonly signal: CodexAppServerChildProcessSignaler;
}): Promise<void> {
  const child = input.child;
  if (!child || input.exited) return;
  let exited = false;
  child.on("exit", () => { exited = true; });
  const exit = onceEvent(child as unknown as EventEmitter, "exit").catch(
    () => undefined,
  );
  try {
    child.stdin.end();
  } catch {
    // The process may have already closed stdin.
  }
  input.signal(child, "SIGTERM");
  const timeout = setTimeout(() => {
    if (!exited) input.signal(child, "SIGKILL");
  }, 5_000);
  timeout.unref();
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exit,
      new Promise<void>((resolve) => { deadline = setTimeout(resolve, 10_000); }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (deadline !== undefined) clearTimeout(deadline);
    // The parent exiting does not prove its process group or hosted unit is empty.
    input.signal(child, "SIGKILL");
  }
}
