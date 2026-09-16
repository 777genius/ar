import { createCodexProviderRuntimeAdapter } from "../../codex-provider-runtime-adapter";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AccessBoundary, NetworkAccessMode, createProviderRuntimeRegistry,
  ControlledAgentRunStatus,
  RunEventProviderKind,
  type ControlledAgentRun,
  type ControlledAgentProviderStartInput,
} from "@vioxen/subscription-runtime/worker-core";
import {
  CodexProviderEgressProfileId, codexProviderEgressPolicy,
  type CodexAppServerChildProcess,
  sessionArtifactFromCodexAuthJson,
} from "@vioxen/subscription-runtime/provider-codex";
import {
  buildCodexControlledAgentProfile,
  CodexControlledAgentProvider,
} from "../index";

const validAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: ["id", "token", "test"].join("-"),
    access_token: ["access", "token", "test"].join("-"),
    refresh_token: ["refresh", "token", "test"].join("-"),
  },
  last_refresh: "2026-07-05T00:00:00.000Z",
});

describe("CodexControlledAgentProvider", () => {
  it.each([false, true])("starts the actual controller provider/materializer; managed adapter=%s (synthetic authority and account)", async managed => {
    const root = await mkdtemp(join(tmpdir(), "codex-controlled-agent-provider-"));
    const workspacePath = join(root, "workspace");
    const stateDir = join(root, "state");
    const fakeFactory = new MinimalAppServerFactory();
    const profile = buildCodexControlledAgentProfile({
      stateDir,
      mcpCommand: "subscription-runtime-codex-goal-mcp-test",
      mcpArgs: ["--stdio"],
      rawShellMode: "disabled-by-provider",
    });
    let provider = new CodexControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromCodexAuthJson(validAuthJson),
      workspacePath,
      codexBinaryPath: "/bin/codex-test",
      processFactory: fakeFactory.create,
      model: "gpt-test",
      reasoningEffort: "high",
      serviceTier: "fast",
      maxGoalTurns: 1,
      controllerObjective:
        "Create focused sandbox child workers only through broker tools.",
    });

    if (managed) {
      // Only fixture bytes are read. Admission and account catalog facts are
      // substituted; dispatch, adapter, provider, driver and materializer are real.
      const authPath = join(root, "synthetic-auth.json");
      await writeFile(authPath, validAuthJson);
      const ops = await import("../../codex-goal-ops");
      const selection = await import("../../application/project-control/codex-goal-project-controller-account-selection");
      const egress = await import("../../hosted-test-egress-admission");
      const readonly = await import("../../hosted-readonly-admission");
      const order: string[] = [];
      const grant = vi.spyOn(egress, "admitHostedTestEgress").mockImplementation(async () => {
        order.push("grant"); return codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification);
      });
      const admission = vi.spyOn(readonly, "admitHostedReadonlyInputs").mockImplementation(() => {
        order.push("readonly"); return fakeFactory.create;
      });
      const slots = vi.spyOn(ops, "listCodexGoalAccountStatuses").mockImplementation(async () => { order.push("accounts"); return []; });
      const account = vi.spyOn(selection, "selectProjectControllerCodexAccountSlot").mockReturnValue({ name: "TEST", authJsonPath: authPath } as never);
      try {
        const adapter = createCodexProviderRuntimeAdapter();
        const result = await adapter.controlledAgentProvider({
          profile: adapter.controllerProfile({ stateDir, mcpCommand: "subscription-runtime-codex-goal-mcp-test", mcpArgs: ["--stdio"] }),
          scope: { projectId: "TEST", workspaceRoots: [workspacePath], worktreeRoots: [], jobIdPrefixes: ["TEST"], allowedGitRemotes: [], authRoot: root },
          launch: { config: { jobId: "TEST", taskId: "TEST", jobRootDir: root, workspacePath, authRootDir: root,
            promptPath: join(root, "synthetic-prompt"), accounts: [{ name: "TEST" }], codexBinaryPath: "/bin/codex-test", model: "gpt-test" } },
          controllerOptions: { maxGoalTurns: 1 }, registryRootDir: root, cwd: workspacePath,
          controllerObjective: async () => { order.push("objective"); return "Create focused sandbox child workers only through broker tools."; },
        });
        if (!(result.provider instanceof CodexControlledAgentProvider)) throw new Error("wrong provider");
        provider = result.provider;
        expect(order).toEqual(["grant", "readonly", "accounts", "objective"]);
      } finally { grant.mockRestore(); admission.mockRestore(); slots.mockRestore(); account.mockRestore(); }
    }

    try {
      const start = provider.start(startInput());
      expect(start.providerRunId).toBe("session-1:codex-app-server");
      expect(start.safeMessage).toContain("native environments disabled");

      const completedStatus = await waitForProviderStatus(
        () => provider.status({ session: startInput().session, run: {
          schemaVersion: 1,
          runId: "run-1",
          sessionId: "session-1",
          controllerJobId: "controller-1",
          providerKind: RunEventProviderKind.Codex,
          status: ControlledAgentRunStatus.Running,
          providerRunId: "session-1:codex-app-server",
          startedAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
        } }),
        ControlledAgentRunStatus.Completed,
        false,
      );
      expect(completedStatus.providerAttached).toBe(false);
      expect(fakeFactory.processes[0]?.killCount).toBeGreaterThan(0);

      const threadStart = fakeFactory.requests.find(
        (request) => request.method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({ environments: [] });
      expect(threadStart?.params).not.toHaveProperty("dynamicTools");
      const turnStart = fakeFactory.requests.find(
        (request) => request.method === "turn/start",
      );
      expect(turnStart?.params).toMatchObject({ environments: [] });
      expect(turnStart?.params).not.toHaveProperty("dynamicTools");
      expect(fakeFactory.prompts.join("\n")).toContain(
        "Use only the broker/status MCP tools",
      );
      expect(fakeFactory.prompts.join("\n")).toContain(
        "codex_goal_project_controller_consume_guidance",
      );
      expect(fakeFactory.prompts.join("\n")).toContain(
        "Create focused sandbox child workers only through broker tools.",
      );

      const codexHome = fakeFactory.codexHomes[0];
      expect(codexHome).toBe(profile.codexHome);
      const configToml = await readFile(join(codexHome ?? "", "config.toml"), "utf8");
      expect(configToml).toContain("subscription-runtime-codex-goal-mcp-test");
      expect(configToml).toContain("enabled_tools");
      expect(configToml).toContain("codex_goal_project_start");
      expect(configToml).toContain("codex_goal_project_operation_status");
      expect(configToml).toContain("codex_goal_project_controller_consume_guidance");
      expect(configToml).toContain("[features.network_proxy]");
      if (managed) {
        expect(configToml).toContain('"registry.npmjs.org" = "allow"');
        expect(fakeFactory.environments[0]?.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE).toBe(CodexProviderEgressProfileId.TestManagedQualification);
      } else expect(configToml).toContain('domains = { "api.openai.com" = "allow" }');
      expect(configToml).not.toContain("danger-full-access");
    } finally {
      await provider.stop({
        session: startInput().session,
        run: {
          schemaVersion: 1,
          runId: "run-1",
          sessionId: "session-1",
          controllerJobId: "controller-1",
          providerKind: RunEventProviderKind.Codex,
          status: ControlledAgentRunStatus.Running,
          providerRunId: "session-1:codex-app-server",
          startedAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
        },
      });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detaches the Codex app-server child when a controller goal blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-controlled-agent-provider-"));
    const workspacePath = join(root, "workspace");
    const stateDir = join(root, "state");
    const fakeFactory = new MinimalAppServerFactory({ goalTerminalStatus: "blocked" });
    const profile = buildCodexControlledAgentProfile({
      stateDir,
      mcpCommand: "subscription-runtime-codex-goal-mcp-test",
      mcpArgs: ["--stdio"],
      rawShellMode: "disabled-by-provider",
    });
    const provider = new CodexControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromCodexAuthJson(validAuthJson),
      workspacePath,
      codexBinaryPath: "/bin/codex-test",
      processFactory: fakeFactory.create,
      maxGoalTurns: 1,
    });

    try {
      const start = provider.start(startInput());
      const blocked = await waitForProviderStatus(
        () => provider.status({ session: startInput().session, run: providerRun() }),
        ControlledAgentRunStatus.Blocked,
        false,
      );

      expect(blocked.providerAttached).toBe(false);
      expect(blocked.safeMessage).toContain("waiting for input");
      expect(fakeFactory.processes[0]?.killCount).toBeGreaterThan(0);

      const stopped = await provider.stop({
        session: startInput().session,
        run: providerRun(),
        reason: "cleanup terminal snapshot",
      });
      expect(stopped.status).toBe(ControlledAgentRunStatus.Stopped);
      expect(provider.status({
        session: startInput().session,
        run: providerRun(),
      }).status).toBe(ControlledAgentRunStatus.Stale);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a long controller packet in the turn while binding compact goal metadata and exact controller routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-controlled-agent-provider-"));
    const workspacePath = join(root, "workspace");
    const stateDir = join(root, "state");
    const fakeFactory = new MinimalAppServerFactory();
    const profile = buildCodexControlledAgentProfile({
      stateDir,
      mcpCommand: "subscription-runtime-codex-goal-mcp-test",
      mcpArgs: ["--stdio"],
      rawShellMode: "disabled-by-provider",
    });
    const longControllerObjective = `controller-packet-start\n${"x".repeat(5_000)}\ncontroller-packet-end`;
    const registryRootDir = join(root, "registry-v10");
    const provider = new CodexControlledAgentProvider({
      profile,
      sessionArtifact: sessionArtifactFromCodexAuthJson(validAuthJson),
      workspacePath,
      codexBinaryPath: "/bin/codex-test",
      processFactory: fakeFactory.create,
      controllerObjective: longControllerObjective,
      controllerRegistryRootDir: registryRootDir,
      maxGoalTurns: 1,
    });

    try {
      provider.start(startInput());
      await waitForProviderStatus(
        () => provider.status({ session: startInput().session, run: providerRun() }),
        ControlledAgentRunStatus.Completed,
        false,
      );

      const prompt = fakeFactory.prompts.join("\n");
      expect(prompt).toContain("controller-packet-start");
      expect(prompt).toContain("controller-packet-end");
      expect(prompt).toContain("controllerJobId=controller-1");
      expect(prompt).toContain(`registryRootDir=${registryRootDir}`);
      expect(prompt.indexOf("controllerJobId=controller-1")).toBeLessThan(
        prompt.indexOf("codex_goal_project_controller_consume_guidance"),
      );
      expect(prompt.indexOf(`registryRootDir=${registryRootDir}`)).toBeLessThan(
        prompt.indexOf("codex_goal_project_controller_consume_guidance"),
      );

      const goalSet = fakeFactory.requests.find(
        (request) => request.method === "thread/goal/set",
      );
      const goalObjective = String(goalSet?.params?.objective ?? "");
      expect(goalObjective.length).toBeLessThanOrEqual(4_000);
      expect(goalObjective).toContain("Controller job: controller-1.");
      expect(goalObjective).toContain("Project: project-1.");
      expect(goalObjective).not.toContain("controller-packet-start");
      expect(goalObjective).not.toContain("controller-packet-end");
    } finally {
      await provider.stop({
        session: startInput().session,
        run: providerRun(),
      });
      await rm(root, { recursive: true, force: true });
    }
  });
});

