import { beforeEach, expect, it, vi } from "vitest";
import { SafeExecutionError } from "../../worker-core/safe-execution/domain/safe-execution-policy";
vi.mock("../hosted-mimo-project-workstream-fence", () => ({ withHostedMimoWorkstreamActivity: async (_root: string, effect: () => Promise<unknown>) => effect() }));
const state = vi.hoisted(() => ({ files: new Map<string, string>(), fds: new Map<number, string>(), nextFd: 10000, command: vi.fn(), handler: vi.fn(), rearm: vi.fn(), busyCapture: vi.fn(), busyCurrent: vi.fn(), publicationFailure: undefined as "write" | "rename" | undefined }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: (p: string) => state.files.has(p), readdirSync: (p: string) => [...state.files.keys()].filter(x => x.startsWith(p + "/")).map(x => x.slice(p.length + 1)), mkdirSync: (p: string) => state.files.set(p, ""),
  realpathSync: (p: string) => p === "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js" ? "/opt/subscription-runtime/releases/" + "f".repeat(40) + "/dist/worker-codex/hosted-mimo-project-bridge-cli.js" : p, lstatSync: (p: string) => ({ isFile: () => true, isDirectory: () => p.endsWith("/mimo-bridge-operations"), isSymbolicLink: () => false, uid: 0, gid: 0, nlink: 1, dev: 1, ino: p.length, ctimeMs: 1,
    size: Buffer.byteLength(state.files.get(p) ?? ""), mode: 0o100000 | (/\.json(?:\.tmp)?$/.test(p) ? 0o600 : 0o700) }),
  openSync: (p: string, flags: number) => {
    if (state.publicationFailure === "write" && p.endsWith(".result.json.tmp")) throw new Error("TEST result write uncertain");
    if (flags & 0o100) state.files.set(p, "");
    const fd = ++state.nextFd; state.fds.set(fd, p); return fd;
  },
  closeSync: (fd: number) => state.fds.delete(fd), fsyncSync: vi.fn(),
  fstatSync: (fd: number) => ({ isFile: () => true, uid: 0, gid: 0, nlink: 1, mode: 0o100600, dev: 1,
    ino: state.fds.get(fd)!.length, ctimeMs: 1, size: Buffer.byteLength(state.files.get(state.fds.get(fd)!) ?? "") }),
  linkSync: (a: string, b: string) => { if (state.publicationFailure === "rename" && b.endsWith(".result.json")) throw new Error("TEST result rename uncertain");
    if (state.files.has(b)) throw Object.assign(new Error("TEST result exists"), { code: "EEXIST" }); state.files.set(b, state.files.get(a)!); },
  unlinkSync: (p: string) => state.files.delete(p),
  writeFileSync: (path: string | number, bytes: string, options?: { flag: string }) => { const p = typeof path === "number" ? state.fds.get(path)! : path; if (state.publicationFailure === "write" && p.endsWith(".result.json.tmp")) throw new Error("TEST result write uncertain"); if (options?.flag === "wx" && state.files.has(p)) throw new Error("TEST retained"); state.files.set(p, bytes); },
  renameSync: (a: string, b: string) => { if (state.publicationFailure === "rename" && b.endsWith(".result.json")) throw new Error("TEST result rename uncertain"); state.files.set(b, state.files.get(a)!); state.files.delete(a); } }));
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchCommand: state.command }));
vi.mock("../research-launch-files", async original => ({ ...await original<object>(), researchCustody: vi.fn(), researchPublish: (path: string, value: unknown) => { if (state.files.has(path)) throw new Error("TEST retained proof"); state.files.set(path, JSON.stringify(value) + "\n"); } }));
vi.mock("../hosted-mimo-project-bridge", () => ({ handleHostedMimoProjectBridge: state.handler,
  assertHostedMimoAdmissionRepairStartRearm: state.rearm,
  hostedMimoBridgeMetadataBytes: (p: string) => Buffer.from(state.files.get(p)!), parseHostedMimoProjectBinding: () => ({ operationTimeoutMs: 900000, stateRoot: "/srv/worker-state/mimo-projects/test-project/test-stream" }) }));
vi.mock("../codex-goal-jobs", () => ({ readCodexGoalJob: vi.fn() }));
vi.mock("../codex-goal-mcp-project-control-deps", () => ({ loadProjectControlController: vi.fn() }));
vi.mock("../hosted-ordinary-writer-authority", () => ({ hostedOrdinaryWriterAuthorityAbsent: vi.fn() }));
vi.mock("../protected-job-birth", () => ({ observeCompatibleProtectedCodexGoalJobBirth: vi.fn(), withProtectedCodexGoalJobBirthPublication: vi.fn() }));
vi.mock("../application/project-control/codex-goal-project-pre-start-admission", () => ({ assertProjectPreStartAdmissionLaunchBinding: vi.fn(), assertProjectPreStartAdmissionDescriptorPaths: vi.fn() }));
vi.mock("../application/project-control/codex-goal-project-pre-start-binding", () => ({ captureProjectPreStartBinding: vi.fn() }));
vi.mock("../hosted-mimo-publication-busy-rearm", async original => ({ ...await original<object>(),
  capturePublicationBusyStartRearm: state.busyCapture, assertPublicationBusyStartRearmCurrent: state.busyCurrent }));
