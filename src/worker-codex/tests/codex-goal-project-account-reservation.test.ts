import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryAttemptJournal,
  InMemoryWorkerAccountCapacityStore,
  InMemoryWorkerAccountLeaseStore,
  type SafeExecutionTaskRecord,
  type WorkerAccountLeaseStore,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalFileWorkerAccountLeaseStore } from "@vioxen/subscription-runtime/store-local-file";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { CodexSessionHomeProfileKind } from "../codex-session-home-profile";
import {
  CodexGoalAccountSelectionMode,
  type CodexGoalJobManifest,
} from "../codex-goal-jobs";
import type { CodexGoalLaunchInput } from "../codex-goal-ops";
import {
  codexProjectContinuationReservationInput,
  assertCodexProjectReservedLaunchAuthority,
  consumeCodexProjectReservedLaunchAuthority,
  codexProjectAccountLeaseMode,
  codexProjectAccountReservationPath,
  releaseCodexProjectAccount,
  reserveCodexProjectAccount,
} from "../application/project-control/codex-goal-project-account-reservation";
import { researchRegisteredExecutionFromReservation } from "../research-registered-execution";
import {
  projectControlWorkspaceLocks,
  withValidatedProjectWorkspaceLock,
} from "../codex-goal-project-workspace-lock";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("project account reservation", () => {
  // RED: cloning, mutating, or replaying a supported selection would mint a
  // fresh execution budget without the original immutable reservation lineage.
  it("binds original selection, declared config and nested account metadata once", async () => {
    const scoped = fixture("/TEST-reservation-authority", "test-reservation");
    const reservation = await reserveCodexProjectAccount({ ...scoped,
      deps: { capacityStore: new InMemoryWorkerAccountCapacityStore(), leaseMode: "shared" } });
    const input = { manifest: scoped.manifest, sourceLaunch: scoped.launch, reservedLaunch: reservation.launch };
    const authority = assertCodexProjectReservedLaunchAuthority(input);
    expect(authority).toMatchObject({ maxAccountCycles: 1, fresh: true, accountId: reservation.accountId });
    expect(() => assertCodexProjectReservedLaunchAuthority({ ...input, reservedLaunch: { ...reservation.launch } })).toThrow();
    Object.assign(scoped.launch.config, { model: "TEST-mutated" });
    expect(() => assertCodexProjectReservedLaunchAuthority(input)).toThrow();
    Object.assign(scoped.launch.config, { model: "gpt-5.6-sol" });
    const selected = reservation.launch.config.accounts[0]!;
    Object.assign(selected, { envVarName: "TEST_FOREIGN_AUTH" });
    expect(() => assertCodexProjectReservedLaunchAuthority(input)).toThrow();
    delete (selected as { envVarName?: string }).envVarName;
    expect(consumeCodexProjectReservedLaunchAuthority(input)).toBe(authority);
    expect(() => consumeCodexProjectReservedLaunchAuthority(input)).toThrow();
  });
  it("does not bless declared config mutation across asynchronous selection", async () => {
    const scoped = fixture("/TEST-reservation-drift", "test-reservation");
    const pending = reserveCodexProjectAccount({ ...scoped,
      deps: { capacityStore: new InMemoryWorkerAccountCapacityStore(), leaseMode: "shared" } });
    Object.assign(scoped.launch.config, { prewarmOnStart: true });
    await expect(pending).rejects.toThrow("project_control_reserved_launch_source_changed");
  });
  // RED: source refusal used to strand an acquired/renewed file lease and receipt.
  // Cleanup derived from the drifted arguments would instead release the foreign reservation.
  it.each(["acquire", "renew"] as const)("releases only the captured exclusive %s after continuation data drifts", async operation => {
    const root = await mkdtemp(join(tmpdir(), "TEST-reservation-refusal-"));
    roots.push(root);
    const scoped = singleAccountFixture(root, "TEST-original-job");
    const foreign = singleAccountFixture(root, "TEST-foreign-job");
    Object.assign(foreign.launch.config, { authRootDir: join(root, "foreign-auth-unused") });
    const store = new LocalFileWorkerAccountLeaseStore({ rootDir: join(root, "original-leases") });
    const foreignStore = new LocalFileWorkerAccountLeaseStore({ rootDir: join(root, "foreign-leases") });
    const now = new Date("2026-07-13T00:00:00.000Z");
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const sessionHomeProfile = { kind: CodexSessionHomeProfileKind.Continuation, sessionId: "TEST-session" };
    Object.assign(scoped.launch.config, { sessionHomeProfile });
    const originalPath = codexProjectAccountReservationPath(scoped.manifest);
    const foreignPath = codexProjectAccountReservationPath(foreign.manifest);
    await reserveCodexProjectAccount({ ...foreign,
      deps: { capacityStore, leaseStore: foreignStore, leaseMode: "exclusive", now } });
    const foreignBytes = await readFile(foreignPath, "utf8");
    // Project selection leases the whole account (leaseDemand:null), not a model-specific slot.
    const foreignLeaseInput = { accountId: "account-a", ownerId: foreign.manifest.jobId, ttlMs: 60_000, now };
    const foreignLease = await foreignStore.acquire(foreignLeaseInput);
    expect(foreignLease.status).toBe("granted");
    if (operation === "renew") await reserveCodexProjectAccount({ ...scoped,
      deps: { capacityStore, leaseStore: store, leaseMode: "exclusive", now } });
    const deps = { capacityStore, leaseStore: store as WorkerAccountLeaseStore, leaseMode: "exclusive" as const, now };
    const drift = () => {
      sessionHomeProfile.sessionId = "TEST-mutated-session";
      Object.assign(scoped.manifest, { jobId: foreign.manifest.jobId, jobRootDir: foreign.manifest.jobRootDir });
      Object.assign(scoped.launch.config, { authRootDir: foreign.launch.config.authRootDir });
      deps.leaseStore = foreignStore;
    };
    deps.leaseStore = {
      acquire: async input => { const result = await store.acquire(input); if (operation === "acquire") drift(); return result; },
      renew: async input => { const result = await store.renew(input); if (operation === "renew") drift(); return result; },
      release: input => store.release(input),
    };
    await expect(reserveCodexProjectAccount({ ...scoped, deps })).rejects.toThrow("project_control_reserved_launch_source_changed");
    await expect(readFile(originalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.acquire({ accountId: "account-a", ownerId: "TEST-new-owner", ttlMs: 60_000, now }))
      .resolves.toMatchObject({ status: "granted" });
    expect(await readFile(foreignPath, "utf8")).toBe(foreignBytes);
    expect(await foreignStore.acquire(foreignLeaseInput)).toEqual(foreignLease);
  });
  it("keeps ordinary continuation budget historical and denies the fresh research projection", async () => {
    const scoped = fixture("/TEST-reservation-continuation", "test-reservation");
    const reservation = await reserveCodexProjectAccount({ ...scoped, continuation: { previousAttemptCount: 3 },
      deps: { capacityStore: new InMemoryWorkerAccountCapacityStore(), leaseMode: "shared" } });
    const authority = assertCodexProjectReservedLaunchAuthority({ manifest: scoped.manifest,
      sourceLaunch: scoped.launch, reservedLaunch: reservation.launch });
    expect(reservation.launch.config.maxAccountCycles).toBe(4);
    expect(authority.fresh).toBe(false);
    expect(() => researchRegisteredExecutionFromReservation(authority, reservation.launch)).toThrow(
      "hosted_research_registered_execution_unsupported");
  });

  it("keeps explicit first choice until a recorded failure allows continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-explicit-continuation-"));
    roots.push(root);
    const base = fixture(root, "job-1");
    const scoped = {
      manifest: {
        ...base.manifest,
        accounts: ["account-v", "account-o"],
        accountSelectionMode: CodexGoalAccountSelectionMode.Explicit,
      },
      launch: {
        ...base.launch,
        config: {
          ...base.launch.config,
          accounts: [{ name: "account-v" }, { name: "account-o" }],
        },
      },
    };
    const deps = {
      capacityStore: new InMemoryWorkerAccountCapacityStore(),
      leaseMode: "shared" as const,
      now: new Date("2026-07-13T00:00:00.000Z"),
    };
    expect((await reserveCodexProjectAccount({ ...scoped, deps })).accountId)
      .toBe("account-v");
    const journal = new InMemoryAttemptJournal();
    await expect(codexProjectContinuationReservationInput({
      status: {
        recommendedAction: "continue_after_capacity",
        resultReason: "account_unavailable",
      },
      launch: scoped.launch,
      journal,
    })).rejects.toThrow("project_control_continuation_attempt_history_required");
    await recordUnavailableAttempt(
      journal,
      "account-v",
      scoped.launch.config.workspacePath,
      "account_unavailable",
    );
    const continuation = await codexProjectContinuationReservationInput({
      status: {
        recommendedAction: "continue_after_capacity",
        resultReason: "account_unavailable",
      },
      launch: scoped.launch,
      journal,
    });
    expect((await reserveCodexProjectAccount({
      ...scoped,
      ...continuation,
      deps,
    })).accountId).toBe("account-o");
  });

  it.each(["account_unavailable", "capacity_unavailable"] as const)(
    "selects another shared account after %s",
    async (failureReason) => {
      const root = await mkdtemp(
        join(tmpdir(), "project-account-excluded-"),
      );
      roots.push(root);
      const capacityStore = new InMemoryWorkerAccountCapacityStore();
      const scoped = fixture(root, "job-1");
      const deps = {
        capacityStore,
        leaseMode: "shared" as const,
        now: new Date("2026-07-13T00:00:00.000Z"),
      };
      const first = await reserveCodexProjectAccount({ ...scoped, deps });
      const journal = new InMemoryAttemptJournal();
      await recordUnavailableAttempt(
        journal,
        first.accountId,
        scoped.launch.config.workspacePath,
        failureReason,
      );
      const continuation = await codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: failureReason,
        },
        launch: scoped.launch,
        journal,
      });
      await expect(
        codexProjectContinuationReservationInput({
          status: {
            recommendedAction: "continue_after_capacity",
            resultReason: failureReason,
            progressAttemptCount: 0,
          },
          launch: scoped.launch,
          journal,
        }),
      ).rejects.toThrow(
        "project_control_continuation_attempt_history_mismatch",
      );
      const continued = await reserveCodexProjectAccount({
        ...scoped,
        ...continuation,
        deps,
      });

      expect(continued.accountId).not.toBe(first.accountId);
      expect(
        continued.launch.config.accounts.map((item) => item.name),
      ).toEqual([continued.accountId]);
      expect(continued.launch.config.maxAccountCycles).toBe(2);
    },
  );

  it("continues after an account-less capacity_unavailable pool failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-pool-capacity-"));
    roots.push(root);
    const scoped = fixture(root, "job-1");
    const journal = new InMemoryAttemptJournal();
    await recordUnavailableAttempt(
      journal,
      undefined,
      scoped.launch.config.workspacePath,
      "capacity_unavailable",
    );

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "capacity_unavailable",
          progressAttemptCount: 1,
        },
        launch: scoped.launch,
        journal,
      }),
    ).resolves.toEqual({
      excludedAccountIds: [],
      continuation: { previousAttemptCount: 1 },
    });

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "capacity_unavailable",
          progressAttemptCount: 1,
        },
        launch: scoped.launch,
        journal: { readTask: async () => null },
      }),
    ).rejects.toThrow("project_control_continuation_attempt_history_required");
  });

  it("grants one new attempt after an evidenced app-server reconnect timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-reconnect-retry-"));
    roots.push(root);
    const scoped = fixture(root, "job-1");
    const journal = new InMemoryAttemptJournal();
    await recordUnavailableAttempt(
      journal,
      "account-a",
      scoped.launch.config.workspacePath,
    );
    const now = new Date("2026-07-13T00:01:00.000Z");
    const reconnectDetails = {
      rawCause:
        "codex_app_server_reconnect_timeout:Reconnecting... 2/5",
    };
    await journal.appendAttempt({
      taskId: "job-1-task",
      attempt: {
        taskId: "job-1-task",
        attemptNumber: 2,
        accountId: "account-b",
        provider: "codex",
        startedAt: now,
        finishedAt: now,
        status: "blocked",
        failureReason: "unknown_error",
        failureDetails: reconnectDetails,
        workspaceDirtyBefore: true,
        workspaceDirtyAfter: true,
        changedFiles: [],
      },
      now,
    });
    await journal.markPartial({
      taskId: "job-1-task",
      status: "partial",
      reason: "unknown_error",
      details: reconnectDetails,
      now,
    });

    const continuation = await codexProjectContinuationReservationInput({
      status: {
        recommendedAction: "inspect_dirty_failure",
        resultReason: "unknown_error",
        progressResultReason: "unknown_error",
        progressAttemptCount: 2,
        progressCurrentAccount: "account-b",
      },
      launch: scoped.launch,
      journal,
    });
    expect(continuation).toEqual({
      excludedAccountIds: [],
      continuation: { previousAttemptCount: 2 },
    });
    const reserved = await reserveCodexProjectAccount({
      ...scoped,
      ...continuation,
      deps: {
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseMode: "shared",
        now,
      },
    });
    expect(reserved.launch.config.maxAccountCycles).toBe(3);

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "inspect_dirty_failure",
          resultReason: "unknown_error",
          progressAttemptCount: 1,
        },
        launch: scoped.launch,
        journal,
      }),
    ).rejects.toThrow(
      "project_control_runtime_retry_attempt_history_mismatch",
    );
    const recorded = await journal.readTask({ taskId: "job-1-task" });
    if (!recorded) throw new Error("expected reconnect task");
    const wrappedReconnectDetails = {
      rawCause: appServerTurnError(reconnectDetails.rawCause),
    };
    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "inspect_dirty_failure",
          resultReason: "unknown_error",
        },
        launch: scoped.launch,
        journal: {
          readTask: async () => withLastFailureDetails(
            recorded,
            wrappedReconnectDetails,
          ),
        },
      }),
    ).resolves.toEqual({
      excludedAccountIds: [],
      continuation: { previousAttemptCount: 2 },
    });
    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "inspect_dirty_failure",
          resultReason: "unknown_error",
        },
        launch: scoped.launch,
        journal: {
          readTask: async () => withLastFailureDetails(recorded, {
            rawCause: appServerTurnError(wrappedReconnectDetails.rawCause),
          }),
        },
      }),
    ).resolves.toEqual({ excludedAccountIds: [] });
    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "inspect_dirty_failure",
          resultReason: "unknown_error",
        },
        launch: scoped.launch,
        journal: {
          readTask: async () => ({
            ...recorded,
            lastFailureDetails: { rawCause: "ordinary_unknown_error" },
          }),
        },
      }),
    ).resolves.toEqual({ excludedAccountIds: [] });
  });

  it("grants one new attempt after a verified prewarm failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-prewarm-retry-"));
    roots.push(root);
    const scoped = fixture(root, "job-1");
    const journal = new InMemoryAttemptJournal();
    const now = new Date("2026-07-13T00:01:00.000Z");
    await journal.startTask({
      taskId: scoped.launch.config.taskId,
      workspaceRunId: "workspace-run",
      workspacePath: scoped.launch.config.workspacePath,
      effectMode: "workspace_patch",
      provider: "codex",
      now,
    });
    await journal.appendAttempt({
      taskId: scoped.launch.config.taskId,
      attempt: {
        taskId: scoped.launch.config.taskId,
        attemptNumber: 1,
        accountId: "account-a",
        provider: "codex",
        startedAt: now,
        finishedAt: now,
        status: "blocked",
        failureReason: "unknown_error",
        workspaceDirtyBefore: true,
        workspaceDirtyAfter: true,
        changedFiles: [],
      },
      now,
    });
    await journal.markPartial({
      taskId: scoped.launch.config.taskId,
      status: "partial",
      reason: "unknown_error",
      now,
    });

    const continuation = await codexProjectContinuationReservationInput({
      status: {
        recommendedAction: "inspect_dirty_failure",
        resultReason: "unknown_error",
        progressResultReason: "unknown_error",
        progressAttemptCount: 1,
        progressCurrentAccount: "account-a",
      },
      launch: scoped.launch,
      journal,
      verifiedPrewarmBeforeAttemptContinuation: true,
    });
    expect(continuation).toEqual({
      excludedAccountIds: ["account-a"],
      continuation: { previousAttemptCount: 1 },
    });

    const reserved = await reserveCodexProjectAccount({
      ...scoped,
      ...continuation,
      deps: {
        capacityStore: new InMemoryWorkerAccountCapacityStore(),
        leaseMode: "shared",
        now,
      },
    });
    expect(reserved.accountId).toBe("account-b");
    expect(reserved.launch.config.maxAccountCycles).toBe(2);

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "inspect_dirty_failure",
          resultReason: "unknown_error",
          progressAttemptCount: 2,
        },
        launch: scoped.launch,
        journal,
        verifiedPrewarmBeforeAttemptContinuation: true,
      }),
    ).rejects.toThrow("project_control_prewarm_attempt_history_mismatch");

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "inspect_dirty_failure",
          resultReason: "unknown_error",
        },
        launch: scoped.launch,
        journal: { readTask: async () => null },
        verifiedPrewarmBeforeAttemptContinuation: true,
      }),
    ).resolves.toEqual({ excludedAccountIds: [] });
  });

  it("proves quota_limited continuation from a singleton launch account", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-quota-continuation-"));
    roots.push(root);
    const scoped = singleAccountFixture(root, "job-1");
    const journal = new InMemoryAttemptJournal();
    await recordQuotaLimitedAttemptWithoutAccount(
      journal,
      scoped.launch.config.workspacePath,
    );

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "quota_limited",
          progressAttemptCount: 1,
        },
        launch: scoped.launch,
        journal,
      }),
    ).resolves.toEqual({
      excludedAccountIds: ["account-a"],
      continuation: { previousAttemptCount: 1 },
    });

    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "account_unavailable",
        },
        launch: scoped.launch,
        journal,
      }),
    ).rejects.toThrow("project_control_continuation_attempt_history_required");
    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "quota_limited",
        },
        launch: fixture(root, "job-1").launch,
        journal,
      }),
    ).rejects.toThrow("project_control_continuation_attempt_history_required");
    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "quota_limited",
          progressResultReason: "provider_failure",
        },
        launch: scoped.launch,
        journal,
      }),
    ).rejects.toThrow("project_control_continuation_attempt_history_mismatch");
    await expect(
      codexProjectContinuationReservationInput({
        status: {
          recommendedAction: "continue_after_capacity",
          resultReason: "quota_limited",
          progressCurrentAccount: "account-b",
        },
        launch: scoped.launch,
        journal,
      }),
    ).rejects.toThrow("project_control_continuation_attempt_history_mismatch");

    const recorded = await journal.readTask({ taskId: "job-1-task" });
    if (!recorded) throw new Error("expected recorded quota task");
    const lastAttempt = recorded.attempts.at(-1)!;
    const invalidTasks: readonly SafeExecutionTaskRecord[] = [
      { ...recorded, workspacePath: `${recorded.workspacePath}-stale` },
      {
        ...recorded,
        attempts: [{ ...lastAttempt, provider: "other-provider" }],
      },
      {
        ...recorded,
        attempts: [
          lastAttempt,
          {
            ...lastAttempt,
            attemptNumber: 2,
            failureReason: "account_unavailable",
          },
        ],
      },
    ];
    for (const invalidTask of invalidTasks) {
      await expect(
        codexProjectContinuationReservationInput({
          status: {
            recommendedAction: "continue_after_capacity",
            resultReason: "quota_limited",
          },
          launch: scoped.launch,
          journal: { readTask: async () => invalidTask },
        }),
      ).rejects.toThrow("project_control_continuation_attempt_history_required");
    }
  });

  it("releases an excluded exclusive reservation before selecting another account", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-reselected-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const scoped = fixture(root, "job-1");
    const deps = {
      capacityStore,
      leaseStore,
      leaseMode: "exclusive" as const,
      now,
    };
    const first = await reserveCodexProjectAccount({ ...scoped, deps });
    const continued = await reserveCodexProjectAccount({
      ...scoped,
      excludedAccountIds: [first.accountId],
      continuation: { previousAttemptCount: 1 },
      deps,
    });

    expect(continued.accountId).not.toBe(first.accountId);
    await expect(leaseStore.acquire({
      accountId: first.accountId,
      ownerId: "independent-job",
      ttlMs: 60_000,
      now,
    })).resolves.toMatchObject({ status: "granted" });
  });

  it("grants one brokered continuation after a single account recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-exhausted-"));
    roots.push(root);
    const now = new Date("2026-07-13T00:00:00.000Z");
    const scoped = singleAccountFixture(root, "job-1");
    const bounded = {
      ...scoped,
      launch: {
        ...scoped.launch,
        config: { ...scoped.launch.config, maxAccountCycles: 1 },
      },
    };
    const deps = {
      capacityStore: new InMemoryWorkerAccountCapacityStore(),
      leaseMode: "shared" as const,
      now,
    };
    const first = await reserveCodexProjectAccount({ ...bounded, deps });
    const continued = await reserveCodexProjectAccount({
      ...bounded,
      excludedAccountIds: [first.accountId],
      continuation: { previousAttemptCount: 1 },
      deps: { ...deps, now: new Date(now.getTime() + 60_000) },
    });

    expect(continued.accountId).toBe(first.accountId);
    expect(continued.launch.config.accounts).toEqual([{ name: "account-a" }]);
    expect(continued.launch.config.maxAccountCycles).toBe(2);
  });

  it("shares an account across concurrent jobs by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-shared-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const deps = { capacityStore, leaseStore, now, leaseMode: "shared" as const };
    const first = singleAccountFixture(root, "job-1");
    const second = singleAccountFixture(root, "job-2");

    const firstSelection = await reserveCodexProjectAccount({ ...first, deps });
    const secondSelection = await reserveCodexProjectAccount({ ...second, deps });

    expect(firstSelection).toMatchObject({ mode: "shared", accountId: "account-a" });
    expect(secondSelection).toMatchObject({ mode: "shared", accountId: "account-a" });
    await expect(leaseStore.acquire({
      accountId: "account-a",
      ownerId: "independent-job",
      ttlMs: 60_000,
      now,
    })).resolves.toMatchObject({ status: "granted" });
    await expect(releaseCodexProjectAccount({
      ...first,
      reason: "shared jobs have no lease",
      deps: { leaseStore, now },
    })).resolves.toBe(false);
  });

  it("keeps exclusive account leases behind an explicit feature flag", () => {
    expect(codexProjectAccountLeaseMode({})).toBe("shared");
    expect(codexProjectAccountLeaseMode({
      SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES: "0",
    })).toBe("shared");
    expect(codexProjectAccountLeaseMode({
      SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES: "1",
    })).toBe("exclusive");
    expect(() => codexProjectAccountLeaseMode({
      SUBSCRIPTION_RUNTIME_PROJECT_ACCOUNT_EXCLUSIVE_LEASES: "true",
    })).toThrow("project_control_account_exclusive_leases_flag_invalid");
  });

  it("reserves before launch, is reentrant and fences concurrent jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-reservation-"));
    roots.push(root);
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const deps = {
      capacityStore,
      leaseStore,
      now,
      leaseMode: "exclusive" as const,
    };
    const first = fixture(root, "job-1");
    const second = fixture(root, "job-2", "high");

    const firstReservation = await reserveCodexProjectAccount({ ...first, deps });
    const secondReservation = await reserveCodexProjectAccount({ ...second, deps });
    const firstReplay = await reserveCodexProjectAccount({ ...first, deps });
    expect(firstReservation.mode).toBe("exclusive");
    expect(firstReplay.mode).toBe("exclusive");
    if (firstReservation.mode !== "exclusive" || firstReplay.mode !== "exclusive") {
      throw new Error("exclusive_reservation_expected");
    }

    expect(firstReservation.accountId).toBe("account-a");
    expect(firstReservation.launch.config.accounts.map((item) => item.name)).toEqual([
      "account-a",
    ]);
    expect(firstReservation.launch.config.maxAccountCycles).toBe(1);
    expect(secondReservation.accountId).toBe("account-b");
    expect(firstReplay).toMatchObject({
      accountId: firstReservation.accountId,
      fencingToken: firstReservation.fencingToken,
    });

    await expect(releaseCodexProjectAccount({
      ...first,
      reason: "test complete",
      deps: { leaseStore, now },
    })).resolves.toBe(true);
    const third = fixture(root, "job-3");
    const thirdReservation = await reserveCodexProjectAccount({ ...third, deps });
    expect(thirdReservation.mode).toBe("exclusive");
    if (thirdReservation.mode !== "exclusive") {
      throw new Error("exclusive_reservation_expected");
    }
    expect(thirdReservation.accountId).toBe("account-a");
    expect(thirdReservation.fencingToken).toBeGreaterThan(
      firstReservation.fencingToken,
    );
  });

  it("serializes stop release against restart so a successor receipt survives", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-account-release-race-"));
    roots.push(root);
    const workspacePath = join(root, "worktrees", "shared");
    const registryRootDir = join(root, "worker-jobs", "registry");
    await mkdir(workspacePath, { recursive: true });
    const leaseStore = new InMemoryWorkerAccountLeaseStore();
    const capacityStore = new InMemoryWorkerAccountCapacityStore();
    const now = new Date("2026-07-13T00:00:00.000Z");
    const account = fixture(root, "job-1");
    const scoped = {
      ...account,
      manifest: { ...account.manifest, workspacePath },
      launch: {
        ...account.launch,
        config: { ...account.launch.config, workspacePath },
      },
    };
    const deps = {
      capacityStore,
      leaseStore,
      now,
      leaseMode: "exclusive" as const,
    };
    await reserveCodexProjectAccount({ ...scoped, deps });
    let allowStopRelease!: () => void;
    const stopMayRelease = new Promise<void>((resolve) => {
      allowStopRelease = resolve;
    });
    let stopEntered!: () => void;
    const stopDidEnter = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    const locks = projectControlWorkspaceLocks(registryRootDir);
    const scope = {
      projectId: "project-a",
      workspaceRoots: [join(root, "workspaces")],
      worktreeRoots: [join(root, "worktrees")],
      registryRoot: registryRootDir,
    };
    const stop = withValidatedProjectWorkspaceLock({
      locks,
      scope,
      requestedWorkspacePath: workspacePath,
      owner: "stop:job-1",
      effect: async () => {
        stopEntered();
        await stopMayRelease;
        await releaseCodexProjectAccount({
          ...scoped,
          reason: "worker_stopped",
          deps: { leaseStore, now },
        });
      },
    });
    await stopDidEnter;

    await expect(withValidatedProjectWorkspaceLock({
      locks,
      scope,
      requestedWorkspacePath: workspacePath,
      owner: "restart:job-1",
      effect: async () => {
        await reserveCodexProjectAccount({ ...scoped, deps });
      },
    })).rejects.toMatchObject({ code: "safe_execution_workspace_locked" });
    allowStopRelease();
    await stop;

    const successor = await withValidatedProjectWorkspaceLock({
      locks,
      scope,
      requestedWorkspacePath: workspacePath,
      owner: "restart:job-1",
      effect: async () =>
        await reserveCodexProjectAccount({ ...scoped, deps }),
    });
    expect(successor.mode).toBe("exclusive");
    if (successor.mode !== "exclusive") {
      throw new Error("exclusive_reservation_expected");
    }
    expect(successor.fencingToken).toBeGreaterThan(1);
    await expect(releaseCodexProjectAccount({
      ...scoped,
      reason: "successor_cleanup",
      deps: { leaseStore, now },
    })).resolves.toBe(true);
  });
});

