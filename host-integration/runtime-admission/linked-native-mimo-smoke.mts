#!/usr/bin/env node
/** One real, bounded NEW TEST composition. No provider or owner port is replaced.
 * Run --help for prerequisites. This file does not install/activate a runtime. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectAccessScope, ProjectAdmissionSummary } from "../../src/worker-core/index";
import type { CodexGoalJobManifest } from "../../src/worker-codex/codex-goal-jobs";
import type { ProjectControlMcpArgs } from "../../src/worker-codex/codex-goal-mcp-inputs";

type Json = Record<string, unknown>;
type Config = {
  schemaVersion: 1; runtimeDirectory: string; candidateCommit: string;
  expectedArtifactSha256: string; expectedMachineId: string;
  testParentDirectory: string; authRootDir: string; codexBinaryPath: string;
};
type NativeStart = { jobId: string; startId: string; specSha256: string; requestSha256: string; unit: string;
  artifactSha256: string; grantSha256: string; receiptSha256: string; directory: string };
type HashLeaf = { path: string; bytes: number; sha256: string };
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function check(condition: unknown, code: string): asserts condition { assert(condition, `TEST_smoke_${code}`); }
function record(value: unknown): Json { check(value && typeof value === "object" && !Array.isArray(value), "object_required"); return value as Json; }
function text(value: unknown): string { check(typeof value === "string", "text_required"); return value; }
function finiteCode(value: unknown): string | undefined {
  return typeof value === "string" ? /^[A-Za-z][A-Za-z0-9_]{0,159}(?=[:;\s]|$)/.exec(value)?.[0] : undefined;
}
const code = (error: unknown): string => finiteCode(error instanceof Error ? error.message : undefined) ?? "TEST_smoke_operation_failed";
const help = `Run only on the authorized TEST Linux host, as initial-host root in PID 1's user/mnt/pid/net namespaces.
The native route refuses hosts with /var/lib/subscription-runtime-host-policy or /run/user/0/subscription-runtime-host-policy.
Do not remove these fences, set sharedcurrent/host-activation-mode, or activate over the shared runtime to make this pass.

Prerequisites, prepared through the existing operator installation procedure:
- One immutable root-owned candidate containing this runner, built dist, and its exact dependencies; no group/other writes or external dependency symlinks.
- Its qualified Node must support native .mts type stripping. That exact process.execPath is pinned into the native start, so invoke the approved Node binary explicitly when it differs from PATH.
- Independently qualified source candidateCommit and expectedArtifactSha256 from researchArtifactDigest(runtimeDirectory), plus the inventory-verified expectedMachineId.
- Root-owned canonical TEST parent on the approved scratch filesystem, with existing native scratch policy/layout and required free space. The runner creates one exclusive random TEST child; no existing project input is accepted.
- Supported root-owned codex binary and configured MiMo account-q/auth root. Do not put keys or credentials in the config. Existing account/provider admission remains authoritative.
- Native writable-root/provider-root qualification and systemd host prerequisites must already pass for this exact artifact. Unsupported hosts fail closed; this runner does not bootstrap them.

Hosted static verification (after the source candidate is prepared):
  npm run typecheck
Live launch prerequisite remains unresolved: host-job-cli's existing managed payload enters private namespaces and drops privilege, so it fails the native initial-root operator preflight. Its outer-job-only contract also cannot own these detached native starts.
Do not weaken that profile or use an unmanaged foreground/background fallback. A separately authorized fixed TEST root-operator service bootstrap must bind this exact runner/config/artifact and retain its own finite deadline plus native-start reconciliation before live execution.
The bootstrap's fixed argv is the qualified Node, this installed runner, --allow-live, and the exact private config path below; this is invocation data, not a supported current host-job profile.
Config fields, all required:
  {"schemaVersion":1,"runtimeDirectory":"/QUALIFIED/CANDIDATE","candidateCommit":"40-or-64-hex-source-commit","expectedArtifactSha256":"64-hex-qualified-artifact","expectedMachineId":"32-hex-inventory-machine-id","testParentDirectory":"/ROOT-OWNED/APPROVED-TEST-PARENT","authRootDir":"/CONFIGURED/ROOT-OWNED/AUTH-ROOT","codexBinaryPath":"/QUALIFIED/CODEX"}

Exactly three provider attempts are planned: finalized retained history, sibling A, sibling B. There is no automatic launch retry.
Sibling tasks read/process 40 actual TEST inputs using enabled workspace MCP tools. No unavailable shell/sleep tool is requested. Live A/B overlap must be observed; finishing too quickly fails without retry.
The collision and same-operation retry must not create a fourth attempt. A 20-minute scenario deadline bounds MCP requests and observation; late success is rejected.
Qualification and exact-start cleanup run outside that scenario deadline with existing finite native timeouts. Do not hard-exit the process at the scenario deadline, because that would skip reconciliation.
Cleanup cancels only exact starts allocated by this run. Evidence/worktrees/pins remain for review; no recursive removal or shared process cleanup occurs.
A failed or uncertain operation emits a failed report and keeps its identity for reconciliation. Re-running creates a new TEST composition and is not recovery of an uncertain start.
`;
if (process.argv.includes("--help")) { process.stdout.write(help); } else {
  check(process.argv.length === 4 && process.argv[2] === "--allow-live", "use_help_or_allow_live_config");
  await main(process.argv[3]!).catch(error => { process.stderr.write(JSON.stringify({ outcome: "unsupported-prerequisite", code: code(error) }) + "\n"); process.exitCode = 1; });
}

async function main(configPath: string): Promise<void> {
  const config = record(JSON.parse(readFileSync(configPath, "utf8"))) as unknown as Config;
  const fields = ["schemaVersion", "runtimeDirectory", "candidateCommit", "expectedArtifactSha256", "expectedMachineId", "testParentDirectory", "authRootDir", "codexBinaryPath"];
  check(Object.keys(config).sort().join() === fields.sort().join() && config.schemaVersion === 1, "config_shape");
  check(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(config.candidateCommit) && /^[a-f0-9]{64}$/.test(config.expectedArtifactSha256) && /^[a-f0-9]{32}$/.test(config.expectedMachineId), "qualification_identity");
  for (const path of [config.runtimeDirectory, config.testParentDirectory, config.authRootDir, config.codexBinaryPath, configPath]) {
    check(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, "canonical_input_required");
  }
  check(realpathSync(fileURLToPath(import.meta.url)) === join(config.runtimeDirectory, "host-integration/runtime-admission/linked-native-mimo-smoke.mts"), "runner_must_belong_to_qualified_candidate");
  const moduleUrl = (name: string): string => pathToFileURL(join(config.runtimeDirectory, "dist", name + ".js")).href;
  const host: typeof import("../../src/worker-codex/research-launch-host") = await import(moduleUrl("worker-codex/research-launch-host"));
  const files: typeof import("../../src/worker-codex/research-launch-files") = await import(moduleUrl("worker-codex/research-launch-files"));
  const admission: typeof import("../../src/worker-codex/research-launch-admission") = await import(moduleUrl("worker-codex/research-launch-admission"));
  const lifecycle: typeof import("../../src/worker-codex/research-launch-lifecycle") = await import(moduleUrl("worker-codex/research-launch-lifecycle"));
  const writers: typeof import("../../src/worker-codex/research-writer-observation") = await import(moduleUrl("worker-codex/research-writer-observation"));
  const jobs: typeof import("../../src/worker-codex/codex-goal-jobs") = await import(moduleUrl("worker-codex/codex-goal-jobs"));
  const core: typeof import("../../src/worker-core/index") = await import(moduleUrl("worker-core/index"));
  const provider: typeof import("../../src/provider-codex/index") = await import(moduleUrl("provider-codex/index"));
  const mcp: typeof import("../../src/worker-codex/codex-goal-mcp") = await import(moduleUrl("worker-codex/codex-goal-mcp"));
  host.assertResearchInitialRoot(true); host.assertResearchSharedHost();
  for (const path of [configPath, config.runtimeDirectory, config.testParentDirectory, config.authRootDir, config.codexBinaryPath]) files.researchCustody(path);
  check(admission.installedResearchRuntimeDirectory() === config.runtimeDirectory, "installed_runtime_mismatch");
  const machine = host.researchProcessIdentity();
  check(machine.machineId === config.expectedMachineId, "machine_identity_changed");
  check(files.researchArtifactDigest(config.runtimeDirectory) === config.expectedArtifactSha256, "artifact_qualification_changed");
  check(config.testParentDirectory !== config.authRootDir && !config.testParentDirectory.startsWith(config.authRootDir + "/") && !config.authRootDir.startsWith(config.testParentDirectory + "/"), "test_parent_auth_overlap");
  check(config.testParentDirectory !== config.runtimeDirectory && !config.testParentDirectory.startsWith(config.runtimeDirectory + "/") && !config.runtimeDirectory.startsWith(config.testParentDirectory + "/"), "test_parent_artifact_overlap");
  const runId = "TEST-runtime-admission-" + randomUUID();
  const root = join(config.testParentDirectory, runId);
  mkdirSync(root, { mode: 0o700 });
  const source = join(root, "source"), worktrees = join(root, "worktrees"), jobRoots = join(root, "jobs"), registryRootDir = join(root, "registry");
  for (const path of [source, worktrees, jobRoots, registryRootDir]) mkdirSync(path, { mode: 0o700 });
  const jobPrefix = runId.toLowerCase() + "-"; // Builtin worker-launch identifiers are lowercase; the exclusive project directory retains TEST.
  const controllerJobId = jobPrefix + "controller", oldId = jobPrefix + "old", aId = jobPrefix + "a", bId = jobPrefix + "b", collisionId = jobPrefix + "collision", idleId = jobPrefix + "never-started";
  const reportPath = join(root, "report.json"), starts = new Map<string, NativeStart>();
  const report: Json = { schemaVersion: 1, runId, root, candidateCommit: config.candidateCommit, runtimeDirectory: config.runtimeDirectory,
    artifactSha256: config.expectedArtifactSha256, machineId: machine.machineId, bootId: machine.bootId,
    plannedJobIds: { controllerJobId, oldId, aId, bId, collisionId, idleId }, observations: [], cleanup: [], outcome: "running" };
  const observations = report.observations as Json[], cleanup = report.cleanup as Json[];
  const publicRequests: Json[] = []; report.publicRequests = publicRequests;
  const save = (): void => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const deadline = Date.now() + 20 * 60_000;
  const observe = (name: string, evidence: Json): void => { check(Date.now() < deadline, "total_deadline"); observations.push({ name, at: new Date().toISOString(), ...evidence }); save(); process.stdout.write(JSON.stringify({ name, reportPath }) + "\n"); };
  let phase = "source-bootstrap", oldHashes: HashLeaf[] | undefined;
  const git = (cwd: string, args: string[]): string => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com", GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const waitFor = async (name: string, operation: () => boolean | Promise<boolean>, milliseconds = 6 * 60_000): Promise<void> => {
    const until = Math.min(deadline, Date.now() + milliseconds);
    while (Date.now() < until) {
      const complete = await operation();
      check(Date.now() < until, "deadline_" + name);
      if (complete) return;
      await delay(Math.min(1000, Math.max(1, until - Date.now())));
    }
    throw new assert.AssertionError({ message: "TEST_smoke_deadline_" + name });
  };
  const ownStart = (jobId: string): NativeStart | undefined => {
    try {
      const current = admission.researchCurrentStart(jobId), binding = current.spec.projectLaunchBinding;
      check(binding?.registryRootDir === registryRootDir && binding.controllerJobId === controllerJobId && current.spec.request.jobRootDir === join(jobRoots, jobId), "native_owner_binding");
      check(current.spec.runtimeDirectory === config.runtimeDirectory && current.spec.artifactSha256 === config.expectedArtifactSha256, "native_artifact_binding");
      const start: NativeStart = { jobId, startId: current.spec.startId, unit: current.spec.unit, directory: current.directory,
        specSha256: files.researchHash(current.bytes), requestSha256: current.spec.requestSha256, artifactSha256: current.spec.artifactSha256,
        grantSha256: current.spec.grantSha256, receiptSha256: binding.receiptSha256 };
      const expected = starts.get(jobId); if (expected) check(expected.startId === start.startId && expected.specSha256 === start.specSha256, "owned_start_replaced");
      starts.set(jobId, start); return start;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const nativeSnapshot = (jobId: string): Json => {
    const start = ownStart(jobId); check(start, "native_start_missing");
    const status = lifecycle.statusResearchLaunch(jobId);
    const providerUnits = lifecycle.researchProviderUnits(start.directory).sort();
    const startDirectories = readdirSync(join(admission.researchJobAuthority(jobId), "starts")).sort();
    return { ...start, active: status.active, providers: status.providers, providerUnits, startDirectories };
  };
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "TEST-linked-native-runtime-admission", version: "1" }), server = mcp.createCodexGoalMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const base = { registryRootDir, controllerJobId };
  const call = async (name: string, args: object): Promise<Json> => {
    const remainingMs = deadline - Date.now(); check(remainingMs > 0, "total_deadline");
    const input = args as Json;
    const request: Json = { sequence: publicRequests.length + 1, tool: name, phase, registryRootDir, controllerJobId,
      jobId: input.jobId, jobRootDir: input.jobRootDir, workspacePath: input.workspacePath ?? input.path,
      argumentsSha256: sha256(JSON.stringify(args)), dispatchedAt: new Date().toISOString(), state: "awaiting-response" };
    publicRequests.push(request); save();
    try {
      const response = await client.callTool({ name, arguments: input }, undefined, { timeout: Math.min(6 * 60_000, remainingMs) }) as CallToolResult;
      request.state = "response-received"; request.responseAt = new Date().toISOString();
      check(Date.now() < deadline, "total_deadline_after_" + name);
      const value = response.structuredContent ?? JSON.parse(text(response.content.find(item => item.type === "text")?.text));
      return record(value);
    } catch (error) {
      // Client timeout/transport rejection is not server-handler settlement.
      // Even absent current grant/start files cannot prove this request had no effect.
      if (request.state !== "response-received") { request.state = "unsettled"; request.retainedForReconciliation = true; }
      request.code = code(error); throw error;
    } finally { save(); }
  };
  const ok = async (name: string, args: object): Promise<Json> => {
    const response = await call(name, args);
    if (response.ok !== true) { report.toolFailure = { tool: name, reason: finiteCode(response.reason), error: finiteCode(response.error), ...(response.admission ? { admission: response.admission } : {}) }; save(); }
    check(response.ok === true, "public_tool_" + name); return response;
  };
  const summary = (response: Json, nested: string): ProjectAdmissionSummary => {
    const value = record(record(response[nested]).admission);
    const backlog = record(value.backlog); check(typeof backlog.count === "number" && backlog.count >= 1 && Array.isArray(backlog.preview) && backlog.preview.length <= 3, "bounded_retained_advisory");
    const summary = value as unknown as ProjectAdmissionSummary;
    process.stdout.write(`Admission advisory: ${summary.backlog.count} retained backlog records; ${summary.backlog.preview.map(item => item.reason).join(", ")}. The count describes records, not running workers.\n`);
    return summary;
  };
  try {
    git(source, ["init", "--quiet", "-b", "main"]);
    for (const name of ["README.md", "controller.md", "lane.md"]) writeFileSync(join(source, name), "NEW TEST linked native admission smoke. Edit output.txt only.\n", { mode: 0o600 });
    mkdirSync(join(source, "checks")); writeFileSync(join(source, "checks/README.md"), "Run git diff --check from this directory.\n", { mode: 0o600 });
    mkdirSync(join(source, "inputs"));
    const inputProofs: string[] = []; let expectedSum = 0;
    for (let index = 0; index < 40; index++) {
      const value = (index + 1) * 17, proof = sha256(runId + ":input:" + index); expectedSum += value; inputProofs.push(proof);
      writeFileSync(join(source, "inputs", `item-${String(index).padStart(2, "0")}.txt`), `value=${value}\nproof=${proof}\n`, { mode: 0o600 });
    }
    report.siblingTask = { inputFiles: 40, enabledTools: "workspace-MCP", expectedSum, orderedProofsSha256: sha256(inputProofs.join(",")) };
    git(source, ["add", "."]); git(source, ["commit", "--quiet", "-m", "test: initialize isolated runtime admission smoke"]);
    const revision = git(source, ["rev-parse", "HEAD"]);
    git(source, ["init", "--bare", "--quiet", join(root, "origin.git")]);
    git(source, ["remote", "add", "origin", join(root, "origin.git")]); git(source, ["push", "origin", "HEAD:main"]);
    const scope: ProjectAccessScope = { projectId: runId, readRoots: [root], workspaceRoots: [source], worktreeRoots: [worktrees],
      registryRoot: registryRootDir, authRoot: config.authRootDir, jobIdPrefixes: [jobPrefix], tmuxSessionPrefixes: [jobPrefix],
      allowedAccountIds: ["account-q"], allowedBranches: ["main", "test/test-*"], allowedGitRemotes: ["origin"], preStartAdmission: { required: false, mode: "serial-builtin" } };
    // Initial operator bootstrap only. Every worker below is created by a public MCP tool.
    await jobs.createCodexGoalJob({ registryRootDir, manifest: { jobId: controllerJobId, taskId: controllerJobId,
      workspacePath: source, jobRootDir: join(jobRoots, controllerJobId), promptPath: join(jobRoots, controllerJobId, "prompt.md"),
      authRootDir: config.authRootDir, accounts: ["account-q"], accessBoundary: core.AccessBoundary.ProjectScopedControl, projectAccessScope: scope } });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const refillArgs = (jobId: string, workspaceId: string, aggregateInputs: boolean, startWorker: boolean): ProjectControlMcpArgs => ({ ...base,
      jobId, taskId: jobId, jobRootDir: join(jobRoots, jobId), workspacePath: join(worktrees, workspaceId), promptPath: join(jobRoots, jobId, "prompt.md"),
      sourceWorkspacePath: source, baseBranch: "main", expectedSourceCommit: revision, newBranch: "test/" + workspaceId,
      accounts: ["account-q"], authRootDir: config.authRootDir, codexBinaryPath: config.codexBinaryPath,
      modelBackend: provider.CodexModelBackend.XiaomiMimoTokenPlan, model: provider.codexMimoDefaultModel,
      executionEngine: "app-server", workerReportMode: "structured-output", reasoningEffort: "high", serviceTier: "default", maxAccountCycles: 1,
      prewarmOnStart: false, requireGitWorkspace: true, taskTimeoutMs: 6 * 60_000, appServerStartupTimeoutMs: 330_000,
      accessBoundary: core.AccessBoundary.IsolatedWorkspaceWrite, networkAccess: core.NetworkAccessMode.Unrestricted,
      editMode: "allow-edits", providerSandboxMode: "workspace-write", workerRole: "producer",
      dependencyBootstrap: "off", executionMode: "sync", confirmRefill: true, startWorker,
      promptBody: (aggregateInputs
        ? `Read each of the 40 inputs/item-00.txt through inputs/item-39.txt files using the enabled workspace MCP tools. Use a read call for each file; batch independent reads within tool turns when supported. Process each value and proof. Create output.txt with exactly three lines: '${jobId}', then 'sum=' followed by the sum of all integer values, then 'proofs=' followed by all proof fields joined with commas in ascending input filename order. End with a newline. `
        : `Create output.txt containing exactly '${jobId}'. `) +
        "Do not commit. Finish successfully with the structured runtime result after writing the file. This is a NEW TEST project; edit only output.txt.\n",
      confirmPreStartAdmission: true, preStartAdmission: { mode: "serial-builtin", contract: {
        kind: "worker-launch", format: 1, canonicalSha: revision, baseSha: revision, phaseStartSha: revision,
        packetRevision: "test-r1", controllerPacket: "controller.md", lanePacket: "lane.md", phaseId: "phase-01", laneId: "test-" + jobId.slice(-12).toLowerCase(),
        inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["output.txt"], mandatoryDocs: ["README.md", "controller.md", "lane.md"],
        mandatoryScripts: [], mandatoryFixtures: [], requiredChecks: [{ id: "diff", cwd: "checks", command: "git diff --check" }],
        executionPolicy: { mode: "sandbox-only", sandboxRoot: root, forbiddenRealProjects: [join(root, "FORBIDDEN-real-project")] } } } });
    phase = "old-linked-refill";
    const oldResponse = await ok("codex_goal_project_refill_worker", refillArgs(oldId, oldId, false, true));
    const old = ownStart(oldId); check(old, "old_linked_start_missing"); observe("old-linked-native-start", { start: old, publicStart: record(oldResponse.start).status });
    await waitFor("old_provider_result", () => existsSync(join(old.directory, "mimo-candidate.json")));
    check(lifecycle.researchProviderUnits(old.directory).length === 1 && readdirSync(join(admission.researchJobAuthority(oldId), "starts")).length === 1, "old_attempt_count");
    const finalized = await lifecycle.finalizeOwnedMimoWorker(old.jobId, old.startId, old.specSha256);
    check(finalized.status === "done" && readFileSync(join(worktrees, oldId, "output.txt"), "utf8").trim() === oldId, "old_output_not_successful");
    const oldManifest = await jobs.readCodexGoalJob({ registryRootDir, jobId: oldId });
    oldHashes = retainedHashes(oldManifest, root); report.retainedBefore = oldHashes; observe("old-finalized-retained", { finalized, leaves: oldHashes.length });
    phase = "public-worktree-and-create-job";
    const idleWorkspace = join(worktrees, idleId);
    const createdWorktree = await ok("codex_goal_project_create_worktree", { ...base, sourceWorkspacePath: source, path: idleWorkspace, baseBranch: "main", expectedSourceCommit: revision, newBranch: "test/" + idleId, confirmCreateWorktree: true });
    const worktreeAdvisory = summary(createdWorktree, "result");
    const createdJob = await ok("codex_goal_project_create_job", { ...base, jobId: idleId, taskId: idleId, jobRootDir: join(jobRoots, idleId), workspacePath: idleWorkspace, promptPath: join(jobRoots, idleId, "prompt.md"), accounts: ["account-q"], confirmCreate: true, workerRole: "producer" });
    // Stage prompt only after public create_job has proved and created its fresh root.
    writeFileSync(join(jobRoots, idleId, "prompt.md"), "NEW TEST never-started worker; no execution requested.\n", { mode: 0o600, flag: "wx" });
    observe("public-create-routes-with-retained-backlog", { worktreeAdvisory, createJobAdvisory: summary(createdJob, "result") });
    phase = "prepare-sibling-a";
    await ok("codex_goal_project_refill_worker", refillArgs(aId, aId, true, false));
    phase = "linked-start-a";
    const runningProviders = (jobId: string): Json[] => {
      const start = ownStart(jobId); check(start, "provider_start_missing");
      const status = lifecycle.statusResearchLaunch(jobId); if (!status.active) return [];
      return status.providers.filter(item => item.active).flatMap(item => {
        try {
          const reservation = lifecycle.readResearchProviderReservation(start.directory, item.unit);
          const service = host.researchServiceIdentity(item.unit), process = host.researchProcessIdentity(service.mainPid);
          host.assertResearchServiceOwner(process, service, reservation.description);
          return [{ service, process }];
        } catch { return []; } // Liveness polling never converts a pending/uncertain owner into proof.
      });
    };
    const aResponse = await ok("codex_goal_project_start", { ...base, jobId: aId, confirmStart: true, dependencyBootstrap: "off" });
    const aManifest = await jobs.readCodexGoalJob({ registryRootDir, jobId: aId });
    await waitFor("a_enforced_running_allocation", async () => runningProviders(aId).length === 1 && (await writers.observeResearchJobWriterAuthority(aManifest)).status === "allocated");
    observe("a-enforced-running-before-sibling-submission", { a: nativeSnapshot(aId), writerStatus: "allocated" });
    phase = "linked-refill-b";
    const bResponse = await ok("codex_goal_project_refill_worker", refillArgs(bId, bId, true, true));
    ownStart(bId);
    observe("siblings-linked", { aAdvisory: summary(aResponse, "result"), bAdvisory: summary(bResponse, "start"), a: nativeSnapshot(aId), b: nativeSnapshot(bId) });
    let concurrentProviders: Json | undefined;
    await waitFor("concurrent_native_provider_units", () => {
      const beforeAt = new Date().toISOString(), aBefore = runningProviders(aId);
      const bAt = new Date().toISOString(), b = runningProviders(bId);
      const aAfter = runningProviders(aId), afterAt = new Date().toISOString();
      // The same live A lifetime brackets B's live observation. PID reuse,
      // service replacement, or a same-name successor cannot establish overlap.
      if (aBefore.length !== 1 || b.length !== 1 || aAfter.length !== 1 || !isDeepStrictEqual(aBefore, aAfter)) return false;
      concurrentProviders = { beforeAt, bAt, afterAt, aBefore, b, aAfter }; return true;
    });
    check(concurrentProviders, "simultaneous_provider_lifetimes_unproved");
    const beforeRetryA = nativeSnapshot(aId), beforeRetryB = nativeSnapshot(bId);
    for (const snapshot of [beforeRetryA, beforeRetryB]) {
      check(Array.isArray(snapshot.startDirectories) && snapshot.startDirectories.length === 1 && Array.isArray(snapshot.providerUnits) && snapshot.providerUnits.length === 1, "sibling_attempt_count");
    }
    observe("two-actually-concurrent-providers", { a: beforeRetryA, b: beforeRetryB, runningOwners: concurrentProviders });
    phase = "conflicting-public-create-job";
    const collisionAuthority = admission.researchJobAuthority(collisionId);
    const collisionManifestPath = jobs.codexGoalJobManifestPath({ registryRootDir, jobId: collisionId });
    const collisionJobRoot = join(jobRoots, collisionId);
    check(!existsSync(collisionManifestPath) && !existsSync(collisionJobRoot) && !existsSync(collisionAuthority), "collision_identity_not_fresh");
    // Request the real live writer's physical workspace through the public broker.
    // No duplicate registration, prepared receipt, or synthetic owner exclusion is needed.
    const collision = await call("codex_goal_project_create_job", { ...base, jobId: collisionId, taskId: collisionId,
      jobRootDir: collisionJobRoot, workspacePath: join(worktrees, aId), promptPath: join(collisionJobRoot, "prompt.md"),
      accounts: ["account-q"], workerRole: "producer", confirmCreate: true,
      modelBackend: provider.CodexModelBackend.XiaomiMimoTokenPlan, model: provider.codexMimoDefaultModel,
      executionEngine: "app-server", workerReportMode: "structured-output", maxAccountCycles: 1, prewarmOnStart: false });
    const denial = record(collision.admission);
    check(collision.ok === false && denial.allowed === false && denial.resource === join(worktrees, aId), "collision_missing_targeted_admission_denial");
    check(typeof denial.action === "string" && Array.isArray(denial.examples) && denial.examples.length <= 2, "collision_unreadable_denial");
    check(denial.examples.some(item => record(item).reason === core.ProjectDebtReason.ActiveWriterConflict), "collision_not_an_actual_writer_conflict");
    check(!existsSync(collisionManifestPath) && !existsSync(collisionJobRoot), "collision_registry_or_job_effect_occurred");
    check(!existsSync(join(collisionAuthority, "active.json")) && !existsSync(join(collisionAuthority, "grant.json")) && !existsSync(join(collisionAuthority, "starts")), "collision_native_effect_occurred");
    observe("collision-denied-before-effect", { tool: "codex_goal_project_create_job", admission: denial, manifestAbsent: true, jobRootAbsent: true, nativeAuthorityAbsent: true });
    phase = "same-operation-retry";
    const retry = await call("codex_goal_project_start", { ...base, jobId: aId, confirmStart: true, dependencyBootstrap: "off" });
    check(retry.reason === "worker_already_running" || retry.reason === "already_running", "retry_not_already_running");
    const afterRetryA = nativeSnapshot(aId), afterRetryB = nativeSnapshot(bId);
    for (const key of ["startId", "specSha256", "grantSha256", "receiptSha256", "providerUnits", "startDirectories"]) {
      assert.deepEqual(afterRetryA[key], beforeRetryA[key], "TEST_smoke_retry_duplicate_effect_" + key);
      assert.deepEqual(afterRetryB[key], beforeRetryB[key], "TEST_smoke_retry_changed_sibling_" + key);
    }
    observe("same-operation-retry-no-duplicate", { reason: retry.reason, a: afterRetryA, b: afterRetryB });
    assert.deepEqual(retainedHashes(oldManifest, root), oldHashes, "TEST_smoke_retained_bytes_changed");
    report.retainedAfter = retainedHashes(oldManifest, root); check(Date.now() < deadline, "total_deadline_before_pass"); report.outcome = "passed";
  } catch (error) { report.outcome = "failed"; report.failure = { phase, code: code(error) }; process.exitCode = 1; }
  finally {
    // Preserve exact public request identity independently of native starts. A
    // client timeout may leave its original handler running after this snapshot.
    for (const request of publicRequests.filter(item => item.state === "unsettled")) {
      cleanup.push({ kind: "public-request", ...request, retainedForReconciliation: true, code: "TEST_smoke_public_request_unsettled" });
      report.outcome = "failed"; process.exitCode = 1;
    }
    // Look up only known run-owned job IDs after uncertainty. Never launch a replacement.
    for (const jobId of [oldId, aId, bId, collisionId]) {
      try {
        const start = ownStart(jobId); if (!start) {
          if (existsSync(join(admission.researchJobAuthority(jobId), "grant.json")) && !existsSync(join(admission.researchJobAuthority(jobId), "last-terminal.json"))) {
            cleanup.push({ jobId, retainedForReconciliation: true, code: "TEST_smoke_grant_without_known_active_start" }); report.outcome = "failed"; process.exitCode = 1;
          }
          continue;
        }
        const current = admission.researchCurrentStart(jobId);
        check(current.spec.startId === start.startId && files.researchHash(current.bytes) === start.specSha256, "cleanup_identity_changed");
        const terminal = existsSync(join(start.directory, "mimo-candidate.json"))
          ? await lifecycle.finalizeOwnedMimoWorker(jobId, start.startId, start.specSha256)
          : lifecycle.cancelResearchLaunch(jobId);
        cleanup.push({ jobId, startId: start.startId, terminal });
      } catch (error) { cleanup.push({ jobId, code: code(error), retainedForReconciliation: true }); process.exitCode = 1; report.outcome = "failed"; }
    }
    if (oldHashes) {
      try {
        const current = await jobs.readCodexGoalJob({ registryRootDir, jobId: oldId });
        const after = retainedHashes(current, root); report.retainedAfter = after;
        assert.deepEqual(after, oldHashes, "TEST_smoke_retained_bytes_changed_during_cleanup");
      } catch (error) { report.retainedHashFailure = code(error); report.outcome = "failed"; process.exitCode = 1; }
    }
    report.starts = [...starts.values()]; report.completedAt = new Date().toISOString(); save();
    await client.close(); await server.close();
    process.stdout.write(JSON.stringify({ outcome: report.outcome, reportPath }) + "\n");
  }
}

function retainedHashes(manifest: CodexGoalJobManifest, root: string): HashLeaf[] {
  const resultPath = join(manifest.jobRootDir, `${manifest.taskId}.latest-result.json`);
  const result = record(JSON.parse(readFileSync(resultPath, "utf8")));
  check(Array.isArray(result.artifacts) && result.artifacts.length >= 3 && result.artifacts.length <= 256, "retained_handoff_artifacts_missing");
  const paths = new Set([join(root, "registry", manifest.jobId, "job.json"), join(manifest.workspacePath, "output.txt"), resultPath,
    join(manifest.jobRootDir, `${manifest.taskId}.progress.json`), manifest.promptPath,
    manifest.projectPreStartAdmission!.contractPath, manifest.projectPreStartAdmission!.statePath, manifest.projectPreStartAdmission!.receiptPath]);
  for (const artifact of result.artifacts) paths.add(text(record(artifact).path));
  const visited = new Set<string>(), leaves = new Map<string, HashLeaf>(); let totalBytes = 0;
  const visit = (path: string, depth: number): void => {
    if (visited.has(path)) return;
    check(depth <= 8 && visited.size < 1024, "retained_evidence_bound_exceeded"); visited.add(path);
    check(path.startsWith(root + "/") && !relative(root, path).startsWith("..") && realpathSync(path) === path, "retained_path_outside_TEST");
    const stat = lstatSync(path); check(!stat.isSymbolicLink(), "retained_evidence_symlink");
    if (stat.isDirectory()) {
      // handoff_packet is a container. Include every regular evidence leaf,
      // including status, path lists, quarantine and future packet files.
      const names = readdirSync(path).sort(); check(names.length <= 1024 - visited.size, "retained_evidence_bound_exceeded");
      for (const name of names) visit(join(path, name), depth + 1);
      return;
    }
    check(stat.isFile() && stat.size <= 16 * 1024 * 1024, "retained_leaf_invalid");
    totalBytes += stat.size; check(totalBytes <= 64 * 1024 * 1024, "retained_evidence_bytes_exceeded");
    const bytes = readFileSync(path); check(bytes.length === stat.size, "retained_leaf_changed");
    leaves.set(path, { path, bytes: bytes.length, sha256: sha256(bytes) });
  };
  for (const path of [...paths].sort()) visit(path, 0);
  return [...leaves.values()].sort((a, b) => a.path.localeCompare(b.path));
}