import { trustedMimoProjectOperationLaunch } from "../trusted-custody-systemd-launch";
import { researchHash } from "../research-launch-files";
// Keep unrelated recipes' provider/install graphs outside this unit boundary;
// the new closed recipe and its input validation remain real.
vi.mock("../hosted-readonly-inputs", () => ({ readHostedPrivateBytes: vi.fn() }));
vi.mock("../research-launch-contract", () => ({ parseResearchStartSpec: vi.fn(), researchProviderSetupTimeoutMs: 1000, researchProviderSetupAllowanceMs: vi.fn() }));
vi.mock("../research-provider-root", () => ({ assertResearchProviderRoot: vi.fn(), researchProviderProtectedPaths: vi.fn(), ResearchRootMountAccess: {} }));
vi.mock("../hosted-dependency-installer-recipe", () => ({ hostedDependencyInstallerProperties: vi.fn(), hostedDependencyInstallerBootstrapCommand: vi.fn() }));
import { submitHostedMimoProjectBridge, executeHostedMimoProjectBridgeOperation, assertHostedMimoRecoveryOperationsSettled } from "../hosted-mimo-project-bridge-operation";
import { MimoProjectBridgeOperation } from "../hosted-mimo-project-bridge-contract";
const request = { kind: "MimoProject", schemaVersion: 1, machineId: "a".repeat(32), projectId: "test-project", workstreamId: "test-stream", operation: MimoProjectBridgeOperation.Create, jobId: "test-job", prompt: "TEST private prompt", sourceCommit: "b".repeat(40) } as const;
const prefix = "/srv/worker-state/mimo-projects/test-project/test-stream/mimo-bridge-operations/test-job.create";
const entry = "/opt/subscription-runtime/releases/" + "f".repeat(40) + "/dist/worker-codex/hosted-mimo-project-bridge-cli.js";
beforeEach(() => { state.files.clear(); state.fds.clear(); state.publicationFailure = undefined; vi.clearAllMocks(); state.files.set("/etc/machine-id", request.machineId); state.files.set("/etc/subscription-runtime/mimo-projects/test-project/test-stream.json", "{}"); state.command.mockReturnValue("LoadState=not-found\nActiveState=inactive"); state.handler.mockResolvedValue({ ok: true }); state.busyCapture.mockResolvedValue({ schemaVersion: 1, requestSha256: "a".repeat(64), bindings: [], directories: [], workspaceBindingSha256: "b".repeat(64) }); state.busyCurrent.mockResolvedValue(undefined); state.rearm.mockResolvedValue({receiptSha256: researchHash("TEST finalization proof")}); });
it("retains an exact owner before uncertain submission and never launches replacement", async () => {
  state.command.mockImplementationOnce(() => { expect(state.files.has(prefix + ".owner.json")).toBe(true); throw new Error("TEST transport timeout"); });
  await expect(submitHostedMimoProjectBridge(request)).rejects.toThrow("TEST transport timeout");
  await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ state: "unresolved" });
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
});
it("schedules a finite owned service with a fixed entry and no prompt in argv", async () => {
  await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ pending: true });
  const args = state.command.mock.calls[0]![1] as string[];
  expect(args).toContain("--property=RuntimeMaxSec=900"); expect(args).toContain(entry); expect(args).toContain("--execute-owned"); expect(args.join(" ")).not.toContain(request.prompt);
});
it("refuses start when create settled with a semantic refusal", async () => {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: false } }));
  const { prompt: _prompt, sourceCommit: _commit, ...control } = request;
  await expect(submitHostedMimoProjectBridge({ ...control, operation: MimoProjectBridgeOperation.Start })).rejects.toThrow("mimo_project_bridge_creation_pending");
});
it("checks the service PID and strips private error detail from durable results", async () => {
  await submitHostedMimoProjectBridge(request);
  const owner = JSON.parse(state.files.get(prefix + ".owner.json")!);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.command.mockReturnValue("MainPID=1\nDescription=" + owner.description);
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).rejects.toThrow("mimo_project_bridge_operation_invalid");
    expect(state.handler).not.toHaveBeenCalled();
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.handler.mockRejectedValue(new Error("project_control_source_invalid: TEST private path/prompt"));
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).resolves.toBe(false);
    expect(JSON.parse(state.files.get(prefix + ".result.json")!)).toEqual({ ok: false, error: "project_control_source_invalid" });
  } finally { process.argv[1] = previous!; }
});
it.each([
  [new SafeExecutionError("safe_execution_workspace_locked", "TEST private lock path", { details: { ownerId: "TEST private owner" }, cause: new Error("TEST private cause") }), "safe_execution_workspace_locked"],
  [new Error("protected_job_birth_publication_busy: TEST private path"), "protected_job_birth_publication_busy"],
  [new Error("protected_job_birth_authority_invalid: TEST private path/prompt"), "protected_job_birth_authority_invalid"],
  [new Error("evidence_custody_bootstrap_evidence_basename_invalid: TEST private path/prompt"), "evidence_custody_bootstrap_evidence_basename_invalid"],
  [new Error("evidence_custody_bootstrap_root_unsafe: TEST private path/prompt"), "evidence_custody_bootstrap_root_unsafe"],
  [new Error("evidence_custody_bootstrap_anchor_unsafe: TEST private path/prompt"), "evidence_custody_bootstrap_anchor_unsafe"],
  [new Error("hosted_ordinary_writer_extent_invalid: TEST private path/prompt"), "hosted_ordinary_writer_extent_invalid"],
  [new Error("controller_maintenance_fence_active: TEST private owner"), "controller_maintenance_fence_active"],
  [new Error("controller_maintenance_activity_active"), "controller_maintenance_activity_active"],
  [new SafeExecutionError("safe_execution_invalid_task", "TEST private invalid task"), "mimo_project_bridge_operation_failed"],
  [Object.assign(new Error("TEST private error"), { code: "safe_execution_workspace_locked_TEST_private" }), "mimo_project_bridge_operation_failed"],
  [new Error("protected_job_birth_TEST_private"), "mimo_project_bridge_operation_failed"],
  [new Error("evidence_custody_bootstrap_TEST_private"), "mimo_project_bridge_operation_failed"],
  [new Error("controller_TEST_private"), "mimo_project_bridge_operation_failed"],
  [new Error("project_mimo_worker_attempt_mismatch: TEST private attempt"), "project_mimo_worker_attempt_mismatch"],
  [new Error("hosted_mimo_worker_finalization_pending: TEST private prompt"), "hosted_mimo_worker_finalization_pending"],
  [new Error("codex_project_reserved_launch_authority_invalid: TEST private owner"), "codex_project_reserved_launch_authority_invalid"],
  [new Error("hosted_stored_project_start_binding_invalid: TEST private binding"), "hosted_stored_project_start_binding_invalid"],
  [new Error("project_control_source_invalid; rollback=TEST private workspace,prompt: detail"), "project_control_source_invalid"],
  [new Error("TEST private unknown; rollback=project_control_source_invalid"), "mimo_project_bridge_operation_failed"],
  [Object.assign(new Error("TEST private missing file"), { code: "ENOENT" }), "mimo_project_bridge_fs_not_found"],
  [Object.assign(new Error("TEST private missing file; rollback=TEST private path"), { code: "ENOENT" }), "mimo_project_bridge_fs_not_found"],
  [Object.assign(new Error("TEST private access failure"), { code: "EACCES" }), "mimo_project_bridge_fs_access_denied"],
  [Object.assign(new Error("TEST private permission failure"), { code: "EPERM" }), "mimo_project_bridge_fs_permission_denied"],
  [Object.assign(new Error("TEST private existing file"), { code: "EEXIST" }), "mimo_project_bridge_fs_already_exists"],
  [Object.assign(new Error("project_control_source_invalid: TEST private source"), { code: "ENOENT" }), "project_control_source_invalid"],
  [Object.assign(new Error("TEST private system failure"), { code: "TEST_UNKNOWN" }), "mimo_project_bridge_operation_failed"],
  [Object.setPrototypeOf(new Error("TEST private inherited code"), Object.assign(Object.create(Error.prototype), { code: "ENOENT" })), "mimo_project_bridge_operation_failed"],
  [new TypeError("TEST private configuration"), "mimo_project_bridge_type_error"],
  [new SyntaxError("TEST private JSON"), "mimo_project_bridge_parse_error"],
  ["TEST private non-Error failure", "mimo_project_bridge_operation_failed"],
])("persists only approved diagnostic codes without private detail %#", async (error, expected) => {
  await submitHostedMimoProjectBridge(request);
  const owner = JSON.parse(state.files.get(prefix + ".owner.json")!);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.handler.mockRejectedValue(error);
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).resolves.toBe(false);
    expect(JSON.parse(state.files.get(prefix + ".result.json")!)).toEqual({ ok: false, error: expected });
    expect(state.files.get(prefix + ".result.json")).not.toContain("TEST private");
    expect(state.handler).toHaveBeenCalledTimes(1);
  } finally { process.argv[1] = previous!; }
});
it("does not invoke a code accessor while retaining a failed operation", async () => {
  await submitHostedMimoProjectBridge(request);
  const owner = JSON.parse(state.files.get(prefix + ".owner.json")!);
  const previous = process.argv[1]; process.argv[1] = entry;
  const getter = vi.fn(() => { throw new Error("TEST private accessor"); });
  try {
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.handler.mockRejectedValue(Object.defineProperty(new Error("TEST private failure"), "code", { get: getter }));
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).resolves.toBe(false);
    expect(JSON.parse(state.files.get(prefix + ".result.json")!)).toEqual({ ok: false, error: "mimo_project_bridge_operation_failed" });
    expect(getter).not.toHaveBeenCalled();
    expect(state.files.get(prefix + ".result.json")).not.toContain("TEST private");
    expect(state.handler).toHaveBeenCalledOnce();
  } finally { process.argv[1] = previous!; }
});
function control(operation: MimoProjectBridgeOperation) { const { prompt: _prompt, sourceCommit: _commit, ...identity } = request; return { ...identity, operation }; }
it("settles an oversized Status projection as a bounded response error", async () => {
  // Legal backslash-heavy filenames fit Git's 1MiB stdout limit but their
  // porcelain quoting expands again when the Status projection is serialized.
  const changedFiles = Array.from({ length: 3500 }, (_, i) => '"src/.mimo-shared-review/' + "\\".repeat(190) + String(i).padStart(4, "0") + '"');
  const response = { ok: true, status: { changedFiles } };
  expect(Buffer.byteLength(JSON.stringify({ ok: true, result: response }))).toBeGreaterThan(1048576);
  const status = control(MimoProjectBridgeOperation.Status), base = prefix.replace(".create", ".status");
  await submitHostedMimoProjectBridge(status);
  const retainedOwner = state.files.get(base + ".owner.json")!, owner = JSON.parse(retainedOwner);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.handler.mockResolvedValue(response);
    await expect(executeHostedMimoProjectBridgeOperation(base + ".request.json")).resolves.toBe(false);
    expect(JSON.parse(state.files.get(base + ".result.json")!)).toEqual({ ok: false, error: "mimo_project_bridge_response_invalid" });
    expect(state.files.get(base + ".owner.json")).toBe(retainedOwner);
    expect(state.handler).toHaveBeenCalledOnce();
  } finally { process.argv[1] = previous!; }
});
it.each(["cycle", "utf8-size"])("settles a %s result without exposing payload or replaying Create", async fault => {
  const response: { ok: boolean; detail?: unknown } = { ok: true };
  response.detail = fault === "cycle" ? response : "я".repeat(600000);
  await submitHostedMimoProjectBridge(request);
  const retainedOwner = state.files.get(prefix + ".owner.json")!, owner = JSON.parse(retainedOwner);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.handler.mockResolvedValue(response);
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).resolves.toBe(false);
    expect(JSON.parse(state.files.get(prefix + ".result.json")!)).toEqual({ ok: false, error: fault === "cycle" ? "mimo_project_bridge_type_error" : "mimo_project_bridge_response_invalid" });
    state.command.mockImplementation((_command: string, args: string[]) => terminalShow(args[1]!));
    await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ state: "settled" });
    await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_creation_pending");
    expect(state.files.get(prefix + ".owner.json")).toBe(retainedOwner);
    expect(state.handler).toHaveBeenCalledOnce();
    expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
  } finally { process.argv[1] = previous!; }
});
it.each(["write", "rename"] as const)("retains %s publication uncertainty without replay or a fabricated failure result", async fault => {
  await submitHostedMimoProjectBridge(request);
  const retainedOwner = state.files.get(prefix + ".owner.json")!, owner = JSON.parse(retainedOwner);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.command.mockReturnValue("MainPID=" + process.pid + "\nDescription=" + owner.description);
    state.publicationFailure = fault;
    await expect(executeHostedMimoProjectBridgeOperation(prefix + ".request.json")).rejects.toThrow("TEST result " + fault + " uncertain");
    expect(state.files.has(prefix + ".result.json")).toBe(false);
    expect(state.files.has(prefix + ".result.json.tmp")).toBe(fault === "rename");
    state.command.mockImplementation((_command: string, args: string[]) => terminalShow(args[1]!));
    await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ state: "unresolved" });
    await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_creation_pending");
    expect(state.files.get(prefix + ".owner.json")).toBe(retainedOwner);
    expect(state.handler).toHaveBeenCalledOnce();
    expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
  } finally { process.argv[1] = previous!; }
});
function repairRequest() {
  return { ...control(MimoProjectBridgeOperation.RepairAdmission), repairPlan: { schemaVersion: 1, machineId: request.machineId,
    projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId,
    expectedBindingSha256: "c".repeat(64), expectedControllerManifestSha256: "d".repeat(64), expectedManifestSha256: "e".repeat(64),
    expectedContractSha256: "f".repeat(64), expectedStateSha256: "0".repeat(64), expectedReceiptSha256: "1".repeat(64), ownedPaths: ["src/TEST.hpp"] } };
}
it("retains the repair once through uncertainty and refuses changed plan replay", async () => {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
  const repair = repairRequest(), repairPrefix = prefix.replace(".create", ".repair-admission");
  state.command.mockImplementation((executable: string) => { if (executable === "/usr/bin/systemd-run") throw new Error("TEST repair uncertain"); return "LoadState=not-found\nActiveState=inactive"; });
  await expect(submitHostedMimoProjectBridge(repair)).rejects.toThrow("TEST repair uncertain");
  await expect(submitHostedMimoProjectBridge(repair)).resolves.toMatchObject({ state: "unresolved" });
  expect(state.files.has(repairPrefix + ".owner.json")).toBe(true);
  await expect(submitHostedMimoProjectBridge({ ...repair, repairPlan: { ...repair.repairPlan, ownedPaths: ["src/OTHER.hpp"] } })).rejects.toThrow("mimo_project_bridge_request_mismatch");
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(2);
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Status))).resolves.toMatchObject({ operations: { "repair-admission": { state: "unresolved" } } });
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).rejects.toThrow("mimo_project_bridge_control_pending");
});
it.each([{ ok: false }, { ok: true, result: { ok: false } }, { ok: true, result: { ok: true } }])("requires a successful settled repair before Start %j", async result => {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
  await submitHostedMimoProjectBridge(repairRequest());
  state.files.set(prefix.replace(".create", ".repair-admission.result.json"), JSON.stringify(result));
  if (result.ok && result.result?.ok) await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ pending: true });
  else await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_control_pending");
});
it.each([undefined, { ok: false }, { ok: true, result: { ok: false } }])("requires successful settled repair before finalization %j", async result => {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
  await submitHostedMimoProjectBridge(repairRequest());
  if (result !== undefined) state.files.set(prefix.replace(".create", ".repair-admission.result.json"), JSON.stringify(result));
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.FinalizeAdmissionRepair))).rejects.toThrow("mimo_project_bridge_repair_pending");
  expect(state.files.has(prefix.replace(".create", ".finalize-admission-repair.owner.json"))).toBe(false);
});
async function settledRepair() {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
  await submitHostedMimoProjectBridge(repairRequest());
  state.files.set(prefix.replace(".create", ".repair-admission.result.json"), JSON.stringify({ ok: true, result: { ok: true } }));
}
it("retains uncertain finalization without replacement and blocks Start, Stop, and semantic Status", async () => {
  await settledRepair();
  state.command.mockImplementation((executable: string) => { if (executable === "/usr/bin/systemd-run") throw new Error("TEST finalizer uncertain"); return "LoadState=not-found\nActiveState=inactive"; });
  const finalizer = control(MimoProjectBridgeOperation.FinalizeAdmissionRepair);
  await expect(submitHostedMimoProjectBridge(finalizer)).rejects.toThrow("TEST finalizer uncertain");
  await expect(submitHostedMimoProjectBridge(finalizer)).resolves.toMatchObject({ state: "unresolved" });
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(3);
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_control_pending");
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).rejects.toThrow("mimo_project_bridge_control_pending");
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Status))).resolves.toMatchObject({ operations: { "finalize-admission-repair": { state: "unresolved" } } });
});
it.each([{ ok: false }, { ok: true, result: { ok: false } }, { ok: true, result: { ok: true } }])("requires successful settled finalization before Start %j", async result => {
  await settledRepair();
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.FinalizeAdmissionRepair));
  state.files.set(prefix.replace(".create", ".finalize-admission-repair.result.json"), JSON.stringify(result));
  if (result.ok && result.result?.ok) await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ pending: true });
  else await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_control_pending");
});
it.each([MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop])("does not finalize while owned %s is running", async operation => {
  await settledRepair();
  if (operation !== MimoProjectBridgeOperation.Create) await submitHostedMimoProjectBridge(control(operation));
  state.command.mockImplementation((executable: string, args: string[]) => {
    if (executable !== "/usr/bin/systemctl") return "";
    const out = terminalShow(args[1]!);
    const row = [...state.files.entries()].find(([p, bytes]) => p.endsWith(`.${operation}.owner.json`) && JSON.parse(bytes).unit === args[1]);
    return row ? out.replace("ActiveState=failed", "ActiveState=active").replace("MainPID=0", "MainPID=123") : out;
  });
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.FinalizeAdmissionRepair))).rejects.toThrow("mimo_project_bridge_control_pending");
  expect(state.files.has(prefix.replace(".create", ".finalize-admission-repair.owner.json"))).toBe(false);
});
async function failedStartThenFinalized() {
  await settledRepair();
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start));
  const startPrefix = prefix.replace(".create", ".start");
  state.files.set(startPrefix + ".result.json", JSON.stringify({ ok: false, error: "project_control_admission_denied" }));
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.FinalizeAdmissionRepair));
  state.files.set(prefix.replace(".create", ".finalize-admission-repair.result.json"), JSON.stringify({ ok: true, result: { ok: true } }));
  state.files.set("/srv/worker-state/mimo-projects/test-project/test-stream/admission-repair-archives/test-job.finalization.json", "TEST finalization proof");
  state.command.mockImplementation((executable: string, args: string[]) => executable === "/usr/bin/systemctl" && args[0] !== "list-jobs" ? terminalShow(args[1]!) : "");
  return startPrefix;
}
it("rearms only an explicit terminal admission-denied Start after verified finalization and preserves all prior evidence", async () => {
  const startPrefix = await failedStartThenFinalized();
  const previous = { owner: state.files.get(startPrefix + ".owner.json")!, request: state.files.get(startPrefix + ".request.json")!, result: state.files.get(startPrefix + ".result.json")! };
  const submitted = state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run").length;
  expect(JSON.parse(previous.owner).generation).toBe(0); expect(state.rearm).not.toHaveBeenCalled();
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ pending: true });
  for (const [suffix, bytes] of Object.entries(previous)) expect(state.files.get(`${startPrefix}.${suffix}.json.generation-0`)).toBe(bytes);
  const current = JSON.parse(state.files.get(startPrefix + ".owner.json")!);
  expect(current.generation).toBe(1); expect(current.unit).not.toBe(JSON.parse(previous.owner).unit);
  expect(state.rearm).toHaveBeenCalledWith(control(MimoProjectBridgeOperation.Start), { ownerSha256: researchHash(previous.owner), requestSha256: researchHash(previous.request), resultSha256: researchHash(previous.result) });
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ state: "unresolved" });
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(submitted + 1);
  state.files.set(startPrefix + ".result.json.generation-0", JSON.stringify({ ok: false, error: "TEST tampered" }));
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_operation_invalid");
});
it.each(["proof-denied", "receipt-drift", "existing-archive", "provider-error", "semantic-error", "collected", "pending-unit"])("refuses Start rearm with %s", async fault => {
  const startPrefix = await failedStartThenFinalized(), oldOwner = state.files.get(startPrefix + ".owner.json");
  if (fault === "proof-denied") state.rearm.mockRejectedValueOnce(new Error("TEST proof denied"));
  if (fault === "receipt-drift") state.files.set("/srv/worker-state/mimo-projects/test-project/test-stream/admission-repair-archives/test-job.finalization.json", "TEST drift");
  if (fault === "existing-archive") state.files.set(startPrefix + ".owner.json.generation-0", "TEST existing archive");
  if (fault === "provider-error") state.files.set(startPrefix + ".result.json", JSON.stringify({ ok: false, error: "project_control_provider_failed" }));
  if (fault === "semantic-error") state.files.set(startPrefix + ".result.json", JSON.stringify({ ok: true, result: { ok: false, error: "project_control_admission_denied" } }));
  if (fault === "collected") state.command.mockReturnValue("LoadState=not-found\nActiveState=inactive");
  if (fault === "pending-unit") state.command.mockImplementation((executable: string, args: string[]) => executable === "/usr/bin/systemctl" ? args[0] === "list-jobs" ? `123 ${JSON.parse(oldOwner!).unit} start waiting` : terminalShow(args[1]!) : "");
  if (["provider-error", "semantic-error"].includes(fault)) await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ state: "settled" });
  else await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow();
  expect(state.files.get(startPrefix + ".owner.json")).toBe(oldOwner);
  expect(state.files.has(startPrefix + ".request.json.generation-0")).toBe(false);
});
it.each(["exact", "queued", "missing-proof", "nonzero-pid", "nonempty-cgroup", "missing-cgroup", "foreign-id"])("rearms collected admission-denied Start only with exact terminal evidence and immutable proof: %s", async condition => {
  const startPrefix = await failedStartThenFinalized(), previousOwner = state.files.get(startPrefix + ".owner.json")!, unit = JSON.parse(previousOwner).unit;
  state.command.mockImplementation((executable: string, args: string[]) => {
    if (executable !== "/usr/bin/systemctl") return "";
    if (args[0] === "list-jobs") return condition === "queued" ? `123 ${unit} start waiting` : "";
    if (args[1] !== unit) return terminalShow(args[1]!);
    return `Id=${condition === "foreign-id" ? "foreign.service" : unit}\nLoadState=not-found\nActiveState=inactive\nMainPID=${condition === "nonzero-pid" ? "123" : "0"}${condition === "missing-cgroup" ? "" : "\nControlGroup=" + (condition === "nonempty-cgroup" ? "/TEST/foreign" : "")}`;
  });
  if (condition === "missing-proof") state.files.delete("/srv/worker-state/mimo-projects/test-project/test-stream/admission-repair-archives/test-job.finalization.json");
  if (condition === "exact") {
    await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ pending: true });
    expect(JSON.parse(state.files.get(startPrefix + ".owner.json")!).generation).toBe(1);
    expect(state.files.get(startPrefix + ".owner.json.generation-0")).toBe(previousOwner);
    expect(state.rearm).toHaveBeenCalledOnce();
  } else {
    await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow();
    expect(state.files.get(startPrefix + ".owner.json")).toBe(previousOwner);
    expect(state.files.has(startPrefix + ".request.json.generation-0")).toBe(false);
  }
});
function terminalShow(unit: string) {
  const retained = [...state.files.entries()].find(([path, bytes]) => path.endsWith(".owner.json") && JSON.parse(bytes).unit === unit);
  if (!retained) return "LoadState=not-found\nActiveState=inactive";
  const value = JSON.parse(retained[1]);
  return `Id=${value.unit}\nDescription=${value.description}\nLoadState=loaded\nActiveState=failed\nMainPID=0\nControlGroup=`;
}
it.each(["prompt", "sourceCommit"])("rejects changed retained Create %s instead of returning another request receipt", async field => {
  await submitHostedMimoProjectBridge(request);
  await expect(submitHostedMimoProjectBridge({ ...request, [field]: field === "prompt" ? "TEST changed" : "c".repeat(40) })).rejects.toThrow("mimo_project_bridge_request_mismatch");
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
});
it("permits a fresh explicit stop only after its prior owned unit is verified terminal and settled", async () => {
  const stopPrefix = prefix.replace(".create", ".stop");
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop));
  const first = JSON.parse(state.files.get(stopPrefix + ".owner.json")!);
  expect((state.command.mock.calls[0]![1] as string[])).not.toContain("--collect");
  state.files.set(stopPrefix + ".result.json", JSON.stringify({ ok: false, error: "project_control_stop_denied" }));
  state.command.mockImplementation((executable: string, args: string[]) => executable === "/usr/bin/systemctl" ? terminalShow(args[1]!) : "");
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).resolves.toMatchObject({ pending: true });
  const second = JSON.parse(state.files.get(stopPrefix + ".owner.json")!);
  expect(second.generation).toBe(1); expect(second.unit).not.toBe(first.unit);
  expect(JSON.parse(state.files.get(stopPrefix + ".owner.json.generation-0")!)).toEqual(first);
  // The new service has no settled result: another request cannot replace it.
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).resolves.toMatchObject({ state: "unresolved" });
  expect(JSON.parse(state.files.get(stopPrefix + ".owner.json")!).generation).toBe(1);
});
it("retains a settled stop if its unit has been collected and terminal ownership cannot be verified", async () => {
  const stopPrefix = prefix.replace(".create", ".stop");
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop));
  state.files.set(stopPrefix + ".result.json", JSON.stringify({ ok: false, error: "project_control_stop_denied" }));
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).resolves.toMatchObject({ state: "settled", terminalVerified: false });
  expect(JSON.parse(state.files.get(stopPrefix + ".owner.json")!).generation).toBe(0);
});
it.each([MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start])("does not schedule Stop while owned %s is running", async operation => {
  await submitHostedMimoProjectBridge(request);
  if (operation === MimoProjectBridgeOperation.Start) {
    state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
    await submitHostedMimoProjectBridge(control(operation));
  }
  state.command.mockImplementation((executable: string, args: string[]) => {
    if (executable !== "/usr/bin/systemctl") return "";
    const out = terminalShow(args[1]!);
    const row = [...state.files.entries()].find(([p, bytes]) => p.endsWith(`.${operation}.owner.json`) && JSON.parse(bytes).unit === args[1]);
    return row ? out.replace("ActiveState=failed", "ActiveState=active").replace("MainPID=0", "MainPID=123") : out;
  });
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Stop))).rejects.toThrow("mimo_project_bridge_control_pending");
  expect(state.files.has(prefix.replace(".create", ".stop.owner.json"))).toBe(false);
});