function singleAccountFixture(
  root: string,
  jobId: string,
): ReturnType<typeof fixture> {
  const value = fixture(root, jobId);
  return {
    manifest: { ...value.manifest, accounts: ["account-a"] },
    launch: {
      ...value.launch,
      config: {
        ...value.launch.config,
        accounts: [{ name: "account-a" }],
      },
    },
  };
}

export function fixture(
  root: string,
  jobId: string,
  reasoningEffort: "xhigh" | "high" = "xhigh",
): {
  readonly manifest: CodexGoalJobManifest;
  readonly launch: CodexGoalLaunchInput;
} {
  const jobRootDir = join(root, jobId);
  const manifest: CodexGoalJobManifest = {
    schemaVersion: 1,
    jobId,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    jobRootDir,
    workspacePath: join(root, "workspace"),
    promptPath: join(jobRootDir, "prompt.md"),
    taskId: `${jobId}-task`,
    accounts: ["account-a", "account-b"],
  };
  return {
    manifest,
    launch: {
      config: {
        jobId,
        jobRootDir,
        authRootDir: join(root, "auth"),
        workspacePath: manifest.workspacePath,
        promptPath: manifest.promptPath,
        taskId: manifest.taskId,
        accounts: [{ name: "account-a" }, { name: "account-b" }],
        model: "gpt-5.6-sol",
        reasoningEffort,
        serviceTier: "fast",
        taskTimeoutMs: 60_000,
      },
      tmuxSession: `${jobId}-tmux`,
      cwd: manifest.workspacePath,
      logPath: join(jobRootDir, "worker.log"),
      cliCommand: ["node", "runtime.js"],
    },
  };
}

