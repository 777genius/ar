import { durablePublishJsonFile } from
  "../../project-control-operation-file-store";
import {
  claimLegacyAttemptQuarantineSingleUse,
  resolveLegacyAttemptQuarantineSingleUsePlan,
} from "./codex-goal-legacy-attempt-quarantine-single-use";

export async function publishLegacyAttemptQuarantinePlanFirst<T>(input: {
  readonly controllerJobRootDir: string;
  readonly planSha256: string;
  readonly planPath: string;
  readonly plan: unknown;
  readonly epochPlanSha256s: readonly string[];
  readonly crashAfterPlanPublication?: boolean;
  readonly load: () => Promise<T>;
}): Promise<T> {
  const claimed = await resolveLegacyAttemptQuarantineSingleUsePlan({
    controllerJobRootDir: input.controllerJobRootDir,
    epochPlanSha256s: input.epochPlanSha256s,
  });
  if (claimed && claimed !== input.planSha256) {
    throw new Error("legacy_attempt_quarantine_single_use_conflict");
  }
  await durablePublishJsonFile({ path: input.planPath, value: input.plan });
  if (input.crashAfterPlanPublication) {
    throw new Error("legacy_attempt_quarantine_simulated_plan_crash");
  }
  return await completeLegacyAttemptQuarantinePlanMarker({
    controllerJobRootDir: input.controllerJobRootDir,
    planSha256: input.planSha256,
    epochPlanSha256s: input.epochPlanSha256s,
    load: input.load,
  });
}

export async function completeLegacyAttemptQuarantinePlanMarker<T>(input: {
  readonly controllerJobRootDir: string;
  readonly planSha256: string;
  readonly epochPlanSha256s: readonly string[];
  readonly load: () => Promise<T>;
}): Promise<T> {
  await claimLegacyAttemptQuarantineSingleUse({
    controllerJobRootDir: input.controllerJobRootDir,
    planSha256: input.planSha256,
    epochPlanSha256s: input.epochPlanSha256s,
  });
  return await input.load();
}
