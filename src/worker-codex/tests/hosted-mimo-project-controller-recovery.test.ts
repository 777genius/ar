import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
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
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchExecutableDigest: () => "a".repeat(64), researchCommand: (command: string, args: string[]) => { const cp = require("node:child_process") as typeof import("node:child_process"); return cp.execFileSync(command, args.map(arg => boundary.map(arg) as string), { encoding: "utf8" }); } }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: (path: string, privateLeaf = false) => {
  // Host UID and fixed namespace are mapped; real directory/file/mode checks remain.
  const fs = require("node:fs") as typeof import("node:fs");
  const physical = boundary.map(path) as string;
  let current = physical;
  for (;;) { const stat = fs.lstatSync(current); if (stat.isSymbolicLink() || (stat.mode & 0o022) || (privateLeaf && current === physical && (stat.mode & 0o077))) throw new Error("TEST custody denied"); if (current === boundary.root) break; const parent = current.slice(0, current.lastIndexOf("/")) || "/"; if (parent === current || !current.startsWith(boundary.root)) break; current = parent; }
} }));
// Cold runtime census needs a real Linux host; protected birth uses real files/publication.

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
import { withHostedMimoWorkstreamActivity } from "../hosted-mimo-project-workstream-fence";
vi.mock("../project-control-operation-file-store", async original => {
  const store = await original<typeof import("../project-control-operation-file-store")>();
  return { ...store, durableReplaceJsonFile: vi.fn(store.durableReplaceJsonFile) };
});
import { durableReplaceJsonFile } from "../project-control-operation-file-store";
import { recoverHostedMimoController } from "../hosted-mimo-project-controller-recovery";
import { readCodexGoalJob } from "../codex-goal-jobs";
import { observeProtectedCodexGoalJobBirth } from "../protected-job-birth";
import { observeResearchJobWriterAuthority } from "../research-writer-observation";
vi.mock("../application/project-control/codex-goal-controller-relocation-idle", () => ({ assertControllerRelocationIdle: vi.fn(async () => {}) }));
vi.mock("../hosted-mimo-project-bridge-operation", () => ({ assertHostedMimoRecoveryOperationsSettled: vi.fn(async () => {}) }));
import { assertControllerRelocationIdle } from "../application/project-control/codex-goal-controller-relocation-idle";
import { assertHostedMimoRecoveryOperationsSettled } from "../hosted-mimo-project-bridge-operation";
vi.mock("../codex-goal-jobs", async original => {
  const jobs = await original<typeof import("../codex-goal-jobs")>();
  return { ...jobs, createCodexGoalJob: vi.fn(jobs.createCodexGoalJob) };
});
import { createCodexGoalJob, listCodexGoalJobs } from "../codex-goal-jobs";
import { researchHash } from "../research-launch-files";
import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
const fs = await vi.importActual<typeof import("node:fs")>("node:fs"), cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
boundary.root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "TEST-mimo-prepare-")));
boundary.map = value => typeof value === "string" && value !== boundary.root && !value.startsWith(boundary.root + "/") && /^\/(?:srv|etc|opt|run|var|TEST-artifact)(?:\/|$)/.test(value) ? boundary.root + value : value;
boundary.unmap = value => value.startsWith(boundary.root + "/") ? value.slice(boundary.root.length) : value;
const physical = (path: string) => boundary.map(path) as string;
function directory(path: string) { fs.mkdirSync(physical(path), { recursive: true, mode: 0o700 }); }
function file(path: string, bytes: string, mode = 0o600) { directory(path.slice(0, path.lastIndexOf("/"))); fs.writeFileSync(physical(path), bytes, { mode }); }
afterAll(() => fs.rmSync(boundary.root, { recursive: true, force: true }));

