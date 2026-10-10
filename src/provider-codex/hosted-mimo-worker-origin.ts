import { assertHostedMimoWorkerMaterial } from "./hosted-mimo-worker-material";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexModelBackend, codexMimoDefaultModel } from "./codex-model-backend";
import { CodexProviderEgressProfileId } from "./codex-provider-egress-policy";
import { HostedMimoProfile } from "./hosted-mimo-profile";

const authority = "/run/user/subscription-runtime-research-v1";
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_mimo_worker_origin_invalid"); }
type Wire = Record<string, unknown>;
function record(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Wire;
}
/** Independent secure read. Never follows a caller-selected authority or key. */
function bytes(path: string, privateLeaf = true): Buffer {
  for (let current = dirname(path);; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) invalid();
    if (current === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
        (before.mode & (privateLeaf ? 0o077 : 0o022)) || before.size < 1 || before.size > 1024 * 1024) invalid();
    const output = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < output.length) {
      const count = readSync(fd, output, length, output.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs || before.uid !== after.uid || before.nlink !== after.nlink || before.mode !== after.mode) invalid();
    return output.subarray(0, length);
  } finally { closeSync(fd); }
}
function json(data: Buffer): Wire { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))); }
function keys(value: Wire, expected: string): void {
  if (Object.keys(value).sort().join(",") !== expected.split(",").sort().join(",")) invalid();
}
function equal(left: unknown, right: unknown): void { if (JSON.stringify(left) !== JSON.stringify(right)) invalid(); }

/** Actual owned runtime MainPID selects authority. Neither env, requested job,
 * a callback nor a grant alone can authorize the fixed shared credential. */
export type HostedMimoCodingWorkerOrigin = Readonly<{
  homeRoot: string; digest: string; directory: string; jobId: string; startId: string; unit: string;
  codexBinaryPath: string; workspacePath: string; workspaceDevice: number; workspaceInode: number; model: string;
  taskTimeoutMs: number; maxGoalTurns: number;
}>;
const codingProofs = new WeakMap<HostedMimoCodingWorkerOrigin, () => void>();

