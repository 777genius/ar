import type { CodexGoalJobManifest } from "./codex-goal-jobs";
import type { CodexGoalLaunchInput } from "./codex-goal-ops";
import { codexGoalAccountStatusPayload } from "./application/codex-goal-worker-control";
import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";
import { RunAccountCapacityStatus } from "@vioxen/subscription-runtime/worker-core";

type JsonObject = Readonly<Record<string, unknown>>;

export async function codexGoalAccountCapacityFacts(input: {
  readonly manifest: CodexGoalJobManifest;
  readonly loadLaunch: (
    manifest: CodexGoalJobManifest,
  ) => Promise<CodexGoalLaunchInput>;
}): Promise<JsonObject> {
  try {
    const launch = await input.loadLaunch(input.manifest);
    // OAuth pool diagnostics do not describe the shared MiMo Token Plan.
    // No quota probe or credential inspection is performed by these facts.
    if (launch.config.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan) {
      return {
        ok: true,
        modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
        capacityAware: false,
        quotaAvailability: RunAccountCapacityStatus.Unknown,
        reason: "quota_endpoint_unavailable",
      };
    }
    const payload = await codexGoalAccountStatusPayload(launch, {
      liveCheck: false,
    });
    const capacityBlockedAccounts = payload.accounts.filter((slot) =>
      slot.capacityAvailability && slot.capacityAvailability !== "available"
    );
    return {
      ok: true,
      capacityAware: payload.capacityAware,
      summary: payload.summary,
      capacityBlockedAccounts: capacityBlockedAccounts.map((slot) => ({
        name: slot.name,
        availability: slot.capacityAvailability,
        reason: slot.capacityReason,
        cooldownUntil: slot.capacityCooldownUntil,
      })),
      availableDedupedAccountNames: payload.availableDedupedAccountNames,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "account_capacity_facts_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
