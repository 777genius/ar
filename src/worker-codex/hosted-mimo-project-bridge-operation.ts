import { existsSync, mkdirSync, writeFileSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { researchCustody, researchHash, researchRecord } from "./research-launch-files";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { handleHostedMimoProjectBridge, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";

const fixedEntry = "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js";
function canonical(request: MimoProjectBridgeRequest): string {
  return JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))));
}
function operationFiles(request: MimoProjectBridgeRequest) {
  const root = `/srv/worker-state/jobs/${request.projectId}/${request.workstreamId}/mimo-bridge-operations`;
  const name = `${request.jobId}.${request.operation}`;
  return { root, requestPath: join(root, name + ".request.json"), resultPath: join(root, name + ".result.json"), ownerPath: join(root, name + ".owner.json") };
}
function entry() {
  const path = realpathSync(fixedEntry);
  researchCustody(dirname(path));
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0) throw new Error("mimo_project_bridge_runtime_invalid");
  return path;
}
function owner(request: MimoProjectBridgeRequest) {
  const files = operationFiles(request), value = researchRecord(JSON.parse(hostedMimoBridgeMetadataBytes(files.ownerPath).toString()),
    "schemaVersion,requestSha256,generation,unit,description,entry,node");
  const bytes = hostedMimoBridgeMetadataBytes(files.requestPath), retained = parseMimoProjectBridgeRequest(JSON.parse(bytes.toString()));
  const digest = researchHash(canonical(retained));
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0 ||
      (retained.operation !== MimoProjectBridgeOperation.Status && value.generation !== 0)) throw new Error("mimo_project_bridge_operation_invalid");
  const unitDigest = researchHash(digest + ":" + value.generation), unit = `subscription-runtime-mimo-project-${unitDigest}.service`;
  if (value.schemaVersion !== 1 || value.requestSha256 !== digest || value.unit !== unit || value.description !== `subscription-runtime MiMo project ${unitDigest}` ||
      retained.machineId !== request.machineId || retained.projectId !== request.projectId || retained.workstreamId !== request.workstreamId ||
      retained.jobId !== request.jobId || retained.operation !== request.operation) throw new Error("mimo_project_bridge_operation_invalid");
  return { ...files, value, retained };
}
function observation(request: MimoProjectBridgeRequest): Record<string, unknown> {
  const files = operationFiles(request);
  if (!existsSync(files.ownerPath)) return { state: "absent" };
  const current = owner(request);
  const output = researchCommand("/usr/bin/systemctl", ["show", current.value.unit as string, "--property=Id,Description,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus,ControlGroup"]);
  const state = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (state.LoadState !== "not-found" && (state.Id !== current.value.unit || state.Description !== current.value.description))
    throw new Error("mimo_project_bridge_operation_invalid");
  const running = ["active", "activating", "deactivating", "reloading"].includes(state.ActiveState ?? "");
  if (running) return { state: "running", unit: current.value.unit };
  if (!existsSync(current.resultPath)) return { state: "unresolved", unit: current.value.unit };
  const result = JSON.parse(hostedMimoBridgeMetadataBytes(current.resultPath, 1048576).toString()) as { ok?: unknown; result?: unknown; error?: unknown };
  if (typeof result.ok !== "boolean") throw new Error("mimo_project_bridge_operation_invalid");
  return { state: "settled", unit: current.value.unit, result };
}
export async function submitHostedMimoProjectBridge(value: unknown): Promise<unknown> {
  const request = parseMimoProjectBridgeRequest(value);
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== request.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  let previousStatus: unknown;
  let generation = 0;
  if (request.operation === MimoProjectBridgeOperation.Status) {
    const operations: Record<string, unknown> = {};
    for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Stop])
      operations[operation] = observation({ ...request, operation });
    // Status/finalization is a semantic mutation too; never run it under the
    // ingress timeout. The same owned status service is scheduled below when
    // no provider-control operation is still executing.
    if (Object.values(operations).some(row => (row as { state: string }).state === "running")) return { ok: true, jobId: request.jobId, operations };
    const prior = observation(request);
    if (prior.state === "settled") {
      previousStatus = { operations, worker: prior.result };
      const old = owner(request); generation = (old.value.generation as number) + 1;
      for (const path of [old.requestPath, old.resultPath, old.ownerPath]) renameSync(path, path + ".generation-" + old.value.generation);
    } else if (prior.state !== "absent") return { ok: true, jobId: request.jobId, operations, worker: prior };
  }
  if (request.operation === MimoProjectBridgeOperation.Start) {
    const created = observation({ ...request, operation: MimoProjectBridgeOperation.Create });
    if (created.state !== "settled" || (created.result as { ok?: boolean; result?: { ok?: boolean } })?.ok !== true ||
        (created.result as { result?: { ok?: boolean } })?.result?.ok !== true)
      throw new Error("mimo_project_bridge_creation_pending");
  }
  const files = operationFiles(request);
  researchCustody(dirname(files.root));
  if (!existsSync(files.root)) mkdirSync(files.root, { mode: 0o700 });
  researchCustody(files.root);
  if (existsSync(files.ownerPath)) return { ok: true, jobId: request.jobId, operation: request.operation, ...observation(request) };
  const bytes = canonical(request), digest = researchHash(bytes), unitDigest = researchHash(digest + ":" + generation), unit = `subscription-runtime-mimo-project-${unitDigest}.service`;
  const description = `subscription-runtime MiMo project ${unitDigest}`, executable = entry(), node = realpathSync(process.execPath);
  researchCustody(dirname(node));
  writeFileSync(files.requestPath, bytes + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(files.ownerPath, JSON.stringify({ schemaVersion: 1, requestSha256: digest, generation, unit, description, entry: executable, node }) + "\n", { flag: "wx", mode: 0o600 });
  // The persisted exact owner precedes submission. A timeout never replaces it.
  researchCommand("/usr/bin/systemd-run", ["--quiet", "--collect", "--unit=" + unit, "--description=" + description,
    "--property=Type=exec", "--property=KillMode=control-group", "--property=RuntimeMaxSec=" + Math.ceil(binding.operationTimeoutMs / 1000),
    "--property=TimeoutStopSec=30", "--property=WorkingDirectory=/", "--property=UMask=0077", "--property=NoNewPrivileges=yes",
    "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/root", "USER=root", "LOGNAME=root", node, executable, "--execute-owned", files.requestPath]);
  return { ok: true, mode: "mimo_project_bridge_operation_started", operation: request.operation, unit, pending: true, jobId: request.jobId, ...(previousStatus ? previousStatus as object : {}) };
}
/** Only the installed owned service invokes this fixed execution mode. */
export async function executeHostedMimoProjectBridgeOperation(requestPath: string): Promise<void> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const request = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(requestPath).toString())), current = owner(request);
  if (current.requestPath !== requestPath || current.value.entry !== realpathSync(process.argv[1]!) || current.value.node !== realpathSync(process.execPath))
    throw new Error("mimo_project_bridge_operation_invalid");
  const service = researchCommand("/usr/bin/systemctl", ["show", current.value.unit as string, "--property=MainPID,Description"]);
  if (!service.split("\n").includes("MainPID=" + process.pid) || !service.split("\n").includes("Description=" + current.value.description))
    throw new Error("mimo_project_bridge_operation_invalid");
  let result: unknown;
  try { result = { ok: true, result: await handleHostedMimoProjectBridge(request) }; }
  catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0]! : "";
    result = { ok: false, error: /^(?:mimo_project_bridge_|project_control_|hosted_research_|codex_goal_|owned_mimo_)[a-z0-9_]{1,100}$/.test(code)
      ? code : "mimo_project_bridge_operation_failed" };
  }
  const serialized = JSON.stringify(result) + "\n";
  if (Buffer.byteLength(serialized) > 1048576) throw new Error("mimo_project_bridge_response_invalid");
  const temp = current.resultPath + ".tmp";
  writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 }); renameSync(temp, current.resultPath);
}