function startInput(): ControlledAgentProviderStartInput {
  return {
    session: {
      schemaVersion: 1,
      sessionId: "session-1",
      identity: {
        controllerJobId: "controller-1",
        projectId: "project-1",
        providerKind: RunEventProviderKind.Codex,
      },
      stateDir: "/tmp/state",
      status: ControlledAgentRunStatus.Planned,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
      toolSurface: {
        boundary: AccessBoundary.ProjectScopedControl,
        allowedTools: [],
        deniedRawCapabilities: ["raw_shell", "raw_git", "raw_tmux"],
      },
    },
    systemPrompt: "Use only the broker/status tools.",
  };
}

function providerRun(): ControlledAgentRun {
  return {
    schemaVersion: 1 as const,
    runId: "run-1",
    sessionId: "session-1",
    controllerJobId: "controller-1",
    providerKind: RunEventProviderKind.Codex,
    status: ControlledAgentRunStatus.Running,
    providerRunId: "session-1:codex-app-server",
    startedAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

async function waitForProviderStatus<T extends { readonly status: ControlledAgentRunStatus }>(
  read: () => T,
  expected: ControlledAgentRunStatus,
  providerAttached?: boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = read();
    if (
      status.status === expected &&
      (providerAttached === undefined ||
        ("providerAttached" in status && status.providerAttached === providerAttached))
    ) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = read();
  expect(status.status).toBe(expected);
  if (providerAttached !== undefined) {
    expect("providerAttached" in status ? status.providerAttached : undefined).toBe(
      providerAttached,
    );
  }
  return status;
}

type FakeAppServerRequest = {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
};

class MinimalAppServerFactory {
  readonly codexHomes: string[] = [];
  readonly environments: Readonly<Record<string, string>>[] = [];
  readonly prompts: string[] = [];
  readonly processes: MinimalAppServerProcess[] = [];
  readonly requests: FakeAppServerRequest[] = [];

  constructor(private readonly options: {
    readonly goalTerminalStatus?: "complete" | "blocked";
  } = {}) {}

  readonly create = (input: {
    readonly env: Readonly<Record<string, string>>;
  }): CodexAppServerChildProcess => {
    this.environments.push(input.env);
    this.codexHomes.push(input.env.CODEX_HOME ?? "");
    const process = new MinimalAppServerProcess((request) => {
      this.requests.push(request);
      if (request.method === "turn/start") {
        this.prompts.push(extractPrompt(request.params));
      }
    }, {
      goalTerminalStatus: this.options.goalTerminalStatus ?? "complete",
    });
    this.processes.push(process);
    return process;
  };
}

class MinimalAppServerProcess extends EventEmitter implements CodexAppServerChildProcess {
  readonly pid = undefined;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  killCount = 0;
  readonly stdin = {
    write: (chunk: string | Uint8Array): boolean => {
      this.handleRequest(String(chunk));
      return true;
    },
    end: (): void => {},
    on: (_event: "error", _listener: (error: Error) => void): unknown => undefined,
  };
  private nextThreadId = 1;
  private nextTurnId = 1;
  private readonly goals = new Map<string, { objective: string; status: string }>();

  constructor(
    private readonly onRequest: (request: FakeAppServerRequest) => void,
    private readonly options: { readonly goalTerminalStatus: "complete" | "blocked" },
  ) {
    super();
  }

  kill(): boolean {
    this.killCount += 1;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  private handleRequest(chunk: string): void {
    for (const line of chunk.split(/\n/)) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as FakeAppServerRequest;
      this.onRequest(request);
      if (request.method === "initialize") {
        this.respond(request.id, {
          userAgent: "fake-codex",
          codexHome: "/tmp/fake-codex-home",
        });
        continue;
      }
      if (request.method === "thread/start") {
        this.respond(request.id, { thread: { id: `thread-${this.nextThreadId++}` } });
        continue;
      }
      if (request.method === "thread/goal/set") {
        const threadId = String(request.params?.threadId ?? "");
        this.goals.set(threadId, {
          objective: String(request.params?.objective ?? ""),
          status: String(request.params?.status ?? "active"),
        });
        this.respond(request.id, { goal: this.goalPayload(threadId) });
        continue;
      }
      if (request.method === "thread/goal/get") {
        this.respond(request.id, { goal: this.goalPayload(String(request.params?.threadId ?? "")) });
        continue;
      }
      if (request.method === "turn/start") {
        const threadId = String(request.params?.threadId ?? "");
        const turnId = `turn-${this.nextTurnId++}`;
        this.respond(request.id, { turn: { id: turnId } });
        setTimeout(() => {
          this.notify("turn/started", {
            threadId,
            turn: { id: turnId, status: "inProgress" },
          });
          this.notify("item/agentMessage/delta", {
            turnId,
            delta: `controlled output:${extractPrompt(request.params)}`,
          });
          this.goals.set(threadId, {
            objective: this.goals.get(threadId)?.objective ?? "",
            status: this.options.goalTerminalStatus,
          });
          this.notify("thread/goal/updated", {
            threadId,
            turnId: null,
            goal: this.goalPayload(threadId),
          });
          this.notify("turn/completed", {
            turn: { id: turnId, status: { type: "completed" } },
          });
        }, 1);
        continue;
      }
      this.respondError(request.id, `unsupported:${request.method}`);
    }
  }

  private goalPayload(threadId: string): Record<string, unknown> | null {
    const goal = this.goals.get(threadId);
    if (!goal) return null;
    return {
      threadId,
      objective: goal.objective,
      status: goal.status,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  private respond(id: number, result: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: number, message: string): void {
    this.stdout.emit("data", `${JSON.stringify({ id, error: { message } })}\n`);
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.stdout.emit("data", `${JSON.stringify({ method, params })}\n`);
  }
}

class FakeReadable extends EventEmitter {
  setEncoding(): void {}
}

function extractPrompt(params: Record<string, unknown> | undefined): string {
  const prompt = params?.prompt;
  if (typeof prompt === "string") return prompt;
  const input = params?.input;
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((item) => JSON.stringify(item)).join("\n");
  }
  return "";
}

it("composes actual controller dispatch, binding, adapter, state and provider with synthetic host/account facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "TEST-managed-controller-route-"));
  const workspacePath = join(root, "workspace"), stateDir = join(root, "state"), registryRootDir = join(root, "registry");
  const authRoot = join(root, "synthetic-auth");
  await mkdir(workspacePath); await mkdir(authRoot);
  const promptPath = join(root, "synthetic-prompt"), authPath = join(authRoot, "auth.json");
  await writeFile(promptPath, "Finish the synthetic controller goal through broker tools.");
  await writeFile(authPath, validAuthJson);
  const jobs = await import("../../codex-goal-jobs");
  const controllerViews = await import("../../codex-goal-mcp-project-controller");
  const stateLocation = await import("../../application/project-control/codex-goal-controller-state-location");
  const registry = await import("../../application/project-control/codex-goal-project-controller-runtime");
  const scope = { projectId: "TEST", workspaceRoots: [workspacePath], worktreeRoots: [], jobIdPrefixes: ["TEST"],
    allowedGitRemotes: [], authRoot, registryRoot: registryRootDir, allowedAccountIds: ["TEST"] };
  const controller = await jobs.createCodexGoalJob({ registryRootDir, manifest: {
    jobId: "TEST-controller", taskId: "TEST-controller", jobRootDir: join(root, "job"), workspacePath,
    authRootDir: authRoot, promptPath, accounts: ["TEST"], requireGitWorkspace: false,
    accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: scope,
    networkAccess: NetworkAccessMode.Restricted, executionEngine: "app-server-goal", model: "gpt-test",
  } });
  const factory = new MinimalAppServerFactory(), order: string[] = [];
  const egress = await import("../../hosted-test-egress-admission"), readonly = await import("../../hosted-readonly-admission");
  const ops = await import("../../codex-goal-ops"), selection = await import("../../application/project-control/codex-goal-project-controller-account-selection");
  let admissions = 0;
  const grant = vi.spyOn(egress, "admitHostedTestEgress").mockImplementation(async () => {
    expect(await stateLocation.controllerStateLocationForRelocation(controller)).toBe(admissions++ === 0 ? undefined : stateDir);
    order.push("grant"); return codexProviderEgressPolicy(CodexProviderEgressProfileId.TestManagedQualification);
  });
  const admitted = vi.spyOn(readonly, "admitHostedReadonlyInputs").mockImplementation(() => {
    order.push("readonly"); return input => { order.push("spawn"); return factory.create(input); };
  });
  const slots = vi.spyOn(ops, "listCodexGoalAccountStatuses").mockImplementation(async () => { order.push("accounts"); return []; });
  const account = vi.spyOn(selection, "selectProjectControllerCodexAccountSlot").mockReturnValue({ name: "TEST", authJsonPath: authPath } as never);
  const deps = { runtimeVersion: "TEST", providerRegistry: registry.createInMemoryProjectControllerProviderRegistry(),
    providerRuntimeRegistry: createProviderRuntimeRegistry([createCodexProviderRuntimeAdapter()]),
    loadProjectControlController: async () => ({ controller: await jobs.readCodexGoalJob({ registryRootDir, jobId: controller.jobId }), registryRootDir, scope }) };
  const args = { controllerJobId: controller.jobId, registryRootDir, stateDir, maxGoalTurns: 1 };
  try {
    expect(await controllerViews.projectControllerStartView(args, deps)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(factory.processes[0]?.killCount).toBeGreaterThan(0));
    expect(order.slice(0, 5)).toEqual(["grant", "readonly", "grant", "readonly", "accounts"]);
    expect(order.indexOf("spawn")).toBeGreaterThan(order.indexOf("accounts"));
    expect(await stateLocation.controllerStateLocationForRelocation(controller)).toBe(stateDir);
    expect(factory.environments[0]?.SUBSCRIPTION_RUNTIME_CODEX_PROVIDER_EGRESS_PROFILE).toBe(CodexProviderEgressProfileId.TestManagedQualification);
    const status = await controllerViews.projectControllerStatusView(args, deps);
    expect(JSON.stringify(status)).toContain("completed");
  } finally {
    await controllerViews.projectControllerStopView(args, deps);
    grant.mockRestore(); admitted.mockRestore(); slots.mockRestore(); account.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
