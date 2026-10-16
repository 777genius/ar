import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { withHostedMimoWorkstreamActivity } from "../hosted-mimo-project-workstream-fence";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "TEST-mimo-fence-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("refuses at once while a maintenance fence exists unless the caller asks to wait", async () => {
  const fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: root, owner: "TEST advance" });
  const effect = vi.fn(async () => "ran");
  try {
    await expect(withHostedMimoWorkstreamActivity(root, effect)).rejects.toThrow("controller_maintenance_fence_active");
    expect(effect).not.toHaveBeenCalled();
  } finally { await releaseLocalControllerMaintenanceFence(fence); }
});
it("an owned unit that waited for the fence still runs its effect exactly once", async () => {
  const fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: root, owner: "TEST advance" });
  const effect = vi.fn(async () => "ran");
  const waiting = withHostedMimoWorkstreamActivity(root, effect, { fenceWaitMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(effect).not.toHaveBeenCalled();
  await releaseLocalControllerMaintenanceFence(fence);
  await expect(waiting).resolves.toBe("ran");
  expect(effect).toHaveBeenCalledTimes(1);
});
it("gives up with the fence refusal when the wait expires", async () => {
  const fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: root, owner: "TEST advance" });
  const effect = vi.fn(async () => "ran");
  try {
    await expect(withHostedMimoWorkstreamActivity(root, effect, { fenceWaitMs: 300 })).rejects.toThrow("controller_maintenance_fence_active");
    expect(effect).not.toHaveBeenCalled();
  } finally { await releaseLocalControllerMaintenanceFence(fence); }
});
it("never replays an effect that fails with the fence refusal itself", async () => {
  const effect = vi.fn(async () => { throw new Error("controller_maintenance_fence_active"); });
  await expect(withHostedMimoWorkstreamActivity(root, effect, { fenceWaitMs: 5000 })).rejects.toThrow("controller_maintenance_fence_active");
  expect(effect).toHaveBeenCalledTimes(1);
});
it("keeps the durable recovery guard ahead of any wait", async () => {
  mkdirSync(root, { recursive: true }); writeFileSync(join(root, ".controller-recovery.json"), "TEST guard\n");
  const effect = vi.fn(async () => "ran");
  await expect(withHostedMimoWorkstreamActivity(root, effect, { fenceWaitMs: 5000 })).rejects.toThrow("mimo_project_bridge_recovery_pending");
  expect(effect).not.toHaveBeenCalled();
});
