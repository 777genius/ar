import type {
  ManagedRunStorePort,
} from "@vioxen/subscription-runtime/core";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import type {
  CodexAppServerRolloutBudget,
} from "../domain/app-server-rollout-budget";
import type { CodexMaterializedSession } from "../../codex-json-execution-engine";
import type {
  CodexAppServerChildProcessSignaler,
  CodexAppServerProcessFactory,
} from "./app-server-process-port";
import {
  appServerStartupTimeoutMs,
} from "../domain/app-server-errors";
import {
  defaultReconnectGraceMs,
  defaultTimeoutMs,
  type CodexAppServerCommandApprovalPolicy,
  type CodexAppServerNativeToolSurface,
} from "../domain/app-server-types";
import { CodexAppServerClient } from "./app-server-client";
import { AppServerGoalRunner } from "./app-server-goal-runner";
import { AppServerTurnRunner } from "./app-server-turn-runner";
import type { CodexAppServerRateLimitsSnapshotHandler } from "./app-server-rate-limits-monitor";

export type AppServerSlot = {
  readonly key: string;
  readonly client: CodexAppServerClient;
  readonly turnRunner: AppServerTurnRunner;
  readonly goalRunner: AppServerGoalRunner;
  sessionHash: string | null;
};

type SlotLifecycle = {
  generation: number;
  tail: Promise<void>;
  pendingOperations: number;
};

type SlotStartupFlight = {
  readonly abortController: AbortController;
  promise: Promise<AppServerSlot>;
  subscribers: number;
};

export class AppServerSlotAcquireAbortedError extends Error {
  constructor() {
    super("codex_app_server_aborted_before_slot_acquired");
  }
}

