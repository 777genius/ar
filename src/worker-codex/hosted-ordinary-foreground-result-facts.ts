import { createHash } from "node:crypto";
import { HostedCustodyReservationState, parseHostedOrdinaryStart } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedActivationFence, decodeHostedActivationBytes, readHostedActivationBytes, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedForegroundResult, type HostedForegroundResult } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { readHostedOrdinaryBirth } from "./hosted-installation-origin-facts";
import { assertActivationSession, assertInspectedInstallation } from "./hosted-installation-physical-facts";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory, ordinaryCompletionBytes } from "./hosted-readonly-host-kernel";
function invalid():never { throw new Error("hosted_activation_evidence_invalid"); }
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function required(name:string):Buffer {const bytes=readHostedActivationBytes(name);if (!bytes) invalid();return bytes;}
/** Fixed factual collection only. Genuine held fence/result select the actual
 * protected start/catalog/row. It accepts no caller start, row, pin or kernel.
 * The store retains actual child association and publication/release policy. */
export function readHostedOrdinaryForegroundResultOwner(fence:HostedActivationFence,result:HostedForegroundResult) {
  assertHostedActivationFence(fence);assertHostedForegroundResult(result);
  const before=required(`ordinary-starts/${result.startId}.json`),start=parseHostedOrdinaryStart(decodeHostedActivationBytes(before));
  if (start.unit!==result.unit || result.unit!==`subscription-runtime-ordinary-${result.startId}.service`) invalid();
  const {installation,activation,birth,originSha256}=readHostedOrdinaryBirth(start.jobId);
  assertInspectedInstallation(installation);
  const kernel=new HostedReadonlyHostKernel();assertActivationSession(activation,kernel.operatorSession());
  const reservation=activation.ordinaryStarts.find(row=>row.startId===result.startId);
  if (!reservation || reservation.state!==HostedCustodyReservationState.Reserved || reservation.unit!==start.unit ||
      reservation.creatorId!==start.creatorId || reservation.originSha256!==start.originSha256 || reservation.generation!==start.activationGeneration ||
      originSha256!==start.originSha256 || installation.installationId!==start.installationId || activation.bootId!==start.bootId ||
      activation.supervisorId!==start.supervisorId || birth.workspacePath!==start.workspacePath || birth.jobRootDir!==start.jobRootDir) invalid();
  if (result.exitCode===0) {
    if (!required(`ordinary-completed/${result.startId}.json`).equals(ordinaryCompletionBytes(result.startId,digest(before)))) invalid();
    kernel.fenceOrdinaryCreator(reservation,start.bootId,digest(before));
  }
  kernel.drainOrdinaryQueue(reservation);kernel.confirmOrdinaryDescendants(reservation);
  const creator=readHostedReadonlyHostInventory().ordinaryCreators.find(row=>row.creatorId===start.creatorId);
  if (!creator || creator.jobRootDir!==start.jobRootDir) invalid();
  assertHostedActivationFence(fence);
  if (!required(`ordinary-starts/${result.startId}.json`).equals(before) ||
      JSON.stringify(readHostedOrdinaryBirth(start.jobId).activation)!==JSON.stringify(activation)) invalid();
  return Object.freeze({jobRootDir:start.jobRootDir,args:creator.launch.args});
}
