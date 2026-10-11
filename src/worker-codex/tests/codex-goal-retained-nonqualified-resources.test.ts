import { describe, expect, it } from "vitest";
import {
  RETAINED_NONQUALIFIED_BACKUP_PAYLOADS,
  RetainedNonqualifiedResourcePolicyId,
  retainedNonqualifiedResourceLimits,
} from "@vioxen/subscription-runtime/worker-core";
import type { LinuxMemoryAvailability } from "../../worker-local/linux-memory-availability";
import {
  assertRetainedActualWithinBudget,
  assertRetainedMemoryAdmission,
  assertRetainedNonqualifiedCapacity,
  retainedBackupBudget,
  retainedMemoryRequirementBytes,
  serializeRetainedHeavyWork,
} from "../application/project-control/codex-goal-retained-nonqualified-resources";

// Portable (no Linux custody): pure arithmetic, refusal and serialization of the retained resource
// gate. The held-descriptor measurement and the live /proc and cgroup reads are tested elsewhere.
const MIB = 1024 * 1024, GIB = 1024 * MIB;
const defaultLimits = retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.Default)!;
const expanded = retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.ExpandedV1)!;
const availability = (effectiveBytes: number, extra: Partial<LinuxMemoryAvailability> = {}): LinuxMemoryAvailability =>
  ({ hostAvailableBytes: 46 * GIB, cgroupRemainingBytes: undefined, effectiveBytes, cgroupVersion: "v2", ...extra });

describe("retained memory admission", () => {
  it("requires 8 x the permitted complete backup plus 256 MiB: 4.25 GiB for the expanded profile", () => {
    expect(retainedMemoryRequirementBytes(expanded)).toBe(4.25 * GIB);
    expect(retainedMemoryRequirementBytes(defaultLimits)).toBe(8 * 256 * MIB + 256 * MIB);
  });

  it("leaves the ordinary policy's behaviour alone: no memory probe at all", async () => {
    let probed = false;
    expect(await assertRetainedMemoryAdmission({ policy: RetainedNonqualifiedResourcePolicyId.Default, limits: defaultLimits,
      read: async () => { probed = true; return availability(0); } })).toBeUndefined();
    expect(probed).toBe(false);
  });

  it("admits the expanded policy exactly at the threshold and refuses one byte below", async () => {
    const need = retainedMemoryRequirementBytes(expanded);
    const policy = RetainedNonqualifiedResourcePolicyId.ExpandedV1;
    expect(await assertRetainedMemoryAdmission({ policy, limits: expanded, read: async () => availability(need) }))
      .toMatchObject({ requiredBytes: need, effectiveBytes: need, cgroupRemainingBytes: null });
    await expect(assertRetainedMemoryAdmission({ policy, limits: expanded, read: async () => availability(need - 1) }))
      .rejects.toThrow("retained_nonqualified_memory_insufficient");
  });

  it("refuses when a tighter cgroup ancestor limits the effective allowance even though the host reports plenty", async () => {
    const policy = RetainedNonqualifiedResourcePolicyId.ExpandedV1;
    await expect(assertRetainedMemoryAdmission({ policy, limits: expanded,
      read: async () => availability(2 * GIB, { hostAvailableBytes: 46 * GIB, cgroupRemainingBytes: 2 * GIB }) }))
      .rejects.toThrow("retained_nonqualified_memory_insufficient");
  });

  it("has no ambient memory authority: the expanded policy refuses unless the retention operator role supplies the port", async () => {
    // No injected reader: nothing in the process (environment, permit, caller value) can stand in for the role.
    await expect(assertRetainedMemoryAdmission({ policy: RetainedNonqualifiedResourcePolicyId.ExpandedV1, limits: expanded }))
      .rejects.toThrow("retained_nonqualified_memory_unknown:linux_memory_unknown:host_authority_not_installed");
  });

  it.each([
    ["an unreadable limit", async () => { throw new Error("linux_memory_unknown:unreadable:/x"); }],
    ["a non-numeric allowance", async () => availability(Number.NaN)],
  ])("refuses the expanded policy on %s instead of guessing", async (_name, read) => {
    await expect(assertRetainedMemoryAdmission({ policy: RetainedNonqualifiedResourcePolicyId.ExpandedV1, limits: expanded, read }))
      .rejects.toThrow(/retained_nonqualified_memory_(unknown|insufficient)/);
  });
});

