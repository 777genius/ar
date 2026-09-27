import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultRedactor,
  type RunnerPort,
  type SessionStorePort,
} from "@vioxen/subscription-runtime/core";
import { describe, expect, it } from "vitest";
import { buildManagedRunRecoveryPacket, buildManagedRunRecoveryPrompt, FileBackendCodexManagedRunCoordinator } from "../file-backend-codex-managed-run-recovery";
import { LocalFileManagedRunStore } from "../file-backend-codex-managed-run-store";

describe("managed run recovery persistence", () => {
  it("rejects a credential-bearing identifier before any disk write", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-identifier-"));
    const secret = "SYNTHETIC_IDENTIFIER_CREDENTIAL";
    const redactor = new DefaultRedactor();
    redactor.registerSecret(secret, "test-canary");
    const store = new LocalFileManagedRunStore(rootDir, redactor);
    try {
      await expect(store.saveWaitingInput({
        runId: `run-${secret}`,
        request: { id: "request-1", kind: "missing_context", audience: "orchestrator", question: "continue" },
        resumeHandle: { runId: `run-${secret}`, providerId: "codex", workspacePath: "/tmp/synthetic" },
        now: new Date("2026-09-27T00:00:00Z"),
      })).rejects.toThrow("managed_run_identifier_not_safe");
      expect(await readdir(rootDir)).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("sanitizes legacy packets again on reload and completion, including credential fields", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-legacy-"));
    const secret = "SYNTHETIC_LEGACY_CREDENTIAL";
    const redactor = new DefaultRedactor();
    redactor.registerSecret(secret, "test-canary");
    const store = new LocalFileManagedRunStore(rootDir, redactor);
    const runId = "synthetic-legacy-run";
    const path = join(rootDir, `${createHash("sha256").update(runId).digest("hex")}.json`);
    try {
      await writeFile(path, JSON.stringify({ runId, status: "active", updatedAt: "2026-09-27T00:00:00Z",
        recoveryPacket: {
          originalPrompt: `prompt ${secret}`,
          attemptSummary: "Recovered after answering request request-1: SYNTHETIC_PREFIX_OF_UNKNOWN_SECRET",
          metadata: {
            api_key: "partial-credential", id_token: "synthetic-id-token",
            providerSecret: "synthetic-provider-secret", maxTokens: "128", note: "safe",
          },
        },
      }));
      const loaded = await store.get({ runId });
      expect(loaded?.recoveryPacket?.originalPrompt).not.toContain(secret);
      expect(loaded?.recoveryPacket?.metadata?.api_key).toBe("[redacted:credential-field]");
      expect(loaded?.recoveryPacket?.metadata?.id_token).toBe("[redacted:credential-field]");
      expect(loaded?.recoveryPacket?.metadata?.providerSecret).toBe("[redacted:credential-field]");
      expect(loaded?.recoveryPacket?.metadata?.maxTokens).toBe("128");
      expect(loaded?.recoveryPacket?.attemptSummary).toBe("Recovered after a prior blocker.");
      expect(buildManagedRunRecoveryPrompt({ packet: loaded!.recoveryPacket!, answer: "safe",
        requestId: "request-1" })).not.toContain("SYNTHETIC_PREFIX_OF_UNKNOWN_SECRET");
      await store.complete({ runId, outputText: "done", now: new Date("2026-09-27T00:01:00Z") });
      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).not.toContain("partial-credential");
      expect(persisted).not.toContain("synthetic-id-token");
      expect(persisted).not.toContain("synthetic-provider-secret");
      expect(persisted).not.toContain("SYNTHETIC_PREFIX_OF_UNKNOWN_SECRET");
      expect(persisted).toContain("[redacted:credential-field]");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("never persists a truncated resume-answer prefix", () => {
    const secret = "SYNTHETIC_ANSWER_SECRET_CROSSING_THE_OLD_240_BYTE_BOUNDARY";
    const packet = buildManagedRunRecoveryPacket({
      result: {
        status: "waiting_for_input", runId: "synthetic-run", outputText: "waiting", warnings: [],
        request: { id: "request-1", kind: "missing_context", audience: "orchestrator", question: "continue" },
        resumeHandle: { runId: "synthetic-run", providerId: "codex", workspacePath: "/tmp/synthetic" },
      },
      context: { kind: "resume", input: { runId: "synthetic-run", requestId: "request-1",
        answer: `${"a".repeat(225)}${secret}`, resumeHandle: {
          runId: "synthetic-run", providerId: "codex", workspacePath: "/tmp/synthetic",
        } }, previousRecord: null },
    });
    expect(packet.attemptSummary).toBe("Recovered after answering request request-1.");
    expect(JSON.stringify(packet)).not.toContain(secret.slice(0, 10));
  });

  it("scrubs unregistered credential fields in serialized output and failure text", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-serialized-"));
    const store = new LocalFileManagedRunStore(rootDir, new DefaultRedactor());
    const runId = "synthetic-serialized-run";
    const path = join(rootDir, `${createHash("sha256").update(runId).digest("hex")}.json`);
    try {
      await store.complete({ runId, outputText: JSON.stringify({ status: "done",
        apiKey: "SYNTHETIC_UNREGISTERED_API_KEY", nested: { providerSecret: "SYNTHETIC_PROVIDER_SECRET" } }),
        now: new Date("2026-09-27T00:00:00Z") });
      const loaded = await store.get({ runId });
      expect(JSON.parse(loaded!.outputText!)).toEqual({ status: "done",
        apiKey: "[redacted:credential-field]", nested: { providerSecret: "[redacted:credential-field]" } });
      expect(await readFile(path, "utf8")).not.toContain("SYNTHETIC_UNREGISTERED_API_KEY");

      await store.fail({ runId, failure: { code: "unknown_runtime_failure", retryable: true,
        reconnectRequired: false, safeMessage: "failed",
        details: { rawCause: "provider_api_key=SYNTHETIC_ASSIGNMENT_SECRET" } },
      now: new Date("2026-09-27T00:01:00Z") });
      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain("SYNTHETIC_ASSIGNMENT_SECRET");
      expect(persisted).toContain("[redacted:credential-bearing-text]");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("scrubs credential assignments embedded after noncredential labels", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-embedded-"));
    const store = new LocalFileManagedRunStore(rootDir, new DefaultRedactor());
    const runId = "synthetic-embedded-run";
    const path = join(rootDir, `${createHash("sha256").update(runId).digest("hex")}.json`);
    try {
      await store.complete({ runId,
        outputText: 'Result: {"apiKey":"SYNTHETIC_EMBEDDED_API_KEY"}',
        now: new Date("2026-09-27T00:00:00Z") });
      expect(await readFile(path, "utf8")).not.toContain("SYNTHETIC_EMBEDDED_API_KEY");

      await store.fail({ runId, failure: { code: "unknown_runtime_failure", retryable: true,
        reconnectRequired: false, safeMessage: "failed",
        details: { rawCause: "Error: providerSecret=SYNTHETIC_EMBEDDED_PROVIDER_SECRET" } },
      now: new Date("2026-09-27T00:01:00Z") });
      const persisted = await readFile(path, "utf8");
      expect(persisted).not.toContain("SYNTHETIC_EMBEDDED_PROVIDER_SECRET");
      expect(persisted).toContain("[redacted:credential-bearing-text]");

      await store.complete({ runId,
        outputText: JSON.stringify(JSON.stringify({ apiKey: "SYNTHETIC_DOUBLE_SERIALIZED_KEY" })),
        now: new Date("2026-09-27T00:02:00Z") });
      expect(await readFile(path, "utf8")).not.toContain("SYNTHETIC_DOUBLE_SERIALIZED_KEY");
      const loaded = await store.get({ runId });
      expect(JSON.parse(JSON.parse(loaded!.outputText!)).apiKey).toBe("[redacted:credential-field]");

      await store.fail({ runId, failure: { code: "unknown_runtime_failure", retryable: true,
        reconnectRequired: false, safeMessage: "failed",
        details: { rawCause: 'Result: {\\"apiKey\\":\\"SYNTHETIC_ESCAPED_KEY\\"}' } },
      now: new Date("2026-09-27T00:03:00Z") });
      expect(await readFile(path, "utf8")).not.toContain("SYNTHETIC_ESCAPED_KEY");

      await store.fail({ runId, failure: { code: "unknown_runtime_failure", retryable: true,
        reconnectRequired: false, safeMessage: "failed",
        details: { rawCause: "application.integrations.subscriptionRuntime.providers.mimo.credentials.providerApiKey=SYNTHETIC_LONG_KEY" } },
      now: new Date("2026-09-27T00:04:00Z") });
      expect(await readFile(path, "utf8")).not.toContain("SYNTHETIC_LONG_KEY");

      await store.fail({ runId, failure: { code: "unknown_runtime_failure", retryable: true,
        reconnectRequired: false, safeMessage: "failed",
        details: { rawCause: 'Result: {"api\\u004Bey":"SYNTHETIC_ESCAPED_FIELD_KEY"}' } },
      now: new Date("2026-09-27T00:05:00Z") });
      const escapedField = await readFile(path, "utf8");
      expect(escapedField).not.toContain("SYNTHETIC_ESCAPED_FIELD_KEY");
      expect(escapedField).toContain("[redacted:escaped-assignment-text]");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("scans a long safe token without blocking the managed-run store", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-long-safe-"));
    const store = new LocalFileManagedRunStore(rootDir, new DefaultRedactor());
    try {
      const outputText = "x".repeat(128 * 1024);
      await store.complete({ runId: "synthetic-long-safe-run", outputText,
        now: new Date("2026-09-27T00:00:00Z") });
      const loaded = await store.get({ runId: "synthetic-long-safe-run" });
      expect(loaded?.outputText).toBe(outputText);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 3000);

  it("redacts registered secrets throughout the durable recovery packet", async () => {
    // Before the fix, the returned provider result could be redacted while the
    // original prompt, answer preview and provider state still leaked to disk.
    const rootDir = await mkdtemp(join(tmpdir(), "managed-run-redaction-"));
    const secret = "SYNTHETIC_SECRET_REDACTION_CANARY";
    const redactor = new DefaultRedactor();
    redactor.registerSecret(secret, "test-canary");
    const managedRunStore = new LocalFileManagedRunStore(rootDir, redactor);
    const coordinator = new FileBackendCodexManagedRunCoordinator({
      providerInstanceId: "test-provider",
      workerId: "test-worker",
      agentDriver: null,
      sessionStore: {} as SessionStorePort,
      managedRunStore,
      runner: {} as RunnerPort,
      redactor,
      clock: { now: () => new Date("2026-09-27T00:00:00Z"), monotonicMs: () => 0 },
      recordFailure: () => {},
      recordSuccessfulRun: () => {},
      exportAuthJsonFileQuietly: async () => {},
      runRecoveryJob: async () => { throw new Error("not used"); },
    });

    try {
      await coordinator.taskResultToOutput({
        status: "waiting_for_input",
        runId: "synthetic-run",
        outputText: `output ${secret}`,
        request: {
          id: "synthetic-request",
          kind: "missing_context",
          audience: "orchestrator",
          question: `question ${secret}`,
          contextSummary: `context ${secret}`,
          suggestedAnswers: [`choice ${secret}`],
        },
        resumeHandle: {
          runId: "synthetic-run",
          providerId: "codex",
          workspacePath: "/tmp/synthetic-workspace",
          providerState: { opaque: `state ${secret}` },
        },
        warnings: [],
      }, {
        kind: "run",
        runId: "synthetic-run",
        attempt: 1,
        job: { prompt: `original ${secret}`, metadata: { note: `metadata ${secret}` } },
      });

      const paths = await readdir(rootDir);
      expect(paths).toHaveLength(1);
      const persisted = await readFile(join(rootDir, paths[0]!), "utf8");
      expect(persisted).not.toContain(secret);
      expect(persisted).toContain("[redacted:test-canary]");
      const record = await managedRunStore.get({ runId: "synthetic-run" });
      expect(record?.recoveryPacket?.originalPrompt).toBe("original [redacted:test-canary]");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