export function readHostedMimoWorkerOrigin(): { readonly homeRoot: string; readonly digest: string; readonly directory: string } | null {
  return readOrigin(false);
}
/** Metadata only. This proof does not admit a provider root, network or tool policy. */
export function readHostedMimoCodingWorkerOrigin(): HostedMimoCodingWorkerOrigin | null {
  return readOrigin(true) as HostedMimoCodingWorkerOrigin | null;
}
/** Only an independently minted proof is accepted, never a reconstructed DTO. */
export function assertHostedMimoCodingWorkerOriginCurrent(proof: HostedMimoCodingWorkerOrigin): void {
  const check = codingProofs.get(proof);
  if (!check) invalid();
  check();
}
function readOrigin(allowCodingMetadata: boolean): { readonly homeRoot: string; readonly digest: string; readonly directory: string } | null {
  if (process.platform !== "linux") return null;
  const group = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").filter(row => row.startsWith("0::"));
  if (group.length !== 1) invalid();
  const match = /^0::\/system\.slice\/(subscription-runtime-research-([a-f0-9-]{36})\.service)$/.exec(group[0]!);
  if (!match) return null;
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) invalid();
  for (const map of ["uid_map", "gid_map"]) {
    if (!/^0\s+0\s+4294967295$/.test(readFileSync(`/proc/self/${map}`, "utf8").trim())) invalid();
  }
  const namespaces: Wire = {};
  for (const name of ["user", "mnt", "pid", "net"]) {
    const actual = readlinkSync(`/proc/self/ns/${name}`);
    if (name !== "mnt" && actual !== readlinkSync(`/proc/1/ns/${name}`)) invalid();
    namespaces[name] = actual;
  }
  for (const path of ["/var/lib/subscription-runtime-host-policy", "/run/user/0/subscription-runtime-host-policy"]) {
    try { lstatSync(path); invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const unit = match[1]!;
  const result = spawnSync("/usr/bin/systemctl", ["show", unit, "--no-pager",
    "--property=Id,MainPID,ControlGroup,InvocationID,Description,ActiveState,SubState,Transient,FragmentPath,DropInPaths,KillMode"],
  { encoding: "utf8", timeout: 30_000, maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  if (result.error || result.status !== 0) invalid();
  const service = Object.fromEntries(result.stdout.trim().split("\n").map(row => { const index = row.indexOf("="); return [row.slice(0, index), row.slice(index + 1)]; }));
  const owner = /^subscription-runtime-research:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(service.Description ?? "");
  if (!owner || service.Id !== unit || service.MainPID !== String(process.pid) || service.ControlGroup !== group[0]!.slice(3) ||
      service.ActiveState !== "active" || service.SubState !== "running" || service.Transient !== "yes" ||
      service.DropInPaths !== "" || service.KillMode !== "control-group" || service.FragmentPath !== `/run/systemd/transient/${unit}` ||
      !/^[a-f0-9]{32}$/.test(service.InvocationID ?? "")) invalid();
  const job = join(authority, owner[1]!), activeBytes = bytes(join(job, "active.json")), active = json(activeBytes);
  const directory = join(job, "starts", match[2]!);
  const specBytes = bytes(join(directory, "spec.json")), spec = json(specBytes), request = record(spec.request);
  const grantBytes = bytes(join(job, "grant.json")), grant = json(grantBytes), bindingBytes = bytes(join(directory, "binding.json")), binding = json(bindingBytes);
  keys(active, "schemaVersion,startId,specSha256");
  const registered = Object.hasOwn(spec, "registeredHandoff");
  keys(grant, "schemaVersion,profileId,hostedProfile,jobId,jobRootDir,workspacePath,grantId,jobDirectory,workspaceDirectory" + (registered ? ",registeredHandoff" : ""));
  keys(spec, "schemaVersion,startId,runtimeDirectory,artifactSha256,grantSha256,request,requestSha256,nodeSha256,codexSha256,unit,jobDirectory,workspaceDirectory" + (registered ? ",registeredHandoff" : ""));
  keys(binding, "schemaVersion,specSha256,process,service");
  const requestKeys = "schemaVersion,jobId,taskId,jobRootDir,workspacePath,promptPath,authRootDir,accounts,codexBinaryPath,model,reasoningEffort,serviceTier,taskTimeoutMs,modelBackend,maxAccountCycles,prewarmOnStart";
  keys(request, requestKeys + ["projectId", "appServerStartupTimeoutMs", "hostedProfile", "maxGoalTurns", ...(registered ? ["durableHandoffRootDir"] : [])].filter(key => Object.hasOwn(request, key)).map(key => "," + key).join(""));
  const coding = request.hostedProfile === HostedMimoProfile.CodingV1;
  if (Object.hasOwn(request, "hostedProfile") && !coding ||
      coding && (!Number.isSafeInteger(request.maxGoalTurns) || (request.maxGoalTurns as number) < 1 || (request.maxGoalTurns as number) > 256) ||
      !coding && Object.hasOwn(request, "maxGoalTurns")) invalid();
  if (grant.hostedProfile !== (coding ? HostedMimoProfile.CodingV1 : HostedMimoProfile.Worker)) invalid();
  // An operator-selected frozen profile alone must never authorize reading the
  // shared key or exposing native tools. A separately verified root/proxy
  // binding across the provider process boundary is not installed yet.
  if (coding && !allowCodingMetadata) throw new Error("hosted_mimo_coding_activation_closed");
  if (active.schemaVersion !== 1 || active.startId !== match[2] || active.specSha256 !== owner[2] || hash(specBytes) !== owner[2] ||
      spec.schemaVersion !== 1 || spec.startId !== match[2] || spec.unit !== unit ||
      spec.runtimeDirectory !== fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "") ||
      typeof request.jobId !== "string" || hash(request.jobId) !== owner[1] || spec.grantSha256 !== hash(grantBytes) ||
      grant.schemaVersion !== 1 || grant.profileId !== CodexProviderEgressProfileId.MimoTokenPlan || grant.hostedProfile !== (coding ? HostedMimoProfile.CodingV1 : HostedMimoProfile.Worker) ||
      request.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || request.model !== codexMimoDefaultModel ||
      request.maxAccountCycles !== 1 || request.prewarmOnStart !== false || JSON.stringify(request.accounts) !== '["account-q"]' ||
      !Number.isSafeInteger(request.taskTimeoutMs) || (request.taskTimeoutMs as number) < 1000 || (request.taskTimeoutMs as number) > 86400000 ||
      binding.schemaVersion !== 1 || binding.specSha256 !== owner[2]) invalid();
  for (const key of ["jobId", "jobRootDir", "workspacePath"]) equal(grant[key], request[key]);
  for (const key of ["jobDirectory", "workspaceDirectory"]) equal(grant[key], spec[key]);
  const homeRoot = join(String(request.jobRootDir), "home");
  if (!/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(homeRoot) || homeRoot.split("/").some(part => part === "." || part === "..")) invalid();
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  if (fields[0] === "Z" || !/^[1-9][0-9]*$/.test(fields[19] ?? "")) invalid();
  equal(binding.process, { pid: process.pid, birthTicks: fields[19], bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    machineId: readFileSync("/etc/machine-id", "utf8").trim(), controlGroup: group[0]!.slice(3), namespaces });
  equal(binding.service, { unit, mainPid: process.pid, controlGroup: service.ControlGroup, invocationId: service.InvocationID,
    description: service.Description, fragmentSha256: hash(bytes(service.FragmentPath!, false)) });
  assertRegisteredOrigin(spec, grant, request, directory);
  assertHostedMimoWorkerMaterial(spec, directory);
  try { lstatSync(join(directory, "closing.json")); invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!bytes(join(job, "active.json")).equals(activeBytes) || !bytes(join(job, "grant.json")).equals(grantBytes) ||
      !bytes(join(directory, "binding.json")).equals(bindingBytes) || !bytes(join(directory, "spec.json")).equals(specBytes)) invalid();
  if (!coding) return allowCodingMetadata ? null : { homeRoot, digest: owner[2]!, directory };
  const workspace = record(spec.workspaceDirectory);
  keys(workspace, "path,device,inode");
  if (workspace.path !== request.workspacePath || !Number.isSafeInteger(workspace.device) || (workspace.device as number) < 0 ||
      !Number.isSafeInteger(workspace.inode) || (workspace.inode as number) < 1) invalid();
  const proof: HostedMimoCodingWorkerOrigin = Object.freeze({ homeRoot, digest: owner[2]!, directory,
    jobId: String(request.jobId), startId: match[2]!, unit, codexBinaryPath: absolutePath(request.codexBinaryPath), workspacePath: absolutePath(request.workspacePath),
    workspaceDevice: workspace.device as number, workspaceInode: workspace.inode as number,
    model: String(request.model), taskTimeoutMs: request.taskTimeoutMs as number, maxGoalTurns: request.maxGoalTurns as number });
  const deadline = performance.now() + proof.taskTimeoutMs;
  const check = (): void => {
    if (performance.now() >= deadline || process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) invalid();
    const assertRetained = (): void => {
      if (performance.now() >= deadline || !bytes(join(job, "active.json")).equals(activeBytes) || !bytes(join(job, "grant.json")).equals(grantBytes) ||
          !bytes(join(directory, "binding.json")).equals(bindingBytes) || !bytes(join(directory, "spec.json")).equals(specBytes)) invalid();
      try { lstatSync(join(directory, "closing.json")); invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    assertRetained();
    if (readFileSync("/proc/self/cgroup", "utf8").trim() !== group[0] ||
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== record(binding.process).bootId ||
        readFileSync("/etc/machine-id", "utf8").trim() !== record(binding.process).machineId) invalid();
    const freshStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const freshFields = freshStat.slice(freshStat.lastIndexOf(")") + 2).split(/\s+/);
    if (freshFields[0] === "Z" || freshFields[19] !== fields[19]) invalid();
    for (const name of ["user", "mnt", "pid", "net"]) if (readlinkSync(`/proc/self/ns/${name}`) !== namespaces[name]) invalid();
    for (const map of ["uid_map", "gid_map"]) if (!/^0\s+0\s+4294967295$/.test(readFileSync(`/proc/self/${map}`, "utf8").trim())) invalid();
    for (const path of [proof.workspacePath, join(directory, "pins/workspace")]) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) ||
          info.dev !== proof.workspaceDevice || info.ino !== proof.workspaceInode) invalid();
    }
    assertRegisteredOrigin(spec, grant, request, directory);
    assertRetained();
  };
  codingProofs.set(proof, check); check();
  return proof;
}


function absolutePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) ||
      value.split("/").some(part => part === "." || part === "..")) invalid();
  return value;
}
/** Registered authority is sealed by the owned spec and the matching grant;
 * neither a request-selected durable sink nor a caller callback grants access. */
