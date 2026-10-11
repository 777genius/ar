import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseResearchOperatorRequestEnvelope, ResearchOperatorOperation, ResearchOperatorState, type ResearchOperatorRequest } from "../core/research-operator-request";
import { researchHash, researchJson, researchPrivateDirectory, researchPublish, researchRead, researchRecord, researchCustody } from "./research-launch-files";
import { assertResearchInitialRoot, assertResearchSharedHost, researchCommand } from "./research-launch-host";
import { startEnrolledResearchLaunch, revokeEnrolledResearchLaunch } from "./research-launch-owner";
import { statusResearchLaunch, cancelEnrolledResearchLaunch } from "./research-launch-lifecycle";
import { readResearchOperatorBinding, researchOperatorDirectory } from "./research-operator-binding";
import { trustedResearchOperatorLaunch } from "./trusted-custody-systemd-launch";
const ownerPath = (jobId: string) => join(researchOperatorDirectory(jobId), "operator-start.json");
const resultPath = (jobId: string) => join(researchOperatorDirectory(jobId), "operator-start-result.json");
function retained(jobId: string) {
  const bytes = researchRead(ownerPath(jobId));
  const owner = researchRecord(researchJson(bytes), "schemaVersion,request");
  if (owner.schemaVersion !== 1) throw new Error("research_operator_owner_invalid");
  const request = parseResearchOperatorRequestEnvelope(owner.request);
  if (request.jobId !== jobId || request.operation !== ResearchOperatorOperation.Start) throw new Error("research_operator_owner_invalid");
  return { request, sha256: researchHash(bytes) };
}
function observation(request: ResearchOperatorRequest) {
  if (!existsSync(ownerPath(request.jobId))) return { state: ResearchOperatorState.NotSubmitted };
  const owner = retained(request.jobId);
  if (owner.request.bindingSha256 !== request.bindingSha256 || owner.request.projectId !== request.projectId || owner.request.machineId !== request.machineId)
    throw new Error("research_operator_owner_invalid");
  const { binding } = readResearchOperatorBinding(owner.request);
  const plan = trustedResearchOperatorLaunch(binding, owner.sha256);
  const output = researchCommand("/usr/bin/systemctl", ["show", plan.unit, "--property=Id,Description,LoadState,ActiveState,SubState,MainPID,ControlGroup"]);
  const fields = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (fields.LoadState !== "not-found" && (fields.Id !== plan.unit || fields.Description !== plan.description)) throw new Error("research_operator_owner_invalid");
  const result = existsSync(resultPath(request.jobId)) ? researchJson(researchRead(resultPath(request.jobId))) : undefined;
  return { state: result ? ResearchOperatorState.Settled : ResearchOperatorState.Unresolved, unit: plan.unit, activeState: fields.ActiveState, ...(result ? { result } : {}) };
}
/** One permanent submission record per enrolled job. Any ambiguous first start
 * remains owned; even a disappeared operation unit never authorizes replay. */
export function submitResearchOperator(value: unknown) {
  const request = parseResearchOperatorRequestEnvelope(value);
  const { binding } = readResearchOperatorBinding(request);
  if (request.operation === ResearchOperatorOperation.Start) {
    if (existsSync(ownerPath(request.jobId))) return observation(request);
    readResearchOperatorBinding(request, true);
    researchPrivateDirectory(researchOperatorDirectory(request.jobId));
    // Exclusive root-private owner is published before the service effect.
    researchPublish(ownerPath(request.jobId), { schemaVersion: 1, request }, true);
    const owner = retained(request.jobId), plan = trustedResearchOperatorLaunch(binding, owner.sha256);
    researchCommand(plan.command, plan.args);
    return { state: ResearchOperatorState.Submitted, unit: plan.unit, jobId: request.jobId };
  }
  if (request.operation === ResearchOperatorOperation.Revoke) {
    revokeEnrolledResearchLaunch(request.jobId, binding.grantSha256); return { state: ResearchOperatorState.Revoked, jobId: request.jobId };
  }
  if (request.operation === ResearchOperatorOperation.Cancel) {
    return cancelEnrolledResearchLaunch(request.jobId, binding.grantSha256, binding.requestSha256);
  }
  const operation = observation(request);
  // Before start publication, status is metadata only and cannot create work.
  if (!existsSync(join(researchOperatorDirectory(request.jobId), "active.json")) &&
      !existsSync(join(researchOperatorDirectory(request.jobId), "last-terminal.json"))) return { operation };
  return { operation, research: statusResearchLaunch(request.jobId) };
}
export function executeResearchOperator(jobId: string, expectedOwnerSha256: string) {
  assertResearchInitialRoot(true); assertResearchSharedHost();
  const owner = retained(jobId);
  if (owner.sha256 !== expectedOwnerSha256) throw new Error("research_operator_owner_invalid");
  const { binding } = readResearchOperatorBinding(owner.request, true);
  const plan = trustedResearchOperatorLaunch(binding, owner.sha256);
  const output = researchCommand("/usr/bin/systemctl", ["show", plan.unit, "--property=Id,Description,MainPID,Transient,FragmentPath,DropInPaths,ControlGroup"]);
  const fields = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  const group = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").filter(line => line.startsWith("0::"));
  if (fields.Id !== plan.unit || fields.Description !== plan.description || fields.MainPID !== String(process.pid) || fields.Transient !== "yes" ||
      fields.FragmentPath !== `/run/systemd/transient/${plan.unit}` || fields.DropInPaths !== "" || group.length !== 1 ||
      group[0] !== "0::" + fields.ControlGroup || fields.ControlGroup !== "/system.slice/" + plan.unit) throw new Error("research_operator_service_invalid");
  researchCustody(fields.FragmentPath);
  if (existsSync(resultPath(jobId))) throw new Error("research_operator_already_settled");
  let result: unknown;
  try { result = { ok: true, start: startEnrolledResearchLaunch(binding.requestPath, binding.requestSha256, binding.grantSha256) }; }
  catch { result = { ok: false, error: "research_operator_start_uncertain" }; }
  researchPublish(resultPath(jobId), result, true);
  return result;
}