describe("retained complete-backup budget", () => {
  const measure = (over: Partial<{ untrackedTarBytes: number; stagedTarBytes: number; receiptEntriesBoundBytes: number }> = {}) => ({
    untrackedTarBytes: 272_920_576, stagedTarBytes: 1024, receiptEntriesBoundBytes: 4_700_000,
    worktreeBytes: 263_341_675, stagedBytes: 0, largestFileBytes: 123_655_872, ...over,
  });
  const budget = (limits = expanded, over: Parameters<typeof measure>[0] = {}, lifecycleTarBytes = 40_960, intentBytes = 2048) =>
    retainedBackupBudget({ limits, measure: measure(over), lifecycleTarBytes, intentBytes });

  it("admits the canary-size corpus (272,920,576-byte tar) under the expanded policy and refuses it under the ordinary one", () => {
    const admitted = budget();
    expect(admitted.totalBoundBytes).toBeLessThanOrEqual(expanded.backupBytes);
    expect(admitted.payloadBounds["untracked.tar"]).toBe(272_920_576);
    expect(admitted.payloadBounds["tracked.diff"]).toBe(expanded.patchBytes);
    expect(admitted.requiredFreeBytes).toBeGreaterThan(admitted.totalBoundBytes);
    expect(() => budget(defaultLimits)).toThrow("retained_nonqualified_payload_too_large:untracked.tar");
  });

  it("refuses one byte over a single payload cap and over the complete backup, before any allocation", () => {
    expect(() => budget(expanded, { untrackedTarBytes: expanded.payloadBytes })).not.toThrow("payload_too_large");
    expect(() => budget(expanded, { untrackedTarBytes: expanded.payloadBytes + 1 })).toThrow("retained_nonqualified_payload_too_large:untracked.tar");
    // 460 MiB of tar fits one payload but, with the 32 MiB patch bound, listings and receipt, no longer the 512 MiB backup.
    expect(() => budget(expanded, { untrackedTarBytes: 470 * MIB })).toThrow("retained_nonqualified_backup_budget_exceeded");
  });

  it("refuses a receipt whose entry list alone could exceed the receipt cap", () => {
    expect(() => budget(expanded, { receiptEntriesBoundBytes: expanded.receiptBytes })).toThrow("retained_nonqualified_receipt_too_large");
  });

  it("refuses growth beyond the admitted bounds and an oversize actual receipt; nothing is truncated", () => {
    const admitted = budget();
    const actual = Object.fromEntries(RETAINED_NONQUALIFIED_BACKUP_PAYLOADS.map(name => [name, admitted.payloadBounds[name]])) as
      Record<typeof RETAINED_NONQUALIFIED_BACKUP_PAYLOADS[number], number>;
    expect(() => assertRetainedActualWithinBudget(admitted, expanded, actual, 4_000_000)).not.toThrow();
    expect(() => assertRetainedActualWithinBudget(admitted, expanded, { ...actual, "untracked.tar": actual["untracked.tar"] + 1 }, 4_000_000))
      .toThrow("retained_nonqualified_source_growth:untracked.tar");
    expect(() => assertRetainedActualWithinBudget(admitted, expanded, actual, expanded.receiptBytes + 1)).toThrow("retained_nonqualified_receipt_too_large");
  });
});

describe("retained capacity and in-process serialization", () => {
  it("requires both the durable target and scratch to hold the complete backup", () => {
    const fits = { requiredBytes: 100, durableFreeBytes: 100, scratchFreeBytes: 100 };
    expect(assertRetainedNonqualifiedCapacity(fits)).toEqual(fits);
    expect(() => assertRetainedNonqualifiedCapacity({ ...fits, durableFreeBytes: 99 })).toThrow("retained_nonqualified_capacity_insufficient");
    expect(() => assertRetainedNonqualifiedCapacity({ ...fits, scratchFreeBytes: 99 })).toThrow("retained_nonqualified_capacity_insufficient");
    expect(() => assertRetainedNonqualifiedCapacity({ ...fits, scratchFreeBytes: Number.NaN })).toThrow("retained_nonqualified_capacity_insufficient");
  });

  it("runs heavy work one at a time in this process, in order, and a failure does not wedge the queue", async () => {
    const events: string[] = [];
    let active = 0, maxActive = 0;
    const task = (name: string, fail = false) => serializeRetainedHeavyWork(async () => {
      active += 1; maxActive = Math.max(maxActive, active); events.push(`start:${name}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end:${name}`); active -= 1;
      if (fail) throw new Error(`failed:${name}`);
      return name;
    });
    const results = await Promise.allSettled([task("a"), task("b", true), task("c")]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
