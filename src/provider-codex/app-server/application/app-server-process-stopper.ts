import type { EventEmitter } from "node:events";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
} from "./app-server-process-port";

export class AppServerProcessCleanupError extends Error {
  constructor(cause: unknown) {
    super("codex_app_server_process_cleanup_failed", { cause });
    this.name = "AppServerProcessCleanupError";
  }
}

export class AppServerProcessCleanupUnresolvedError extends AppServerProcessCleanupError {
  constructor() {
    super(new Error("codex_app_server_process_ownership_unverified"));
    this.name = "AppServerProcessCleanupUnresolvedError";
  }
}

export async function stopAppServerProcess(input: {
  readonly child: CodexAppServerChildProcess | null;
  readonly exited: boolean;
  readonly signal: CodexAppServerChildProcessSignaler;
}): Promise<void> {
  const child = input.child;
  if (!child || input.exited) return;
  const emitter = child as unknown as EventEmitter;
  let exited = false;
  let onExit: () => void;
  let onError: (error: Error) => void;
  const exit = new Promise<void>((resolve, reject) => {
    onExit = () => { exited = true; resolve(); };
    onError = reject;
    emitter.on("exit", onExit);
    emitter.on("error", onError);
  });
  // A synchronous signal failure may occur before we await the observation.
  void exit.catch(() => undefined);
  let escalation: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  const failures: unknown[] = [];
  try {
    try {
      child.stdin.end();
    } catch {
      // The process may have already closed stdin.
    }
    input.signal(child, "SIGTERM");
    await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        escalation = setTimeout(() => {
          if (exited) return;
          try { input.signal(child, "SIGKILL"); } catch (error) { reject(error); }
        }, 5_000);
        escalation.unref();
        deadline = setTimeout(() => reject(new Error("codex_app_server_stop_timeout")), 10_000);
      }),
    ]);
  } catch (error) {
    failures.push(error);
  } finally {
    if (escalation !== undefined) clearTimeout(escalation);
    if (deadline !== undefined) clearTimeout(deadline);
    emitter.removeListener("exit", onExit!);
    emitter.removeListener("error", onError!);
    // Local parent exit does not prove an empty hosted unit or process group.
    try { input.signal(child, "SIGKILL"); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throw new AppServerProcessCleanupError(failures.length === 1 ? failures[0] :
      new AggregateError(failures, "codex_app_server_stop_failures"));
  }
}
