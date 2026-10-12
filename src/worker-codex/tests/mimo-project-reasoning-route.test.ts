import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CodexReasoningEffort } from "@vioxen/subscription-runtime/provider-codex";
import type { MimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";

const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), fds: new Map<number, string>(), fd: 1,
  created: vi.fn(), transport: vi.fn(), dispatch: undefined as undefined | ((request: unknown) => Promise<unknown>) }));
const route = { projectId: "test-project", workstreamId: "test-stream", host: "TEST-host", machineId: "a".repeat(32), socketDir: "/TEST/socket" };
const root = "/srv/worker-state/mimo-projects/test-project/test-stream";
const scratch = "/srv/workers/mimo-projects/test-project/test-stream";
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const bytes = (p: string) => { const b = state.files.get(p); if (!b) throw Object.assign(new Error("TEST missing"), { code: "ENOENT" }); return b; };
  const stat = (p: string) => ({ uid: 0, dev: 1, ino: 2, ctimeMs: 1, nlink: 1, mode: 0o100600, size: bytes(p).length,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
  return { ...real, openSync: (p: string) => { bytes(p); const n = ++state.fd; state.fds.set(n, p); return n; },
    closeSync: (n: number) => state.fds.delete(n), fstatSync: (n: number) => stat(state.fds.get(n)!), lstatSync: stat,
    existsSync: (p: string) => state.files.has(p), readFileSync: (p: string | number, enc?: string) => {
      const b = bytes(typeof p === "number" ? state.fds.get(p)! : p); return enc ? b.toString() : b;
    }, mkdirSync: (p: string) => state.files.set(p, Buffer.from("TEST directory")),
    writeFileSync: (p: string, b: string, o: { flag: string }) => {
      if (o.flag === "wx" && state.files.has(p)) throw new Error("TEST retained"); state.files.set(p, Buffer.from(b));
    } };
});
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn() }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: vi.fn() }));
vi.mock("../application/project-control/worker-launch-spec", () => ({ workerLaunchAdmissionSchema: z.any() }));
vi.mock("../codex-goal-mcp-project-control-deps", async original => ({ ...await original<object>(),
  loadProjectControlController: async () => ({ scope: { projectId: "test-project", allowedAccountIds: ["account-q"] } }) }));
// Inject the terminal job-creation effect; retain the real manifest mapping.
vi.mock("../codex-goal-mcp-project-control-jobs", async original => ({ ...await original<object>(),
  projectControlRefillWorkerView: async (args: Record<string, unknown>) => {
    const { jobManifestInputFromArgs } = await import("../application/codex-goal-manifest-input");
    const manifest = jobManifestInputFromArgs({ ...args, promptPath: String(args.jobRootDir) + "/prompt.md", sourceEnv: {} });
    state.created(manifest);
    return { ok: true, jobId: manifest.jobId };
  } }));
// Inject only transport/configuration; the real client validates and encodes.
vi.mock("../mimo-project-bridge-client", async original => {
  const real = await original<typeof import("../mimo-project-bridge-client")>();
  return { ...real, delegateMimoProjectOperation: (operation: Parameters<typeof real.delegateMimoProjectOperation>[0],
    args: Parameters<typeof real.delegateMimoProjectOperation>[1]) => real.delegateMimoProjectOperation(operation, args, {
      routes: [{ projectId: "test-project", workstreamId: "test-stream", host: "TEST-host", machineId: "a".repeat(32), socketDir: "/TEST/socket" }],
      transport: async () => ({ request: async (request: MimoProjectBridgeRequest) => {
        state.transport(request); return state.dispatch!(JSON.parse(JSON.stringify(request)));
      } }),
    }) };
});
import { handleHostedMimoProjectBridge } from "../hosted-mimo-project-bridge";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-contract";
import { delegateMimoProjectOperation } from "../mimo-project-bridge-client";
import { registerCodexGoalProjectControlJobTools } from "../codex-goal-mcp-project-control-job-tool-registration";
import { appServerTurnStartParams } from "../../provider-codex/app-server/application/app-server-turn-start-params";

