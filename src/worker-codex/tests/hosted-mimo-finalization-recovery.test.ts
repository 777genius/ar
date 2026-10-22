import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Only host UID/path/kernel/manager boundaries and the owned-preservation effect
// are mapped. Plan validation, closed preconditions, receipt schemas and the
// actual exclusive synced filesystem publication are real.
const state = vi.hoisted(() => ({ fs: undefined as typeof import("node:fs") | undefined, root: "",
  inactive: true, op: "absent", cold: true, statusResult: undefined as unknown,
  waiting: true, waitingMismatch: false, retirement: false, race: false,
  current: undefined as { directory: string; spec: Record<string, unknown>; bytes: Buffer } | undefined,
  recovery: [] as unknown[] }));
const R = "/srv/worker-state/mimo-projects/test-project/test-stream";
const boot = "3".repeat(32), machine = "a".repeat(40 - 8).padEnd(32, "a"), unit = "subscription-runtime-TEST-finalization.service";
const startId = "123e4567-e89b-12d3-a456-426614174000", jobId = "test-job";
function mapped(path: import("node:fs").PathLike): import("node:fs").PathLike {
  if (typeof path !== "string" || !state.root) return path;
  if (path === "/proc/sys/kernel/random/boot_id") return join(state.root, "boot");
  if (path === "/etc/machine-id") return join(state.root, "machine");
  if (path.startsWith("/etc/subscription-runtime/mimo-projects/")) return join(state.root, "binding.json");
  if (path === "/proc" || path.startsWith("/proc/")) return join(state.root, "proc", path.slice(6));
  if (path === "/srv" || path.startsWith("/srv/")) return join(state.root, "host", path.slice(4));
  return path;
}
function stats(value: import("node:fs").Stats): import("node:fs").Stats {
  const result = Object.create(value) as import("node:fs").Stats;
  Object.defineProperties(result, { uid: { value: 0 }, gid: { value: 0 } });
  return result;
}
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>(); state.fs = fs;
  return { ...fs, lstatSync: (p: string) => stats(fs.lstatSync(mapped(p))), fstatSync: (fd: number) => stats(fs.fstatSync(fd)),
    readFileSync: (p: string | number, options?: unknown) =>
      fs.readFileSync(typeof p === "number" ? p : mapped(p), options as BufferEncoding),
    realpathSync: (p: string) => typeof mapped(p) === "string" && mapped(p) !== p ? p : fs.realpathSync(p),
    readdirSync: (p: string, options?: unknown) => fs.readdirSync(mapped(p), options as { withFileTypes: true }),
    mkdirSync: (p: string, options?: unknown) => fs.mkdirSync(mapped(p), options as import("node:fs").MakeDirectoryOptions),
    existsSync: (p: string) => fs.existsSync(mapped(p)), openSync: (p: string, flags: string | number, mode?: number) => fs.openSync(mapped(p), flags, mode),
    linkSync: (a: string, b: string) => fs.linkSync(mapped(a), mapped(b)), unlinkSync: (p: string) => fs.unlinkSync(mapped(p)),
    renameSync: (a: string, b: string) => fs.renameSync(mapped(a), mapped(b)),
  };
});
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchCommand: (_exe: string, args: string[]) => {
  if (args[0] === "list-jobs") return "";
  return `Id=${unit}\nLoadState=not-found\nActiveState=${state.inactive ? "inactive" : "active"}\nMainPID=0\n`;
} }));
vi.mock("../research-launch-files", async original => {
  const actual = await original<typeof import("../research-launch-files")>();
  return { ...actual, researchCustody: (p: string, privateLeaf = false) => {
    if (!state.root || mapped(p) === p) return;
    const s = state.fs!.lstatSync(mapped(p));
    if (s.isSymbolicLink() || (s.mode & 0o022) || privateLeaf && (s.mode & 0o777) !== 0o700) throw Error("TEST custody refused");
  }, researchPublish: (p: string, value: unknown, exclusive = false) => actual.researchPublish(p, value, exclusive) };
});
vi.mock("@vioxen/subscription-runtime/store-local-file", async original => ({ ...await original<object>(),
  acquireLocalControllerMaintenanceFence: async () => {
    // A concurrent recovery publishes its own receipt while this one waits for the fence.
    if (state.race) write(R + "/finalization-recoveries/" + jobId + ".json", { stolen: true });
    return { path: R + "/.controller-maintenance-fence.json", ownerToken: "TEST-fence" };
  }, releaseLocalControllerMaintenanceFence: async () => undefined }));
