import { expect, it, vi } from "vitest";
import { CodexModelBackend, codexMimoDefaultModel } from "@vioxen/subscription-runtime/provider-codex";
import { parseResearchOperatorRequest } from "../research-launch-contract";
import { resolveHostScratchTempRoot, type ScratchTempHost } from "../host-scratch-temp";
const stateRoot = "/srv/worker-state/mimo-projects/test-project/test-stream";
const workspace = "/srv/workers/mimo-projects/test-project/test-stream/workspaces/test-job";
it("research contract admits protected MiMo source/workspace prefix without weakening separation", () => {
  const request = { schemaVersion: 1, jobId: "test-job", taskId: "test-task", jobRootDir: stateRoot + "/jobs/test-job", workspacePath: workspace,
    promptPath: stateRoot + "/jobs/test-job/prompt.md", authRootDir: "/srv/worker-state/account-pools/live-codex-auth", accounts: ["account-q"],
    codexBinaryPath: "/usr/bin/codex", modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel, reasoningEffort: "medium",
    serviceTier: "default", taskTimeoutMs: 600000, maxAccountCycles: 1, prewarmOnStart: false };
  expect(parseResearchOperatorRequest(request)).toMatchObject({ workspacePath: workspace, jobRootDir: request.jobRootDir });
  expect(() => parseResearchOperatorRequest({ ...request, promptPath: workspace + "/prompt.md" })).toThrow();
});
it("existing scratch mount policy hashes protected control paths without requiring shared project roots", () => {
  const uuid = "d0f2cac1-2009-4e9d-a710-e156f417938f", mutation = vi.fn();
  const host: ScratchTempHost = { uid: 0,
    mountNamespace: () => "mnt:[4026532000]", managerMountNamespace: () => "mnt:[4026531841]", ownsRunnerNamespace: () => true,
    realpath: path => path,
    lstat: path => ({ uid: 0, mode: path === "/etc/subscription-runtime/scratch-temp.json" ? 0o100600 : 0o40755,
      dev: 1, ino: 2, isDirectory: () => path !== "/etc/subscription-runtime/scratch-temp.json", isFile: () => path === "/etc/subscription-runtime/scratch-temp.json", isSymbolicLink: () => false }),
    read: () => JSON.stringify({ schemaVersion: 1, root: "/srv/workers", uuid }),
    inspectMount: path => path === "/srv/workers" ? { target: path, uuid, fsroot: "/" } : undefined,
    statfs: () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }), mkdir: mutation, removeLock: mutation, chmod: mutation,
    entries: () => [], bind: mutation, makePrivate: mutation, unmount: mutation };
  expect(resolveHostScratchTempRoot(stateRoot + "/jobs/test-job", host)).toMatchObject({ uuid, source: expect.stringMatching(/^\/srv\/workers\/runtime-tmp\/[a-f0-9]{64}$/) });
  expect(mutation).not.toHaveBeenCalled();
});
