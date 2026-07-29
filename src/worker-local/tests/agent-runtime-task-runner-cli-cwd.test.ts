import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runSubscriptionAgentRuntimeTaskCli,
  type SubscriptionAgentRuntimeTaskCliIo,
} from "../agent-runtime-task-runner-cli";

describe("subscription runtime agent-runtime-task runner CLI cwd", () => {
  it("rejects request cwd values outside the current workspace", async () => {
    for (const cwd of ["/", "../escape"]) {
      await expectInvalidCwd({ cwd });
    }
  });

  it("rejects request cwd symlinks that resolve outside the current workspace", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "subscription-runtime-agent-runtime-task-cwd-"));
    const workspaceDir = join(tempDir, "workspace");
    const outsideDir = join(tempDir, "outside");
    await mkdir(workspaceDir);
    await mkdir(outsideDir);
    await symlink(outsideDir, join(workspaceDir, "outside-link"));

    try {
      await expectInvalidCwd({ cwd: "outside-link", workspaceDir });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function expectInvalidCwd(input: {
  readonly cwd: string;
  readonly workspaceDir?: string;
}): Promise<void> {
  let factoryCalled = false;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runSubscriptionAgentRuntimeTaskCli(
    ["--provider", "codex", "--ephemeral", "--format", "result-json"],
    fakeIo({
      ...(input.workspaceDir === undefined ? {} : { cwd: input.workspaceDir }),
      stdout,
      stderr,
      stdin: JSON.stringify({
        protocolVersion: 1,
        cwd: input.cwd,
        task: { kind: "structured-prompt", prompt: "hello" },
      }),
      env: { CODEX_AUTH_JSON_PATH: "/tmp/auth.json" },
    }),
    () => {
      factoryCalled = true;
      throw new Error("should not construct");
    },
  );

  expect(exitCode).toBe(1);
  expect(factoryCalled).toBe(false);
  expect(stderr).toEqual([]);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    status: "failed",
    failure: {
      code: "task_request_invalid",
      safeMessage: "Agent runtime task cwd must stay within the current workspace.",
    },
  });
}

function fakeIo(input: {
  readonly stdin: string;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}): SubscriptionAgentRuntimeTaskCliIo {
  return {
    async readStdin() {
      return input.stdin;
    },
    writeStdout(chunk) {
      input.stdout.push(chunk);
    },
    writeStderr(chunk) {
      input.stderr.push(chunk);
    },
    cwd() {
      return input.cwd ?? process.cwd();
    },
    env() {
      return input.env;
    },
  };
}
