import type {
  RedactorPort,
  RunnerPort,
  SessionArtifact,
  SessionStorePort,
  WorkspacePort,
} from "@vioxen/subscription-runtime/core";
import type { CodexSessionPrewarmResult } from "@vioxen/subscription-runtime/provider-codex";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import {
  SubscriptionWorkerError,
  type SubscriptionWorkerPrewarmResult,
} from "@vioxen/subscription-runtime/worker-core";

type PrewarmCapableCodexAgentDriver = {
  prewarmSession(input: {
    readonly session: SessionArtifact | null;
    readonly redactor: RedactorPort;
    readonly workspacePath?: string;
    readonly runner?: RunnerPort;
    readonly abortSignal?: AbortSignal;
  }): Promise<CodexSessionPrewarmResult>;
};

export type FileBackendCodexPrewarmerOptions = {
  readonly providerInstanceId: string;
  readonly sessionStore: SessionStorePort;
  readonly agentDriver: object;
  readonly prewarmWorkspace: WorkspacePort;
  readonly runner: RunnerPort;
  readonly redactor: RedactorPort;
  readonly now: () => Date;
  readonly importAuthJsonFileIfChanged: (
    context: "prewarm" | "run",
  ) => Promise<void>;
  readonly exportAuthJsonFileQuietly: (
    context: "prewarm" | "run",
  ) => Promise<void>;
  readonly rememberQuotaGroup: (session: SessionArtifact) => void;
  readonly onFailure?: (error: unknown) => void;
};

export class FileBackendCodexPrewarmer {
  constructor(private readonly options: FileBackendCodexPrewarmerOptions) {}

  async prewarm(): Promise<SubscriptionWorkerPrewarmResult> {
    const isMimo = isMimoAgentDriver(this.options.agentDriver);
    if (!isMimo) await this.options.importAuthJsonFileIfChanged("prewarm");
    const session = isMimo
      ? null
      : await this.options.sessionStore.read({
          providerInstanceId: this.options.providerInstanceId,
          expectedProviderId: "codex",
          purpose: "run",
        });
    if (!isMimo && !session) {
      throw new SubscriptionWorkerError(
        "subscription_worker_prewarm_failed",
        "Codex session is missing.",
      );
    }
    if (session) this.options.rememberQuotaGroup(session.artifact);

    if (!hasPrewarmSession(this.options.agentDriver)) {
      try {
        return {
          status: "skipped",
          warmedAt: this.options.now(),
          warnings: [],
          details: {
            engine: "plain-exec",
            engineReusable: "false",
          },
        };
      } finally {
          if (!isMimo) await this.options.exportAuthJsonFileQuietly("prewarm");
      }
    }

    const workspace = await this.options.prewarmWorkspace.create({
      purpose: "run-task",
      isolation: "temp-dir",
    });
    try {
      const result = await this.options.agentDriver.prewarmSession({
        session: session?.artifact ?? null,
        redactor: this.options.redactor,
        workspacePath: workspace.path,
        runner: this.options.runner,
        abortSignal: new AbortController().signal,
      });
      return {
        status: result.reusable ? "ready" : "skipped",
        warmedAt: result.warmedAt,
        warnings: result.warnings ?? [],
        details: {
          mode: result.mode,
          reusable: String(result.reusable),
          ...(result.engine
            ? {
                engine: result.engine.kind,
                engineReusable: String(result.engine.reusable),
              }
            : {}),
        },
      };
    } catch (error) {
      this.options.onFailure?.(error);
      throw error;
    } finally {
      await workspace.dispose?.();
      if (!isMimo) await this.options.exportAuthJsonFileQuietly("prewarm");
    }
  }
}

function isMimoAgentDriver(agentDriver: object): boolean {
  return (
    "modelBackend" in agentDriver &&
    (agentDriver as { readonly modelBackend?: unknown }).modelBackend ===
      CodexModelBackend.XiaomiMimoTokenPlan
  );
}

function hasPrewarmSession(
  agentDriver: object,
): agentDriver is PrewarmCapableCodexAgentDriver {
  return "prewarmSession" in agentDriver;
}
