import type { HostedMimoCodingEngineAuthority } from "../../hosted-mimo-coding-engine-authority";
import { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import type { EventEmitter } from "node:events";
import { AppServerProcessCleanupError, AppServerProcessCleanupUnresolvedError, stopAppServerProcess } from "./app-server-process-stopper";
import type {
  ManagedRunStorePort,
} from "@vioxen/subscription-runtime/core";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import type { CodexModelBackend } from "../../codex-model-backend";
import type { CodexProviderEgressPolicy } from "../../codex-provider-egress-policy";
import type { PublicResearchSourceReader } from "./public-research-source-port";
import type {
  CodexAppServerRolloutBudget,
} from "../domain/app-server-rollout-budget";
import type { CodexMaterializedSession } from "../../codex-json-execution-engine";
import type {
  CodexAppServerChildProcess,
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
import type { AppServerCompletedTurnCheckpoint } from "./app-server-turn-checkpoint";
import { AppServerTurnRunner } from "./app-server-turn-runner";
import type { CodexAppServerRateLimitsSnapshotHandler } from "./app-server-rate-limits-monitor";
import type { HostedControllerDynamicToolAdapter } from "../domain/hosted-controller-dynamic-tools";

export type AppServerSlot = {
  readonly key: string;
  readonly client: CodexAppServerClient;
  readonly turnRunner: AppServerTurnRunner;
  readonly goalRunner: AppServerGoalRunner;
  sessionHash: string | null;
};

type SlotCleanup = {
  client: CodexAppServerClient;
  child: CodexAppServerChildProcess | null;
  exited: boolean;
  pending: boolean;
  retryProcessStop: boolean;
  onExit: () => void;
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
  private readonly cleanup = new Map<string, SlotCleanup>();
  private disposed = false;

  constructor(
    private readonly options: {
      readonly codexBinaryPath: string;
      readonly childBudget?: ChildExecutionBudget;
      readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
      readonly providerEgressPolicy?: CodexProviderEgressPolicy;
      readonly publicSourceReader?: PublicResearchSourceReader;
      readonly hostedPermissionProfiles?: boolean;
      readonly processFactory: CodexAppServerProcessFactory;
      readonly signalChildProcess: CodexAppServerChildProcessSignaler;
      readonly runStore: ManagedRunStorePort;
      readonly completedTurnCheckpoint?: AppServerCompletedTurnCheckpoint;
      readonly executionProfile: ResolvedCodexExecutionProfile;
      readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
      readonly hostedCodingAuthority?: HostedMimoCodingEngineAuthority;
  readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
      readonly hostedControllerTools?: HostedControllerDynamicToolAdapter;
      readonly rolloutBudget?: CodexAppServerRolloutBudget;
      readonly bypassHookTrust?: boolean;
      readonly rateLimitsSnapshotHandler?: CodexAppServerRateLimitsSnapshotHandler;
      readonly cleanThreadPrewarm: boolean;
      readonly timeoutMs?: number;
      readonly startupTimeoutMs?: number;
      readonly reconnectGraceMs?: number;
      readonly maxOutputBytes: number;
      /** Fixed for the pool's whole lifetime — every slot in this pool serves one backend. */
      readonly modelBackend?: CodexModelBackend;
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
    if (this.cleanup.get(input.key)?.pending) {
      throw new Error("codex_app_server_slot_cleanup_pending");
    }
    const existing = this.slots.get(input.key);
    if (existing && existing.sessionHash === input.sessionHash) return existing;
    if (existing) {
      await this.stopSlot(input.key);
      if (this.disposed || input.abortSignal.aborted ||
          this.lifecycleFor(input.key).generation !== input.generation) {
        throw new Error("codex_app_server_slot_startup_disposed");
      }
    }

    const sourceEnv = {
      ...(this.options.sourceEnv ?? process.env),
      ...input.session.env,
    };
    const cleanup: SlotCleanup = {
      client: undefined as never, child: null, exited: false,
      pending: false, retryProcessStop: false,
      onExit: () => { cleanup.exited = true; },
    };
    const client = new CodexAppServerClient({
      ...(this.options.childBudget ? { childBudget: this.options.childBudget } : {}),
      codexBinaryPath: this.options.codexBinaryPath,
      sourceEnv,
      ...(this.options.providerEgressPolicy ? { providerEgressPolicy: this.options.providerEgressPolicy } : {}),
      ...(this.options.publicSourceReader ? { publicSourceReader: this.options.publicSourceReader } : {}),
      ...(this.options.hostedPermissionProfiles === undefined ? {} : {
        hostedPermissionProfiles: this.options.hostedPermissionProfiles,
      }),
      processFactory: this.options.processFactory,
      onProcessCreated: (child) => {
        cleanup.child = child;
        child.on("exit", cleanup.onExit);
      },
      signalChildProcess: this.options.signalChildProcess,
      session: input.session,
      workspacePath: input.workspacePath,
      executionProfile: this.options.executionProfile,
      ...(this.options.commandApprovalPolicy === undefined
        ? {}
        : { commandApprovalPolicy: this.options.commandApprovalPolicy }),
      ...(this.options.hostedCodingAuthority === undefined ? {} : { hostedCodingAuthority: this.options.hostedCodingAuthority }),
      ...(this.options.nativeToolSurface === undefined
        ? {}
        : { nativeToolSurface: this.options.nativeToolSurface }),
      ...(this.options.hostedControllerTools === undefined
        ? {}
        : { hostedControllerTools: this.options.hostedControllerTools }),
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
      ...(this.options.modelBackend === undefined
        ? {}
        : { modelBackend: this.options.modelBackend }),
      ...(this.options.rateLimitsSnapshotHandler === undefined
        ? {}
        : {
            rateLimitsSnapshotHandler:
              this.options.rateLimitsSnapshotHandler,
          }),
    });
    cleanup.client = client;
    this.cleanup.set(input.key, cleanup);
    try {
      await client.start();
    } catch (error) {
      await this.cleanupStartupFailure(input.key, error);
      throw error;
    }
    if (
      this.disposed ||
      input.abortSignal.aborted ||
      this.lifecycleFor(input.key).generation !== input.generation
    ) {
      const error = new Error("codex_app_server_slot_startup_disposed");
      await this.cleanupStartupFailure(input.key, error);
      throw error;
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
        ...(this.options.completedTurnCheckpoint ? { completedTurnCheckpoint: this.options.completedTurnCheckpoint } : {}),
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
    try {
      await this.enqueue(lifecycle, async () => await this.stopSlot(key));
    } finally {
      this.releaseLifecycleIfIdle(key, lifecycle);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const keys = new Set([
      ...this.cleanup.keys(), ...this.lifecycles.keys(), ...this.startupFlights.keys(),
    ]);
    const results = await Promise.allSettled([...keys].map(async (key) => {
      const lifecycle = this.lifecycleFor(key);
      lifecycle.generation += 1;
      this.abortStartupFlights(key);
      try {
        await this.enqueue(lifecycle, async () => await this.stopSlot(key));
      } finally {
        this.releaseLifecycleIfIdle(key, lifecycle);
      }
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "codex_app_server_slot_cleanup_failed");
  }

  private async cleanupStartupFailure(key: string, startupError: unknown): Promise<void> {
    this.cleanup.get(key)?.client.executionLifetime?.close(startupError);
    try {
      await this.stopSlot(key);
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], "codex_app_server_startup_cleanup_failed");
    }
  }

  private async stopSlot(key: string): Promise<void> {
    const cleanup = this.cleanup.get(key);
    if (!cleanup) return;
    cleanup.pending = true;
    try {
      // The client caches its stop promise and detaches its child before awaiting.
      // Retain the cleanup obligation independently so a failed stop can be retried.
      if (cleanup.retryProcessStop) {
        // After exit the stopper may only observe group absence, never signal
        // the retained numeric identity. A live/unknown group remains pending.
        if (cleanup.exited && !cleanup.child?.pid) {
          throw new AppServerProcessCleanupUnresolvedError();
        }
        await stopAppServerProcess({
          child: cleanup.child, exited: cleanup.exited,
          signal: this.options.signalChildProcess,
        });
      } else {
        await cleanup.client.stop();
      }
    } catch (error) {
      if (error instanceof AppServerProcessCleanupError) cleanup.retryProcessStop = true;
      if (cleanup.retryProcessStop && !(error instanceof AppServerProcessCleanupError)) {
        throw new AppServerProcessCleanupError(error);
      }
      throw error;
    }
    (cleanup.child as unknown as EventEmitter | null)?.removeListener("exit", cleanup.onExit);
    this.cleanup.delete(key);
    this.slots.delete(key);
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
      !this.cleanup.has(key) &&
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
          (error: unknown) => reject(error instanceof AggregateError ? error : new AppServerSlotAcquireAbortedError()),
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