async function recordUnavailableAttempt(
  journal: InMemoryAttemptJournal,
  accountId: string | undefined,
  workspacePath: string,
  failureReason: "account_unavailable" | "capacity_unavailable" =
    "account_unavailable",
): Promise<void> {
  const now = new Date("2026-07-13T00:00:00.000Z");
  await journal.startTask({
    taskId: "job-1-task",
    workspaceRunId: "workspace-run",
    workspacePath,
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await journal.appendAttempt({
    taskId: "job-1-task",
    attempt: {
      taskId: "job-1-task",
      attemptNumber: 1,
      ...(accountId ? { accountId } : {}),
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason,
      workspaceDirtyBefore: true,
      workspaceDirtyAfter: true,
      changedFiles: [],
    },
    now,
  });
  await journal.markPartial({
    taskId: "job-1-task",
    status: "waiting_capacity",
    reason: failureReason,
    now,
  });
}

function appServerTurnError(cause: string): string {
  return `codex_app_server_turn_error:${cause}:details=${JSON.stringify({
    phase: "turn_error_before_output",
    turnNumber: 1,
    outputObserved: false,
    outputCharCount: 0,
    elapsedMs: 25,
  })}`;
}

function withLastFailureDetails(
  task: SafeExecutionTaskRecord,
  details: Readonly<Record<string, string>>,
): SafeExecutionTaskRecord {
  return {
    ...task,
    lastFailureDetails: details,
    attempts: task.attempts.map((attempt, index) =>
      index === task.attempts.length - 1
        ? { ...attempt, failureDetails: details }
        : attempt
    ),
  };
}

async function recordQuotaLimitedAttemptWithoutAccount(
  journal: InMemoryAttemptJournal,
  workspacePath: string,
): Promise<void> {
  const now = new Date("2026-07-13T00:00:00.000Z");
  await journal.startTask({
    taskId: "job-1-task",
    workspaceRunId: "workspace-run",
    workspacePath,
    effectMode: "workspace_patch",
    provider: "codex",
    now,
  });
  await journal.appendAttempt({
    taskId: "job-1-task",
    attempt: {
      taskId: "job-1-task",
      attemptNumber: 1,
      provider: "codex",
      startedAt: now,
      finishedAt: now,
      status: "blocked",
      failureReason: "quota_limited",
      workspaceDirtyBefore: false,
      workspaceDirtyAfter: false,
      changedFiles: [],
    },
    now,
  });
  await journal.markPartial({
    taskId: "job-1-task",
    status: "waiting_capacity",
    reason: "quota_limited",
    now,
  });
}
