import type {
  IntegrationAttempt,
} from "../domain/integration-attempt";
import type { IntegrationAuditEvent } from "../domain/integration-events";

export interface IntegrationAttemptStorePort {
  withActivityLease?<T>(owner: string, effect: () => Promise<T>): Promise<T>;
  create(attempt: IntegrationAttempt): Promise<void> | void;
  get(attemptId: string): Promise<IntegrationAttempt | null> | IntegrationAttempt | null;
  update(attempt: IntegrationAttempt): Promise<void> | void;
  appendEvent(
    attemptId: string,
    event: IntegrationAuditEvent,
  ): Promise<void> | void;
  readEvents?(
    attemptId: string,
  ): Promise<readonly IntegrationAuditEvent[]> | readonly IntegrationAuditEvent[];
}
