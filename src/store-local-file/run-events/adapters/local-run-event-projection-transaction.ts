import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseRunEvent } from "@vioxen/subscription-runtime/worker-core";
import type { RunEvent, RunEventProjectionResult, RunEventProjectionState } from "../ports/run-event-store-contracts";
import type { LocalFileRunEventStoreOptions } from "./local-run-event-store";
import { withDirectoryLock } from "./local-run-event-lock";
import {
  localRunEventLogDefaultLockAcquireTimeoutMs as defaultLockAcquireTimeoutMs,
  localRunEventLogDefaultLockPollMs as defaultLockPollMs,
  localRunEventLogDefaultLockTtlMs as defaultLockTtlMs,
} from "../domain/run-event-log-policy";

export class LocalRunEventProjectionTransaction {
  constructor(
    private readonly options: LocalFileRunEventStoreOptions,
    private readonly statePath: (runId: string) => string,
    private readonly parseState: (value: unknown) => RunEventProjectionState | null,
  ) {}
  async withProjectionLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const path = this.statePath(runId);
    return withDirectoryLock({
      lockPath: `${path}.lock`, parentDir: dirname(path),
      lockTtlMs: this.options.lockTtlMs ?? defaultLockTtlMs,
      lockAcquireTimeoutMs: this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs,
      lockPollMs: this.options.lockPollMs ?? defaultLockPollMs,
      timeoutError: "run_event_projection_lock_timeout",
    }, operation);
  }

  async readPendingProjection(runId: string): Promise<RunEventProjectionResult | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(`${this.statePath(runId)}.pending`, "utf8"));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (!(typeof value === "object" && value !== null && "events" in value && "nextState" in value) || !Array.isArray(value.events)) {
      throw new Error("invalid_pending_run_event_projection");
    }
    const nextState = this.parseState(value.nextState);
    const events = value.events.map(parseRunEvent);
    if (!nextState || nextState.runId !== runId ||
        events.some((event) => !event || event.runId !== runId)) {
      throw new Error("invalid_pending_run_event_projection");
    }
    return { nextState, events: events as RunEvent[] };
  }

  async writePendingProjection(projection: RunEventProjectionResult): Promise<void> {
    await this.writeAtomic(`${this.statePath(projection.nextState.runId)}.pending`, projection);
  }

  async clearPendingProjection(runId: string): Promise<void> {
    await rm(`${this.statePath(runId)}.pending`, { force: true });
  }

  async writeAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

}
