import {
  AccountAvailability, AuthSessionStatus,
  type CodexAccountObserver,
} from "@vioxen/agent-account-observability";
import { materializeCodexEffectiveSeed } from "./codex-effective-seed";
import { codexAccountCapacityStore } from "./application/codex-account-capacity-store";
import { codexLiveQuotaCapacitySnapshot } from "./application/codex-live-quota-capacity";
import { codexSessionCapacityAccountId } from "./codex-session-capacity-identity";
import { classifyCodexRuntimeFailure } from "@vioxen/subscription-runtime/provider-codex";
import { WorkerAccountCapacitySignalScope } from "@vioxen/subscription-runtime/worker-core";

/** Adapter for the existing operator quota consumer. The login source owns
 * authorization; a private probe home owns its temporary refresh; the same
 * encrypted publication contract owns successful probe rotation afterwards.
 */
export async function observeCodexEffectiveQuota(input: {
  readonly observer: Pick<CodexAccountObserver, "observe">;
  readonly observation: Parameters<CodexAccountObserver["observe"]>[0];
  readonly authRootDir: string;
  readonly sourcePath: string;
}) {
  const { account, now } = input.observation;
  const store = codexAccountCapacityStore(input.authRootDir, {
    authJsonPaths: { [account.slotId]: input.sourcePath },
  });
  const capacity = store.read({ accountId: account.slotId, now });
  if (capacity?.reason === "provider_session_invalid") throw new Error("provider_session_invalid");
  if (capacity?.availability === "quota_exhausted") throw new Error("codex_account_quota_held");
  if (capacity && capacity.availability !== "available") throw new Error("codex_account_capacity_held");

  const effective = await materializeCodexEffectiveSeed(input.sourcePath);
  // Capture the source before launching: a delayed revoked probe must not
  // invalidate an independent owner replacement written during the probe.
  const captured = codexAccountCapacityStore(input.authRootDir, {
    authJsonByAlias: { [account.slotId]: effective.seed.source },
  });
  let successful = false;
  try {
    const observation = await input.observer.observe({
      ...input.observation,
      account: { ...account, authHome: effective.home, authJsonPath: effective.authJsonPath },
    });
    const invalid = observation.auth.status === AuthSessionStatus.ReloginRequired ||
      observation.evidence.some(evidence =>
        classifyCodexRuntimeFailure(String(evidence.details?.error ?? "")) === "provider_session_invalid");
    if (invalid) {
      for (const bytes of [effective.seed.source, effective.seed.bytes]) {
        const sessionId = codexSessionCapacityAccountId(JSON.parse(bytes));
        if (!sessionId) continue;
        captured.observe({ accountId: account.slotId, observedAt: now,
          scope: WorkerAccountCapacitySignalScope.AccountWide,
          capacity: { availability: "disabled", reason: "provider_session_invalid",
            details: { capacitySessionId: sessionId } },
        });
      }
      throw new Error("provider_session_invalid");
    }
    const limited = codexLiveQuotaCapacitySnapshot(observation);
    if (limited) captured.observe({ accountId: account.slotId, observedAt: now,
      scope: WorkerAccountCapacitySignalScope.AccountWide, capacity: limited });
    successful = observation.quota !== null &&
      (observation.decision.availability === AccountAvailability.Available ||
       observation.decision.availability === AccountAvailability.Limited);
    return observation;
  } finally {
    await effective.finish(successful);
  }
}
