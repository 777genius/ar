import { describe, expect, it, vi } from "vitest";
import { delegateMimoProjectOperation, parseMimoProjectClientRoutes, type MimoProjectClientRoute } from "../mimo-project-bridge-client";
import { registryRootFromInput } from "../application/codex-goal-use-case-inputs";
import { registryRootFromArgs } from "../codex-goal-mcp-inputs";
import { MimoProjectBridgeOperation as Operation } from "../hosted-mimo-project-bridge-contract";
const route: MimoProjectClientRoute = { projectId: "test-project", workstreamId: "test-work", host: "TEST-host", machineId: "a".repeat(32), socketDir: "/private/tmp/TEST-sockets" };
const identity = { mimoProjectId: route.projectId, mimoWorkstreamId: route.workstreamId, jobId: "test-worker" };
describe("scoped MiMo remote project client", () => {
  it.each([[true, "high"], [false, "none"]] as const)("submits canonical thinking=%s exactly once", async (thinking, reasoningEffort) => {
    const request = vi.fn(async (_request: unknown) => ({ ok: true }));
    await delegateMimoProjectOperation(Operation.Create, { ...identity, thinking,
      promptBody: "TEST edit", sourceCommit: "b".repeat(40), confirmCreate: true },
    { routes: [route], transport: async () => ({ request }) });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toMatchObject({ reasoningEffort });
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("thinking");
  });
  it("rejects contradictions and thinking without a MiMo route before transport", async () => {
    const transport = vi.fn();
    await expect(delegateMimoProjectOperation(Operation.Create, { ...identity, thinking: true,
      reasoningEffort: "none", promptBody: "TEST", sourceCommit: "b".repeat(40), confirmCreate: true },
    { routes: [route], transport })).rejects.toThrow("request_invalid");
    await expect(delegateMimoProjectOperation(Operation.Create, { jobId: "local", thinking: false },
      { transport })).rejects.toThrow("backend_conflict");
    for (const operation of [Operation.Start, Operation.Status, Operation.Stop])
      await expect(delegateMimoProjectOperation(operation, { ...identity, thinking: true },
        { routes: [route], transport })).rejects.toThrow("override_denied");
    expect(transport).not.toHaveBeenCalled();
  });
  it("sends only finite project identity and prompt/source DTO, never caller host data", async () => {
    const request = vi.fn(async (_request: unknown) => ({ ok: true, jobId: "test-worker" }));
    await delegateMimoProjectOperation(Operation.Create, { ...identity, promptBody: "TEST harmless edit", sourceCommit: "b".repeat(40), confirmCreate: true },
      { routes: [route], transport: async () => ({ request }) });
    expect(request.mock.calls[0]?.[0]).toEqual({ kind: "MimoProject", schemaVersion: 1, machineId: route.machineId,
      projectId: route.projectId, workstreamId: route.workstreamId, operation: "create", jobId: "test-worker", prompt: "TEST harmless edit", sourceCommit: "b".repeat(40) });
  });
  it("rejects unconfigured scopes and caller path overrides before transport", async () => {
    const transport = vi.fn();
    await expect(delegateMimoProjectOperation(Operation.Status, { ...identity, mimoProjectId: "foreign" }, { routes: [route], transport })).rejects.toThrow("route_not_configured");
    await expect(delegateMimoProjectOperation(Operation.Status, { ...identity, workspacePath: "/etc" } as typeof identity, { routes: [route], transport })).rejects.toThrow("override_denied");
    expect(transport).not.toHaveBeenCalled();
  });
  it("retains uncertain outcome and never retries mutation", async () => {
    const request = vi.fn(async () => { throw new Error("outcome unknown"); });
    await expect(delegateMimoProjectOperation(Operation.Start, { ...identity, confirmStart: true }, { routes: [route], transport: async () => ({ request }) })).rejects.toThrow("outcome unknown");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("leaves ordinary local routes untouched without reading client configuration", async () => {
    const transport = vi.fn();
    expect(await delegateMimoProjectOperation(Operation.Status, { jobId: "local" }, { transport })).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });
  it("projects canonical worker status while retaining owned operation status", async () => {
    const status = { resultStatus: "done", resultExists: true };
    const response = { ok: true, operations: { status: { state: "settled" } }, worker: { ok: true, result: { ok: true, status } } };
    expect(await delegateMimoProjectOperation(Operation.Status, identity, { routes: [route], transport: async () => ({ request: async () => response }) })).toEqual({ ...response, status });
  });
  it("refuses unsupported remote operations at common local registry boundaries", () => {
    expect(() => registryRootFromInput(identity)).toThrow("operation_unsupported");
    expect(() => registryRootFromArgs(identity)).toThrow("operation_unsupported");
  });
  it("denies credential bags, duplicate routes and SSH destinations with a user override", () => {
    for (const changed of [{ ...route, host: "root@host" }, { ...route, env: { key: "sentinel" } }]) {
      expect(() => parseMimoProjectClientRoutes({ schemaVersion: 1, routes: [changed] })).toThrow("config_invalid");
    }
    expect(() => parseMimoProjectClientRoutes({ schemaVersion: 1, routes: [route, route] })).toThrow("route_duplicate");
  });
});