function recipeInput() {
  const digest = researchHash(JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b)))));
  const suffix = researchHash(digest + ":0");
  return { request, requestSha256: digest, generation: 0, unit: `subscription-runtime-mimo-project-${suffix}.service`,
    description: `subscription-runtime MiMo project ${suffix}`, requestPath: prefix + ".request.json", entry, node: process.execPath, operationTimeoutMs: 900000 };
}
it("trusted recipe keeps service and environment arguments closed", () => {
  const launch = trustedMimoProjectOperationLaunch(recipeInput());
  expect(launch.command).toBe("/usr/bin/systemd-run");
  expect(launch.args).toContain("--expand-environment=no"); expect(launch.args).toContain("--property=Restart=no");
  const delimiter = launch.args.indexOf("--");
  expect(launch.args.slice(delimiter + 1)).toEqual(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/root", "USER=root", "LOGNAME=root", process.execPath, entry, "--execute-owned", prefix + ".request.json"]);
});
it("trusted recipe admits an explicit Start generation while keeping repair and finalizer one-shot", () => {
  for (const operation of [MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.RepairAdmission, MimoProjectBridgeOperation.FinalizeAdmissionRepair]) {
    const request = operation === MimoProjectBridgeOperation.RepairAdmission ? repairRequest() : control(operation);
    const digest = researchHash(JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b)))));
    const suffix = researchHash(digest + ":1");
    const input = { ...recipeInput(), request, requestSha256: digest, generation: 1, unit: `subscription-runtime-mimo-project-${suffix}.service`,
      description: `subscription-runtime MiMo project ${suffix}`, requestPath: prefix.replace(".create", "." + operation) + ".request.json" };
    if (operation === MimoProjectBridgeOperation.Start) expect(trustedMimoProjectOperationLaunch(input).args).toContain("--unit=" + input.unit);
    else expect(() => trustedMimoProjectOperationLaunch(input)).toThrow("mimo_project_bridge_operation_invalid");
  }
});
it.each([
  ["requestSha256", "0".repeat(64)], ["generation", 1], ["unit", "other.service"], ["description", "other"],
  ["requestPath", "/srv/worker-state/jobs/test-project/test-stream/request.json"],
  ["entry", "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js"],
  ["entry", "/opt/subscription-runtime/releases/main/dist/worker-codex/hosted-mimo-project-bridge-cli.js"],
  ["node", "/bin/sh"], ["operationTimeoutMs", 0], ["operationTimeoutMs", 86400001], ["args", ["/bin/sh"]],
])("trusted recipe rejects injected or mismatched %s", (key, value) => {
  expect(() => trustedMimoProjectOperationLaunch({ ...recipeInput(), [key]: value })).toThrow();
});

