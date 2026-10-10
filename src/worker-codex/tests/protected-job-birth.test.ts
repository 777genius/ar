import { host, setupResearchFixture, cleanupResearchFixture } from "./research-launch-fixture";
import { AsyncResource } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCodexGoalJob, readCodexGoalJob, type CodexGoalJobManifest } from "../codex-goal-jobs";
import { observeProtectedCodexGoalJobBirth, recordProtectedCodexGoalJobFirstEffect } from "../protected-job-birth";
import { grantOwnedMimoWorkerLaunch } from "../research-launch-owner";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import { createFixture, createScope } from "./codex-goal-project-refill-fixture";
import { callToolJson, git, gitStdout } from "./codex-goal-mcp-test-support";
import { observeResearchJobWriterAuthority } from "../research-writer-observation";
import { recordRawGoalStateOrigin } from "../application/project-control/codex-goal-controller-state-location";
import { withProjectAdmissionPublicationLock } from "../codex-goal-project-workspace-lock";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
const registryRootDir = "/TEST-project/registry";
async function create(id: string, existingRoot = false): Promise<CodexGoalJobManifest> {
  const jobRootDir = "/TEST-project/jobs/" + id, workspacePath = "/TEST-project/workspaces/" + id;
  mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
  if (existingRoot) mkdirSync(jobRootDir, { recursive: true, mode: 0o700 });
  return await createCodexGoalJob({ registryRootDir, manifest: {
    jobId: id, taskId: id, jobRootDir, workspacePath, promptPath: join(jobRootDir, "prompt.md"), accounts: ["TEST-a"],
  } });
}

// RED: a public marker, an existing root, manifest restoration or inode
// replacement can manufacture positive no-start authority after controlled create.
it.skipIf(process.platform !== "linux")("binds fresh controlled birth to exact manifest and physical roots", async () => {
  const legacy = await create("TEST-legacy", true);
  writeFileSync(join(legacy.jobRootDir, ".controller-state-origin.json"), JSON.stringify({
    schemaVersion: 2, jobId: legacy.jobId, createdAt: legacy.createdAt,
  }), { mode: 0o600 });
  expect(await observeProtectedCodexGoalJobBirth(legacy)).toEqual({ status: "unknown" });
  const fresh = await create("TEST-fresh");
  expect(await observeProtectedCodexGoalJobBirth(fresh)).toEqual({ status: "released" });
  const manifestPath = join(registryRootDir, fresh.jobId, "job.json"), bytes = readFileSync(manifestPath);
  writeFileSync(manifestPath, bytes); // Identical JSON cannot restore the sealed file generation.
  expect(await observeProtectedCodexGoalJobBirth(fresh)).toEqual({ status: "unknown" });
  const replaced = await create("TEST-replaced");
  renameSync(replaced.jobRootDir, replaced.jobRootDir + "-old"); mkdirSync(replaced.jobRootDir, { mode: 0o700 });
  expect(await observeProtectedCodexGoalJobBirth(replaced)).toEqual({ status: "unknown" });
  host.namespaceRoot = true;
  expect(await observeProtectedCodexGoalJobBirth(await create("TEST-unsupported"))).toEqual({ status: "unknown" });
});

// RED: sealing after manifest publication turns a legacy future workspace into
// an error, or skipping an unsupported lexical alias misses physical first use.
it.skipIf(process.platform !== "linux")("preserves legacy future workspaces and invalidates canonical spaces aliases", async () => {
  const futureRoot = "/TEST-project/jobs/TEST-future-workspace";
  const future = await createCodexGoalJob({ registryRootDir, manifest: {
    jobId: "TEST-future-workspace", taskId: "TEST-future-workspace", jobRootDir: futureRoot,
    workspacePath: "/TEST-project/future-workspace", promptPath: join(futureRoot, "prompt.md"), accounts: ["TEST-a"],
  } });
  expect(readFileSync(join(registryRootDir, future.jobId, "job.json"), "utf8")).toContain(future.jobId);
  expect(existsSync(futureRoot)).toBe(false);
  expect(await observeProtectedCodexGoalJobBirth(future)).toEqual({ status: "unknown" });
  const spaceRoot = "/TEST-project/jobs/TEST legacy spaces", spaceWorkspace = "/TEST-project/workspaces/TEST legacy spaces";
  mkdirSync(spaceWorkspace, { recursive: true, mode: 0o700 });
  const spaces = await createCodexGoalJob({ registryRootDir, manifest: {
    jobId: "TEST-legacy-spaces", taskId: "TEST-legacy-spaces", jobRootDir: spaceRoot,
    workspacePath: spaceWorkspace, promptPath: join(spaceRoot, "prompt.md"), accounts: ["TEST-a"],
  } });
  expect(existsSync(spaceRoot)).toBe(false);
  expect(await observeProtectedCodexGoalJobBirth(spaces)).toEqual({ status: "unknown" });
  const protectedJob = await create("TEST-space-alias"), alias = "/TEST-project/jobs/TEST canonical spaces alias";
  expect(await observeProtectedCodexGoalJobBirth(protectedJob)).toEqual({ status: "released" });
  host.pins.set(alias, protectedJob.jobRootDir);
  recordRawGoalStateOrigin(alias);
  expect(await observeProtectedCodexGoalJobBirth(protectedJob)).toEqual({ status: "unknown" });
});

