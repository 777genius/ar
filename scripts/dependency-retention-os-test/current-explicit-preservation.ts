import { positiveAcceptanceAdmissionRemaining } from "./current-positive-acceptance-roster.js";
import { readCodexGoalResultSummary } from "../../dist/worker-codex/codex-goal-status-files.js";
/** Genuine original FULL caller. Snapshots are DATA, never execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, readdirSync, realpathSync, symlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { HostedActivationPhase, HostedCustodyReservationState } from "../../dist/worker-core/index.js";
import { HostedInstallationActivationStore, readHostedInstallationActivation } from "../../dist/worker-codex/hosted-installation-activation.js";
import { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } from "../../dist/worker-codex/hosted-readonly-host-kernel.js";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { createReadonlyPrivateRecord } from "../../dist/worker-codex/hosted-readonly-custody.js";
import { readHostedDependencyEvictionEnabled } from "../../dist/worker-codex/hosted-dependency-eviction-enabled-policy.js";
import { readHostedDependencyBinding, hostedDependencyOwnerRoot } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { readHostedForegroundLaunchObservation, type HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { readHostedForegroundResultRecord } from "../../dist/worker-codex/hosted-foreground-result.js";
import { LocalDependencyOwnerStore } from "../../dist/store-local-file/dependency-environment/local-dependency-owner-store.js";
import { readHostedDependencyPreservationSelections } from "../../dist/worker-codex/hosted-dependency-preservation-selection.js";
import { readHostedDependencyCompletedPreservation, readHostedDependencyPreservationRelease } from "../../dist/worker-codex/hosted-dependency-preservation-handoff.js";
import { HostedDependencyExplicitPreservationOutcome } from "../../dist/worker-codex/hosted-dependency-transactions.js";
import { assertRootScope, assertPreparedCurrentConfiguredAuth, assertCurrentConfiguredAuth, retainPreparedCurrentAuthCompletion, isPreparedCurrentPositiveAuxiliary, type CurrentOrdinaryRoots, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
import { FullEntryKind, FullRequestPhase, requestCurrentNextWork, assertCurrentNextWorkDelivered, runCurrentOrdinaryEntry, assertDistinctCurrentEntries } from "./current-full-entry.js";
import { runCurrentFullReadonlyContinuation } from "./current-full-r-continuation.js";
import { assertCurrentClosedEntry } from "./current-closed-entry.js";
import { readEvictRestoreReady, assertPathAbsent } from "./current-evict-restore-readback.js";
import { prepareEvictRestoreSentinels, captureEvictRestoreSentinels, assertEvictRestoreSentinels } from "./current-evict-restore-sentinels.js";
import { startNativeInstallerTrace, NativeInstallerTraceState } from "./native-installer-observations.js";
import { pinReferenceFile } from "../../dist/worker-codex/hosted-dependency-legacy-reference-records.js";
const policy = "/var/lib/subscription-runtime-host-policy", hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
export enum ExplicitPreservationPhase { Cold="cold", Mutation="opaque_mutation", Preserve="explicit_preservation", Restore="ordinary_restore", Hot="ordinary_hot", Readonly="original_readonly_continuation" }
export enum OpaqueSnapshotKind { Directory="directory", File="file", Symlink="symlink" }
type SnapshotEntry = Readonly<{ path: string; kind: OpaqueSnapshotKind; dev: string; ino: string; mode: string; uid: string; gid: string; bytes?: number; sha256?: string; target?: string }>;
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return (["dev","ino","mode","uid","gid","nlink","size","mtimeNs","ctimeNs"] as const).every(key => a[key] === b[key]);
}
/** Bounded independent whole-tree DATA. No link is followed and no proof is
 * supplied to the producer. Linux uses retained directory FD paths throughout;
 * the portable DATA tests use named paths bracketed by the same identity checks.
 * Root path is excluded so rename compares exactly. */
