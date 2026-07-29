export class CodexAppServerThreadForkError extends Error {
  readonly sourceThreadUnavailable: boolean;

  constructor(message: string) {
    super(`codex_app_server_thread_fork_failed:${message}`);
    this.name = "CodexAppServerThreadForkError";
    this.sourceThreadUnavailable = isSourceThreadUnavailableMessage(message);
  }
}

function isSourceThreadUnavailableMessage(message: string): boolean {
  const normalized = message.trim().replaceAll(/\s+/gu, " ");
  return (
    /\b(?:source|requested|specified) thread(?: (?:id )?(?:"[^"]+"|'[^']+'|[A-Za-z0-9._:-]+))? (?:was |is )?(?:not found|does not exist)\b/iu
      .test(normalized) ||
    /\bthread (?:id )?(?:"[^"]+"|'[^']+'|[A-Za-z0-9][A-Za-z0-9._:-]*) (?:was |is )?(?:not found|does not exist)\b/iu
      .test(normalized)
  );
}
