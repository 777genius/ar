/** Trusted Host callback. A completed provider turn is not released until it resolves. */
export type AppServerCompletedTurnCheckpoint = (input: {
  readonly runId: string;
  readonly workspacePath: string;
  readonly turnNumber: number;
}) => Promise<void>;

export class AppServerTurnCheckpointError extends Error {
  constructor(cause: unknown) {
    super("codex_turn_checkpoint_unprotected", { cause });
    this.name = "AppServerTurnCheckpointError";
  }
}