export function captureExplicitOpaqueTreeData(root: string) {
  const started = process.hrtime.bigint(), records: SnapshotEntry[] = []; let total = 0;
  const bound = () => assert(records.length <= 32768 && total <= 512 * 1024 * 1024 && process.hrtime.bigint() - started < 30000000000n, "TEST opaque DATA bound");
  assert.equal(realpathSync(root), root);
  function walk(relative: Buffer, device: bigint, path: Buffer): void {
    bound(); const before = lstatSync(path, { bigint: true }); assert.equal(before.dev, device);
    const base = { path: relative.toString("base64"), dev: String(before.dev), ino: String(before.ino), mode: String(before.mode & 0o7777n), uid: String(before.uid), gid: String(before.gid) };
    if (before.isSymbolicLink()) {
      const target = readlinkSync(path, { encoding: "buffer" }); assert(target.length <= 65536); total += target.length;
      records.push({ ...base, kind: OpaqueSnapshotKind.Symlink, target: target.toString("base64") });
    } else if (before.isDirectory()) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        assert(stable(before, fstatSync(fd, { bigint: true })));
        records.push({ ...base, kind: OpaqueSnapshotKind.Directory });
        const anchored = process.platform === "linux" ? Buffer.from("/proc/self/fd/" + fd) : path;
        const names = readdirSync(anchored, { encoding: "buffer" }).sort(Buffer.compare); assert(names.length <= 32768);
        for (const name of names) { assert(name.length > 0 && name.length <= 255 && !name.includes(0) && !name.includes(47));
          walk(relative.length ? Buffer.concat([relative, Buffer.from("/"), name]) : name, device, Buffer.concat([anchored, Buffer.from("/"), name])); }
        assert(stable(before, fstatSync(fd, { bigint: true })));
      } finally { closeSync(fd); }
    } else {
      assert(before.isFile() && before.nlink === 1n && before.size >= 0n && before.size <= 64n * 1024n * 1024n);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        assert(stable(before, fstatSync(fd, { bigint: true }))); const bytes = Buffer.alloc(65536), digest = createHash("sha256"); let size = 0;
        for (;;) { const n = readSync(fd, bytes, 0, bytes.length, size); if (!n) break; size += n; total += n; assert(size <= Number(before.size)); digest.update(bytes.subarray(0,n)); bound(); }
        assert.equal(size, Number(before.size)); records.push({ ...base, kind: OpaqueSnapshotKind.File, bytes: size, sha256: digest.digest("hex") });
        assert(stable(before, fstatSync(fd, { bigint: true })));
      } finally { closeSync(fd); }
    }
    assert(stable(before, lstatSync(path, { bigint: true }))); bound();
  }
  const rootStat = lstatSync(root, { bigint: true }); assert(rootStat.isDirectory() && !rootStat.isSymbolicLink()); walk(Buffer.alloc(0), rootStat.dev, Buffer.from(root));
  return Object.freeze({ entries: Object.freeze(records.map(row => Object.freeze(row))), bytes: total, digest: hash(encode(records)) });
}
function publicPin(path: string, limit: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd, { bigint: true }); assert(s.isFile() && s.uid === 0n && s.nlink === 1n && !(s.mode & 0o077n) && s.size >= 0n && s.size <= BigInt(limit));
    const bytes = Buffer.alloc(Number(s.size) + 1); let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; }
    assert.equal(size, Number(s.size)); assert(stable(s, fstatSync(fd, { bigint: true }))); assert(stable(s, lstatSync(path, { bigint: true })));
    return Object.freeze({ path, dev: String(s.dev), ino: String(s.ino), sha256: hash(bytes.subarray(0, size)) });
  } finally { closeSync(fd); }
}
export async function captureCurrentCompletedOutputData(roots: CurrentOrdinaryRoots, result: HostedForegroundResult) {
  const native = readHostedForegroundLaunchObservation(result); assert(/^subscription-runtime-ordinary-[a-f0-9-]{36}\.service$/.test(native.unit));
  const resultPath = roots.jobRoot + "/state/TEST-result.json", first=publicPin(resultPath,1024*1024),record = readHostedForegroundResultRecord(resultPath);
  assert.equal(record.value.status, "done"); assert.equal(record.output.unit, native.unit); assert.equal(record.output.exitCode, 0);
  const summary=await readCodexGoalResultSummary(resultPath);assert.equal(summary.status,"done");assert.deepEqual(summary.foregroundOutput,record.output);
  const outputs=["stdout","stderr"].map(kind=>publicPin(policy+"/foreground-output/"+native.unit+"."+kind,16*1024*1024));
  assert.equal(outputs[0]!.sha256,hash(Buffer.from(record.output.stdout)));assert.equal(outputs[1]!.sha256,hash(Buffer.from(record.output.stderr)));
  assert.deepEqual(publicPin(resultPath,1024*1024),first);
  return Object.freeze({result:first,outputs,summarySha256:hash(encode(summary)),unit:native.unit});
}
function assertPins(pins: readonly ReturnType<typeof publicPin>[]) { for (const pin of pins) assert.deepEqual(publicPin(pin.path, 16 * 1024 * 1024), pin); }
/** Exact old result is checked only before the next genuine entry overwrites
 * its documented latest alias. Per-unit outputs remain checked thereafter. */
