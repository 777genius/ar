import { host, local, request, setupResearchFixture, cleanupResearchFixture, enterResearchOperatorScope } from "./research-launch-fixture";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { DefaultRedactor } from "@vioxen/subscription-runtime/core";
import type { SafeExecutionRunResult, RuntimeResultEnvelope } from "@vioxen/subscription-runtime/worker-core";
import type { FileBackendCodexWorkerResult } from "../file-backend-codex-worker";
import { CodexJsonAgentDriver, CodexAppServerExecutionEngine, CodexModelBackend, AppServerExecutionLifetime, codexMimoDefaultModel,
  codexMimoApiKeyEnvVarDefault } from "@vioxen/subscription-runtime/provider-codex";
import { parseResearchOperatorRequest, researchRunConfig } from "../research-launch-contract";
import { grantOwnedMimoWorkerLaunch, revokeResearchLaunch, startResearchLaunch } from "../research-launch-owner";
import { assertResearchMimoProviderHome, admitResearchProcessFactory, bindResearchRuntime, researchCurrentStart, researchJobAuthority } from "../research-launch-admission";
import { cancelResearchLaunch, finalizeOwnedMimoWorker } from "../research-launch-lifecycle";
import { researchMimoWorkerLifecycle } from "../research-mimo-worker-result";
import { researchHash, researchPublish, researchRead } from "../research-launch-files";
import { runCodexGoal, codexGoalOutputPath, codexGoalProgressPath } from "../codex-goal-runner";
import { StaticRunner } from "./file-backend-codex-worker-test-support";
import * as scratch from "../host-scratch-temp";
import * as runtimeArtifact from "../research-runtime-artifact";
import * as materialization from "../codex-goal-terminal-handoff-materialization";
import { researchArtifactDigest } from "../research-launch-files";

const hostedMimoCredentialPath = "/etc/subscription-runtime/secrets/shared/mimo-token-plan-api-key";

