import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessBoundary, NetworkAccessMode, ProjectOperation, evaluateProjectAdmission, CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER } from "@vioxen/subscription-runtime/worker-core";
import type { CodexGoalJobManifest } from "../codex-goal-jobs";
import { assertConfiguredProjectControlCustodyItemsPresent } from "../codex-goal-project-custody-recovery";
import { assertProjectControlCanonicalScopeRepair } from "../codex-goal-project-scope-recovery";
import { LocalProjectControlEvidenceCustody } from "../../worker-local/project-control-evidence-custody-local-adapter";
import { readCodexGoalConsumedOutputLedgers } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { git } from "./codex-goal-mcp-test-support";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bootstrap-recovery-"));
  roots.push(root);
  const ledger = join(root, "ledger");
  const workspace = join(root, "workspace");
  await mkdir(ledger);
  await mkdir(workspace);
  const controller: CodexGoalJobManifest = {
    schemaVersion: 1, jobId: "project-controller", taskId: "project-controller",
    createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
    jobRootDir: root, workspacePath: workspace, promptPath: join(root, "prompt.md"),
    accounts: ["account-a"], accessBoundary: AccessBoundary.ProjectScopedControl,
    networkAccess: NetworkAccessMode.Restricted,
    projectAccessScope: {
      projectId: "project", readRoots: [root], workspaceRoots: [workspace],
      consumedOutputLedgerRoots: [ledger],
      allowedGitRemotes: ["https://example.com/team/project.git"],
      allowedAccountIds: ["account-a"],
    },
  };
  const custody = new LocalProjectControlEvidenceCustody();
  return { root, ledger, workspace, controller, custody };
}

describe("configured custody is observational", () => {
  it("keeps missing-items admission debt and refuses to infer initial bootstrap", async () => {
    const f = await fixture();
    const read = () => readCodexGoalConsumedOutputLedgers({ roots: [f.ledger] });
    const admission = async () => evaluateProjectAdmission({
      request: { operation: ProjectOperation.CreateJob },
      snapshot: { schemaVersion: 1, projectId: "project", observedAt: new Date().toISOString(), debt: (await read()).debt },
    });
    expect(await admission()).toMatchObject({ allowed: false, reason: "unreadable_project_state" });
    await expect(assertConfiguredProjectControlCustodyItemsPresent(
      f.controller.projectAccessScope!, f.custody)).rejects.toThrow("missing_or_unsafe_state");
    expect(await readdir(f.ledger)).toEqual([]);
    expect(await admission()).toMatchObject({ allowed: false });
    await expect(readFile(join(f.root, "project-controller.project-control-events.jsonl"))).rejects.toThrow();
  });

  it.each(["file", "symlink", "dangling"])("rejects %s items without changing custody", async kind => {
    const f = await fixture();
    const items = join(f.ledger, "items");
    if (kind === "file") await writeFile(items, "sentinel");
    else await symlink(kind === "symlink" ? f.workspace : join(f.root, "absent"), items);
    await expect(assertConfiguredProjectControlCustodyItemsPresent(
      f.controller.projectAccessScope!, f.custody)).rejects.toThrow();
    expect(await readdir(f.workspace)).toEqual([]);
    if (kind === "file") expect(await readFile(items, "utf8")).toBe("sentinel");
  });
});

describe("canonical remote scope recovery", () => {
  it("permits only an exact existing fetch and push origin mapping", async () => {
    const f = await fixture();
    const existing = f.controller.projectAccessScope!;
    await git(f.workspace, ["init"]);
    await git(f.workspace, ["remote", "add", "origin", existing.allowedGitRemotes![0]!]);
    const input = { existing, proposed: { ...existing, allowedGitRemotes: ["origin"] }, workspacePath: f.workspace };
    await expect(assertProjectControlCanonicalScopeRepair(input)).resolves.toBeUndefined();
    await git(f.workspace, ["remote", "set-url", "--push", "origin", "https://example.com/other.git"]);
    await expect(assertProjectControlCanonicalScopeRepair(input)).rejects.toThrow("allowedGitRemotes_repair_denied");
    await git(f.workspace, ["config", "--unset", "remote.origin.pushurl"]);
    await git(f.workspace, ["remote", "set-url", "--add", "origin", "https://example.com/second.git"]);
    await expect(assertProjectControlCanonicalScopeRepair(input)).rejects.toThrow("allowedGitRemotes_repair_denied");
  });

  it("rejects alias additions, endpoint changes, broad scopes and unrelated scope widening", async () => {
    const f = await fixture();
    const existing = f.controller.projectAccessScope!;
    await git(f.workspace, ["init"]);
    await git(f.workspace, ["remote", "add", "origin", existing.allowedGitRemotes![0]!]);
    for (const remotes of [["upstream"], ["origin", "other"], ["https://example.com/other.git"], []]) {
      await expect(assertProjectControlCanonicalScopeRepair({ existing,
        proposed: { ...existing, allowedGitRemotes: remotes }, workspacePath: f.workspace,
      })).rejects.toThrow("allowedGitRemotes_repair_denied");
    }
    await expect(assertProjectControlCanonicalScopeRepair({
      existing: { ...existing, workspaceRoots: [f.root] },
      proposed: { ...existing, workspaceRoots: [f.root], allowedGitRemotes: ["origin"] },
      workspacePath: f.workspace,
    })).rejects.toThrow("allowedGitRemotes_repair_denied");
    await expect(assertProjectControlCanonicalScopeRepair({ existing,
      proposed: { ...existing, allowedGitRemotes: ["origin"], allowForcePush: true }, workspacePath: f.workspace,
    })).rejects.toThrow("allowForcePush_repair_denied");
    await expect(assertProjectControlCanonicalScopeRepair({
      existing: { ...existing, deniedRoots: [f.workspace] },
      proposed: { ...existing, deniedRoots: [f.workspace], allowedGitRemotes: ["origin"] },
      workspacePath: f.workspace,
    })).rejects.toThrow("allowedGitRemotes_repair_denied");
  });
});

