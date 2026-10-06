import type { RuntimeEvent } from "../domain/types";
import type { RuntimeDeps } from "../ports";

/** Normalized event data only; the runtime retains actual observability dispatch. */
export function buildRuntimeEvent(
  deps: RuntimeDeps,
  name: string,
  runId: string | undefined,
  metadata: Readonly<Record<string, string>>,
  durationMs?: number,
): RuntimeEvent {
  return {
    name,
    providerId: deps.sessionDriver.providerId,
    agentId: deps.agentDriver.agentId,
    storeId: deps.sessionStore?.storeId ?? "none",
    metadata,
    ...(runId === undefined ? {} : { runId }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
