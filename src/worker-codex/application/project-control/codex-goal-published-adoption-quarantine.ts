import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { resolveLegacyAttemptQuarantine } from
  "./codex-goal-legacy-attempt-quarantine-resolution";

export async function assertPublishedIntegrationAttemptMutable(input: {
  readonly controllerJobRootDir: string;
  readonly scope: ProjectAccessScope;
  readonly attemptId: string;
  readonly readQuarantine?: (input: {
    readonly controllerJobRootDir: string;
    readonly scope: ProjectAccessScope;
  }) => Promise<{ readonly attemptIds: ReadonlySet<string> }>;
}): Promise<void> {
  const quarantine = await (input.readQuarantine ?? resolveLegacyAttemptQuarantine)({
    controllerJobRootDir: input.controllerJobRootDir,
    scope: input.scope,
  });
  if (quarantine.attemptIds.has(input.attemptId)) {
    throw new Error("project_integration_attempt_quarantined");
  }
}