it.each(["absent", "failed"])("recovers a %s status observer without replaying provider controls", async lifecycle => {
  const status = control(MimoProjectBridgeOperation.Status), statusPrefix = prefix.replace(".create", ".status");
  await submitHostedMimoProjectBridge(status);
  const retainedRequest = state.files.get(statusPrefix + ".request.json"), first = JSON.parse(state.files.get(statusPrefix + ".owner.json")!);
  state.files.set(statusPrefix + ".result.json.tmp", "TEST interrupted result");
  state.command.mockImplementation((executable: string, args: string[]) => {
    if (executable !== "/usr/bin/systemctl" || args[0] === "list-jobs") return "";
    return lifecycle === "failed" ? terminalShow(args[1]!) : `Id=${first.unit}\nLoadState=not-found\nActiveState=inactive\nMainPID=0`;
  });
  await expect(submitHostedMimoProjectBridge(status)).resolves.toMatchObject({ pending: true });
  expect(state.files.get(statusPrefix + ".request.json.generation-0")).toBe(retainedRequest);
  expect(JSON.parse(state.files.get(statusPrefix + ".owner.json.generation-0")!)).toEqual(first);
  expect(JSON.parse(state.files.get(statusPrefix + ".owner.json")!).generation).toBe(1);
  expect(state.files.has(statusPrefix + ".result.json.generation-0")).toBe(false);
  expect(state.files.get(statusPrefix + ".result.json.tmp.generation-0")).toBe("TEST interrupted result");
  expect(state.files.has(statusPrefix + ".result.json.tmp")).toBe(false);
  expect(state.files.has(prefix + ".owner.json")).toBe(false);
  expect(state.files.has(prefix.replace(".create", ".start.owner.json"))).toBe(false);
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(2);
});
it.each(["pending-job", "nonzero-pid", "unknown-state", "running"])("retains an unresolved status observer with %s", async condition => {
  const status = control(MimoProjectBridgeOperation.Status), statusPrefix = prefix.replace(".create", ".status");
  await submitHostedMimoProjectBridge(status);
  const first = JSON.parse(state.files.get(statusPrefix + ".owner.json")!);
  state.command.mockImplementation((executable: string, args: string[]) => {
    if (executable !== "/usr/bin/systemctl") return "";
    if (args[0] === "list-jobs") return condition === "pending-job" ? `123 ${first.unit} start waiting` : "";
    const out = terminalShow(args[1]!);
    return condition === "nonzero-pid" ? out.replace("MainPID=0", "MainPID=99") : condition === "unknown-state" ? out.replace("ActiveState=failed", "ActiveState=maintenance") : condition === "running" ? out.replace("ActiveState=failed", "ActiveState=active") : out;
  });
  await expect(submitHostedMimoProjectBridge(status)).resolves.toMatchObject({ worker: { state: condition === "running" ? "running" : "unresolved" } });
  expect(JSON.parse(state.files.get(statusPrefix + ".owner.json")!)).toEqual(first);
  expect(state.files.has(statusPrefix + ".owner.json.generation-0")).toBe(false);
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
});
it("rejects foreign terminal status ownership before archiving", async () => {
  const status = control(MimoProjectBridgeOperation.Status), statusPrefix = prefix.replace(".create", ".status");
  await submitHostedMimoProjectBridge(status);
  state.command.mockReturnValue("Id=foreign.service\nLoadState=not-found\nActiveState=inactive\nMainPID=0");
  await expect(submitHostedMimoProjectBridge(status)).rejects.toThrow("mimo_project_bridge_operation_invalid");
  expect(state.files.has(statusPrefix + ".owner.json.generation-0")).toBe(false);
});
it("never overwrites prior status generation evidence", async () => {
  const status = control(MimoProjectBridgeOperation.Status), statusPrefix = prefix.replace(".create", ".status");
  await submitHostedMimoProjectBridge(status);
  const first = state.files.get(statusPrefix + ".owner.json");
  state.files.set(statusPrefix + ".owner.json.generation-0", "TEST existing evidence");
  state.command.mockImplementation((executable: string, args: string[]) => executable !== "/usr/bin/systemctl" || args[0] === "list-jobs" ? "" : terminalShow(args[1]!));
  await expect(submitHostedMimoProjectBridge(status)).rejects.toThrow("mimo_project_bridge_operation_invalid");
  expect(state.files.get(statusPrefix + ".owner.json")).toBe(first);
  expect(state.files.get(statusPrefix + ".owner.json.generation-0")).toBe("TEST existing evidence");
  expect(state.files.has(statusPrefix + ".request.json.generation-0")).toBe(false);
});

