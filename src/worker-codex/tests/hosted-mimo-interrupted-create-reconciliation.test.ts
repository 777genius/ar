import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { CodexGoalJobManifestInput } from "../codex-goal-jobs";

// Only host UID/path/kernel/manager boundaries are mapped. Receipt schemas,
// retained-owner verification and actual exclusive synced filesystem publication are real.
const state = vi.hoisted(() => ({ fs: undefined as typeof import("node:fs") | undefined, root: "", unit: "", queue: false,
  birth: false, native: false, foreign: false, race: false, incomplete: false, now: 0, expiry: "none" as "none" | "base-read" | "publication-read",
  procReadError: "" as "" | "ENOENT" | "ESRCH" | "EACCES" | "EPERM" | "EIO", procDisappearance: "none" as "none" | "gone" | "reused" }));
const R = "/srv/worker-state/mimo-projects/test-project/test-stream", W = "/srv/workers/mimo-projects/test-project/test-stream/workspaces/test-job";
const boot = "3".repeat(32), invocation = "4".repeat(32), machine = "a".repeat(32), source = "b".repeat(40);
function mapped(path: import("node:fs").PathLike): import("node:fs").PathLike {
  if (typeof path !== "string" || !state.root) return path;
  if (path === "/proc/sys/kernel/random/boot_id") return join(state.root, "boot");
  if (path === "/etc/machine-id") return join(state.root, "machine");
  if (path.startsWith("/etc/subscription-runtime/mimo-projects/")) return join(state.root, "binding.json");
  if (path === "/proc" || path.startsWith("/proc/")) return join(state.root, "proc", path.slice(6));
  if (path.startsWith("/sys/fs/cgroup/system.slice/")) return join(state.root, "cgroups", path.slice("/sys/fs/cgroup/system.slice/".length));
  if (path === "/srv" || path.startsWith("/srv/")) return join(state.root, "host", path.slice(4));
  return path;
}
function stats(value: import("node:fs").Stats, path?: string): import("node:fs").Stats {
  const result = Object.create(value) as import("node:fs").Stats;
  Object.defineProperties(result, { uid: { value: state.foreign && path?.endsWith(".owner.json") ? 1000 : 0 }, gid: { value: 0 } });
  return result;
}
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>(); state.fs = fs;
  return { ...fs, lstatSync: (p: string) => stats(fs.lstatSync(mapped(p)), p), fstatSync: (fd: number) => stats(fs.fstatSync(fd)),
    readFileSync: (p: string | number, options?: unknown) => {
      if (p === "/proc/42/cgroup" && state.procReadError) {
        if (state.procDisappearance !== "none") {
          fs.rmSync(mapped("/proc/42"), { recursive: true });
          if (state.procDisappearance === "reused") {
            fs.mkdirSync(mapped("/proc/42"));
            fs.writeFileSync(mapped("/proc/42/cgroup"), "0::/system.slice/TEST-reused.service\n");
          }
        }
        throw Object.assign(Error("TEST process observation failed"), { code: state.procReadError });
      }
      return fs.readFileSync(typeof p === "number" ? p : mapped(p), options as BufferEncoding);
    },
    realpathSync: (p: string) => typeof mapped(p) === "string" && mapped(p) !== p ? p : fs.realpathSync(p),
    readdirSync: (p: string, options?: unknown) => fs.readdirSync(mapped(p), options as { withFileTypes: true }),
    mkdirSync: (p: string, options?: unknown) => fs.mkdirSync(mapped(p), options as import("node:fs").MakeDirectoryOptions),
    existsSync: (p: string) => fs.existsSync(mapped(p)), openSync: (p: string, flags: string | number, mode?: number) => fs.openSync(mapped(p), flags, mode),
    linkSync: (a: string, b: string) => fs.linkSync(mapped(a), mapped(b)), unlinkSync: (p: string) => fs.unlinkSync(mapped(p)),
    renameSync: (a: string, b: string) => fs.renameSync(mapped(a), mapped(b)),
  };
});
vi.mock("../research-launch-host", () => ({ assertResearchInitialRoot: vi.fn(), assertResearchSharedHost: vi.fn(), researchCommand: (exe: string, args: string[]) => {
  if (exe === "/usr/bin/journalctl") return journal();
  if (exe !== "/usr/bin/systemctl") throw Error("unexpected command");
  if (args[0] === "list-jobs") return state.queue ? `9 ${state.unit} start waiting\n` : "";
  return `Id=${state.unit}\nLoadState=not-found\nDescription=collected\nActiveState=inactive\nMainPID=0\nControlGroup=\n`;
} }));
vi.mock("../research-launch-files", async original => {
  const actual = await original<typeof import("../research-launch-files")>();
  return { ...actual, researchCustody: (p: string, privateLeaf = false) => {
    if (!state.root || mapped(p) === p) return;
    const s = state.fs!.lstatSync(mapped(p));
    if (s.isSymbolicLink() || (s.mode & 0o022) || privateLeaf && (s.mode & 0o777) !== 0o700) throw Error("TEST custody refused");
  }, researchPublish: (p: string, value: unknown, exclusive = false) => {
    if (state.incomplete && p.endsWith(".receipt.json") && (value as { complete?: unknown }).complete === true) throw Error("TEST receipt finalization interrupted");
    actual.researchPublish(p, value, exclusive);
    if (state.race && p.endsWith(".receipt.json") && exclusive) state.fs!.appendFileSync(mapped(R + "/mimo-bridge-operations/test-job.create.owner.json"), " ");
  } };
});
vi.mock("../hosted-mimo-project-bridge", async original => ({ ...await original<object>(), hostedMimoBridgeMetadataBytes: (p: string) => {
  const bytes = state.fs!.readFileSync(mapped(p));
  // A real retained-byte read finishes late during the final completion guard.
  if (state.fs!.existsSync(mapped(prefix + ".result.json")) &&
    (state.expiry === "base-read" && p.endsWith("/prompt.md") || state.expiry === "publication-read" && p === stem + ".receipt.json")) state.now = 6000;
  return bytes;
} }));
vi.mock("../protected-job-birth", () => ({ withProtectedCodexGoalJobBirthPublication: async (effect: () => Promise<unknown>) => effect(),
  assertProtectedCodexGoalJobBirthUnpublished: () => { if (state.birth) throw Error("TEST birth already published"); } }));
