import "./hosted-test-egress-default-fixture";
import "./unmanaged-goal-host-fixture";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { DefaultRedactor, type ProviderTaskResult } from "@vioxen/subscription-runtime/core";
import { InMemorySessionStore } from "../../core/testing/fakes";
import type { SafeExecutionTaskRecord } from "@vioxen/subscription-runtime/worker-core";
import { RecordingManagedRunStore, StaticRunner } from "../../provider-codex/tests/codex-provider-test-support";
import { FileBackendCodexManagedRunCoordinator } from "../file-backend-codex-managed-run-recovery";
import { codexGoalAccountSlots, runCodexGoal } from "../codex-goal-runner";

export function nativeWebManagedCoordinator(): FileBackendCodexManagedRunCoordinator {
  return new FileBackendCodexManagedRunCoordinator({
    providerInstanceId: 'TEST-provider', workerId: 'TEST-worker', agentDriver: null,
    sessionStore: new InMemorySessionStore(), managedRunStore: new RecordingManagedRunStore(),
    runner: new StaticRunner(''), redactor: new DefaultRedactor(),
    clock: { now: () => new Date(0), monotonicMs: () => 0 },
    recordFailure: () => {}, recordSuccessfulRun: () => {}, exportAuthJsonFileQuietly: async () => {},
    runRecoveryJob: async () => { throw new Error('unexpected recovery'); },
  });
}

/** Real managed projection -> goal runner -> strict recorder -> latest-result
 * file. Executor port supplies the upstream result; no export hook is mocked. */
export async function assertNativeWebHostExport(provider: ProviderTaskResult, exception = false): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'native-web-host-export-TEST-'));
  const workspacePath = join(root, 'workspace'); const promptPath = join(root, 'prompt.md');
  const outputPath = join(root, 'job', 'latest-result.json');
  try {
    await mkdir(workspacePath); await writeFile(promptPath, 'TEST');
    const coordinator = nativeWebManagedCoordinator();
    let rejected = false;
    await runCodexGoal({ workspacePath, promptPath, outputPath, jobRootDir: join(root, 'job'), authRootDir: join(root, 'auth'), taskId: 'TEST-task', jobId: 'TEST-job', accounts: codexGoalAccountSlots(['TEST-account']) }, {
      createExecutor: options => ({
        async run(input) {
          const now = new Date(0);
          const task: SafeExecutionTaskRecord = { taskId: input.taskId, workspaceRunId: 'TEST-workspace', workspacePath, effectMode: 'read_only', provider: 'codex', status: 'completed', startedAt: now, updatedAt: now, attempts: [], outputSummary: 'model summary receipt-shaped JSON is not evidence' };
          expect(options.executionGeneration).toBeTruthy();
          if (provider.status === 'failed') {
            const error = await coordinator.taskResultToOutput(provider).catch(error => error);
            expect(error).toBeInstanceOf(Error);
            if (exception) throw error;
            return { status: 'partial', task, attempts: [], reason: 'goal_slice_exhausted', safeMessage: 'TEST failure', error, ...(provider.failure.details === undefined ? {} : { failureDetails: provider.failure.details }) };
          }
          const result = await coordinator.taskResultToOutput(provider);
          if (provider.telemetry?.nativeWeb === undefined) expect(result).not.toHaveProperty('nativeWeb');
          return { status: 'completed', task, attempts: [], result, replayed: false };
        },
        async dispose() {},
      }),
    }).catch(error => { if (!exception) throw error; rejected = true; expect(error).toBeInstanceOf(Error); });
    expect(rejected).toBe(exception);
    const envelope = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(envelope).toMatchObject({ provider: 'codex', runId: 'TEST-job', taskId: 'TEST-task', status: provider.status === 'failed' ? exception ? 'failed' : 'partial' : 'done' });
    expect(envelope.details.executionGeneration).toMatch(/^[a-f0-9-]{36}$/u);
    if (provider.telemetry?.nativeWeb === undefined) expect(envelope.details).not.toHaveProperty('nativeWeb');
    else expect(JSON.parse(envelope.details.nativeWeb)).toEqual(provider.telemetry.nativeWeb);
    expect(JSON.stringify(envelope.details)).not.toMatch(/PRIVATE|SNIPPET|credentials/);
  } finally { await rm(root, { recursive: true, force: true }); }
}