beforeEach(setupResearchFixture);
afterEach(cleanupResearchFixture);
function start(physical = false) {
  host.physicalPaths = physical;
  const selected = parseResearchOperatorRequest({ ...request(), accounts: ["account-q"],
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel, maxAccountCycles: 1, prewarmOnStart: false });
  fs.writeFileSync(local("/TEST-operator/request.json"), JSON.stringify(selected), { mode: 0o600 });
  grantOwnedMimoWorkerLaunch(selected.jobId, selected.jobRootDir, selected.workspacePath);
  const launched = startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json")));
  host.group = "/system.slice/" + launched.unit; bindResearchRuntime(launched.jobId, launched.startId);
  const factory = admitResearchProcessFactory(selected), lease = researchMimoWorkerLifecycle(factory);
  if (!lease) throw new Error("Expected genuine Worker lifecycle");
  return { ...launched, ...researchCurrentStart(launched.jobId), selected, factory, lease, config: researchRunConfig(selected) };
}
async function candidate(status: "done" | "partial" | "failed" = "done") {
  const current = start(true);
  await promisify(execFile)("git", ["-C", current.selected.workspacePath, "init"]);
  current.lease.stage({ status, provider: "codex", runId: current.jobId, taskId: current.selected.taskId,
    reason: status === "failed" ? "provider_failed" : undefined });
  return current;
}
const finalize = (current: ReturnType<typeof start>) => finalizeOwnedMimoWorker(current.jobId, current.startId, current.specSha256);
const record = (current: ReturnType<typeof start>, name: string) => JSON.parse(researchRead(join(current.directory, name + ".json")).toString());
function completedResult(current: ReturnType<typeof start>, structuredOutput: unknown = {
  outcome: "done", evidence: ["TEST turn completed"], blockers: [], nextActionHint: "review_completed", summary: "TEST complete",
}): SafeExecutionRunResult<FileBackendCodexWorkerResult> {
  const now = new Date(), result = { outputText: "TEST", warnings: [], structuredOutput };
  return { status: "completed", attempts: [], result, replayed: false,
    task: { taskId: current.selected.taskId, workspaceRunId: current.startId,
      workspacePath: current.selected.workspacePath, effectMode: "workspace_patch", provider: "codex",
      status: "completed", startedAt: now, updatedAt: now, completedAt: now, attempts: [], result } };
}
async function initializeReportWorkspace(current: ReturnType<typeof start>): Promise<void> {
  const git = (args: string[]) => promisify(execFile)("git", ["-C", current.selected.workspacePath, ...args], { env: {
    ...process.env, GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
    GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
  } });
  await git(["init"]);
  fs.writeFileSync(join(current.selected.workspacePath, "TEST-baseline.txt"), "TEST baseline\n");
  await git(["add", "TEST-baseline.txt"]);
  expect((await git(["var", "GIT_AUTHOR_IDENT"])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
  expect((await git(["var", "GIT_COMMITTER_IDENT"])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
  await git(["commit", "-m", "test: create report TEST baseline"]);
}

describe("external owned MiMo result publication", () => {
  // RED: turn/completed overwrites a truthful report outcome with done.
  it.each([
    ["done", "review_completed"], ["partial", "continue"], ["blocked", "ask_user"], ["failed", "recover"],
  ] as const)("publishes the validated %s report only after outside reconciliation", async (outcome, nextAction) => {
    const current = start(true);
    await promisify(execFile)("git", ["-C", current.selected.workspacePath, "init"]);
    const report = { outcome, evidence: ["TEST observed result"], blockers: outcome === "done" ? [] : ["TEST incomplete"],
      summary: "TEST report", nextActionHint: "launch_next_slice" };
    await runCodexGoal(current.config, { createExecutor: () => ({ run: async task => {
      expect(task.outputSchemaName).toBe("codex-worker-report");
      return completedResult(current, report);
    }, dispose: async () => {} }) });
    expect(record(current, "mimo-candidate").result).toMatchObject({ status: outcome, nextAction });
    expect(fs.existsSync(codexGoalOutputPath(current.config))).toBe(false);
    enterResearchOperatorScope(current.unit);
    expect(await finalize(current)).toMatchObject({ status: outcome });
    expect(JSON.parse(fs.readFileSync(codexGoalOutputPath(current.config), "utf8")))
      .toMatchObject({ status: outcome, nextAction, evidence: expect.arrayContaining(report.evidence) });
  });

  // RED: missing, incomplete or foreign report data can become public success.
  it.each(["missing", null, {}, { outcome: "done" }, { outcome: "success", evidence: [], blockers: [], nextActionHint: "review", summary: "TEST" },
    { outcome: "done", evidence: [42], blockers: [], nextActionHint: "review", summary: "TEST" },
    { outcome: "done", evidence: [], blockers: [], nextActionHint: "review", summary: "TEST", injected: "TEST" },
  ])("fails closed and finalizes an invalid report %j", async invalid => {
    const current = start(true);
    await initializeReportWorkspace(current);
    fs.writeFileSync(join(current.selected.workspacePath, "TEST-report-proof.txt"), "TEST preserved incomplete work\n");
    await expect(runCodexGoal(current.config, { createExecutor: () => ({
      run: async () => {
        const result = completedResult(current, invalid);
        return invalid === "missing" ? { ...result, result: { outputText: "TEST", warnings: [] } } : result;
      }, dispose: async () => {},
    }) })).rejects.toThrow("owned_mimo_worker_report_invalid");
    expect(record(current, "mimo-candidate").result.status).toBe("failed");
    expect(fs.existsSync(codexGoalOutputPath(current.config))).toBe(false);
    enterResearchOperatorScope(current.unit);
    expect((await finalize(current)).status).toBe("failed");
    const output: RuntimeResultEnvelope = JSON.parse(fs.readFileSync(codexGoalOutputPath(current.config), "utf8"));
    expect(output.changedFiles).toContain("TEST-report-proof.txt");
    expect(output.nextAction).toBe("preserve_patch");
    const artifact = output.artifacts?.find(item => item.kind === "handoff_untracked_archive");
    if (!artifact?.path || !artifact.sha256) throw new Error("Expected retained invalid-report TEST archive");
    expect(createHash("sha256").update(fs.readFileSync(artifact.path)).digest("hex")).toBe(artifact.sha256);
    const { stdout } = await promisify(execFile)("tar", ["-xOf", artifact.path, "TEST-report-proof.txt"]);
    expect(stdout).toBe("TEST preserved incomplete work\n");
  });

  // RED: MiMo bypasses cache preparation and later removes/denies the owned home.
  it("prepares the real driver's home before config/key and retains it after engine disposal", async () => {
    const current = start(true), homeRoot = join(current.selected.jobRootDir, "home");
    const home = fs.lstatSync(homeRoot);
    expect(home.isDirectory()).toBe(true);
    expect(home.isSymbolicLink()).toBe(false);
    expect(home.mode & 0o777).toBe(0o700);
    fs.mkdirSync(dirname(local(hostedMimoCredentialPath)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(local(hostedMimoCredentialPath), "TEST-only-mimo-credential", { mode: 0o600 });
    let selectedHome = "", prepared = false, disposed = false;
    vi.spyOn(scratch, "prepareHostScratchCaches").mockImplementation(async home => {
      expect(fs.existsSync(join(home, "config.toml"))).toBe(false);
      selectedHome = home;
      for (const suffix of ["plugins/cache", "cache/remote_plugin_catalog"]) fs.mkdirSync(join(home, suffix), { recursive: true, mode: 0o700 });
      prepared = true;
    });
    const sourceEnv = current.config.sourceEnv;
    if (sourceEnv === undefined) throw new Error("Expected the owned Worker source environment");
    const executionLifetime = new AppServerExecutionLifetime({ deadlineEpochMs: Date.now() + 60_000, maxGoalTurns: 1,
      binding: { allocationId: current.jobId, incarnationId: current.startId } });
    const engine = new CodexAppServerExecutionEngine({ codexBinaryPath: current.selected.codexBinaryPath,
      modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, sourceEnv, processFactory: current.factory,
      executionLifetime, goalMode: false, maxGoalTurns: 1, cleanThreadPrewarm: false,
      nativeToolSurface: "disabled", hostedPermissionProfiles: true });
    vi.spyOn(engine, "run").mockImplementation(async input => {
      expect(prepared).toBe(true);
      expect(fs.existsSync(join(input.session.codexHome, "plugins/cache"))).toBe(true);
      expect(fs.existsSync(join(input.session.codexHome, "config.toml"))).toBe(true);
      expect(input.redactor.redact(input.session.env[codexMimoApiKeyEnvVarDefault]!)).not.toContain("TEST-only-mimo-credential");
      return { outputText: "TEST completed", warnings: [], structuredOutput: {
        outcome: "done", evidence: ["TEST cache inspected"], blockers: [], nextActionHint: "review_completed", summary: "TEST complete" } };
    });
    vi.spyOn(engine, "dispose").mockImplementation(async () => { disposed = true; });
    const driver = new CodexJsonAgentDriver({ modelBackend: CodexModelBackend.XiaomiMimoTokenPlan,
      sourceEnv, mimoHomeLifecycle: current.lease.home, executionLifetime, engine });
    const result = await driver.runTask({ session: null, task: { kind: "structured-prompt", prompt: "TEST" }, workspace: { path: current.selected.workspacePath },
      redactor: new DefaultRedactor(), runner: new StaticRunner({ exitCode: 0, stdout: "", stderr: "" }), abortSignal: new AbortController().signal });
    expect(result.status).toBe("completed");
    await driver.dispose();
    expect(disposed).toBe(true);
    expect(fs.existsSync(selectedHome)).toBe(true);
    expect(record(current, "mimo-home").identity.path).toBe(selectedHome);
    expect(() => assertResearchMimoProviderHome(current.spec, selectedHome)).not.toThrow();
    const foreignHome = join(homeRoot, "mimo-foreign", "codex-home");
    fs.mkdirSync(foreignHome, { recursive: true, mode: 0o700 });
    expect(() => assertResearchMimoProviderHome(current.spec, foreignHome)).toThrow("hosted_research_launch_denied");
    fs.renameSync(selectedHome, selectedHome + "-retained");
    fs.mkdirSync(selectedHome, { mode: 0o700 });
    expect(() => assertResearchMimoProviderHome(current.spec, selectedHome)).toThrow("hosted_research_launch_denied");
    expect(host.authReads).toBe(0);
  });

  // RED: the runner writes completed output/progress before outside service reconciliation.
  it("withholds public completion through the real goal entry until the outside owner finalizes", async () => {
    const current = start(true);
    await promisify(execFile)("git", ["-C", current.selected.workspacePath, "init"]);
    await runCodexGoal(current.config, { createExecutor: () => ({ run: async () => completedResult(current), dispose: async () => {} }) });
    expect(fs.existsSync(codexGoalOutputPath(current.config))).toBe(false);
    expect(JSON.parse(fs.readFileSync(codexGoalProgressPath(current.config), "utf8")).status).not.toBe("completed");
    expect(record(current, "mimo-candidate").result.status).toBe("done");
    enterResearchOperatorScope(current.unit);
    expect((await finalize(current)).status).toBe("done");
    expect(JSON.parse(fs.readFileSync(codexGoalOutputPath(current.config), "utf8")).status).toBe("done");
    expect(JSON.parse(fs.readFileSync(codexGoalProgressPath(current.config), "utf8")).status).toBe("completed");
    expect(host.units.get(current.unit)?.active).toBe(false);
  });

  // RED: cancel releases the active candidate before its dirty output is preserved.
  it("retains a cancelled pending candidate, then finalizes its real dirty artifact", async () => {
    const current = start(true), command = promisify(execFile);
    const env = { ...process.env, GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
      GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com" };
    const git = async (args: string[]) => await command("git", ["-C", current.selected.workspacePath, ...args], { env });
    await git(["init"]);
    const source = join(current.selected.workspacePath, "TEST-worker.txt");
    fs.writeFileSync(source, "TEST baseline\n");
    await git(["add", "TEST-worker.txt"]);
    expect((await git(["var", "GIT_AUTHOR_IDENT"])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
    expect((await git(["var", "GIT_COMMITTER_IDENT"])).stdout).toMatch(/^iliya <iliyazelenkog@gmail\.com>/);
    await git(["commit", "-m", "test: create owned TEST baseline"]);
    fs.writeFileSync(source, "TEST retained worker edit\n");
    current.lease.stage({ status: "partial", provider: "codex", runId: current.jobId, taskId: current.selected.taskId,
      changedFiles: ["TEST-worker.txt"], evidence: ["TEST worker output", "patch_preserve_unavailable"] });
    enterResearchOperatorScope(current.unit);
    expect(() => cancelResearchLaunch(current.jobId)).toThrow("hosted_mimo_worker_finalization_pending");
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(true);
    expect(fs.existsSync(join(current.directory, "closing.json"))).toBe(true);
    expect(fs.existsSync(codexGoalOutputPath(current.config))).toBe(false);
    expect((await finalize(current)).status).toBe("partial");
    const output: RuntimeResultEnvelope = JSON.parse(fs.readFileSync(codexGoalOutputPath(current.config), "utf8"));
    expect(output.status).toBe("partial");
    expect(output.changedFiles).toContain("TEST-worker.txt");
    expect(output.evidence).toContain("TEST worker output");
    expect(output.evidence).not.toContain("patch_preserve_unavailable");
    const patch = output.artifacts?.find(artifact => artifact.kind === "handoff_worktree");
    if (patch?.path === undefined || patch.sha256 === undefined) throw new Error("Expected preserved TEST worktree patch");
    const bytes = fs.readFileSync(patch.path);
    expect(bytes.toString()).toContain("TEST retained worker edit");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(patch.sha256);
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(false);
  });

  describe("bounded refusal (explicit offline Linux Host fixture)", () => {
    const platform = process.platform;
    beforeEach(() => {
      cleanupResearchFixture(); setupResearchFixture({ allocationParent: process.cwd() });
      Object.defineProperty(process, "platform", { value: "linux" });
    });
    afterEach(() => Object.defineProperty(process, "platform", { value: platform }));
  it.each([
    [8 * 1024 * 1024 + 1, "handoff_file_byte_limit_exceeded", "TEST-too-large.bin"],
    [64, "handoff_raw_secret_rejected", "TEST-too-large.bin"],
    [64, "handoff_sensitive_path_rejected", "TEST-generated/.env.example"],
    [64, "handoff_sensitive_path_rejected", "TEST-generated/.npmrc"],
  ] as const)("authenticates terminal refusal %s without exporting paths or freeing the workspace", async (size, reason, relativePath) => {
    const current = start(true); await initializeReportWorkspace(current);
    const path = join(current.selected.workspacePath, relativePath), bytes = Buffer.alloc(size);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, bytes);
    const external = join(current.selected.jobRootDir, "TEST-dependency-target"), dependency = join(current.selected.workspacePath, "node_modules");
    fs.mkdirSync(external, { mode: 0o700 });
    fs.writeFileSync(join(external, "TEST-original.txt"), "TEST preserved dependency bytes\n");
    fs.symlinkSync(external, dependency, "dir");
    const dependencyIdentity = fs.lstatSync(dependency);
    current.lease.stage({ status: "partial", provider: "codex", runId: current.jobId, taskId: current.selected.taskId,
      changedFiles: [relativePath] });
    const originalCandidate = researchRead(join(current.directory, "mimo-candidate.json"));
    enterResearchOperatorScope(current.unit);
    vi.spyOn(runtimeArtifact, "assertQualifiedResearchRuntimeArtifact").mockImplementation((directory, sha) => {
      expect(directory).toBe("/TEST-artifact"); expect(researchArtifactDigest(directory)).toBe(sha);
    });
    expect((await finalize(current)).status).toBe("partial");
    const name = fs.readdirSync(current.directory).find(name => name.startsWith("preservation-refusal."));
    if (!name) throw new Error("Missing authenticated TEST refusal");
    const retained = researchRead(join(current.directory, name));
    expect(JSON.parse(retained.toString())).toMatchObject({ jobId: current.jobId, startId: current.startId,
      specSha256: current.specSha256, candidateSha256: researchHash(originalCandidate),
      reason, processTerminal: true, preservationComplete: false, writerReleased: false });
    // The result is published without a packet: the receipt is the proof and only the count, never the refused paths.
    const publication = researchRead(join(current.directory, "mimo-publication.json"));
    const result: RuntimeResultEnvelope = JSON.parse(publication.toString()).result;
    expect(result.status).toBe("partial");
    expect(result.changedFiles).toEqual([]);
    expect(result.artifacts ?? []).toEqual([]);
    expect(result.evidence).toContain(`handoff_preservation_refused:${reason}`);
    expect(result.details).toMatchObject({ preservationRefusalReason: reason,
      preservationRefusalReceiptSha256: researchHash(retained), preservationRefusalWorkspaceRetained: "true" });
    expect(result.details?.changedFilesCount).toMatch(/^[1-9][0-9]*$/);
    for (const refusedPath of ["TEST-too-large.bin", ".env.example", ".npmrc"]) expect(publication.toString()).not.toContain(refusedPath);
    expect(JSON.parse(fs.readFileSync(codexGoalOutputPath(current.config), "utf8"))).toMatchObject({ status: "partial" });
    expect(JSON.parse(fs.readFileSync(codexGoalProgressPath(current.config), "utf8")).status).toBe("partial");
    expect(fs.readFileSync(path).equals(bytes)).toBe(true);
    expect(fs.lstatSync(dependency).ino).toBe(dependencyIdentity.ino);
    expect(fs.readlinkSync(dependency)).toBe(external);
    expect(fs.readFileSync(join(external, "TEST-original.txt"), "utf8")).toBe("TEST preserved dependency bytes\n");
    expect(researchRead(join(current.directory, "mimo-candidate.json"))).toEqual(originalCandidate);
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(false);
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "last-terminal.json"))).toBe(true);
    expect((await finalize(current)).status).toBe("partial");
    expect(researchRead(join(current.directory, name))).toEqual(retained);
    expect(researchRead(join(current.directory, "mimo-publication.json"))).toEqual(publication);
  });

  it("refuses candidate drift at the budget-error boundary without minting a refusal", async () => {
    const current = await candidate(); enterResearchOperatorScope(current.unit);
    vi.spyOn(materialization, "materializeReconciledTerminalCodexGoalHandoff").mockImplementation(async () => {
      researchPublish(join(current.directory, "mimo-candidate.json"), { TEST: "foreign" });
      throw new Error("dirty_terminal_handoff_unavailable:handoff_total_byte_limit_exceeded");
    });
    await expect(finalize(current)).rejects.toThrow("hosted_research_launch_denied");
    expect(fs.readdirSync(current.directory).some(name => name.startsWith("preservation-refusal."))).toBe(false);
    expect(fs.existsSync(join(current.directory, "mimo-publication.json"))).toBe(false);
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(true);
    expect(fs.existsSync(codexGoalOutputPath(current.config))).toBe(false);
  });

  });

  // RED: another operator releases/restarts the same job during final publication.
  it("excludes cancel, restart, revoke and another finalizer during publication", async () => {
    const current = await candidate(); enterResearchOperatorScope(current.unit);
    const rename = fs.renameSync;
    let interleaved = false;
    let concurrent: Promise<unknown> | undefined;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (!interleaved && String(to).endsWith(".latest-result.json")) {
        interleaved = true;
        expect(() => cancelResearchLaunch(current.jobId)).toThrow("hosted_research_job_mutation_busy");
        expect(() => revokeResearchLaunch(current.jobId)).toThrow("hosted_research_job_mutation_busy");
        expect(() => startResearchLaunch("/TEST-operator/request.json", researchHash(researchRead("/TEST-operator/request.json"))))
          .toThrow("hosted_research_job_mutation_busy");
        concurrent = expect(finalize(current)).rejects.toThrow("hosted_research_job_mutation_busy");
        expect(researchCurrentStart(current.jobId).spec.startId).toBe(current.startId);
      }
      return rename(from, to);
    });
    expect((await finalize(current)).status).toBe("done");
    expect(interleaved).toBe(true);
    if (concurrent === undefined) throw new Error("Expected a concurrent TEST finalizer");
    await concurrent;
    expect(JSON.parse(fs.readFileSync(codexGoalOutputPath(current.config), "utf8")).status).toBe("done");
  });

  it.each(["partial", "failed"] as const)("preserves the original %s outcome and repeats finalization without new effects", async status => {
    const current = await candidate(status); enterResearchOperatorScope(current.unit);
    expect((await finalize(current)).status).toBe(status);
    const output = fs.readFileSync(codexGoalOutputPath(current.config), "utf8"), calls = host.calls.length;
    expect((await finalize(current)).status).toBe(status);
    expect(fs.readFileSync(codexGoalOutputPath(current.config), "utf8")).toBe(output);
    expect(host.calls.slice(calls).some(call => call.args[0] === "stop")).toBe(false);
    expect(JSON.parse(output).reason).toBe(status === "failed" ? "provider_failed" : undefined);
  });

  it.each(["binding", "candidate", "job", "workspace", "foreign-runtime", "live-runtime"])("refuses %s without public completion", async fault => {
    const current = await candidate(); enterResearchOperatorScope(current.unit);
    if (fault === "binding") researchPublish(join(current.directory, "binding.json"), { ...record(current, "binding"), specSha256: "0".repeat(64) });
    if (fault === "candidate") researchPublish(join(current.directory, "mimo-candidate.json"), { ...record(current, "mimo-candidate"), startId: "00000000-0000-0000-0000-000000000000" });
    if (fault === "job" || fault === "workspace") {
      const path = fault === "job" ? current.selected.jobRootDir : current.selected.workspacePath;
      fs.renameSync(path, path + "-old"); fs.mkdirSync(path, { mode: 0o700 });
    }
    if (fault === "foreign-runtime") host.units.get(current.unit)!.description = "TEST-foreign";
    if (fault === "live-runtime") host.stopFailures.add(current.unit);
    await expect(finalize(current)).rejects.toThrow();
    expect(fs.existsSync(codexGoalOutputPath(current.config))).toBe(false);
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(true);
  });

  it("retains exact active/closing/candidate after publication failure, then retries the same receipt", async () => {
    const current = await candidate(); enterResearchOperatorScope(current.unit);
    const rename = fs.renameSync;
    const denied = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(".latest-result.json")) throw new Error("TEST publication denied");
      return rename(from, to);
    });
    await expect(finalize(current)).rejects.toThrow("TEST publication denied");
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(true);
    expect(fs.existsSync(join(current.directory, "closing.json"))).toBe(true);
    const retained = researchRead(join(current.directory, "mimo-publication.json"));
    denied.mockRestore(); await finalize(current);
    expect(researchRead(join(current.directory, "mimo-publication.json"))).toEqual(retained);
    expect(fs.existsSync(join(researchJobAuthority(current.jobId), "active.json"))).toBe(false);
  });
});