vi.mock("../research-job-runtime-provenance", () => ({ researchJobRuntimeNamespaceAbsent: () => !state.native }));
vi.mock("../hosted-ordinary-writer-authority", () => ({ hostedOrdinaryWriterAuthorityAbsent: () => true }));
vi.mock("../hosted-mimo-project-workstream-fence", () => ({ withHostedMimoWorkstreamActivity: async (_: string, effect: () => Promise<unknown>) => effect() }));
vi.mock("@vioxen/subscription-runtime/store-local-file", async original => ({ ...await original<object>(),
  acquireLocalControllerMaintenanceFence: async () => {
    const path = R + "/.controller-maintenance-fence.json"; write(path, { ownerToken: "TEST-fence" }); return { path, ownerToken: "TEST-fence" };
  }, releaseLocalControllerMaintenanceFence: async ({ path }: { path: string }) => state.fs!.unlinkSync(mapped(path)) }));
import { reconcileHostedMimoInterruptedCreate, decodeHostedMimoCreateTimeoutJournal } from "../hosted-mimo-interrupted-create-reconciliation";
import { readHostedMimoProjectOperationOwner, hostedMimoInterruptedCreateComplete } from "../hosted-mimo-project-bridge-operation";
import { researchHash } from "../research-launch-files";
import { materializeBuiltinWorkerLaunchSpec } from "../application/project-control/codex-goal-project-builtin-pre-start-admission";
import { parseMimoProjectBridgeRequest } from "../hosted-mimo-project-bridge-contract";
const request = { kind: "MimoProject", schemaVersion: 1, machineId: machine, projectId: "test-project", workstreamId: "test-stream", operation: "create", jobId: "test-job", prompt: "TEST secret prompt", sourceCommit: source };
const prefix = R + "/mimo-bridge-operations/test-job.create", stem = R + "/interrupted-create-settlements/test-job";
let planPath: string;
function write(path: string, value: unknown): Buffer {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value) + "\n");
  state.fs!.mkdirSync(dirname(mapped(path) as string), { mode: 0o700, recursive: true });
  state.fs!.writeFileSync(mapped(path), bytes, { mode: 0o600 }); return bytes;
}
function journal() {
  const base = { _PID: "1", _UID: "0", _COMM: "systemd", _TRANSPORT: "journal", _MACHINE_ID: machine, _BOOT_ID: boot,
    INVOCATION_ID: invocation, UNIT: state.unit, MESSAGE: "TEST secret is never retained" };
  return [ { ...base, MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", JOB_RESULT: "done", __MONOTONIC_TIMESTAMP: "1000000" },
    { ...base, MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "timeout", __MONOTONIC_TIMESTAMP: "901000000" } ].map(x => JSON.stringify(x)).join("\n") + "\n";
}
beforeEach(() => {
  state.root = state.fs!.mkdtempSync(join(tmpdir(), "TEST-interrupted-create-"));
  state.queue = state.birth = state.native = state.foreign = state.race = state.incomplete = false;
  state.now = 0; state.expiry = "none"; vi.spyOn(performance, "now").mockImplementation(() => state.now);
  state.procReadError = ""; state.procDisappearance = "none";
  const digest = researchHash(JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b)))));
  const suffix = researchHash(digest + ":0"); state.unit = "subscription-runtime-mimo-project-" + suffix + ".service";
  const req = write(prefix + ".request.json", JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b)))) + "\n");
  const owner = write(prefix + ".owner.json", { schemaVersion: 1, requestSha256: digest, generation: 0, unit: state.unit,
    description: "subscription-runtime MiMo project " + suffix, entry: "/opt/subscription-runtime/releases/" + "f".repeat(40) + "/dist/worker-codex/hosted-mimo-project-bridge-cli.js", node: process.execPath });
  const jobRoot = R + "/jobs/test-job";
  write(R + "/mimo-bridge-attempts/test-job.json", { schemaVersion: 1, requestSha256: researchHash(JSON.stringify(JSON.parse(req.toString()))),
    projectId: "test-project", workstreamId: "test-stream", jobId: "test-job", jobRoot, workspace: W });
  const declarative = { kind: "worker-launch", format: 1, canonicalSha: source, baseSha: source, phaseStartSha: source,
    packetRevision: "r1", controllerPacket: "docs/controller.md", lanePacket: "docs/lane.md", phaseId: "phase-01", laneId: "lane", inputPatchHash: null,
    reviewKind: "implementation", ownedPaths: ["src/"], mandatoryDocs: ["docs/controller.md", "docs/lane.md"], mandatoryScripts: [], mandatoryFixtures: [],
    requiredChecks: [{ id: "check", cwd: "src", command: "node --version" }], executionPolicy: { mode: "sandbox-only", sandboxRoot: W + "/sandbox", forbiddenRealProjects: ["/srv/real-project"] } };
  const material = materializeBuiltinWorkerLaunchSpec({ contract: declarative,
    manifest: { jobId: "test-job", jobRootDir: jobRoot, workspacePath: W, promptPath: jobRoot + "/prompt.md" } as CodexGoalJobManifestInput });
  const prompt = write(jobRoot + "/prompt.md", "TEST secret prompt"), contract = write(jobRoot + "/pre-start-admission/contract.json", material.contract), data = write(jobRoot + "/pre-start-admission/state.json", material.state);
  write(jobRoot + "/pre-start-admission/receipt.json", { schemaVersion: 1, status: "validated_not_launched", validatorKind: "builtin", jobId: "test-job",
    workKey: material.contract.workKey, workspaceHead: source, promptSha256: researchHash(prompt), contractSha256: researchHash(contract), stateSha256: researchHash(data) });
  state.fs!.mkdirSync(mapped(W), { mode: 0o700, recursive: true }); state.fs!.mkdirSync(mapped(R + "/registry"), { mode: 0o700 });
  const binding = write("/etc/subscription-runtime/mimo-projects/test-project/test-stream.json", { schemaVersion: 1, projectId: "test-project", workstreamId: "test-stream", machineId: machine, routingEnabled: true,
    stateRoot: R, scratchRoot: "/srv/workers/mimo-projects/test-project/test-stream", registryRootDir: R + "/registry", controllerJobId: "test-controller", sourceWorkspacePath: W,
    sourceCommit: source, sourceRef: "origin/main", codexBinaryPath: "/usr/bin/codex", taskTimeoutMs: 3600000, appServerStartupTimeoutMs: 600000, operationTimeoutMs: 900000,
    admission: { mode: "serial-builtin", contract: declarative } });
  write("/etc/machine-id", machine); write("/proc/sys/kernel/random/boot_id", boot); write("/proc/42/cgroup", "0::/system.slice/TEST-other.service\n");
  planPath = join(state.root, "plan.json"); write(planPath, { schemaVersion: 1, machineId: machine, projectId: "test-project", workstreamId: "test-stream", jobId: "test-job",
    expectedBindingSha256: researchHash(binding), expectedOwnerSha256: researchHash(owner), expectedRequestSha256: researchHash(req), expectedBootId: boot, expectedInvocationId: invocation });
});
afterEach(() => { state.fs!.rmSync(state.root, { recursive: true, force: true }); state.root = ""; vi.restoreAllMocks(); });
it("publishes a canonical failed pair through the real store and leaves all partials unchanged", async () => {
  const names = ["prompt.md", "pre-start-admission/contract.json", "pre-start-admission/state.json", "pre-start-admission/receipt.json"];
  const before = names.map(name => state.fs!.readFileSync(mapped(R + "/jobs/test-job/" + name)));
  await expect(reconcileHostedMimoInterruptedCreate(planPath)).resolves.toEqual({ termination: "runtime_timeout", disposition: "retained_unregistered_failure", registrationPublished: false, payloadStarted: false, partialsPreserved: true });
  expect(state.fs!.readFileSync(mapped(prefix + ".result.json"), "utf8")).toBe('{"ok":false,"error":"project_control_interrupted_create_timeout"}\n');
  expect(hostedMimoInterruptedCreateComplete(readHostedMimoProjectOperationOwner(parseMimoProjectBridgeRequest(request)))).toBe(true);
  for (const [i, name] of names.entries()) expect(state.fs!.readFileSync(mapped(R + "/jobs/test-job/" + name))).toEqual(before[i]);
  expect(state.fs!.statSync(mapped(prefix + ".result.json")).nlink).toBe(1);
  expect(state.fs!.statSync(mapped(prefix + ".result.json")).mode & 0o777).toBe(0o600);
  expect(state.fs!.readFileSync(mapped(stem + ".intent.json"), "utf8")).not.toContain("TEST secret");
  await expect(reconcileHostedMimoInterruptedCreate(planPath)).rejects.toThrow();
});
it.each(["ENOENT", "ESRCH"] as const)("settles after a %s census read only when the process is positively gone", async code => {
  state.procReadError = code; state.procDisappearance = "gone";
  await reconcileHostedMimoInterruptedCreate(planPath);
  expect(state.fs!.existsSync(mapped("/proc/42"))).toBe(false);
  expect(hostedMimoInterruptedCreateComplete(readHostedMimoProjectOperationOwner(parseMimoProjectBridgeRequest(request)))).toBe(true);
});
it.each([
  ["ENOENT", "none"], ["ESRCH", "none"], ["ESRCH", "reused"],
  ["EACCES", "gone"], ["EPERM", "gone"], ["EIO", "gone"],
] as const)("refuses a %s census read with %s process evidence without publication", async (code, disappearance) => {
  state.procReadError = code; state.procDisappearance = disappearance;
  await expect(reconcileHostedMimoInterruptedCreate(planPath)).rejects.toThrow();
  for (const path of [prefix + ".result.json", prefix + ".result.json.tmp", stem + ".intent.json", stem + ".receipt.json"])
    expect(state.fs!.existsSync(mapped(path))).toBe(false);
});
it.each(["queued", "live", "birth", "native", "manifest", "registry-partial", "wrong-attempt", "Start", "foreign-owner", "owner-race"])("refuses unsafe interrupted Create %s without publishing failure", async fault => {
  if (fault === "queued") state.queue = true;
  if (fault === "live") write("/proc/42/cgroup", `0::/system.slice/${state.unit}/child\n`);
  if (fault === "birth") state.birth = true;
  if (fault === "native") state.native = true;
  if (fault === "manifest") write(R + "/registry/test-job/job.json", {});
  if (fault === "registry-partial") write(R + "/registry/test-job/job.json.tmp", {});
  if (fault === "wrong-attempt") write(R + "/mimo-bridge-attempts/test-job.json", {});
  if (fault === "Start") write(R + "/mimo-bridge-operations/test-job.start.owner.json", {});
  if (fault === "foreign-owner") state.foreign = true;
  if (fault === "owner-race") state.race = true;
  await expect(reconcileHostedMimoInterruptedCreate(planPath)).rejects.toThrow();
  expect(state.fs!.existsSync(mapped(prefix + ".result.json"))).toBe(false);
});
it("retains uncertainty after result publication when receipt finalization is interrupted", async () => {
  state.incomplete = true;
  await expect(reconcileHostedMimoInterruptedCreate(planPath)).rejects.toThrow("TEST receipt finalization interrupted");
  expect(state.fs!.existsSync(mapped(prefix + ".result.json"))).toBe(true);
  expect(hostedMimoInterruptedCreateComplete(readHostedMimoProjectOperationOwner(parseMimoProjectBridgeRequest(request)))).toBe(false);
});
it.each(["base-read", "publication-read"] as const)("keeps the canonical pair unresolved when the final %s completes after witness expiry", async delay => {
  state.expiry = delay;
  await expect(reconcileHostedMimoInterruptedCreate(planPath)).rejects.toThrow("project_control_interrupted_create_reconciliation_refused");
  expect(state.now).toBe(6000);
  expect(state.fs!.existsSync(mapped(prefix + ".result.json"))).toBe(true);
  expect(JSON.parse(state.fs!.readFileSync(mapped(stem + ".receipt.json"), "utf8")).complete).toBe(false);
  expect(hostedMimoInterruptedCreateComplete(readHostedMimoProjectOperationOwner(parseMimoProjectBridgeRequest(request)))).toBe(false);
});
it.each(["missing", "spoofed", "wrong-invocation", "duplicate", "success"])("rejects a %s journal witness rather than treating collected-unit defaults as timeout", fault => {
  const rows = journal().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  if (fault === "missing") rows.pop();
  if (fault === "spoofed") rows[1]!._PID = "42";
  if (fault === "wrong-invocation") rows[1]!.INVOCATION_ID = "5".repeat(32);
  if (fault === "duplicate") rows.push({ ...rows[0]! });
  if (fault === "success") rows[1]!.UNIT_RESULT = "success";
  expect(() => decodeHostedMimoCreateTimeoutJournal(rows.map(row => JSON.stringify(row)).join("\n") + "\n", { machineId: machine, unit: state.unit, bootId: boot, invocationId: invocation, operationTimeoutMs: 900000 })).toThrow();
  expect(state.fs!.existsSync(mapped(prefix + ".result.json"))).toBe(false);
});

