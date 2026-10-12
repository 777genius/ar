import { trustedMimoProjectOperationLaunch } from "./trusted-custody-systemd-launch";
import { existsSync, mkdirSync, writeFileSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { researchCustody, researchHash, researchRecord } from "./research-launch-files";
import { parseMimoProjectBridgeRequest, MimoProjectBridgeOperation, type MimoProjectBridgeRequest } from "./hosted-mimo-project-bridge-contract";
import { handleHostedMimoProjectBridge, hostedMimoBridgeMetadataBytes, parseHostedMimoProjectBinding } from "./hosted-mimo-project-bridge";
import { withHostedMimoWorkstreamActivity } from "./hosted-mimo-project-workstream-fence";
import { readdirSync } from "node:fs";

const fixedEntry = "/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js";
function canonical(request: MimoProjectBridgeRequest): string {
  return JSON.stringify(Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))));
}
function operationFiles(request: MimoProjectBridgeRequest) {
  const root = `/srv/worker-state/mimo-projects/${request.projectId}/${request.workstreamId}/mimo-bridge-operations`;
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
      (![MimoProjectBridgeOperation.Status, MimoProjectBridgeOperation.Stop].includes(retained.operation) && value.generation !== 0)) throw new Error("mimo_project_bridge_operation_invalid");
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
  return { state: "settled", unit: current.value.unit, result, terminalVerified: state.LoadState === "loaded" &&
    ["inactive", "failed"].includes(state.ActiveState ?? "") && state.MainPID === "0" };
}
/** Status may reconcile an existing publication, but never submits a provider.
 * Recover only after the exact prior observer cannot execute any further work. */
function recoverableStatus(request: MimoProjectBridgeRequest, mode?: "controller-recovery"): boolean {
  const current = owner(request), unit = current.value.unit as string;
  const output = researchCommand("/usr/bin/systemctl", ["show", unit, "--property=Id,Description,LoadState,ActiveState,MainPID,ControlGroup"]);
  const fields = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.Id !== unit || (fields.LoadState !== "not-found" && fields.Description !== current.value.description))
    throw new Error("mimo_project_bridge_operation_invalid");
  if (mode === "controller-recovery" && (fields.MainPID !== "0" || (fields.ControlGroup ?? "") !== "")) return false;
  if (!(fields.LoadState === "not-found" || fields.LoadState === "loaded" &&
      ["inactive", "failed"].includes(fields.ActiveState ?? "") && fields.MainPID === "0")) return false;
  const jobs = researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]);
  return !jobs.trim().split("\n").some(line => line.trim().split(/\s+/)[1] === unit);
}
export async function submitHostedMimoProjectBridge(value: unknown): Promise<unknown> {
  const request = parseMimoProjectBridgeRequest(value);
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== request.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  researchCustody(binding.stateRoot, true);
  return withHostedMimoWorkstreamActivity(binding.stateRoot, () => submitHostedMimoProjectBridgeUnfenced(value));
}
async function submitHostedMimoProjectBridgeUnfenced(value: unknown): Promise<unknown> {
  const request = parseMimoProjectBridgeRequest(value);
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  if (hostedMimoBridgeMetadataBytes("/etc/machine-id").toString().trim() !== request.machineId) throw new Error("mimo_project_bridge_machine_mismatch");
  let previousStatus: unknown;
  let generation = 0;
  const retainedFiles = operationFiles(request);
  // Real submissions must retain the exact request. Synthetic observations
  // intentionally lack Create payload fields and only verify job identity.
  if (request.operation !== MimoProjectBridgeOperation.Status && existsSync(retainedFiles.ownerPath) &&
      owner(request).value.requestSha256 !== researchHash(canonical(request)))
    throw new Error("mimo_project_bridge_request_mismatch");
  if (request.operation === MimoProjectBridgeOperation.Stop) {
    for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start])
      if (observation({ ...request, operation }).state === "running") throw new Error("mimo_project_bridge_control_pending");
    const prior = observation(request);
    // Only a verified terminal unit plus a durable settled result permits a
    // fresh explicit stop. An uncertain/collected unit keeps its exact owner.
    if (prior.state === "settled" && prior.terminalVerified === true) {
      const old = owner(request); generation = (old.value.generation as number) + 1;
      for (const path of [old.requestPath, old.resultPath, old.ownerPath]) renameSync(path, path + ".generation-" + old.value.generation);
    }
  }
  if (request.operation === MimoProjectBridgeOperation.Status) {
    const operations: Record<string, unknown> = {};
    for (const operation of [MimoProjectBridgeOperation.Create, MimoProjectBridgeOperation.Start, MimoProjectBridgeOperation.Stop])
      operations[operation] = observation({ ...request, operation });
    // Status/finalization is a semantic mutation too; never run it under the
    // ingress timeout. The same owned status service is scheduled below when
    // no provider-control operation is still executing.
    if (Object.values(operations).some(row => (row as { state: string }).state === "running")) return { ok: true, jobId: request.jobId, operations };
    const prior = observation(request);
    if (prior.state === "settled" || prior.state === "unresolved" && recoverableStatus(request)) {
      previousStatus = { operations, worker: prior.state === "settled" ? prior.result : prior };
      const old = owner(request); generation = (old.value.generation as number) + 1;
      const evidence = [old.requestPath, old.resultPath, old.resultPath + ".tmp", old.ownerPath]
        .filter(path => path === old.requestPath || path === old.ownerPath || existsSync(path));
      if (evidence.some(path => existsSync(path + ".generation-" + old.value.generation)))
        throw new Error("mimo_project_bridge_operation_invalid");
      for (const path of evidence) renameSync(path, path + ".generation-" + old.value.generation);
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
  const launch = trustedMimoProjectOperationLaunch({ request, requestSha256: digest, generation, unit, description,
    requestPath: files.requestPath, entry: executable, node, operationTimeoutMs: binding.operationTimeoutMs });
  writeFileSync(files.requestPath, bytes + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(files.ownerPath, JSON.stringify({ schemaVersion: 1, requestSha256: digest, generation, unit, description, entry: executable, node }) + "\n", { flag: "wx", mode: 0o600 });
  // The persisted exact owner precedes submission. A timeout never replaces it.
  researchCommand(launch.command, launch.args);
  return { ok: true, mode: "mimo_project_bridge_operation_started", operation: request.operation, unit, pending: true, jobId: request.jobId, ...(previousStatus ? previousStatus as object : {}) };
}
/** Only the installed owned service invokes this fixed execution mode. */
export async function executeHostedMimoProjectBridgeOperation(requestPath: string): Promise<boolean> {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const request = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(requestPath).toString()));
  const binding = parseHostedMimoProjectBinding(JSON.parse(hostedMimoBridgeMetadataBytes(
    `/etc/subscription-runtime/mimo-projects/${request.projectId}/${request.workstreamId}.json`).toString()), request);
  researchCustody(binding.stateRoot, true);
  return withHostedMimoWorkstreamActivity(binding.stateRoot, () => executeHostedMimoProjectBridgeOperationUnfenced(requestPath));
}
async function executeHostedMimoProjectBridgeOperationUnfenced(requestPath: string): Promise<boolean> {
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
  const outcome = result as { ok: boolean; result?: { ok?: boolean } };
  return outcome.ok && outcome.result?.ok !== false;
}

