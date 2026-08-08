import {
  IntegrationError,
  IntegrationErrorReason,
} from "../domain/integration-errors";
import {
  IntegrationAuditEventType,
  type IntegrationAuditEvent,
} from "../domain/integration-events";
import type { IntegrationAttempt } from "../domain/integration-attempt";
import type {
  IntegrationAttemptStorePort,
} from "../ports/integration-attempt-store-port";
import type {
  IntegrationAuditPort,
} from "../ports/integration-audit-port";

export type IntegrationClock = {
  now(): Date;
};

export type IntegrationUseCaseDeps = {
  readonly store: IntegrationAttemptStorePort;
  readonly audit?: IntegrationAuditPort;
  readonly clock?: IntegrationClock;
};

export async function runIntegrationTransaction<T>(
  deps: IntegrationUseCaseDeps,
  attemptId: string,
  effect: () => Promise<T>,
): Promise<T> {
  return deps.store.withActivityLease
    ? await deps.store.withActivityLease(`integration-transaction:${attemptId}`, effect)
    : await effect();
}

export function nowIso(clock?: IntegrationClock): string {
  return (clock ?? { now: () => new Date() }).now().toISOString();
}

export async function loadIntegrationAttempt(
  store: IntegrationAttemptStorePort,
  attemptId: string,
): Promise<IntegrationAttempt> {
  const attempt = await store.get(attemptId);
  if (!attempt) {
    throw new IntegrationError({
      reason: IntegrationErrorReason.InvalidTransition,
      message: "integration_attempt_not_found",
      evidence: [attemptId],
    });
  }
  return attempt;
}

export async function recordIntegrationAudit(
  deps: IntegrationUseCaseDeps,
  attempt: IntegrationAttempt,
  input: {
    readonly type: IntegrationAuditEventType;
    readonly occurredAt: string;
    readonly safeReason?: string;
    readonly files?: readonly string[];
    readonly commitSha?: string;
  },
): Promise<void> {
  const event: IntegrationAuditEvent = {
    schemaVersion: 1,
    type: input.type,
    occurredAt: input.occurredAt,
    attemptId: attempt.attemptId,
    projectId: attempt.projectId,
    controllerJobId: attempt.controllerJobId,
    workerJobId: attempt.workerJobId,
    status: attempt.status,
    ...(input.safeReason ? { safeReason: input.safeReason } : {}),
    ...(input.files ? { files: input.files } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
  };
  await deps.store.appendEvent(attempt.attemptId, event);
  await deps.audit?.record(event);
}