// RED: an awaited census releases its never-started fence before the existing
// claim is published, permitting a raw start between observation and claim.
it.skipIf(process.platform !== "linux")("fences concurrent raw first effect through census and claim, then invalidates permanently", async () => {
  const job = await create("TEST-race"), outsider = new AsyncResource("TEST-independent-raw-start");
  let continueCensus!: () => void, censusEntered!: () => void;
  const held = new Promise<void>(resolve => { continueCensus = resolve; });
  const entered = new Promise<void>(resolve => { censusEntered = resolve; });
  const claimPath = join(registryRootDir, job.jobId, "existing-claim.json");
  const admission = withProjectAdmissionPublicationLock({ registryRootDir, owner: "TEST-census", effect: async () => {
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "released" });
    censusEntered(); await held;
    expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "released" });
    recordProtectedCodexGoalJobFirstEffect(job.jobRootDir);
    writeFileSync(claimPath, '{"status":"launch_authorized"}\n', { mode: 0o600 });
  } });
  await entered;
  try {
    expect(() => outsider.runInAsyncScope(() => recordRawGoalStateOrigin(job.jobRootDir)))
      .toThrow("protected_job_birth_publication_busy");
  } finally { continueCensus(); }
  await admission;
  expect(readFileSync(claimPath, "utf8")).toContain("launch_authorized");
  let releaseSibling!: () => void, siblingEntered!: () => void;
  const siblingHeld = new Promise<void>(resolve => { releaseSibling = resolve; });
  const siblingReady = new Promise<void>(resolve => { siblingEntered = resolve; });
  const sibling = withProjectAdmissionPublicationLock({ registryRootDir, owner: "TEST-sibling-census", effect: async () => {
    siblingEntered(); await siblingHeld;
  } });
  await siblingReady;
  try {
    // Real native grant publication rechecks permanent negative history while
    // the independent sibling owns the entire awaited census section.
    outsider.runInAsyncScope(() => grantOwnedMimoWorkerLaunch(job.jobId, job.jobRootDir, job.workspacePath));
  } finally { releaseSibling(); }
  await sibling;
  const alias = "/TEST-project/jobs/TEST-race-alias";
  host.pins.set(alias, job.jobRootDir);
  outsider.runInAsyncScope(() => recordRawGoalStateOrigin(alias));
  unlinkSync(join(job.jobRootDir, ".controller-state-origin.json"));
  writeFileSync(join(job.jobRootDir, ".controller-state-origin.json"), JSON.stringify({
    schemaVersion: 2, jobId: job.jobId, createdAt: job.createdAt,
  }), { mode: 0o600 });
  expect(await observeProtectedCodexGoalJobBirth(job)).toEqual({ status: "unknown" });
  outsider.emitDestroy();
});


