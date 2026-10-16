import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ operations: new Map<string, object | (() => object)>(), project: "", release: undefined as (() => void) | undefined }));
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
    result[name] = async (...args: unknown[]) => { const answer = await fn(...args.map(boundary.map)); return name === "realpath" && !String(args[0]).startsWith("/proc/self/fd/") ? boundary.unmap(answer as string) : answer; };
  }
  return result;
});
vi.mock("node:child_process", async original => {
  const cp = await original<typeof import("node:child_process")>();
  const mapped = (args: string[]) => args.map(arg => boundary.map(arg) as string);
  return { ...cp, execFile: Object.assign((file: string, args: string[], ...rest: unknown[]) => (cp.execFile as Function)(file, mapped(args), ...rest),
    { [Symbol.for("nodejs.util.promisify.custom")]: (file: string, args: string[], options: object) => new Promise((resolve, reject) =>
      cp.execFile(file, mapped(args), options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) }),
    execFileSync: (file: string, args: string[], options: object) => cp.execFileSync(file, mapped(args), options) };
});
vi.mock("../research-launch-host", async original => ({ ...await original<object>(), assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(),
  researchProcessIdentity: () => ({ pid: process.pid, birthTicks: "1", bootId: "b".repeat(36), machineId: "b".repeat(32), controlGroup: "/TEST", namespaces: { user: "TEST", mnt: "TEST", pid: "TEST", net: "TEST" } }),
  researchCommand: (command: string, args: string[]) => { const cp = require("node:child_process") as typeof import("node:child_process");
    return cp.execFileSync(command === "/usr/bin/ps" && process.platform === "darwin" ? "/bin/ps" : command, args.map(arg => boundary.map(arg) as string), { encoding: "utf8" }); } }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: (path: string, privateLeaf = false) => {
  // Host UID and fixed namespace are mapped; real directory/file/mode checks remain.
  const fs = require("node:fs") as typeof import("node:fs");
  const physical = boundary.map(path) as string;
  let current = physical;
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.mode & 0o022) || (privateLeaf && current === physical && (stat.mode & 0o077))) throw new Error("TEST custody denied");
    if (current === boundary.root) break;
    const parent = current.slice(0, current.lastIndexOf("/")) || "/";
    if (parent === current || !current.startsWith(boundary.root)) break;
    current = parent;
  }
} }));
// Operation observation needs systemd; the observer is the unit boundary here and its own suite covers the real one.
vi.mock("../hosted-mimo-project-bridge-operation", async original => ({ ...await original<object>(),
  observeHostedMimoProjectOperation: (request: { jobId: string; operation: string }) => {
    const row = harness.operations.get(`${request.jobId}.${request.operation}`);
    return typeof row === "function" ? row() : row ?? { state: "absent" };
  } }));
vi.mock("../codex-goal-mcp-project-control-deps", async original => ({ ...await original<object>(),
  loadProjectControlController: async () => ({ scope: { projectId: harness.project, allowedAccountIds: ["account-q"] } }) }));
import { advanceHostedMimoProjectSource, MimoAdvanceStep, type MimoAdvanceOptions } from "../hosted-mimo-project-bridge-advance";
import { hostedMimoSealedSourcePort } from "../hosted-mimo-project-source";
import { withHostedMimoWorkstreamActivity } from "../hosted-mimo-project-workstream-fence";
import { acquireLocalControllerActivityLease, acquireLocalControllerMaintenanceFence, releaseLocalControllerActivityLease, releaseLocalControllerMaintenanceFence }
  from "@vioxen/subscription-runtime/store-local-file";
const fs = await vi.importActual<typeof import("node:fs")>("node:fs"), cp = await vi.importActual<typeof import("node:child_process")>("node:child_process");
boundary.root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "TEST-mimo-advance-")));
boundary.map = value => typeof value === "string" && /^\/(?:srv|etc|opt|run|TEST-artifact)(?:\/|$)/.test(value) ? boundary.root + value : value;
boundary.unmap = value => value.startsWith(boundary.root + "/") ? value.slice(boundary.root.length) : value;
const physical = (path: string) => boundary.map(path) as string;
function directory(path: string, mode = 0o700) { fs.mkdirSync(physical(path), { recursive: true, mode }); fs.chmodSync(physical(path), mode); }
function file(path: string, bytes: string, mode = 0o600) { directory(path.slice(0, path.lastIndexOf("/"))); fs.writeFileSync(physical(path), bytes, { mode }); }
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const gitEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (repo: string, ...args: string[]) => cp.execFileSync("/usr/bin/git", ["-C", physical(repo), ...args], { encoding: "utf8", env: gitEnv }).trim();
afterAll(() => fs.rmSync(boundary.root, { recursive: true, force: true }));
beforeEach(() => { harness.operations.clear(); harness.release = undefined; });