let sequence = 0;
async function fixture() {
  const id = `test-recovery-${++sequence}`, state = `/srv/worker-state/mimo-projects/${id}/test-work`;
  const scratch = `/srv/workers/mimo-projects/${id}/test-work`, source = scratch + "/source", registry = state + "/registry";
  for (const path of [state, registry, source, "/etc/subscription-runtime", "/var/lib", "/run/user", "/usr/bin", "/srv/worker-state/account-pools/auth", "/TEST-artifact"]) directory(path);
  for (const path of ["dist", "host-integration", "node_modules"]) directory("/TEST-artifact/" + path);
  file("/TEST-artifact/package.json", '{"type":"module"}\n'); file("/TEST-artifact/dist/main.js", "TEST immutable artifact bytes\n");
  const git = (...args: string[]) => cp.execFileSync("/usr/bin/git", ["-C", physical(source), ...args], { encoding: "utf8" }).trim();
  git("init"); git("config", "user.name", "iliya"); git("config", "user.email", "iliyazelenkog@gmail.com");
  file(source + "/TEST.txt", "TEST recovery source\n"); git("add", "."); git("commit", "-m", "TEST fixture");
  const commit = git("rev-parse", "HEAD"); git("remote", "add", "origin", "https://github.com/example/TEST.git"); git("update-ref", "refs/remotes/origin/main", commit);
  file("/etc/machine-id", "a".repeat(32));
  // The fixture intentionally reproduces legacy precreation: no protected birth.
  directory(state + "/controller"); file(state + "/controller/prompt.md", "TEST controller never launch\n");
  const scope = { projectId: id, registryRoot: registry, authRoot: "/srv/worker-state/account-pools/auth", workspaceRoots: [scratch],
    worktreeRoots: [scratch + "/workspaces"], observedWorkspaceRoots: [source], jobIdPrefixes: ["test-worker-", "test-controller"],
    tmuxSessionPrefixes: ["test-worker-", "test-controller"], allowedBranches: ["origin/main", "main", "feat/test-worker-*"], allowedGitRemotes: ["origin"],
    allowedAccountIds: ["account-q"], consumedOutputLedgerRoots: [registry + "/consumed-output-ledger"], consumedOutputEvidenceRoots: [registry + "/archives"] };
  const old = await createCodexGoalJob({ registryRootDir: registry, manifest: { jobId: "test-controller", taskId: "test-controller", jobRootDir: state + "/controller",
    workspacePath: source, promptPath: state + "/controller/prompt.md", authRootDir: scope.authRoot, accounts: ["account-q"],
    accessBoundary: AccessBoundary.ProjectScopedControl, projectAccessScope: scope } });
  const binding = { schemaVersion: 1, projectId: id, workstreamId: "test-work", machineId: "a".repeat(32), routingEnabled: true,
    stateRoot: state, scratchRoot: scratch, registryRootDir: registry, controllerJobId: old.jobId, sourceWorkspacePath: source,
    sourceCommit: commit, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/true", taskTimeoutMs: 600000, appServerStartupTimeoutMs: 330000,
    operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract: { executionPolicy: { mode: "sandbox-only", sandboxRoot: source + "/sandbox", forbiddenRealProjects: ["/TEST/real"] } } } };
  // Full worker admission is irrelevant to metadata parsing at this boundary.
  const config = `/etc/subscription-runtime/mimo-projects/${id}/test-work.json`;
  file(config, JSON.stringify(binding) + "\n");
  const oldPath = registry + "/" + old.jobId + "/job.json", oldBytes = fs.readFileSync(physical(oldPath));
  const evidencePath = state + "/TEST-attestation-evidence.txt"; file(evidencePath, "TEST verified never-run history\n");
  const plan = { schemaVersion: 1, projectId: id, workstreamId: "test-work", machineId: binding.machineId,
    expectedBindingSha256: researchHash(fs.readFileSync(physical(config))), expectedControllerManifestSha256: researchHash(oldBytes), newControllerJobId: "test-controller-r1",
    attestation: { operatorIdentity: "TEST operator", assertedAt: new Date().toISOString(), controllerJobId: old.jobId, controllerCreatedAt: old.createdAt,
      manifestSha256: researchHash(oldBytes), scopeSha256: researchHash(JSON.stringify(old.projectAccessScope)), registryRootDir: registry,
      jobRootDir: old.jobRootDir, sourceWorkspacePath: source, confirmation: "I attest complete never-run controller history through this recovery maintenance fence",
      historyCompleteFromCreationThroughThisMaintenanceFence: true, noControllerProviderOrWorkerExecution: true, coversDefaultCustomDirectAndAlternateHostLaunches: true,
      coversStateMovementAndDeletion: true, distinguishesBrokerChildWorkersFromControllerExecution: true,
      evidence: [{ reference: evidencePath, sha256: researchHash(fs.readFileSync(physical(evidencePath))) }] } };
  const input = state + "/TEST-recovery-plan.json";
  const save = () => file(input, JSON.stringify(plan)); save();
  return { input, config, state, registry, source, old, oldPath, oldBytes, binding, plan, save, git };
}
vi.mock("../application/project-control/worker-launch-spec", () => ({ workerLaunchAdmissionSchema: { parse: (v: unknown) => v } }));
it("retires exact legacy registration; fresh canonical birth releases only the replacement", async () => {
  const f = await fixture();
  expect(await observeProtectedCodexGoalJobBirth(f.old)).toEqual({ status: "unknown" });
  const sourceBefore = f.git("rev-parse", "HEAD");
  await expect(recoverHostedMimoController(f.input)).resolves.toMatchObject({ ok: true, controllerJobId: f.plan.newControllerJobId });
  const fresh = await readCodexGoalJob({ registryRootDir: f.registry, jobId: f.plan.newControllerJobId });
  expect(await observeProtectedCodexGoalJobBirth(fresh)).toEqual({ status: "released" });
  expect(await observeResearchJobWriterAuthority(fresh)).toEqual({ status: "released" });
  expect(await observeProtectedCodexGoalJobBirth(f.old)).toEqual({ status: "unknown" });
  const archived = f.registry + "/.project-control/superseded-controllers/" + f.old.jobId + "-" + f.plan.expectedControllerManifestSha256 + "/job.json";
  expect(fs.readFileSync(physical(archived))).toEqual(f.oldBytes);
  expect(fs.existsSync(physical(f.oldPath))).toBe(false);
  expect((await listCodexGoalJobs({ registryRootDir: f.registry })).map(job => job.jobId)).toEqual([fresh.jobId]);
  expect(f.git("rev-parse", "HEAD")).toBe(sourceBefore);
  expect(JSON.parse(fs.readFileSync(physical(f.config), "utf8"))).toEqual({ ...f.binding, controllerJobId: fresh.jobId });
  expect(fs.existsSync(physical(f.state + "/.controller-recovery.json"))).toBe(false);
});
it.each(["child", "binding", "source", "unsafe", "authority", "first-effect", "evidence", "active"])("refuses %s without granting legacy authority", async fault => {
  const f = await fixture();
  if (fault === "child") file(f.registry + "/test-worker-existing/job.json", f.oldBytes.toString());
  if (fault === "binding") file(f.config, JSON.stringify({ ...f.binding, taskTimeoutMs: 601000 }));
  if (fault === "source") file(f.source + "/TEST.txt", "TEST changed\n");
  if (fault === "unsafe") fs.chmodSync(physical(f.old.jobRootDir), 0o777);
  if (fault === "authority") directory("/run/user/subscription-runtime-research-v1/" + researchHash(f.old.jobId));
  if (fault === "first-effect") file("/run/user/subscription-runtime-research-v1/job-births/" + researchHash(f.old.jobRootDir) + ".first-effect.json", "TEST negative history\n");
  if (fault === "evidence") file(f.plan.attestation.evidence[0]!.reference, "TEST changed evidence\n");
  if (fault === "active") vi.mocked(assertControllerRelocationIdle).mockRejectedValueOnce(new Error("TEST live extent"));
  await expect(recoverHostedMimoController(f.input)).rejects.toThrow();
  expect(fs.readFileSync(physical(f.oldPath))).toEqual(f.oldBytes);
  expect(fs.existsSync(physical(f.registry + "/" + f.plan.newControllerJobId + "/job.json"))).toBe(false);
  if (fault === "authority") fs.rmSync(physical("/run/user/subscription-runtime-research-v1/" + researchHash(f.old.jobId)), { recursive: true });
  if (fault === "first-effect") fs.unlinkSync(physical("/run/user/subscription-runtime-research-v1/job-births/" + researchHash(f.old.jobRootDir) + ".first-effect.json"));
});
it("retains the crash guard and resumes only the exact plan after fresh publication", async () => {
  const f = await fixture();
  vi.mocked(assertHostedMimoRecoveryOperationsSettled).mockResolvedValueOnce().mockRejectedValueOnce(new Error("TEST pending operation"));
  await expect(recoverHostedMimoController(f.input)).rejects.toThrow("TEST pending operation");
  expect(fs.existsSync(physical(f.state + "/.controller-recovery.json"))).toBe(true);
  expect(fs.readFileSync(physical(f.oldPath))).toEqual(f.oldBytes);
  await expect(recoverHostedMimoController(f.input)).resolves.toMatchObject({ ok: true });
  expect(fs.existsSync(physical(f.state + "/.controller-recovery.json"))).toBe(false);
});