/** Recovery consumes the same exact owner/digest observer as normal ingress.
 * Collected units require a durable failure and no queued unit job. */
export async function assertHostedMimoRecoveryOperationsSettled(binding: { stateRoot: string; projectId: string; workstreamId: string; machineId: string }): Promise<void> {
  const root = join(binding.stateRoot, "mimo-bridge-operations");
  if (!existsSync(root)) { researchCustody(binding.stateRoot); return; }
  researchCustody(root, true);
  const names = readdirSync(root);
  for (const name of names) {
    if (/\.generation-\d+$/.test(name)) continue;
    if (name.endsWith(".request.json") || name.endsWith(".result.json")) {
      if (!names.includes(name.replace(/\.(?:request|result)\.json$/, ".owner.json"))) throw new Error("mimo_project_bridge_recovery_denied");
    } else if (!name.endsWith(".owner.json")) throw new Error("mimo_project_bridge_recovery_denied");
  }
  for (const name of readdirSync(root).filter(name => name.endsWith(".owner.json"))) {
    const requestPath = join(root, name.replace(/\.owner\.json$/, ".request.json"));
    const request = parseMimoProjectBridgeRequest(JSON.parse(hostedMimoBridgeMetadataBytes(requestPath).toString()));
    if (request.projectId !== binding.projectId || request.workstreamId !== binding.workstreamId || request.machineId !== binding.machineId)
      throw new Error("mimo_project_bridge_recovery_denied");
    const current = owner(request), observed = observation(request);
    const result = observed.result as { ok?: boolean; result?: { ok?: boolean } } | undefined;
    if (current.ownerPath !== join(root, name) || observed.state !== "settled" || !recoverableStatus(request, "controller-recovery") ||
        (request.operation !== MimoProjectBridgeOperation.Status && result?.ok !== false && result?.result?.ok !== false))
      throw new Error("mimo_project_bridge_recovery_denied");
  }
}
