import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

// TEST fixtures only: host paths are mapped below a temporary root and the
// host-only observers (systemd, writer authority, mounts) are replaced by a
// harness. Git, file custody, fences, records and the census run for real.
const harness = vi.hoisted(() => ({
  operations: new Map<string, object>(), writer: new Map<string, string>(), terminal: new Set<string>(), warm: new Set<string>(),
  status: new Map<string, object>(), linkFailure: undefined as RegExp | undefined,
}));
const boundary = vi.hoisted(() => ({ root: "", map: (value: unknown): unknown => value, unmap: (value: string) => value }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const result = { ...fs } as Record<string, unknown>;
  for (const name of ["existsSync", "mkdirSync", "rmdirSync", "writeFileSync", "readFileSync", "openSync", "readdirSync", "linkSync", "unlinkSync", "renameSync", "rmSync", "statSync", "lstatSync", "realpathSync"]) {
    const fn = (fs as unknown as Record<string, (...args: unknown[]) => unknown>)[name]!;
    result[name] = (...args: unknown[]) => {
      if (name === "linkSync" && harness.linkFailure?.test(String(args[1]))) throw new Error("TEST crash during publication");
      const answer = fn(...args.map(boundary.map));
      if (["lstatSync", "statSync"].includes(name)) return Object.assign(answer as object, { uid: 0, gid: 0 });
      return name === "realpathSync" ? boundary.unmap(answer as string) : answer;
    };
  }
  result.fstatSync = (fd: number, options?: { bigint?: boolean }) => options?.bigint
    ? Object.assign(fs.fstatSync(fd, { bigint: true }), { uid: 0n }) : Object.assign(fs.fstatSync(fd), { uid: 0, gid: 0 });
  return result;
});
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>(); const result = { ...fs } as Record<string, unknown>;
  for (const name of ["mkdir", "mkdtemp", "rmdir", "chmod", "copyFile", "appendFile", "writeFile", "readFile", "open", "readdir", "link", "unlink", "rename", "rm", "stat", "lstat", "realpath", "access"]) {
    const fn = (fs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!;
    result[name] = async (...args: unknown[]) => { const answer = await fn(...args.map(boundary.map)); return name === "realpath" ? boundary.unmap(answer as string) : answer; };
  }
  return result;
});
vi.mock("node:child_process", async original => {
  const cp = await original<typeof import("node:child_process")>();
  const mapped = (args: string[]) => args.map(arg => boundary.map(arg) as string);
  const cwd = (options: { cwd?: string } | undefined) => options?.cwd ? { ...options, cwd: boundary.map(options.cwd) as string } : options;
  return { ...cp, execFile: Object.assign((file: string, args: string[], ...rest: unknown[]) => (cp.execFile as Function)(file, mapped(args), ...rest),
    { [Symbol.for("nodejs.util.promisify.custom")]: (file: string, args: string[], options: { cwd?: string }) => new Promise((resolve, reject) =>
      cp.execFile(file, mapped(args), cwd(options) as object, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) }),
    execFileSync: (file: string, args: string[], options: object) => cp.execFileSync(file, mapped(args), options) };
});
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn() }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: (path: string, privateLeaf = false) => {
  const fs = require("node:fs") as typeof import("node:fs");
  const physical = boundary.map(path) as string;
  for (let current = physical; current.startsWith(boundary.root);) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) || (privateLeaf && current === physical && (stat.mode & 0o077))) throw new Error("TEST custody denied");
    if (current === boundary.root) break;
    current = current.slice(0, current.lastIndexOf("/")) || "/";
  }
} }));
vi.mock("../research-writer-observation", async original => ({ ...await original<object>(),
  prepareResearchJobWriterObservation: async (manifest: { jobId: string }) => async () => ({ status: harness.writer.get(manifest.jobId) ?? "released" }) }));
vi.mock("../research-launch-lifecycle", async original => ({ ...await original<object>(), terminalResearchStart: (jobId: string) => {
  if (!harness.terminal.has(jobId)) throw new Error("TEST terminal unproven");
  const fs = require("node:fs") as typeof import("node:fs");
  const authority = boundary.root + "/run/user/subscription-runtime-research-v1/" + createHash("sha256").update(jobId).digest("hex");
  const slot = JSON.parse(fs.readFileSync(authority + "/last-terminal.json", "utf8")), bytes = fs.readFileSync(`${authority}/starts/${slot.startId}/spec.json`);
  return { directory: "", bytes, spec: JSON.parse(bytes.toString()), active: false };
} }));
vi.mock("../research-launch-contract", async original => ({ ...await original<object>(), parseResearchStartSpec: (value: unknown) => value }));
vi.mock("../hosted-ordinary-writer-authority", async original => ({ ...await original<object>(), hostedOrdinaryWriterAuthorityAbsent: () => true }));
vi.mock("../codex-goal-ops", async original => ({ ...await original<object>(),
  collectCodexGoalStatus: async (input: { taskId?: string }) => harness.status.get(input.taskId ?? "") ?? {} }));
// Operation observation needs systemd; its own suite covers the real observer.
vi.mock("../hosted-mimo-project-bridge-operation", async original => ({ ...await original<object>(),
  observeHostedMimoProjectOperation: (request: { jobId: string; operation: string }) => harness.operations.get(`${request.jobId}.${request.operation}`) ?? { state: "absent" },
  hostedMimoProjectOperationCold: (request: { jobId: string; operation: string }) => !harness.warm.has(`${request.jobId}.${request.operation}`) }));
import { retireHostedJobs, JobRetirementStep, type JobRetirementOptions } from "../job-retirement/job-retirement-command";
import { submitHostedMimoProjectBridge } from "../hosted-mimo-project-bridge-operation";
import { getCodexGoalStatusByIdUseCase } from "../application/codex-goal-job-use-cases";
import { stopStoredJobLifecycle } from "../application/codex-goal-job-lifecycle-use-cases";
import { projectControlStopStoredJobView } from "../codex-goal-mcp-project-control-stop";
import { loadJobLaunch } from "../application/codex-goal-job-launch-loader";
import { projectControlStartStoredJobView } from "../codex-goal-mcp-project-control-actions";
import { createCodexGoalJob, listCodexGoalJobs, readCodexGoalJob, updateCodexGoalJob } from "../codex-goal-jobs";
import { createOrReuseProjectJob } from "../application/project-control/codex-goal-project-refill";
import { assertRetirementConfigInert } from "../job-retirement/job-retirement-git";
import { acquireLocalControllerActivityLease, releaseLocalControllerActivityLease } from "@vioxen/subscription-runtime/store-local-file";
import type { RetirementHost } from "../job-retirement/job-retirement-pins";

const fs = await vi.importActual<typeof import("node:fs")>("node:fs"), cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
// Root creates host trees with umask 022; a user umask such as 002 would make
// the fixtures group-writable, which retirement rightly refuses.
process.umask(0o022);
boundary.root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "TEST-job-retirement-")));
// Idempotent: the fixture root may itself live below /srv on a worker host.
boundary.map = value => typeof value === "string" && /^\/(?:srv|etc|run)(?:\/|$)/.test(value) &&
  value !== boundary.root && !value.startsWith(boundary.root + "/") ? boundary.root + value : value;
