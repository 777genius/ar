import { createFixedCodexAgentDriver } from "./file-backend-codex-agent-driver-factory";
import { HostedManagedDependencySessionDriver } from "./hosted-managed-dependency-session-driver";
import type { HostedManagedDependencySessionMaterializer } from "./hosted-managed-dependency-session-materializer";
import { assertHostedDependencyToolAdmittedFactory, createHostedDependencyToolSessionRuntime } from "./hosted-readonly-admission";
import { CODEX_WORKER_DEFAULT_MODEL, CODEX_WORKER_DEFAULT_REASONING_EFFORT } from "./codex-worker-defaults";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  createSubscriptionRuntime,
  DeterministicIdGenerator,
  type ClockPort,
  type ObservabilityPort,
  type RedactorPort,
  type RuntimeDeps,
} from "@vioxen/subscription-runtime/core";
import { CodexCliAgentDriver, CodexCliSessionDriver, CodexJsonAgentDriver, CodexMimoNoSessionDriver,
  CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { createLocalFileBackendRuntimeAdapters } from "@vioxen/subscription-runtime/store-local-file";
import { NodeProcessRunner } from "../worker-local/node-process-runner";
import {
  BorrowedRunTaskWorkspace,
  StableWorkerWorkspace,
} from "../worker-local/temp-workspace";
import { CommandPolicyRunner } from "./command-policy-runner";
import { LocalFileManagedRunStore } from "./file-backend-codex-managed-run-store";
import type { FileBackendCodexWorkerOptions } from "./file-backend-codex-worker";
import { resolveFileBackendCodexWorkerOptions, type FileBackendCodexWorkerInput } from "./file-backend-codex-worker-options";

export type CodexWorkerExecutionEngine =
  | "app-server"
  | "app-server-goal"
  | "packaged-exec"
  | "plain-exec";

export type FileBackendCodexWorkerRuntimeParts = {
  readonly runner: RuntimeDeps["runner"];
  readonly workspace: RuntimeDeps["workspace"];
  readonly clock: ClockPort;
  readonly sessionDriver: CodexCliSessionDriver | CodexMimoNoSessionDriver;
  readonly agentDriver: CodexJsonAgentDriver | CodexCliAgentDriver;
  readonly sessionStore: NonNullable<RuntimeDeps["sessionStore"]>;
  readonly managedRunStore: LocalFileManagedRunStore;
  readonly runtime: ReturnType<typeof createSubscriptionRuntime>;
  readonly ownedWorkspace: StableWorkerWorkspace | null;
  readonly prewarmWorkspace: RuntimeDeps["workspace"];
};

export { openWorkerFactorySecretRoots } from "./file-backend-codex-agent-driver-factory";

export function createFileBackendCodexWorkerRuntime(input: {
  readonly options: FileBackendCodexWorkerInput;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
  readonly redactor: RedactorPort;
  readonly clock: ClockPort;
}): FileBackendCodexWorkerRuntimeParts {
  const options = resolveFileBackendCodexWorkerOptions(input.options);
  // A v2 caller cannot construct adapters through a substituted public process
  // factory. Actual protected ordinary origin, not options, selects this gate.
  assertHostedDependencyToolAdmittedFactory(options.appServerProcessFactory, options.workspacePath);
  const runners = createWorkerRunners({
    options,
    workerId: input.workerId,
    observability: input.observability,
  });
  const runner = runners.taskRunner;
  const workspaces = createWorkerWorkspaces({
    options,
    workerId: input.workerId,
  });
  const managed = createHostedDependencyToolSessionRuntime(options.appServerProcessFactory,options.workspacePath,
    {options,workerId:input.workerId,observability:input.observability,redactor:input.redactor});
  const { sessionStore, leaseStore } = managed ?? createLocalFileBackendRuntimeAdapters({
    providerId:"codex",rootDir:join(options.stateRootDir,"sessions"),encryptionKey:options.encryptionKey,
    metadata:{adapter:"file-backend-codex-worker"},
  });
  const managedSession = managed?.materializer;
  const managedRunStore = managed?.managedRunStore ?? new LocalFileManagedRunStore(join(options.stateRootDir,"managed-runs"),input.redactor);
  const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  // MiMo is a static API-key credential with no ChatGPT auth.json/OAuth
  // session at all: it uses a no-session driver so the runtime kernel takes
  // the `no-session` execution plan (never reads/writes sessionStore/lease,
  // never refreshes). The ChatGPT path below is completely untouched.
  const sessionDriver: CodexCliSessionDriver | CodexMimoNoSessionDriver =
    modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
      ? new CodexMimoNoSessionDriver()
      : createSessionDriver({
          codexBinaryPath: options.codexBinaryPath,
          model: options.model ?? CODEX_WORKER_DEFAULT_MODEL,
          ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
          refreshMode: "lazy-refresh",
          ...(runners.refreshBootstrapRunner
            ? { refreshBootstrapRunner: runners.refreshBootstrapRunner }
            : {}),
        },managedSession);
  const agentDriver = managed?.agentDriver ?? createFixedCodexAgentDriver({
    options,
    workerId: input.workerId,
    observability: input.observability,
    managedRunStore,
    ...(managedSession ? {managedSession} : {}),
  });
  const runtime = createSubscriptionRuntime({
    policy: {
      custodyMode: "local-only",
      requireNoBackendPlaintext: false,
      requireWritebackBeforeTask: true,
      requireCompareAndSwap: true,
      allowInteractiveSetupInRuntime: false,
      allowedProviderIds: [sessionDriver.providerId],
      allowedAgentIds: [agentDriver.agentId],
      allowedStoreIds: [sessionStore.storeId],
      allowedRunnerIds: [runner.runnerId],
      requestedTaskMode: "structured-prompt",
      refreshPolicy: {
        minFreshMs: options.refreshFreshnessMs ?? 15 * 60 * 1000,
        refreshBeforeExpiryMs: options.refreshBeforeExpiryMs ?? 5 * 60 * 1000,
        maxSessionAgeMs: options.maxSessionAgeMs ?? 24 * 60 * 60 * 1000,
      },
    },
    sessionDriver,
    agentDriver,
    sessionStore,
    leaseStore,
    ...(managed ? {sessionExecutionLifecycle:managed.sessionExecutionLifecycle} : {}),
    runner,
    workspace: workspaces.workspace,
    redactor: input.redactor,
    observability: input.observability,
    clock: input.clock,
    idGenerator: new DeterministicIdGenerator(),
  });
  return {
    runner,
    workspace: workspaces.workspace,
    clock: input.clock,
    sessionDriver,
    agentDriver,
    sessionStore,
    managedRunStore,
    runtime,
    ownedWorkspace: workspaces.ownedWorkspace,
    prewarmWorkspace: workspaces.prewarmWorkspace,
  };
}

function createWorkerRunners(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
  readonly observability: ObservabilityPort;
}): {
  readonly taskRunner: RuntimeDeps["runner"];
  readonly refreshBootstrapRunner?: RuntimeDeps["runner"];
} {
  const baseRunner = input.options.runner ?? new NodeProcessRunner();
  const taskRunner = input.options.commandPolicy?.validateCommands
    ? new CommandPolicyRunner(baseRunner, input.options.commandPolicy, {
        observability: input.observability,
        providerId: "codex",
        metadata: {
          workerId: input.workerId,
          providerInstanceId: input.options.providerInstanceId,
        },
      })
    : baseRunner;
  const refreshBootstrapRunner =
    input.options.commandPolicy?.validateCommands &&
    input.options.codexBinaryPath === "codex"
      ? baseRunner
      : undefined;
  return {
    taskRunner,
    ...(refreshBootstrapRunner ? { refreshBootstrapRunner } : {}),
  };
}

