import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES,
  gitWorkspaceStatus,
  readLastCodexGoalRuntimeEvent,
} from "../codex-goal-status-files";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

describe("Codex goal workspace status", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("reports exact nested untracked file paths", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "codex-goal-status-"));
    cleanup.push(workspacePath);
    await execFileAsync("git", ["init"], { cwd: workspacePath });
    await mkdir(join(workspacePath, "nested"));
    await writeFile(join(workspacePath, "nested", "untracked.ts"), "export {};\n");

    await expect(gitWorkspaceStatus(workspacePath)).resolves.toMatchObject({
      exists: true,
      dirty: true,
      changedFiles: ["nested/untracked.ts"],
    });
  });
});

describe("Codex goal runtime event status", () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ));
  });

  it("reads the last non-empty UTF-8 record with CRLF and trailing whitespace", async () => {
    const path = await runtimeEventFixture([
      '{"event":"earlier"}',
      '{"event":"привіт 👋","timestamp":"2026-09-05T00:00:00Z","level":"info"}',
      "  ",
      "",
    ].join("\r\n"));

    await expect(readLastCodexGoalRuntimeEvent(path)).resolves.toEqual({
      event: "привіт 👋",
      timestamp: "2026-09-05T00:00:00Z",
      level: "info",
    });
  });

  it("reads only a bounded suffix of a long event history", async () => {
    const lastEvent = '{"event":"latest"}\n';
    const path = await runtimeEventFixture(
      `${"x".repeat(CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES * 2)}\n${lastEvent}`,
    );

    await expect(readLastCodexGoalRuntimeEvent(path)).resolves.toEqual({
      event: "latest",
    });
  });

  it("warns instead of selecting an older event when the last record is oversized", async () => {
    const path = await runtimeEventFixture(
      `{"event":"older"}\n{"event":"${"x".repeat(
        CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES,
      )}"}`,
    );

    const result = await readLastCodexGoalRuntimeEvent(path);

    expect(result.event).toBeUndefined();
    expect(result.warning).toContain("last record begins outside");
    expect(result.warning).toContain(
      `${CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES}-byte suffix`,
    );
  });

  it("bounds unresolved trailing whitespace scans", async () => {
    const path = await runtimeEventFixture(
      `{"event":"older"}\n${" ".repeat(
        CODEX_GOAL_RUNTIME_EVENT_MAX_READ_BYTES + 1,
      )}`,
    );

    await expect(readLastCodexGoalRuntimeEvent(path)).resolves.toEqual({
      warning: expect.stringContaining("last non-empty record was not found"),
    });
  });

  it("returns a secret-free warning for a malformed last record", async () => {
    const secret = "raw-secret-must-not-escape";
    const path = await runtimeEventFixture(`{"event":"ok"}\n{${secret}}`);

    const result = await readLastCodexGoalRuntimeEvent(path);

    expect(result.warning).toBe(
      "runtime event file is unreadable or its last record is malformed",
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("handles missing and empty files", async () => {
    const emptyPath = await runtimeEventFixture("");
    await expect(readLastCodexGoalRuntimeEvent(emptyPath)).resolves.toEqual({});
    await expect(
      readLastCodexGoalRuntimeEvent(`${emptyPath}.missing`),
    ).resolves.toEqual({});
  });
});

async function runtimeEventFixture(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-goal-runtime-event-"));
  cleanup.push(root);
  const path = join(root, "runtime-events.jsonl");
  await writeFile(path, contents);
  return path;
}
