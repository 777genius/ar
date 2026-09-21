export enum CodexSessionHomeProfileKind {
  OneShot = "one-shot",
  Continuation = "continuation",
}

export type CodexSessionHomeProfile =
  | {
      readonly kind: CodexSessionHomeProfileKind.OneShot;
      readonly sessionId?: never;
    }
  | {
      readonly kind: CodexSessionHomeProfileKind.Continuation;
      readonly sessionId: string;
    };

export function assertCodexSessionHomeProfile(
  profile: CodexSessionHomeProfile | undefined,
): void {
  if (profile === undefined) return;
  if (profile.kind === CodexSessionHomeProfileKind.OneShot) {
    if ("sessionId" in profile) {
      throw new Error("file_backend_codex_one_shot_session_id_conflict");
    }
    return;
  }
  if (profile.kind === CodexSessionHomeProfileKind.Continuation) {
    if (typeof profile.sessionId !== "string" || !profile.sessionId.trim()) {
      throw new Error("file_backend_codex_continuation_session_id_required");
    }
    return;
  }
  throw new Error("file_backend_codex_session_home_profile_invalid");
}

export function codexSessionHomeCacheKey(input: {
  readonly profile: CodexSessionHomeProfile | undefined;
  readonly providerInstanceId: string;
  readonly workerId: string;
}): string {
  if (input.profile === undefined) {
    return `codex:${input.providerInstanceId}:${input.workerId}`;
  }
  const identity = input.profile.kind === CodexSessionHomeProfileKind.Continuation
    ? input.profile.sessionId.trim()
    : input.workerId;
  return `codex:profile:v1:${input.profile.kind}:${JSON.stringify([
    input.providerInstanceId,
    identity,
  ])}`;
}

export function codexSessionHomePreservedOnDispose(
  profile: CodexSessionHomeProfile | undefined,
): boolean {
  return profile?.kind !== CodexSessionHomeProfileKind.OneShot;
}