boundary.unmap = value => value.startsWith(boundary.root + "/") ? value.slice(boundary.root.length) : value;
// Many real repositories: removing the fixture root can take longer than a default hook.
afterAll(() => fs.rmSync(boundary.root, { recursive: true, force: true }), 120_000);
const physical = (path: string) => boundary.map(path) as string;
function directory(path: string, mode = 0o700) { fs.mkdirSync(physical(path), { recursive: true, mode }); fs.chmodSync(physical(path), mode); }
function file(path: string, bytes: string, mode = 0o600) { directory(path.slice(0, path.lastIndexOf("/"))); fs.writeFileSync(physical(path), bytes, { mode }); fs.chmodSync(physical(path), mode); }
const json = (path: string, value: unknown) => file(path, JSON.stringify(value) + "\n");
const read = (path: string) => JSON.parse(fs.readFileSync(physical(path), "utf8"));
const exists = (path: string) => fs.existsSync(physical(path));
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const gitEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (repo: string, ...args: string[]) => cp.execFileSync("/usr/bin/git", ["-C", physical(repo), ...args], { encoding: "utf8", env: gitEnv }).trim();
const machine = "b".repeat(32), authority = (jobId: string) => "/run/user/subscription-runtime-research-v1/" + sha256(jobId);
/** A fake initial host: mounted pins show their source directory, as a bind does. */
const mounts = new Map<string, { device: number; inode: number }>(), busy = new Set<string>(), boot = { id: "11111111-1111-4111-8111-111111111111" };
const host: RetirementHost = { mountTable: () => [...mounts.keys()].map((target, index) => `${index + 100} 1 8:1 / ${target} rw shared:1 - ext4 /dev/sda1 rw`).join("\n") + "\n",
  unmount: target => { if (busy.has(target)) throw new Error("TEST target is busy"); mounts.delete(target); },
  identity: path => { const stat = fs.lstatSync(physical(path)); return mounts.get(path) ?? { device: stat.dev, inode: stat.ino }; },
  bootId: () => boot.id };
const fast: JobRetirementOptions = { fenceTimeoutMs: 300, fenceRetryMs: 25, host };
let counter = 0, plans = 0;
beforeEach(() => { harness.operations.clear(); harness.writer.clear(); harness.terminal.clear(); harness.status.clear(); harness.warm.clear();
  harness.linkFailure = undefined; mounts.clear(); busy.clear(); boot.id = "11111111-1111-4111-8111-111111111111"; });
directory("/etc/subscription-runtime/job-retirement"); directory("/run/user", 0o755); directory("/run/user/subscription-runtime-research-v1");
file("/etc/machine-id", machine, 0o644);

function repository(path: string, url = "https://github.com/example/project.git"): string {
  directory(path);
  git(path, "init", "-q", "-b", "main"); git(path, "config", "user.name", "iliya"); git(path, "config", "user.email", "iliyazelenkog@gmail.com");
  git(path, "remote", "add", "origin", url);
  file(path + "/README.md", "TEST source\n", 0o644); file(path + "/app/.keep", "TEST sandbox\n", 0o644);
  git(path, "add", "."); git(path, "commit", "-q", "-m", "TEST base");
  const head = git(path, "rev-parse", "HEAD");
  git(path, "update-ref", "refs/remotes/origin/main", head); git(path, "checkout", "-q", "--detach", head);
  return head;
}
const manifest = (jobId: string, jobRootDir: string, workspacePath: string, extra: object = {}) => ({ schemaVersion: 1, jobId, taskId: jobId,
  createdAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:00.000Z", jobRootDir, workspacePath, promptPath: jobRootDir + "/prompt.md",
  accounts: ["account-q"], ...extra });
const register = (registry: string, value: { jobId: string }) => json(`${registry}/${value.jobId}/job.json`, value);
const manifestSha = (registry: string, jobId: string) => sha256(fs.readFileSync(physical(`${registry}/${jobId}/job.json`)));
const runnerEvent = (event: string, jobId: string) => JSON.stringify({ event, attributes: { jobId } }) + "\n";
/** The runner's last word for a run that ended and released its resources. */
const disposedRun = (jobRoot: string, jobId: string) => file(`${jobRoot}/${jobId}.events.jsonl`, runnerEvent("runner_disposed", jobId));

/** A MiMo workstream as preparation and refill leave it, with its route closed. */
function workstream() {
  const project = "ret" + ++counter, stream = "main", state = `/srv/worker-state/mimo-projects/${project}/${stream}`;
  const scratch = `/srv/workers/mimo-projects/${project}/${stream}`, registry = state + "/registry", source = scratch + "/source";
  for (const path of [state, registry, registry + "/durable-handoffs", scratch, scratch + "/workspaces", state + "/controller"]) directory(path);
  const head = repository(source), controller = project + "-controller";
  const binding = { schemaVersion: 1, projectId: project, workstreamId: stream, machineId: machine, routingEnabled: false, stateRoot: state, scratchRoot: scratch,
    registryRootDir: registry, controllerJobId: controller, sourceWorkspacePath: source, sourceCommit: head, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/true",
    taskTimeoutMs: 600000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract: { kind: "worker-launch", format: 1,
      canonicalSha: head, baseSha: head, phaseStartSha: head, packetRevision: "test-r1", controllerPacket: "README.md", lanePacket: "README.md", phaseId: "phase-01",
      laneId: "test-lane", inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["app/"], mandatoryDocs: ["README.md"], mandatoryScripts: [], mandatoryFixtures: [],
      requiredChecks: [{ id: "test", cwd: "app", command: "true" }], executionPolicy: { mode: "sandbox-only", sandboxRoot: source + "/app", forbiddenRealProjects: ["/srv/workers/jobs"] } } } };
  json(`/etc/subscription-runtime/mimo-projects/${project}/${stream}.json`, binding);
  register(registry, manifest(controller, state + "/controller", source, { accessBoundary: "project_scoped_control" }));
  const f = { project, stream, state, scratch, registry, source, head, controller, binding, jobs: [] as string[] };
  return { ...f, bindingSha: sha256(fs.readFileSync(physical(`/etc/subscription-runtime/mimo-projects/${project}/${stream}.json`))) };
}
type Workstream = ReturnType<typeof workstream>;
/** A worker worktree on `feat/<jobId>` and its registration; `native` adds terminal research run-state. */
function worker(f: Workstream, name: string, options: { native?: boolean; started?: boolean } = {}) {
  // Research run-state is host-global and keyed by job ID, so IDs are unique per fixture.
  const jobId = `${f.project}-${name}`, workspace = `${f.scratch}/workspaces/${jobId}`, jobRoot = `${f.state}/jobs/${jobId}`;
  git(f.source, "worktree", "add", "-q", "-b", "feat/" + jobId, physical(workspace), f.head);
  directory(jobRoot);
  register(f.registry, manifest(jobId, jobRoot, workspace, { modelBackend: "xiaomi-mimo-token-plan" }));
  json(`${f.state}/mimo-bridge-attempts/${jobId}.json`, { schemaVersion: 1, jobId });
  operation(f, jobId, "create", { state: "settled", result: { ok: true, result: { ok: true } } });
  if (options.started || options.native) operation(f, jobId, "start", { state: "settled", result: { ok: true, result: { ok: true } } });
  if (options.native) native(jobId, jobRoot, workspace, f.registry + "/durable-handoffs");
  f.jobs.push(jobId);
  return { jobId, workspace, jobRoot };
}
/** A retained bridge operation: its owner file and what the observer reports for it. */
function operation(f: Workstream, jobId: string, name: string, observed: object) {
  for (const kind of ["owner", "request", "result"]) file(`${f.state}/mimo-bridge-operations/${jobId}.${name}.${kind}.json`, "{}\n");
  harness.operations.set(`${jobId}.${name}`, observed);
}
function native(jobId: string, jobRoot: string, workspace: string, durable: string) {
  const startId = "0f0e0d0c-0b0a-4908-8706-" + sha256(jobId).slice(0, 12), start = `${authority(jobId)}/starts/${startId}`;
  const identity = (path: string) => { const stat = fs.lstatSync(physical(path)); return { path, device: stat.dev, inode: stat.ino }; };
  const sources = { job: identity(jobRoot), workspace: identity(workspace), "durable-handoff": identity(durable) };
  json(`${start}/spec.json`, { schemaVersion: 1, startId, request: { jobId, jobRootDir: jobRoot, workspacePath: workspace },
    jobDirectory: sources.job, workspaceDirectory: sources.workspace, registeredHandoff: { durableDirectory: sources["durable-handoff"] } });
  json(`${authority(jobId)}/last-terminal.json`, { schemaVersion: 1, startId, specSha256: sha256(fs.readFileSync(physical(`${start}/spec.json`))) });
  for (const [name, source] of Object.entries(sources)) { directory(`${start}/pins/${name}`); mounts.set(`${start}/pins/${name}`, { device: source.device, inode: source.inode }); }
  harness.terminal.add(jobId);
  return start;
}
function plan(f: Workstream, outputs: Record<string, object> = {}, over: object = {}) {
  const path = `/etc/subscription-runtime/job-retirement/plan-${++plans}.json`;
  json(path, { schemaVersion: 1, machineId: machine, target: { kind: "mimo-workstream", projectId: f.project, workstreamId: f.stream, expectedBindingSha256: f.bindingSha },
    jobs: [f.controller, ...f.jobs].map(jobId => ({ jobId, expectedManifestSha256: manifestSha(f.registry, jobId), output: outputs[jobId] ?? { kind: "clean" } })), ...over });
  return path;
}
const retire = (path: string, options: JobRetirementOptions = {}) => retireHostedJobs(path, { ...fast, ...options });
const statusRequest = (f: Workstream, jobId: string, operation = "status") => ({ kind: "MimoProject", schemaVersion: 1, machineId: machine,
  projectId: f.project, workstreamId: f.stream, operation, jobId });

