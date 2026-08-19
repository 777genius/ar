import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  ConsumedOutputLedgerEpochPlan,
} from "@vioxen/subscription-runtime/worker-core";
import {
  ledgerEpochOrphanWorkspaceBindingMatches,
  revalidateLedgerEpochOrphanWorkspaceBinding,
} from "./codex-goal-ledger-epoch-orphan-quarantine";

const ORPHAN_BINDING_REVALIDATION_CONCURRENCY = 8;

export async function assertOrphanWorkspaceBindingsUnchanged(
  plan: Pick<ConsumedOutputLedgerEpochPlan, "orphanWorkspaceBindings" | "deniedRoots">,
): Promise<void> {
  const results = new Array<Awaited<ReturnType<
    typeof revalidateLedgerEpochOrphanWorkspaceBinding
  >>>(plan.orphanWorkspaceBindings.length);
  let nextIndex = 0;
  const workers = Array.from({
    length: Math.min(
      ORPHAN_BINDING_REVALIDATION_CONCURRENCY,
      plan.orphanWorkspaceBindings.length,
    ),
  }, async () => {
    while (nextIndex < plan.orphanWorkspaceBindings.length) {
      const index = nextIndex++;
      const binding = plan.orphanWorkspaceBindings[index];
      if (!binding) throw new Error("ledger_epoch_binding_index_invalid");
      results[index] = await revalidateLedgerEpochOrphanWorkspaceBinding({
        binding,
        deniedRoots: plan.deniedRoots,
      });
    }
  });
  await Promise.all(workers);
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!result) throw new Error("ledger_epoch_binding_result_invalid");
    if (!result.matches) {
      throw new LedgerEpochOrphanWorkspaceBindingRevalidationError({
        category: result.category,
        index,
        path: result.path,
      });
    }
  }
}

export class LedgerEpochOrphanWorkspaceBindingRevalidationError extends Error {
  readonly category: "mismatch" | "observation_error";
  readonly bindingIndex: number;
  readonly bindingPath: string;

  constructor(input: {
    readonly category: "mismatch" | "observation_error";
    readonly index: number;
    readonly path: string;
  }) {
    super(input.category === "mismatch"
      ? "ledger_epoch_orphan_workspace_binding_drift"
      : "ledger_epoch_orphan_workspace_binding_observation_error");
    this.name = "LedgerEpochOrphanWorkspaceBindingRevalidationError";
    this.category = input.category;
    this.bindingIndex = input.index;
    this.bindingPath = input.path;
  }
}

export async function mergeInheritedOrphanWorkspaceBindings(input: {
  readonly previous: readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly current: readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[];
  readonly deniedRoots: readonly string[];
}): Promise<readonly ConsumedOutputLedgerEpochOrphanWorkspaceBinding[]> {
  const bindings = new Map<string, ConsumedOutputLedgerEpochOrphanWorkspaceBinding>();
  for (const binding of input.previous) {
    if (binding.state !== "quarantined" ||
      !await ledgerEpochOrphanWorkspaceBindingMatches({
        binding,
        deniedRoots: input.deniedRoots,
      })) {
      throw new Error("ledger_epoch_inherited_orphan_workspace_binding_drift");
    }
    bindings.set(resolve(binding.declaredPath), binding);
  }
  for (const binding of input.current) {
    const key = resolve(binding.declaredPath);
    const inherited = bindings.get(key);
    if (inherited && JSON.stringify(inherited) !== JSON.stringify(binding)) {
      throw new Error("ledger_epoch_inherited_orphan_workspace_binding_drift");
    }
    bindings.set(key, binding);
  }
  return [...bindings.values()].sort((left, right) =>
    left.declaredPath.localeCompare(right.declaredPath)
  );
}

export function rememberQuarantinedOrphanCandidate(
  value: unknown,
  currentJobIds: ReadonlySet<string>,
  target: Set<string>,
): void {
  if (!isRecord(value) || typeof value.jobId !== "string" ||
    currentJobIds.has(value.jobId) || !isRecord(value.backup) ||
    typeof value.backup.workspace !== "string"
  ) return;
  target.add(resolve(value.backup.workspace));
}

export function orphanArtifactName(
  binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
): string {
  return `${createHash("sha256").update(binding.declaredPath).digest("hex")}.json`;
}

export function orphanWorkspaceArtifact(
  binding: ConsumedOutputLedgerEpochOrphanWorkspaceBinding,
  planSha256: string,
) {
  return {
    schemaVersion: 1,
    status: "quarantined_orphan_legacy_workspace",
    planSha256,
    binding,
    valid: false,
    repaired: false,
    sourceWorkspaceUntouched: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
