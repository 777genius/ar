import { assertCurrentClosedEntry } from "./current-closed-entry.js";
import type { HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
/** Real Linux mount regression SOURCE. Invoke only in the owned disposable
 * original TEST guest after actual installation, never in a developer process.
 * This helper cannot install a profile, spawn a provider, or grant admission. */
import assert from "node:assert/strict";
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,unlinkSync} from "node:fs";
import {withHostedActivationFence} from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import {assertHostedDependencyPhysicalWorkspace,readHostedDependencyBinding} from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import {HostedActivationPhase,HostedCustodyReservationState} from "../../dist/worker-core/index.js";
import {readHostedInstallationActivation} from "../../dist/worker-codex/hosted-installation-activation.js";
import {assertPreparedCurrentConfiguredAuth,closePreparedCurrentConfiguredAuth,type CurrentColdHotRoots} from "./current-cold-hot-root.js";
import {command} from "./common.ts";
function mountRow(path:string):string {
 const text=readFileSync("/proc/self/mountinfo","utf8");assert(Buffer.byteLength(text)<=1024*1024);
 const rows=text.trimEnd().split("\n").filter(l=>l.split(" ")[4]===path);assert.equal(rows.length,1);return rows[0]!;
}
/** Catches replacing the whole-job mount veto with a path-only auth waiver.
 * The additional mount is this fixture's own public empty regular file. */
export function runOriginalConfiguredAuthExtraMountRegression(roots:CurrentColdHotRoots):void {
 assertPreparedCurrentConfiguredAuth(roots);
 withHostedActivationFence(()=>{
  const installed=readHostedInstallationActivation();assert.equal(installed.activation.phase,HostedActivationPhase.Closed);
  assert(installed.activation.ordinaryStarts.every(r=>r.state===HostedCustodyReservationState.Terminal));
  const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
  assertHostedDependencyPhysicalWorkspace(binding); // Genuine installed role is positive here.
  const source=roots.jobRoot+"/TEST-auth-extra-source",target=roots.jobRoot+"/TEST-auth-extra-target";
  const make=(path:string)=>{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{return fstatSync(fd,{bigint:true});}finally{closeSync(fd);}};
  const ownSource=make(source),ownTarget=make(target);
  command("/usr/bin/mount",["--bind",source,target]);const attached=mountRow(target);
  assert.throws(()=>assertHostedDependencyPhysicalWorkspace(binding));
  assert.equal(mountRow(target),attached); // Release only this exact additional mount.
  command("/usr/bin/umount",["--",target]);
  const actual=lstatSync(target,{bigint:true});assert(actual.dev===ownTarget.dev && actual.ino===ownTarget.ino && actual.size===0n && actual.nlink===1n);
  const src=lstatSync(source,{bigint:true});assert(src.dev===ownSource.dev && src.ino===ownSource.ino && src.size===0n && src.nlink===1n);
  unlinkSync(target);unlinkSync(source);assertHostedDependencyPhysicalWorkspace(binding);
 });
}
/** Requires a genuine final retained completion already recorded by the actual
 * flow. Original release revalidates branded Closed/drained custody itself. */
export function runOriginalConfiguredAuthFinalReleaseRegression(roots:CurrentColdHotRoots):void {
 assertPreparedCurrentConfiguredAuth(roots);const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
 assertHostedDependencyPhysicalWorkspace(binding);closePreparedCurrentConfiguredAuth(roots);
 assert.throws(()=>assertHostedDependencyPhysicalWorkspace(binding));
 assert.throws(()=>closePreparedCurrentConfiguredAuth(roots)); // No adoption or replay.
}

/** Destructive NEGATIVE fixture only in its own disposable guest after a real
 * final branded Closed/drained entry. It leaves the invalid attachment Held for
 * original OS teardown; never remounts back to pretend uninterrupted custody. */
export function runOriginalConfiguredAuthFlagDriftRegression(roots:CurrentColdHotRoots,result:HostedForegroundResult):void {
 assertPreparedCurrentConfiguredAuth(roots);
 withHostedActivationFence(fence=>{
  assertCurrentClosedEntry(fence,roots.jobRoot,result);
  const binding=readHostedDependencyBinding(roots.candidateJobId);assert(binding && binding.version===2);
  assertHostedDependencyPhysicalWorkspace(binding);
  const target=roots.jobRoot+"/auth/"+roots.accountName+"/auth.json",before=mountRow(target);
  command("/usr/bin/mount",["-o","remount,bind,rw,nosuid,nodev,noexec",target]);
  const after=mountRow(target),flags=after.split(" ")[5]!.split(",");
  assert.equal(after.split(" ")[0],before.split(" ")[0]);assert(flags.includes("rw") && !flags.includes("ro"));
  assert.throws(()=>assertHostedDependencyPhysicalWorkspace(binding));
 });
}
