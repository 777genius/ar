import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, statSync } from "node:fs";
import type { HostedInventorySupervisor } from "../core/host-infrastructure/host-inventory";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { collectProcessBirth, collectUnitShow } from "./hosted-readonly-linux-collector";

const root = "/var/lib/subscription-runtime-host-policy/ordinary-qualification";
const guestEntry = "/dist/worker-codex/hosted-ordinary-installation-usable-guest.js";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function held(): never { throw new Error("hosted_ordinary_owned_unresolved"); }
function bytes(path: string): Buffer { const value=readHostedPrivateBytes(path,65536);if(!value)held();return value; }
function record(value: unknown, keys: string): Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.split(",").sort().join(","))held();return value as Record<string,unknown>;
}
/** Read-only data join, not an operation/reservation issuer. The genuine Store
 * reservation and original returned-child maps remain mandatory at the caller. */
export function readOriginalUsableGuestFunding(supervisor: HostedInventorySupervisor): Buffer {
  if(!supervisor.bootstrap.path.endsWith(guestEntry))held();
  const fundedBytes=bytes(root+"/funded-operation.json"),funded=JSON.parse(fundedBytes.toString("utf8"));
  const inputBytes=bytes(root+"/usable-input.json"),input=record(JSON.parse(inputBytes.toString("utf8")),"schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure,creator,tools");
  const operation=record(input.operation,"operationId,workEndEpochMs,cleanupEndEpochMs"),fixture=record(input.fixture,"testId,guestMachineId,guestHostname,guestEntrySha256");
  const candidate=record(input.candidate,"candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256");
  const ready=record(JSON.parse(bytes(root+"/usable-ready.json").toString("utf8")),"schemaVersion,operationSha256,guestInputSha256,unit,invocationId,namespaces,bootId");
  if(input.schemaVersion!==1||funded.schemaVersion!==2||funded.operationId!==supervisor.operationId||operation.operationId!==supervisor.operationId||
      funded.workEndEpochMs!==supervisor.workEndEpochMs||operation.workEndEpochMs!==supervisor.workEndEpochMs||
      funded.cleanupEndEpochMs!==supervisor.cleanupEndEpochMs||operation.cleanupEndEpochMs!==supervisor.cleanupEndEpochMs||
      funded.node?.path!==supervisor.executable.path||funded.node?.sha256!==supervisor.executable.sha256||
      candidate.candidateArtifactPath!==funded.runtimeDirectory||candidate.runtimeSha!==funded.runtimeSha||candidate.runtimeManifestSha256!==funded.runtimeManifestSha256||
      supervisor.bootstrap.path!==String(candidate.candidateArtifactPath)+guestEntry||fixture.guestEntrySha256!==supervisor.bootstrap.sha256||
      hash(bytes(supervisor.bootstrap.path))!==supervisor.bootstrap.sha256||
      readFileSync("/etc/machine-id","utf8").trim()!==fixture.guestMachineId||readFileSync("/etc/hostname","utf8").trim()!==fixture.guestHostname||
      ready.schemaVersion!==1||ready.operationSha256!==hash(fundedBytes)||ready.guestInputSha256!==hash(inputBytes)||
      ready.unit!=="subscription-runtime-ordinary-"+fixture.testId+".service"||ready.bootId!==readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()||typeof ready.invocationId!=="string"||!/^[a-f0-9]{32}$/.test(ready.invocationId)||
      !Array.isArray(ready.namespaces)||ready.namespaces.length!==4)held();
  for(const name of ["user","mnt","pid","net"]){
    const rows=ready.namespaces.filter((row:Record<string,unknown>)=>row.name===name);if(rows.length!==1)held();
    const row=record(rows[0],"name,dev,ino"),own=statSync(`/proc/self/ns/${name}`),initial=statSync(`/proc/1/ns/${name}`);
    if(own.dev!==initial.dev||own.ino!==initial.ino||own.dev!==row.dev||own.ino!==row.ino)held();
  }
  const pid=supervisor.birth.split(":")[0];if(!pid||!/^[1-9][0-9]*$/.test(pid)||collectProcessBirth(pid)!==supervisor.birth)held();
  const argv=Buffer.from([supervisor.executable.path,supervisor.bootstrap.path,"worker"].join("\0")+"\0");
  const unit=collectUnitShow("subscription-runtime-hosted-"+input.workerId+".service");
  if(unit.MainPID!==pid||readlinkSync(`/proc/${pid}/exe`)!==supervisor.executable.path||!readFileSync(`/proc/${pid}/cmdline`).equals(argv))held();
  if(!bytes(root+"/funded-operation.json").equals(fundedBytes)||!bytes(root+"/usable-input.json").equals(inputBytes))held();
  return fundedBytes;
}
