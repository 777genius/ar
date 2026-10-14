import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InterruptedProjectCreateErrorCode } from "@vioxen/subscription-runtime/worker-core";
import { researchInvalid } from "../research-launch-files";

const adapter = vi.hoisted(() => ({ reconcileHostedMimoInterruptedCreate: vi.fn() }));
vi.mock("../hosted-mimo-interrupted-create-reconciliation", () => adapter);
const originalArgv = process.argv, originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  process.argv = ["node", "/TEST/bridge-cli", "--reconcile-interrupted-create", "/TEST/plan.json"];
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks(); vi.resetAllMocks();
});
async function failure(error: unknown, expected: string): Promise<void> {
  adapter.reconcileHostedMimoInterruptedCreate.mockRejectedValueOnce(error);
  await import("../hosted-mimo-project-bridge-cli");
  expect(adapter.reconcileHostedMimoInterruptedCreate).toHaveBeenCalledExactlyOnceWith("/TEST/plan.json");
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: false, error: expected }) + "\n");
  expect(process.stderr.write).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
}
it("retains the domain reconciliation refusal at the actual CLI boundary", async () => {
  await failure(new Error(InterruptedProjectCreateErrorCode.ReconciliationRefused), "project_control_interrupted_create_reconciliation_refused");
});
it("retains an actual research admission refusal without its private cause", async () => {
  let error: unknown;
  try { researchInvalid("file-deadline"); } catch (caught) { error = caught; }
  await failure(error, "hosted_research_launch_denied");
});
it("preserves the existing closed bridge error framing", async () => {
  await failure(new Error("mimo_project_bridge_operation_invalid"), "mimo_project_bridge_operation_invalid");
});
it.each([
  new Error("TEST_PRIVATE_PATH /private/TEST-secret"),
  new Error("project_control_interrupted_create_reconciliation_refused: TEST-secret"),
  new Error("hosted_research_launch_denied; TEST-secret"),
  "hosted_research_launch_denied",
])("keeps unknown, suffixed and untyped failures private: %s", async error => {
  await failure(error, "mimo_project_bridge_operation_failed");
});
