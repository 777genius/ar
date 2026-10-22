import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  RETAINED_NONQUALIFIED_BACKUP_PAYLOADS,
  RetainedNonqualifiedResourcePolicyId,
  type RetainedNonqualifiedResourceLimits,
} from "@vioxen/subscription-runtime/worker-core";
import type { LinuxMemoryAvailability } from "../../../worker-local/linux-memory-availability";
import { captureRetainedWorkspaceInventory, type RetainedWorkspaceInventory } from "./codex-goal-retained-nonqualified-inventory";
import { measureRetainedLifecycle, type RetainedLifecyclePaths } from "./codex-goal-retained-nonqualified-lifecycle";

export type RetainedPayloadName = typeof RETAINED_NONQUALIFIED_BACKUP_PAYLOADS[number];

/**
 * Copy-amplification multiplier of the first TEST threshold. This is a HYPOTHESIS about how many
 * times the permitted backup can be resident at once (source buffers, tar construction, custody
 * read chunks and concatenation, verification copies). It must be replaced by measured peaks from
 * the qualified TEST runs; it is not a proven safe factor and is not caller-selectable.
 */
export const RETAINED_MEMORY_COPY_MULTIPLIER = 8;
export const RETAINED_MEMORY_HEADROOM_BYTES = 256 * 1024 * 1024;
/** Margin added to every durable/scratch free-space requirement. */
export const RETAINED_CAPACITY_MARGIN_BYTES = 4 * 1024 * 1024;
/**
 * There is NO ambient memory reader. The live memory observation of the expanded policy is supplied only through the
 * explicit `read` port, and only the Host's retention operator role constructs one (after it authenticated the
 * installation, the finite operation window and the memory topology; see `retention-operation-host.ts`). A plain MCP
 * tool call, a permit, the environment or any caller value therefore cannot admit `expanded_v1`: without the port it
 * refuses here. The default policy never consults it. The topology mechanics live in
 * `worker-local/linux-memory-availability.ts`.
 */
const noMemoryAuthority = (): Promise<LinuxMemoryAvailability> =>
  Promise.reject(new Error("linux_memory_unknown:host_authority_not_installed"));

export const retainedMemoryRequirementBytes = (limits: RetainedNonqualifiedResourceLimits) =>
  RETAINED_MEMORY_COPY_MULTIPLIER * limits.backupBytes + RETAINED_MEMORY_HEADROOM_BYTES;

export type RetainedProcessMemory = {
  readonly rss: number; readonly heapUsed: number; readonly external: number; readonly arrayBuffers: number;
};

/** Phase sample for the TEST runner's peak table and for the preview output. */
export function sampleRetainedProcessMemory(): RetainedProcessMemory {
  const usage = process.memoryUsage();
  return { rss: usage.rss, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers };
}

export type RetainedMemoryObservation = {
  readonly requiredBytes: number;
  readonly hostAvailableBytes: number;
  readonly cgroupRemainingBytes: number | null;
  readonly effectiveBytes: number;
  readonly cgroupVersion: "v1" | "v2";
  readonly process: RetainedProcessMemory;
};

/**
 * Admission for the expanded policy only (the ordinary policy keeps its ordinary behaviour): the
 * effective allowance (MemAvailable, swap excluded, bounded by the remainder of every cgroup
 * ancestor, which already includes this process's RSS) must cover the conservative requirement.
 * Unknown limits or a parse failure refuse. This is a preflight, NOT a reservation: another
 * process can still consume memory afterwards, which is why TEST peaks, not this arithmetic,
 * qualify a multiplier.
 */