it("durable recovery guard blocks workstream activity before effect", async () => {
  const f = await fixture(); file(f.state + "/.controller-recovery.json", "TEST partial recovery\n");
  const effect = vi.fn(async () => true);
  await expect(withHostedMimoWorkstreamActivity(f.state, effect)).rejects.toThrow("mimo_project_bridge_recovery_pending");
  expect(effect).not.toHaveBeenCalled();
});

it("reconciles an exact partial retirement before binding CAS without duplicating controller", async () => {
  const f = await fixture();
  vi.mocked(durableReplaceJsonFile).mockRejectedValueOnce(new Error("TEST binding publication uncertain"));
  await expect(recoverHostedMimoController(f.input)).rejects.toThrow("TEST binding publication uncertain");
  expect(fs.existsSync(physical(f.oldPath))).toBe(false);
  expect(fs.existsSync(physical(f.state + "/.controller-recovery.json"))).toBe(true);
  expect(JSON.parse(fs.readFileSync(physical(f.config), "utf8")).controllerJobId).toBe(f.old.jobId);
  await expect(recoverHostedMimoController(f.input)).resolves.toMatchObject({ ok: true, controllerJobId: f.plan.newControllerJobId });
  expect((await listCodexGoalJobs({ registryRootDir: f.registry })).map(job => job.jobId)).toEqual([f.plan.newControllerJobId]);
});

it("an interrupted root birth requires reconciliation and never publishes an uncertified replay manifest", async () => {
  const f = await fixture();
  vi.mocked(createCodexGoalJob).mockImplementationOnce(async input => {
    directory(input.manifest.jobRootDir); throw new Error("TEST interrupted canonical birth");
  });
  await expect(recoverHostedMimoController(f.input)).rejects.toThrow("TEST interrupted canonical birth");
  const created = vi.mocked(createCodexGoalJob).mock.calls.length;
  expect(fs.existsSync(physical(f.state + "/.controller-recovery.json"))).toBe(true);
  await expect(recoverHostedMimoController(f.input)).rejects.toThrow("mimo_project_bridge_recovery_reconciliation_required");
  expect(vi.mocked(createCodexGoalJob)).toHaveBeenCalledTimes(created);
  expect(fs.existsSync(physical(f.registry + "/" + f.plan.newControllerJobId + "/job.json"))).toBe(false);
  expect(fs.readFileSync(physical(f.oldPath))).toEqual(f.oldBytes);
  expect(JSON.parse(fs.readFileSync(physical(f.config), "utf8"))).toEqual(f.binding);
  expect(fs.existsSync(physical(f.state + "/.controller-recovery.json"))).toBe(true);
});