type RegisteredTool = { schema: Record<string, z.ZodTypeAny>; invoke: (args: Record<string, unknown>) => Promise<unknown> };
const tools = new Map<string, RegisteredTool>();
registerCodexGoalProjectControlJobTools({ registerTool: (name: string, config: { inputSchema: RegisteredTool["schema"] }, invoke: RegisteredTool["invoke"]) => {
  tools.set(name, { schema: config.inputSchema, invoke });
} } as unknown as McpServer);
beforeEach(() => {
  state.files.clear(); state.fds.clear(); vi.clearAllMocks(); state.dispatch = handleHostedMimoProjectBridge;
  state.files.set("/etc/machine-id", Buffer.from(route.machineId));
  state.files.set("/etc/subscription-runtime/mimo-projects/test-project/test-stream.json", Buffer.from(JSON.stringify({
    schemaVersion: 1, projectId: route.projectId, workstreamId: route.workstreamId, machineId: route.machineId, routingEnabled: true,
    stateRoot: root, scratchRoot: scratch, registryRootDir: root + "/registry", controllerJobId: "test-controller",
    sourceWorkspacePath: scratch + "/source", sourceCommit: "b".repeat(40), sourceRef: "origin/main", codexBinaryPath: "/TEST/codex",
    taskTimeoutMs: 300000, appServerStartupTimeoutMs: 180000, operationTimeoutMs: 300000,
    admission: { contract: { executionPolicy: { sandboxRoot: scratch + "/source/sandbox" } } },
  })));
  state.files.set("/etc/subscription-runtime/projects/test-project.d/test-stream.yml", Buffer.from(
    "project_id: test-project\nworkstream_id: test-stream\nstate_root: /srv/worker-state/jobs/test-project/test-stream\nscratch_root: /srv/workers/jobs/test-project/test-stream\nrouting_enabled: true\n"));
});
describe("registered MiMo Create reasoning reaches the admitted job", () => {
  it.each(["codex_goal_project_create_job", "codex_goal_project_refill_worker"])("preserves optional reasoning through %s", async name => {
    const tool = tools.get(name)!;
    for (const effort of [undefined, "none", "minimal", "low", "medium", "high", "xhigh"] as const) {
      const args = { mimoProjectId: route.projectId, mimoWorkstreamId: route.workstreamId, jobId: "test-" + (effort ?? "default"),
        promptBody: "TEST one-file edit", ...(name.endsWith("create_job") ? { sourceCommit: "b".repeat(40), confirmCreate: true }
          : { expectedSourceCommit: "b".repeat(40), confirmRefill: true }), ...(effort === undefined ? {} : { reasoningEffort: effort }) };
      expect(await tool.invoke(z.object(tool.schema).parse(args))).not.toHaveProperty("isError", true);
      const manifest = state.created.mock.lastCall![0] as { reasoningEffort: CodexReasoningEffort; jobId: string };
      expect(manifest).toMatchObject({ jobId: args.jobId, reasoningEffort: effort ?? "medium" });
      const wire = state.transport.mock.lastCall![0];
      if (effort === undefined) expect(wire).not.toHaveProperty("reasoningEffort");
      else expect(wire.reasoningEffort).toBe(effort);
      expect(appServerTurnStartParams({ threadId: "TEST-thread", prompt: "TEST", model: "mimo-v2.6-pro", reasoningEffort: manifest.reasoningEffort },
        { disableTools: false, disableNativeEnvironments: false }).effort).toBe(effort ?? "medium");
    }
    expect(state.created).toHaveBeenCalledTimes(7);
  });
  it("rejects unsupported reasoning and operation overrides before any creation or transport", async () => {
    const tool = tools.get("codex_goal_project_create_job")!;
    for (const reasoningEffort of ["max", "ultra", "enabled", "NONE", ""]) {
      expect(await tool.invoke(z.object(tool.schema).parse({ mimoProjectId: route.projectId, mimoWorkstreamId: route.workstreamId,
        jobId: "test-invalid", promptBody: "TEST", sourceCommit: "b".repeat(40), confirmCreate: true, reasoningEffort }))).toHaveProperty("isError", true);
    }
    await expect(delegateMimoProjectOperation(MimoProjectBridgeOperation.Status, { mimoProjectId: route.projectId,
      mimoWorkstreamId: route.workstreamId, jobId: "test-control", reasoningEffort: "none" })).rejects.toThrow("override_denied");
    const create = { kind: "MimoProject", schemaVersion: 1, machineId: route.machineId, projectId: route.projectId,
      workstreamId: route.workstreamId, operation: "create", jobId: "test-invalid", prompt: "TEST", sourceCommit: "b".repeat(40) };
    for (const reasoningEffort of [null, undefined, "max", {}, 1]) expect(() => parseMimoProjectBridgeRequest({ ...create, reasoningEffort })).toThrow("request_invalid");
    expect(() => parseMimoProjectBridgeRequest({ ...create, operation: "status", reasoningEffort: "none" })).toThrow("request_invalid");
    expect(state.transport).not.toHaveBeenCalled(); expect(state.created).not.toHaveBeenCalled();
  });
});