it("accepts the actual timeout metadata shape with later unbound PID1 unit diagnostics", () => {
  const rows = journal().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  rows[0]!.__MONOTONIC_TIMESTAMP = "2023952390033";
  rows[1]!.__MONOTONIC_TIMESTAMP = "2024852535503";
  // Exact sanitized shape/timing of the a6 manager diagnostics: no message,
  // invocation or lifecycle markers. No Host request or producer is invoked.
  for (const timestamp of ["2024875073094", "2024921724452", "2024964090744"]) rows.push({
    _PID: "1", _UID: "0", _COMM: "systemd", _TRANSPORT: "journal", _MACHINE_ID: machine,
    _BOOT_ID: boot, UNIT: state.unit, __MONOTONIC_TIMESTAMP: timestamp,
  });
  expect(decodeHostedMimoCreateTimeoutJournal(rows.map(row => JSON.stringify(row)).join("\n") + "\n", {
    machineId: machine, unit: state.unit, bootId: boot, invocationId: invocation, operationTimeoutMs: 900000,
  })).toEqual({ unit: state.unit, bootId: boot, invocationId: invocation,
    startedMonotonicUs: "2023952390033", failedMonotonicUs: "2024852535503" });
  expect(state.fs!.existsSync(mapped(prefix + ".result.json"))).toBe(false);
});

