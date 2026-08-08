import {
  openIntegrationAttempt,
  type IntegrationAttempt,
  type OpenIntegrationAttemptInput,
} from "../domain/integration-attempt";
import { IntegrationAuditEventType } from "../domain/integration-events";
import {
  assertCanOpenIntegrationAttempt,
  type ProjectIntegrationPolicy,
} from "../domain/integration-policy";
import {
  nowIso,
  recordIntegrationAudit,
  runIntegrationTransaction,
  type IntegrationUseCaseDeps,
} from "./common";

export type OpenProjectIntegrationAttemptInput =
  Omit<OpenIntegrationAttemptInput, "now"> & {
    readonly policy: ProjectIntegrationPolicy;
  };

export async function openProjectIntegrationAttempt(
  deps: IntegrationUseCaseDeps,
  input: OpenProjectIntegrationAttemptInput,
): Promise<IntegrationAttempt> {
  return await runIntegrationTransaction(deps, input.attemptId, async () =>
    await openProjectIntegrationAttemptTransaction(deps, input)
  );
}

async function openProjectIntegrationAttemptTransaction(
  deps: IntegrationUseCaseDeps,
  input: OpenProjectIntegrationAttemptInput,
): Promise<IntegrationAttempt> {
  const now = nowIso(deps.clock);
  const attemptInput = { ...input, now };
  assertCanOpenIntegrationAttempt(input.policy, attemptInput);
  const attempt = openIntegrationAttempt(attemptInput);
  await deps.store.create(attempt);
  await recordIntegrationAudit(deps, attempt, {
    type: IntegrationAuditEventType.AttemptOpened,
    occurredAt: now,
    files: attempt.expectedFiles,
  });
  return attempt;
}