export async function assertRetainedMemoryAdmission(input: {
  readonly policy: RetainedNonqualifiedResourcePolicyId;
  readonly limits: RetainedNonqualifiedResourceLimits;
  readonly read?: () => Promise<LinuxMemoryAvailability>;
}): Promise<RetainedMemoryObservation | undefined> {
  if (input.policy === RetainedNonqualifiedResourcePolicyId.Default) return undefined;
  let availability: LinuxMemoryAvailability;
  try { availability = await (input.read ?? noMemoryAuthority)(); }
  catch (cause) {
    throw new Error(`retained_nonqualified_memory_unknown:${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const requiredBytes = retainedMemoryRequirementBytes(input.limits);
  if (!(availability.effectiveBytes >= requiredBytes)) throw new Error("retained_nonqualified_memory_insufficient");
  return {
    requiredBytes, hostAvailableBytes: availability.hostAvailableBytes,
    cgroupRemainingBytes: availability.cgroupRemainingBytes ?? null, effectiveBytes: availability.effectiveBytes,
    cgroupVersion: availability.cgroupVersion, process: sampleRetainedProcessMemory(),
  };
}

/** The complete backup must fit both the durable target and scratch; no guard is bypassed. */
export function assertRetainedNonqualifiedCapacity(capacity: {
  readonly requiredBytes: number; readonly durableFreeBytes: number; readonly scratchFreeBytes: number;
}) {
  if (!Number.isFinite(capacity.durableFreeBytes) || !Number.isFinite(capacity.scratchFreeBytes) ||
      capacity.durableFreeBytes < capacity.requiredBytes || capacity.scratchFreeBytes < capacity.requiredBytes) {
    throw new Error("retained_nonqualified_capacity_insufficient");
  }
  return capacity;
}

export const retainedScratchRoot = () => process.env.TMPDIR ?? tmpdir();

export async function retainedFreeBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

let heavyWorkTail: Promise<void> = Promise.resolve();
/**
 * Heavy producer and admission verification run one at a time inside the owning process, so two
 * simultaneous buffer sets cannot each spend the same observed memory budget. Other processes are
 * NOT coordinated: cross-process races remain a documented limitation of the preflight.
 */
export function serializeRetainedHeavyWork<T>(work: () => Promise<T>): Promise<T> {
  const run = heavyWorkTail.then(work, work);
  heavyWorkTail = run.then(() => undefined, () => undefined);
  return run;
}

export type RetainedBackupBudget = {
  /** Upper bound of each payload, from measured sizes (exact for the archives, policy cap for the patch). */
  readonly payloadBounds: Readonly<Record<RetainedPayloadName, number>>;
  readonly receiptBoundBytes: number;
  readonly totalBoundBytes: number;
  readonly requiredFreeBytes: number;
};

/**
 * The complete backup budget from metadata alone. Every payload bound and the total must fit the
 * policy BEFORE any body is allocated: a single payload within `payloadBytes`, and all payloads
 * plus the receipt within `backupBytes`. Refusal never truncates.
 */
export function retainedBackupBudget(input: {
  readonly limits: RetainedNonqualifiedResourceLimits;
  readonly measure: RetainedWorkspaceInventory["measure"];
  readonly lifecycleTarBytes: number;
  readonly intentBytes: number;
}): RetainedBackupBudget {
  const { limits, measure } = input;
  // Git listings are bounded by the metadata buffer and, tighter, by the measured path volume.
  const listingBound = Math.min(limits.gitMetadataBytes, 2 * measure.receiptEntriesBoundBytes + 4096);
  const receiptBoundBytes = measure.receiptEntriesBoundBytes + 65_536;
  if (receiptBoundBytes > limits.receiptBytes) throw new Error("retained_nonqualified_receipt_too_large");
  const payloadBounds: Record<RetainedPayloadName, number> = {
    "owner-intent.json": input.intentBytes,
    "git-status.txt": listingBound,
    "tracked.diff": limits.patchBytes,
    "tracked.numstat": listingBound,
    "untracked.tar": measure.untrackedTarBytes,
    "staged.tar": measure.stagedTarBytes,
    "lifecycle.tar": input.lifecycleTarBytes,
  };
  let totalBoundBytes = receiptBoundBytes;
  for (const name of RETAINED_NONQUALIFIED_BACKUP_PAYLOADS) {
    if (payloadBounds[name] > limits.payloadBytes) throw new Error(`retained_nonqualified_payload_too_large:${name}`);
    totalBoundBytes += payloadBounds[name];
  }
  if (totalBoundBytes > limits.backupBytes) throw new Error("retained_nonqualified_backup_budget_exceeded");
  return { payloadBounds, receiptBoundBytes, totalBoundBytes, requiredFreeBytes: totalBoundBytes + RETAINED_CAPACITY_MARGIN_BYTES };
}

/** Exact actual lengths must stay within the bounds the preflight admitted (growth refuses, never truncates). */
export function assertRetainedActualWithinBudget(
  budget: RetainedBackupBudget,
  limits: RetainedNonqualifiedResourceLimits,
  actual: Readonly<Record<RetainedPayloadName, number>>,
  receiptBytes: number,
): void {
  let total = receiptBytes;
  if (receiptBytes > limits.receiptBytes) throw new Error("retained_nonqualified_receipt_too_large");
  for (const name of RETAINED_NONQUALIFIED_BACKUP_PAYLOADS) {
    if (actual[name] > budget.payloadBounds[name] || actual[name] > limits.payloadBytes) {
      throw new Error(`retained_nonqualified_source_growth:${name}`);
    }
    total += actual[name];
  }
  if (total > limits.backupBytes) throw new Error("retained_nonqualified_backup_budget_exceeded");
}

/**
 * The pre-allocation resource gate, run under the existing workspace lock before any full-buffer
 * collection: metadata-only inventory and lifecycle measurement, the complete backup budget, the
 * actual durable and scratch free space, and (expanded policy) the Linux memory admission.
 */
export async function preflightRetainedResources(input: {
  readonly policy: RetainedNonqualifiedResourcePolicyId;
  readonly limits: RetainedNonqualifiedResourceLimits;
  readonly workspacePath: string;
  readonly ignoredRetain: readonly string[];
  readonly lifecyclePaths: RetainedLifecyclePaths;
  readonly intentBytes: number;
  readonly durablePath: string;
  readonly scratchPath?: string;
  readonly readMemory?: () => Promise<LinuxMemoryAvailability>;
}): Promise<{
  readonly budget: RetainedBackupBudget;
  readonly measure: RetainedWorkspaceInventory["measure"];
  readonly capacity: { readonly requiredBytes: number; readonly durableFreeBytes: number; readonly scratchFreeBytes: number };
  readonly memory: RetainedMemoryObservation | undefined;
}> {
  const inventory = await captureRetainedWorkspaceInventory(input.workspacePath, {
    ignoredRetain: input.ignoredRetain, limits: input.limits, measureOnly: true,
  });
  const lifecycle = await measureRetainedLifecycle(input.lifecyclePaths, input.limits.lifecycleBytes);
  const budget = retainedBackupBudget({ limits: input.limits, measure: inventory.measure,
    lifecycleTarBytes: lifecycle.tarBytes, intentBytes: input.intentBytes });
  const capacity = assertRetainedNonqualifiedCapacity({
    requiredBytes: budget.requiredFreeBytes,
    durableFreeBytes: await retainedFreeBytes(input.durablePath),
    scratchFreeBytes: await retainedFreeBytes(input.scratchPath ?? retainedScratchRoot()),
  });
  const memory = await assertRetainedMemoryAdmission({ policy: input.policy, limits: input.limits,
    ...(input.readMemory === undefined ? {} : { read: input.readMemory }) });
  return { budget, measure: inventory.measure, capacity, memory };
}
