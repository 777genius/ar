import type { WorkerControlContinuationBatch } from "../../control";
import type { AttemptFailureReason } from "../domain/safe-execution-policy";
import type {
  ContinuationPacket,
  TaskRunId,
  WorkspaceSnapshot,
} from "../domain/safe-execution-task";
import type { ContinuationPacketBuilder } from "../ports/safe-execution-ports";

const MAX_RENDERED_DIFF_STAT_CHARACTERS = 8_000;
const MAX_RENDERED_DIFF_STAT_LINES = 100;
const DIFF_STAT_OMISSION_MARKER =
  "[diff stat truncated: additional content omitted]";

function renderBoundedDiffStat(diffStat: string): string {
  const lines = diffStat.split(/\r\n|\r|\n/);
  if (
    diffStat.length <= MAX_RENDERED_DIFF_STAT_CHARACTERS &&
    lines.length <= MAX_RENDERED_DIFF_STAT_LINES
  ) {
    return diffStat;
  }

  const contentCharacterLimit =
    MAX_RENDERED_DIFF_STAT_CHARACTERS - DIFF_STAT_OMISSION_MARKER.length - 1;
  const renderedLines: string[] = [];
  let renderedCharacters = 0;
  for (const line of lines.slice(0, MAX_RENDERED_DIFF_STAT_LINES - 1)) {
    const separatorLength = renderedLines.length === 0 ? 0 : 1;
    if (renderedCharacters + separatorLength + line.length > contentCharacterLimit) {
      if (renderedLines.length === 0) {
        renderedLines.push(line.slice(0, contentCharacterLimit));
      }
      break;
    }
    renderedLines.push(line);
    renderedCharacters += separatorLength + line.length;
  }
  return [...renderedLines, DIFF_STAT_OMISSION_MARKER].join("\n");
}

export class DefaultContinuationPacketBuilder
  implements ContinuationPacketBuilder
{
  build(input: {
    readonly taskId: TaskRunId;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly workspacePath: string;
    readonly originalPrompt: string;
    readonly previousFailureReason: AttemptFailureReason;
    readonly snapshot: WorkspaceSnapshot;
    readonly previousOutputSummary?: string;
    readonly controlBatch?: WorkerControlContinuationBatch;
  }): ContinuationPacket {
    const changedFiles = input.snapshot.changedFiles;
    const filesText =
      changedFiles.length === 0
        ? "No changed files were detected."
        : changedFiles.slice(0, 80).map((file) => `- ${file}`).join("\n");
    const previousOutputText = input.previousOutputSummary
      ? `\nPrevious output summary:\n${input.previousOutputSummary}\n`
      : "";
    const diffStatText = input.snapshot.diffStat
      ? `\nDiff stat:\n${renderBoundedDiffStat(input.snapshot.diffStat)}\n`
      : "";
    const controlText = input.controlBatch?.message
      ? `\n${input.controlBatch.message}\n`
      : "";
    const message = [
      "Continue the same task in the current workspace.",
      "",
      `Task id: ${input.taskId}`,
      `Attempt: ${input.attemptNumber}`,
      `Provider: ${input.provider}`,
      `Workspace: ${input.workspacePath}`,
      `Previous attempt stopped because: ${input.previousFailureReason}`,
      "",
      "Original task:",
      input.originalPrompt,
      previousOutputText.trimEnd(),
      "",
      "Current workspace summary:",
      input.snapshot.summary,
      diffStatText.trimEnd(),
      controlText.trimEnd(),
      "",
      "Changed files:",
      filesText,
      "",
      "Important instruction:",
      "Do not restart from scratch. Inspect the current workspace state and continue from the existing partial changes.",
    ]
      .filter((line) => line !== "")
      .join("\n");

    return {
      taskId: input.taskId,
      attemptNumber: input.attemptNumber,
      provider: input.provider,
      workspacePath: input.workspacePath,
      originalPrompt: input.originalPrompt,
      previousFailureReason: input.previousFailureReason,
      changedFiles,
      workspaceSummary: input.snapshot.summary,
      ...(input.previousOutputSummary === undefined
        ? {}
        : { previousOutputSummary: input.previousOutputSummary }),
      ...(input.controlBatch?.signalIds.length
        ? { workerControlSignalIds: input.controlBatch.signalIds }
        : {}),
      message,
    };
  }
}