function assertRegisteredOrigin(spec: Wire, grant: Wire, request: Wire, directory: string): void {
  if (!Object.hasOwn(spec, "registeredHandoff")) {
    if (Object.hasOwn(grant, "registeredHandoff") || Object.hasOwn(request, "durableHandoffRootDir")) invalid();
    return;
  }
  const handoff = record(spec.registeredHandoff);
  equal(grant.registeredHandoff, handoff);
  keys(handoff, "registryRootDir,controllerJobId,manifestSha256,scopeSha256,receiptSha256,requestSha256,durableDirectory,registeredExecution");
  const registry = absolutePath(handoff.registryRootDir);
  if (typeof handoff.controllerJobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(handoff.controllerJobId)) invalid();
  for (const field of ["manifestSha256", "scopeSha256", "receiptSha256", "requestSha256"]) {
    if (typeof handoff[field] !== "string" || !/^[a-f0-9]{64}$/.test(handoff[field] as string)) invalid();
  }
  const execution = record(handoff.registeredExecution);
  keys(execution, "sourceConfigSha256,reservedConfigSha256,selectedAccountSha256,accountId,projectId,maxAccountCycles,prewarmOnStart,appServerStartupTimeoutMs");
  for (const field of ["sourceConfigSha256", "reservedConfigSha256", "selectedAccountSha256"]) {
    if (typeof execution[field] !== "string" || !/^[a-f0-9]{64}$/.test(execution[field] as string)) invalid();
  }
  if (execution.accountId !== "account-q" || typeof execution.projectId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(execution.projectId) ||
      execution.maxAccountCycles !== 1 || execution.prewarmOnStart !== false ||
      !Number.isSafeInteger(execution.appServerStartupTimeoutMs) ||
      (execution.appServerStartupTimeoutMs as number) < 1 || (execution.appServerStartupTimeoutMs as number) > 86400000) invalid();
  for (const field of ["projectId", "maxAccountCycles", "prewarmOnStart", "appServerStartupTimeoutMs"]) equal(request[field], execution[field]);
  equal(request.accounts, [execution.accountId]);
  // Reconstruct the contract parser's stable field order before hashing. The
  // normalization itself is independent of worker-layer imports.
  const normalized: Wire = {};
  for (const field of ["schemaVersion", "jobId", "taskId", "jobRootDir", "workspacePath", "promptPath", "authRootDir",
    "durableHandoffRootDir", "hostedProfile", "maxGoalTurns", "modelBackend", "accounts", "codexBinaryPath", "model", "reasoningEffort", "serviceTier", "taskTimeoutMs"]) {
    if (Object.hasOwn(request, field)) normalized[field] = request[field];
  }
  Object.assign(normalized, { projectId: request.projectId ?? request.jobId, maxAccountCycles: request.maxAccountCycles ?? 5,
    prewarmOnStart: request.prewarmOnStart ?? true, appServerStartupTimeoutMs: request.appServerStartupTimeoutMs });
  if (hash(JSON.stringify(normalized)) !== handoff.requestSha256) invalid();
  const identity = record(handoff.durableDirectory);
  keys(identity, "path,device,inode,mountId,mountDevice,mountRoot,mountPoint,filesystemUuid");
  if (identity.path !== join(registry, "durable-handoffs") || request.durableHandoffRootDir !== identity.path ||
      !Number.isSafeInteger(identity.device) || (identity.device as number) < 0 ||
      !Number.isSafeInteger(identity.inode) || (identity.inode as number) < 1 ||
      !Number.isSafeInteger(identity.mountId) || (identity.mountId as number) < 1 ||
      typeof identity.mountDevice !== "string" || !/^\d+:\d+$/.test(identity.mountDevice) ||
      typeof identity.filesystemUuid !== "string" || !/^[a-fA-F0-9-]{8,128}$/.test(identity.filesystemUuid)) invalid();
  for (const field of ["mountRoot", "mountPoint"]) if (identity[field] !== "/") absolutePath(identity[field]);
  const point = String(identity.mountPoint);
  if (point !== "/" && identity.path !== point && !(identity.path as string).startsWith(point + "/")) invalid();
  for (const path of [String(identity.path), join(directory, "pins", "durable-handoff")]) {
    for (let current = path;; current = dirname(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) ||
          (current === path && ((stat.mode & 0o777) !== 0o700 || stat.dev !== identity.device || stat.ino !== identity.inode))) invalid();
      if (current === "/") break;
    }
  }
}

/** Storage transfer requires independently authenticated owner receipt. */
export function assertHostedMimoWorkerHomeRetained(path: string): void {
  const origin = readHostedMimoWorkerOrigin();
  if (!origin || !/^mimo-[A-Za-z0-9]+\/codex-home$/.test(path.slice(origin.homeRoot.length + 1)) ||
      !path.startsWith(origin.homeRoot + "/")) invalid();
  const receipt = json(bytes(join(origin.directory, "mimo-home.json")));
  keys(receipt, "schemaVersion,specSha256,identity");
  const identity = record(receipt.identity); keys(identity, "path,device,inode");
  const stat = lstatSync(path);
  if (receipt.schemaVersion !== 1 || receipt.specSha256 !== origin.digest || identity.path !== path ||
      !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) ||
      identity.device !== stat.dev || identity.inode !== stat.ino) invalid();
}