it("retires a MiMo workstream, tears down its pins and answers Status and Stop from tombstones with the scratch root gone", async () => {
  const f = workstream(), done = worker(f, "done", { native: true }), fresh = worker(f, "new");
  const pins = [...mounts.keys()];
  const result = await retire(plan(f)) as { workstreamTombstonePath: string; receiptPath: string; jobs: { jobId: string; tombstoneSha256: string }[] };
  expect(mounts.size).toBe(0);
  const tombstone = read(`${f.registry}/${done.jobId}/retired.json`);
  expect(tombstone).toMatchObject({ schema: "subscription-runtime-retired-job", jobId: done.jobId, layout: "mimo-workstream",
    terminal: { kind: "native-released" }, output: { kind: "clean", head: f.head }, deletion: { scope: "workstream", workstreamTombstone: f.state + "/retired.json" },
    workspace: { path: done.workspace, device: fs.lstatSync(physical(done.workspace)).dev, inode: fs.lstatSync(physical(done.workspace)).ino } });
  expect(tombstone.pins.map((pin: { path: string }) => pin.path).sort()).toEqual(pins.sort());
  expect(tombstone.pins.every((pin: { action: string }) => pin.action === "unmounted")).toBe(true);
  expect(read(`${f.registry}/${fresh.jobId}/terminal.json`)).toMatchObject({ terminal: { kind: "never-started", birth: "absent" } });
  expect(read(`${f.registry}/${f.controller}/terminal.json`)).toMatchObject({ role: "controller", terminal: { kind: "controller-closed" } });
  const workstreamRecord = read(f.state + "/retired.json");
  expect(workstreamRecord).toMatchObject({ scratchRoot: { path: f.scratch }, source: { path: f.source, head: f.head } });
  expect(workstreamRecord.jobs).toEqual(expect.arrayContaining(result.jobs.map(job => expect.objectContaining({ jobId: job.jobId, tombstoneSha256: job.tombstoneSha256 }))));
  expect(read(result.receiptPath)).toMatchObject({ schema: "subscription-runtime-job-retirement-receipt", workstreamTombstoneSha256: sha256(fs.readFileSync(physical(f.state + "/retired.json"))) });
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  // The host tool deletes the whole unit; Status and Stop must not need it.
  fs.rmSync(physical(f.scratch), { recursive: true, force: true });
  for (const operation of ["status", "stop"])
    await expect(submitHostedMimoProjectBridge(statusRequest(f, done.jobId, operation))).resolves.toMatchObject({ ok: true, jobId: done.jobId, state: "retired",
      retirement: { output: { kind: "clean" }, deletion: "workstream" } });
  await expect(submitHostedMimoProjectBridge(statusRequest(f, done.jobId, "start"))).rejects.toThrow("mimo_project_bridge_workstream_retired");
  await expect(submitHostedMimoProjectBridge(statusRequest(f, f.project + "-unknown"))).rejects.toThrow("mimo_project_bridge_workstream_retired");
  await expect(getCodexGoalStatusByIdUseCase({ registryRootDir: f.registry, jobId: fresh.jobId })).resolves.toMatchObject({ ok: true, state: "retired" });
  // The controller is retired too, so a local Stop answers before loading it.
  await expect(projectControlStopStoredJobView({ registryRootDir: f.registry, controllerJobId: f.controller, jobId: done.jobId, confirmStop: true } as never,
    { loadProjectControlController: () => { throw new Error("TEST must not load"); } } as never)).resolves.toMatchObject({ ok: true, state: "retired" });
  await expect(loadJobLaunch({ registryRootDir: f.registry, jobId: done.jobId })).rejects.toThrow("codex_goal_job_retired");
  await expect(readCodexGoalJob({ registryRootDir: f.registry, jobId: f.project + "-new-after" })).rejects.toThrow("codex_goal_job_retired");
  // The same plan is an idempotent no-op; any other plan conflicts with the records.
  await expect(retire(plan(f))).resolves.toMatchObject({ ok: true, alreadyRetired: true });
  await expect(retire(plan(f, { [fresh.jobId]: { kind: "handoff", manifestSha256: "0".repeat(64) } }))).rejects.toThrow("job_retirement_record_conflict");
});

