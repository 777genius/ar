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
  throwIfAborted,
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

export type AppServerSlot = {
  readonly key: string;
  readonly client: CodexAppServerClient;
  readonly turnRunner: AppServerTurnRunner;
  readonly goalRunner: AppServerGoalRunner;
  sessionHash: string | null;
};

export class AppServerSlotPool {
  private readonly slots = new Map<string, AppServerSlot>();
  private readonly startingClients = new Set<CodexAppServerClient>();
  private readonly stoppingClients = new Map<CodexAppServerClient, Promise<void>>();
  private disposingClients: readonly CodexAppServerClient[] = [];
  private disposeInFlight: Promise<void> | null = null;
  private terminal = false;

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
      readonly cleanThreadPrewarm: boolean;
      readonly timeoutMs?: number;
      readonly startupTimeoutMs?: number;
      readonly reconnectGraceMs?: number;
      readonly attestationMode?: "none" | "provider-receipt";
    },
  ) {}

  async ensureSlot(input: {
    readonly session: CodexMaterializedSession;
    readonly workspacePath: string;
    readonly abortSignal: AbortSignal;
  }): Promise<AppServerSlot> {
    this.assertActive();
    const key = input.session.codexHome;
    const sessionHash = input.session.sessionHash ?? null;
    const existing = this.slots.get(key);
    if (existing && existing.sessionHash === sessionHash) {
      return existing;
    }

    if (existing) {
      const stopping = this.stopClient(existing.client);
      this.slots.delete(key);
      await stopping;
      this.assertActive();
    }

    throwIfAborted(input.abortSignal);
    this.assertActive();
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
      ...(this.options.attestationMode === undefined
        ? {}
        : { attestationMode: this.options.attestationMode }),
      abortSignal: input.abortSignal,
    });
    this.startingClients.add(client);
    try {
      await client.start();
    } catch (error) {
      await this.stopClient(client).catch(() => undefined);
      throw error;
    } finally {
      this.startingClients.delete(client);
    }
    if (this.terminal) {
      client.forceStop();
      await this.stopClient(client).catch(() => undefined);
      this.assertActive();
    }
    const slot = {
      key,
      client,
      turnRunner: new AppServerTurnRunner({
        client,
        cleanThreadPrewarm: this.options.cleanThreadPrewarm,
      }),
      goalRunner: new AppServerGoalRunner({
        client,
        runStore: this.options.runStore,
      }),
      sessionHash,
    };
    this.slots.set(key, slot);
    return slot;
  }

  async disposeSessionSlot(session: CodexMaterializedSession): Promise<void> {
    const slot = this.slots.get(session.codexHome);
    if (!slot) return;
    const stopping = this.stopClient(slot.client);
    this.slots.delete(session.codexHome);
    await stopping;
  }

  dispose(): Promise<void> {
    if (this.disposeInFlight) return this.disposeInFlight;
    this.terminal = true;
    const clients = [...new Set([
      ...[...this.slots.values()].map((slot) => slot.client),
      ...this.startingClients,
      ...this.stoppingClients.keys(),
    ])];
    const stops = clients.map((client) => this.stopClient(client));
    this.disposingClients = clients;
    this.slots.clear();
    this.disposeInFlight = Promise.all(stops).then(() => undefined);
    return this.disposeInFlight;
  }

  forceDispose(): void {
    this.terminal = true;
    const clients = new Set([
      ...[...this.slots.values()].map((slot) => slot.client),
      ...this.startingClients,
      ...this.stoppingClients.keys(),
      ...this.disposingClients,
    ]);
    for (const client of clients) client.forceStop();
  }

  private assertActive(): void {
    if (this.terminal) throw new Error("codex_app_server_slot_pool_disposed");
  }

  private stopClient(client: CodexAppServerClient): Promise<void> {
    const existing = this.stoppingClients.get(client);
    if (existing) return existing;
    const stopping = client.stop().finally(() => {
      this.stoppingClients.delete(client);
    });
    this.stoppingClients.set(client, stopping);
    return stopping;
  }
}