export function assertCurrentCompletedOutputData(value:Awaited<ReturnType<typeof captureCurrentCompletedOutputData>>) {assertPins([value.result,...value.outputs]);}
export function assertCurrentCompletedOutputLogsData(value:Awaited<ReturnType<typeof captureCurrentCompletedOutputData>>) {assertPins(value.outputs);}
function preparePolicy(roots: CurrentColdHotRoots) {
  withHostedActivationFence(() => {
    assertReadonlyHostOperator(); assertRootScope(roots); const actual = readHostedInstallationActivation();
    assert.equal(actual.activation.phase, HostedActivationPhase.Closed); assert.equal(actual.activation.ordinaryStarts.length, 0); assert.equal(actual.installation.runtimeSha, roots.sourceSha);
    const creators = readHostedReadonlyHostInventory().ordinaryCreators; assert.equal(creators.length, 1); assert.equal(creators[0]!.jobId, roots.candidateJobId); assert.equal(creators[0]!.workspacePath, roots.workspace);
    new HostedReadonlyHostKernel().verifyExclusiveInventory();
    const parent = lstatSync(policy); assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && parent.gid === 0 && (parent.mode & 0o7777) === 0o700);
    const path = policy + "/dependency-retention-policy.json"; assertPathAbsent(path);
    createReadonlyPrivateRecord(path, encode({ version: 1, managedReadyRequired: true, evictionEnabled: false }));
    assert.equal(readHostedDependencyEvictionEnabled(), false); assert(pinReferenceFile(path, 4096).bytes.equals(encode({ version: 1, managedReadyRequired: true, evictionEnabled: false })));
  });
}
function measured(trace: ReturnType<typeof startNativeInstallerTrace>, count: number, prior: number) {
  const result = trace.finish(); assert.equal(result.state, NativeInstallerTraceState.Measured); assert.equal(result.launchedInstalls, count); assert.equal(result.completedInstalls, count); assert.equal(result.excludedPriorStarts, prior); return result;
}
/** One genuine callable case; no supplied manifest/proof/session/installer. */
export async function runCurrentExplicitPreservation(roots: CurrentColdHotRoots, maximumMs: number, progress: (phase: ExplicitPreservationPhase) => void) {
  assert.equal(process.platform, "linux"); assertReadonlyHostOperator(); assertRootScope(roots); assertPreparedCurrentConfiguredAuth(roots); assertCurrentConfiguredAuth(roots);
  assert(Number.isSafeInteger(maximumMs) && maximumMs > 0 && maximumMs <= 27 * 60 * 1000); const deadline = performance.now() + maximumMs;
  const remaining = () => { const n = Math.floor(deadline - performance.now()); assert(n > 0, "TEST explicit preservation work budget"); return n; };
  preparePolicy(roots); prepareEvictRestoreSentinels(roots); const sentinels = captureEvictRestoreSentinels(roots), store = new HostedInstallationActivationStore();
  let trace: ReturnType<typeof startNativeInstallerTrace> | undefined = startNativeInstallerTrace(roots.candidateJobId, remaining());
  try {
    const birth = store.enrollOrdinary(roots.candidateJobId); assert.equal(birth.jobRootDir, roots.jobRoot); assert.equal(birth.workspacePath, roots.workspace);
    progress(ExplicitPreservationPhase.Cold); store.resumeOrdinary(); const cold = await runCurrentOrdinaryEntry(roots, FullEntryKind.Cold); store.finishClosed();
    withHostedActivationFence(fence => assertCurrentClosedEntry(fence, roots.jobRoot, cold.result)); const old = readEvictRestoreReady(roots), completed = await captureCurrentCompletedOutputData(roots, cold.result);
    const coldTrace = trace; trace = undefined; const coldInstaller = measured(coldTrace, 1, 0); assertEvictRestoreSentinels(roots, sentinels);
    const core=await preserveCurrentC(roots,cold,deadline,sentinels,progress);
    const {restored,hot,restoreDelivery,hotDelivery,preservationInstaller,restoreInstaller,hotInstaller,preserved,selected,consumed,before,retained}=core;
    progress(ExplicitPreservationPhase.Readonly); const readonly = await runCurrentFullReadonlyContinuation(roots, hot.observation, remaining(), () => remaining());
    assertDistinctCurrentEntries([cold, restored, hot, ...readonly.entries.map(observation => ({ observation }))]);
    assert.deepEqual(captureExplicitOpaqueTreeData(preserved.destination), before); assertPins(completed.outputs); assertEvictRestoreSentinels(roots, sentinels);
    assert.equal(new Set([...coldInstaller.invocationIds, ...restoreInstaller.invocationIds]).size, 2); assert.equal(readHostedDependencyEvictionEnabled(), false);
    assert.equal(readHostedInstallationActivation().activation.phase, HostedActivationPhase.Closed);
    assert(readHostedInstallationActivation().activation.ordinaryStarts.every(row => row.state === HostedCustodyReservationState.Terminal));
    return Object.freeze({ qualification: "native_actual_explicit_preservation_c_restore_hot_r_first_hot_only", status: "partial_pass", fullPlanQualification: "pending",
      entries: [cold.observation, restored.observation, hot.observation, ...readonly.entries], cumulativeInstalls: 2,
      control: [restoreDelivery, hotDelivery], installer: { cold: coldInstaller, preserve: preservationInstaller, restore: restoreInstaller, hot: hotInstaller }, readonly,
      preservation: { operationId: preserved.operationId, mappingDigest: preserved.mappingDigest, committed: selected.release.mapping.committed.reference, consumedInstalling: consumed.installing.reference,
        consumedReady: consumed.ready.reference, oldReady: old.reference, opaqueEntries: before.entries.length, opaqueBytes: before.bytes, opaqueSha256: before.digest, originalInode: old.receipt.tree, retained },
      unsupported: ["same_workspace_R_to_C_owner_v3_claim", "no_active_R_explicit_preservation", "native_preservation_crash_recovery"], noGarbageCollection: true });
  } finally { if (trace) { try { trace.finish(); } catch { process.stderr.write("TEST_explicit_preservation_installer_observation_unresolved\n"); } } }
}

