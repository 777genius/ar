import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimeTaskResultStatus,
} from "@vioxen/subscription-runtime/core";
import {
  AgentRuntimeThreadOutcome,
  agentRuntimeTaskProtocolVersionV3,
  type AgentRuntimeTaskResultV3,
} from "@vioxen/subscription-runtime/agent-runtime-task";
import {
  LogicalThreadBusyError,
  LogicalThreadExecutionStatus,
  LogicalThreadStoreCorruptError,
  type LogicalThreadState,
} from "../../agent-runtime-task-runner/logical-thread";
import { FileLogicalThreadStore } from "../agent-runtime-task-runner/file-logical-thread-store";

describe("FileLogicalThreadStore", () => {
  it("persists only encrypted records with private key, directory and file modes", async () => {
    const rootDir = await temporaryRoot("logical-thread-store-");
    const store = new FileLogicalThreadStore({ rootDir });
    const state = completedThreadState();
    try {
      await store.withExclusive({
        threadId: state.threadId,
        action: async (transaction) => {
          await transaction.writeState(state);
          await transaction.writeExecution(state.lastCompletedExecution!);
        },
      });

      const files = await recursiveFiles(rootDir);
      const persisted = await Promise.all(
        files.map(async (path) => await readFile(path)),
      );
      expect(Buffer.concat(persisted).toString("utf8")).not.toContain(
        state.threadId,
      );
      expect(Buffer.concat(persisted).toString("utf8")).not.toContain(
        "provider-secret-checkpoint",
      );
      expect(mode(await lstat(keyPath(rootDir)))).toBe(0o600);
      for (const path of files) {
        expect(mode(await lstat(path))).toBe(0o600);
      }
      for (const path of [
        rootDir,
        join(rootDir, "threads"),
        join(rootDir, "executions"),
        join(rootDir, "locks"),
      ]) {
        expect(mode(await lstat(path))).toBe(0o700);
      }

      const reopened = new FileLogicalThreadStore({ rootDir });
      await reopened.withExclusive({
        threadId: state.threadId,
        action: async (transaction) => {
          expect(transaction.readState()).toEqual(state);
          expect(await transaction.readExecution("exec-1")).toEqual(
            state.lastCompletedExecution,
          );
        },
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("never reclaims an old lock and never starts a second action", async () => {
    const rootDir = await temporaryRoot("logical-thread-old-lock-");
    const threadId = "thread-1";
    const lockDir = join(
      rootDir,
      "locks",
      `${hashText(threadId)}.lock`,
    );
    let actionStarted = false;
    try {
      await initializeStore(rootDir);
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(
        join(lockDir, "owner.json"),
        `${JSON.stringify({
          storageVersion: "agent-runtime-logical-thread-lock-v1",
          lockId: "orphan-lock",
          pid: 999_999,
          acquiredAt: "2020-01-01T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      await expect(new FileLogicalThreadStore({ rootDir }).withExclusive({
        threadId,
        action: async () => {
          actionStarted = true;
        },
      })).rejects.toBeInstanceOf(LogicalThreadBusyError);
      expect(actionStarted).toBe(false);
      expect(await lstat(lockDir)).toBeDefined();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not remove a replacement lock owner during release", async () => {
    const rootDir = await temporaryRoot("logical-thread-replacement-owner-");
    const threadId = "thread-1";
    const lockDir = lockPath(rootDir, threadId);
    try {
      await new FileLogicalThreadStore({ rootDir }).withExclusive({
        threadId,
        action: async () => {
          await rm(lockDir, { recursive: true });
          await mkdir(lockDir, { mode: 0o700 });
          await writeLockOwner(lockDir, "replacement-owner");
        },
      });

      expect(JSON.parse(
        await readFile(join(lockDir, "owner.json"), "utf8"),
      )).toMatchObject({ lockId: "replacement-owner" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["key permissions", async (rootDir: string) => {
      await initializeStore(rootDir);
      await chmod(keyPath(rootDir), 0o644);
    }],
    ["record permissions", async (rootDir: string) => {
      const path = await writeActiveState(rootDir);
      await chmod(path, 0o644);
    }],
    ["state directory permissions", async (rootDir: string) => {
      await initializeStore(rootDir);
      await chmod(join(rootDir, "threads"), 0o755);
    }],
  ])("fails closed on unsafe %s", async (_label, arrange) => {
    const rootDir = await temporaryRoot("logical-thread-permission-");
    try {
      await arrange(rootDir);
      await expect(new FileLogicalThreadStore({ rootDir }).withExclusive({
        threadId: "thread-1",
        action: async () => undefined,
      })).rejects.toBeInstanceOf(LogicalThreadStoreCorruptError);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["key", async (rootDir: string, outside: string) => {
      await symlink(outside, keyPath(rootDir));
    }],
    ["record", async (rootDir: string, outside: string) => {
      const path = await writeActiveState(rootDir);
      await unlink(path);
      await symlink(outside, path);
    }],
    ["state directory", async (rootDir: string, outside: string) => {
      await initializeStore(rootDir);
      await rm(join(rootDir, "threads"), { recursive: true });
      await symlink(outside, join(rootDir, "threads"));
    }],
  ])("fails closed on a %s symlink", async (_label, arrange) => {
    const rootDir = await temporaryRoot("logical-thread-symlink-");
    const outsideDir = await temporaryRoot("logical-thread-outside-");
    const outsideFile = join(outsideDir, "outside");
    try {
      await writeFile(outsideFile, Buffer.alloc(32, 7), { mode: 0o600 });
      await arrange(rootDir, _label === "state directory"
        ? outsideDir
        : outsideFile);
      await expect(new FileLogicalThreadStore({ rootDir }).withExclusive({
        threadId: "thread-1",
        action: async () => undefined,
      })).rejects.toBeInstanceOf(LogicalThreadStoreCorruptError);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the key is missing while encrypted state exists", async () => {
    const rootDir = await temporaryRoot("logical-thread-missing-key-");
    try {
      await writeActiveState(rootDir);
      await unlink(keyPath(rootDir));
      await expect(new FileLogicalThreadStore({ rootDir }).withExclusive({
        threadId: "thread-1",
        action: async () => undefined,
      })).rejects.toBeInstanceOf(LogicalThreadStoreCorruptError);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["key", async (rootDir: string) => {
      await initializeStore(rootDir);
      await writeFile(keyPath(rootDir), Buffer.alloc(33, 7), { mode: 0o600 });
    }],
    ["encrypted record", async (rootDir: string) => {
      const path = await writeActiveState(rootDir);
      await writeFile(path, Buffer.alloc(16 * 1024 * 1024 + 1, 7), {
        mode: 0o600,
      });
    }],
  ])("fails closed before reading an oversized %s", async (_label, arrange) => {
    const rootDir = await temporaryRoot("logical-thread-oversized-");
    try {
      await arrange(rootDir);
      await expect(new FileLogicalThreadStore({ rootDir }).withExclusive({
        threadId: "thread-1",
        action: async () => undefined,
      })).rejects.toBeInstanceOf(LogicalThreadStoreCorruptError);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["negative generation", {
      ...activeThreadState(),
      generation: -1,
    }],
    ["invalid nested active execution", {
      ...activeThreadState(),
      activeExecution: {
        ...activeThreadState().activeExecution!,
        startedAt: "not-a-timestamp",
      },
    }],
    ["successful receipt without a workspace fingerprint", {
      threadId: "thread-1",
      generation: 1,
      compatibilityHash: "runtime-a",
      providerCheckpoint: "provider-secret-checkpoint",
      lastCompletedExecution: {
        status: LogicalThreadExecutionStatus.Completed,
        executionId: "exec-1",
        requestHash: "request-a",
        result: completedResult(),
        completedAt: "2026-07-29T00:00:00.000Z",
      },
      updatedAt: "2026-07-29T00:00:00.000Z",
    }],
  ])("rejects logically corrupt state before persistence: %s", async (
    _label,
    invalidState,
  ) => {
    const rootDir = await temporaryRoot("logical-thread-schema-");
    try {
      const store = new FileLogicalThreadStore({ rootDir });
      await expect(store.withExclusive({
        threadId: "thread-1",
        action: async (transaction) => {
          await transaction.writeState(
            invalidState as unknown as LogicalThreadState,
          );
        },
      })).rejects.toBeInstanceOf(LogicalThreadStoreCorruptError);
      expect(await recursiveFiles(join(rootDir, "threads"))).toEqual([]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

function activeThreadState(): LogicalThreadState {
  return {
    threadId: "thread-1",
    generation: 0,
    compatibilityHash: "runtime-a",
    activeExecution: {
      status: LogicalThreadExecutionStatus.Active,
      executionId: "exec-1",
      requestHash: "request-a",
      startedAt: "2026-07-29T00:00:00.000Z",
    },
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function completedThreadState(): LogicalThreadState {
  return {
    threadId: "thread-1",
    generation: 1,
    compatibilityHash: "runtime-a",
    providerCheckpoint: "provider-secret-checkpoint",
    lastCompletedExecution: {
      status: LogicalThreadExecutionStatus.Completed,
      executionId: "exec-1",
      requestHash: "request-a",
      result: completedResult(),
      workspaceEffectFingerprint: "workspace-a",
      completedAt: "2026-07-29T00:00:00.000Z",
    },
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function completedResult(): AgentRuntimeTaskResultV3 {
  return {
    protocolVersion: agentRuntimeTaskProtocolVersionV3,
    status: AgentRuntimeTaskResultStatus.Completed,
    outputText: "done",
    thread: {
      id: "thread-1",
      outcome: AgentRuntimeThreadOutcome.StartedFresh,
    },
    warnings: [],
  };
}

async function initializeStore(rootDir: string): Promise<void> {
  await new FileLogicalThreadStore({ rootDir }).withExclusive({
    threadId: "initialization",
    action: async () => undefined,
  });
}

async function writeActiveState(rootDir: string): Promise<string> {
  const store = new FileLogicalThreadStore({ rootDir });
  await store.withExclusive({
    threadId: "thread-1",
    action: async (transaction) =>
      await transaction.writeState(activeThreadState()),
  });
  return (await recursiveFiles(join(rootDir, "threads")))[0]!;
}

async function temporaryRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function recursiveFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(rootDir, entry.name);
    return entry.isDirectory() ? await recursiveFiles(path) : [path];
  }));
  return paths.flat();
}

function mode(metadata: Awaited<ReturnType<typeof lstat>>): number {
  return Number(metadata.mode) & 0o777;
}

function keyPath(rootDir: string): string {
  return join(rootDir, "logical-thread-encryption.key");
}

function lockPath(rootDir: string, threadId: string): string {
  return join(rootDir, "locks", `${hashText(threadId)}.lock`);
}

async function writeLockOwner(path: string, lockId: string): Promise<void> {
  const now = "2026-07-29T00:00:00.000Z";
  await writeFile(
    join(path, "owner.json"),
    `${JSON.stringify({
      storageVersion: "agent-runtime-logical-thread-lock-v1",
      lockId,
      pid: process.pid,
      acquiredAt: now,
    })}\n`,
    { mode: 0o600 },
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
