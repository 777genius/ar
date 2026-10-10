import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readHostedMimoWorkerOrigin, readHostedMimoCodingWorkerOrigin, assertHostedMimoCodingWorkerOriginCurrent } from "../hosted-mimo-worker-origin";
import { CodexModelBackend, codexMimoDefaultModel } from "../codex-model-backend";
import { CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { HostedMimoProfile } from "../hosted-mimo-profile";
const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), descriptors: new Map<number, string>(), next: 10,
  service: "", pinInode: 21, pinMode: 0o700, materialCalls: 0, materialInvalid: false, workspaceInode: 21, closing: false, lateEffect: undefined as undefined | (() => void) }));
vi.mock("../hosted-mimo-worker-material", () => ({ assertHostedMimoWorkerMaterial: () => { state.materialCalls++; if (state.materialInvalid) throw new Error("TEST_material_invalid"); } }));
vi.mock("node:child_process", () => ({ spawnSync: () => ({ status: 0, stdout: state.service }) }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: (path: string, encoding?: string) => { const data = state.files.get(path); if (!data) throw Object.assign(new Error(), { code: "ENOENT" }); return encoding ? data.toString() : data; },
  readlinkSync: (path: string) => `ns-${path.split("/").at(-1)}`,
  lstatSync: (path: string) => {
    if (path.includes("host-policy") || path.endsWith("closing.json") && !state.closing) throw Object.assign(new Error(), { code: "ENOENT" });
    const pin = path.endsWith("durable-handoff");
    if (pin && state.lateEffect) { const effect = state.lateEffect; state.lateEffect = undefined; effect(); }
    return { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: pin ? state.pinMode : path.endsWith("durable-handoffs") ? 0o700 : 0o755,
      dev: 7, ino: pin ? state.pinInode : path === "/TEST/workspace" || path.endsWith("pins/workspace") ? state.workspaceInode : 21 };
  },
  openSync: (path: string) => { if (!state.files.has(path)) throw new Error("missing fixture"); const fd = state.next++; state.descriptors.set(fd, path); return fd; },
  closeSync: (fd: number) => state.descriptors.delete(fd),
  fstatSync: (fd: number) => ({ isFile: () => true, uid: 0, nlink: 1, mode: state.descriptors.get(fd)?.startsWith("/run/systemd/") ? 0o644 : 0o600,
    size: state.files.get(state.descriptors.get(fd)!)!.length, ctimeMs: 1, mtimeMs: 1 }),
  readSync: (fd: number, output: Buffer, offset: number, length: number, position: number) => state.files.get(state.descriptors.get(fd)!)!.copy(output, offset, position, position + length),
}));
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let spec: Record<string, unknown>, grant: Record<string, unknown>, directory: string, job: string;
function publish(): void {
  const put = (path: string, value: unknown) => { const data = Buffer.from(JSON.stringify(value)); state.files.set(path, data); return digest(data); };
  const grantHash = put(`${job}/grant.json`, grant); spec.grantSha256 = grantHash;
  const sha = put(`${directory}/spec.json`, spec), unit = String(spec.unit), group = `/system.slice/${unit}`;
  const description = `subscription-runtime-research:${digest("test-job")}:${sha}`;
  state.service = Object.entries({ Id: unit, MainPID: process.pid, ControlGroup: group, InvocationID: "a".repeat(32), Description: description,
    ActiveState: "active", SubState: "running", Transient: "yes", FragmentPath: `/run/systemd/transient/${unit}`, DropInPaths: "", KillMode: "control-group" }).map(([k, v]) => `${k}=${v}`).join("\n");
  state.files.set(`/run/systemd/transient/${unit}`, Buffer.from("unit"));
  put(`${job}/active.json`, { schemaVersion: 1, startId: spec.startId, specSha256: sha });
  put(`${directory}/binding.json`, { schemaVersion: 1, specSha256: sha,
    process: { pid: process.pid, birthTicks: "42", bootId: "boot", machineId: "machine", controlGroup: group,
      namespaces: { user: "ns-user", mnt: "ns-mnt", pid: "ns-pid", net: "ns-net" } },
    service: { unit, mainPid: process.pid, controlGroup: group, invocationId: "a".repeat(32), description,
      fragmentSha256: digest("unit") } });
}
beforeEach(() => {
  state.files.clear(); state.pinInode = 21; state.pinMode = 0o700; state.materialCalls = 0; state.materialInvalid = false; state.workspaceInode = 21; state.closing = false; state.lateEffect = undefined;
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "getuid").mockReturnValue(0); vi.spyOn(process, "geteuid").mockReturnValue(0);
  const startId = "11111111-1111-1111-1111-111111111111";
  // Explicit sealed wire fixture: provider tests do not import worker contracts.
  const request = { schemaVersion: 1, jobId: "test-job", taskId: "test-task", jobRootDir: "/TEST/job",
    workspacePath: "/TEST/workspace", promptPath: "/TEST/job/prompt.md", authRootDir: "/TEST/auth", durableHandoffRootDir: "/TEST/registry/durable-handoffs",
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, accounts: ["account-q"], codexBinaryPath: "/usr/bin/codex", model: codexMimoDefaultModel, reasoningEffort: "medium", serviceTier: "default", taskTimeoutMs: 60000,
    projectId: "test-project", maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: 30000 };
  const registeredHandoff = { registryRootDir: "/TEST/registry", controllerJobId: "test-controller", manifestSha256: "a".repeat(64), scopeSha256: "b".repeat(64),
    receiptSha256: "c".repeat(64), requestSha256: digest(JSON.stringify(request)),
    durableDirectory: { path: request.durableHandoffRootDir, device: 7, inode: 21, mountId: 5, mountDevice: "0:7", mountRoot: "/", mountPoint: "/", filesystemUuid: "12345678" },
    registeredExecution: { sourceConfigSha256: "d".repeat(64), reservedConfigSha256: "e".repeat(64), selectedAccountSha256: "f".repeat(64), accountId: "account-q",
      projectId: "test-project", maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: 30000 } };
  const identity = { path: request.jobRootDir, device: 7, inode: 21 }, workspace = { ...identity, path: request.workspacePath };
  grant = { schemaVersion: 1, profileId: CodexProviderEgressProfileId.MimoTokenPlan, hostedProfile: HostedMimoProfile.Worker, jobId: request.jobId,
    jobRootDir: request.jobRootDir, workspacePath: request.workspacePath, grantId: startId, jobDirectory: identity, workspaceDirectory: workspace, registeredHandoff };
  spec = { schemaVersion: 1, startId, runtimeDirectory: fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, ""),
    artifactSha256: "a".repeat(64), request, requestSha256: "b".repeat(64), nodeSha256: "c".repeat(64), codexSha256: "d".repeat(64),
    unit: `subscription-runtime-research-${startId}.service`, jobDirectory: identity, workspaceDirectory: workspace, registeredHandoff };
  job = `/run/user/subscription-runtime-research-v1/${digest(request.jobId)}`; directory = `${job}/starts/${startId}`;
  state.files.set("/proc/self/cgroup", Buffer.from(`0::/system.slice/${spec.unit}`));
  for (const map of ["uid_map", "gid_map"]) state.files.set(`/proc/self/${map}`, Buffer.from("0 0 4294967295"));
  state.files.set(`/proc/${process.pid}/stat`, Buffer.from(`1 (node) S ${Array(18).fill("0").join(" ")} 42`));
  state.files.set("/proc/sys/kernel/random/boot_id", Buffer.from("boot")); state.files.set("/etc/machine-id", Buffer.from("machine"));
  publish();
});
describe("sealed registered MiMo origin", () => {
  // The old origin rejected every registered launch before any credential access.
  it("accepts the independently sealed registered execution and private durable pin", () => {
    expect(readHostedMimoWorkerOrigin()).toEqual({ homeRoot: "/TEST/job/home", directory, digest: digest(state.files.get(`${directory}/spec.json`)!) });
  });
  it.each(["projectId", "durableHandoffRootDir", "appServerStartupTimeoutMs"])("rejects changed request %s even with a newly sealed spec", key => {
    spec.request = { ...(spec.request as object), [key]: key === "appServerStartupTimeoutMs" ? 30001 : "/TEST/foreign" }; publish();
    expect(() => readHostedMimoWorkerOrigin()).toThrow("hosted_mimo_worker_origin_invalid");
  });
  it("rejects changed model-independent request bytes against registered hash", () => {
    spec.request = { ...(spec.request as object), taskTimeoutMs: 61000 }; publish();
    expect(() => readHostedMimoWorkerOrigin()).toThrow();
  });
  it("rejects a handoff without a registered reservation", () => {
    const handoff = { ...(spec.registeredHandoff as Record<string, unknown>) }; delete handoff.registeredExecution;
    spec.registeredHandoff = handoff; grant.registeredHandoff = handoff; publish();
    expect(() => readHostedMimoWorkerOrigin()).toThrow();
  });
  it("rejects unequal grant authority", () => { grant.registeredHandoff = { ...(grant.registeredHandoff as object), receiptSha256: "0".repeat(64) }; publish();
    expect(() => readHostedMimoWorkerOrigin()).toThrow(); });
  it.each(["identity", "custody"])("rejects durable pin %s substitution", kind => { if (kind === "identity") state.pinInode++; else state.pinMode = 0o755;
    expect(() => readHostedMimoWorkerOrigin()).toThrow(); });
});

