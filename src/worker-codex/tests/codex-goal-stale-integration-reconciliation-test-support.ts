import {
  CheckRunStatus,
  CheckWorkspaceIntegrityDisposition,
  IntegrationAttemptStatus,
  SecretScanStatus,
  markChecksRunning,
  markCommitCreated,
  markWorkerOutputApplied,
  recordCheckRuns,
  type IntegrationAttempt,
} from "@vioxen/subscription-runtime/worker-core";

export function historicalAttemptAtStatus(
  opened: IntegrationAttempt,
  status: IntegrationAttemptStatus,
): IntegrationAttempt {
  if (status === IntegrationAttemptStatus.Opened) return opened;
  let attempt = markWorkerOutputApplied(opened, {
    changedFiles: opened.workerOutput.changedFiles,
    now: "2026-08-08T00:00:01.000Z",
  });
  if (status === IntegrationAttemptStatus.Applied) return attempt;
  attempt = markChecksRunning(attempt, "2026-08-08T00:00:02.000Z");
  if (status === IntegrationAttemptStatus.ChecksRunning) return attempt;
  attempt = recordCheckRuns(attempt, {
    checkRuns: status === IntegrationAttemptStatus.ChecksFailed
      ? [failedCheckRun()]
      : [passedCheckRun()],
    now: "2026-08-08T00:00:03.000Z",
  });
  if (status === IntegrationAttemptStatus.ChecksFailed ||
    status === IntegrationAttemptStatus.ChecksPassed) return attempt;
  if (status === IntegrationAttemptStatus.CommitCreated) {
    return markCommitCreated(attempt, {
      commitCandidate: commitCandidate(),
      now: "2026-08-08T00:00:04.000Z",
    });
  }
  throw new Error(`unsupported historical status ${status}`);
}

export function passedCheckRun() {
  return {
    checkId: "focused",
    command: ["npm", "test"],
    status: CheckRunStatus.Passed,
    startedAt: "2026-08-08T00:00:02.000Z",
    completedAt: "2026-08-08T00:00:03.000Z",
    exitCode: 0,
    workspaceIntegrity: CheckWorkspaceIntegrityDisposition.Unchanged,
  } as const;
}

export function failedCheckRun() {
  return {
    ...passedCheckRun(),
    status: CheckRunStatus.Failed,
    exitCode: 1,
  } as const;
}

export function commitCandidate() {
  return {
    commitSha: "e".repeat(40),
    message: "fix: historical candidate",
    files: ["value.txt"],
    secretScanStatus: SecretScanStatus.Passed,
    createdAt: "2026-08-08T00:00:04.000Z",
  } as const;
}
