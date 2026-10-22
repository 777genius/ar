import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryWorkspaceLockStore,
  SafeExecutionRunner,
  SubscriptionWorkerError,
  type WorkspaceLockHandle,
  type WorkspaceLockStore,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotter,
} from "@vioxen/subscription-runtime/worker-core";
import {
  LocalFileAttemptJournal,
  LocalFileWorkspaceLockStore,
} from "../safe-execution";

type PromptJob = {
  readonly prompt: string;
  readonly workspacePath: string;
};

type PromptResult = {
  readonly output: string;
};

describe("local safe execution state stores", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    while (cleanupPaths.length > 0) {
      const path = cleanupPaths.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  it("replaces a workspace lock owned by a dead process without requiring staleLockMs", async () => {
    const workspacePath = await tempDir("local-safe-execution-workspace-");
    const canonicalWorkspacePath = await realpath(workspacePath);
    const lockRoot = await tempDir("local-safe-execution-lock-store-");
    const lockStore = new LocalFileWorkspaceLockStore(lockRoot);
    const deadOwner = await lockStore.acquire({
      taskId: "task-dead-lock-owner",
      workspacePath,
      ownerId: "dead-owner",
      ownerPid: 9_999_999,
    });

    const replacement = await lockStore.acquire({
      taskId: "task-dead-lock-replacement",
      workspacePath,
      ownerId: "replacement-owner",
      ownerPid: process.pid,
    });

    expect(replacement.taskId).toBe("task-dead-lock-replacement");
    expect(replacement.workspacePath).toBe(canonicalWorkspacePath);
    await replacement.release();
    await deadOwner.release();
  });

  it("does not replace a workspace lock owned by a live process", async () => {
    const workspacePath = await tempDir("local-safe-execution-live-lock-");
    const lockRoot = await tempDir("local-safe-execution-live-lock-store-");
    const lockStore = new LocalFileWorkspaceLockStore(lockRoot);
    const lock = await lockStore.acquire({
      taskId: "task-live-lock-owner",
      workspacePath,
      ownerId: "live-owner",
      ownerPid: process.pid,
    });

    try {
      await expect(
        lockStore.acquire({
          taskId: "task-live-lock-replacement",
          workspacePath,
          ownerId: "replacement-owner",
          ownerPid: process.pid,
        }),
      ).rejects.toMatchObject({
        code: "safe_execution_workspace_locked",
        details: expect.objectContaining({
          taskId: "task-live-lock-owner",
          ownerPid: String(process.pid),
        }),
      });
    } finally {
      await lock.release();
    }
  });

  it("allows only one replacement for concurrent dead-process locks", async () => {
    const workspacePath = await tempDir("local-safe-execution-race-lock-");
    const lockRoot = await tempDir("local-safe-execution-race-lock-store-");
    const lockStore = new LocalFileWorkspaceLockStore(lockRoot);

    await lockStore.acquire({
      taskId: "task-stale-race",
      workspacePath,
      ownerId: "old-owner",
      ownerPid: 9_999_999,
    });

    const results = await Promise.allSettled([
      lockStore.acquire({
        taskId: "task-replacement-race-a",
        workspacePath,
        ownerId: "new-owner-a",
        ownerPid: process.pid,
      }),
      lockStore.acquire({
        taskId: "task-replacement-race-b",
        workspacePath,
        ownerId: "new-owner-b",
        ownerPid: process.pid,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<WorkspaceLockHandle> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "safe_execution_workspace_locked",
    });
    await fulfilled[0]!.value.release();
  });

  it("does not let stale handles release replacement workspace locks", async () => {
    const stores: readonly {
      readonly name: string;
      create(): Promise<WorkspaceLockStore>;
    }[] = [
      {
        name: "memory",
        create: async () => new InMemoryWorkspaceLockStore(),
      },
      {
        name: "file",
        create: async () =>
          new LocalFileWorkspaceLockStore(
            await tempDir("local-safe-execution-stale-release-store-"),
          ),
      },
    ];

    for (const store of stores) {
      const workspacePath = await tempDir(
        `local-safe-execution-stale-release-${store.name}-`,
      );
      const lockStore = await store.create();
      const stale = await lockStore.acquire({
        taskId: "task-same-owner",
        workspacePath,
        ownerId: "same-owner",
        ownerPid: 9_999_999,
      });
      const replacement = await lockStore.acquire({
        taskId: "task-same-owner",
        workspacePath,
        ownerId: "same-owner",
        ownerPid: process.pid,
      });

      await stale.release();
      await expect(
        lockStore.acquire({
          taskId: "task-probe",
          workspacePath,
          ownerId: "probe-owner",
          ownerPid: process.pid,
        }),
      ).rejects.toMatchObject({
        code: "safe_execution_workspace_locked",
      });
      await replacement.release();
    }
  });

  it("resumes a partial task from the local file journal with a continuation packet", async () => {
    const workspacePath = await tempDir(
      "local-safe-execution-journal-workspace-",
    );
    const stateRoot = await tempDir("local-safe-execution-state-");
    const firstJournal = new LocalFileAttemptJournal(stateRoot);
    const firstRunner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: firstJournal,
      snapshotter: new SequenceSnapshotter([
        snapshot({ workspacePath, fingerprint: "clean", dirty: false }),
        snapshot({
          workspacePath,
          fingerprint: "dirty",
          dirty: true,
          changedFiles: ["journal.txt"],
          summary: "Git workspace has 1 changed file(s).",
        }),
      ]),
    });

    await firstRunner.run({
      taskId: "task-journal",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Quota limited.",
            { details: { reason: "quota_limited" } },
          );
        },
      },
      job: { prompt: "finish journal task", workspacePath },
      originalPrompt: "finish journal task",
      policy: { maxAttempts: 1 },
    });

    const secondJournal = new LocalFileAttemptJournal(stateRoot);
    const persisted = await secondJournal.readTask({ taskId: "task-journal" });
    expect(persisted?.lastFailureReason).toBe("quota_limited");
    expect(persisted?.startedAt).toBeInstanceOf(Date);
    expect(persisted?.attempts).toHaveLength(1);

    let resumedPrompt = "";
    const secondRunner = new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: secondJournal,
      snapshotter: new SequenceSnapshotter([
        snapshot({
          workspacePath,
          fingerprint: "resume-dirty",
          dirty: true,
          changedFiles: ["journal.txt"],
          summary: "Git workspace has 1 changed file(s).",
        }),
        snapshot({
          workspacePath,
          fingerprint: "resume-before",
          dirty: true,
          changedFiles: ["journal.txt"],
        }),
        snapshot({
          workspacePath,
          fingerprint: "resume-after",
          dirty: true,
          changedFiles: ["journal.txt"],
        }),
      ]),
    });
    const result = await secondRunner.run({
      taskId: "task-journal",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          resumedPrompt = job.prompt;
          return { output: "resumed" };
        },
      },
      job: { prompt: "finish journal task", workspacePath },
      originalPrompt: "finish journal task",
      policy: { maxAttempts: 2 },
    });

    expect(result.status).toBe("completed");
    expect(result.attempts).toHaveLength(2);
    expect(resumedPrompt).toContain("Continue the same task");
    expect(resumedPrompt).toContain(
      "Previous attempt stopped because: quota_limited",
    );
    expect(resumedPrompt).toContain("- journal.txt");
  });

  it("starts a fresh attempt sequence for a completed record from another execution generation", async () => {
    const workspacePath = await tempDir(
      "local-safe-execution-generation-workspace-",
    );
    const stateRoot = await tempDir("local-safe-execution-generation-state-");
    const first = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(
        stateRoot,
        undefined,
        "TEST-generation-first",
      ),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-generation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "read_only",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "first" };
        },
      },
      job: { prompt: "finish generation task", workspacePath },
      originalPrompt: "finish generation task",
      policy: { maxAttempts: 1 },
    });
    expect(first.status).toBe("completed");

    let poolRuns = 0;
    const second = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(
        stateRoot,
        undefined,
        "TEST-generation-second",
      ),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-generation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "read_only",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          poolRuns += 1;
          return { output: "second" };
        },
      },
      job: { prompt: "finish generation task", workspacePath },
      originalPrompt: "finish generation task",
      policy: { maxAttempts: 1 },
    });

    expect(poolRuns).toBe(1);
    expect(second).toMatchObject({
      status: "completed",
      replayed: false,
      result: { output: "second" },
    });
    expect(second.attempts).toHaveLength(1);
    const record = await new LocalFileAttemptJournal(stateRoot).readTask({
      taskId: "task-generation",
    });
    expect(record?.executionGeneration).toBe("TEST-generation-second");
    expect(record?.attempts).toHaveLength(1);
    expect(record?.attempts[0]?.attemptNumber).toBe(1);
  });

  it("replays a completed record through a journal without an execution generation", async () => {
    const workspacePath = await tempDir(
      "local-safe-execution-ungenerated-workspace-",
    );
    const stateRoot = await tempDir("local-safe-execution-ungenerated-state-");
    const first = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(stateRoot),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-ungenerated",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "read_only",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "first" };
        },
      },
      job: { prompt: "finish ungenerated task", workspacePath },
      originalPrompt: "finish ungenerated task",
      policy: { maxAttempts: 1 },
    });
    expect(first.status).toBe("completed");

    let poolRuns = 0;
    const second = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(stateRoot),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-ungenerated",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "read_only",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          poolRuns += 1;
          throw new Error("TEST replay must not invoke the provider");
        },
      },
      job: { prompt: "finish ungenerated task", workspacePath },
      originalPrompt: "finish ungenerated task",
      policy: { maxAttempts: 1 },
    });

    expect(poolRuns).toBe(0);
    expect(second).toMatchObject({
      status: "completed",
      replayed: true,
      result: { output: "first" },
    });
  });

  it("replays a completed record from its own execution generation", async () => {
    const workspacePath = await tempDir(
      "local-safe-execution-same-generation-workspace-",
    );
    const stateRoot = await tempDir(
      "local-safe-execution-same-generation-state-",
    );
    const first = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(
        stateRoot,
        undefined,
        "TEST-generation-same",
      ),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-same-generation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "read_only",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          return { output: "first" };
        },
      },
      job: { prompt: "finish same generation task", workspacePath },
      originalPrompt: "finish same generation task",
      policy: { maxAttempts: 1 },
    });
    expect(first.status).toBe("completed");

    let poolRuns = 0;
    const second = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(
        stateRoot,
        undefined,
        "TEST-generation-same",
      ),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-same-generation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "read_only",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          poolRuns += 1;
          throw new Error("TEST same-generation replay must not invoke the provider");
        },
      },
      job: { prompt: "finish same generation task", workspacePath },
      originalPrompt: "finish same generation task",
      policy: { maxAttempts: 1 },
    });

    expect(poolRuns).toBe(0);
    expect(second).toMatchObject({
      status: "completed",
      replayed: true,
      result: { output: "first" },
    });
  });

  it("resumes a failed record from another execution generation with a continuation packet", async () => {
    const workspacePath = await tempDir(
      "local-safe-execution-failed-generation-workspace-",
    );
    const stateRoot = await tempDir(
      "local-safe-execution-failed-generation-state-",
    );
    await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(
        stateRoot,
        undefined,
        "TEST-generation-failed-first",
      ),
      snapshotter: new SequenceSnapshotter([]),
    }).run({
      taskId: "task-failed-generation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(): Promise<PromptResult> {
          throw new SubscriptionWorkerError(
            "subscription_worker_run_failed",
            "Quota limited.",
            { details: { reason: "quota_limited" } },
          );
        },
      },
      job: { prompt: "finish failed generation task", workspacePath },
      originalPrompt: "finish failed generation task",
      policy: { maxAttempts: 1 },
    });

    let resumedPrompt = "";
    const second = await new SafeExecutionRunner({
      lockStore: new InMemoryWorkspaceLockStore(),
      journal: new LocalFileAttemptJournal(
        stateRoot,
        undefined,
        "TEST-generation-failed-second",
      ),
      snapshotter: new SequenceSnapshotter([
        snapshot({
          workspacePath,
          fingerprint: "resume-dirty",
          dirty: true,
          changedFiles: ["journal.txt"],
          summary: "Git workspace has 1 changed file(s).",
        }),
      ]),
    }).run({
      taskId: "task-failed-generation",
      workspace: { mode: "existing_locked", path: workspacePath },
      effectMode: "workspace_patch",
      provider: "codex",
      pool: {
        async run(job: PromptJob): Promise<PromptResult> {
          resumedPrompt = job.prompt;
          return { output: "resumed" };
        },
      },
      job: { prompt: "finish failed generation task", workspacePath },
      originalPrompt: "finish failed generation task",
      policy: { maxAttempts: 2 },
    });

    expect(second.status).toBe("completed");
    expect(second.attempts).toHaveLength(2);
    expect(resumedPrompt).toContain("Continue the same task");
    expect(resumedPrompt).toContain(
      "Previous attempt stopped because: quota_limited",
    );
  });

  async function tempDir(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    cleanupPaths.push(path);
    await mkdir(path, { recursive: true });
    return path;
  }
});

class SequenceSnapshotter implements WorkspaceSnapshotter {
  private readonly snapshots: WorkspaceSnapshot[];

  constructor(snapshots: readonly WorkspaceSnapshot[]) {
    this.snapshots = [...snapshots];
  }

  async capture(input: {
    readonly workspacePath: string;
  }): Promise<WorkspaceSnapshot> {
    return (
      this.snapshots.shift() ??
      snapshot({ workspacePath: input.workspacePath, fingerprint: "fallback" })
    );
  }
}

function snapshot(input: {
  readonly workspacePath: string;
  readonly fingerprint: string;
  readonly dirty?: boolean;
  readonly changedFiles?: readonly string[];
  readonly summary?: string;
}): WorkspaceSnapshot {
  const changedFiles = input.changedFiles ?? [];
  return {
    mode: "git",
    workspacePath: input.workspacePath,
    capturedAt: new Date("2026-01-01T00:00:00.000Z"),
    dirty: input.dirty ?? changedFiles.length > 0,
    changedFiles,
    fingerprint: input.fingerprint,
    summary:
      input.summary ??
      (changedFiles.length === 0
        ? "Git workspace is clean."
        : `Git workspace has ${changedFiles.length} changed file(s).`),
  };
}
