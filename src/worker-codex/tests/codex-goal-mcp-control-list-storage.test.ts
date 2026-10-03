const loaded = vi.hoisted(() => ({ value: null as any }));
vi.mock("../application/codex-goal-job-launch-loader", () => ({ loadJobLaunch: async () => loaded.value }));
import { registerCodexGoalWorkerControlTools } from "../codex-goal-mcp-worker-control-tools";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { WorkerControlService } from "../../worker-core/control/worker-control-service";
import { LocalFileWorkerControlInboxStore } from "../../store-local-file/worker-control-inbox/adapters/local-worker-control-inbox-store";
import { workerControlSignalViewJson, workerControlDecisionJson } from "../application/codex-goal-worker-control-view";
import { mcpJson } from "../codex-goal-mcp-response";
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));
it("measures ordinary delivered control history returned by default list projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "control-response-fake-"));
    const target = { jobId: "test-project-controller-20260906", taskId: "test-controller-loop", workspaceId: root + "/test-project-workspace" };
    const dir = join(root, "worker-control-inbox", createHash("sha256").update(target.jobId).digest("hex"));
    await mkdir(dir, { recursive: true });
    const date = "2026-09-06T00:00:00.000Z";
    const signals = [];
    const receipts = [];
    for (let i = 0; i < 1000; i++) {
        const id = `signal-${String(i).padStart(4, "0")}`;
        signals.push({ storageVersion: "local-file-worker-control-inbox-v1", schemaVersion: 1, signalId: id, idempotencyKey: createHash("sha256").update(id).digest("hex"), target, intent: "guidance", deliveryMode: "next_safe_point", body: "Continue current work after applying reviewer feedback. ".repeat(20), createdAt: date, createdBy: "orchestrator", priority: "normal", supersedesSignalIds: [], metadata: {} });
        receipts.push({ storageVersion: "local-file-worker-control-inbox-v1", schemaVersion: 1, receiptId: `receipt-${i}`, signalId: id, target, state: "delivered", createdAt: date, deliveryAttemptId: `test-controller-attempt-${i}`, deliveredAt: date, metadata: {} });
    }
    await writeFile(join(dir, "signals.jsonl"), signals.map(x => JSON.stringify(x)).join("\n") + "\n");
    await writeFile(join(dir, "receipts.jsonl"), receipts.map(x => JSON.stringify(x)).join("\n") + "\n");
    try {
        const control = new WorkerControlService({ store: new LocalFileWorkerControlInboxStore({ rootDir: root }) });
        const views = await control.listSignals({ target, includeBodies: false, includeExpired: true });
        const result = { ok: true, registryRootDir: root + "/registry", jobId: target.jobId, taskId: target.taskId, signals: views.map(x => workerControlSignalViewJson(x, false)) };
        loaded.value = { registryRootDir: root + "/registry", manifest: { jobId: target.jobId }, launch: { config: { taskId: target.taskId, workspacePath: target.workspaceId, stateRootDir: root } } };
        const registered = new Map<string, {
            schema: any;
            handler: any;
        }>();
        registerCodexGoalWorkerControlTools({ registerTool: (name: string, schema: any, handler: any) => registered.set(name, { schema, handler }) } as any);
        const tool = registered.get("codex_goal_control_list")!;
        const actual = await tool.handler({ jobId: target.jobId });
        expect(actual.structuredContent.signals).toHaveLength(0);
        expect(actual.structuredContent.signals.every((x: any) => x.state === "delivered" && x.signal.body === undefined)).toBe(true);
        expect(actual.structuredContent.counts).toMatchObject({ total: 1000, delivered: 1000, pending: 0 });
        expect(bytes(actual)).toBeLessThan(2000);
        const withBodies = await tool.handler({ jobId: target.jobId, includeBodies: true, state: "all" });
        expect(withBodies.structuredContent.signals[0].signal.body).toContain("Continue current work");
        const counts = await control.reconcile({ target });
        const metrics = { registeredSchemaKeys: Object.keys(tool.schema.inputSchema), actualDefaultHandlerEnvelopeBytes: bytes(actual), explicitIncludeBodiesEnvelopeBytes: bytes(withBodies), returnedSignals: views.length, pending: counts.pendingCount, payloadBytes: bytes(result), mcpEnvelopeBytes: bytes(mcpJson(result)), hundredSignalEnvelopeBytes: bytes(mcpJson({ ...result, signals: result.signals.slice(0, 100) })), countsEnvelopeBytes: bytes(mcpJson({ ok: true, report: counts })) };
        process.stdout.write("CONTROL_LIST " + JSON.stringify(metrics) + "\n");
        expect(bytes(withBodies)).toBeLessThanOrEqual(65536);
        expect(views).toHaveLength(1000);
        expect(counts.pendingCount).toBe(0);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
