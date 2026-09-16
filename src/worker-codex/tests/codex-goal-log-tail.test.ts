import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES,
  CODEX_GOAL_LOG_TAIL_MAX_READ_BYTES,
  readBoundedCodexGoalLogTail,
} from "../codex-goal-log-tail";
import {
  runCodexGoalCli,
  type CodexGoalCliIo,
} from "../codex-goal-cli";
import { tailCodexGoalRunLog } from "../application/codex-goal-operation-use-cases";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("bounded Codex goal log tail", () => {
  it("returns an empty zero-line tail without opening the path", async () => {
    await expect(readBoundedCodexGoalLogTail("/missing/log", 0)).resolves.toBe("");
    await expect(readBoundedCodexGoalLogTail("/missing/log", -10)).resolves.toBe(
      "",
    );
    await expect(
      readBoundedCodexGoalLogTail("/missing/log", Number.NaN),
    ).resolves.toBe("");
  });

  it("propagates file errors for positive line requests", async () => {
    await expect(readBoundedCodexGoalLogTail("/missing/log", 1)).rejects.toThrow(
      /ENOENT/,
    );
  });

  it("preserves small UTF-8 CRLF tails and normalizes their newlines", async () => {
    const path = await fixture("first\r\nпривіт 👋\r\nlast\r\n");

    await expect(readBoundedCodexGoalLogTail(path, 2)).resolves.toBe(
      "привіт 👋\nlast\n",
    );
  });

  it("omits an incomplete multi-megabyte line and retains recent complete lines", async () => {
    const rawSecret = "secret-tail-fragment-should-never-escape";
    const giantLine = `${"x".repeat(3 * 1024 * 1024)}${rawSecret}`;
    const path = await fixture(`${giantLine}\nrecent one\nrecent two\n`);

    const tail = await readBoundedCodexGoalLogTail(path, 1_000_000);

    expect(Buffer.byteLength(giantLine)).toBeGreaterThan(
      CODEX_GOAL_LOG_TAIL_MAX_READ_BYTES,
    );
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(
      CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES,
    );
    expect(tail).toContain("[log tail truncated:");
    expect(tail).toContain("recent one\nrecent two\n");
    expect(tail).not.toContain(rawSecret);
  });

  it("omits a complete line that cannot fit the output ceiling", async () => {
    const oversized = `token=${"raw-secret".repeat(2_000)}`;
    const path = await fixture(`older\n${oversized}\nlatest\n`);

    const tail = await readBoundedCodexGoalLogTail(path, Number.POSITIVE_INFINITY);

    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(
      CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES,
    );
    expect(tail).toContain("[log tail truncated:");
    expect(tail).toContain("latest\n");
    expect(tail).not.toContain("raw-secret");
    expect(tail).not.toContain("older\n");
  });

  it("redacts complete secret-bearing lines at the application boundary", async () => {
    const path = await fixture("Authorization: Bearer rawBearerSecret\nnormal\n");

    const result = await tailCodexGoalRunLog({
      cwd: undefined,
      jobRootDir: undefined,
      taskId: undefined,
      logPath: path,
      lines: 10,
    });

    expect(result.text).toContain("Bearer [redacted]");
    expect(result.text).not.toContain("rawBearerSecret");
  });

  it("bounds application output after redaction expands short secrets", async () => {
    const path = await fixture(`${"token=x\n".repeat(1_000)}latest\n`);

    const result = await tailCodexGoalRunLog({
      cwd: undefined,
      jobRootDir: undefined,
      taskId: undefined,
      logPath: path,
      lines: 1_000,
    });

    expect(Buffer.byteLength(result.text as string)).toBeLessThanOrEqual(
      CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES,
    );
    expect(result.text).toContain("[log tail truncated:");
    expect(result.text).toContain("latest\n");
    expect(result.text).not.toContain("token=x");
  });

  it("redacts secret-bearing lines from the CLI tail output", async () => {
    const path = await fixture(`${"token=x\n".repeat(1_000)}normal\n`);
    let stdout = "";
    const io: CodexGoalCliIo = {
      cwd: () => "/tmp",
      env: () => ({}),
      writeStdout: (chunk) => {
        stdout += chunk;
      },
      writeStderr: () => undefined,
    };

    await expect(
      runCodexGoalCli(["tail", "--log", path, "--lines", "1000"], io),
    ).resolves.toBe(0);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(
      CODEX_GOAL_LOG_TAIL_MAX_OUTPUT_BYTES,
    );
    expect(stdout).toContain("[log tail truncated:");
    expect(stdout).toContain("token=[redacted:token-field]");
    expect(stdout).not.toContain("token=x");
  });
});

async function fixture(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-goal-log-tail-"));
  fixtureRoots.push(root);
  const path = join(root, "worker.log");
  await writeFile(path, contents);
  return path;
}