function createWorkerWorkspaces(input: {
  readonly options: FileBackendCodexWorkerOptions;
  readonly workerId: string;
}): {
  readonly ownedWorkspace: StableWorkerWorkspace | null;
  readonly workspace: RuntimeDeps["workspace"];
  readonly prewarmWorkspace: RuntimeDeps["workspace"];
} {
  const defaultWorkspacePath = join(
    input.options.runtimeHomeRootDir ?? input.options.stateRootDir,
    "workspaces",
    hashText(input.workerId),
  );
  const ownedWorkspace = input.options.workspace
    ? null
    : new StableWorkerWorkspace(defaultWorkspacePath, {
        allowedRootDir: input.options.runtimeHomeRootDir ?? input.options.stateRootDir,
      });
  const workspace =
    input.options.workspace ??
    (input.options.workspacePath
      ? new BorrowedRunTaskWorkspace(input.options.workspacePath, ownedWorkspace!)
      : ownedWorkspace!);
  return {
    ownedWorkspace,
    workspace,
    prewarmWorkspace: input.options.workspace ?? ownedWorkspace!,
  };
}


function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createSessionDriver(options: ConstructorParameters<typeof CodexCliSessionDriver>[0], materializer: HostedManagedDependencySessionMaterializer | undefined): CodexCliSessionDriver {
  return materializer ? new HostedManagedDependencySessionDriver(options ?? {},materializer) : new CodexCliSessionDriver(options);
}