it("keeps loading and previews observational and appends ready account-d without relaxing account rejection", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createCodexGoalMcpServer } = await import("../codex-goal-mcp");
  const { callToolJson, writeFakeAuth } = await import("./codex-goal-mcp-test-support");
  const { createCodexGoalJob, readCodexGoalJob } = await import("../codex-goal-jobs");
  const { loadProjectControlController } = await import("../codex-goal-mcp-project-control-deps");
  const f = await fixture();
  const registryRootDir = join(f.root, "registry");
  const authRootDir = join(f.root, "auth");
  const scope = { ...f.controller.projectAccessScope!, registryRoot: registryRootDir,
    authRoot: authRootDir, jobIdPrefixes: ["project-"], tmuxSessionPrefixes: ["project-"],
  };
  await writeFakeAuth(authRootDir, "account-a", { lastRefresh: new Date().toISOString() });
  await writeFakeAuth(authRootDir, "account-d", { lastRefresh: new Date().toISOString() });
  await git(f.workspace, ["init"]);
  await git(f.workspace, ["remote", "add", "origin", scope.allowedGitRemotes![0]!]);
  await createCodexGoalJob({ registryRootDir,
    manifest: { ...f.controller, projectAccessScope: scope, authRootDir },
  });
  // Simulate an already-persisted controller from before items materialization.
  await rename(join(f.ledger, "items"), join(f.ledger, "saved-items"));
  const loaded = await loadProjectControlController({ registryRootDir, controllerJobId: f.controller.jobId });
  expect(loaded.scope).toEqual(expect.objectContaining(scope));
  await expect(readdir(join(f.ledger, "items"))).rejects.toThrow();
  const server = createCodexGoalMcpServer();
  const client = new Client({ name: "bootstrap-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const args = { registryRootDir, controllerJobId: f.controller.jobId,
      projectAccessScope: { ...loaded.scope, allowedGitRemotes: ["origin"], allowedAccountIds: ["account-a", "account-d"] },
    };
    expect(await callToolJson(client, "codex_goal_project_update_controller_scope", args)).toMatchObject({ reason: "confirm_update_required" });
    expect((await readCodexGoalJob({ registryRootDir, jobId: f.controller.jobId })).projectAccessScope?.allowedAccountIds).toEqual(["account-a"]);
    await expect(readdir(join(f.ledger, "items"))).rejects.toThrow();
    await expect(readFile(join(f.root, "project-controller.project-control-events.jsonl"))).rejects.toThrow();
    expect(await callToolJson(client, "codex_goal_project_update_controller_scope", { ...args, confirmUpdate: true })).toMatchObject({ ok: false });
    await expect(readdir(join(f.ledger, "items"))).rejects.toThrow();
    // Restore real saved state; a confirmed scope change must not manufacture an empty replacement.
    await rename(join(f.ledger, "saved-items"), join(f.ledger, "items"));
    expect(await callToolJson(client, "codex_goal_project_update_controller_scope", { ...args, confirmUpdate: true })).toMatchObject({ ok: true });
    const updated = await readCodexGoalJob({ registryRootDir, jobId: f.controller.jobId });
    expect(updated.projectAccessScope?.allowedAccountIds).toEqual(["account-a", "account-d"]);
    expect(updated.projectAccessScope?.allowedGitRemotes).toEqual(["origin"]);
    for (const accounts of [["account-d"], ["account-a", "account-d", "account-missing"], ["account-a", "account-d", "../escape"]]) {
      expect(await callToolJson(client, "codex_goal_project_update_controller_scope", {
        ...args, confirmUpdate: true,
        projectAccessScope: { ...updated.projectAccessScope, allowedAccountIds: accounts },
      })).toMatchObject({ ok: false });
    }
    expect((await readCodexGoalJob({ registryRootDir, jobId: f.controller.jobId })).projectAccessScope).toEqual(updated.projectAccessScope);
    const audit = (await readFile(join(f.root, "project-controller.project-control-events.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    expect(audit.filter(event => event.operation === "controller_scope").map(event => event.phase)).toEqual(["requested", "applied"]);
  } finally { await client.close(); await server.close(); }
});
