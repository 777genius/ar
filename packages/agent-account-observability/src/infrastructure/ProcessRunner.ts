import { spawn } from "node:child_process";

export type ProcessRunnerInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
};

export type ProcessRunnerResult = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
};

export interface ProcessRunnerPort {
  run(input: ProcessRunnerInput): Promise<ProcessRunnerResult>;
}

export class NodeProcessRunner implements ProcessRunnerPort {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  run(input: ProcessRunnerInput): Promise<ProcessRunnerResult> {
    return new Promise((resolve) => {
      const child = this.spawnProcess(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      let settled = false;
      let stdinError: Error | null = null;
      const timeout =
        input.timeoutMs !== undefined
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, input.timeoutMs)
          : null;

      const settle = (
        exitCode: number | null,
        processError?: Error,
      ): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        const capturedStderr = Buffer.concat(stderr).toString("utf8");
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: processError
            ? `${capturedStderr}\n${processError.message}`
            : capturedStderr,
          timedOut,
        });
      };
      const handleStdinError = (error: unknown): void => {
        // A short-lived command may exit successfully without consuming its
        // optional stdin. Node reports that normal close race as EPIPE.
        if (isBrokenPipeError(error)) return;
        stdinError ??= toError(error);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
        }
      };

      child.stdout.on("data", (chunk) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.on("error", (error) => {
        settle(null, error);
      });
      child.on("close", (exitCode) => {
        settle(stdinError ? null : exitCode, stdinError ?? undefined);
      });
      child.stdin.on("error", handleStdinError);
      try {
        child.stdin.end(input.stdin ?? "");
      } catch (error) {
        handleStdinError(error);
      }
    });
  }
}

function isBrokenPipeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EPIPE"
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
