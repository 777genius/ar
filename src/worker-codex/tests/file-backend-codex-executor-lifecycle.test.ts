import "./absent-host-scratch-fixture";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createContinuationExecutor,
  createOneShotExecutor,
  FileBackendCodexSafeExecutor,
  type FileBackendCodexSafeExecutorOptions,
} from "../index";
import {
  codexSessionHomeCacheKey,
  CodexSessionHomeProfileKind,
} from "../codex-session-home-profile";
import {
  FakeAppServerFactory,
  StaticRunner,
  codexAuthJson,
} from "./file-backend-codex-worker-test-support";

describe("Codex safe executor session-home lifecycle", () => {
  it("keeps profiled cache identities disjoint from each other and legacy keys", () => {
    const providerInstanceId = "provider:ambiguous";
    const legacy = codexSessionHomeCacheKey({
      profile: undefined,
      providerInstanceId,
      workerId: "session:sandbox-session",
    });
    const oneShot = codexSessionHomeCacheKey({
      profile: { kind: CodexSessionHomeProfileKind.OneShot },
      providerInstanceId,
      workerId: "session:sandbox-session",
    });
    const continuation = codexSessionHomeCacheKey({
      profile: {
        kind: CodexSessionHomeProfileKind.Continuation,
        sessionId: "sandbox-session",
      },
      providerInstanceId,
      workerId: "ignored",
    });

    expect(legacy).toBe("codex:provider:ambiguous:session:sandbox-session");
    expect(new Set([legacy, oneShot, continuation])).toHaveLength(3);
  });

  it("cleans one-shot CODEX_HOME on executor disposal", async () => {
    const fixture = await executorFixture("one-shot-cleanup");
    const executor = createOneShotExecutor(fixture.options);

    try {
      const result = await executor.run({
        taskId: "one-shot-task",
        prompt: "Run the isolated sandbox task.",
        controls: { editMode: "allow-edits" },
      });

      expect(result.status).toBe("completed");
      const codexHome = fixture.appServer.codexHomes[0]!;
      await expect(access(codexHome)).resolves.toBeUndefined();
      await writeFile(join(codexHome, "one-shot-marker"), "must be removed\n");

      await executor.dispose();

      await expect(access(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await executor.dispose();
      await fixture.cleanup();
    }
  });

  it("retains continuation CODEX_HOME by stable session id across executors", async () => {
    const fixture = await executorFixture("continuation-retention");
    const first = createContinuationExecutor({
      ...fixture.options,
      executorId: "continuation-executor-first",
      sessionId: "sandbox-session-1",
    });
    let second: ReturnType<typeof createContinuationExecutor> | undefined;

    try {
      const firstResult = await first.run({
        taskId: "continuation-first-task",
        prompt: "Start the sandbox continuation.",
        controls: { editMode: "allow-edits" },
      });
      expect(firstResult.status).toBe("completed");
      const firstCodexHome = fixture.appServer.codexHomes[0]!;
      const markerPath = join(firstCodexHome, "continuation-marker");
      await writeFile(markerPath, "retained\n");

      await first.dispose();
      await expect(readFile(markerPath, "utf8")).resolves.toBe("retained\n");
      await expect(access(join(firstCodexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      second = createContinuationExecutor({
        ...fixture.options,
        executorId: "continuation-executor-second",
        sessionId: "sandbox-session-1",
      });
      const secondResult = await second.run({
        taskId: "continuation-second-task",
        prompt: "Continue the sandbox session.",
        controls: { editMode: "allow-edits" },
      });

      expect(secondResult.status).toBe("completed");
      expect(fixture.appServer.codexHomes[1]).toBe(firstCodexHome);
      await expect(readFile(markerPath, "utf8")).resolves.toBe("retained\n");
    } finally {
      await first.dispose();
      await second?.dispose();
      await fixture.cleanup();
    }
  });

  it("rejects empty continuation session ids before starting a worker", async () => {
    const fixture = await executorFixture("continuation-invalid");
    try {
      expect(() =>
        createContinuationExecutor({
          ...fixture.options,
          sessionId: "   ",
        }),
      ).toThrow("file_backend_codex_continuation_session_id_required");
      expect(fixture.appServer.spawnCount).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    {
      label: "logical-thread",
      continuation: {
        logicalThread: {
          threadId: "must-not-be-used",
          onCheckpoint: () => undefined,
        },
      },
    },
    {
      label: "managed-run recovery",
      continuation: {
        recoveryPacket: {
          originalPrompt: "must not resume",
          lastOutput: "sandbox output",
          blockerQuestion: "must not ask",
        },
      },
    },
  ])("rejects $label input on a one-shot executor", async ({ continuation }) => {
    const fixture = await executorFixture("one-shot-continuation-invalid");
    const executor = createOneShotExecutor(fixture.options);
    try {
      await expect(
        executor.run({
          taskId: "one-shot-continuation-task",
          prompt: "This must be rejected before provider startup.",
          controls: { editMode: "allow-edits" },
          ...continuation,
        }),
      ).rejects.toThrow("file_backend_codex_one_shot_continuation_invalid");
      expect(fixture.appServer.spawnCount).toBe(0);
    } finally {
      await executor.dispose();
      await fixture.cleanup();
    }
  });

  it("keeps legacy constructor preservation for existing integrations", async () => {
    const fixture = await executorFixture("legacy-retention");
    const executor = new FileBackendCodexSafeExecutor(fixture.options);
    try {
      const result = await executor.run({
        taskId: "legacy-task",
        prompt: "Run the legacy compatibility task.",
        controls: { editMode: "allow-edits" },
      });
      expect(result.status).toBe("completed");
      const codexHome = fixture.appServer.codexHomes[0]!;
      const markerPath = join(codexHome, "legacy-marker");
      await writeFile(markerPath, "retained\n");

      await executor.dispose();

      await expect(readFile(markerPath, "utf8")).resolves.toBe("retained\n");
      await expect(access(join(codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await executor.dispose();
      await fixture.cleanup();
    }
  });
});

async function executorFixture(name: string): Promise<{
  readonly appServer: FakeAppServerFactory;
  readonly options: FileBackendCodexSafeExecutorOptions;
  readonly cleanup: () => Promise<void>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), `codex-${name}-`));
  const workspacePath = join(rootDir, "sandbox-workspace");
  const appServer = new FakeAppServerFactory();
  await mkdir(workspacePath, { mode: 0o700 });
  await writeFile(
    join(workspacePath, "sandbox-marker.txt"),
    "sandbox workspace marker\n",
  );
  return {
    appServer,
    options: {
      stateRootDir: join(rootDir, "state"),
      runtimeHomeRootDir: join(rootDir, "runtime-home"),
      workspacePath,
      requireGitWorkspace: false,
      accounts: [
        {
          codexAuthJson: codexAuthJson(`${name}-account`),
          worker: {
            providerInstanceId: `codex-${name}-account`,
            stateRootDir: join(rootDir, "state"),
            codexBinaryPath: "codex",
            encryptionKey: new Uint8Array(32).fill(17),
            appServerProcessFactory: appServer.create,
            runner: new StaticRunner({
              exitCode: 0,
              stdout: "",
              stderr: "",
            }),
          },
        },
      ],
    },
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}