it("recovery accepts exact collected failed operations and refuses pending/successful effects", async () => {
  await submitHostedMimoProjectBridge(request);
  const saved = JSON.parse(state.files.get(prefix + ".owner.json")!);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: false, error: "project_control_admission_denied" }));
  state.command.mockImplementation((_command: string, args: string[]) => args[0] === "list-jobs" ? "" : `Id=${saved.unit}\nLoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n`);
  const b = { stateRoot: "/srv/worker-state/mimo-projects/test-project/test-stream", projectId: request.projectId, workstreamId: request.workstreamId, machineId: request.machineId };
  await expect(assertHostedMimoRecoveryOperationsSettled(b)).resolves.toBeUndefined();
  state.command.mockImplementation((_command: string, args: string[]) => args[0] === "list-jobs" ? `19 ${saved.unit} start waiting` : `Id=${saved.unit}\nLoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n`);
  await expect(assertHostedMimoRecoveryOperationsSettled(b)).rejects.toThrow();
  state.command.mockImplementation((_command: string, args: string[]) => args[0] === "list-jobs" ? "" : `Id=${saved.unit}\nLoadState=not-found\nActiveState=inactive\nMainPID=0\nControlGroup=\n`);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
  await expect(assertHostedMimoRecoveryOperationsSettled(b)).rejects.toThrow();
});