it.each([
  ["an active start", (f: Workstream) => { const job = worker(f, "a", { native: true }); json(`${authority(job.jobId)}/active.json`, {}); }, "active_start"],
  ["no terminal record for a run job", (f: Workstream) => { const job = worker(f, "a", { native: true }); harness.terminal.delete(job.jobId); }, "terminal_unproven"],
  ["a writer that is not released", (f: Workstream) => { const job = worker(f, "a", { native: true }); harness.writer.set(job.jobId, "unknown"); }, "writer_not_released"],
  ["a candidate without a publication", (f: Workstream) => { const job = worker(f, "a", { native: true });
    const start = fs.readdirSync(physical(authority(job.jobId) + "/starts"))[0]; json(`${authority(job.jobId)}/starts/${start}/mimo-candidate.json`, {}); }, "candidate_unpublished"],
  ["an account reservation", (f: Workstream) => { const job = worker(f, "a", { native: true }); json(job.jobRoot + "/account-reservation.json", {}); }, "account_reserved"],
  ["a started job without run-state", (f: Workstream) => { worker(f, "a", { started: true }); }, "never_started_unproven"],
  ["an unsettled bridge operation", (f: Workstream) => { const job = worker(f, "a"); operation(f, job.jobId, "status", { state: "running" }); }, "operations_unsettled"],
  ["an unpublished bridge result", (f: Workstream) => { const job = worker(f, "a"); file(`${f.state}/mimo-bridge-operations/${job.jobId}.stop.result.json.tmp`, "{}\n"); }, "operations_unsettled"],
  ["an unregistered Create that succeeded", (f: Workstream) => { worker(f, "a"); const lost = f.project + "-lost";
    json(`${f.state}/mimo-bridge-attempts/${lost}.json`, {}); operation(f, lost, "create", { state: "settled", result: { ok: true, result: { ok: true } } }); }, "attempt_unaccounted"],
  ["a controller recovery guard", (f: Workstream) => { worker(f, "a"); json(f.state + "/.controller-recovery.json", {}); }, "recovery_pending"],
  ["an open route", (f: Workstream) => { worker(f, "a"); const path = `/etc/subscription-runtime/mimo-projects/${f.project}/${f.stream}.json`;
    json(path, { ...f.binding, routingEnabled: true }); Object.assign(f, { bindingSha: sha256(fs.readFileSync(physical(path))) });
    file(`/etc/subscription-runtime/projects/${f.project}.d/${f.stream}.yml`, `project_id: ${f.project}\nworkstream_id: ${f.stream}\n` +
      `state_root: /srv/worker-state/jobs/${f.project}/${f.stream}\nscratch_root: /srv/workers/jobs/${f.project}/${f.stream}\nrouting_enabled: true\n`, 0o644); }, "route_open"],
  ["dirty workspace claimed clean", (f: Workstream) => { const job = worker(f, "a"); file(job.workspace + "/app/new.txt", "TEST change\n", 0o644); }, "workspace_dirty"],
  ["a commit beyond the published state", (f: Workstream) => { const job = worker(f, "a"); file(job.workspace + "/app/new.txt", "TEST change\n", 0o644);
    git(job.workspace, "add", "."); git(job.workspace, "commit", "-q", "-m", "TEST unpublished"); }, "branch_unpublished_commits"],
  ["an unknown scratch entry", (f: Workstream) => { worker(f, "a"); directory(f.scratch + "/workspaces/stray"); }, "scratch_unknown_entry"],
  ["a worktree outside the unit", (f: Workstream) => { worker(f, "a"); git(f.source, "worktree", "add", "-q", "-b", "elsewhere", physical("/srv/workers/elsewhere-" + f.project), f.head); }, "worktree_outside_unit"],
])("refuses %s before any effect", async (_name, arrange, reason) => {
  const f = workstream(); arrange(f);
  const before = [...mounts.keys()];
  await expect(retire(plan(f))).rejects.toThrow("job_retirement_" + reason);
  expect([...mounts.keys()]).toEqual(before);
  for (const jobId of [f.controller, ...f.jobs]) for (const name of ["terminal.json", "retired.json"]) expect(exists(`${f.registry}/${jobId}/${name}`)).toBe(false);
  expect(exists(f.state + "/retired.json")).toBe(false);
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
});

it("refuses while a maintenance fence or a live activity lease is held", async () => {
  const f = workstream(); worker(f, "a");
  const lease = await acquireLocalControllerActivityLease({ controllerJobRootDir: f.state, owner: "TEST live bridge operation" });
  try { await expect(retire(plan(f))).rejects.toThrow("job_retirement_fence_busy"); }
  finally { await releaseLocalControllerActivityLease(lease); }
  const controllerLease = await acquireLocalControllerActivityLease({ controllerJobRootDir: f.state + "/controller", owner: "TEST live publication" });
  try { await expect(retire(plan(f))).rejects.toThrow("job_retirement_fence_busy"); }
  finally { await releaseLocalControllerActivityLease(controllerLease); }
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  await expect(retire(plan(f))).resolves.toMatchObject({ ok: true });
});

it("refuses when another clone borrows objects from the unit", async () => {
  const f = workstream(), other = workstream(); worker(f, "a");
  fs.writeFileSync(physical(other.source + "/.git/objects/info/alternates"), physical(f.source + "/.git/objects") + "\n");
  await expect(retire(plan(f))).rejects.toThrow("job_retirement_alternates_referenced");
  fs.rmSync(physical(other.source + "/.git/objects/info/alternates"));
  // A worktree of this source registered under another workstream depends on it too.
  git(f.source, "worktree", "add", "-q", "-b", "borrowed", physical(other.scratch + "/workspaces/borrowed"), f.head);
  await expect(retire(plan(f))).rejects.toThrow(/job_retirement_(?:alternates_referenced|worktree_outside_unit)/);
});

it("requires the published handoff to match the workspace exactly", async () => {
  const f = workstream(), job = worker(f, "a", { native: true });
  file(job.workspace + "/README.md", "TEST changed by the worker\n", 0o644); file(job.workspace + "/app/new.txt", "TEST untracked\n", 0o644);
  const { materializeDurableCodexGoalHandoffPacket } = await import("../codex-goal-durable-handoff-packet");
  const packet = (await materializeDurableCodexGoalHandoffPacket({ workerJobId: job.jobId, taskId: job.jobId, workspacePath: job.workspace,
    durableRootDir: f.registry + "/durable-handoffs" }))!;
  const handoff = (manifestSha256: string) => plan(f, { [job.jobId]: { kind: "handoff", manifestSha256 } });
  await expect(retire(handoff("0".repeat(64)))).rejects.toThrow("job_retirement_handoff_missing");
  file(job.workspace + "/app/later.txt", "TEST written after publication\n", 0o644);
  await expect(retire(handoff(packet.manifestSha256))).rejects.toThrow("job_retirement_handoff_stale");
  fs.rmSync(physical(job.workspace + "/app/later.txt"));
  file(job.workspace + "/app/new.txt", "TEST untracked, other bytes\n", 0o644);
  await expect(retire(handoff(packet.manifestSha256))).rejects.toThrow("job_retirement_handoff_stale");
  file(job.workspace + "/app/new.txt", "TEST UNTRACKED\n", 0o644); // Same length, other bytes.
  await expect(retire(handoff(packet.manifestSha256))).rejects.toThrow("job_retirement_handoff_stale");
  file(job.workspace + "/app/new.txt", "TEST untracked\n", 0o644);
  await expect(retire(handoff(packet.manifestSha256))).resolves.toMatchObject({ ok: true });
  expect(read(`${f.registry}/${job.jobId}/retired.json`).output).toEqual({ kind: "handoff", manifestSha256: packet.manifestSha256, packetPath: packet.packetPath, head: f.head });
});

