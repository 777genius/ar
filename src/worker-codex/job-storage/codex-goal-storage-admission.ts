import { lstat } from "node:fs/promises";
import { LocalTerminalCheckpointAdmission } from "@vioxen/subscription-runtime/store-local-file";
import { readLocalGitHeadCommit } from "../codex-goal-git-revision";
import { assertCodexGoalTurnCheckpointHistory } from "../codex-goal-turn-checkpoint";
import { prepareHostScratchTemp } from "../host-scratch-temp";
import type { CodexGoalRunDeps } from "./codex-goal-runner-contracts";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import {
  assertJobStorageIdentity, assertJobStorageIntent, JobStorageIntentKind, JobStorageProducer,
  JobStorageCapabilityUnavailableError, JobStorageUnavailableCapability,
  type JobStorageAdmissionPort, type JobStorageIntent, type JobStorageWriteLease,
} from "@vioxen/subscription-runtime/worker-core";
import { assertCodexSessionHomeProfile, CodexSessionHomeProfileKind } from "../codex-session-home-profile";
import type { CodexGoalRunConfig } from "../codex-goal-runner";

export type CodexGoalNewStorage = {
  readonly generationId: string;
  readonly intent: JobStorageIntent;
};

/** NEW config is immutable across awaited host admission. Legacy is untouched. */
export function snapshotCodexGoalStorageConfig(config: CodexGoalRunConfig): CodexGoalRunConfig {
  const state = join(config.jobRootDir, "state"), home = join(config.jobRootDir, "home"), tmp = join(config.jobRootDir, "tmp");
  const fixedPaths = { stateRootDir: state, runtimeHomeRootDir: home,
    outputPath: join(config.jobRootDir, "output", `${config.taskId}.latest-result.json`),
    progressPath: join(config.jobRootDir, "output", `${config.taskId}.progress.json`),
    encryptionKeyPath: join(state, "encryption-key.hex"), durableHandoffRootDir: join(config.jobRootDir, "durable-handoffs") };
  for (const [key, expected] of Object.entries(fixedPaths)) {
    const supplied = config[key as keyof typeof fixedPaths];
    if (supplied !== undefined && supplied !== expected) throw new Error("codex_goal_storage_layout_invalid");
  }
  const fixedEnv = { SUBSCRIPTION_RUNTIME_JOB_ROOT: config.jobRootDir, SUBSCRIPTION_RUNTIME_TMPDIR: tmp,
    HOME: home, TMPDIR: join(tmp, "agent"), TMP: join(tmp, "agent"), TEMP: join(tmp, "agent") };
  for (const [key, expected] of Object.entries(fixedEnv)) {
    const supplied = config.sourceEnv?.[key];
    if (supplied !== undefined && supplied !== expected) throw new Error("codex_goal_storage_layout_invalid");
  }
  const copy = structuredClone({ ...config, ...fixedPaths, sourceEnv: { ...(config.sourceEnv ?? process.env), ...fixedEnv } });
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}

/** Called before egress/provider admission and before writable runner setup.
 * No production native lifetime authority is implemented by this checkpoint. */