function interruptedCreatePair(complete: boolean) {
  const owner = JSON.parse(state.files.get(prefix + ".owner.json")!);
  const root = "/srv/worker-state/mimo-projects/test-project/test-stream/interrupted-create-settlements/test-job";
  const result = JSON.stringify({ ok: false, error: "project_control_interrupted_create_timeout" }) + "\n";
  const intent = JSON.stringify({ schemaVersion: 1, planSha256: "1".repeat(64), machineId: request.machineId,
    projectId: request.projectId, workstreamId: request.workstreamId, jobId: request.jobId,
    ownerSha256: researchHash(state.files.get(prefix + ".owner.json")!), requestSha256: researchHash(state.files.get(prefix + ".request.json")!),
    bindingSha256: "2".repeat(64), resultSha256: researchHash(result), witness: { unit: owner.unit, bootId: "3".repeat(32), invocationId: "4".repeat(32),
      startedMonotonicUs: "1000000", failedMonotonicUs: "901000000" }, partials: { attemptSha256: "9".repeat(64), promptSha256: "5".repeat(64), contractSha256: "6".repeat(64), stateSha256: "7".repeat(64), receiptSha256: "8".repeat(64) },
    outcome: { termination: "runtime_timeout", disposition: "retained_unregistered_failure", registrationPublished: false, payloadStarted: false, partialsPreserved: true }, cpuCause: "unproven" }) + "\n";
  state.files.set(prefix + ".result.json", result); state.files.set(root + ".intent.json", intent);
  state.files.set(root + ".receipt.json", JSON.stringify({ schemaVersion: 1, complete, intentSha256: researchHash(intent), resultSha256: researchHash(result) }) + "\n");
  return root;
}
it.each(["complete", "incomplete", "missing", "wrong-owner"])("recognizes only the bound complete interrupted Create settlement: %s", async phase => {
  await submitHostedMimoProjectBridge(request);
  const before = state.files.get(prefix + ".owner.json"), root = interruptedCreatePair(phase === "complete");
  if (phase === "missing") state.files.delete(root + ".receipt.json");
  if (phase === "wrong-owner") {
    const intent = JSON.parse(state.files.get(root + ".intent.json")!); intent.ownerSha256 = "0".repeat(64);
    const bytes = JSON.stringify(intent) + "\n"; state.files.set(root + ".intent.json", bytes);
    state.files.set(root + ".receipt.json", JSON.stringify({ schemaVersion: 1, complete: true, intentSha256: researchHash(bytes), resultSha256: researchHash(state.files.get(prefix + ".result.json")!) }));
  }
  state.command.mockImplementation((_exe: string, args: string[]) => args[0] === "list-jobs" ? "" : terminalShow(args[1]!));
  await expect(submitHostedMimoProjectBridge(request)).resolves.toMatchObject({ state: phase === "complete" ? "settled" : "unresolved" });
  const binding = { stateRoot: "/srv/worker-state/mimo-projects/test-project/test-stream", projectId: request.projectId, workstreamId: request.workstreamId, machineId: request.machineId };
  if (phase === "complete") await expect(assertHostedMimoRecoveryOperationsSettled(binding)).resolves.toBeUndefined();
  else await expect(assertHostedMimoRecoveryOperationsSettled(binding)).rejects.toThrow("mimo_project_bridge_recovery_denied");
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("mimo_project_bridge_creation_pending");
  expect(state.files.get(prefix + ".owner.json")).toBe(before);
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(1);
});