// RED: public refill writes prompt/admission files before createJob, so a
// create-only mkdir at manifest publication misses the actual fresh birth.
it.skipIf(process.platform !== "linux")("preserves protected birth across actual public refill prompt preparation", async () => {
  const f = await createFixture(), server = createCodexGoalMcpServer();
  const client = new Client({ name: "TEST-protected-refill-birth", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const authRootDir = join(f.root, "auth");
  const registryRootDir = join(f.root, "worker-jobs", "registry"), controllerRoot = join(f.root, "worker-jobs", "test-controller");
  const childRoot = join(f.root, "worker-jobs", "test-child"), workspacePath = join(f.root, "worktrees", "test-child");
  try {
    mkdirSync(authRootDir, { recursive: true, mode: 0o700 });
    // Exercise the same real ownership-bound serial contract as native refill.
    for (const name of ["controller.md", "lane.md", "checks/README.md"]) {
      await mkdir(join(f.sourceWorkspacePath, name === "checks/README.md" ? "checks" : "."), { recursive: true });
      await writeFile(join(f.sourceWorkspacePath, name), "TEST admission input.\n");
    }
    await git(f.sourceWorkspacePath, ["add", "."]);
    await git(f.sourceWorkspacePath, ["commit", "-m", "test: prepare scoped refill inputs"]);
    const phaseStartSha = (await gitStdout(f.sourceWorkspacePath, ["rev-parse", "HEAD"])).trim();
    const remote = join(f.root, "origin.git");
    await git(f.root, ["init", "--bare", remote]);
    await git(f.sourceWorkspacePath, ["remote", "add", "origin", remote]);
    await git(f.sourceWorkspacePath, ["push", "origin", "HEAD:main"]);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(await callToolJson(client, "codex_goal_create_job", {
      registryRootDir, jobId: "test-controller", jobRootDir: controllerRoot, taskId: "test-controller",
      workspacePath: f.sourceWorkspacePath, promptPath: join(controllerRoot, "prompt.md"), accounts: ["account-a"], authRootDir,
      accessBoundary: AccessBoundary.ProjectScopedControl,
      projectAccessScope: { ...createScope(f), registryRoot: registryRootDir, jobIdPrefixes: ["test-"],
        tmuxSessionPrefixes: ["test-"], allowedBranches: ["main", "test/test-*"],
        allowedAccountIds: ["account-a"], allowedGitRemotes: ["origin"],
        preStartAdmission: { required: true, mode: "serial-builtin" } },
    })).toMatchObject({ ok: true });
    const controller = await readCodexGoalJob({ registryRootDir, jobId: "test-controller" });
    expect(await observeProtectedCodexGoalJobBirth(controller)).toEqual({ status: "released" });
    expect(await observeResearchJobWriterAuthority(controller)).toEqual({ status: "released" });
    const result = await callToolJson(client, "codex_goal_project_refill_worker", {
      registryRootDir, controllerJobId: "test-controller", jobId: "test-child", taskId: "test-child",
      jobRootDir: childRoot, sourceWorkspacePath: f.sourceWorkspacePath, baseBranch: "main",
      expectedSourceCommit: phaseStartSha, newBranch: "test/test-child", workspacePath,
      promptPath: join(childRoot, "prompt.md"), promptBody: "TEST fresh controlled preparation.\n",
      accounts: ["account-a"], authRootDir, startWorker: false, confirmRefill: true, executionMode: "sync",
      confirmPreStartAdmission: true,
      preStartAdmission: { mode: "serial-builtin", contract: {
        kind: "worker-launch", format: 1, canonicalSha: phaseStartSha, baseSha: phaseStartSha, phaseStartSha,
        packetRevision: "test-r1", controllerPacket: "controller.md", lanePacket: "lane.md",
        phaseId: "phase-01", laneId: "lane-a", inputPatchHash: null, reviewKind: "implementation",
        ownedPaths: ["output.txt"], mandatoryDocs: ["README.md", "controller.md", "lane.md"],
        mandatoryScripts: [], mandatoryFixtures: [],
        requiredChecks: [{ id: "diff", cwd: "checks", command: "git diff --check" }],
        executionPolicy: { mode: "sandbox-only", sandboxRoot: workspacePath,
          forbiddenRealProjects: [join(f.root, "FORBIDDEN-real-project")] },
      } },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, startSkipped: true });
    expect(await readFile(join(childRoot, "prompt.md"), "utf8")).toBe("TEST fresh controlled preparation.\n");
    expect(await observeProtectedCodexGoalJobBirth(result.manifest as CodexGoalJobManifest)).toEqual({ status: "released" });
  } finally {
    await client.close(); await server.close(); await rm(f.root, { recursive: true, force: true });
  }
});
