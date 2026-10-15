import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
const resumeFault = vi.hoisted(() => ({ job: "", beforeBirth: false, afterBirth: false, createCalls: 0, birthTicks: "1" }));
const boundary = vi.hoisted(() => ({ root: "", map: (value: unknown): unknown => value, unmap: (value: string) => value }));
vi.mock("node:url", async original => {
  const url = await original<typeof import("node:url")>();
  return { ...url, fileURLToPath: (value: URL | string) => {
    const path = url.fileURLToPath(value); return path === process.cwd() + "/" ? "/TEST-artifact/" : path;
  } };
});
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const result = { ...fs } as Record<string, unknown>;
  for (const name of ["existsSync", "mkdirSync", "rmdirSync", "writeFileSync", "readFileSync", "openSync", "readdirSync", "linkSync", "unlinkSync", "renameSync", "rmSync", "statSync", "lstatSync", "realpathSync"]) {
    const fn = (fs as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    result[name] = (...args: unknown[]) => {
      const answer = fn(...args.map(boundary.map));
      if (["lstatSync", "statSync"].includes(name)) return Object.assign(answer as object, { uid: 0 });
      return name === "realpathSync" ? boundary.unmap(answer as string) : answer;
    };
  }
  result.fstatSync = (fd: number, options?: { bigint?: boolean }) => options?.bigint
    ? Object.assign(fs.fstatSync(fd, { bigint: true }), { uid: 0n }) : Object.assign(fs.fstatSync(fd), { uid: 0 });
  return result;
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>(); const result = { ...fs } as Record<string, unknown>;
  for (const name of ["mkdir", "mkdtemp", "rmdir", "chmod", "copyFile", "appendFile", "writeFile", "readFile", "open", "readdir", "link", "unlink", "rename", "rm", "stat", "lstat", "realpath", "access"]) {
    const fn = (fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
    result[name] = async (...args: unknown[]) => { const answer = await fn(...args.map(boundary.map)); return name === "realpath" && !String(args[0]).startsWith("/proc/self/fd/") ? boundary.unmap(answer as string) : answer; };
  }
  return result;
});
vi.mock("node:child_process", async original => {
  const cp = await original<typeof import("node:child_process")>();
  return { ...cp, execFile: Object.assign((file: string, args: string[], ...rest: unknown[]) => (cp.execFile as Function)(file, args.map(arg => boundary.map(arg) as string), ...rest), { [Symbol.for("nodejs.util.promisify.custom")]: (file: string, args: string[], options: object) => new Promise((resolve, reject) => cp.execFile(file, args.map(arg => boundary.map(arg) as string), options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) }), execFileSync: (file: string, args: string[], options: object) => cp.execFileSync(file, args.map(arg => boundary.map(arg) as string), options) };
});
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchProcessIdentity: () => ({ pid: process.pid, birthTicks: resumeFault.birthTicks, bootId: "b".repeat(36), machineId: "b".repeat(32), controlGroup: "/TEST", namespaces: { user: "TEST", mnt: "TEST", pid: "TEST", net: "TEST" } }), researchExecutableDigest: () => "a".repeat(64), researchCommand: (command: string, args: string[]) => { const cp = require("node:child_process") as typeof import("node:child_process"); return cp.execFileSync(command === "/usr/bin/ps" && process.platform === "darwin" ? "/bin/ps" : command, args.map(arg => boundary.map(arg) as string), { encoding: "utf8" }); } }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: (path: string, privateLeaf = false) => {
  // Host UID and fixed namespace are mapped; real directory/file/mode checks remain.
  const fs = require("node:fs") as typeof import("node:fs");
  const physical = boundary.map(path) as string;
  let current = physical;
  for (;;) { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || (stat.mode & 0o022) || (privateLeaf && current === physical && (stat.mode & 0o077))) throw new Error("TEST custody denied"); if (current === boundary.root) break; const parent = current.slice(0, current.lastIndexOf("/")) || "/"; if (parent === current || !current.startsWith(boundary.root)) break; current = parent; }
} }));
// Cold runtime census needs a real Linux host; protected birth uses real files/publication.
vi.mock("../application/project-control/codex-goal-project-admission", async original => ({ ...await original<object>(), codexProjectAdmissionGate: () => ({ evaluate: async () => ({ allowed: true, status: "admitted" }) }) }));
vi.mock("../codex-goal-mcp-project-accounts", async original => ({ ...await original<object>(), projectControlRefillAccountNames: async () => ["account-q"] }));
vi.mock("../../worker-local/project-control-evidence-custody-local-adapter", async original => {
  const adapter = await original<typeof import("../../worker-local/project-control-evidence-custody-local-adapter")>();
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const { projectControlCustodyMaterializationPaths } = await import("../../worker-local/project-control-evidence-custody-materialization");
  return { ...adapter, LocalProjectControlEvidenceCustody: class extends adapter.LocalProjectControlEvidenceCustody {
    override async canonicalDirectory(path: string, allowMissing = false) {
      const mapped = boundary.map(path) as string;
      if (process.platform === "linux") return boundary.unmap(await super.canonicalDirectory(mapped, allowMissing));
      // macOS substitutes procfs traversal only; real path/mode checks remain.
      const stat = await fs.lstat(mapped);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(mapped) !== mapped) throw new Error("TEST noncanonical custody");
      return path;
    }
    override async materializeApprovedProjectControlCustody(input: Parameters<InstanceType<typeof adapter.LocalProjectControlEvidenceCustody>["materializeApprovedProjectControlCustody"]>[0]) {
      if (process.platform === "linux") return super.materializeApprovedProjectControlCustody({ ...input,
        approvedAnchor: boundary.map(input.approvedAnchor) as string, ledgerRoots: input.ledgerRoots.map(root => boundary.map(root) as string),
        evidenceRoots: input.evidenceRoots.map(root => boundary.map(root) as string), deniedRoots: input.deniedRoots.map(root => boundary.map(root) as string) });
      const paths = projectControlCustodyMaterializationPaths({ anchor: input.approvedAnchor, ledgerRoots: input.ledgerRoots, evidenceRoots: input.evidenceRoots });
      for (const path of paths) await fs.mkdir(boundary.map(path) as string, { recursive: true, mode: 0o700 });
      const revalidate = async () => { for (const path of paths) { await this.canonicalDirectory(path);
        if ((await fs.lstat(boundary.map(path) as string)).mode & 0o077) throw new Error("TEST custody denied"); } };
      await revalidate();
      return { ...input, revalidate, close: async () => {} };
    }
  } };
});
vi.mock("../codex-goal-jobs", async original => {
  const real = await original<typeof import("../codex-goal-jobs")>();
  return { ...real, createCodexGoalJob: async (input: Parameters<typeof real.createCodexGoalJob>[0]) => {
    if (input.manifest.jobId === resumeFault.job) {
      resumeFault.createCalls++;
      if (resumeFault.beforeBirth) throw new Error("TEST original controller creation failed before birth");
    }
    const value = await real.createCodexGoalJob(input);
    if (input.manifest.jobId === resumeFault.job && resumeFault.afterBirth) throw new Error("TEST controller response failed after birth");
    return value;
  } };
});
vi.mock("../hosted-ordinary-writer-authority", async original => ({ ...await original<object>(), hostedOrdinaryWriterAuthorityAbsent: () => true }));
vi.mock("../host-scratch-temp", async original => ({ ...await original<object>(), resolveHostScratchTempRoot: () => ({ root: "/srv/workers" }) }));
vi.mock("../research-runtime-artifact", async original => {
  const real = await original<object>();
  const files = await import("../research-launch-files");
  return { ...real, assertQualifiedResearchRuntimeArtifact: (path: string, digest: string) => {
    if (files.researchArtifactDigest(path) !== digest) throw new Error("TEST immutable artifact changed");
  } };
});
import { prepareHostedMimoProject, resumeHostedMimoProjectPreparation, preparationSafeGit, assertPreparationGitMetadata, assertPreparationSandbox } from "../hosted-mimo-project-bridge-prepare";
import { resolveProjectSourceRevision } from "../application/project-control/codex-goal-project-source-revision";
import { assertHostedMimoProjectRouteOpen, captureHeldMimoPreparationFence, handleHostedMimoProjectBridge } from "../hosted-mimo-project-bridge";
import { readCodexGoalJob } from "../codex-goal-jobs";
import { loadProjectControlController } from "../codex-goal-mcp-project-control-deps";
import { projectControlAdoptPublishedIntegrationCommit } from "../codex-goal-mcp-project-control-published-adoption";
import { acquireLocalControllerMaintenanceFence, releaseLocalControllerMaintenanceFence } from "@vioxen/subscription-runtime/store-local-file";
import { observeProtectedCodexGoalJobBirth } from "../protected-job-birth";
import { observeResearchJobWriterAuthority } from "../research-writer-observation";
const fs = await vi.importActual<typeof import("node:fs")>("node:fs"), cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
boundary.root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "TEST-mimo-prepare-")));
boundary.map = value => typeof value === "string" && value !== boundary.root && !value.startsWith(boundary.root + "/") && /^\/(?:srv|etc|opt|run|TEST-artifact)(?:\/|$)/.test(value) ? boundary.root + value : value;
boundary.unmap = value => value.startsWith(boundary.root + "/") ? value.slice(boundary.root.length) : value;
const physical = (path: string) => boundary.map(path) as string;
function directory(path: string) { fs.mkdirSync(physical(path), { recursive: true, mode: 0o700 }); }
function file(path: string, bytes: string, mode = 0o600) { directory(path.slice(0, path.lastIndexOf("/"))); fs.writeFileSync(physical(path), bytes, { mode }); }
afterAll(() => fs.rmSync(boundary.root, { recursive: true, force: true }));
it("real filesystem prepare creates a real scoped controller and onboards; fsmonitor stays inert", async () => {
  const snapshot = "/srv/reviewed/test-source", state = "/srv/worker-state/mimo-projects/test-project/test-work", scratch = "/srv/workers/mimo-projects/test-project/test-work";
  directory(snapshot); directory("/srv/worker-state/account-pools/auth"); directory("/srv/workers"); directory("/srv/worker-state");
  directory("/run/user");
  for (const path of ["dist", "host-integration", "node_modules"]) directory("/TEST-artifact/" + path);
  file("/TEST-artifact/package.json", '{"type":"module"}\n'); file("/TEST-artifact/dist/main.js", "TEST immutable artifact bytes\n");
  const git = (...args: string[]) => cp.execFileSync("/usr/bin/git", ["-C", physical(snapshot), ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  git("init"); git("config", "user.name", "iliya"); git("config", "user.email", "iliyazelenkog@gmail.com");
  const url = "https://github.com/example/project.git"; git("remote", "add", "origin", url);
  for (const path of ["controller.md", "lane.md", "doc.md", "sandbox/.keep"]) file(snapshot + "/" + path, "TEST reviewed proof\n");
  git("add", "."); git("commit", "-m", "TEST fixture"); const sha = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", sha);
  const marker = boundary.root + "/TEST-fsmonitor-executed";
  git("config", "core.fsmonitor", `touch ${marker}`);
  fs.chmodSync(physical(snapshot + "/.git/config"), 0o666);
  expect(() => assertPreparationGitMetadata(snapshot)).toThrow("TEST custody denied");
  expect(fs.existsSync(marker)).toBe(false); fs.chmodSync(physical(snapshot + "/.git/config"), 0o600);
  file(snapshot + "/sandbox-file", "TEST regular file");
  expect(() => assertPreparationSandbox(snapshot, "sandbox-file")).toThrow("mimo_project_bridge_sandbox_directory_required");
  fs.unlinkSync(physical(snapshot + "/sandbox-file")); directory(snapshot + "/empty-sandbox");
  expect(() => assertPreparationSandbox(snapshot, "empty-sandbox")).toThrow("mimo_project_bridge_sandbox_tracked_required");
  fs.rmdirSync(physical(snapshot + "/empty-sandbox"));
  const machine = "b".repeat(32); file("/etc/machine-id", machine);
  file("/etc/subscription-runtime/projects/test-project.d/test-work.yml", `project_id: test-project\nworkstream_id: test-work\nstate_root: /srv/worker-state/jobs/test-project/test-work\nscratch_root: /srv/workers/jobs/test-project/test-work\nrouting_enabled: true\nrepositories:\n  runtime:\n    url: "${url}"\n    branch: main\n    exact_head: "${sha}"\n`);
  const entry = "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js"; file(entry, "TEST executable");
  const contract = { kind: "worker-launch", format: 1, canonicalSha: sha, baseSha: sha, phaseStartSha: sha, packetRevision: "test-r1", controllerPacket: "controller.md", lanePacket: "lane.md", phaseId: "phase-01", laneId: "test-lane", inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["sandbox"], mandatoryDocs: ["controller.md", "lane.md", "doc.md"], mandatoryScripts: [], mandatoryFixtures: [], requiredChecks: [{ id: "test-check", cwd: "sandbox", command: "true" }], executionPolicy: { mode: "sandbox-only", sandboxRoot: scratch + "/source/sandbox", forbiddenRealProjects: ["/srv/workers/jobs"] } };
  const binding = { schemaVersion: 1 as const, projectId: "test-project", workstreamId: "test-work", machineId: machine, routingEnabled: true, stateRoot: state, scratchRoot: scratch, registryRootDir: state + "/registry", controllerJobId: "test-controller", sourceWorkspacePath: scratch + "/source", sourceCommit: sha, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/true", taskTimeoutMs: 600000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract } };
  const plan = { schemaVersion: 1, binding, sourceSnapshotPath: snapshot, repositoryKey: "runtime", repositoryUrl: url, workerJobPrefix: "test-worker-", authRootDir: "/srv/worker-state/account-pools/auth", commitIdentity: { name: "iliya", email: "iliyazelenkog@gmail.com" } };
  file("/etc/subscription-runtime/test-plan.json", JSON.stringify(plan));
  // Real safe Git invokes status against an executable fsmonitor configuration.
  assertPreparationGitMetadata(snapshot); preparationSafeGit(["-C", snapshot, "status", "--porcelain"]); expect(fs.existsSync(marker)).toBe(false);
  const result = await prepareHostedMimoProject("/etc/subscription-runtime/test-plan.json");
  expect(result).toMatchObject({ ok: true, projectId: "test-project" }); expect(fs.existsSync(marker)).toBe(false);
  const controller = await readCodexGoalJob({ registryRootDir: state + "/registry", jobId: "test-controller" });
  expect(await observeProtectedCodexGoalJobBirth(controller)).toEqual({ status: "released" });
  expect(await observeResearchJobWriterAuthority(controller)).toEqual({ status: "released" });
  expect(controller.projectAccessScope?.allowedAccountIds).toEqual(["account-q"]);
  const archive = state + "/registry/archives", ledger = state + "/registry/consumed-output-ledger";
  expect(controller.projectAccessScope?.consumedOutputEvidenceRoots).toEqual([archive]);
  expect(controller.projectAccessScope?.consumedOutputLedgerRoots).toEqual([ledger]);
  for (const path of [state + "/reviewed-worker-outputs", state + "/reviewed-worker-outputs/.locks", state + "/reviewed-worker-outputs/.locks/workspace-locks",
    state + "/registry/.consumed-output-ledger-mutation-locks", archive, ledger, ledger + "/items"]) {
    const stat = fs.lstatSync(physical(path));
    expect(stat.isDirectory()).toBe(true); expect(stat.isSymbolicLink()).toBe(false); expect(stat.mode & 0o777).toBe(0o700);
  }
  const control = { registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId };
  await expect(loadProjectControlController(control)).resolves.toMatchObject({ scope: controller.projectAccessScope });
  // The public consumption boundary must accept initial authority without scope repair.
  const adoption = await projectControlAdoptPublishedIntegrationCommit({ ...control, attemptId: "test-attempt", commitSha: sha,
    message: "test: readiness only", permitFile: "/etc/subscription-runtime/test-unread-permit.json", expectedPermitSha256: "a".repeat(64) });
  expect(JSON.parse(adoption.content[0]!.text!)).toMatchObject({ reason: "confirm_adoption_required" });
  // Canonical controller loading fails closed if either authority root disappears.
  for (const path of [archive, ledger]) {
    fs.renameSync(physical(path), physical(path + "-held"));
    await expect(loadProjectControlController(control)).rejects.toThrow();
    fs.renameSync(physical(path + "-held"), physical(path));
  }
  expect(fs.statSync(physical(scratch + "/source/sandbox")).isDirectory()).toBe(true);
  expect(JSON.parse(fs.readFileSync(physical("/etc/subscription-runtime/mimo-projects/test-project/test-work.json"), "utf8")).sourceCommit).toBe(sha);
  // A sealed snapshot must create locally even when Git origin cannot be reached.
  cp.execFileSync("/usr/bin/git", ["-C", physical(binding.sourceWorkspacePath), "remote", "set-url", "origin", boundary.root + "/TEST-unreachable-origin"]);
  const create = { kind: "MimoProject", schemaVersion: 1, machineId: machine, projectId: binding.projectId, workstreamId: binding.workstreamId, operation: "create", jobId: "test-worker-sealed", prompt: "TEST isolated child", sourceCommit: sha };
  await expect(handleHostedMimoProjectBridge(create)).resolves.toMatchObject({ ok: true });
  const child = scratch + "/workspaces/" + create.jobId;
  expect(cp.execFileSync("/usr/bin/git", ["-C", physical(child), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sha);
  expect((await readCodexGoalJob({ registryRootDir: state + "/registry", jobId: create.jobId })).workspacePath).toBe(child);
  const second = { ...create, jobId: "test-worker-sealed-second" };
  await expect(handleHostedMimoProjectBridge(second)).resolves.toMatchObject({ ok: true });
  expect(cp.execFileSync("/usr/bin/git", ["-C", physical(scratch + "/workspaces/" + second.jobId), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(sha);
  // Ordinary expectedSourceCommit remains a remote pin and cannot use this local seal.
  await expect(resolveProjectSourceRevision({ resolvedSource: { sourceRealPath: binding.sourceWorkspacePath, revision: sha },
    remoteTrackingRef: binding.sourceRef, expectedSourceCommit: sha })).rejects.toThrow("project_control_git_failed:ls-remote");
  const sourceGit = (...args: string[]) => cp.execFileSync("/usr/bin/git", ["-C", physical(binding.sourceWorkspacePath), ...args], { encoding: "utf8" }).trim();
  const drift = sourceGit("-c", "user.name=iliya", "-c", "user.email=iliyazelenkog@gmail.com", "commit-tree", sha + "^{tree}", "-p", sha, "-m", "test: sealed source drift");
  for (const ref of ["refs/remotes/origin/main", "HEAD"]) {
    sourceGit("update-ref", ref, drift);
    const rejected = { ...create, jobId: "test-worker-drift-" + (ref === "HEAD" ? "head" : "ref") };
    await expect(handleHostedMimoProjectBridge(rejected)).rejects.toThrow("mimo_project_bridge_source_mismatch");
    expect(fs.existsSync(physical(scratch + "/workspaces/" + rejected.jobId))).toBe(false);
    expect(fs.existsSync(physical(state + "/registry/" + rejected.jobId))).toBe(false);
    sourceGit("update-ref", ref, sha);
  }


});


async function partialFixture(name: string, afterBirth = false) {
  const project = "resume-" + name, stream = "test-work", snapshot = "/srv/reviewed/" + project;
  const state = `/srv/worker-state/mimo-projects/${project}/${stream}`, scratch = `/srv/workers/mimo-projects/${project}/${stream}`;
  directory(snapshot); directory("/srv/worker-state/account-pools/auth"); directory("/run/user");
  for (const path of ["dist", "host-integration", "node_modules"]) directory("/TEST-artifact/" + path);
  file("/TEST-artifact/package.json", '{"type":"module"}\n');
  file("/TEST-artifact/dist/worker-codex/hosted-mimo-project-bridge-cli.js", "TEST immutable CLI\n");
  const pointer = physical("/opt/subscription-runtime/mimo-project-bridge-current");
  fs.rmSync(pointer, { recursive: true, force: true }); directory("/opt/subscription-runtime");
  fs.symlinkSync(physical("/TEST-artifact"), pointer);
  const git = (...args: string[]) => cp.execFileSync("/usr/bin/git", ["-C", physical(snapshot), ...args], { encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  git("init"); git("config", "user.name", "iliya"); git("config", "user.email", "iliyazelenkog@gmail.com");
  const url = "https://github.com/example/project.git"; git("remote", "add", "origin", url);
  file(snapshot + "/README.md", "TEST source\n"); file(snapshot + "/app/.keep", "TEST owned sandbox\n");
  git("add", "."); git("commit", "-m", "TEST resume fixture"); const sha = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", sha);
  const machine = "b".repeat(32); file("/etc/machine-id", machine);
  file(`/etc/subscription-runtime/projects/${project}.d/${stream}.yml`, `project_id: ${project}\nworkstream_id: ${stream}\nstate_root: /srv/worker-state/jobs/${project}/${stream}\nscratch_root: /srv/workers/jobs/${project}/${stream}\nrouting_enabled: true\nrepositories:\n  app:\n    url: "${url}"\n    branch: main\n    exact_head: "${sha}"\n`);
  const contract = { kind: "worker-launch", format: 1, canonicalSha: sha, baseSha: sha, phaseStartSha: sha, packetRevision: "test-r1", controllerPacket: "README.md", lanePacket: "README.md", phaseId: "phase-01", laneId: "test-lane", inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["app/"], mandatoryDocs: ["README.md"], mandatoryScripts: [], mandatoryFixtures: [], requiredChecks: [{ id: "test", cwd: "app", command: "true" }], executionPolicy: { mode: "sandbox-only", sandboxRoot: scratch + "/source/app", forbiddenRealProjects: ["/srv/workers/jobs"] } };
  const binding = { schemaVersion: 1 as const, projectId: project, workstreamId: stream, machineId: machine, routingEnabled: true, stateRoot: state, scratchRoot: scratch, registryRootDir: state + "/registry", controllerJobId: project + "-controller", sourceWorkspacePath: scratch + "/source", sourceCommit: sha, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/true", taskTimeoutMs: 600000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract } };
  const plan = { schemaVersion: 1, binding, sourceSnapshotPath: snapshot, repositoryKey: "app", repositoryUrl: url, workerJobPrefix: project + "-worker-", authRootDir: "/srv/worker-state/account-pools/auth", commitIdentity: { name: "iliya", email: "iliyazelenkog@gmail.com" } };
  const planPath = `/etc/subscription-runtime/${project}-plan.json`; file(planPath, JSON.stringify(plan));
  resumeFault.job = binding.controllerJobId; resumeFault.beforeBirth = !afterBirth; resumeFault.afterBirth = afterBirth; resumeFault.createCalls = 0;
  await expect(prepareHostedMimoProject(planPath)).rejects.toThrow(afterBirth ? "TEST controller response failed after birth" : "TEST original controller creation failed before birth");
  resumeFault.beforeBirth = resumeFault.afterBirth = false;
  const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const { researchArtifactDigest } = await import("../research-launch-files");
  const artifact = researchArtifactDigest("/TEST-artifact");
  file("/etc/subscription-runtime/mimo-project-runtime-routing.json", JSON.stringify({ schemaVersion: 2, currentRuntimeDirectory: "/TEST-artifact", currentArtifactSha256: artifact }));
  const failedResult = `/etc/subscription-runtime/${project}-failed-result.json`, originalFailure = JSON.stringify({ ok: false, error: "mimo_project_bridge_operation_failed" }) + "\n"; file(failedResult, originalFailure);
  const identity = (path: string) => { const s = fs.lstatSync(physical(path)); return { path, device: s.dev, inode: s.ino }; };
  const resume = { schemaVersion: 1, preparationPlanPath: planPath, expectedPlanSha256: digest(fs.readFileSync(physical(planPath))), expectedPreparationSha256: digest(fs.readFileSync(physical(state + "/preparation.json"))), failedResultPath: failedResult, expectedFailedResultSha256: digest(originalFailure), runtimeDirectory: "/TEST-artifact", artifactSha256: artifact, directories: [state, scratch, binding.registryRootDir, binding.sourceWorkspacePath].map(identity) };
  const resumePath = `/etc/subscription-runtime/${project}-resume.json`; file(resumePath, JSON.stringify(resume));
  return { state, scratch, binding, resumePath, failedResult, originalFailure, digest };
}

it("resumes a real pre-controller failure through canonical birth and onboarding without re-cloning or replacing the failed record", async () => {
  const f = await partialFixture("success"), before = fs.lstatSync(physical(f.binding.sourceWorkspacePath));
  expect(fs.existsSync(physical(f.state + "/controller"))).toBe(false);
  const originalPreparation = fs.readFileSync(physical(f.state + "/preparation.json"));
  const original = JSON.parse(fs.readFileSync(physical(f.resumePath), "utf8"));
  let closureChecks = 0;
  const answer = await resumeHostedMimoProjectPreparation(f.resumePath, evidence => {
    closureChecks++;
    expect(evidence).toEqual({ planSha256: original.expectedPlanSha256, retainedPreparationSha256: original.expectedPreparationSha256,
      failedResultSha256: original.expectedFailedResultSha256 });
    if (fs.existsSync(physical(f.state + "/controller"))) expect(fs.existsSync(physical(f.state + "/.controller-maintenance-fence.json"))).toBe(true);
    return "c".repeat(64);
  });
  expect(closureChecks).toBeGreaterThan(7);
  expect(fs.existsSync(physical(f.state + "/.controller-maintenance-fence.json"))).toBe(false);
  expect(answer).toMatchObject({ ok: true, projectId: f.binding.projectId });
  const controller = await readCodexGoalJob({ registryRootDir: f.binding.registryRootDir, jobId: f.binding.controllerJobId });
  expect(await observeProtectedCodexGoalJobBirth(controller)).toEqual({ status: "released" });
  expect(fs.lstatSync(physical(f.binding.sourceWorkspacePath)).ino).toBe(before.ino);
  expect(fs.readFileSync(physical(f.state + "/preparation.json"))).toEqual(originalPreparation);
  expect(fs.readFileSync(physical(f.failedResult), "utf8")).toBe(f.originalFailure);
  expect(fs.existsSync(physical(f.state + "/preparation-resume.intent.json"))).toBe(true);
  expect(resumeFault.createCalls).toBe(2);
  await expect(resumeHostedMimoProjectPreparation(f.resumePath, () => "c".repeat(64))).rejects.toThrow();
  expect(resumeFault.createCalls).toBe(2);
});

it.each(["first-effect", "controller-collision", "source-changed", "failed-after-birth"])("refuses %s before consuming resume intent", async fault => {
  const f = await partialFixture(fault, fault === "failed-after-birth");
  if (fault === "first-effect") file("/run/user/subscription-runtime-research-v1/job-births/" + f.digest(f.state + "/controller") + ".first-effect.json", '{"firstEffectObserved":true}');
  if (fault === "controller-collision") directory(f.state + "/controller");
  if (fault === "source-changed") file(f.binding.sourceWorkspacePath + "/app/.keep", "TEST source changed\n");
  await expect(resumeHostedMimoProjectPreparation(f.resumePath, () => "c".repeat(64))).rejects.toThrow();
  expect(fs.existsSync(physical(f.state + "/preparation-resume.intent.json"))).toBe(false);
  expect(resumeFault.createCalls).toBe(1);
  expect(fs.readFileSync(physical(f.failedResult), "utf8")).toBe(f.originalFailure);
});

it("retains a consumed resume intent after another pre-controller failure and refuses a second resume", async () => {
  const f = await partialFixture("resume-fails"); resumeFault.beforeBirth = true;
  await expect(resumeHostedMimoProjectPreparation(f.resumePath, () => "c".repeat(64))).rejects.toThrow("TEST original controller creation failed before birth");
  expect(fs.existsSync(physical(f.state + "/preparation-resume.intent.json"))).toBe(true);
  resumeFault.beforeBirth = false;
  await expect(resumeHostedMimoProjectPreparation(f.resumePath, () => "c".repeat(64))).rejects.toThrow();
  expect(resumeFault.createCalls).toBe(2);
});


it.each(["missing", "unproven", "changed-proof", "external-fence"])("refuses %s original-producer/fence authority before intent", async fault => {
  const f = await partialFixture("closure-" + fault);
  const external = fault === "external-fence" ? await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: f.state, owner: "TEST external" }) : undefined;
  const closure = fault === "missing" ? undefined : () => {
    if (fault === "unproven") throw new Error("TEST original producer not proven closed");
    return fault === "changed-proof" && fs.existsSync(physical(f.state + "/.controller-maintenance-fence.json")) ? "d".repeat(64) : "c".repeat(64);
  };
  try {
    await expect(resumeHostedMimoProjectPreparation(f.resumePath, closure!)).rejects.toThrow();
    expect(fs.existsSync(physical(f.state + "/preparation-resume.intent.json"))).toBe(false);
    expect(fs.existsSync(physical(f.state + "/controller"))).toBe(false);
    expect(resumeFault.createCalls).toBe(1);
  } finally { if (external) await releaseLocalControllerMaintenanceFence(external); }
});

it("rechecks original producer closure after canonical creation before reviewed binding", async () => {
  const f = await partialFixture("closure-tail");
  await expect(resumeHostedMimoProjectPreparation(f.resumePath, () => {
    if (fs.existsSync(physical(f.binding.registryRootDir + "/" + f.binding.controllerJobId + "/job.json")))
      throw new Error("TEST original producer closure changed");
    return "c".repeat(64);
  })).rejects.toThrow("TEST original producer closure changed");
  expect(fs.existsSync(physical(f.state + "/preparation-resume.intent.json"))).toBe(true);
  expect(fs.existsSync(physical(f.state + "/reviewed-binding.json"))).toBe(false);
  expect(fs.existsSync(physical(`/etc/subscription-runtime/mimo-projects/${f.binding.projectId}/${f.binding.workstreamId}.json`))).toBe(false);
  expect(fs.existsSync(physical(f.state + "/.controller-maintenance-fence.json"))).toBe(false);
});

it("authenticates held fence identity, process birth and every route guard", async () => {
  const f = await partialFixture("fence-auth"), fence = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: f.state, owner: "TEST own" });
  const bytes = fs.readFileSync(physical(fence.path));
  try {
    expect(() => assertHostedMimoProjectRouteOpen(f.binding)).toThrow("mimo_project_bridge_route_closed");
    expect(() => captureHeldMimoPreparationFence(f.binding, { ...fence, ownerToken: "TEST forged" })).toThrow("mimo_project_bridge_route_closed");
    const capability = captureHeldMimoPreparationFence(f.binding, fence);
    expect(() => assertHostedMimoProjectRouteOpen(f.binding, capability)).not.toThrow();
    expect(() => assertHostedMimoProjectRouteOpen({ ...f.binding, stateRoot: f.state + "-other" }, capability)).toThrow("mimo_project_bridge_route_closed");
    expect(() => assertHostedMimoProjectRouteOpen(f.binding, {} as typeof capability)).toThrow("mimo_project_bridge_route_closed");
    const disabled = `/etc/subscription-runtime/projects/${f.binding.projectId}.d/${f.binding.workstreamId}.route-disabled`;
    file(disabled, "TEST disabled"); expect(() => assertHostedMimoProjectRouteOpen(f.binding, capability)).toThrow("mimo_project_bridge_route_closed"); fs.unlinkSync(physical(disabled));
    expect(() => assertHostedMimoProjectRouteOpen({ ...f.binding, routingEnabled: false }, capability)).toThrow("mimo_project_bridge_route_closed");
    file(f.state + "/.controller-recovery.json", "TEST recovery"); expect(() => assertHostedMimoProjectRouteOpen(f.binding, capability)).toThrow("mimo_project_bridge_route_closed"); fs.unlinkSync(physical(f.state + "/.controller-recovery.json"));
    const yaml = `/etc/subscription-runtime/projects/${f.binding.projectId}.d/${f.binding.workstreamId}.yml`, yamlBytes = fs.readFileSync(physical(yaml));
    fs.writeFileSync(physical(yaml), yamlBytes.toString().replace("routing_enabled: true", "routing_enabled: false"));
    expect(() => assertHostedMimoProjectRouteOpen(f.binding, capability)).toThrow("mimo_project_bridge_route_closed"); fs.writeFileSync(physical(yaml), yamlBytes);
    resumeFault.birthTicks = "2"; expect(() => assertHostedMimoProjectRouteOpen(f.binding, capability)).toThrow("mimo_project_bridge_route_closed"); resumeFault.birthTicks = "1";
    fs.renameSync(physical(fence.path), physical(fence.path + ".old"));
    fs.writeFileSync(physical(fence.path), bytes, { mode: 0o600 });
    expect(() => assertHostedMimoProjectRouteOpen(f.binding, capability)).toThrow("mimo_project_bridge_route_closed");
  } finally { resumeFault.birthTicks = "1"; await releaseLocalControllerMaintenanceFence(fence); }
});