const prelaunchFailures = ["protected_job_birth_publication_busy", "mimo_project_bridge_operation_failed"] as const;
async function publicationBusyStart(error: string = prelaunchFailures[0]) {
  await submitHostedMimoProjectBridge(request);
  state.files.set(prefix + ".result.json", JSON.stringify({ ok: true, result: { ok: true } }));
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start));
  const stem = prefix.replace(".create", ".start");
  state.files.set(stem + ".result.json", JSON.stringify({ ok: false, error }));
  state.command.mockImplementation((executable: string, args: string[]) => executable === "/usr/bin/systemctl" && args[0] !== "list-jobs" ? terminalShow(args[1]!) : "");
  return stem;
}
it.each(prelaunchFailures)("rearms exact cold pre-effect Start and retains its generation: %s", async error => {
  const stem = await publicationBusyStart(error), oldOwner = state.files.get(stem + ".owner.json")!;
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ pending: true });
  expect(state.files.get(stem + ".owner.json.generation-0")).toBe(oldOwner);
  expect(JSON.parse(state.files.get(stem + ".owner.json")!).generation).toBe(1);
  expect(state.busyCapture).toHaveBeenCalledOnce(); expect(state.rearm).not.toHaveBeenCalled();
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).resolves.toMatchObject({ state: "unresolved" });
  expect(state.busyCapture).toHaveBeenCalledOnce();
});
it.each(prelaunchFailures)("keeps the failed owner intact when fresh pre-effect proof refuses: %s", async error => {
  const stem = await publicationBusyStart(error), oldOwner = state.files.get(stem + ".owner.json")!;
  state.busyCapture.mockRejectedValueOnce(new Error("TEST first effect present"));
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow("TEST first effect present");
  expect(state.files.get(stem + ".owner.json")).toBe(oldOwner); expect(state.files.has(stem + ".owner.json.generation-0")).toBe(false);
});