vi.mock("../hosted-mimo-project-bridge-operation", async original => ({ ...await original<object>(),
  observeHostedMimoProjectOperation: (request: { operation: string }) =>
    request.operation === "status" && state.statusResult !== undefined ? { state: "settled", result: state.statusResult } : { state: state.op },
  hostedMimoProjectOperationCold: () => state.cold }));
vi.mock("../research-launch-lifecycle", async original => ({ ...await original<object>(),
  observePendingMimoFinalization: () => state.waiting ? {
    startId: state.waitingMismatch ? "9".repeat(8) + "-0000-4000-8000-000000000000" : startId,
    candidateSha256: researchHash(state.fs!.readFileSync(mapped(join(state.current!.directory, "mimo-candidate.json")) as string)),
    runtimeDirectory: "/opt/subscription-runtime/releases/" + "f".repeat(40),
  } : undefined,
  researchProviderUnits: () => [],
  recoverOwnedMimoWorkerPreservation: async (expected: unknown) => {
    state.recovery.push(expected);
    return { startId: (expected as { startId: string }).startId, status: "recovered" };
  },
}));
vi.mock("../job-retirement/job-retirement-records", async original => ({ ...await original<object>(),
  assertNoWorkstreamRetirement: (_stateRoot: string, error: string) => { if (state.retirement) throw new Error(error); } }));
vi.mock("../research-launch-admission", async original => ({ ...await original<object>(), researchCurrentStart: () => state.current! }));
import { recoverHostedMimoFinalization } from "../hosted-mimo-finalization-recovery";
import { researchHash, researchRead } from "../research-launch-files";

