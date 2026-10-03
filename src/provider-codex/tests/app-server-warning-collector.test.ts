import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import {
  createBoundedAppServerWarningCollector,
  redactBoundedAppServerWarnings,
} from "../app-server/application/app-server-warning-collector";
import { redactFallbackAppServerResult } from "../app-server/application/app-server-fallback-policy";

describe("app-server warning collector", () => {
  it("bounds a warning flood, deduplicates it, and preserves an omission count", () => {
    const collector = createBoundedAppServerWarningCollector({
      maxBytes: 64 * 1024,
      maxEntries: 256,
    });
    for (let index = 0; index < 3_000; index += 1) {
      collector.push({
        code: `provider_warning_${index % 2}`,
        safeMessage: `provider warning ${index % 2}: ${"x".repeat(140)}`,
      });
    }

    const warnings = collector.drain();
    expect(warnings).toHaveLength(3);
    expect(warnings.at(-1)).toEqual({
      code: "codex_app_server_warnings_omitted",
      safeMessage: expect.stringContaining("Count: 2998."),
    });
    expect(Buffer.byteLength(JSON.stringify(warnings), "utf8")).toBeLessThan(64 * 1024);
  });

  it("redacts warning fields before applying the collection boundary", () => {
    const redactor = new DefaultRedactor();
    const secret = "warning-safety-canary";
    redactor.registerSecret(secret, "test-canary");

    const warnings = redactBoundedAppServerWarnings({
      warnings: Array.from({ length: 3_000 }, (_, index) => ({
        code: `unsupported_${index}_${secret}`,
        safeMessage: `${secret}:${"x".repeat(512)}`,
      })),
      redactor,
      context: "test-warning",
    });

    expect(JSON.stringify(warnings)).not.toContain(secret);
    expect(warnings.some((warning) => warning.code === "codex_app_server_warnings_omitted")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(warnings), "utf8")).toBeLessThan(64 * 1024);
  });

  it("accounts for serialized JSON escaping and UTF-8 bytes", () => {
    const collector = createBoundedAppServerWarningCollector({
      maxBytes: 1_024,
      maxEntries: 256,
    });
    for (let index = 0; index < 300; index += 1) {
      collector.push({
        code: `warning_${index}\u0000`,
        safeMessage: `${index}:${"\\\"\n\t😀".repeat(30)}`,
      });
    }

    const warnings = collector.drain();
    expect(Buffer.byteLength(JSON.stringify(warnings), "utf8")).toBeLessThanOrEqual(1_024);
    expect(warnings.at(-1)?.code).toBe("codex_app_server_warnings_omitted");
  });

  it("marks a fallback sanitizer failure replay-unsafe after fallback execution", () => {
    const unsafeRedactor = {
      registerSecret() {},
      redact(input: string) { return input; },
      assertNoKnownSecret() { throw new Error("warning sanitizer failed"); },
    };

    try {
      redactFallbackAppServerResult({
        error: new Error("app-server failed"),
        result: { outputText: "fallback output", warnings: [] },
        redactor: unsafeRedactor,
      });
      throw new Error("expected fallback warning sanitizer to fail");
    } catch (error) {
      expect(error).toMatchObject({ executionMayHaveStarted: true });
    }
  });
});
