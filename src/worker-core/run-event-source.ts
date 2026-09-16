import type { RunEventSource } from "./run-event-types";

/** Registry identifies the runtime within an outbox; host/workspace are observation metadata. */
export function runEventSourceKey(source: RunEventSource): string {
  return JSON.stringify([source.providerKind, source.registryRootDir ?? null]);
}

export function sameRunEventSource(left: RunEventSource | undefined, right: RunEventSource | undefined): boolean {
  return left === undefined || right === undefined ? left === right : runEventSourceKey(left) === runEventSourceKey(right);
}