it.each(prelaunchFailures)("rechecks fresh proof inside the owned unit before any handler effect: %s", async error => {
  const stem = await publicationBusyStart(error);
  await submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start));
  const next = JSON.parse(state.files.get(stem + ".owner.json")!), old = JSON.parse(state.files.get(stem + ".owner.json.generation-0")!);
  state.command.mockImplementation((_exe: string, args: string[]) => args[0] === "list-jobs" ? "" : args[1] === next.unit
    ? `MainPID=${process.pid}\nDescription=${next.description}`
    : `Id=${old.unit}\nDescription=${old.description}\nLoadState=loaded\nActiveState=failed\nMainPID=0\nControlGroup=`);
  const previous = process.argv[1]; process.argv[1] = entry;
  try {
    state.busyCurrent.mockRejectedValueOnce(new Error("mimo_project_bridge_publication_busy_rearm_refused"));
    await expect(executeHostedMimoProjectBridgeOperation(stem + ".request.json")).resolves.toBe(false);
    expect(state.busyCurrent).toHaveBeenCalledOnce(); expect(state.handler).not.toHaveBeenCalled();
  } finally { process.argv[1] = previous!; }
});

it.each(prelaunchFailures.flatMap(error => ["queued", "pid", "cgroup", "foreign-unit", "changed-request", "existing-proof", "partial-result", "unknown-error"].map(fault => [error, fault] as const)))("never rearms uncertain or unsupported Start (%s): %s", async (error, fault) => {
  const stem = await publicationBusyStart(error), oldOwner = state.files.get(stem + ".owner.json")!, old = JSON.parse(oldOwner);
  if (fault === "queued") state.command.mockImplementation((_exe: string, args: string[]) => args[0] === "list-jobs" ? `1 ${old.unit} start waiting` : terminalShow(args[1]!));
  if (fault === "pid" || fault === "cgroup" || fault === "foreign-unit") state.command.mockImplementation((_exe: string, args: string[]) => {
    if (args[0] === "list-jobs") return "";
    const out = terminalShow(args[1]!); if (args[1] !== old.unit) return out;
    return fault === "pid" ? out.replace("MainPID=0", "MainPID=999") : fault === "cgroup" ? out.replace("ControlGroup=", "ControlGroup=/TEST") : out.replace(`Id=${old.unit}`, "Id=foreign.service");
  });
  if (fault === "existing-proof") state.files.set(stem + ".publication-busy-rearm-0.json", "TEST retained partial");
  if (fault === "partial-result") state.files.set(stem + ".result.json.tmp", "TEST uncertain partial");
  if (fault === "unknown-error") state.files.set(stem + ".result.json", JSON.stringify({ ok: false, error: "mimo_project_bridge_type_error" }));
  const next = { ...control(MimoProjectBridgeOperation.Start), ...(fault === "changed-request" ? { confirmStart: false } : {}) };
  if (fault === "unknown-error") await expect(submitHostedMimoProjectBridge(next)).resolves.toMatchObject({ state: "settled" });
  else await expect(submitHostedMimoProjectBridge(next)).rejects.toThrow();
  expect(state.files.get(stem + ".owner.json")).toBe(oldOwner); expect(state.files.has(stem + ".owner.json.generation-0")).toBe(false);
});

it.each(["request", "result", "owner"])("retains an incomplete rearm after archival crash at %s", async lastArchived => {
  const stem = await publicationBusyStart("mimo_project_bridge_operation_failed");
  const previous = new Map(state.files);
  for (const suffix of ["request", "result", "owner"]) {
    const path = stem + "." + suffix + ".json";
    state.files.set(path + ".generation-0", state.files.get(path)!); state.files.delete(path);
    if (suffix === lastArchived) break;
  }
  const afterCrash = new Map(state.files);
  state.command.mockClear();
  await expect(submitHostedMimoProjectBridge(control(MimoProjectBridgeOperation.Start))).rejects.toThrow();
  expect(state.files).toEqual(afterCrash);
  expect(state.command.mock.calls.filter(row => row[0] === "/usr/bin/systemd-run")).toHaveLength(0);
  expect(state.files.get(stem + ".request.json.generation-0")).toBe(previous.get(stem + ".request.json"));
});