it("publishes records atomically and finishes from a crash with the same plan", async () => {
  const f = workstream(), first = worker(f, "a", { native: true }), second = worker(f, "b");
  const path = plan(f);
  harness.linkFailure = new RegExp(`/${second.jobId}/retired\\.json$`);
  await expect(retire(path)).rejects.toThrow("TEST crash during publication");
  harness.linkFailure = undefined;
  // Nothing partial is visible; the durable guard, not a fence, keeps the workstream closed.
  expect(exists(`${f.registry}/${second.jobId}/retired.json`)).toBe(false);
  expect(fs.readdirSync(physical(`${f.registry}/${second.jobId}`)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  expect(read(f.state + "/.job-retirement.json")).toEqual({ schemaVersion: 1, planSha256: sha256(fs.readFileSync(physical(path))) });
  expect(mounts.size).toBe(0);
  await expect(submitHostedMimoProjectBridge(statusRequest(f, second.jobId))).rejects.toThrow("mimo_project_bridge_retirement_pending");
  await expect(loadJobLaunch({ registryRootDir: f.registry, jobId: second.jobId })).rejects.toThrow("codex_goal_job_retired");
  await expect(getCodexGoalStatusByIdUseCase({ registryRootDir: f.registry, jobId: second.jobId })).resolves.toMatchObject({ state: "retiring" });
  // Another plan cannot take over a half-retired workstream.
  await expect(retire(plan(f, { [second.jobId]: { kind: "handoff", manifestSha256: "0".repeat(64) } }))).rejects.toThrow("job_retirement_record_conflict");
  const before = read(`${f.registry}/${first.jobId}/retired.json`);
  await expect(retire(path)).resolves.toMatchObject({ ok: true });
  expect(read(`${f.registry}/${first.jobId}/retired.json`)).toEqual(before);
  expect(read(`${f.registry}/${second.jobId}/retired.json`)).toMatchObject({ jobId: second.jobId, terminal: { kind: "never-started" } });
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  await expect(retire(path)).resolves.toMatchObject({ ok: true, alreadyRetired: true });
});
/** Fences a killed process left behind: its PID and start identity are gone. */
function plantDeadFences(f: Workstream) {
  for (const root of [f.state, f.state + "/controller"]) json(root + "/.controller-maintenance-fence.json", { schemaVersion: 1,
    owner: "TEST killed retirement", ownerToken: "dead", pid: 4194000, processStartIdentity: "Thu Jan  1 00:00:00 1970", createdAt: "2026-10-16T00:00:00.000Z" });
}

it("writes a missing receipt from the records alone after the host deleted the unit", async () => {
  const f = workstream(); worker(f, "a", { native: true });
  const path = plan(f);
  await expect(retire(path, { afterStep: step => { if (step === JobRetirementStep.WorkstreamTombstoned) throw new Error("TEST crash before receipt"); } }))
    .rejects.toThrow("TEST crash before receipt");
  fs.rmSync(physical(f.scratch), { recursive: true, force: true });
  plantDeadFences(f);
  const result = await retire(path) as { receiptPath: string };
  expect(result).toMatchObject({ ok: true, alreadyRetired: true });
  expect(read(result.receiptPath)).toMatchObject({ layout: "mimo-workstream", workstreamTombstoneSha256: sha256(fs.readFileSync(physical(f.state + "/retired.json"))) });
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  expect(exists(f.state + "/controller/.controller-maintenance-fence.json")).toBe(false);
});

it("detects a replaced workspace on replay and keeps busy pins mounted", async () => {
  const f = workstream(), job = worker(f, "a", { native: true }); worker(f, "b");
  const path = plan(f);
  await expect(retire(path, { afterStep: step => { if (step === JobRetirementStep.Tombstoned) throw new Error("TEST crash after tombstones"); } }))
    .rejects.toThrow("TEST crash after tombstones");
  // The directory at the path is no longer the one the tombstone names.
  fs.renameSync(physical(job.workspace), physical(`/srv/workers/moved-${job.jobId}`)); directory(job.workspace);
  await expect(retire(path)).rejects.toThrow("job_retirement_tombstone_identity_mismatch");
  const g = workstream(), held = worker(g, "c", { native: true });
  const busyPin = [...mounts.keys()].find(pin => pin.includes(sha256(held.jobId)) && pin.endsWith("/pins/workspace"))!;
  busy.add(busyPin);
  await expect(retire(plan(g))).rejects.toThrow("job_retirement_pin_busy");
  // Never a lazy unmount: the busy pin stays, the job stays closed but not retired.
  expect(mounts.has(busyPin)).toBe(true);
  expect(exists(`${g.registry}/${held.jobId}/terminal.json`)).toBe(true);
  expect(exists(`${g.registry}/${held.jobId}/retired.json`)).toBe(false);
});

it("dry run reports every job and changes nothing", async () => {
  const f = workstream(), done = worker(f, "a", { native: true }), dirty = worker(f, "b");
  file(dirty.workspace + "/app/new.txt", "TEST change\n", 0o644);
  const before = [...mounts.keys()];
  const report = await retire(plan(f), { dryRun: true }) as { ready: boolean; jobs: { jobId: string; blocker?: string; terminal?: string }[] };
  expect(report).toMatchObject({ ok: true, dryRun: true, ready: false });
  expect(report.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: done.jobId, terminal: "native-released" }),
    expect.objectContaining({ jobId: dirty.jobId, blocker: "workspace_dirty" })]));
  expect([...mounts.keys()]).toEqual(before);
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  for (const jobId of f.jobs) expect(exists(`${f.registry}/${jobId}/terminal.json`)).toBe(false);
});

/** A shared project registry: one job is retired, the controller and other jobs stay. */
function projectRegistry() {
  const project = "proj" + ++counter, stream = "main", state = `/srv/worker-state/jobs/${project}/${stream}`, registry = state + "/registry";
  const scratch = `/srv/workers/jobs/${project}/${stream}`, main = scratch + "/main";
  for (const path of [state, registry, scratch, state + "/controller"]) directory(path);
  const head = repository(main);
  register(registry, manifest(project + "-controller", state + "/controller", main, { accessBoundary: "project_scoped_control" }));
  return { project, stream, state, registry, scratch, main, head, controller: project + "-controller" };
}
function projectJob(p: ReturnType<typeof projectRegistry>, jobId: string) {
  const workspace = `${p.scratch}/worktrees/${jobId}`, jobRoot = `${p.state}/jobs/${jobId}`;
  git(p.main, "worktree", "add", "-q", "-b", "feat/" + jobId, physical(workspace), p.head);
  directory(jobRoot);
  register(p.registry, manifest(jobId, jobRoot, workspace));
  return { workspace, jobRoot };
}
function jobPlan(p: ReturnType<typeof projectRegistry>, jobId: string) {
  const path = `/etc/subscription-runtime/job-retirement/plan-${++plans}.json`;
  json(path, { schemaVersion: 1, machineId: machine, target: { kind: "job", registryRootDir: p.registry, jobId },
    jobs: [{ jobId, expectedManifestSha256: manifestSha(p.registry, jobId), output: { kind: "clean" } }] });
  return path;
}

