import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readHostedMimoWorkerOrigin } from "../hosted-mimo-worker-origin";
import { parseResearchOperatorRequest, researchHashRequest } from "../../worker-codex/research-launch-contract";
import { CodexModelBackend, codexMimoDefaultModel } from "../codex-model-backend";
import { CodexProviderEgressProfileId } from "../codex-provider-egress-policy";
import { HostedMimoProfile } from "../hosted-mimo-profile";
const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), descriptors: new Map<number, string>(), next: 10,
  service: "", pinInode: 21, pinMode: 0o700 }));
vi.mock("../hosted-mimo-worker-material", () => ({ assertHostedMimoWorkerMaterial: () => undefined }));
vi.mock("node:child_process", () => ({ spawnSync: () => ({ status: 0, stdout: state.service }) }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: (path: string, encoding?: string) => { const data = state.files.get(path); if (!data) throw Object.assign(new Error(), { code: "ENOENT" }); return encoding ? data.toString() : data; },
  readlinkSync: (path: string) => `ns-${path.split("/").at(-1)}`,
  lstatSync: (path: string) => {
    if (path.includes("host-policy") || path.endsWith("closing.json")) throw Object.assign(new Error(), { code: "ENOENT" });
    const pin = path.endsWith("durable-handoff");
    return { isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: pin ? state.pinMode : path.endsWith("durable-handoffs") ? 0o700 : 0o755,
      dev: 7, ino: pin ? state.pinInode : 21 };
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
  state.files.clear(); state.pinInode = 21; state.pinMode = 0o700;
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "getuid").mockReturnValue(0); vi.spyOn(process, "geteuid").mockReturnValue(0);
  const startId = "11111111-1111-1111-1111-111111111111";
  const request = parseResearchOperatorRequest({ schemaVersion: 1, jobId: "test-job", taskId: "test-task", jobRootDir: "/TEST/job",
    workspacePath: "/TEST/workspace", promptPath: "/TEST/job/prompt.md", authRootDir: "/TEST/auth", accounts: ["account-q"], codexBinaryPath: "/usr/bin/codex",
    modelBackend: CodexModelBackend.XiaomiMimoTokenPlan, model: codexMimoDefaultModel, reasoningEffort: "medium", serviceTier: "default", taskTimeoutMs: 60000,
    projectId: "test-project", maxAccountCycles: 1, prewarmOnStart: false, appServerStartupTimeoutMs: 30000, durableHandoffRootDir: "/TEST/registry/durable-handoffs" });
  const registeredHandoff = { registryRootDir: "/TEST/registry", controllerJobId: "test-controller", manifestSha256: "a".repeat(64), scopeSha256: "b".repeat(64),
    receiptSha256: "c".repeat(64), requestSha256: researchHashRequest(request),
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