function write(path: string, value: unknown): Buffer {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n");
  state.fs!.mkdirSync(dirname(mapped(path) as string), { mode: 0o700, recursive: true });
  state.fs!.writeFileSync(mapped(path), bytes, { mode: 0o600 }); return bytes;
}
let planPath: string, receiptPath: string, planBytes: Buffer, candidateSha: string, bindingSha: string, specSha: string;
function plan(overrides: Record<string, unknown> = {}): Buffer {
  planBytes = write(planPath, { schemaVersion: 1, machineId: machine, expectedBootId: boot, projectId: "test-project",
    workstreamId: "test-stream", jobId, startId, specSha256: specSha, candidateSha256: candidateSha, bindingSha256: bindingSha,
    action: "preserve", cause: "mimo_bridge_test_failure", ...overrides });
  return planBytes;
}
beforeEach(() => {
  // The realpath avoids /var's macOS symlink: custody walks the leaf up to /.
  state.root = state.fs!.mkdtempSync(join(state.fs!.realpathSync(tmpdir()), "TEST-finalization-recovery-"));
  state.inactive = true; state.op = "absent"; state.cold = true; state.statusResult = undefined;
  state.waiting = true; state.waitingMismatch = false; state.retirement = false; state.race = false; state.recovery = [];
  write("/etc/machine-id", machine); write("/proc/sys/kernel/random/boot_id", boot);
  const source = "b".repeat(40), declarative = { kind: "worker-launch", format: 1, canonicalSha: source, baseSha: source, phaseStartSha: source,
    packetRevision: "r1", controllerPacket: "docs/controller.md", lanePacket: "docs/lane.md", phaseId: "phase-01", laneId: "lane", inputPatchHash: null,
    reviewKind: "implementation", ownedPaths: ["src/"], mandatoryDocs: ["docs/controller.md", "docs/lane.md"], mandatoryScripts: [], mandatoryFixtures: [],
    requiredChecks: [{ id: "check", cwd: "src", command: "node --version" }], executionPolicy: { mode: "sandbox-only", sandboxRoot: "/srv/workers/mimo-projects/test-project/test-stream/workspaces/source/sandbox", forbiddenRealProjects: ["/srv/real-project"] } };
  write("/etc/subscription-runtime/mimo-projects/test-project/test-stream.json", { schemaVersion: 1, projectId: "test-project",
    workstreamId: "test-stream", machineId: machine, routingEnabled: true, stateRoot: R, scratchRoot: "/srv/workers/mimo-projects/test-project/test-stream",
    registryRootDir: R + "/registry", controllerJobId: "test-controller", sourceWorkspacePath: "/srv/workers/mimo-projects/test-project/test-stream/workspaces/source",
    sourceCommit: source, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/codex", taskTimeoutMs: 3600000,
    appServerStartupTimeoutMs: 600000, operationTimeoutMs: 900000, admission: { mode: "serial-builtin", contract: declarative } });
  // The start directory lives in mapped /srv space: the real custody walk inside
  // researchRead rejects world-writable /tmp ancestors on Linux.
  const directory = R + "/start";
  state.fs!.mkdirSync(mapped(R) as string, { mode: 0o700, recursive: true });
  state.fs!.mkdirSync(mapped(join(directory, "providers")) as string, { mode: 0o700, recursive: true });
  const spec = { startId, unit, requestSha256: "e".repeat(64), request: {}, registeredHandoff: undefined };
  const bytes = write(join(directory, "spec.json"), spec);
  const candidate = write(join(directory, "mimo-candidate.json"), { status: "done" });
  const binding = write(join(directory, "binding.json"), { binding: "TEST" });
  state.current = { directory, spec: spec as unknown as Record<string, unknown>, bytes };
  specSha = researchHash(bytes); candidateSha = researchHash(candidate); bindingSha = researchHash(binding);
  receiptPath = R + "/finalization-recoveries/" + jobId + ".json";
  planPath = join(state.root, "plan.json"); state.statusResult = { ok: false, error: "mimo_bridge_test_failure" }; plan();
});
afterEach(() => { state.fs!.rmSync(state.root, { recursive: true, force: true }); state.root = ""; vi.restoreAllMocks(); });

const expectedReceipt = () => ({ schemaVersion: 1, planSha256: researchHash(planBytes), machineId: machine, projectId: "test-project",
  workstreamId: "test-stream", jobId, startId, specSha256: specSha, candidateSha256: candidateSha, action: "preserve" });

