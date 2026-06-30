import { assertProviderTaskSystemPrompt, } from "@777genius/subscription-runtime/core";
import { codexJsonAgentCapabilities, codexJsonAgentId, codexProviderId, defaultCodexModel, } from "./capabilities.js";
import { classifyCodexFailure } from "./failure-classifier.js";
import { PackagedCodexJsonExecutionEngine, codexSandboxModeForPermissionMode, codexExecutionFailure, } from "./codex-json-execution-engine.js";
import { CodexEphemeralSessionMaterializer, sessionArtifactHash, } from "./codex-session-materializer.js";
export class CodexJsonAgentDriver {
    options;
    agentId = codexJsonAgentId;
    providerId = codexProviderId;
    capabilities = codexJsonAgentCapabilities;
    engine;
    model;
    reasoningEffort;
    serviceTier;
    sessionMaterializer;
    constructor(options) {
        this.options = options;
        this.engine =
            "engine" in options
                ? options.engine
                : new PackagedCodexJsonExecutionEngine({
                    codexBinaryPath: options.codexBinaryPath,
                    ...(options.sourceEnv ? { sourceEnv: options.sourceEnv } : {}),
                    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
                });
        this.model = options.model ?? defaultCodexModel;
        this.reasoningEffort = options.reasoningEffort ?? "low";
        this.serviceTier = options.serviceTier;
        this.sessionMaterializer =
            options.sessionMaterializer ?? new CodexEphemeralSessionMaterializer();
    }
    async runTask(input) {
        assertProviderTaskSystemPrompt(input.task.systemPrompt, "task.systemPrompt");
        const startedAt = Date.now();
        if (!input.session) {
            return {
                status: "failed",
                failure: {
                    code: "provider_session_invalid",
                    retryable: false,
                    reconnectRequired: true,
                    safeMessage: "Codex requires a session artifact.",
                },
                telemetry: {
                    durationMs: Date.now() - startedAt,
                    finishReason: "provider_error",
                },
                warnings: [],
            };
        }
        let materialized = null;
        try {
            materialized = await this.sessionMaterializer.materialize({
                session: input.session,
                redactor: input.redactor,
            });
            const outputSchemaName = input.task.controls?.outputSchemaName ?? input.task.outputSchemaName;
            const goalObjective = readTaskGoalObjective(input.task);
            const result = await this.engine.run({
                prompt: input.task.prompt,
                ...(goalObjective ? { goalObjective } : {}),
                ...(input.task.systemPrompt !== undefined
                    ? { systemPrompt: input.task.systemPrompt }
                    : {}),
                outputSchema: outputSchemaName ? { name: outputSchemaName } : undefined,
                session: materialized,
                workspacePath: input.workspace.path,
                runner: input.runner,
                redactor: input.redactor,
                model: input.task.controls?.model ?? this.model,
                reasoningEffort: this.reasoningEffort,
                ...(this.serviceTier === undefined
                    ? {}
                    : { serviceTier: this.serviceTier }),
                sandboxMode: codexSandboxModeForPermissionMode(input.task.controls?.permissionMode),
                abortSignal: input.abortSignal,
            });
            const snapshot = await snapshotSessionUpdate({
                materialized,
                previousSession: input.session,
                redactor: input.redactor,
            });
            return {
                status: "completed",
                outputText: result.outputText,
                structuredOutput: result.structuredOutput,
                ...(snapshot.sessionUpdate
                    ? { sessionUpdate: snapshot.sessionUpdate }
                    : {}),
                telemetry: {
                    durationMs: Date.now() - startedAt,
                    finishReason: "completed",
                },
                warnings: [...result.warnings, ...snapshot.warnings],
            };
        }
        catch (error) {
            const failure = codexExecutionFailure(error);
            return {
                ...failure,
                telemetry: {
                    durationMs: Date.now() - startedAt,
                    finishReason: finishReasonForFailure(failure.failure.code),
                },
            };
        }
        finally {
            await materialized?.release();
        }
    }
    classifyRunFailure(error) {
        return classifyCodexFailure(error);
    }
    async prewarmSession(input) {
        const sessionPrewarm = this.sessionMaterializer.prewarm
            ? await this.sessionMaterializer.prewarm(input)
            : await this.prewarmMaterializerFallback(input);
        if (!sessionPrewarm.reusable ||
            !this.engine.prewarm ||
            !input.workspacePath ||
            !input.runner) {
            return sessionPrewarm;
        }
        const materialized = await this.sessionMaterializer.materialize(input);
        try {
            const enginePrewarm = await this.engine.prewarm({
                session: materialized,
                workspacePath: input.workspacePath,
                runner: input.runner,
                redactor: input.redactor,
                model: this.model,
                reasoningEffort: this.reasoningEffort,
                ...(this.serviceTier === undefined
                    ? {}
                    : { serviceTier: this.serviceTier }),
                ...(this.options.warmupPrompt
                    ? { warmupPrompt: this.options.warmupPrompt }
                    : {}),
                abortSignal: input.abortSignal ?? new AbortController().signal,
            });
            return {
                ...sessionPrewarm,
                engine: {
                    kind: enginePrewarm.kind,
                    reusable: enginePrewarm.reusable,
                },
                warmedAt: enginePrewarm.warmedAt,
                warnings: enginePrewarm.warnings,
            };
        }
        finally {
            await materialized.release();
        }
    }
    async prewarmMaterializerFallback(input) {
        const materialized = await this.sessionMaterializer.materialize(input);
        try {
            return {
                mode: this.sessionMaterializer.mode,
                home: materialized.home,
                codexHome: materialized.codexHome,
                sessionHash: sessionArtifactHash(input.session),
                reusable: false,
                warmedAt: new Date(),
            };
        }
        finally {
            await materialized.release();
        }
    }
    async dispose() {
        const results = await Promise.allSettled([
            Promise.resolve().then(() => this.engine.dispose?.()),
            Promise.resolve().then(() => this.sessionMaterializer.dispose?.()),
        ]);
        const errors = results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) {
            const error = new AggregateError(errors, "codex_json_agent_dispose_failed");
            error.code = "codex_json_agent_dispose_failed";
            throw error;
        }
    }
}
async function snapshotSessionUpdate(input) {
    if (!input.materialized.snapshotSession) {
        return { warnings: [] };
    }
    try {
        const snapshot = await input.materialized.snapshotSession();
        if (!snapshot) {
            return { warnings: [] };
        }
        input.redactor.registerSecret(snapshot.bytes, "codex-session-snapshot");
        if (sessionArtifactHash(snapshot) === sessionArtifactHash(input.previousSession)) {
            return { warnings: [] };
        }
        return { sessionUpdate: snapshot, warnings: [] };
    }
    catch {
        return {
            warnings: [
                {
                    code: "codex_session_snapshot_failed",
                    safeMessage: "Codex session snapshot could not be captured after task execution.",
                },
            ],
        };
    }
}
function readTaskGoalObjective(task) {
    const value = task.metadata?.codexGoalObjective;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function finishReasonForFailure(code) {
    if (code === "task_cancelled")
        return "cancelled";
    if (code === "task_timeout")
        return "timeout";
    return "provider_error";
}
//# sourceMappingURL=codex-json-agent-driver.js.map