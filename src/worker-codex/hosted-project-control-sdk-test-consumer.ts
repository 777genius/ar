import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "@vioxen/subscription-runtime/core";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedDependencyPhysicalWorkspaceInspection } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { createCodexGoalMcpServer } from "./codex-goal-mcp";
import { readCodexGoalJob } from "./codex-goal-jobs";
import { publishOriginalHostedProjectControlAllocation } from "./protected-job-birth.js";
import { assertOriginalFullProjectControlSetupCurrent } from "./hosted-project-control-native-origin.js";
import { closeOriginalHostedProjectControlAllocation, holdOriginalHostedProjectControlAllocationError,
  originalHostedProjectControlWorkspaceInspectionSelection, prepareOriginalHostedProjectControlAllocation,
  prepareOriginalHostedProjectControlSourceFixture, runOriginalHostedProjectControlGit } from "./hosted-project-control-native-allocation.js";
import { OriginalControlGitOperation as GitOperation, OriginalControlGitRole as GitRole, originalControlGitBranch } from "./hosted-project-control-git-recipe.js";

enum SdkTool { Create = "codex_goal_create_job", Refill = "codex_goal_project_refill_worker" }
export enum OriginalSdkObservationKind { PublicSourceOnly = "original_public_sdk_source_only_v1" }
let issued = false;

/** Real public TEST SDK consumer. No caller supplies an allocation, account
 * readiness, result, scope, native handle or clock. It never starts a provider. */