it("recovers one stuck finalization and publishes its canonical receipt", async () => {
  const outcome = await recoverHostedMimoFinalization(planPath);
  expect(outcome).toMatchObject({ ok: true, action: "preserve", projectId: "test-project", workstreamId: "test-stream",
    jobId, startId, status: "recovered", receiptPath });
  expect(state.recovery).toEqual([{ jobId, startId, specSha256: specSha, requestSha256: "e".repeat(64) }]);
  expect(JSON.parse(researchRead(receiptPath).toString())).toEqual({ ...expectedReceipt(), status: "recovered", complete: true });
  // Idempotent: the second run finds the same receipt and drives no new effect.
  const again = await recoverHostedMimoFinalization(planPath);
  expect(again).toMatchObject({ ok: true, status: "recovered", receiptPath, alreadyRecovered: true });
  expect(state.recovery).toHaveLength(1);
});
it("accepts a refusal-receipt witness in place of the settled Status cause", async () => {
  const refusal = write(join(state.current!.directory, "preservation-refusal." + "0".repeat(64) + ".json"), { reason: "TEST" });
  plan({ cause: undefined, refusalReceiptSha256: researchHash(refusal) }); state.statusResult = undefined;
  await expect(recoverHostedMimoFinalization(planPath)).resolves.toMatchObject({ ok: true, status: "recovered" });
  expect(JSON.parse(researchRead(receiptPath).toString()).complete).toBe(true);
});
it("dry-runs the pinned recovery without driving the effect or minting a receipt", async () => {
  await expect(recoverHostedMimoFinalization(planPath, { dryRun: true })).resolves.toEqual({ ok: true, action: "preserve",
    projectId: "test-project", workstreamId: "test-stream", jobId, startId, status: "pending", receiptPath, dryRun: true });
  expect(state.recovery).toEqual([]);
  expect(state.fs!.existsSync(mapped(receiptPath))).toBe(false);
});
it("keeps discard closed under its own named refusal", async () => {
  plan({ action: "discard" });
  await expect(recoverHostedMimoFinalization(planPath)).rejects.toThrow("mimo_finalization_recovery_discard_refused");
  expect(state.recovery).toEqual([]);
  expect(state.fs!.existsSync(mapped(receiptPath))).toBe(false);
});
it.each([["cause and receipt"], ["neither witness"]])("refuses a plan pinned by %s", async shape => {
  plan(shape === "cause and receipt" ? { refusalReceiptSha256: "0".repeat(64) } : { cause: undefined });
  await expect(recoverHostedMimoFinalization(planPath)).rejects.toThrow("mimo_finalization_recovery_refused");
  expect(state.recovery).toEqual([]);
});
it.each(["machine", "boot", "retirement", "controller-recovery", "operation-running", "operation-unresolved-hot",
  "cause-mismatch", "spec-hash", "candidate-hash", "binding-hash", "receipt-missing", "waiting-absent", "waiting-mismatch",
  "unit-active", "fence-race"])("refuses unsafe finalization recovery %s without publishing or driving preservation", async fault => {
  if (fault === "machine") plan({ machineId: "9".repeat(32) });
  if (fault === "boot") plan({ expectedBootId: "9".repeat(32) });
  if (fault === "retirement") state.retirement = true;
  if (fault === "controller-recovery") write(R + "/.controller-recovery.json", {});
  if (fault === "operation-running") state.op = "running";
  if (fault === "operation-unresolved-hot") { state.op = "unresolved"; state.cold = false; }
  if (fault === "cause-mismatch") state.statusResult = { ok: false, error: "other_failure_code" };
  if (fault === "spec-hash") plan({ specSha256: "0".repeat(64) });
  if (fault === "candidate-hash") plan({ candidateSha256: "0".repeat(64) });
  if (fault === "binding-hash") plan({ bindingSha256: "0".repeat(64) });
  if (fault === "receipt-missing") plan({ cause: undefined, refusalReceiptSha256: "0".repeat(64) });
  if (fault === "waiting-absent") state.waiting = false;
  if (fault === "waiting-mismatch") state.waitingMismatch = true;
  if (fault === "unit-active") state.inactive = false;
  if (fault === "fence-race") state.race = true;
  await expect(recoverHostedMimoFinalization(planPath)).rejects.toThrow();
  expect(state.recovery).toEqual([]);
  if (fault === "fence-race") expect(JSON.parse(researchRead(receiptPath).toString())).toEqual({ stolen: true });
  else expect(state.fs!.existsSync(mapped(receiptPath))).toBe(false);
});
it("retains a foreign receipt at the fence race rather than overwriting it", async () => {
  state.race = true;
  await expect(recoverHostedMimoFinalization(planPath)).rejects.toThrow("mimo_finalization_recovery_refused");
  expect(researchRead(receiptPath).toString()).toBe('{"stolen":true}\n');
});
it("refuses a receipt that does not match the pinned plan", async () => {
  plan(); write(receiptPath, { complete: true });
  await expect(recoverHostedMimoFinalization(planPath)).rejects.toThrow("mimo_finalization_recovery_refused");
  expect(state.recovery).toEqual([]);
});
