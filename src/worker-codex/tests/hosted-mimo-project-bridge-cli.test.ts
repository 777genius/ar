import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InterruptedProjectCreateErrorCode } from "@vioxen/subscription-runtime/worker-core";
import { researchInvalid } from "../research-launch-files";

const adapter = vi.hoisted(() => ({ listPending: vi.fn(), reconcileHostedMimoInterruptedCreate: vi.fn(), resumeHostedMimoProjectPreparation: vi.fn(), advanceHostedMimoProjectSource: vi.fn() }));
vi.mock("../hosted-mimo-interrupted-create-reconciliation", () => adapter);
vi.mock("../hosted-mimo-pending-finalization", () => ({ listHostedMimoPendingFinalization: adapter.listPending }));
vi.mock("../hosted-mimo-project-bridge-advance", () => ({ advanceHostedMimoProjectSource: adapter.advanceHostedMimoProjectSource }));
vi.mock("../hosted-mimo-project-bridge-prepare", async original => ({ ...await original<object>(), resumeHostedMimoProjectPreparation: adapter.resumeHostedMimoProjectPreparation }));
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
  "hosted_research_launch_denied",
])("keeps unknown, suffixed and untyped failures private: %s", async error => {
  await failure(error, "mimo_project_bridge_operation_failed");
});

it("refuses generic preparation resume without a trusted original-producer closure adapter", async () => {
  process.argv = ["node", "/TEST/bridge-cli", "--resume-project-preparation", "/TEST/resume.json"];
  await import("../hosted-mimo-project-bridge-cli");
  expect(adapter.resumeHostedMimoProjectPreparation).not.toHaveBeenCalled();
  expect(adapter.reconcileHostedMimoInterruptedCreate).not.toHaveBeenCalled();
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith('{"ok":false,"error":"mimo_project_bridge_prepare_resume_refused"}\n');
  expect(process.exitCode).toBe(1);
});

it.each([
  [new Error("project_control_interrupted_create_reconciliation_refused: TEST-secret"), "project_control_interrupted_create_reconciliation_refused"],
  [new Error("hosted_research_launch_denied; TEST-secret"), "hosted_research_launch_denied"],
  [Object.assign(new Error("TEST private missing path"), { code: "ENOENT" }), "mimo_project_bridge_fs_not_found"],
])("preserves safe canonical codes without private causes", async (error, code) => {
  await failure(error, code);
});

it.each([
  [["--advance-source", "/TEST/plan.json"], { dryRun: false }],
  [["--advance-source", "--dry-run", "/TEST/plan.json"], { dryRun: true }],
])("routes %j to the source advance with only the dry-run choice", async (args, options) => {
  process.argv = ["node", "/TEST/bridge-cli", ...args];
  adapter.advanceHostedMimoProjectSource.mockResolvedValueOnce({ ok: true });
  await import("../hosted-mimo-project-bridge-cli");
  expect(adapter.advanceHostedMimoProjectSource).toHaveBeenCalledExactlyOnceWith("/TEST/plan.json", options);
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith('{"ok":true}\n');
});
it.each([["--advance-source"], ["--advance-source", "--dry-run"], ["--advance-source", "/TEST/plan.json", "extra"], ["--advance-source", "--force", "/TEST/plan.json"]])(
  "refuses the malformed source advance command line %j", async (...args) => {
    process.argv = ["node", "/TEST/bridge-cli", ...args];
    await import("../hosted-mimo-project-bridge-cli");
    expect(adapter.advanceHostedMimoProjectSource).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith('{"ok":false,"error":"mimo_project_bridge_request_invalid"}\n');
    expect(process.exitCode).toBe(1);
  });
it("routes --render-attachment to the pure renderer and exits 1 on an invalid card", async () => {
  process.argv = ["node", "/TEST/bridge-cli", "--render-attachment", "/TEST/missing-card.json"];
  await import("../hosted-mimo-project-bridge-cli");
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"error":"mimo_project_bridge_render_card_invalid"'));
  expect(process.exitCode).toBe(1);
});
it("prints the rendered files for a valid card and nothing for argument shapes it does not accept", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "TEST-render-"));
  try {
    const path = join(dir, "card.json");
    writeFileSync(path, JSON.stringify({ projectId: "test-project", repositoryUrl: "https://github.com/example/test-repo.git", branch: "main", commit: "a".repeat(40), sandboxSubdir: "sandbox",
      ownedPaths: ["src/"], taskTimeoutMs: 14400000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, diskPeak: { scratch: 1, durable: 1 },
      host: { alias: "test-host", machineId: "b".repeat(32), socketDir: "/private/tmp/x", authRootDir: "/srv/auth", codexBinaryPath: "/opt/codex" } }));
    process.argv = ["node", "/TEST/bridge-cli", "--render-attachment", path];
    await import("../hosted-mimo-project-bridge-cli");
    expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"ok":true'));
    expect(process.exitCode).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it.each([["--render-attachment"], ["--render-attachment", "/TEST/a.json", "extra"]])("refuses the malformed render command line %j", async (...args) => {
  process.argv = ["node", "/TEST/bridge-cli", ...args];
  await import("../hosted-mimo-project-bridge-cli");
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith('{"ok":false,"error":"mimo_project_bridge_request_invalid"}\n');
  expect(process.exitCode).toBe(1);
});
it("routes --list-pending-finalization to the read-only listing and accepts no further arguments", async () => {
  process.argv = ["node", "/TEST/bridge-cli", "--list-pending-finalization"];
  adapter.listPending.mockReturnValueOnce({ ok: true, pending: [], uncertain: 0 });
  await import("../hosted-mimo-project-bridge-cli");
  expect(adapter.listPending).toHaveBeenCalledOnce();
  expect(process.stdout.write).toHaveBeenCalledExactlyOnceWith('{"ok":true,"pending":[],"uncertain":0}\n');
});