it("retires one disposed job of a shared project registry and answers Status and Stop without its workspace", async () => {
  const p = projectRegistry(), job = projectJob(p, p.project + "-x"), other = projectJob(p, p.project + "-y");
  const jobId = p.project + "-x", events = `${job.jobRoot}/${jobId}.events.jsonl`;
  file(events, runnerEvent("runner_starting", jobId) + runnerEvent("runner_exception", jobId));
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_runner_not_disposed");
  // Another run's disposal proves nothing about this one.
  file(events, runnerEvent("runner_starting", jobId) + runnerEvent("runner_disposed", p.project + "-y"));
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_runner_not_disposed");
  file(events, runnerEvent("runner_starting", jobId) + runnerEvent("runner_disposed", jobId));
  harness.status.set(jobId, { progressProcessAlive: true });
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_worker_alive");
  harness.status.set(jobId, { progressProcessAlive: false });
  await expect(retire(jobPlan(p, jobId))).resolves.toMatchObject({ ok: true });
  expect(read(`${p.registry}/${jobId}/retired.json`)).toMatchObject({ layout: "project-workstream", deletion: { scope: "workspace" },
    terminal: { kind: "runner-disposed", eventsPath: events } });
  expect(exists(`${p.registry}/${p.project}-y/terminal.json`)).toBe(false);
  expect(exists(p.state + "/controller/.controller-maintenance-fence.json")).toBe(false);
  void other;
  fs.rmSync(physical(job.workspace), { recursive: true, force: true });
  await expect(getCodexGoalStatusByIdUseCase({ registryRootDir: p.registry, jobId })).resolves.toMatchObject({ ok: true, jobId, state: "retired" });
  await expect(stopStoredJobLifecycle({ registryRootDir: p.registry, jobId }, { loadJobLaunch: () => { throw new Error("TEST must not load"); } }))
    .resolves.toMatchObject({ ok: true, state: "retired" });
  const deps = { loadProjectControlController: async () => ({ registryRootDir: p.registry, controller: { jobId: p.controller }, scope: {} }),
    loadJobLaunch: () => { throw new Error("TEST must not load"); }, codexProjectControlBroker: () => { throw new Error("TEST must not stop"); } };
  await expect(projectControlStopStoredJobView({ registryRootDir: p.registry, controllerJobId: p.controller, jobId, confirmStop: true } as never, deps as never))
    .resolves.toMatchObject({ ok: true, mode: "project_control_stop", state: "retired" });
});

it("refuses a job unit that is a controller, a MiMo job alone or outside its scratch root", async () => {
  const p = projectRegistry();
  await expect(retire(jobPlan(p, p.controller))).rejects.toThrow("job_retirement_controller_requires_workstream");
  const outside = `/srv/workers/other-${p.project}`, outsideJob = p.project + "-out"; repository(outside); directory(`${p.state}/jobs/${outsideJob}`);
  register(p.registry, manifest(outsideJob, `${p.state}/jobs/${outsideJob}`, outside));
  await expect(retire(jobPlan(p, outsideJob))).rejects.toThrow("job_retirement_workspace_outside_scratch");
  const f = workstream(), mimo = worker(f, "m");
  const path = `/etc/subscription-runtime/job-retirement/plan-${++plans}.json`;
  json(path, { schemaVersion: 1, machineId: machine, target: { kind: "job", registryRootDir: f.registry, jobId: mimo.jobId },
    jobs: [{ jobId: mimo.jobId, expectedManifestSha256: manifestSha(f.registry, mimo.jobId), output: { kind: "clean" } }] });
  await expect(retire(path)).rejects.toThrow("job_retirement_unit_must_be_workstream");
});

const refusingBroker = new Proxy({}, { get: () => () => { throw new Error("TEST broker must not run"); } });
/** Every effect path reads the job through the guarded reader, so each one refuses. */
async function expectEffectsRefused(registry: string, controller: string, controllerRoot: string, jobId: string, reason: string) {
  const deps = { loadProjectControlController: async () => ({ registryRootDir: registry, controller: { jobId: controller, jobRootDir: controllerRoot }, scope: {} }),
    loadJobLaunch: () => { throw new Error("TEST must not load"); }, codexProjectControlBroker: () => refusingBroker };
  await expect(readCodexGoalJob({ registryRootDir: registry, jobId })).rejects.toThrow(reason);
  await expect(loadJobLaunch({ registryRootDir: registry, jobId })).rejects.toThrow(reason);
  await expect(projectControlStartStoredJobView({ registryRootDir: registry, controllerJobId: controller, jobId, confirmStart: true, forceStart: true } as never,
    deps as never)).rejects.toThrow(reason);
  await expect(createOrReuseProjectJob({ broker: refusingBroker as never, registryRootDir: registry, scope: {} as never,
    manifest: { jobId } as never, promptBody: "TEST" })).rejects.toThrow(reason);
  await expect(updateCodexGoalJob({ registryRootDir: registry, jobId, patch: { description: "TEST revived" } })).rejects.toThrow(reason);
}

it("refuses every effect path of a retired job and keeps read-only projections", async () => {
  const p = projectRegistry(), jobId = p.project + "-s"; projectJob(p, jobId);
  disposedRun(`${p.state}/jobs/${jobId}`, jobId);
  await expect(retire(jobPlan(p, jobId))).resolves.toMatchObject({ ok: true });
  await expectEffectsRefused(p.registry, p.controller, p.state + "/controller", jobId, "codex_goal_job_retired");
  const stored = read(`${p.registry}/${jobId}/job.json`);
  await expect(createCodexGoalJob({ registryRootDir: p.registry, manifest: stored, overwrite: true })).rejects.toThrow("codex_goal_job_retired");
  await expect(readCodexGoalJob({ registryRootDir: p.registry, jobId, includeRetired: true })).resolves.toMatchObject({ jobId });
  expect((await listCodexGoalJobs({ registryRootDir: p.registry })).map(job => job.jobId)).toContain(jobId);
  // The other jobs of the shared registry are untouched.
  await expect(readCodexGoalJob({ registryRootDir: p.registry, jobId: p.controller })).resolves.toMatchObject({ jobId: p.controller });
});

it("keeps every effect path of a MiMo workstream closed after a partial retirement", async () => {
  const f = workstream(), job = worker(f, "open");
  const path = plan(f);
  await expect(retire(path, { afterStep: step => { if (step === JobRetirementStep.Guarded) throw new Error("TEST crash after guard"); } }))
    .rejects.toThrow("TEST crash after guard");
  // No job is closed yet and the fences are released: the durable guard alone holds.
  expect(exists(`${f.registry}/${job.jobId}/terminal.json`)).toBe(false);
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  await expectEffectsRefused(f.registry, f.controller, f.state + "/controller", job.jobId, "codex_goal_job_retirement_pending");
  await expect(readCodexGoalJob({ registryRootDir: f.registry, jobId: f.controller })).rejects.toThrow("codex_goal_job_retirement_pending");
  // The read-only writer observation a replay needs still loads the job.
  await expect(loadJobLaunch({ registryRootDir: f.registry, jobId: job.jobId }, { includeRetired: true })).resolves.toMatchObject({ manifest: { jobId: job.jobId } });
  const added = f.project + "-added";
  await expect(createCodexGoalJob({ registryRootDir: f.registry, manifest: manifest(added, `${f.state}/jobs/${added}`, `${f.scratch}/workspaces/${added}`) as never }))
    .rejects.toThrow("codex_goal_job_retirement_pending");
  await expect(submitHostedMimoProjectBridge(statusRequest(f, job.jobId, "start"))).rejects.toThrow("mimo_project_bridge_retirement_pending");
  expect(exists(`${f.registry}/${added}`)).toBe(false);
  // Nothing is closed yet, so the operator may withdraw the plan and reopen the workstream.
  await expect(retire(path, { cancel: true })).resolves.toMatchObject({ ok: true, cancelled: true });
  expect(exists(f.state + "/.job-retirement.json")).toBe(false);
  await expect(readCodexGoalJob({ registryRootDir: f.registry, jobId: job.jobId })).resolves.toMatchObject({ jobId: job.jobId });
  // Once a job is closed the retirement can only be finished.
  await expect(retire(path, { afterStep: step => { if (step === JobRetirementStep.Closed) throw new Error("TEST crash after close"); } }))
    .rejects.toThrow("TEST crash after close");
  await expect(retire(path, { cancel: true })).rejects.toThrow("job_retirement_retirement_pending");
  await expect(retire(path)).resolves.toMatchObject({ ok: true });
});

