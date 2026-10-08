import { assertCodexSubscriptionTestBoundary } from "../../provider-codex/tests/codex-subscription-preparation-test-support";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntimeAccessBoundary as Access, AgentRuntimeTool, ChildContinuationMode, ChildExecutionBudget,
  DefaultRedactor, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { CodexModelBackend, CodexSubscriptionConsumerRole as Role, CodexSubscriptionReasoningEffort as Effort,
  parseCodexSubscriptionPreparationRecord, sessionArtifactFromCodexAuthJson } from "@vioxen/subscription-runtime/provider-codex";
import { AppServerExecutionLifetime } from "../../provider-codex/app-server/application/app-server-child-lifetime";
import { createCodexSubscriptionPreparationOwner, prepareCodexSubscriptionConsumer } from "../hosted-controller/codex-subscription-consumer-preparation";

async function fixture(role: Role) {
  const root = await realpath(await mkdtemp(join(homedir(), "consumer-preparation-TEST-"))), job = join(root, "job"), workspace = join(root, "workspace");
  await mkdir(job, { mode: 0o700 }); await mkdir(join(job, "tmp"), { mode: 0o700 }); await mkdir(workspace, { mode: 0o700 });
  try { await assertCodexSubscriptionTestBoundary(job); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const binding = { role, controllerId: "TEST-controller", allocationId: "TEST-allocation", incarnationId: "TEST-incarnation",
    jobId: "TEST-job", accountId: "TEST-account", grantSha256: "a".repeat(64), sourceSha: "b".repeat(40), artifactSha: "c".repeat(40),
    ...(role === Role.Child ? { slotId: "TEST-slot" } : {}) };
  const commonBounds = { deadlineEpochMs: Date.now() + 10000, maxGoalTurns: 2, maxAttempts: 1, maxAccountCycles: 1,
    continuationMode: ChildContinuationMode.Disabled, denyProjectInstructions: true } as const;
  const bounds = role === Role.Child ? parseChildLifetime({ ...commonBounds, schemaVersion: 1, accountId: binding.accountId,
    accessBoundary: Access.IsolatedWorkspaceWrite, allowedTools: [AgentRuntimeTool.ReadFile, AgentRuntimeTool.EditFile] }) : commonBounds;
  const childBudget = role === Role.Child ? new ChildExecutionBudget(parseChildLifetime(bounds)) : undefined;
  const lifetime = childBudget ? new AppServerExecutionLifetime({ childBudget })
    : new AppServerExecutionLifetime({ deadlineEpochMs: bounds.deadlineEpochMs, maxGoalTurns: 2, binding });
  const record = parseCodexSubscriptionPreparationRecord({ ...binding, schemaVersion: 1, modelBackend: CodexModelBackend.OpenAiChatGpt,
    model: "gpt-6.1-sol", reasoningEffort: role === Role.Child ? Effort.Medium : Effort.High, serviceTier: null, bounds });
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "TEST-synthetic-selected-refresh" } });
  const input = { record, expected: record, selectedSession: { binding, artifact: sessionArtifactFromCodexAuthJson(auth) },
    executionLifetime: lifetime, ...(childBudget ? { childBudget } : {}), jobRootDir: job, workspacePath: workspace,
    codexBinaryPath: "/TEST/codex", redactor: new DefaultRedactor(), abortSignal: new AbortController().signal };
  return { input, job, auth, lifetime, childBudget, close: async () => { lifetime.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("worker subscription preparation boundary", () => {
  // Red if preparation only returns DATA, remakes budgets, prespends invocation, or mixes role resources.
  it("prepares distinct actual controller/child homes and preserves exact original fences", async () => {
    const controller = await fixture(Role.Controller), child = await fixture(Role.Child);
    try {
      const owners = [controller, child].map(f => createCodexSubscriptionPreparationOwner(f.input));
      for (const owner of owners) expect(await prepareCodexSubscriptionConsumer({ preparationOwner: owner })).toEqual({ status: "prepared" });
      const a = owners[0]!.takeSessionForConsumer(), b = owners[1]!.takeSessionForConsumer();
      expect(a.session.codexHome).not.toBe(b.session.codexHome);
      expect(await readFile(join(a.session.codexHome, "auth.json"), "utf8")).toBe(controller.auth);
      expect(await readFile(join(b.session.codexHome, "auth.json"), "utf8")).toBe(child.auth);
      expect(a.profile.sandboxMode).toBe("read-only"); expect(b.profile.sandboxMode).toBe("workspace-write");
      expect(b.profile.role).toBe(Role.Child);
      if (b.profile.role === Role.Child) {
        expect(b.profile.allowedTools).toEqual(child.childBudget!.lifetime.allowedTools);
        expect(b.profile.accessBoundary).toBe(child.childBudget!.lifetime.accessBoundary);
      }
      expect(a.profile.dynamicTools.map(t => t.name)).toEqual(["launch", "observe", "stop"]); expect(b.profile.dynamicTools).toEqual([]);
      expect(a.executionLifetime).toBe(controller.lifetime); expect(b.executionLifetime).toBe(child.lifetime);
      expect(b.childBudget).toBe(child.childBudget); expect(child.childBudget!.consumedTurns).toBe(0);
      // The actual engine is the first owner of invocation consumption.
      expect(() => child.childBudget!.beginInvocation()).not.toThrow();
      expect(JSON.stringify(a)).toBe('{"status":"held"}'); expect(JSON.stringify(b.session)).toBe('{"status":"held"}');
    } finally { await controller.close(); await child.close(); }
  });
  // Red if any reviewed binding field can drift independently, including bounds/access/tool decisions.
  it.each(["role", "accountId", "slotId", "model", "modelBackend", "reasoningEffort", "serviceTier", "grantSha256", "sourceSha", "artifactSha", "bounds"])("refuses mismatched %s before allocation", async field => {
    const f = await fixture(Role.Child);
    try {
      const altered = { ...f.input.record, [field]: field === "bounds" ? { ...f.input.record.bounds, maxGoalTurns: 1 } : "TEST-wrong" };
      expect(() => createCodexSubscriptionPreparationOwner({ ...f.input, record: altered })).toThrow("preparation_invalid");
      expect(await readdir(join(f.job, "tmp"))).toEqual([]);
    } finally { await f.close(); }
  });
  it.each(["deadline", "tools", "account", "budget"])("refuses original lifetime mismatch: %s", async kind => {
    const f = await fixture(Role.Child);
    try {
      const bounds = parseChildLifetime({ ...f.childBudget!.lifetime,
        ...(kind === "deadline" ? { deadlineEpochMs: f.childBudget!.lifetime.deadlineEpochMs + 1 } : {}),
        ...(kind === "tools" ? { allowedTools: [AgentRuntimeTool.ReadFile] } : {}),
        ...(kind === "account" ? { accountId: "TEST-another-account" } : {}) });
      const record = { ...f.input.record, bounds }, other = new ChildExecutionBudget(f.childBudget!.lifetime);
      expect(() => createCodexSubscriptionPreparationOwner({ ...f.input, record, expected: record,
        ...(kind === "budget" ? { childBudget: other } : {}) })).toThrow("preparation_invalid");
      expect(await readdir(join(f.job, "tmp"))).toEqual([]);
    } finally { await f.close(); }
  });
  // Red if parser accepts selectors, getter effects, implicit bound defaults or inappropriate role extensions.
  it.each(["unknown", "missing", "getter", "child_slot", "auth_selector"])("rejects non-closed DATA: %s", async kind => {
    const f = await fixture(Role.Controller);
    try {
      const record: Record<string, unknown> = { ...f.input.record };
      if (kind === "unknown") record.unknown = true;
      if (kind === "missing") delete record.serviceTier;
      if (kind === "child_slot") record.slotId = "TEST-unexpected-slot";
      if (kind === "auth_selector") record.authRootDir = "/TEST/private-selector";
      let getterCalls = 0;
      if (kind === "getter") Object.defineProperty(record, "model", { enumerable: true, get: () => { getterCalls++; return "gpt-6.1-sol"; } });
      expect(() => createCodexSubscriptionPreparationOwner({ ...f.input, record })).toThrow("preparation_invalid");
      expect(getterCalls).toBe(0); expect(await readdir(join(f.job, "tmp"))).toEqual([]);
    } finally { await f.close(); }
  });
  // Red if an expired retained fence produces a fresh home or permits another preparation attempt.
  it("keeps an expired original fence rejected with zero files", async () => {
    const f = await fixture(Role.Controller);
    try {
      const owner = createCodexSubscriptionPreparationOwner(f.input); f.lifetime.close(new Error("TEST-private-reason"));
      expect(await prepareCodexSubscriptionConsumer({ preparationOwner: owner })).toEqual({ status: "rejected", code: "unavailable" });
      expect(await prepareCodexSubscriptionConsumer({ preparationOwner: owner })).toEqual({ status: "rejected", code: "consumed" });
      expect(await readdir(join(f.job, "tmp"))).toEqual([]);
      expect(() => owner.takeSessionForConsumer()).toThrow("handoff_denied");
      expect(JSON.stringify(owner)).toBe('{"status":"rejected","code":"unavailable"}');
    } finally { await f.close(); }
  });
});
