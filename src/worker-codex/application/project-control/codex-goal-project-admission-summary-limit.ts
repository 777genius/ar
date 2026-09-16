import type { ConsumedOutputLedger } from "@vioxen/subscription-runtime/worker-core";

import type { CodexGoalJobSummary } from "../../codex-goal-jobs";

export function limitCodexProjectSummariesForInspection(
  summaries: readonly CodexGoalJobSummary[],
  consumedOutput: ConsumedOutputLedger,
): readonly CodexGoalJobSummary[] {
  const max = projectAdmissionMaxJobSummaries();
  if (max <= 0 || summaries.length <= max) return summaries;
  const limited = [...summaries]
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(-max);
  const includedJobIds = new Set(limited.map((summary) => summary.jobId));
  const retentionSafetySummaries = summaries.filter((summary) =>
    !includedJobIds.has(summary.jobId) &&
    consumedOutput.byJobId.get(summary.jobId)?.retentionEvidenceMissing === true
  );
  return [...retentionSafetySummaries, ...limited];
}

function projectAdmissionMaxJobSummaries(): number {
  const raw = Number(
    process.env.SUBSCRIPTION_RUNTIME_PROJECT_ADMISSION_MAX_JOB_SUMMARIES ?? "0",
  );
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}
