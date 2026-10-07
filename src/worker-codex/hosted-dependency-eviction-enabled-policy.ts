import { decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
export function readHostedDependencyEvictionEnabled(): boolean {
  const bytes = readHostedPrivateBytes("/var/lib/subscription-runtime-host-policy/dependency-retention-policy.json", 4096);
  if (!bytes) return false;
  const value = decodeHostedActivationBytes(bytes) as Record<string, unknown>;
  if (!value || Object.keys(value).sort().join(",") !== "evictionEnabled,managedReadyRequired,version" ||
      value.version !== 1 || value.managedReadyRequired !== true || typeof value.evictionEnabled !== "boolean") fail();
  return value.evictionEnabled;
}
function fail(): never { throw new Error("dependency_transaction_unresolved"); }