const positiveOpaque = new WeakMap<CurrentOrdinaryRoots,Readonly<{destination:string;before:ReturnType<typeof captureExplicitOpaqueTreeData>}>>();
/** Fixed auxiliary C continuation. The caller supplies only an ORIGINAL FDA
 * result from its real first restore, never an installer/proof callback. */
export async function runCurrentPositivePreservationC(roots:CurrentOrdinaryRoots,initial:Awaited<ReturnType<typeof runCurrentOrdinaryEntry>>,deadline:number) {
  assert(isPreparedCurrentPositiveAuxiliary(roots));assertRootScope(roots);assertPreparedCurrentConfiguredAuth(roots);
  assert.equal(readHostedDependencyEvictionEnabled(),true);
  const sentinels=captureEvictRestoreSentinels(roots);
  const core=await preserveCurrentC(roots,initial,deadline,sentinels,()=>{});
  assert.equal(readHostedDependencyEvictionEnabled(),true);
  positiveOpaque.set(roots,{destination:core.preserved.destination,before:core.before});
  return Object.freeze({entries:[core.restored.observation,core.hot.observation],control:[core.restoreDelivery,core.hotDelivery],
    installer:{preserve:core.preservationInstaller,restore:core.restoreInstaller,hot:core.hotInstaller},cumulativeInstalls:2,
    preservation:{operationId:core.preserved.operationId,mappingDigest:core.preserved.mappingDigest,committed:core.selected.release.mapping.committed.reference,
      consumedInstalling:core.consumed.installing.reference,consumedReady:core.consumed.ready.reference,opaqueEntries:core.before.entries.length,
      opaqueBytes:core.before.bytes,opaqueSha256:core.before.digest,retained:core.retained},noGarbageCollection:true});
}
async function preserveCurrentC(roots:CurrentOrdinaryRoots,initial:Awaited<ReturnType<typeof runCurrentOrdinaryEntry>>,deadline:number,
    sentinels:ReturnType<typeof captureEvictRestoreSentinels>,progress:(phase:ExplicitPreservationPhase)=>void) {
  assertRootScope(roots);assertPreparedCurrentConfiguredAuth(roots);
  withHostedActivationFence(fence=>assertCurrentClosedEntry(fence,roots.jobRoot,initial.result));
  const remaining=()=>{const ms=Math.floor(deadline-performance.now());assert(ms>0 && ms<=27*60*1000);return ms;};remaining();
  const store=new HostedInstallationActivationStore(),old=readEvictRestoreReady(roots),completed=await captureCurrentCompletedOutputData(roots,initial.result);
  let trace:ReturnType<typeof startNativeInstallerTrace>|undefined;
  try {
    progress(ExplicitPreservationPhase.Mutation); const original = roots.workspace + "/node_modules", nested = original + "/TEST-authored-unknown";
    mkdirSync(nested, { mode: 0o750 }); writeFileSync(nested + "/bytes", Buffer.from([0, 255, 128, 1]), { flag: "wx", mode: 0o640 });
    writeFileSync(Buffer.concat([Buffer.from(nested + "/"), Buffer.from([255, 1])]), Buffer.from([255, 0, 128]), { flag: "wx", mode: 0o600 });
    chmodSync(nested,0o750); chmodSync(nested + "/bytes",0o640);
    symlinkSync(Buffer.from([255, 2]), nested + "/raw-dangling");
    // Authored cache bytes are part of the old unknown tree, never a cleanup
    // category. Keep any existing cache intact; collisions cannot be repaired.
    const cache = original + "/.cache";
    try { const current = lstatSync(cache); assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(realpathSync(cache),cache); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; mkdirSync(cache,{mode:0o700}); }
    const authoredCache = cache + "/TEST-explicit-preservation"; mkdirSync(authoredCache,{mode:0o750});
    writeFileSync(authoredCache + "/authored.bin",Buffer.from([0,255,128,3,0]),{flag:"wx",mode:0o640});
    chmodSync(authoredCache,0o750);chmodSync(authoredCache + "/authored.bin",0o640);
    const before = captureExplicitOpaqueTreeData(original);
    assert.equal(before.entries[0]!.ino, old.receipt.tree.ino); assert.equal(before.entries[0]!.dev, old.receipt.tree.dev);
    store.resumeOrdinary(); trace = startNativeInstallerTrace(roots.candidateJobId, remaining()); progress(ExplicitPreservationPhase.Preserve);
    const preserved = await store.preserveDependencyForExplicitReinstallation(roots.candidateJobId); assert.equal(preserved.outcome, HostedDependencyExplicitPreservationOutcome.Preserved);
    const preservationTrace = trace; trace = undefined; const preservationInstaller = measured(preservationTrace, 0, 1); assertPathAbsent(original);
    const selected = withHostedActivationFence(fence => {
      const binding = readHostedDependencyBinding(roots.candidateJobId); assert(binding && binding.version === 2);
      const selection = readHostedDependencyPreservationSelections(binding).find(row => row.header.operationId === preserved.operationId); assert(selection); assert.deepEqual(selection.header.prior.receipt, old);
      const release = readHostedDependencyPreservationRelease(fence, selection.header); assert.equal(hash(encode(release.mapping.prepared.header)), preserved.mappingDigest);
      const owners = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try { assert.deepEqual(owners.read(binding.workspace), release.released); } finally { owners.close(); }
      assert.equal(preserved.destination, selection.header.destinationParent.canonicalPath + "/dependency-" + preserved.operationId);
      assert(pinReferenceFile(old.reference.path, 16384).bytes.equals(encode(old.receipt))); return { binding, selection, release };
    });
    assert.deepEqual(captureExplicitOpaqueTreeData(preserved.destination), before); assertPins([completed.result, ...completed.outputs]); assertEvictRestoreSentinels(roots, sentinels);
    const restoreRequest = await requestCurrentNextWork(roots, FullRequestPhase.ColdRestore); trace = startNativeInstallerTrace(roots.candidateJobId, remaining()); progress(ExplicitPreservationPhase.Restore);
    if(isPreparedCurrentPositiveAuxiliary(roots))positiveAcceptanceAdmissionRemaining(deadline);
    const restored = await runCurrentOrdinaryEntry(roots, FullEntryKind.Restored), restoreDelivery = await assertCurrentNextWorkDelivered(roots, restoreRequest);
    const restoreTrace = trace; trace = undefined; const restoreInstaller = measured(restoreTrace, 1, 1);
    const consumed = withHostedActivationFence(fence => { const value = readHostedDependencyCompletedPreservation(fence, selected.binding, preserved.operationId); assert(value);
      assert.deepEqual(value.release.reference, selected.release.reference); assert.equal(value.installing.receipt.generation, restored.observation.attemptId); assert.equal(value.ready.receipt.generation, restored.observation.attemptId); return value; });
    const restoredReady = readEvictRestoreReady(roots); assert.notEqual(restoredReady.receipt.tree.ino, old.receipt.tree.ino); assert.deepEqual(restoredReady, consumed.ready);
    const hotRequest = await requestCurrentNextWork(roots, FullRequestPhase.CurrentHot); trace = startNativeInstallerTrace(roots.candidateJobId, remaining()); progress(ExplicitPreservationPhase.Hot);
    if(isPreparedCurrentPositiveAuxiliary(roots))positiveAcceptanceAdmissionRemaining(deadline);
    const hot = await runCurrentOrdinaryEntry(roots, FullEntryKind.Hot), hotDelivery = await assertCurrentNextWorkDelivered(roots, hotRequest);
    const hotTrace = trace; trace = undefined; const hotInstaller = measured(hotTrace, 0, 2); assert.deepEqual(readEvictRestoreReady(roots), restoredReady);
    store.finishClosed(); withHostedActivationFence(fence => assertCurrentClosedEntry(fence, roots.jobRoot, hot.result)); retainPreparedCurrentAuthCompletion(roots, hot.result);
    assertDistinctCurrentEntries([initial,restored,hot]);
    assert.deepEqual(captureExplicitOpaqueTreeData(preserved.destination),before);assertPins(completed.outputs);
    const retained=assertEvictRestoreSentinels(roots,sentinels);
    return {restored,hot,restoreDelivery,hotDelivery,preservationInstaller,restoreInstaller,hotInstaller,preserved,selected,consumed,before,retained};
  }finally{if(trace){try{trace.finish();}catch{process.stderr.write("TEST_explicit_preservation_installer_observation_unresolved\n");}}}
}

/** Reobserve retained opaque bytes after the different primary R sequence.
 * This cannot authorize cleanup or construct a preservation handoff. */
export function assertCurrentPositiveOpaquePreservationRetained(roots:CurrentOrdinaryRoots) {
  assert(isPreparedCurrentPositiveAuxiliary(roots));assertRootScope(roots);const held=positiveOpaque.get(roots);assert(held);
  assert.deepEqual(captureExplicitOpaqueTreeData(held.destination),held.before);
  return Object.freeze({opaqueSha256:held.before.digest,opaqueBytes:held.before.bytes,opaqueEntries:held.before.entries.length,retained:true});
}
