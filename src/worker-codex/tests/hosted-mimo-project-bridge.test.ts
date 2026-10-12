import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), fds: new Map<number, string>(), fd: 1,
  allowed: ["account-q"], jobPrefixes: ["test-"], tmuxPrefixes: ["test-"], refill: vi.fn(), start: vi.fn(), stop: vi.fn(), load: vi.fn(), command: vi.fn(), executableDigest: vi.fn(), repair: vi.fn(), readJob: vi.fn(), provenance: vi.fn(), assertOrigin: vi.fn() }));
vi.mock("../../../host-integration/runtime-admission/mimo-job-admission-repair.mts", () => ({ repairHostedMimoJobAdmissionPlan: state.repair }));
vi.mock("../protected-job-birth", async original => ({ ...await original<object>(), protectedCodexGoalJobRuntimeProvenance: state.provenance }));
vi.mock("../codex-goal-jobs", async original => ({ ...await original<object>(), readCodexGoalJob: state.readJob }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const bytes = (p: string) => { const b = state.files.get(p); if (!b) throw Object.assign(new Error("TEST missing"), { code: "ENOENT" }); return b; };
  const stat = (p: string) => ({ uid: 0, dev: 1, ino: 2, ctimeMs: 1, nlink: 1, mode: 0o100600, size: bytes(p).length,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
  return { ...real, realpathSync: (p: string) => p, openSync: (p: string) => { bytes(p); const n = ++state.fd; state.fds.set(n, p); return n; }, closeSync: (n: number) => state.fds.delete(n),
    fstatSync: (n: number) => stat(state.fds.get(n)!), lstatSync: stat, existsSync: (p: string) => state.files.has(p),
    readFileSync: (p: string | number, enc?: string) => { const b = bytes(typeof p === "number" ? state.fds.get(p)! : p); return enc ? b.toString() : b; },
    mkdirSync: (p: string) => state.files.set(p, Buffer.from("TEST dir")),
    writeFileSync: (p: string, b: string, o: { flag: string }) => { if (o.flag === "wx" && state.files.has(p)) throw new Error("TEST retained"); state.files.set(p, Buffer.from(b)); } };
});
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchCommand: state.command, researchExecutableDigest: state.executableDigest }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: vi.fn() }));
// Admission schema has its own real contracts. Here the independent boundary
// is ownership/routing/dispatch, never the contents of the operator template.
vi.mock("../application/project-control/worker-launch-spec", () => ({ workerLaunchAdmissionSchema: { parse: (v: unknown) => v } }));
vi.mock("../codex-goal-mcp-project-control-tool-handlers", () => ({ projectControlRefillWorkerFromSealedSource: state.refill, projectControlStartStoredJob: state.start, projectControlStopStoredJob: state.stop }));
vi.mock("../codex-goal-mcp-project-control-deps", () => ({ loadProjectControlController: async () => ({ controller: { jobId: "test-controller" }, scope: { projectId: "test-project", allowedAccountIds: state.allowed, jobIdPrefixes: state.jobPrefixes, tmuxSessionPrefixes: state.tmuxPrefixes } }), loadJobLaunch: state.load }));
vi.mock("../project-mimo-worker-launch", () => ({ reconcileProjectMimoWorker: vi.fn(), observeProjectMimoWorker: vi.fn() }));
vi.mock("../codex-goal-ops", () => ({ collectCodexGoalStatus: async () => ({ state: "done" }) }));
vi.mock("../codex-goal-mcp-status-input", () => ({ codexGoalStatusInputFromLaunch: () => ({}) }));
import { researchCustody, researchHash } from "../research-launch-files";
import { onboardHostedMimoProject } from "../hosted-mimo-project-bridge-onboard";
import { handleHostedMimoProjectBridge } from "../hosted-mimo-project-bridge";
import { MimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-contract";
const request = { kind: "MimoProject", schemaVersion: 1, machineId: "a".repeat(32), projectId: "test-project", workstreamId: "test-stream", operation: MimoProjectBridgeOperation.Create, jobId: "test-job", prompt: "TEST prompt", sourceCommit: "b".repeat(40) };
const root = "/srv/worker-state/mimo-projects/test-project/test-stream", scratch = "/srv/workers/mimo-projects/test-project/test-stream";
const config = "/etc/subscription-runtime/mimo-projects/test-project/test-stream.json";
const helperPath = fileURLToPath(new URL("../../../host-integration/runtime-admission/mimo-job-admission-repair.mts", import.meta.url));
const binding = { schemaVersion: 1, projectId: request.projectId, workstreamId: request.workstreamId, machineId: request.machineId, routingEnabled: true,
  stateRoot: root, scratchRoot: scratch, registryRootDir: root + "/registry", controllerJobId: "test-controller", sourceWorkspacePath: scratch + "/source",
  sourceCommit: request.sourceCommit, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/codex", taskTimeoutMs: 600000, appServerStartupTimeoutMs: 330000, operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract: { executionPolicy: { mode: "sandbox-only", sandboxRoot: scratch + "/source/sandbox", forbiddenRealProjects: ["/TEST/real-project"] } } } };
const control = (operation: MimoProjectBridgeOperation) => { const { prompt: _p, sourceCommit: _s, ...r } = request; return { ...r, operation }; };
beforeEach(() => {
  state.files.clear(); state.fds.clear(); vi.clearAllMocks(); state.allowed = ["account-q"]; state.jobPrefixes = ["test-"]; state.tmuxPrefixes = ["test-"];
  state.files.set("/etc/machine-id", Buffer.from(request.machineId)); state.files.set(config, Buffer.from(JSON.stringify(binding)));
  state.files.set(helperPath, Buffer.from("TEST fixed helper bytes"));
  state.readJob.mockResolvedValue({ jobId: request.jobId, jobRootDir: root + "/jobs/test-job", workspacePath: scratch + "/workspaces/test-job" });
  state.provenance.mockReturnValue({ runtimeDirectory: "/opt/subscription-runtime/releases/" + "7".repeat(40), artifactSha256: "d".repeat(64), assertCurrent: state.assertOrigin });
  state.repair.mockResolvedValue({ ok: true, jobId: request.jobId });
  state.files.set("/etc/subscription-runtime/projects/test-project.d/test-stream.yml", Buffer.from(`project_id: test-project\nworkstream_id: test-stream\nstate_root: /srv/worker-state/jobs/test-project/test-stream\nscratch_root: /srv/workers/jobs/test-project/test-stream\nrouting_enabled: true\n`));
  const response = { content: [{ type: "text", text: '{"ok":true}' }] }; state.refill.mockResolvedValue(response); state.start.mockResolvedValue(response); state.stop.mockResolvedValue(response);
  state.load.mockResolvedValue({ launch: { config: { jobRootDir: root + "/jobs/test-job", workspacePath: scratch + "/workspaces/test-job", modelBackend: "xiaomi-mimo-token-plan", accounts: [{ name: "account-q" }], projectAccessScope: { projectId: request.projectId } } } });
});
function repairRequest() {
  return { ...control(MimoProjectBridgeOperation.RepairAdmission), repairPlan: { schemaVersion: 1, machineId: request.machineId,
    projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId,
    expectedBindingSha256: researchHash(state.files.get(config)!), expectedControllerManifestSha256: "d".repeat(64), expectedManifestSha256: "e".repeat(64),
    expectedContractSha256: "f".repeat(64), expectedStateSha256: "0".repeat(64), expectedReceiptSha256: "1".repeat(64), ownedPaths: ["src/TEST.hpp"] } };
}
it("dispatches only a same-job repair to the fixed helper with matched original provenance", async () => {
  await handleHostedMimoProjectBridge(request); state.refill.mockClear();
  const repair = repairRequest();
  await expect(handleHostedMimoProjectBridge(repair)).resolves.toEqual({ ok: true, jobId: request.jobId });
  expect(state.repair).toHaveBeenCalledWith(repair.repairPlan, "/opt/subscription-runtime/releases/" + "7".repeat(40), "d".repeat(64));
  expect(state.assertOrigin).toHaveBeenCalledTimes(2);
  expect(state.load).not.toHaveBeenCalled(); expect(state.refill).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled(); expect(state.stop).not.toHaveBeenCalled();
});
it.each(["binding", "job", "missing-origin", "different-origin", "helper-custody"])("refuses repair %s drift before invoking helper", async fault => {
  await handleHostedMimoProjectBridge(request);
  const repair = repairRequest();
  if (fault === "binding") repair.repairPlan.expectedBindingSha256 = "0".repeat(64);
  if (fault === "job") state.readJob.mockResolvedValue({ jobId: "other", jobRootDir: root + "/jobs/test-job", workspacePath: scratch + "/workspaces/test-job" });
  if (fault === "missing-origin") state.provenance.mockReturnValue(undefined);
  if (fault === "different-origin") state.provenance.mockReturnValueOnce({ runtimeDirectory: "/opt/subscription-runtime/releases/" + "8".repeat(40), artifactSha256: "d".repeat(64), assertCurrent: state.assertOrigin });
  if (fault === "helper-custody") state.files.delete(helperPath);
  await expect(handleHostedMimoProjectBridge(repair)).rejects.toThrow();
  expect(state.repair).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled(); expect(state.load).not.toHaveBeenCalled();
});
describe("trusted MiMo bridge dispatch and retention", () => {
  it("derives paths and authority, then refuses replay", async () => {
    await handleHostedMimoProjectBridge(request);
    expect(state.refill).toHaveBeenCalledWith(expect.objectContaining({ registryRootDir: root + "/registry", controllerJobId: "test-controller", workspacePath: scratch + "/workspaces/test-job", jobRootDir: root + "/jobs/test-job", sourceRef: "origin/main", accounts: ["account-q"], startWorker: false }), expect.anything());
    await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("TEST retained"); expect(state.refill).toHaveBeenCalledTimes(1);
  });
  it.each(["scope", "machine", "route", "source", "binding"])("refuses %s drift before dispatch", async fault => {
    if (fault === "scope") state.allowed = ["account-a"];
    if (fault === "machine") state.files.set("/etc/machine-id", Buffer.from("c".repeat(32)));
    if (fault === "route") state.files.set("/etc/subscription-runtime/projects/test-project.route-disabled", Buffer.from("TEST"));
    if (fault === "source") state.files.set(config, Buffer.from(JSON.stringify({ ...binding, sourceCommit: "d".repeat(40) })));
    if (fault === "binding") state.files.set(config, Buffer.from(JSON.stringify({ ...binding, registryRootDir: "/TEST-other" })));
    await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow(); expect(state.refill).not.toHaveBeenCalled();
  });
  it("retains an uncertain creation before any replacement", async () => {
    state.refill.mockRejectedValueOnce(new Error("TEST uncertain")); await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("TEST uncertain");
    await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("TEST retained"); expect(state.refill).toHaveBeenCalledTimes(1);
  });
  it("refuses foreign jobs before loading them", async () => {
    await expect(handleHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow(); expect(state.load).not.toHaveBeenCalled();
  });
  it("keeps status and cleanup available on a closed route", async () => {
    await handleHostedMimoProjectBridge(request); state.files.set("/etc/subscription-runtime/projects/test-project.route-disabled", Buffer.from("TEST"));
    await expect(handleHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_route_closed");
    await expect(handleHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).resolves.toMatchObject({ ok: true });
    await expect(handleHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Status))).resolves.toMatchObject({ jobId: "test-job", status: { state: "done" } });
  });
});

describe("root-only existing project enrollment", () => {
  function prepare() {
    state.files.set("/etc/subscription-runtime/TEST-reviewed.json", Buffer.from(JSON.stringify(binding)));
    state.files.delete(config);
    state.files.set(binding.codexBinaryPath, Buffer.from("TEST executable"));
    state.files.set("/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js", Buffer.from("TEST runtime"));
    state.command.mockReturnValue(binding.sourceCommit + "\n");
  }
  it("installs reviewed fixed metadata once without launching or widening scope", async () => {
    prepare();
    await expect(onboardHostedMimoProject("/etc/subscription-runtime/TEST-reviewed.json")).resolves.toMatchObject({ ok: true, projectId: request.projectId });
    expect(JSON.parse(state.files.get(config)!.toString())).toEqual(binding);
    expect(state.refill).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled(); expect(state.allowed).toEqual(["account-q"]);
    await expect(onboardHostedMimoProject("/etc/subscription-runtime/TEST-reviewed.json")).rejects.toThrow("TEST retained");
  });
  it("refuses an executable rejected by the launch digest before installing", async () => {
    prepare(); state.executableDigest.mockImplementationOnce(() => { throw new Error("TEST symlink denied"); });
    await expect(onboardHostedMimoProject("/etc/subscription-runtime/TEST-reviewed.json")).rejects.toThrow("TEST symlink denied");
    expect(state.files.has(config)).toBe(false);
  });
  it.each(["job", "tmux", "incompatible"])("rejects %s worker prefixes before installing", async fault => {
    prepare();
    if (fault === "job") state.jobPrefixes = [];
    if (fault === "tmux") state.tmuxPrefixes = [];
    if (fault === "incompatible") state.tmuxPrefixes = ["foreign-"];
    await expect(onboardHostedMimoProject("/etc/subscription-runtime/TEST-reviewed.json")).rejects.toThrow("mimo_project_bridge_worker_prefix_scope_denied");
    expect(state.files.has(config)).toBe(false);
  });
  it.each(["scope", "route", "source"])("rejects %s drift before writing the binding", async fault => {
    prepare();
    if (fault === "scope") state.allowed = ["account-a"];
    if (fault === "route") state.files.set("/etc/subscription-runtime/projects/test-project.route-disabled", Buffer.from("TEST"));
    if (fault === "source") state.command.mockReturnValue("c".repeat(40));
    await expect(onboardHostedMimoProject("/etc/subscription-runtime/TEST-reviewed.json")).rejects.toThrow();
    expect(state.files.has(config)).toBe(false); expect(state.refill).not.toHaveBeenCalled();
  });
});

it("derives a separate exact sandbox from the trusted source template for each child", async () => {
  await handleHostedMimoProjectBridge(request);
  await handleHostedMimoProjectBridge({ ...request, jobId: "test-job-two" });
  const policies = state.refill.mock.calls.map(row => row[0].preStartAdmission.contract.executionPolicy);
  expect(policies.map(row => row.sandboxRoot)).toEqual([scratch + "/workspaces/test-job/sandbox", scratch + "/workspaces/test-job-two/sandbox"]);
  expect(policies.every(row => row.forbiddenRealProjects[0] === "/TEST/real-project")).toBe(true);
});
it("refuses a template sandbox outside or equal to the source root", async () => {
  for (const sandboxRoot of [scratch + "/source", scratch + "/escape"]) {
    const admission = { ...binding.admission, contract: { ...binding.admission.contract, executionPolicy: { ...binding.admission.contract.executionPolicy, sandboxRoot } } };
    state.files.set(config, Buffer.from(JSON.stringify({ ...binding, admission })));
    await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("mimo_project_bridge_admission_invalid");
  }
  expect(state.refill).not.toHaveBeenCalled();
});

it("rejects a binding in shared state ancestry while accepting original routing-only YAML state_root", async () => {
  state.files.set(config, Buffer.from(JSON.stringify({ ...binding, stateRoot: "/srv/worker-state/jobs/test-project/test-stream", registryRootDir: "/srv/worker-state/jobs/test-project/test-stream/registry" })));
  await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("mimo_project_bridge_binding_invalid");
  expect(state.refill).not.toHaveBeenCalled();
  state.files.set(config, Buffer.from(JSON.stringify(binding)));
  await expect(handleHostedMimoProjectBridge(request)).resolves.toMatchObject({ ok: true });
  expect(state.refill).toHaveBeenCalledWith(expect.objectContaining({ registryRootDir: root + "/registry", jobRootDir: root + "/jobs/test-job" }), expect.anything());
});
it("rejects YAML state-root drift even though routing state is separate from protected state", async () => {
  const yamlPath = "/etc/subscription-runtime/projects/test-project.d/test-stream.yml";
  state.files.set(yamlPath, Buffer.from(state.files.get(yamlPath)!.toString().replace("state_root: /srv/worker-state/jobs/test-project/test-stream", "state_root: " + root)));
  await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("mimo_project_bridge_route_closed");
  expect(state.refill).not.toHaveBeenCalled();
});

it("keeps private authority out of shared state ancestry without changing custody", async () => {
  vi.mocked(researchCustody).mockImplementation(path => {
    if (path === "/srv/worker-state/jobs" || path.startsWith("/srv/worker-state/jobs/") || path === "/srv/workers/jobs" || path.startsWith("/srv/workers/jobs/")) throw new Error("TEST shared ancestry is not authority");
  });
  try {
    await expect(handleHostedMimoProjectBridge(request)).resolves.toMatchObject({ ok: true });
    expect(state.files.has(root + "/mimo-bridge-attempts/test-job.json")).toBe(true);
    expect(vi.mocked(researchCustody).mock.calls.some(([path]) => path.startsWith("/srv/worker-state/jobs") || path.startsWith("/srv/workers/jobs"))).toBe(false);
  } finally { vi.mocked(researchCustody).mockReset(); }
});

it("rejects shared project scratch authority while preserving routing-only YAML", async () => {
  const shared = "/srv/workers/jobs/test-project/test-stream";
  state.files.set(config, Buffer.from(JSON.stringify({ ...binding, scratchRoot: shared, sourceWorkspacePath: shared + "/source" })));
  await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("mimo_project_bridge_binding_invalid");
  expect(state.refill).not.toHaveBeenCalled();
  state.files.set(config, Buffer.from(JSON.stringify(binding)));
  await expect(handleHostedMimoProjectBridge(request)).resolves.toMatchObject({ ok: true });
  expect(state.refill).toHaveBeenCalledWith(expect.objectContaining({ sourceWorkspacePath: scratch + "/source", workspacePath: scratch + "/workspaces/test-job" }), expect.anything());
});
it("rejects original YAML scratch-root drift independently of protected scratch", async () => {
  const yamlPath = "/etc/subscription-runtime/projects/test-project.d/test-stream.yml";
  state.files.set(yamlPath, Buffer.from(state.files.get(yamlPath)!.toString().replace("scratch_root: /srv/workers/jobs/test-project/test-stream", "scratch_root: " + scratch)));
  await expect(handleHostedMimoProjectBridge(request)).rejects.toThrow("mimo_project_bridge_route_closed");
  expect(state.refill).not.toHaveBeenCalled();
});