export async function runOriginalHostedProjectControlSdkTestConsumer(): Promise<Readonly<{
  kind: OriginalSdkObservationKind; jobId: string; revision: string; tree: string;
  workspace: Readonly<{ canonicalPath: string; dev: string; ino: string }>;
}>> {
  assertOriginalFullProjectControlSetupCurrent(); assert(!issued); issued = true;
  try {
  const allocation = prepareOriginalHostedProjectControlAllocation();
  const sourceGit = async (operation: GitOperation, revision: string | null = null) => {
    const result = await runOriginalHostedProjectControlGit(GitRole.Source, operation, revision);
    assert.equal(result.code, 0); assert.equal(result.signal, ""); return result.stdout.trim();
  };
  prepareOriginalHostedProjectControlSourceFixture();
  await sourceGit(GitOperation.InitSource);
  for (const operation of [GitOperation.Author, GitOperation.Committer])
    assert.match(await sourceGit(operation), /^iliya <iliyazelenkog@gmail\.com> [0-9]+ [+-][0-9]{4}$/);
  await sourceGit(GitOperation.AddSource); await sourceGit(GitOperation.CommitSource);
  const revision = await sourceGit(GitOperation.Head), tree = await sourceGit(GitOperation.Tree);
  assert.match(revision, /^[a-f0-9]{40}$/); assert.match(tree, /^[a-f0-9]{40}$/);
  await sourceGit(GitOperation.AddLinked, revision);
  assert(lstatSync(allocation.workspace + "/.git").isFile());
  let rejectedLinked = false;
  try { assertHostedDependencyPhysicalWorkspaceInspection(originalHostedProjectControlWorkspaceInspectionSelection()); }
  catch (error) {
    if (!(error instanceof DependencyAdmissionError) || error.reason !== DependencyAdmissionFailure.Unsupported) throw error;
    rejectedLinked = true;
  }
  assert(rejectedLinked); await sourceGit(GitOperation.RemoveLinked);
  publishOriginalHostedProjectControlAllocation();

  const server = createCodexGoalMcpServer(), client = new Client({ name: "TEST-original-public-sdk", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let primaryFailed = false;
  let observedWorkspace: ReturnType<typeof originalHostedProjectControlWorkspaceInspectionSelection> | undefined;
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const call = async (name: SdkTool, args: Record<string, unknown>) => {
      assertOriginalFullProjectControlSetupCurrent();
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as readonly { type?: unknown; text?: unknown }[];
      const first = content[0]; assert(first?.type === "text" && typeof first.text === "string" && Buffer.byteLength(first.text) <= 1024 * 1024);
      const value: unknown = JSON.parse(first.text); assert(value && typeof value === "object" && !Array.isArray(value));
      // Never put raw tool/provider failures or auth payloads in TEST evidence.
      if (!("ok" in value) || value.ok !== true) throw new Error("TEST_original_sdk_tool_failed:" + name);
      assertOriginalFullProjectControlSetupCurrent();
    };
    // This fixed missing-auth slot is metadata only. Existing public capacity
    // selection remains unchanged; startWorker:false cannot assert readiness.
    const accounts = ["account-test-sdk-metadata"];
    const scope = { projectId: "TEST-original-sdk", workspaceRoots: [allocation.source], readRoots: [allocation.jobRootDir],
      worktreeRoots: [allocation.workspace], registryRoot: allocation.registry, authRoot: allocation.auth,
      jobIdPrefixes: ["TEST-"], tmuxSessionPrefixes: ["TEST-"], allowedBranches: ["main", revision, originalControlGitBranch],
      allowedGitRemotes: ["origin"], allowedAccountIds: accounts };
    await call(SdkTool.Create, { jobId: allocation.controllerId, taskId: allocation.controllerId,
      registryRootDir: allocation.registry, jobRootDir: allocation.controllerRoot, workspacePath: allocation.source,
      promptPath: allocation.controllerRoot + "/prompt.md", promptBody: "Original public TEST SDK controller.\n",
      authRootDir: allocation.auth, accounts, executionEngine: "app-server-goal",
      accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: scope });
    const request = { controllerJobId: allocation.controllerId, jobId: allocation.jobId, taskId: allocation.jobId,
      registryRootDir: allocation.registry, jobRootDir: allocation.jobRootDir, workspacePath: allocation.workspace,
      cwd: allocation.workspace, sourceWorkspacePath: allocation.source, baseBranch: "main", sourceRef: revision,
      newBranch: originalControlGitBranch, promptBody: "Original public physical SDK TEST.\n", authRootDir: allocation.auth,
      accounts, stateRootDir: allocation.jobRootDir + "/state", progressPath: allocation.jobRootDir + "/" + allocation.jobId + ".progress.json",
      logPath: allocation.jobRootDir + "/" + allocation.jobId + ".log", outputPath: allocation.jobRootDir + "/" + allocation.jobId + ".latest-result.json",
      executionEngine: "app-server-goal", durableHandoffRootDir: allocation.durableHandoffs, prewarmOnStart: false,
      startWorker: false, confirmRefill: true };
    await call(SdkTool.Refill, request);
    const manifest = await readCodexGoalJob({ registryRootDir: allocation.registry, jobId: allocation.jobId });
    assert.equal(manifest.workspacePath, allocation.workspace); assert.deepEqual(manifest.projectAccessScope?.workspaceRoots, [allocation.workspace]);
    observedWorkspace = originalHostedProjectControlWorkspaceInspectionSelection();
    assertHostedDependencyPhysicalWorkspaceInspection(observedWorkspace);
    assert(lstatSync(allocation.workspace + "/.git").isDirectory());
    assert(!readdirSync(allocation.workspace + "/.git").includes("commondir"));
    assert.equal(readFileSync(allocation.workspace + "/README.md", "utf8"), "Original public standalone SDK Source fixture.\n");
    for (const [operation, expected] of [[GitOperation.Head, revision], [GitOperation.Tree, tree], [GitOperation.Branch, originalControlGitBranch], [GitOperation.Remote, ""]] as const) {
      const result = await runOriginalHostedProjectControlGit(GitRole.PublishedChild, operation);
      assert.equal(result.code, 0); assert.equal(result.signal, ""); assert.equal(result.stdout.trim(), expected);
    }
    await call(SdkTool.Refill, request);
    assert.deepEqual(originalHostedProjectControlWorkspaceInspectionSelection(), observedWorkspace);
    assertHostedDependencyPhysicalWorkspaceInspection(observedWorkspace);
  } catch (error) { primaryFailed = true; holdOriginalHostedProjectControlAllocationError(); throw error; }
  finally {
    const errors: unknown[] = [];
    try { await client.close(); } catch (error) { errors.push(error); }
    try { await server.close(); } catch (error) { errors.push(error); }
    if (errors.length) { holdOriginalHostedProjectControlAllocationError(); if (!primaryFailed) throw new AggregateError(errors, "TEST_original_sdk_transport_close_held"); }
  }
  assert(observedWorkspace); closeOriginalHostedProjectControlAllocation();
  return Object.freeze({ kind: OriginalSdkObservationKind.PublicSourceOnly, jobId: allocation.jobId, revision, tree,
    workspace: observedWorkspace.workspace });
  } catch (error) { holdOriginalHostedProjectControlAllocationError(); throw error; }
}
