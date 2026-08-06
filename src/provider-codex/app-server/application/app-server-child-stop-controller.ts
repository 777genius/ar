import { EventEmitter, once as onceEvent } from "node:events";
import type {
  CodexAppServerChildProcess,
  CodexAppServerChildProcessSignaler,
} from "./app-server-process-port";

export class AppServerChildStopController {
  private stopInFlight: Promise<void> | null = null;

  constructor(
    private readonly child: CodexAppServerChildProcess,
    private readonly signal: CodexAppServerChildProcessSignaler,
  ) {}

  stop(): Promise<void> {
    this.stopInFlight ??= this.stopGracefully();
    return this.stopInFlight;
  }

  forceStop(): void {
    this.signal(this.child, "SIGKILL");
  }

  private async stopGracefully(): Promise<void> {
    const exit = onceEvent(this.child as unknown as EventEmitter, "exit").catch(
      () => undefined,
    );
    try {
      this.child.stdin.end();
    } catch {
      // The process may have already closed stdin.
    }
    this.signal(this.child, "SIGTERM");
    const timeout = setTimeout(() => this.forceStop(), 5_000);
    try {
      await exit;
    } finally {
      clearTimeout(timeout);
      this.forceStop();
    }
  }
}