it("refuses a workstream whose scratch root another binding or registered job claims", async () => {
  const f = workstream(); worker(f, "a");
  const foreign = `/etc/subscription-runtime/mimo-projects/${f.project}/other.json`;
  json(foreign, { ...f.binding, workstreamId: "other", stateRoot: f.state + "-other", registryRootDir: f.state + "-other/registry", scratchRoot: f.scratch });
  await expect(retire(plan(f))).rejects.toThrow("job_retirement_workspace_shared");
  json(foreign, { ...f.binding, workstreamId: "other", stateRoot: f.state + "-other", registryRootDir: f.state + "-other/registry",
    scratchRoot: f.scratch + "-other", sourceWorkspacePath: f.scratch + "/workspaces/borrowed" });
  await expect(retire(plan(f))).rejects.toThrow("job_retirement_workspace_shared");
  fs.rmSync(physical(foreign));
  const p = projectRegistry(), other = p.project + "-tmp";
  register(p.registry, manifest(other, `${p.state}/jobs/${other}`, `${p.scratch}/worktrees/${other}`, { agentTempRootDir: f.scratch + "/tmp" }));
  await expect(retire(plan(f))).rejects.toThrow("job_retirement_workspace_shared");
  fs.rmSync(physical(`${p.registry}/${other}`), { recursive: true });
  await expect(retire(plan(f))).resolves.toMatchObject({ ok: true });
});

it("never runs a program the repository names and refuses what would hide an edit", async () => {
  const p = projectRegistry(), jobId = p.project + "-git", workspace = `${p.scratch}/clones/${jobId}`, markers = physical(`/srv/markers-${p.project}`);
  repository(workspace); directory(`${p.state}/jobs/${jobId}`); directory(`/srv/markers-${p.project}`);
  disposedRun(`${p.state}/jobs/${jobId}`, jobId);
  register(p.registry, manifest(jobId, `${p.state}/jobs/${jobId}`, workspace));
  const touch = (name: string) => `/usr/bin/touch ${markers}/${name}`;
  // A worker controls its repository: drivers named there would run as root.
  git(workspace, "config", "filter.evil.clean", touch("filter")); git(workspace, "config", "diff.evil.textconv", touch("textconv"));
  git(workspace, "config", "core.fsmonitor", touch("fsmonitor"));
  file(workspace + "/.gitattributes", "* filter=evil diff=evil\n", 0o644); file(workspace + "/README.md", "TEST edited by the worker\n", 0o644);
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_git_config_unsafe");
  for (const section of ["filter.evil", "diff.evil"]) git(workspace, "config", "--remove-section", section);
  git(workspace, "config", "--unset", "core.fsmonitor"); fs.rmSync(physical(workspace + "/.gitattributes"));
  // An assume-unchanged entry hides the edit from status and diff.
  git(workspace, "update-index", "--assume-unchanged", "README.md");
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_git_index_masked");
  git(workspace, "update-index", "--no-assume-unchanged", "README.md"); file(workspace + "/README.md", "TEST source\n", 0o644);
  file(workspace + "/.gitmodules", "[submodule \"vendor\"]\n\tpath = app/vendor\n\turl = ./vendor\n", 0o644);
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_git_submodule_present");
  fs.rmSync(physical(workspace + "/.gitmodules"));
  // A nested repository's own driver would run when status looks into it.
  const nested = workspace + "/app/vendor";
  repository(nested); git(nested, "config", "filter.evil.clean", touch("nested")); file(nested + "/.gitattributes", "* filter=evil\n", 0o644);
  file(nested + "/README.md", "TEST nested edit\n", 0o644); git(workspace, "update-index", "--add", "--cacheinfo", `160000,${git(nested, "rev-parse", "HEAD")},app/vendor`);
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_git_submodule_present");
  expect(fs.readdirSync(markers)).toEqual([]);
  expect(exists(`${p.registry}/${jobId}/terminal.json`)).toBe(false);
});

/** What a writer of the index can do: keep an entry's stat data current but name other content. */
function forgeIndexEntry(repo: string, path: string, objectId: string) {
  const file = physical(repo + "/.git/index"), index = fs.readFileSync(file);
  expect(index.readUInt32BE(4)).toBe(2);
  for (let entry = 0, at = 12; entry < index.readUInt32BE(8); entry++) {
    const nameLength = index.readUInt16BE(at + 60) & 0xfff;
    if (index.subarray(at + 62, at + 62 + nameLength).toString() === path) Buffer.from(objectId, "hex").copy(index, at + 40);
    at += (62 + nameLength + 8) & ~7;
  }
  createHash("sha1").update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  fs.writeFileSync(file, index);
}

