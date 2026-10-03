import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseRunEvent, sameRunEventSource, type RunEventSource } from "@vioxen/subscription-runtime/worker-core";
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
    private readonly statePath: (runId: string, source?: RunEventSource) => string,
    private readonly parseState: (value: unknown) => RunEventProjectionState | null,
  ) {}
  async withProjectionLock<T>(runId: string, operation: () => Promise<T>, source?: RunEventSource): Promise<T> {
    const path = this.statePath(runId, source);
    return withDirectoryLock({
      lockPath: `${path}.lock`, parentDir: dirname(path),
      lockTtlMs: this.options.lockTtlMs ?? defaultLockTtlMs,
      lockAcquireTimeoutMs: this.options.lockAcquireTimeoutMs ?? defaultLockAcquireTimeoutMs,
      lockPollMs: this.options.lockPollMs ?? defaultLockPollMs,
      timeoutError: "run_event_projection_lock_timeout",
    }, operation);
  }

  async readPendingProjection(runId: string, source?: RunEventSource): Promise<RunEventProjectionResult | null> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(`${this.statePath(runId, source)}.pending`, "utf8"));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        if (source) {
          return this.withProjectionLock(runId, async () => {
            const legacy = await this.readPendingProjection(runId);
            if (!legacy) return null;
            if (legacy.events.length === 0) {
              if (legacy.nextState.providerKind === source.providerKind) throw new Error("legacy_pending_run_event_projection_scope_ambiguous");
              return null;
            }
            if (!legacy.events.every(event => sameRunEventSource(event.source, legacy.events[0]!.source))) {
              throw new Error("legacy_pending_run_event_projection_scope_ambiguous");
            }
            if (!sameRunEventSource(legacy.events[0]!.source, source)) return null;
            const migrated = { ...legacy, nextState: { ...legacy.nextState, source } };
            // Scoped WAL is durable before retiring the original; either copy can retry IDs.
            await this.writePendingProjection(migrated);
            await this.clearPendingProjection(runId);
            return migrated;
          });
        }
        return null;
      }
      throw error;
    }
    if (!(typeof value === "object" && value !== null && "events" in value && "nextState" in value) || !Array.isArray(value.events)) {
      throw new Error("invalid_pending_run_event_projection");
    }
    const nextState = this.parseState(value.nextState);
    const events = value.events.map(parseRunEvent);
    if (!nextState || nextState.runId !== runId || !sameRunEventSource(nextState.source, source) ||
        events.some((event) => !event || event.runId !== runId || event.source.providerKind !== nextState.providerKind ||
          (source !== undefined && !sameRunEventSource(event.source, source)))) {
      throw new Error("invalid_pending_run_event_projection");
    }
    if (source) {
      await this.withProjectionLock(runId, async () => {
        const legacy = await this.readPendingProjection(runId);
        if (legacy) {
          const { source: _source, ...scopedState } = nextState;
          if (JSON.stringify(legacy.nextState) === JSON.stringify(scopedState) &&
              JSON.stringify(legacy.events) === JSON.stringify(events)) await this.clearPendingProjection(runId);
        }
      });
    }
    return { nextState, events: events as RunEvent[] };
  }

  async writePendingProjection(projection: RunEventProjectionResult): Promise<void> {
    await this.writeAtomic(`${this.statePath(projection.nextState.runId, projection.nextState.source)}.pending`, projection);
  }

  async clearPendingProjection(runId: string, source?: RunEventSource): Promise<void> {
    await rm(`${this.statePath(runId, source)}.pending`, { force: true });
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
