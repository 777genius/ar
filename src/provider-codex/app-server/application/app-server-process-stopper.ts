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
  if (!child) return;
  // Read-only POSIX observation, separate from the signaler (which can swallow
  // errors or target a hosted unit). ESRCH proves local group absence only;
  // it is never a hosted cgroup/custody receipt or permission to signal again.
  const groupIsEmpty = (): boolean => {
    if (process.platform === "win32" || !Number.isSafeInteger(child.pid) || !child.pid || child.pid <= 0) return false;
    try { process.kill(-child.pid, 0); }
    catch (error) {
      return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
    }
    return false;
  };
  if (input.exited) {
    if (child.pid && !groupIsEmpty()) throw new AppServerProcessCleanupUnresolvedError();
    return;
  }
  const emitter = child as unknown as EventEmitter;
  let exited = false;
  const signal = (kind: NodeJS.Signals) => {
    // A numeric group can be reused after the original exits, including during
    // an awaited stop. Check at each effect, while exit observation is attached.
    if (child.pid && exited) {
      if (groupIsEmpty()) return;
      throw new AppServerProcessCleanupUnresolvedError();
    }
    input.signal(child, kind);
  };
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
    signal("SIGTERM");
    await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        escalation = setTimeout(() => {
          if (exited) return;
          try { signal("SIGKILL"); } catch (error) { reject(error); }
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
    // Local parent exit does not prove an empty hosted unit or process group.
    try { signal("SIGKILL"); } catch (error) { failures.push(error); }
    emitter.removeListener("exit", onExit!);
    emitter.removeListener("error", onError!);
  }
  if (failures.length > 0) {
    if (failures.every(error => error instanceof AppServerProcessCleanupUnresolvedError)) {
      throw failures[0];
    }
    throw new AppServerProcessCleanupError(failures.length === 1 ? failures[0] :
      new AggregateError(failures, "codex_app_server_stop_failures"));
  }
}