it.each(["message-id", "job-result", "unit-result", "null-invocation", "empty-invocation", "null-message-id", "foreign-invocation", "wrong-boot", "wrong-machine", "wrong-source", "bad-time"] as const)(
  "rejects a malformed/conflicting %s row alongside the valid timeout pair", fault => {
    const rows = journal().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const diagnostic: Record<string, unknown> = { _PID: "1", _UID: "0", _COMM: "systemd", _TRANSPORT: "journal",
      _MACHINE_ID: machine, _BOOT_ID: boot, UNIT: state.unit, __MONOTONIC_TIMESTAMP: "902000000" };
    if (fault === "message-id") diagnostic.MESSAGE_ID = "39f53479d3a045ac8e11786248231fbf";
    if (fault === "job-result") diagnostic.JOB_RESULT = "done";
    if (fault === "unit-result") diagnostic.UNIT_RESULT = "timeout";
    if (fault === "null-invocation") diagnostic.INVOCATION_ID = null;
    if (fault === "empty-invocation") diagnostic.INVOCATION_ID = "";
    if (fault === "null-message-id") diagnostic.MESSAGE_ID = null;
    if (fault === "foreign-invocation") diagnostic.INVOCATION_ID = "5".repeat(32);
    if (fault === "wrong-boot") diagnostic._BOOT_ID = "5".repeat(32);
    if (fault === "wrong-machine") diagnostic._MACHINE_ID = "5".repeat(32);
    if (fault === "wrong-source") diagnostic._TRANSPORT = "stdout";
    if (fault === "bad-time") diagnostic.__MONOTONIC_TIMESTAMP = "invalid";
    rows.push(diagnostic);
    expect(() => decodeHostedMimoCreateTimeoutJournal(rows.map(row => JSON.stringify(row)).join("\n") + "\n", {
      machineId: machine, unit: state.unit, bootId: boot, invocationId: invocation, operationTimeoutMs: 900000,
    })).toThrow("project_control_interrupted_create_reconciliation_refused");
    expect(state.fs!.existsSync(mapped(prefix + ".result.json"))).toBe(false);
  },
);
