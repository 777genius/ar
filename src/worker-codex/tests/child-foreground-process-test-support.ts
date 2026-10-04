import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { FakeAppServerProcess } from "../../provider-codex/app-server/testing/fake-app-server";

/** Finite TEST process facts; production CLI, lifetime and transport execute.
 * No executable, inherited credentials, PID or OS signal is involved. */
export function createChildForegroundTestProcess(input: {
  readonly mode: "unfinished" | "retryable" | "delayed";
  readonly log: string;
  readonly resource: string;
  readonly sentinel: string;
}) {
  type Row = { readonly type: string; readonly pid?: number; readonly at?: number;
    readonly code?: number; readonly resourceActive?: boolean; readonly sentinelSeen?: boolean } |
    { readonly method: string; readonly params?: Record<string, unknown> };
  const record = (row: Row) => appendFileSync(input.log, JSON.stringify(row) + "\n");
  const cleanupSignals: NodeJS.Signals[] = [];
  const child = new FakeAppServerProcess({
    goalStatusesAfterTurns: ["active", "active"],
    agentMessageDeltas: ["Still unfinished."],
    suppressTurnCompletion: input.mode === "delayed",
    ...(input.mode === "retryable" ? { emitTopLevelErrorOnTurn: "usage limit reached" } : {}),
    onRequest: request => record({ method: request.method,
      ...(["turn/start", "thread/start"].includes(request.method) && request.params ? { params: request.params } : {}) }),
  });
  const write = child.stdin.write;
  let delay: NodeJS.Timeout | undefined;
  child.stdin.write = chunk => {
    const request = JSON.parse(String(chunk)) as { method?: string };
    if (input.mode !== "delayed" || request.method !== "turn/start") return write(chunk);
    // The request really crosses stdin now. Only the ACK is delayed.
    delay = setTimeout(() => {
      delay = undefined;
      record({ type: "turn-start-ack", at: Date.now() });
      write(chunk);
    }, 350);
    return true;
  };
  let stopped = false;
  const kill = child.kill.bind(child);
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    if (stopped) return true;
    stopped = true;
    cleanupSignals.push(signal);
    record({ type: "cleanup-request", pid: 1, resourceActive: true });
    if (delay) clearTimeout(delay);
    rmSync(input.resource, { force: true });
    record({ type: "provider-exit", pid: 1, code: 0 });
    return kill();
  };
  return { child, cleanupSignals, start: (env: Readonly<Record<string, string>>) => {
    writeFileSync(input.resource, "TEST fake provider obligation");
    record({ type: "TEST-resource-live", pid: 1 });
    record({ type: "provider-start", sentinelSeen: env.MIMO_TOKEN_PLAN_API_KEY === input.sentinel });
  } };
}