const machine = "b".repeat(32), url = "https://github.com/example/project.git", fast = { fenceTimeoutMs: 250, fenceRetryMs: 25 } as const;
let counter = 0;
type Fixture = Awaited<ReturnType<typeof fixture>>;
function contractFor(f: { scratch: string }, commit: string, command = "true") {
  return { kind: "worker-launch", format: 1, canonicalSha: commit, baseSha: commit, phaseStartSha: commit, packetRevision: "test-r1", controllerPacket: "README.md", lanePacket: "README.md",
    phaseId: "phase-01", laneId: "test-lane", inputPatchHash: null, reviewKind: "implementation", ownedPaths: ["app/"], mandatoryDocs: ["README.md"], mandatoryScripts: [], mandatoryFixtures: [],
    requiredChecks: [{ id: "test", cwd: "app", command }], executionPolicy: { mode: "sandbox-only", sandboxRoot: f.scratch + "/source/app", forbiddenRealProjects: ["/srv/workers/jobs"] } };
}
/** A real snapshot at B and a real source checkout at A, wired like preparation leaves them. */
async function fixture(pinned = false) {
  const project = "adv" + ++counter, stream = "main", snapshot = `/srv/reviewed/${project}`;
  const state = `/srv/worker-state/mimo-projects/${project}/${stream}`, scratch = `/srv/workers/mimo-projects/${project}/${stream}`, source = scratch + "/source";
  harness.project = project;
  directory("/srv/reviewed"); directory(snapshot); directory(state); directory(state + "/mimo-bridge-operations"); directory(scratch); directory("/TEST-artifact");
  file("/etc/machine-id", machine);
  file(`/etc/subscription-runtime/projects/${project}.d/${stream}.yml`, `project_id: ${project}\nworkstream_id: ${stream}\nstate_root: /srv/worker-state/jobs/${project}/${stream}\nscratch_root: /srv/workers/jobs/${project}/${stream}\nrouting_enabled: true\n`);
  git(snapshot, "init", "-b", "main"); git(snapshot, "config", "user.name", "iliya"); git(snapshot, "config", "user.email", "iliyazelenkog@gmail.com");
  git(snapshot, "remote", "add", "origin", url);
  file(snapshot + "/README.md", "TEST source one\n"); file(snapshot + "/app/.keep", "TEST sandbox\n");
  git(snapshot, "add", "."); git(snapshot, "commit", "-m", "TEST one"); const A = git(snapshot, "rev-parse", "HEAD");
  git(snapshot, "update-ref", "refs/remotes/origin/main", A);
  cp.execFileSync("/usr/bin/git", ["clone", "--quiet", "--no-hardlinks", "--no-local", "--", physical(snapshot), physical(source)], { env: gitEnv });
  git(source, "remote", "set-url", "origin", url); git(source, "checkout", "--detach", A); git(source, "update-ref", "refs/remotes/origin/main", A);
  const binding = { schemaVersion: 1 as const, projectId: project, workstreamId: stream, machineId: machine, routingEnabled: true, stateRoot: state, scratchRoot: scratch, registryRootDir: state + "/registry",
    controllerJobId: project + "-controller", sourceWorkspacePath: source, sourceCommit: A, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/true", taskTimeoutMs: 600000,
    appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract: contractFor({ scratch }, A, pinned ? `test "$(git rev-parse HEAD)" = ${A}` : "true") } };
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${project}/${stream}.json`;
  file(bindingPath, JSON.stringify(binding) + "\n");
  const f = { project, stream, snapshot, state, scratch, source, A, binding, bindingPath, planned: 0 };
  return { ...f, B: commit(f, "TEST source two\n") };
}
/** Moves the snapshot forward the way the reviewed refresh leaves it: ref and detached HEAD both at the new commit. */
function commit(f: { snapshot: string }, text: string): string {
  file(f.snapshot + "/README.md", text); git(f.snapshot, "add", "."); git(f.snapshot, "commit", "-m", "TEST " + text.trim());
  const sha = git(f.snapshot, "rev-parse", "HEAD"); git(f.snapshot, "update-ref", "refs/remotes/origin/main", sha); return sha;
}
const planFor = (f: Fixture, over: Record<string, unknown> = {}) => ({ schemaVersion: 1, projectId: f.project, workstreamId: f.stream, machineId: machine,
  expectedBindingSha256: sha256(fs.readFileSync(physical(f.bindingPath))), expectedSourceCommit: f.A, newSourceCommit: f.B, sourceSnapshotPath: f.snapshot, acknowledgedJobIds: [], ...over });
function writePlan(f: Fixture, plan: object): string {
  const path = `/etc/subscription-runtime/mimo-advance/plan-${f.project}-${++f.planned}.json`; file(path, JSON.stringify(plan)); return path;
}
const advance = (f: Fixture, plan: object, options: MimoAdvanceOptions = fast) => advanceHostedMimoProjectSource(writePlan(f, plan), options);
const bindingBytes = (f: Fixture) => fs.readFileSync(physical(f.bindingPath));
const exists = (path: string) => fs.existsSync(physical(path));
function job(f: Fixture, jobId: string, operations: Record<string, object>) {
  for (const [operation, observation] of Object.entries(operations)) {
    file(`${f.state}/mimo-bridge-operations/${jobId}.${operation}.owner.json`, "{}\n"); harness.operations.set(`${jobId}.${operation}`, observation);
  }
}
const settledOk = { state: "settled", result: { ok: true, result: { ok: true } } };
function untouched(f: Fixture, before: Buffer) {
  expect(bindingBytes(f)).toEqual(before);
  expect(git(f.source, "rev-parse", "HEAD")).toBe(f.A); expect(git(f.source, "rev-parse", "refs/remotes/origin/main")).toBe(f.A);
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false); expect(exists(f.state + "/source-advances")).toBe(false);
}
function deadFence(f: Fixture) {
  file(f.state + "/.controller-maintenance-fence.json", JSON.stringify({ schemaVersion: 1, owner: "TEST dead advance", ownerToken: "dead", pid: 4194000,
    processStartIdentity: "Thu Jan  1 00:00:00 1970", createdAt: new Date().toISOString() }) + "\n");
}
const crash = (step: MimoAdvanceStep): MimoAdvanceOptions => ({ ...fast, afterStep: seen => { if (seen === step) throw new Error("TEST crash after " + step); } });

it("advances the source, ref and binding in place and leaves job worktrees and packed refs alone", async () => {
  const f = await fixture();
  git(f.source, "worktree", "add", "-b", "feat/test-job", physical(f.scratch + "/workspaces/test-job"), f.A);
  const packed = fs.readFileSync(physical(f.source + "/.git/packed-refs")), before = bindingBytes(f);
  const result = await advance(f, planFor(f)) as { newBindingSha256: string; receiptPath: string };
  expect(git(f.source, "rev-parse", "HEAD")).toBe(f.B); expect(git(f.source, "rev-parse", "refs/remotes/origin/main")).toBe(f.B);
  expect(git(f.source, "status", "--porcelain")).toBe("");
  const next = JSON.parse(bindingBytes(f).toString());
  expect(next).toMatchObject({ sourceCommit: f.B, sourceRef: "origin/main", controllerJobId: f.binding.controllerJobId });
  expect(next.admission.contract).toMatchObject({ canonicalSha: f.B, baseSha: f.B, phaseStartSha: f.B });
  expect(Object.keys(next)).toEqual(Object.keys(f.binding)); expect(sha256(bindingBytes(f))).toBe(result.newBindingSha256);
  expect(bindingBytes(f)).not.toEqual(before);
  // Containment: packed-refs, job worktrees and branches, and the temporary ref.
  expect(fs.readFileSync(physical(f.source + "/.git/packed-refs"))).toEqual(packed);
  expect(git(f.scratch + "/workspaces/test-job", "rev-parse", "HEAD")).toBe(f.A); expect(git(f.source, "rev-parse", "refs/heads/feat/test-job")).toBe(f.A);
  expect(git(f.source, "for-each-ref", "refs/mimo-advance")).toBe("");
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  const receipt = JSON.parse(fs.readFileSync(physical(`${f.state}/source-advances/${f.A}..${f.B}.json`), "utf8"));
  expect(receipt).toMatchObject({ oldCommit: f.A, newCommit: f.B, oldBindingSha256: sha256(before), newBindingSha256: result.newBindingSha256, acknowledgedJobIds: [], runtimeRelease: "/TEST-artifact" });
  // The sealed check Create uses now accepts the new commit and refuses the old one.
  const port = (commit: string) => hostedMimoSealedSourcePort({ ...next, sourceCommit: commit }).resolveRevision({ sourceWorkspacePath: next.sourceWorkspacePath, sourceRef: "origin/main", expectedSourceCommit: commit });
  await expect(port(f.B)).resolves.toMatchObject({ revision: f.B }); await expect(port(f.A)).rejects.toThrow("mimo_project_bridge_source_mismatch");
});

it("replays the same plan as an already advanced no-op and refuses to move again", async () => {
  const f = await fixture(), plan = planFor(f);
  await advance(f, plan); const after = bindingBytes(f);
  await expect(advance(f, plan)).resolves.toMatchObject({ ok: true, alreadyAdvanced: true });
  expect(bindingBytes(f)).toEqual(after);
});

it("dry-run writes nothing and reports the binding digest that the real run produces", async () => {
  const f = await fixture(), before = bindingBytes(f), plan = planFor(f);
  const preview = await advance(f, plan, { ...fast, dryRun: true }) as { state: string; blockers: unknown[]; newBindingSha256: string };
  expect(preview).toMatchObject({ ok: true, dryRun: true, state: "pending", blockers: [], fence: "absent" }); untouched(f, before);
  await advance(f, plan); expect(sha256(bindingBytes(f))).toBe(preview.newBindingSha256);
});

it("a plan for an equal commit and unchanged binding is a no-op with a receipt", async () => {
  const f = await fixture();
  await expect(advance(f, planFor(f, { newSourceCommit: f.A }))).rejects.toThrow("mimo_project_bridge_advance_snapshot_invalid");
  git(f.snapshot, "checkout", "--detach", f.A); git(f.snapshot, "update-ref", "refs/remotes/origin/main", f.A);
  await expect(advance(f, planFor(f, { newSourceCommit: f.A }))).resolves.toMatchObject({ ok: true, newCommit: f.A });
  expect(exists(`${f.state}/source-advances/${f.A}..${f.A}.json`)).toBe(true); expect(git(f.source, "rev-parse", "HEAD")).toBe(f.A);
});

it.each([
  ["a stale binding digest", (f: Fixture) => ({ expectedBindingSha256: "0".repeat(64) }), "binding_mismatch"],
  ["another old commit", (f: Fixture) => ({ expectedSourceCommit: f.B }), "binding_mismatch"],
  ["another machine", () => ({ machineId: "c".repeat(32) }), "mimo_project_bridge_machine_mismatch"],
  ["an unknown field", () => ({ extra: true }), "hosted_research_launch_denied"],
  ["a bad commit", () => ({ newSourceCommit: "xyz" }), "plan_invalid"],
])("refuses %s before any effect", async (_name, over, error) => {
  const f = await fixture(), before = bindingBytes(f);
  await expect(advance(f, planFor(f, over(f)))).rejects.toThrow(error); untouched(f, before);
});

it.each([
  ["a snapshot that is not at the new commit", (f: Fixture) => git(f.snapshot, "checkout", "--detach", f.A), "snapshot_invalid"],
  ["a dirty snapshot", (f: Fixture) => file(f.snapshot + "/stray.txt", "TEST untracked\n"), "snapshot_invalid"],
  ["another repository URL", (f: Fixture) => git(f.snapshot, "remote", "set-url", "origin", "https://github.com/example/other.git"), "repository_mismatch"],
  ["a commit that does not descend from the old one", (f: Fixture) => {
    const orphan = git(f.snapshot, "commit-tree", f.B + "^{tree}", "-m", "TEST orphan"); git(f.snapshot, "checkout", "--detach", orphan);
    git(f.snapshot, "update-ref", "refs/remotes/origin/main", orphan); return orphan;
  }, "not_forward"],
  ["a commit that the snapshot branch does not contain", (f: Fixture) => git(f.snapshot, "update-ref", "refs/remotes/origin/main", f.A), "not_on_branch"],
  ["a source checkout that moved on its own", (f: Fixture) => file(f.source + "/README.md", "TEST local edit\n"), "source_dirty"],
])("refuses %s before touching the binding", async (_name, break_, error) => {
  const f = await fixture(); const extra = break_(f) as string | undefined;
  const before = bindingBytes(f);
  await expect(advance(f, planFor(f, error === "not_forward" ? { newSourceCommit: extra } : {}))).rejects.toThrow(error);
  expect(bindingBytes(f)).toEqual(before); expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  expect(git(f.source, "rev-parse", "refs/remotes/origin/main")).toBe(f.A);
});

it("refuses hand-pinned checks until the plan carries a reviewed template", async () => {
  const f = await fixture(true), before = bindingBytes(f);
  await expect(advance(f, planFor(f))).rejects.toThrow("mimo_project_bridge_advance_admission_pinned"); untouched(f, before);
  const admission = { mode: "serial-builtin", contract: contractFor(f, f.B, "true") };
  await expect(advance(f, planFor(f, { admission }))).resolves.toMatchObject({ ok: true });
  expect(JSON.parse(bindingBytes(f).toString()).admission).toEqual(admission);
});

it.each([
  ["a mandatory doc that is not in the snapshot", (c: ReturnType<typeof contractFor>) => ({ ...c, mandatoryDocs: ["README.md", "missing.md"] })],
  ["a check directory that is a file", (c: ReturnType<typeof contractFor>) => ({ ...c, requiredChecks: [{ id: "test", cwd: "README.md", command: "true" }] })],
  ["a sandbox directory that does not exist", (c: ReturnType<typeof contractFor>) => ({ ...c, executionPolicy: { ...c.executionPolicy, sandboxRoot: c.executionPolicy.sandboxRoot + "-missing" } })],
  ["an admission pinned to another commit", (c: ReturnType<typeof contractFor>) => ({ ...c, baseSha: "d".repeat(40) })],
])("refuses an explicit template with %s", async (_name, mutate) => {
  const f = await fixture(), before = bindingBytes(f);
  await expect(advance(f, planFor(f, { admission: { mode: "serial-builtin", contract: mutate(contractFor(f, f.B)) } }))).rejects.toThrow(); untouched(f, before);
});

it("requires a root-private plan directory and a root-private plan inside it", async () => {
  const f = await fixture(), before = bindingBytes(f), plan = planFor(f);
  file(`/etc/subscription-runtime/outside-${f.project}.json`, JSON.stringify(plan));
  await expect(advanceHostedMimoProjectSource(`/etc/subscription-runtime/outside-${f.project}.json`, fast)).rejects.toThrow("mimo_project_bridge_advance_plan_invalid");
  const loose = `/etc/subscription-runtime/mimo-advance/loose-${f.project}.json`; file(loose, JSON.stringify(plan), 0o644);
  await expect(advanceHostedMimoProjectSource(loose, fast)).rejects.toThrow("mimo_project_bridge_operation_invalid");
  const path = writePlan(f, plan); directory("/etc/subscription-runtime/mimo-advance", 0o755);
  try { await expect(advanceHostedMimoProjectSource(path, fast)).rejects.toThrow("TEST custody denied"); } finally { directory("/etc/subscription-runtime/mimo-advance", 0o700); }
  untouched(f, before);
});

it("allows an advance while only the route-disabled markers close the route, never over a recovery guard", async () => {
  const f = await fixture(), marker = `/etc/subscription-runtime/projects/${f.project}.route-disabled`;
  file(f.state + "/.controller-recovery.json", "TEST recovery\n"); file(marker, "TEST disabled\n");
  const before = bindingBytes(f);
  await expect(advance(f, planFor(f))).rejects.toThrow("mimo_project_bridge_advance_recovery_pending"); untouched(f, before);
  fs.unlinkSync(physical(f.state + "/.controller-recovery.json"));
  await expect(advance(f, planFor(f))).resolves.toMatchObject({ ok: true }); expect(git(f.source, "rev-parse", "HEAD")).toBe(f.B);
});

it.each([
  ["a Create that is unresolved", { create: { state: "unresolved" } }],
  ["a created job whose Start never ran", { create: settledOk }],
  ["a created job whose Start failed before launch", { create: settledOk, start: { state: "settled", result: { ok: false, error: "protected_job_birth_publication_busy" } } }],
  ["a created job whose Start was denied by admission", { create: settledOk, start: { state: "settled", result: { ok: false, error: "project_control_admission_denied" } } }],
  ["an unresolved admission repair", { create: settledOk, start: settledOk, "repair-admission": { state: "unresolved" } }],
  ["an unresolved admission repair finalization", { create: settledOk, start: settledOk, "finalize-admission-repair": { state: "unresolved" } }],
])("refuses while there is %s unless it is acknowledged", async (_name, operations) => {
  const f = await fixture(), before = bindingBytes(f); job(f, "test-job", operations);
  await expect(advance(f, planFor(f))).rejects.toThrow("mimo_project_bridge_advance_blocked"); untouched(f, before);
  const preview = await advance(f, planFor(f), { ...fast, dryRun: true }) as { blockers: { jobId: string }[] };
  expect(preview.blockers.map(row => row.jobId)).toContain("test-job"); untouched(f, before);
  await expect(advance(f, planFor(f, { acknowledgedJobIds: ["test-job"] }))).resolves.toMatchObject({ ok: true });
  expect(JSON.parse(fs.readFileSync(physical(`${f.state}/source-advances/${f.A}..${f.B}.json`), "utf8")).acknowledgedJobIds).toEqual(["test-job"]);
});

it.each(["create", "start", "status", "stop", "repair-admission", "finalize-admission-repair"])("waits for a running %s unit and never takes the fence for it, even when acknowledged", async operation => {
  const f = await fixture(), before = bindingBytes(f); job(f, "test-job", { create: settledOk, start: settledOk, [operation]: { state: "running" } });
  const observed: string[] = [];
  // No fence file may ever appear while a unit is running: a failed attempt can fail a concurrent Create.
  const watcher = setInterval(() => { if (exists(f.state + "/.controller-maintenance-fence.json")) observed.push("fence"); }, 5);
  try { await expect(advance(f, planFor(f, { acknowledgedJobIds: ["test-job"] }))).rejects.toThrow("mimo_project_bridge_advance_busy"); } finally { clearInterval(watcher); }
  expect(observed).toEqual([]); untouched(f, before);
});

it("treats a launched worker and a failed or never started Create as no blocker", async () => {
  const f = await fixture(); job(f, "running-job", { create: settledOk, start: settledOk, status: settledOk, stop: settledOk });
  job(f, "failed-create", { create: { state: "settled", result: { ok: false, error: "project_control_admission_denied" } } });
  job(f, "never-created", { start: { state: "absent" } });
  await expect(advance(f, planFor(f))).resolves.toMatchObject({ ok: true });
  expect(JSON.parse(fs.readFileSync(physical(`${f.state}/source-advances/${f.A}..${f.B}.json`), "utf8")).launchedJobIds).toEqual(["running-job"]);
});

it.each(["status", "stop"])("releases the fence again when a %s unit starts between the first check and the fence", async operation => {
  const f = await fixture(), before = bindingBytes(f); let calls = 0;
  // Absent for the check before the fence, running for every later one: the unit holds no activity lease yet.
  job(f, "late-job", { create: settledOk, start: settledOk, [operation]: () => ({ state: ++calls > 1 ? "running" : "absent" }) });
  await expect(advance(f, planFor(f))).rejects.toThrow("mimo_project_bridge_advance_busy");
  expect(calls).toBeGreaterThan(1); untouched(f, before);
});

it("does not ask again for a job whose Create was made at an earlier commit, but still blocks one made at the current commit", async () => {
  const create = (f: Fixture, jobId: string, sourceCommit: string) => file(`${f.state}/mimo-bridge-operations/${jobId}.create.request.json`,
    JSON.stringify({ kind: "MimoProject", schemaVersion: 1, machineId: machine, projectId: f.project, workstreamId: f.stream, operation: "create", jobId, prompt: "TEST", sourceCommit }) + "\n");
  const stale = await fixture(); job(stale, "old-job", { create: { state: "unresolved" } }); create(stale, "old-job", "e".repeat(40));
  await expect(advance(stale, planFor(stale), { ...fast, dryRun: true })).resolves.toMatchObject({ blockers: [], staleJobIds: ["old-job"] });
  await expect(advance(stale, planFor(stale))).resolves.toMatchObject({ ok: true });
  expect(JSON.parse(fs.readFileSync(physical(`${stale.state}/source-advances/${stale.A}..${stale.B}.json`), "utf8"))).toMatchObject({ staleJobIds: ["old-job"], acknowledgedJobIds: [] });
  const current = await fixture(), before = bindingBytes(current); job(current, "new-job", { create: { state: "unresolved" } }); create(current, "new-job", current.A);
  await expect(advance(current, planFor(current))).rejects.toThrow("mimo_project_bridge_advance_blocked"); untouched(current, before);
});

it("refuses an acknowledgement for a job that has no retained operation", async () => {
  const f = await fixture(), before = bindingBytes(f);
  await expect(advance(f, planFor(f, { acknowledgedJobIds: ["typo-job"] }))).rejects.toThrow("mimo_project_bridge_advance_acknowledgement_unknown"); untouched(f, before);
});

it("waits out a short activity lease and then advances; a lease that outlives the wait leaves everything untouched", async () => {
  const f = await fixture(), before = bindingBytes(f);
  const lease = await acquireLocalControllerActivityLease({ controllerJobRootDir: f.state, owner: "TEST status" });
  await expect(advance(f, planFor(f), fast)).rejects.toThrow("mimo_project_bridge_advance_busy"); untouched(f, before);
  setTimeout(() => { void releaseLocalControllerActivityLease(lease); }, 120);
  await expect(advance(f, planFor(f), { fenceTimeoutMs: 5000, fenceRetryMs: 25 })).resolves.toMatchObject({ ok: true });
  expect(git(f.source, "rev-parse", "HEAD")).toBe(f.B);
});

it("never recovers or releases a live foreign fence", async () => {
  const f = await fixture(), before = bindingBytes(f);
  const foreign = await acquireLocalControllerMaintenanceFence({ controllerJobRootDir: f.state, owner: "TEST foreign" });
  try {
    await expect(advance(f, planFor(f))).rejects.toThrow("mimo_project_bridge_advance_busy");
    expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(true);
  } finally { await releaseLocalControllerMaintenanceFence(foreign); }
  untouched(f, before);
});

it("keeps ingress and owned units closed behind the dead fence and completes only by replaying the same plan", async () => {
  for (const step of [MimoAdvanceStep.Fenced, MimoAdvanceStep.Fetched, MimoAdvanceStep.RefMoved, MimoAdvanceStep.CheckedOut, MimoAdvanceStep.BindingReplaced]) {
    const f = await fixture(), before = bindingBytes(f), plan = planFor(f);
    await expect(advance(f, plan, crash(step))).rejects.toThrow("TEST crash after " + step);
    deadFence(f);
    // The workstream stays closed until an acquirer recovers the dead fence.
    await expect(withHostedMimoWorkstreamActivity(f.state, async () => true)).rejects.toThrow("controller_maintenance_fence_active");
    const old = JSON.parse(before.toString()), moved = step !== MimoAdvanceStep.Fenced && step !== MimoAdvanceStep.Fetched;
    const sealed = () => hostedMimoSealedSourcePort(old).resolveRevision({ sourceWorkspacePath: old.sourceWorkspacePath, sourceRef: "origin/main", expectedSourceCommit: f.A });
    // Create stays fail-closed whenever source, ref and binding disagree.
    if (moved && step !== MimoAdvanceStep.BindingReplaced) await expect(sealed()).rejects.toThrow("mimo_project_bridge_source_mismatch");
    else if (!moved) await expect(sealed()).resolves.toMatchObject({ revision: f.A });
    await expect(advance(f, plan)).resolves.toMatchObject({ ok: true, newCommit: f.B });
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.B); expect(git(f.source, "rev-parse", "refs/remotes/origin/main")).toBe(f.B);
    expect(JSON.parse(bindingBytes(f).toString()).sourceCommit).toBe(f.B); expect(git(f.source, "for-each-ref", "refs/mimo-advance")).toBe("");
    expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
    expect(exists(`${f.state}/source-advances/${f.A}..${f.B}.json`)).toBe(true);
    await expect(withHostedMimoWorkstreamActivity(f.state, async () => true)).resolves.toBe(true);
  }
});

it("leaves the fence in place when an ordinary error follows the first source change, and the same plan completes", async () => {
  const f = await fixture(), before = bindingBytes(f), plan = planFor(f);
  await expect(advance(f, plan, crash(MimoAdvanceStep.RefMoved))).rejects.toThrow("TEST crash after ref-moved");
  // Source and ref moved, the binding did not: ingress stays closed instead of letting a Create at the old commit spend its job ID.
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(true); expect(bindingBytes(f)).toEqual(before);
  expect(git(f.source, "rev-parse", "refs/remotes/origin/main")).toBe(f.B);
  await expect(withHostedMimoWorkstreamActivity(f.state, async () => true)).rejects.toThrow("controller_maintenance_fence_active");
  deadFence(f);
  await expect(advance(f, plan)).resolves.toMatchObject({ ok: true, newCommit: f.B });
  expect(JSON.parse(bindingBytes(f).toString()).sourceCommit).toBe(f.B); expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
  await expect(withHostedMimoWorkstreamActivity(f.state, async () => true)).resolves.toBe(true);
});

it("keeps the fence on a replay that finds the source already moved, and a further replay completes", async () => {
  const f = await fixture(), plan = planFor(f);
  await expect(advance(f, plan, crash(MimoAdvanceStep.RefMoved))).rejects.toThrow("TEST crash after ref-moved"); deadFence(f);
  await expect(advance(f, plan, crash(MimoAdvanceStep.Fenced))).rejects.toThrow("TEST crash after fenced");
  // The replay performed no step itself, yet ingress stays closed while the binding is at A and the source at B.
  expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(true);
  await expect(withHostedMimoWorkstreamActivity(f.state, async () => true)).rejects.toThrow("controller_maintenance_fence_active");
  deadFence(f);
  await expect(advance(f, plan)).resolves.toMatchObject({ ok: true, newCommit: f.B });
  expect(JSON.parse(bindingBytes(f).toString()).sourceCommit).toBe(f.B); expect(exists(f.state + "/.controller-maintenance-fence.json")).toBe(false);
});

it("reads back a receipt larger than 64 KiB on replay", async () => {
  const f = await fixture(), plan = planFor(f);
  for (let i = 0; i < 700; i++) job(f, "launched-job-" + String(i).padStart(4, "0") + "-" + "x".repeat(100), { create: settledOk, start: settledOk });
  await advance(f, plan);
  expect(fs.statSync(physical(`${f.state}/source-advances/${f.A}..${f.B}.json`)).size).toBeGreaterThan(65536);
  await expect(advance(f, plan)).resolves.toMatchObject({ ok: true, alreadyAdvanced: true });
});

it("releases the fence for an ordinary error that comes before the first source change", async () => {
  const f = await fixture(), before = bindingBytes(f);
  await expect(advance(f, planFor(f), crash(MimoAdvanceStep.Fenced))).rejects.toThrow("TEST crash after fenced"); untouched(f, before);
});

it("refuses a binding directory that is not root-private before any effect, in dry-run too", async () => {
  const f = await fixture(), before = bindingBytes(f), path = `/etc/subscription-runtime/mimo-projects/${f.project}`;
  directory(path, 0o755);
  try {
    for (const options of [fast, { ...fast, dryRun: true }]) await expect(advance(f, planFor(f), options)).rejects.toThrow("mimo_project_bridge_advance_binding_directory_invalid");
  } finally { directory(path, 0o700); }
  untouched(f, before);
});

it("refuses a replacement admission that makes the binding larger than the readers accept, in dry-run too", async () => {
  const f = await fixture(), before = bindingBytes(f), admission = { mode: "serial-builtin", contract: contractFor(f, f.B, "true # " + "x".repeat(70000)) };
  for (const options of [fast, { ...fast, dryRun: true }]) await expect(advance(f, planFor(f, { admission }), options)).rejects.toThrow("mimo_project_bridge_advance_binding_too_large");
  untouched(f, before);
});

it("measures the binding cap exactly as the readers do: 65536 bytes with the newline pass, one more is refused", async () => {
  const f = await fixture(), padded = (size: number) => ({ mode: "serial-builtin", contract: contractFor(f, f.B, "true # " + "x".repeat(size)) });
  const length = (size: number) => Buffer.byteLength(JSON.stringify({ ...f.binding, sourceCommit: f.B, admission: padded(size) }) + "\n");
  const exact = 65536 - length(0), before = bindingBytes(f);
  expect(length(exact)).toBe(65536);
  await expect(advance(f, planFor(f, { admission: padded(exact + 1) }), { ...fast, dryRun: true })).rejects.toThrow("mimo_project_bridge_advance_binding_too_large");
  untouched(f, before);
  // The exact-size binding is accepted by the advance and then by every reader, including a replay.
  const plan = planFor(f, { admission: padded(exact) });
  await expect(advance(f, plan)).resolves.toMatchObject({ ok: true });
  expect(bindingBytes(f).length).toBe(65536);
  await expect(advance(f, plan)).resolves.toMatchObject({ ok: true, alreadyAdvanced: true });
  await expect(hostedMimoSealedSourcePort(JSON.parse(bindingBytes(f).toString())).resolveRevision({ sourceWorkspacePath: f.source, sourceRef: "origin/main", expectedSourceCommit: f.B }))
    .resolves.toMatchObject({ revision: f.B });
});

it("refuses a different plan while source, ref and binding disagree", async () => {
  const f = await fixture(), plan = planFor(f);
  await expect(advance(f, plan, crash(MimoAdvanceStep.RefMoved))).rejects.toThrow("TEST crash"); deadFence(f);
  const C = commit(f, "TEST source three\n"), before = bindingBytes(f);
  await expect(advance(f, planFor(f, { newSourceCommit: C }))).rejects.toThrow("mimo_project_bridge_advance_source_diverged");
  expect(bindingBytes(f)).toEqual(before); expect(JSON.parse(before.toString()).sourceCommit).toBe(f.A);
  expect(git(f.source, "rev-parse", "refs/remotes/origin/main")).toBe(f.B);
});

it("removes a stale source lock left by a killed Git only under the fence", async () => {
  const f = await fixture();
  file(f.source + "/.git/index.lock", ""); file(f.source + "/.git/refs/remotes/origin/main.lock", "");
  await expect(advance(f, planFor(f))).resolves.toMatchObject({ ok: true });
  expect(exists(f.source + "/.git/index.lock")).toBe(false); expect(git(f.source, "rev-parse", "HEAD")).toBe(f.B);
});

it("rechecks the operations under the fence: a Create persisted just before it blocks the advance", async () => {
  const f = await fixture(), before = bindingBytes(f); let observations = 0;
  file(`${f.state}/mimo-bridge-operations/late-job.create.owner.json`, "{}\n");
  harness.operations.set("late-job.create", () => ++observations > 1 ? { state: "unresolved" } : { state: "absent" });
  await expect(advance(f, planFor(f))).rejects.toThrow("mimo_project_bridge_advance_blocked");
  expect(observations).toBe(2); untouched(f, before);
});