function codingRequest(): void {
  const prior = spec.request as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of ["schemaVersion", "jobId", "taskId", "jobRootDir", "workspacePath", "promptPath", "authRootDir", "durableHandoffRootDir"]) normalized[key] = prior[key];
  Object.assign(normalized, { hostedProfile: HostedMimoProfile.CodingV1, maxGoalTurns: 64 });
  for (const key of ["modelBackend", "accounts", "codexBinaryPath", "model", "reasoningEffort", "serviceTier", "taskTimeoutMs", "projectId", "maxAccountCycles", "prewarmOnStart", "appServerStartupTimeoutMs"]) normalized[key] = prior[key];
  spec.request = normalized;
  const handoff = { ...(spec.registeredHandoff as object), requestSha256: digest(JSON.stringify(normalized)) };
  spec.registeredHandoff = handoff; grant.registeredHandoff = handoff; grant.hostedProfile = HostedMimoProfile.CodingV1;
  publish();
}
describe("independent CodingV1 metadata proof, without activation", () => {
  it("fully checks material and returns immutable scoped metadata while old reader remains closed", () => {
    codingRequest();
    expect(() => readHostedMimoWorkerOrigin()).toThrow("hosted_mimo_coding_activation_closed");
    const proof = readHostedMimoCodingWorkerOrigin()!;
    expect(state.materialCalls).toBe(1);
    expect(proof).toMatchObject({ jobId: "test-job", startId: spec.startId, unit: spec.unit, workspacePath: "/TEST/workspace",
      workspaceDevice: 7, workspaceInode: 21, maxGoalTurns: 64, taskTimeoutMs: 60000 });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(() => assertHostedMimoCodingWorkerOriginCurrent(proof)).not.toThrow();
    expect(() => assertHostedMimoCodingWorkerOriginCurrent({ ...proof })).toThrow("hosted_mimo_worker_origin_invalid");
  });
  it("does not shortcut material or registered authority validation", () => {
    codingRequest(); state.materialInvalid = true;
    expect(() => readHostedMimoCodingWorkerOrigin()).toThrow("TEST_material_invalid");
    state.materialInvalid = false;
    spec.request = { ...(spec.request as object), maxGoalTurns: 65 }; publish();
    expect(() => readHostedMimoCodingWorkerOrigin()).toThrow("hosted_mimo_worker_origin_invalid");
  });
  it.each(["active", "grant", "spec", "binding", "process"])("invalidates retained proof after %s changes", kind => {
    codingRequest(); const proof = readHostedMimoCodingWorkerOrigin()!;
    const path = kind === "active" || kind === "grant" ? `${job}/${kind}.json` : `${directory}/${kind}.json`;
    if (kind === "process") state.files.set(`/proc/${process.pid}/stat`, Buffer.from(`1 (node) S ${Array(18).fill("0").join(" ")} 43`));
    else state.files.set(path, Buffer.from("{}"));
    expect(() => assertHostedMimoCodingWorkerOriginCurrent(proof)).toThrow("hosted_mimo_worker_origin_invalid");
  });
  it.each(["closing", "workspace", "namespace-map"])("rejects proof use after %s changes", kind => {
    codingRequest(); const proof = readHostedMimoCodingWorkerOrigin()!;
    if (kind === "closing") state.closing = true;
    else if (kind === "workspace") state.workspaceInode++;
    else state.files.set("/proc/self/uid_map", Buffer.from("0 1000 1"));
    expect(() => assertHostedMimoCodingWorkerOriginCurrent(proof)).toThrow("hosted_mimo_worker_origin_invalid");
  });
  it.each(["active", "closing"])("rejects %s revocation during the final durable pin check", kind => {
    codingRequest(); const proof = readHostedMimoCodingWorkerOrigin()!;
    state.lateEffect = () => {
      if (kind === "active") state.files.set(`${job}/active.json`, Buffer.from("{}"));
      else state.closing = true;
    };
    expect(() => assertHostedMimoCodingWorkerOriginCurrent(proof)).toThrow("hosted_mimo_worker_origin_invalid");
  });
  it("returns null only after fully validating Worker, preserving its ordinary reader", () => {
    expect(readHostedMimoCodingWorkerOrigin()).toBeNull();
    expect(state.materialCalls).toBe(1);
    expect(readHostedMimoWorkerOrigin()).not.toBeNull();
    state.materialInvalid = true;
    expect(() => readHostedMimoCodingWorkerOrigin()).toThrow("TEST_material_invalid");
  });
  it("rejects invalid Worker and mismatched profile grants", () => {
    grant.hostedProfile = "unknown"; publish();
    expect(() => readHostedMimoCodingWorkerOrigin()).toThrow("hosted_mimo_worker_origin_invalid");
    codingRequest(); grant.hostedProfile = HostedMimoProfile.Worker; publish();
    expect(() => readHostedMimoCodingWorkerOrigin()).toThrow("hosted_mimo_worker_origin_invalid");
  });
});