export class AppServerSlotPool {
  private readonly slots = new Map<string, AppServerSlot>();
  /**
   * Mutating a slot has to be ordered per CODEX_HOME, but unrelated accounts
   * must still be able to start in parallel.
   */
  private readonly lifecycles = new Map<string, SlotLifecycle>();
  /**
   * A caller joining an already-starting session observes that exact startup
   * result. In particular, it must not silently turn a shared failure into a
   * second provider start.
   */
  private readonly startupFlights = new Map<
    string,
    Map<string | null, SlotStartupFlight>
  >();
  private disposed = false;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly signalChildProcess: CodexAppServerChildProcessSignaler;
      readonly runStore: ManagedRunStorePort;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
      readonly rolloutBudget?: CodexAppServerRolloutBudget;
      readonly bypassHookTrust?: boolean;
      readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
      readonly cleanThreadPrewarm: boolean;
      readonly timeoutMs?: number;
      readonly startupTimeoutMs?: number;
      readonly reconnectGraceMs?: number;
      readonly maxOutputBytes: number;
    },
  ) {}

  async ensureSlot(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly abortSignal: AbortSignal;
  }): Promise<AppServerSlot> {
    const key = input.session.codexHome;
    const sessionHash = input.session.sessionHash ?? null;
    this.throwIfAcquireAborted(input.abortSignal);
    if (this.disposed) throw new Error("codex_app_server_slot_pool_disposed");

    const existingFlight = this.startupFlights.get(key)?.get(sessionHash);
    if (existingFlight) {
      return await this.awaitFlight(existingFlight, input.abortSignal);
    }

    const lifecycle = this.lifecycleFor(key);
    const abortController = new AbortController();
    const flight: SlotStartupFlight = {
      abortController,
      promise: Promise.resolve(undefined as never),
      subscribers: 0,
    };
    this.startupFlightsFor(key).set(sessionHash, flight);
    const generation = lifecycle.generation;
    flight.promise = this.enqueue(lifecycle, async () =>
      await this.startSlot({
        key,
        sessionHash,
        generation,
        abortSignal: abortController.signal,
        session: input.session,
        workspacePath: input.workspacePath,
      }),
    );
    void flight.promise.then(
      () => this.clearStartupFlight(key, sessionHash, flight),
      () => this.clearStartupFlight(key, sessionHash, flight),
    );
    return await this.awaitFlight(flight, input.abortSignal);
  }

  private async startSlot(input: {
    readonly key: string;
    readonly sessionHash: string | null;
    readonly generation: number;
    readonly abortSignal: AbortSignal;
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
  }): Promise<AppServerSlot> {
    if (
      this.disposed ||
      input.abortSignal.aborted ||
      this.lifecycleFor(input.key).generation !== input.generation
    ) {
      throw new Error("codex_app_server_slot_startup_disposed");
    }
    const existing = this.slots.get(input.key);
    if (existing && existing.sessionHash === input.sessionHash) return existing;
    if (existing) {
      this.slots.delete(input.key);
      await existing.client.stop();
    }

    const sourceEnv = {
      ...(this.options.sourceEnv ?? process.env),
      ...input.session.env,
    };
    const client = new CodexAppServerClient({
      codexBinaryPath: this.options.codexBinaryPath,
      sourceEnv,
      processFactory: this.options.processFactory,
      signalChildProcess: this.options.signalChildProcess,
      session: input.session,
      workspacePath: input.workspacePath,
      executionProfile: this.options.executionProfile,
      ...(this.options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
      ...(this.options.nativeToolSurface === undefined
        ? {}
        : { nativeToolSurface: this.options.nativeToolSurface }),
      ...(this.options.rolloutBudget === undefined
        ? {}
        : { rolloutBudget: this.options.rolloutBudget }),
      ...(this.options.bypassHookTrust === undefined
        ? {}
        : { bypassHookTrust: this.options.bypassHookTrust }),
      timeoutMs: this.options.timeoutMs ?? defaultTimeoutMs,
      startupTimeoutMs: appServerStartupTimeoutMs({
        ...(this.options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.timeoutMs }),
        ...(this.options.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: this.options.startupTimeoutMs }),
      }),
      reconnectGraceMs: this.options.reconnectGraceMs ?? defaultReconnectGraceMs,
      maxOutputBytes: this.options.maxOutputBytes,
      abortSignal: input.abortSignal,
      ...(this.options.rateLimitsSnapshotHandler === undefined
        ? {}
        : {
            rateLimitsSnapshotHandler:
              this.options.rateLimitsSnapshotHandler,
          }),
    });
    try {
      await client.start();
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    }
    if (
      this.disposed ||
      input.abortSignal.aborted ||
      this.lifecycleFor(input.key).generation !== input.generation
    ) {
      await client.stop().catch(() => undefined);
      throw new Error("codex_app_server_slot_startup_disposed");
    }
    const slot = {
      key: input.key,
      client,
      turnRunner: new AppServerTurnRunner({
        client,
        cleanThreadPrewarm: this.options.cleanThreadPrewarm,
      }),
      goalRunner: new AppServerGoalRunner({
        client,
        runStore: this.options.runStore,
      }),
      sessionHash: input.sessionHash,
    };
    this.slots.set(input.key, slot);
    return slot;
  }

  async disposeSessionSlot(session: CodexMaterializedSession): Promise<void> {
    const key = session.codexHome;
    const lifecycle = this.lifecycleFor(key);
    lifecycle.generation += 1;
    this.abortStartupFlights(key);
    await this.enqueue(lifecycle, async () => {
      const slot = this.slots.get(key);
      if (!slot) return;
      this.slots.delete(key);
      await slot.client.stop();
    });
    this.releaseLifecycleIfIdle(key, lifecycle);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const keys = new Set([
      ...this.slots.keys(),
      ...this.lifecycles.keys(),
      ...this.startupFlights.keys(),
    ]);
    await Promise.all([...keys].map(async (key) => {
      const lifecycle = this.lifecycleFor(key);
      lifecycle.generation += 1;
      this.abortStartupFlights(key);
      await this.enqueue(lifecycle, async () => {
        const slot = this.slots.get(key);
        if (!slot) return;
        this.slots.delete(key);
        await slot.client.stop();
      });
      this.releaseLifecycleIfIdle(key, lifecycle);
    }));
  }

  private lifecycleFor(key: string): SlotLifecycle {
    const existing = this.lifecycles.get(key);
    if (existing) return existing;
    const lifecycle = {
      generation: 0,
      tail: Promise.resolve(),
      pendingOperations: 0,
    };
    this.lifecycles.set(key, lifecycle);
    return lifecycle;
  }

  private enqueue<T>(lifecycle: SlotLifecycle, operation: () => Promise<T>): Promise<T> {
    lifecycle.pendingOperations += 1;
    const result = lifecycle.tail.then(operation, operation);
    lifecycle.tail = result.then(
      () => {
        lifecycle.pendingOperations -= 1;
      },
      () => {
        lifecycle.pendingOperations -= 1;
      },
    );
    return result;
  }

  private startupFlightsFor(key: string): Map<string | null, SlotStartupFlight> {
    const existing = this.startupFlights.get(key);
    if (existing) return existing;
    const flights = new Map<string | null, SlotStartupFlight>();
    this.startupFlights.set(key, flights);
    return flights;
  }

  private clearStartupFlight(
    key: string,
    sessionHash: string | null,
    flight: SlotStartupFlight,
  ): void {
    const flights = this.startupFlights.get(key);
    if (flights?.get(sessionHash) !== flight) return;
    flights.delete(sessionHash);
    if (flights.size === 0) this.startupFlights.delete(key);
    const lifecycle = this.lifecycles.get(key);
    if (lifecycle) this.releaseLifecycleIfIdle(key, lifecycle);
  }

  private abortStartupFlights(key: string): void {
    for (const flight of this.startupFlights.get(key)?.values() ?? []) {
      flight.abortController.abort();
    }
  }

  private releaseLifecycleIfIdle(key: string, lifecycle: SlotLifecycle): void {
    if (
      !this.slots.has(key) &&
      !this.startupFlights.has(key) &&
      lifecycle.pendingOperations === 0
    ) {
      this.lifecycles.delete(key);
    }
  }

  private async awaitFlight(
    flight: SlotStartupFlight,
    abortSignal: AbortSignal,
  ): Promise<AppServerSlot> {
    this.throwIfAcquireAborted(abortSignal);
    return await new Promise<AppServerSlot>((resolve, reject) => {
      let released = false;
      let cancelled = false;
      const release = () => {
        if (released) return;
        released = true;
        flight.subscribers -= 1;
      };
      const onAbort = () => {
        cancelled = true;
        release();
        abortSignal.removeEventListener("abort", onAbort);
        if (flight.subscribers > 0) {
          reject(new AppServerSlotAcquireAbortedError());
          return;
        }
        flight.abortController.abort();
        void flight.promise.then(
          () => reject(new AppServerSlotAcquireAbortedError()),
          () => reject(new AppServerSlotAcquireAbortedError()),
        );
      };
      flight.subscribers += 1;
      abortSignal.addEventListener("abort", onAbort, { once: true });
      void flight.promise.then(
        (slot) => {
          if (!cancelled) resolve(slot);
        },
        (error: unknown) => {
          if (!cancelled) reject(error);
        },
      ).finally(() => {
        release();
        abortSignal.removeEventListener("abort", onAbort);
      });
    });
  }

  private throwIfAcquireAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AppServerSlotAcquireAbortedError();
  }
}