it("compares the files themselves, not stat data the index or configuration vouches for", async () => {
  const p = projectRegistry(), jobId = p.project + "-stat", workspace = `${p.scratch}/clones/${jobId}`;
  repository(workspace); directory(`${p.state}/jobs/${jobId}`); disposedRun(`${p.state}/jobs/${jobId}`, jobId);
  register(p.registry, manifest(jobId, `${p.state}/jobs/${jobId}`, workspace));
  const original = git(workspace, "rev-parse", "HEAD:README.md");
  // An older file than the index is not racily clean, so Git trusts its stat data.
  file(workspace + "/README.md", "TEST SOURCE\n", 0o644); fs.utimesSync(physical(workspace + "/README.md"), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  git(workspace, "add", "README.md");
  forgeIndexEntry(workspace, "README.md", original);
  // The premise: Git itself now reports the edited workspace as clean.
  expect(git(workspace, "status", "--porcelain")).toBe("");
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_workspace_dirty");
  // Weaker stat checks from the repository's configuration do not apply either.
  git(workspace, "config", "core.trustctime", "false"); git(workspace, "config", "core.checkStat", "minimal");
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_workspace_dirty");
  expect(exists(`${p.registry}/${jobId}/terminal.json`)).toBe(false);
});

it("reads repository configuration the way Git does before root runs Git", () => {
  let probes = 0;
  const inert = (text: string) => { const path = `/srv/config-probes/config-${++probes}`; file(path, text, 0o644); assertRetirementConfigInert(path); };
  expect(() => inert("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote \"origin\"]\n\turl = https://example.com/x.git\n" +
    "\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n[user]\n\tname = \"a ; b # c\"\n")).not.toThrow();
  // A continued value is not a header.
  expect(() => inert("[user]\n\tname = a\\\n[filter \"x\"]\n")).not.toThrow();
  for (const text of ["[Filter \"evil\"]\n\tclean = x\n", "[filter.evil]\n\tclean = x\n", "[diff \"x\"] textconv = y\n", "[core] fsmonitor = x\n",
    "[includeIf \"gitdir:/srv/\"]\n\tpath = y\n", "[include]\n\tpath = y\n", "[submodule \"x\"]\n\turl = y\n", "[hook \"x\"]\n\tcommand = y\n",
    // An escaped backslash ends the value; quoted comment marks are text.
    "[core]\n\tname = x \\\\\n\tfsmonitor = y\n", "[core]\n\tname = \"x;y\" ; z\n\tfsmonitor = y\n",
    "[core]\r\n\tFSMonitor = y\r\n", "[core]\n\tworktree = /srv\n", "[core\n", "[core]\n\tname = \"open\n"])
    expect(() => inert(text)).toThrow("job_retirement_git_config_unsafe");
  // Only root may be able to change what Git reads.
  file("/srv/config-probes/shared", "[user]\n\tname = a\n", 0o666);
  expect(() => assertRetirementConfigInert("/srv/config-probes/shared")).toThrow("job_retirement_git_config_unsafe");
});

it("refuses a workspace another registered job shares or nests in", async () => {
  const p = projectRegistry(), owner = p.project + "-owner", job = projectJob(p, owner);
  disposedRun(`${p.state}/jobs/${owner}`, owner);
  // A verifier sharing the producer's workspace is a normal project layout.
  directory(`${p.state}/jobs/${p.project}-verifier`);
  register(p.registry, manifest(p.project + "-verifier", `${p.state}/jobs/${p.project}-verifier`, job.workspace));
  await expect(retire(jobPlan(p, owner))).rejects.toThrow("job_retirement_workspace_shared");
  const verifier = p.project + "-verifier", verifierRoot = `${p.state}/jobs/${verifier}`;
  json(`${p.registry}/${verifier}/job.json`, manifest(verifier, verifierRoot, job.workspace + "/nested"));
  await expect(retire(jobPlan(p, owner))).rejects.toThrow("job_retirement_workspace_shared");
  // Any path another job names counts, at any depth of its manifest.
  json(`${p.registry}/${verifier}/job.json`, manifest(verifier, verifierRoot, `${p.scratch}/worktrees/elsewhere`,
    { projectAccessScope: { projectId: p.project, readRoots: [job.workspace + "/app"] } }));
  await expect(retire(jobPlan(p, owner))).rejects.toThrow("job_retirement_workspace_shared");
  expect(exists(`${p.registry}/${owner}/terminal.json`)).toBe(false);
  // A producer and its verifier sharing one workspace retire together.
  json(`${p.registry}/${verifier}/job.json`, manifest(verifier, verifierRoot, job.workspace));
  disposedRun(`${verifierRoot}`, verifier);
  const both = `/etc/subscription-runtime/job-retirement/plan-${++plans}.json`;
  json(both, { schemaVersion: 1, machineId: machine, target: { kind: "job", registryRootDir: p.registry, jobId: owner },
    jobs: [owner, verifier].map(jobId => ({ jobId, expectedManifestSha256: manifestSha(p.registry, jobId), output: { kind: "clean" } })) });
  await expect(retire(both)).resolves.toMatchObject({ ok: true });
  expect(read(`${p.registry}/${verifier}/retired.json`).workspace).toEqual(read(`${p.registry}/${owner}/retired.json`).workspace);
});

it("refuses a job that keeps its own state inside the unit or a plan of jobs with other workspaces", async () => {
  const p = projectRegistry(), jobId = p.project + "-auth", job = projectJob(p, jobId), other = p.project + "-other";
  disposedRun(`${job.jobRoot}`, jobId);
  // Deleting the workspace would take the job's credentials with it.
  json(`${p.registry}/${jobId}/job.json`, manifest(jobId, job.jobRoot, job.workspace, { authRootDir: job.workspace + "/.auth" }));
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_state_inside_unit");
  json(`${p.registry}/${jobId}/job.json`, manifest(jobId, job.jobRoot, job.workspace));
  projectJob(p, other);
  const mixed = `/etc/subscription-runtime/job-retirement/plan-${++plans}.json`;
  json(mixed, { schemaVersion: 1, machineId: machine, target: { kind: "job", registryRootDir: p.registry, jobId },
    jobs: [jobId, other].map(id => ({ jobId: id, expectedManifestSha256: manifestSha(p.registry, id), output: { kind: "clean" } })) });
  await expect(retire(mixed)).rejects.toThrow("job_retirement_plan_jobs_mismatch");
});

it("refuses a standalone clone with an unpublished local branch", async () => {
  const p = projectRegistry(), jobId = p.project + "-clone", workspace = `${p.scratch}/clones/${jobId}`;
  repository(workspace); directory(`${p.state}/jobs/${jobId}`);
  disposedRun(`${p.state}/jobs/${jobId}`, jobId);
  register(p.registry, manifest(jobId, `${p.state}/jobs/${jobId}`, workspace));
  const head = git(workspace, "rev-parse", "HEAD");
  git(workspace, "checkout", "-q", "-b", "side"); file(workspace + "/app/side.txt", "TEST side work\n", 0o644);
  git(workspace, "add", "."); git(workspace, "commit", "-q", "-m", "TEST side"); git(workspace, "checkout", "-q", "--detach", head);
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_branch_unpublished_commits");
});

it("refuses before any effect a record its readers would reject", async () => {
  const p = projectRegistry(), jobId = p.project + "-space", workspace = `${p.scratch}/worktrees/with space`;
  git(p.main, "worktree", "add", "-q", "-b", "feat/" + jobId, physical(workspace), p.head);
  directory(`${p.state}/jobs/${jobId}`); disposedRun(`${p.state}/jobs/${jobId}`, jobId);
  register(p.registry, manifest(jobId, `${p.state}/jobs/${jobId}`, workspace));
  await expect(retire(jobPlan(p, jobId))).rejects.toThrow("job_retirement_record_invalid");
  expect(fs.readdirSync(physical(`${p.registry}/${jobId}`))).toEqual(["job.json"]);
});

it("proves a closed never-started job again on replay", async () => {
  const f = workstream(), job = worker(f, "n");
  const path = plan(f);
  await expect(retire(path, { afterStep: step => { if (step === JobRetirementStep.Closed) throw new Error("TEST crash after close"); } })).rejects.toThrow("TEST crash");
  // Something ran in the job root after it was closed: the close no longer holds.
  file(`${job.jobRoot}/${job.jobId}.events.jsonl`, runnerEvent("runner_starting", job.jobId));
  await expect(retire(path)).rejects.toThrow("job_retirement_runner_not_disposed");
  // Even a run that finished is another terminal fact than the closed record states.
  disposedRun(`${job.jobRoot}`, job.jobId);
  await expect(retire(path)).rejects.toThrow("job_retirement_terminal_unproven");
  expect(exists(`${f.registry}/${job.jobId}/retired.json`)).toBe(false);
});

it("finishes a closed native job after a reboot lost its run-state", async () => {
  const f = workstream(), job = worker(f, "r", { native: true });
  const path = plan(f);
  await expect(retire(path, { afterStep: step => { if (step === JobRetirementStep.Closed) throw new Error("TEST crash after close"); } })).rejects.toThrow("TEST crash");
  fs.rmSync(physical(authority(job.jobId)), { recursive: true, force: true }); mounts.clear(); harness.terminal.delete(job.jobId);
  // The same boot without run-state is doubt; another boot proves nothing of the old one runs.
  await expect(retire(path)).rejects.toThrow("job_retirement_terminal_unproven");
  boot.id = "22222222-2222-4222-8222-222222222222";
  await expect(retire(path)).resolves.toMatchObject({ ok: true });
  expect(read(`${f.registry}/${job.jobId}/retired.json`)).toMatchObject({ terminal: { kind: "native-released" }, pins: [] });
});