export async function withCodexGoalStorage<T>(config: CodexGoalRunConfig,
  port: JobStorageAdmissionPort | undefined,
  effect: (lease?: JobStorageWriteLease) => Promise<T>): Promise<T> {
  assertCodexSessionHomeProfile(config.sessionHomeProfile);
  const storage = config.storage;
  if (!storage) {
    if (config.sessionHomeProfile !== undefined) throw new Error("codex_goal_storage_intent_required");
    return effect();
  }
  assertJobStorageIntent(storage.intent);
  const profile = config.sessionHomeProfile;
  if (!profile || (storage.intent.kind === JobStorageIntentKind.NoResume
    ? profile.kind !== CodexSessionHomeProfileKind.OneShot
    : profile.kind !== CodexSessionHomeProfileKind.Continuation || profile.sessionId !== storage.intent.sessionId)) {
    throw new Error("codex_goal_storage_profile_binding_invalid");
  }
  // The existing OneShot materializer deletes home unconditionally on dispose.
  // Neither a caller flag nor a native pin can qualify A2 disposal here.
  if (profile.kind === CodexSessionHomeProfileKind.OneShot) throw new JobStorageCapabilityUnavailableError(JobStorageUnavailableCapability.OneShotDisposal);
  const sessionId = profile.sessionId;
  if (!port) throw new JobStorageCapabilityUnavailableError(JobStorageUnavailableCapability.NativeLifetime);
  const layout = Object.freeze({ jobRoot: config.jobRootDir, workspace: config.workspacePath,
    state: config.stateRootDir ?? join(config.jobRootDir, "state"),
    home: config.runtimeHomeRootDir ?? join(config.jobRootDir, "home"), tmp: join(config.jobRootDir, "tmp") });
  // New adapters have one admitted layout; legacy overrides remain unchanged.
  if (layout.state !== join(layout.jobRoot, "state") || config.runtimeHomeRootDir !== layout.home ||
      layout.home !== join(layout.jobRoot, "home")) throw new Error("codex_goal_storage_layout_invalid");
  const request = Object.freeze({ jobId: config.jobId ?? config.taskId,
    generationId: storage.generationId, intent: Object.freeze({ ...storage.intent }), layout,
    taskId: config.taskId, attemptId: randomUUID(), producerId: JobStorageProducer.CodexGoalRunner,
    providerBindingSha256: createHash("sha256").update(JSON.stringify({
      backend: config.modelBackend ?? CodexModelBackend.OpenAiChatGpt, engine: config.executionEngine ?? "app-server-goal",
      accounts: config.accounts.map(account => account.name), profile,
    })).digest("hex"),
  });
  if (![request.jobId, request.taskId, request.generationId].every(value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) ||
      Object.values(layout).some(path => !isAbsolute(path) || resolve(path) !== path || path === "/")) {
    throw new Error("codex_goal_storage_request_invalid");
  }
  return port.withAdmittedLifetime(request, async lease => {
    const receipt = lease.receipt;
    assertJobStorageIdentity(receipt);
    if (receipt.schemaVersion !== 1 || receipt.jobId !== request.jobId || receipt.generationId !== request.generationId ||
        receipt.taskId !== request.taskId || receipt.attemptId !== request.attemptId || receipt.producerId !== request.producerId ||
        receipt.providerBindingSha256 !== request.providerBindingSha256 ||
        receipt.intent.kind !== request.intent.kind || receipt.intent.kind !== JobStorageIntentKind.Continuation ||
        receipt.intent.sessionId !== sessionId ||
        Object.entries(layout).some(([key, value]) => receipt.layout[key as keyof typeof layout] !== value) ||
        [receipt.machineId, receipt.filesystemUuid, receipt.device, receipt.mountSource, receipt.fsRoot, receipt.namespaceId, receipt.pinId]
          .some(value => typeof value !== "string" || !value)) throw new Error("codex_goal_storage_receipt_binding_invalid");
    const boundLease: JobStorageWriteLease = Object.freeze({ receipt: Object.freeze({ ...receipt,
      intent: Object.freeze({ ...receipt.intent }), layout: Object.freeze({ ...receipt.layout }) }),
      assertCurrent: () => lease.assertCurrent(), observeRunnerTerminal: () => lease.observeRunnerTerminal() });
    boundLease.assertCurrent();
    try { return await effect(boundLease); }
    finally {
      // Terminal execution is at most RESUMABLE. Native lifetime retention/drain
      // remains owned by the port even when result publication or disposal fails.
      await lease.observeRunnerTerminal();
    }
  });
}

/** Guard the actual checkpoint writer and scratch bootstrap after awaited reads.
 * Point checks complement the trusted port's held shared generation authority;
 * they are not a native fence or lifetime implementation. */
export async function withCodexGoalCheckpointWriter<T>(config: CodexGoalRunConfig,
  deps: CodexGoalRunDeps, lease: JobStorageWriteLease | undefined,
  effect: (baseCommit: string | undefined) => Promise<T>): Promise<T> {
  const baseCommit = await readLocalGitHeadCommit(config.workspacePath);
  lease?.assertCurrent();
  const checkpointRootExists = await lstat(join(config.jobRootDir, "turn-checkpoints"))
    .then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
  lease?.assertCurrent();
  if ((config.checkpointRequired || checkpointRootExists) &&
    !config.checkpointPublisherSocketPath && !deps.checkpointPublisher) throw new Error("checkpoint_publisher_required");
  if (config.checkpointPublisherSocketPath || deps.checkpointPublisher) {
    if (!baseCommit) throw new Error("checkpoint_initial_base_required");
    await assertCodexGoalTurnCheckpointHistory({ jobId: config.jobId ?? config.taskId,
      taskId: config.taskId, jobRootDir: config.jobRootDir, initialBaseCommit: baseCommit });
  }
  lease?.assertCurrent();
  return new LocalTerminalCheckpointAdmission(config.jobRootDir).withWriter(async () => {
    lease?.assertCurrent();
    await prepareHostScratchTemp(config.jobRootDir, config.sourceEnv ?? process.env);
    lease?.assertCurrent();
    return effect(baseCommit);
  });
}
