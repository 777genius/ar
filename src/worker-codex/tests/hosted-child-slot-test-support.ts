import { createHash } from "node:crypto";
import { join } from "node:path";
import { ChildContinuationMode, AgentRuntimeTool, parseChildLifetime } from "@vioxen/subscription-runtime/core";
import { CodexProviderEgressProfileId, CodexModelBackend, HostedMimoProfile } from "@vioxen/subscription-runtime/provider-codex";
import { HostedInstallationActivationStore } from "../hosted-installation-activation";
import { enrollHostedChildSlot } from "../hosted-child-slot-files";

/** Private TEST host fixture; caller supplies the existing disposable host I/O. */
export function enrolledTestChild(runtimeDirectory: string, inventory: Record<string, unknown>, put: (name: string, value: unknown) => void) {
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const jobId = "ordinary-job", jobRootDir = "/jobs/ordinary-job", workspacePath = jobRootDir + "/workspace";
  const promptPath = "/var/lib/subscription-runtime-host-policy/task.md";
  const lifetime = parseChildLifetime({ schemaVersion: 1, accountId: "account-s", deadlineEpochMs: Date.now() + 60_000,
    maxGoalTurns: 2, maxAccountCycles: 1, maxAttempts: 1, continuationMode: ChildContinuationMode.Disabled,
    denyProjectInstructions: true, accessBoundary: "read_only", allowedTools: [AgentRuntimeTool.ReadFile] });
  const grant = { schemaVersion: 3, jobId, jobRootDir, workspacePath, profileId: CodexProviderEgressProfileId.MimoTokenPlan,
    accountId: "account-s", hostedProfile: HostedMimoProfile.Child, slotId: "finite-test-slot", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
    executionEngine: "app-server-goal", namedPermissions: true, globalScanGuard: true, nativeToolSurface: "disabled" };
  put("grants/" + hash(jobId) + ".json", grant);
  const launch = { command: process.execPath, cwd: workspacePath, args: [join(runtimeDirectory, "dist/worker-codex/codex-goal-cli.js"), "run",
    "--prompt", promptPath, "--workspace", workspacePath, "--job-root", jobRootDir, "--job-id", jobId, "--task-id", jobId,
    "--auth-root", jobRootDir + "/capacity", "--codex-binary", "/TEST/pinned-codex", "--accounts", "account-s",
    "--max-account-cycles", "1", "--max-attempts", "1", "--continuation-mode", "disabled", "--max-goal-turns", "2",
    "--child-lifetime-json", JSON.stringify(lifetime), "--execution-engine", "app-server-goal", "--model-backend", "xiaomi-mimo-token-plan",
    "--model", "mimo-v2.6-pro", "--access-boundary", "read_only", "--edit-mode", "read-only",
    "--project-access-scope-json", JSON.stringify({ projectId: jobId, readRoots: [workspacePath] })] };
  const slot = { schemaVersion: 1, slotId: "finite-test-slot", creatorId: "ordinary-creator", jobId, jobRootDir, workspacePath, promptPath,
    sourceSha: "c".repeat(40), artifactSha: "a".repeat(40), grantSha256: hash(JSON.stringify(grant) + "\n"), launch, lifetime };
  const bytes = Buffer.from(JSON.stringify(slot) + "\n");
  put("readonly-inventory.json", { ...inventory, ordinaryCreators: [{ creatorId: slot.creatorId, jobId, jobRootDir, workspacePath,
    launch, childSlotSha256: hash(bytes.toString()) }] });
  const store = new HostedInstallationActivationStore(); store.install();
  store.serialized(fence => enrollHostedChildSlot(fence, bytes)); store.enrollOrdinary(slot.creatorId); store.resumeOrdinary();
  return { store, launch, slot };
}
