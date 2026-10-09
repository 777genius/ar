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
export function readHostedMimoWorkerOrigin(): { readonly homeRoot: string; readonly digest: string; readonly directory: string } | null {
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
  keys(grant, "schemaVersion,profileId,hostedProfile,jobId,jobRootDir,workspacePath,grantId,jobDirectory,workspaceDirectory");
  keys(spec, "schemaVersion,startId,runtimeDirectory,artifactSha256,grantSha256,request,requestSha256,nodeSha256,codexSha256,unit,jobDirectory,workspaceDirectory");
  keys(binding, "schemaVersion,specSha256,process,service");
  const requestKeys = "schemaVersion,jobId,taskId,jobRootDir,workspacePath,promptPath,authRootDir,accounts,codexBinaryPath,model,reasoningEffort,serviceTier,taskTimeoutMs,modelBackend,maxAccountCycles,prewarmOnStart";
  keys(request, requestKeys + ["projectId", "appServerStartupTimeoutMs"].filter(key => Object.hasOwn(request, key)).map(key => "," + key).join(""));
  if (active.schemaVersion !== 1 || active.startId !== match[2] || active.specSha256 !== owner[2] || hash(specBytes) !== owner[2] ||
      spec.schemaVersion !== 1 || spec.startId !== match[2] || spec.unit !== unit ||
      spec.runtimeDirectory !== fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "") ||
      typeof request.jobId !== "string" || hash(request.jobId) !== owner[1] || spec.grantSha256 !== hash(grantBytes) ||
      grant.schemaVersion !== 1 || grant.profileId !== CodexProviderEgressProfileId.MimoTokenPlan || grant.hostedProfile !== HostedMimoProfile.Worker ||
      grant.registeredHandoff !== undefined || spec.registeredHandoff !== undefined ||
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
  assertHostedMimoWorkerMaterial(spec, directory);
  try { lstatSync(join(directory, "closing.json")); invalid(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!bytes(join(job, "active.json")).equals(activeBytes) || !bytes(join(job, "grant.json")).equals(grantBytes) ||
      !bytes(join(directory, "binding.json")).equals(bindingBytes) || !bytes(join(directory, "spec.json")).equals(specBytes)) invalid();
  return { homeRoot, digest: owner[2]!, directory };
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
