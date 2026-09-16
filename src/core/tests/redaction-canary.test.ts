import { describe, expect, it } from "vitest";
import { DefaultRedactor } from "../index";

describe("subscription runtime redaction canary", () => {
  it("redacts provider token spellings used by CLI logs and JSON auth files", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("registered-secret", "registered");

    const redacted = redactor.redact(
      [
        "refresh_token=refresh-raw",
        "access_token: access-raw",
        '"id_token":"id-raw"',
        "Bearer bearer-raw",
        "registered-secret",
      ].join("\n"),
    );

    expect(redacted).not.toContain("refresh-raw");
    expect(redacted).not.toContain("access-raw");
    expect(redacted).not.toContain("id-raw");
    expect(redacted).not.toContain("bearer-raw");
    expect(redacted).not.toContain("registered-secret");
    expect(redacted).toContain("refresh_token=[redacted:token-field]");
    expect(redacted).toContain("access_token=[redacted:token-field]");
    expect(redacted).toContain("id_token=[redacted:token-field]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).toContain("[redacted:registered]");
  });

  it("redacts registered, bearer, and token-field values split across text deltas", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("synthetic-stream-secret", "stream");
    const stream = redactor.createTextStream();
    const output = [
      stream.push("safe synthetic-st"),
      stream.push("ream-secret token=field-"),
      stream.push("value Bear"),
      stream.push("er bearer-value done"),
      stream.flush(),
    ].join("");

    expect(output).toContain("safe ");
    expect(output).toContain("[redacted:stream]");
    expect(output).toContain("token=[redacted:token-field]");
    expect(output).toContain("Bearer [redacted]");
    expect(output).not.toContain("synthetic-stream-secret");
    expect(output).not.toContain("field-value");
    expect(output).not.toContain("bearer-value");
  });

  it("rejects an unterminated sensitive stream instead of growing its carry", () => {
    const stream = new DefaultRedactor().createTextStream();
    expect(() => stream.push(`Bearer ${"a".repeat(8 * 1024 + 1)}`)).toThrow(
      "redacted_text_stream_pending_limit_exceeded",
    );
  });

  it("does not hold ordinary output for the length of an unrelated large secret", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret(`synthetic-${"s".repeat(1024)}`, "large");
    const stream = redactor.createTextStream();

    expect(stream.push("app-server output: live text")).toContain("app-server");
  });

  it("redacts overlapping and multiline registered secrets across boundaries", () => {
    const redactor = new DefaultRedactor();
    redactor.registerSecret("synthetic-overlap", "short");
    redactor.registerSecret("synthetic-overlap-secret", "long");
    redactor.registerSecret("line-one\nline-two", "multiline");
    const stream = redactor.createTextStream();
    const output = [
      stream.push("synthetic-overlap-sec"),
      stream.push("ret line-one\nline-"),
      stream.push("two"),
      stream.flush(),
    ].join("");

    expect(output).toContain("[redacted:short]");
    expect(output).toContain("[redacted:multiline]");
    expect(output).not.toContain("synthetic-overlap-secret");
    expect(output).not.toContain("line-one\nline-two");
  });

  it("holds token-field syntax until delimiters and values are complete", () => {
    const stream = new DefaultRedactor().createTextStream();
    const output = [
      stream.push("api_key   "),
      stream.push('=synthetic!value "api_key"'),
      stream.push(':"quoted-value"'),
      stream.flush(),
    ].join("");

    expect(output).toContain("api_key=[redacted:token-field]");
    expect(output).not.toContain("synthetic!value");
    expect(output).not.toContain("quoted-value");
  });

  it("preserves a token-looking field which begins inside an emitted word", () => {
    const stream = new DefaultRedactor().createTextStream();
    expect([stream.push("x"), stream.push("api_key=value"), stream.flush()].join("")).toBe(
      "xapi_key=value",
    );
  });
});
