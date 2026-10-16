import { mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const projected = vi.hoisted(() => ({ path: "", authorityReads: 0,
  downstream: vi.fn(() => { throw Error("TEST disabled policy crossed destructive boundary"); }) }));
// Only upstream host authority/fence and the exact protected reader transport
// are projected. The real policy parser and transaction selection execute.
vi.mock("@vioxen/subscription-runtime/provider-codex", async original => {
  const actual = await original<typeof import("@vioxen/subscription-runtime/provider-codex")>();
  return { ...actual, withHostedActivationFence: (effect: (fence: unknown) => unknown) =>
    effect(Object.freeze({ purpose: "TEST upstream host fence projection" })) };
});
vi.mock("../hosted-current-dependency-origin", async original => {
  const actual = await original<typeof import("../hosted-current-dependency-origin")>();
  return { ...actual, readCurrentHostedDependencyMaintenanceAuthority: () => {
    projected.authorityReads++;
    return Object.freeze({ purpose: "TEST upstream selected authority projection; no cold or writer handle" });
  }, claimCurrentHostedDependencyMaintenance: projected.downstream,
  renameCurrentHostedDependencyMaintenanceTree: projected.downstream,
  releaseCurrentHostedDependencyMaintenance: projected.downstream };
});
vi.mock("../hosted-readonly-inputs", async original => {
  const actual = await original<typeof import("../hosted-readonly-inputs")>();
  const fs = await import("node:fs");
  return { ...actual, readHostedPrivateBytes: (path: string, maximum: number) => {
    expect(path).toBe("/var/lib/subscription-runtime-host-policy/dependency-retention-policy.json");
    expect(maximum).toBe(4096);
    if (!fs.existsSync(projected.path)) return undefined;
    const bytes = fs.readFileSync(projected.path); expect(bytes.length).toBeLessThanOrEqual(maximum);
    return bytes;
  } };
});
vi.mock("../hosted-dependency-receipts", async original => ({
  ...await original<typeof import("../hosted-dependency-receipts")>(),
  readHostedDependencyReceipt: projected.downstream, publishHostedDependencyReceipt: projected.downstream,
  ensureHostedDependencyDirectory: projected.downstream,
}));
import { readHostedDependencyEvictionEnabled } from "../hosted-dependency-eviction-enabled-policy";
import { evictHostedDependencyCandidate, HostedDependencyTransactionOutcome } from "../hosted-dependency-transactions";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
it.each(["false", "missing", "true"] as const)("actual %s policy controls the eviction boundary before receipt/ownership/tree effects", async mode => {
  root = mkdtempSync(join(tmpdir(), "TEST-eviction-off-policy-"));
  projected.path = join(root, "policy.json"); projected.authorityReads = 0; projected.downstream.mockClear();
  if (mode !== "missing") writeFileSync(projected.path,
    JSON.stringify({ version: 1, managedReadyRequired: true, evictionEnabled: mode === "true" }) + "\n", { mode: 0o600 });
  const sentinel = join(root, "unknown-dependency-and-quarantine-sentinel");
  writeFileSync(sentinel, Buffer.from([0, 255, 17, 10]), { mode: 0o600 });
  const before = readFileSync(sentinel), identity = lstatSync(sentinel, { bigint: true });
  const policyBefore = existsSync(projected.path) ? readFileSync(projected.path) : undefined;
  expect(readHostedDependencyEvictionEnabled()).toBe(mode === "true");
  const eviction = evictHostedDependencyCandidate({ jobId: "TEST-off-policy", revision: 1,
    generation: "12345678-1234-4234-8234-123456789abc", installKey: "a".repeat(64) });
  // A positive gate control prevents an unconditional Skipped implementation
  // from satisfying the disabled-policy assertions. No actual effect is granted.
  if (mode === "true") await expect(eviction).rejects.toThrow("TEST disabled policy crossed destructive boundary");
  else expect(await eviction).toEqual({ outcome: HostedDependencyTransactionOutcome.Skipped });
  expect(projected.authorityReads).toBe(1);
  expect(projected.downstream).toHaveBeenCalledTimes(mode === "true" ? 1 : 0);
  expect(readFileSync(sentinel)).toEqual(before);
  const after = lstatSync(sentinel, { bigint: true });
  expect([after.dev, after.ino, after.mode]).toEqual([identity.dev, identity.ino, identity.mode]);
  expect(existsSync(projected.path) ? readFileSync(projected.path) : undefined).toEqual(policyBefore);
});
