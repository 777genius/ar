import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccessBoundary, ProjectAuthorityMode, ProjectControlBroker,
  type ProjectAccessScope, type ProjectControlBrokerPorts,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectAuthorityTupleStore } from "../../worker-local/project-authority-tuple-local-adapter";
import { registerCodexGoalProjectAuthorityTools } from "../codex-goal-mcp-project-authority-tool-registration";
import { projectControlAdoptAuthorityTupleView } from "../codex-goal-mcp-project-authority";
import { mcpJson } from "../codex-goal-mcp-response";
import type { ProjectControlMcpArgs } from "../codex-goal-mcp-inputs";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("registered project authority MCP lifecycle", () => {
  it("runs the registered handler through the production broker and local store", async () => {
    const registryRootDir = await root();
    const scope: ProjectAccessScope = { projectId: "hosted-web-core-v1",
      preStartAdmission: { required: true, mode: "serial-builtin",
        authorityMode: ProjectAuthorityMode.HostedWebCoreV1 } };
    const store = new LocalProjectAuthorityTupleStore({
      rootDir: join(registryRootDir, ".project-authority"), projectId: scope.projectId,
    });
    const expected = { packetRevision: "hosted-web-core-v1-r1", baseSha: "a".repeat(40),
      phaseStartSha: null, inputPatchHash: "b".repeat(64) } as const;
    await store.initialize(expected);
    const deps = { async loadProjectControlController() { return {
      registryRootDir, controller: { jobId: "controller" } as never, scope,
    }; }, codexProjectControlBroker() { return broker(scope, store); } };
    let registered: ((args: ProjectControlMcpArgs) => Promise<unknown>) | undefined;
    const server = { registerTool(_name: string, _schema: unknown, callback: typeof registered) {
      registered = callback;
    } };
    registerCodexGoalProjectAuthorityTools(server as never,
      async (args) => mcpJson(await projectControlAdoptAuthorityTupleView(args, deps)));
    expect(registered).toBeDefined();
    const args = authorityArgs();
    await expect(registered!(args)).resolves.toMatchObject({ content: expect.any(Array) });
    await expect(registered!(args)).resolves.toMatchObject({ content: expect.any(Array) });
    await expect(store.compareAndSet({ expected, desired: {
      packetRevision: args.packetRevision!, baseSha: args.baseSha!,
      phaseStartSha: args.phaseStartSha!, inputPatchHash: args.inputPatchHash!,
      reviewReceiptSha256: args.reviewReceiptSha256!,
    } })).resolves.toBe("noop");
  });
});
function broker(scope: ProjectAccessScope, authority: LocalProjectAuthorityTupleStore) {
  const unavailable = async () => { throw new Error("unused_port"); };
  const ports = { authority, registry: { createJob: unavailable, writeReviewMarker: unavailable },
    supervisor: { startWorker: unavailable, stopWorker: unavailable },
    workspace: { createWorktree: unavailable }, git: { integrateCommit: unavailable, pushBranch: unavailable },
  } as unknown as ProjectControlBrokerPorts;
  return new ProjectControlBroker({ boundary: AccessBoundary.ProjectScopedControl, scope }, ports);
}
function authorityArgs(): ProjectControlMcpArgs {
  const receipt = JSON.stringify({ schemaVersion: 1, packetRevision: "hosted-web-core-v1-r1",
    baseSha: "a".repeat(40), phaseStartSha: "c".repeat(40), inputPatchHash: "b".repeat(64) });
  return { registryRootDir: "/unused", controllerJobId: "controller", confirmAuthorityAdoption: true,
    packetRevision: "hosted-web-core-v1-r1", baseSha: "a".repeat(40), phaseStartSha: "c".repeat(40),
    inputPatchHash: "b".repeat(64), reviewReceipt: receipt,
    reviewReceiptSha256: createHash("sha256").update(receipt).digest("hex") };
}
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "authority-mcp-"));
  roots.push(path); await mkdir(join(path, ".project-authority"), { mode: 0o700 }); return path; }
