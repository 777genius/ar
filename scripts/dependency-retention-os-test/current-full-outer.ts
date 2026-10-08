import { assertOuterIoUringPins, controlIoUringFixture, IoUringControlFailure } from "./io-uring.ts";
/** The runner only operates one newly registered service/root. Guest creation
 * is not authority: all positive gates execute inside its actual kernel view. */
import assert from "node:assert/strict";
import { captureFullAdministrativeBirth, retainFullBackingBirth, type FullGuestSelection } from "./current-full-backing-collector.js";
import { CurrentBackingGeometry, CurrentGeometryQualification, currentBackingStorage } from "./current-backing-geometry.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, statSync, statfsSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, resolve } from "node:path";
import { assembleCurrentFull as assemble } from "./assemble-current-full.js";
import { fullNativeOsBase, fullNativeTmpDir, retainCurrentFullParent } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";
import { readCurrentFullOuterInput } from "./current-full-outer-input.js";
import { configuredAuthNspawnBinding } from "./current-configured-auth-mount.js";
import { prepareCurrentRealCodexCapsule } from "./prepare-current-real-codex-capsule.js";
import { isDependencyCustodyObject } from "../../dist/core/dependency-environment/dependency-custody-evidence.js";
import { busDiagnosticDropIn, busDiagnosticDropInPath, busDiagnosticSink, cleanEnv, command as runCommand, directory, directoryIdentity, digest, fileDigest, json, node, OwnedOsMode, OwnedOsScenario, readonlyStorage, runtime, setupDiagnostic, type OwnedOsFixtureScenario } from "./common.ts";

export let fullParentTerminal:unknown;

// This starts after workflow checkout/build/typecheck, not at workflow start.
// The unchanged 40-minute job timeout is the independent platform backstop.
const outerStarted = process.hrtime.bigint();
const milliseconds = (value: number): bigint => BigInt(value) * 1000000n;
const workDeadline = outerStarted + milliseconds(27 * 60 * 1000);
const outerDeadline = outerStarted + milliseconds(30 * 60 * 1000);
const earlier = (left: bigint, right: bigint): bigint => left < right ? left : right;
function remaining(deadline: bigint, failure = "owned TEST shared monotonic work budget exhausted"): number {
  const value = Number((deadline - process.hrtime.bigint()) / 1000000n);
  assert(value > 0, failure); return value;
}
function boundedCommand(file: string, args: readonly string[], deadline: bigint, timeout = 30000): string {
  const output = runCommand(file, args, Math.min(timeout, remaining(deadline)), "/", fullNativeTmpDir);
  remaining(deadline); return output;
}

// This NEW route consumes fixed ROOT-staged TEST inputs. Historical GitHub
// assertions/dispatch in registration-outer remain byte-for-byte unchanged.
assert.equal(process.argv.length,2);
const managedParent=retainCurrentFullParent();
const fullInput=readCurrentFullOuterInput(),{source,toolchain}=fullInput;
assert.equal(boundedCommand("/usr/bin/lsb_release",["--codename","--short"],workDeadline).trim(),"noble");
const diagnostic=false,geometry=CurrentBackingGeometry.Adoptable;
const qualification="native_actual_c_cold_hot_committed_absent_restore_coldv2_r_entries_only";
const inheritedHostJobId=process.env.SUBSCRIPTION_RUNTIME_HOST_JOB_ID;
if(inheritedHostJobId!==undefined)assert(/^TEST-[A-Za-z0-9_.-]{1,123}$/.test(inheritedHostJobId));
const inheritedHostMarker=inheritedHostJobId===undefined?"":`--setenv=SUBSCRIPTION_RUNTIME_HOST_JOB_ID=${inheritedHostJobId} `;
const authBinding=configuredAuthNspawnBinding(fullInput.accountName);
await prepareCurrentRealCodexCapsule(fullInput.sourceSha);
const base=fullNativeOsBase; // Must already be independently provisioned and pinned.
const namespace=lstatSync(base);assert(namespace.isDirectory() && !namespace.isSymbolicLink() && namespace.uid===0 && namespace.gid===0 && (namespace.mode&0o7777)===0o700);
assert.equal(realpathSync(base),base);
const defaultEvidence = await runOwnedOs(OwnedOsScenario.CurrentDependency);
if (defaultEvidence.status !== "partial_pass") process.exitCode = 1;
defaultEvidence.outerBudget = { clock: "process.hrtime.bigint", workMs: 27 * 60 * 1000,
  cleanupEvidenceReserveMs: 3 * 60 * 1000, totalMs: 30 * 60 * 1000,
  elapsedMs: Number((process.hrtime.bigint() - outerStarted) / 1000000n),
  startsAfter: "independently reviewed ROOT TEST source/toolchain input", enclosingManagedServiceTimeoutRequired: true };
assert(Buffer.byteLength(JSON.stringify(defaultEvidence)) <= 512 * 1024);
// The reviewed source remains readonly. Publish only into own protected output.
const outputBase="/var/lib/subscription-runtime-full-TEST-output";
if(!existsSync(outputBase))directory(outputBase);
const outputStat=lstatSync(outputBase);assert(outputStat.isDirectory() && !outputStat.isSymbolicLink() && outputStat.uid===0 && outputStat.gid===0 && (outputStat.mode&0o7777)===0o700);
assert.equal(realpathSync(outputBase),outputBase);
const outputRoot=outputBase+"/"+fullInput.sourceSha;
if(!existsSync(outputRoot))directory(outputRoot);
const outputRootStat=lstatSync(outputRoot);assert(outputRootStat.isDirectory() && !outputRootStat.isSymbolicLink() && outputRootStat.uid===0 && outputRootStat.gid===0 && (outputRootStat.mode&0o7777)===0o700);
assert.equal(realpathSync(outputRoot),outputRoot);
json(outputRoot + "/dependency-retention-os-evidence.json", defaultEvidence, 0o600);
managedParent.revalidate(); // Only the actual parent finally may consume its terminal brand.

async function runOwnedOs(scenario: OwnedOsFixtureScenario): Promise<Record<string, unknown>> {
const diagnostic = scenario === OwnedOsMode.BusDiagnostic;
const id = randomUUID(), owned = base + "/" + id; assert(!existsSync(owned));directory(owned);
const root = owned + "/root", outbox=owned+"/policy-request-outbox", reviewed=owned+"/independently-reviewed-inputs", fullReviewed=owned+"/full-reviewed-input", publicReviewed=owned+"/public-reviewed-input", unit = `TEST-retention-os-${id}.service`;
const machineId = randomUUID().replaceAll("-", ""), outerMachineId = readFileSync("/etc/machine-id", "utf8").trim();
const evidence: Record<string, unknown> = { schemaVersion: 1, qualification,
  sourceSha: process.env.TEST_SOURCE_SHA, scenario, unit, machineId, outerMachineId, status: "failed", results: [],
  fullPlanQualification:"pending",sourcePathDeliveryQualification:"pending",
  unsupported: ["dangerous_or_incompatible_mutations", "derived_next_cleanup", "active_exclusion", "uncertain_failure_preservation",
    "legacy_clean_mutated_mode_unknown_bounds", "compressed_manifest_quarantine", "mount_toctou_crash_table", "original_30_source_path_delivery", "full_eight_acceptance_criteria"] };
let registered: ReturnType<typeof directoryIdentity> | undefined;
let invocationId: string | undefined;
let fragmentSha256: string | undefined;
let sink: DiagnosticSink | undefined;
let backing: ReturnType<typeof retainFullBackingBirth> | undefined;
const scenarioStarted = process.hrtime.bigint();
let deadline = earlier(workDeadline, scenarioStarted + milliseconds(22 * 60 * 1000));
const command = (file: string, args: readonly string[], timeout = 30000): string => boundedCommand(file, args, deadline, timeout);
try {
  remaining(deadline);
  directory(outbox);directory(outbox+"/current-full-pulses");directory(reviewed);
  assemble(root, owned + "/apt", source, toolchain, process.env.TEST_SOURCE_SHA!, machineId, scenario, () => remaining(deadline), geometry);
  remaining(deadline);
  // Boot replaces guest /run with tmpfs. Keep protected inputs outside it and
  // bind the same validated directories readonly into the exact guest paths.
  directory(fullReviewed);
  json(fullReviewed+"/input.json",{accountName:fullInput.accountName,reviewReference:fullInput.reviewReference,schemaVersion:1,sourceSha:fullInput.sourceSha});
  const publicFrom=root+"/run/TEST-real-codex-review";
  assert.equal(realpathSync(publicFrom),publicFrom);assert(!existsSync(publicReviewed));
  const publicFd=openSync(publicFrom,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(publicFd),named=lstatSync(publicFrom),leaf=lstatSync(publicFrom+"/input.json");
    assert(before.isDirectory() && before.uid===0 && before.gid===0 && (before.mode&0o7777)===0o700 && before.dev===named.dev && before.ino===named.ino && !named.isSymbolicLink());
    assert.deepEqual(readdirSync(publicFrom),["input.json"]);
    assert(leaf.isFile() && !leaf.isSymbolicLink() && leaf.uid===0 && leaf.gid===0 && leaf.nlink===1 && (leaf.mode&0o7777)===0o600 && leaf.size<=4096);
    renameSync(publicFrom,publicReviewed);
    const after=lstatSync(publicReviewed),held=fstatSync(publicFd),afterLeaf=lstatSync(publicReviewed+"/input.json");
    for(const key of ["dev","ino","uid","gid","mode"] as const){assert.equal(after[key],before[key]);assert.equal(held[key],before[key]);}
    for(const key of ["dev","ino","uid","gid","mode","size","mtimeMs","ctimeMs"] as const)assert.equal(afterLeaf[key],leaf[key]);
    assert.equal(realpathSync(publicReviewed),publicReviewed);
  }finally{closeSync(publicFd);}
  let dataImage: string | undefined;
  const storage = geometry === CurrentBackingGeometry.Adoptable ? currentBackingStorage : readonlyStorage;
  if (scenario === OwnedOsScenario.Readonly || geometry === CurrentBackingGeometry.Adoptable) {
    // Reserve real backing bytes before formatting, never a sparse capacity
    // claim. Retain the born image before formatting or service exposure; the
    // collector measures actual loop/mount joins without granting authority.
    const bytes = 6n * 1024n * 1024n * 1024n, free = statfsSync(owned, { bigint: true });
    assert(free.bavail * free.bsize >= bytes && free.ffree >= 100000n, "TEST readonly scratch capacity unavailable");
    dataImage = owned + "/readonly-data.ext4";
    const administrativeBeforeBirth = captureFullAdministrativeBirth(managedParent);
    const fd = openSync(dataImage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let inode: ReturnType<typeof fstatSync>;
    try { inode = fstatSync(fd); assert(inode.isFile() && inode.uid === 0 && inode.nlink === 1);
      backing = retainFullBackingBirth(id, fd, () => remaining(deadline), managedParent, administrativeBeforeBirth);
    }
    finally { closeSync(fd); }
    command("/usr/bin/fallocate", ["--length", String(bytes), dataImage], 60000);
    command("/usr/sbin/mkfs.ext4", ["-F", "-m", "0", "-N", "100000", dataImage], 60000);
    const current = lstatSync(dataImage); assert(current.dev === inode.dev && current.ino === inode.ino &&
      current.uid === 0 && current.nlink === 1 && (current.mode & 0o777) === 0o600 && BigInt(current.size) === bytes);
    evidence.readonlyImage = { path: dataImage, dev: String(current.dev), ino: String(current.ino), bytes: String(bytes),
      scratchAvailableBytes: String(free.bavail * free.bsize), scratchAvailableInodes: String(free.ffree),
      attachment: "owned service MountImages only; no runner mount operation" };
  }
  registered = directoryIdentity(root);
  if (diagnostic) sink = retainDiagnosticSink(root, registered);
  const packagePath = root + runtime + "/os-packages.json";
  const packageStat = lstatSync(packagePath); assert(packageStat.isFile() && packageStat.uid === 0 && packageStat.size < 65536);
  evidence.osPackageFacts = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!diagnostic) {
  try { evidence.ioUringControl = controlIoUringFixture(root, () => remaining(deadline)); }
  catch (error) {
    if (error instanceof IoUringControlFailure) evidence.ioUringControlFailure = error.observation;
    throw error;
  }
  assert.equal(fileDigest(root + node), fileDigest(process.execPath));
  // This trusted startup probe runs only in the newly extracted CI guest root,
  // before jobs, auth fixtures or systemd units. It cannot mount host libraries.
  const startup = spawnSync("/usr/sbin/chroot", [root, node, "--version"], { env: cleanEnv, cwd: "/",
    encoding: "utf8", timeout: Math.min(10000, remaining(deadline)), maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
  const versionOutput = startup.stdout?.trim() ?? "";
  evidence.nodePreboot = { status: startup.status, signal: startup.signal,
    errorCode: startup.error && "code" in startup.error && ["ENOENT", "EACCES", "ETIMEDOUT"].includes(String(startup.error.code))
      ? startup.error.code : startup.error ? "other" : null,
    version: /^v\d+\.\d+\.\d+$/.test(versionOutput) ? versionOutput : null,
    diagnostic: setupDiagnostic(startup.stderr ?? "") };
  assert(!startup.error && startup.status === 0 && startup.signal === null && versionOutput === process.version,
    "owned TEST pinned Node preboot failed");
  remaining(deadline);
  }
  const nspawn = root + "/usr/bin/systemd-nspawn";
  const version = command(nspawn, ["--version"]).split("\n")[0]!;
  assert.match(version, /^systemd 255(?:\.|\s)/);
  const launch = { schemaVersion: 1, purpose: "dependency-retention-owned-OS-TEST", unit, root: registered,
    machineId, outerMachineId, sourceSha: process.env.TEST_SOURCE_SHA, nspawnVersion: version, nspawnSha256: fileDigest(nspawn) };
  json(owned + "/registration.json", launch);
  evidence.launchRegistration = launch;
  const runtimeSeconds = Math.ceil(remaining(deadline) / 1000) + 90;
  const target = diagnostic ? "TEST-retention-bus-diagnostic.target" : "TEST-retention.target";
  managedParent.revalidate();
  const parentLiveBindings=managedParent.liveBindings().join(" ");
  const fragment = `[Unit]\nBindsTo=${managedParent.unit}\nAfter=${managedParent.unit}\nPartOf=${managedParent.unit}\nDescription=Owned disposable dependency TEST OS ${id}\n[Service]\nType=exec\nMemoryMax=6G\nMemorySwapMax=0\nTasksMax=1024\nCPUQuota=400%\nCPUQuotaPeriodSec=100ms\nDelegate=yes\nKillMode=control-group\nRestart=no\nRuntimeMaxSec=${runtimeSeconds}s\nTimeoutStopSec=30s\n${dataImage ? `MountImages=${dataImage}:${storage}\n` : ""}Environment=SYSTEMD_NSPAWN_USE_CGNS=1\nExecStart=${nspawn} --directory=${root} --machine=TEST-retention-${id} --register=no --keep-unit --private-users=no --boot --console=pipe --resolv-conf=off --capability=CAP_SYS_ADMIN,CAP_MKNOD,CAP_SETPCAP,CAP_SETFCAP,CAP_SYS_PTRACE ${dataImage ? `--bind=${storage} ` : ""}${inheritedHostMarker}${authBinding} ${parentLiveBindings} --bind-ro=${fullReviewed}:/run/TEST-full-flow-input --bind-ro=${publicReviewed}:/run/TEST-real-codex-review --bind=${outbox}:/run/TEST-full-flow-outbox --bind-ro=${reviewed}:/run/user/0/subscription-runtime-host-policy/codex-readonly-reviewed --setenv=SYSTEMD_UNIT_PATH=/etc/systemd/test-units:/run/systemd/system -- --unit=${target} --log-target=console\n`;
  const unitPath = "/run/systemd/system/" + unit;
  assert(!existsSync(unitPath)); writeFileSync(unitPath, fragment, { flag: "wx", mode: 0o644 });
  fragmentSha256 = fileDigest(unitPath);
  json(owned + "/unit-registration.json", { unit, fragmentSha256, sourceSha: process.env.TEST_SOURCE_SHA, root: registered, outerMachineId });
  evidence.fragmentSha256 = fragmentSha256;
  managedParent.registerGuest(id,root,fragmentSha256);
  command("/usr/bin/systemctl", ["daemon-reload"]);
  managedParent.revalidate();
  command("/usr/bin/systemctl", ["start", "--no-block", unit]);
  invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
  // A queued start may not yet have its invocation. Poll only this registered unit.
  const bootStarted = process.hrtime.bigint();
  const bootDeadline = earlier(deadline, bootStarted + milliseconds(90000));
  if (!diagnostic) {
    while (!invocationId) {
      remaining(bootDeadline, "owned TEST invocation readiness deadline exhausted");
      assert(["active", "activating"].includes(command("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"], Math.min(2000, remaining(bootDeadline))).trim()));
      invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], Math.min(2000, remaining(bootDeadline))).trim();
      if (!invocationId) await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining(bootDeadline))));
    }
    assert.match(invocationId, /^[a-f0-9]{32}$/);
    // Original once-only seal validates actual current systemctl invocation.
    // It must precede the pending ColdV2 request, not wait for guest evidence.
    managedParent.observeGuestInvocation(id, invocationId);
    evidence.invocationId = invocationId;
  }
  if (diagnostic) {
    evidence.observation = { purpose: "TEST_daemon_stderr_only", outcome: "unqualified", limitBytes: 65536, totalStartsLimit: 1 };
    const bootRemaining = () => remaining(bootDeadline, "owned TEST diagnostic boot deadline exhausted");
    while (process.hrtime.bigint() < bootDeadline) {
      remaining(deadline);
      const state = command("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"], Math.min(2000, bootRemaining())).trim();
      if (!invocationId) invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], Math.min(2000, bootRemaining())).trim();
      if (!["active", "activating"].includes(state)) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, bootRemaining())));
    }
    assert.match(invocationId ?? "", /^[a-f0-9]{32}$/); evidence.invocationId = invocationId;
    throw new Error("owned TEST diagnostic-only observation; qualification not attempted");
  }
  const path = root + runtime + "/guest-evidence.json";
  while (!existsSync(path)) {
    remaining(deadline);
    const intervalRequest=outbox+"/current-full-interval-request.json";
    if(existsSync(intervalRequest) && !evidence.backingIntervalQualified) {
      const stat=lstatSync(intervalRequest);assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && stat.nlink===1 && (stat.mode&0o7777)===0o600 && stat.size<=4096);
      const bytes=readFileSync(intervalRequest),request:unknown=JSON.parse(bytes.toString("utf8"));
      assert(isDependencyCustodyObject(request,"schemaVersion,sourceSha,runtimeManifestSha256") && request.schemaVersion===1 && request.sourceSha===fullInput.sourceSha && typeof request.runtimeManifestSha256==="string" && /^[a-f0-9]{64}$/.test(request.runtimeManifestSha256));
      assert(Buffer.from(JSON.stringify(request)+"\n").equals(bytes));assert(backing && registered && invocationId);
      observeGuestBoot(root,registered,unit,invocationId,deadline,undefined,(selection,handles)=>backing!.select(selection,handles));
      managedParent.revalidate();const facts=backing.qualify();
      evidence.backingIntervalQualified={purpose:"actual_original_parent_backing_interval",factsSha256:digest(JSON.stringify(facts)+"\n")};
    }
    if(evidence.backingIntervalQualified){
      assert(backing);const names=readdirSync(outbox+"/current-full-pulses");assert(names.length<=256);
      for(const name of names){if(/^\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name))continue;assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(name));
        const s=lstatSync(outbox+"/current-full-pulses/"+name);if(s.isFile() && s.nlink===2)continue;
        backing.pulse(outbox+"/current-full-pulses/"+name);
      }
    }
    const requestPath=outbox+"/cold-policy-request.json";
    if(existsSync(requestPath) && !evidence.independentPolicyRequest) {
      const stat=lstatSync(requestPath);assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid===0 && stat.gid===0 && stat.nlink===1 && (stat.mode&0o7777)===0o600 && stat.size<=16384);
      const bytes=readFileSync(requestPath),request:unknown=JSON.parse(bytes.toString("utf8"));
      assert(isDependencyCustodyObject(request,"candidateJobId,jobRoot,readonlyJobId,readonlyPaths,runtimeLaunch,runtimeManifestSha256,runtimeSha,schemaVersion,workspace") && request.schemaVersion===1);
      assert(Buffer.from(JSON.stringify(request)+"\n").equals(bytes));assert.equal(request.runtimeSha,fullInput.sourceSha);
      assert(backing && registered && invocationId);
      managedParent.revalidate();
      assert(evidence.backingIntervalQualified);
      observeGuestBoot(root, registered, unit, invocationId, deadline);
      assert.equal(command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], 2000).trim(), invocationId);
      const facts = backing.observe();
      assert.equal(command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], 2000).trim(), invocationId);
      backing.revalidate(); managedParent.revalidate();
      const factsPath = owned + "/cold-policy-backing-facts.json";
      json(factsPath, facts, 0o600);
      backing.revalidate(); managedParent.revalidate();
      evidence.independentBackingFacts = { purpose: "TEST_backing_facts_only_no_exclusion_authority", path: factsPath, sha256: fileDigest(factsPath) };
      // Factual request, not a positive REVIEW or generated issuer. ROOT's
      // independent reviewer installs exact protected bytes into this own inbox.
      evidence.independentPolicyRequest={purpose:"TEST_factual_policy_review_request_only",request,reviewedInputDirectory:reviewed};
      json(owned+"/policy-review-request.json",evidence.independentPolicyRequest);
    }
    const childFailure = root + runtime + "/guest-child-exit.json";
    if (existsSync(childFailure)) {
      const stat = lstatSync(childFailure); assert(stat.isFile() && stat.uid === 0 && stat.size < 4096);
      const failure = JSON.parse(readFileSync(childFailure, "utf8")) as Record<string, unknown>;
      assert.equal(failure.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(failure.purpose, "TEST_child_failure_observation_only");
      evidence.guestChildFailure = failure;
      throw new Error("owned TEST qualification child exited before evidence");
    }
    const started = root + runtime + "/guest-started.json";
    evidence.bootObservation = { purpose: "TEST_readiness_observation_only", phase: evidence.guestBootstrap ? "qualification" : "supervisor_start",
      supervisorMarkerPresent: existsSync(started), readinessLimitMs: 90000,
      readinessElapsedMs: Number((process.hrtime.bigint() - bootStarted) / 1000000n),
      scenarioRemainingMs: remaining(deadline), workRemainingMs: remaining(workDeadline) };
    if (!existsSync(started)) remaining(bootDeadline, "owned TEST guest supervisor readiness deadline exhausted");
    else if (!evidence.guestBootstrap) {
      const stat = lstatSync(started); assert(stat.isFile() && stat.uid === 0 && stat.size < 4096);
      const bootstrap = JSON.parse(readFileSync(started, "utf8")) as Record<string, unknown>;
      assert.equal(bootstrap.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(bootstrap.machineId, machineId);
      assert.equal(bootstrap.purpose, "TEST_bootstrap_observation_only"); evidence.guestBootstrap = bootstrap;
    }
    const state = command("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"]).trim();
    assert(["active", "activating"].includes(state), "owned TEST guest exited before evidence");
    if (!invocationId) invocationId = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"]).trim();
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining(deadline))));
  }
  assert.match(invocationId ?? "", /^[a-f0-9]{32}$/);
  evidence.invocationId = invocationId;
  const stat = lstatSync(path); assert(stat.isFile() && stat.uid === 0 && stat.size < 65536);
  const guest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(guest.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(guest.machineId, machineId);
  assert.equal(guest.qualification, qualification);
  evidence.guest = guest; evidence.status = guest.status;
  const outputPath = root + runtime + "/guest-output-observation.json";
  const outputDeadline = earlier(deadline, process.hrtime.bigint() + milliseconds(2000));
  while (!existsSync(outputPath)) {
    const allowance = Number((outputDeadline - process.hrtime.bigint()) / 1000000n);
    if (allowance <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, allowance)));
  }
  if (existsSync(outputPath)) {
    const outputStat = lstatSync(outputPath); assert(outputStat.isFile() && outputStat.uid === 0 && outputStat.nlink === 1 && outputStat.size < 16384);
    const output = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    assert.equal(output.sourceSha, process.env.TEST_SOURCE_SHA); assert.equal(output.purpose, "TEST_output_classification_only");
    evidence.guestOutputObservation = output;
  } else evidence.guestOutputObservationUnavailable = true;
  assert.equal(guest.status, "partial_pass", "actual four-entry measurement did not qualify");
  assertOuterIoUringPins(root);
  remaining(deadline);
} catch (error) {
  evidence.status = diagnostic ? "unqualified" : "failed";
  evidence.failure = "TEST_owned_current_full_flow_failed";
  process.exitCode = 1;
} finally {
  // Cleanup uses the separately reserved shared allowance, never another full
  // guest budget. Uncertain ownership/deadline failure remains failed/held.
  deadline = earlier(outerDeadline, process.hrtime.bigint() + milliseconds(90000));
  if (registered && existsSync("/run/systemd/system/" + unit)) {
    try {
      assert.deepEqual(directoryIdentity(root), registered);
      assert.equal(readFileSync("/etc/machine-id", "utf8").trim(), outerMachineId);
      const retained = JSON.parse(readFileSync(owned + "/unit-registration.json", "utf8")) as Record<string, unknown>;
      assert.deepEqual(retained, { unit, fragmentSha256, sourceSha: process.env.TEST_SOURCE_SHA, root: registered, outerMachineId });
      assert.equal(fileDigest("/run/systemd/system/" + unit), retained.fragmentSha256);
      const current = command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], 5000).trim();
      assert(invocationId && current === invocationId, "uncertain owned unit: leave held for VM disposal");
      if (evidence.status !== "partial_pass") {
        try {
        const shown = command("/usr/bin/systemctl", ["show", unit,
          "--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus"], 5000);
        const properties: Record<string, string> = {};
        for (const line of shown.trim().split("\n")) {
          const [key, value, ...extra] = line.split("=");
          assert(key && value !== undefined && extra.length === 0 && /^[A-Za-z0-9_-]{0,80}$/.test(value));
          assert(["ActiveState", "SubState", "Result", "ExecMainCode", "ExecMainStatus"].includes(key)); properties[key] = value;
        }
        const journal = spawnSync("/usr/bin/journalctl", ["--unit", unit, "--no-pager", "--output=cat", "--lines=80"],
          { env: { ...cleanEnv, TMPDIR: fullNativeTmpDir }, encoding: "utf8", timeout: Math.min(5000, remaining(deadline)), maxBuffer: 32768, stdio: ["ignore", "pipe", "pipe"] });
        evidence.ownedUnitFailure = { properties, journalDiagnostic: setupDiagnostic(journal.stdout ?? ""), journalStatus: journal.status };
        } catch { evidence.ownedUnitDiagnosticUnavailable = true; }
        try {
          // Observation starts only after failure and exact outer ownership
          // checks. Its own allowance cannot consume the stop reservation.
          const observationDeadline = earlier(deadline - milliseconds(60000), process.hrtime.bigint() + milliseconds(15000));
          evidence.guestBootFailure = observeGuestBoot(root, registered, unit, invocationId, observationDeadline, sink);
          assert.equal(command("/usr/bin/systemctl", ["show", unit, "--property=InvocationID", "--value"], 2000).trim(), invocationId);
        } catch { delete evidence.guestBootFailure; evidence.guestBootDiagnosticUnavailable = true; }
      }
      if (backing) { try { backing.revalidate(); } catch { evidence.backingFinalObservationUncertain = true; } }
      command("/usr/bin/systemctl", ["stop", unit], 45000);
      evidence.ownedOsStopped = true;
    } catch { evidence.status = "failed"; evidence.ownedOsStopped = false; process.exitCode = 1; }
  }
  if (backing && evidence.ownedOsStopped === true) {
    try { fullParentTerminal=backing.closeAfterTerminal();evidence.backingTerminal=fullParentTerminal; }
    catch { evidence.backingRetentionTerminalUnproven=true;evidence.status="failed";process.exitCode=1; }
  }
  else if (backing) evidence.backingRetentionTerminalUnproven = true;
  if (sink) { try { closeSync(sink.fd); } catch { evidence.status = "failed"; evidence.sinkCloseFailed = true; process.exitCode = 1; } }
  if (!diagnostic && existsSync(root + runtime + "/TEST-io-uring-probe.json")) {
    try { assertOuterIoUringPins(root); }
    catch { evidence.status = "failed"; evidence.ioUringPinBracketFailed = true; process.exitCode = 1; }
  }
  // No guest registry/root is deleted. VM disposal retains uncertain state until
  // the platform ends the owned job; export bounded sanitized facts only.
  if (process.hrtime.bigint() >= outerDeadline) {
    evidence.status = "failed"; evidence.budgetExhaustedDuringCleanup = true; process.exitCode = 1;
  }
  evidence.scenarioElapsedMs = Number((process.hrtime.bigint() - scenarioStarted) / 1000000n);
  assert(Buffer.byteLength(JSON.stringify(evidence)) <= 256 * 1024);
  json(owned + "/owned-evidence.json", evidence, 0o644);
}
return evidence;
}

type DiagnosticSink = Readonly<{ fd: number; birth: BigIntStats }>;
function sinkState(prefix: string, registered: ReturnType<typeof directoryIdentity>, sink: DiagnosticSink): BigIntStats {
  const retained: number[] = [];
  const mount = (fd: number) => { const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    assert(info.length <= 4096); const id = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(info)?.[1]; assert(id); return id; };
  try {
    const root = statSync(prefix, { bigint: true });
    assert(root.isDirectory() && (root.mode & 0o7777n) === 0o700n && String(root.dev) === registered.dev && String(root.ino) === registered.ino);
    let rootMount: string | undefined;
    for (const suffix of ["", "/var", "/var/lib", dirname(busDiagnosticSink)]) {
      const path = prefix + suffix, named = suffix ? lstatSync(path, { bigint: true }) : root;
      assert(named.isDirectory() && !named.isSymbolicLink() && named.uid === 0n && named.gid === 0n &&
        !(named.mode & 0o022n) && String(named.dev) === registered.dev);
      if (suffix === dirname(busDiagnosticSink)) assert.equal(named.mode & 0o7777n, 0o700n);
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (suffix ? constants.O_NOFOLLOW : 0)); retained.push(fd);
      const opened = fstatSync(fd, { bigint: true }); assert(opened.dev === named.dev && opened.ino === named.ino);
      rootMount ??= mount(fd); assert.equal(mount(fd), rootMount);
    }
    const path = prefix + busDiagnosticSink, named = lstatSync(path, { bigint: true });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); retained.push(fd);
    const actual = fstatSync(sink.fd, { bigint: true });
    for (const stat of [named, fstatSync(fd, { bigint: true }), actual]) {
      assert(stat.isFile() && stat.uid === 0n && stat.gid === 0n && stat.nlink === 1n &&
        (stat.mode & 0o7777n) === 0o600n && stat.dev === sink.birth.dev && stat.ino === sink.birth.ino);
      for (const key of ["size", "mtimeNs", "ctimeNs"] as const) assert.equal(stat[key], actual[key]);
    }
    assert.equal(mount(fd), rootMount); return actual;
  } finally { for (const fd of retained) closeSync(fd); }
}
function retainDiagnosticSink(root: string, registered: ReturnType<typeof directoryIdentity>): DiagnosticSink {
  const fd = openSync(root + busDiagnosticSink, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const sink = { fd, birth: fstatSync(fd, { bigint: true }) }; assert.equal(sinkState(root, registered, sink).size, 0n); return sink; }
  catch (error) { closeSync(fd); throw error; }
}
function classifyBusStderr(bytes: Uint8Array) {
  // Exact dbus-1.14.10 startup error prefixes; variable suffixes never escape.
  const prefixes = [
    ["missing_listen", "Configuration file needs one or more <listen> elements giving addresses"],
    ["missing_socket", "No socket received."], ["wrong_socket", "Passed socket has wrong type."],
    ["socket_acquisition", "Failed to acquire systemd socket:"], ["socket_type", "Failed to verify systemd socket type:"],
    ["unsupported_auth", "Unsupported auth mechanism \""], ["invalid_message_type", "Bad message type \""],
    ["xml_parse", "Error in file "], ["apparmor_context", "Error getting AppArmor context of bus:"],
    ["apparmor_required", "AppArmor mediation required but not present"],
    ["config_user_rule_scope", "<allow> rule cannot be per-user because it has bus-global semantics"],
    ["config_user_rule_scope", "<deny> rule cannot be per-user because it has bus-global semantics"],
  ] as const;
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n"); assert(lines.length <= 256);
  const labels = new Set<(typeof prefixes)[number][0] | "unclassified">();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = /^(?:dbus|dbus-daemon)\[[1-9][0-9]*\]: Failed to start message bus: (.*)$/.exec(line)?.[1];
    const matched = message === undefined ? [] : prefixes.filter(([, prefix]) => message.startsWith(prefix));
    for (const [label] of matched) labels.add(label); if (!matched.length) labels.add("unclassified");
  }
  return [...labels].sort();
}

// No result here can authorize a launch. Every query addresses only the
// registered owned guest's PID1 private socket, never a system-bus fallback.
function observeGuestBoot(root: string, registered: ReturnType<typeof directoryIdentity>, unit: string,
  invocationId: string, deadline: bigint, sink?: DiagnosticSink,
  backingObservation?: (selection: FullGuestSelection, handles: readonly number[]) => void): Record<string, unknown> {
  function proc(path: string, bound: number): string {
    remaining(deadline, "owned TEST boot diagnostic allowance exhausted");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const bytes = Buffer.alloc(bound + 1); let size = 0, count = 0;
      while ((count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) { size += count; assert(size <= bound); }
      return bytes.subarray(0, size).toString("utf8");
    } finally { closeSync(fd); }
  }
  const pinsPath = root + runtime + "/os-signed-elf-pins.json";
  const pinsStat = lstatSync(pinsPath); assert(pinsStat.isFile() && pinsStat.uid === 0 && pinsStat.nlink === 1 &&
    (pinsStat.mode & 0o777) === 0o600 && pinsStat.size <= 128 * 1024);
  const signed = JSON.parse(proc(pinsPath, 128 * 1024)) as { schemaVersion: unknown; pins: unknown };
  assert(signed.schemaVersion === 1 && Array.isArray(signed.pins) && signed.pins.length <= 20000);
  const busPins = signed.pins.filter((pin: unknown): pin is { path: string; sha256: string } => {
    if (!pin || typeof pin !== "object" || !("path" in pin) || !("sha256" in pin)) return false;
    return pin.path === "/usr/bin/systemctl" && typeof pin.sha256 === "string" && /^[a-f0-9]{64}$/.test(pin.sha256);
  });
  assert.equal(busPins.length, 1);
  const systemctl = root + "/usr/bin/systemctl", binary = lstatSync(systemctl, { bigint: true });
  assert(binary.isFile() && binary.uid === 0n && binary.nlink === 1n && (binary.mode & 0o6022n) === 0n &&
    binary.size > 0n && binary.size <= 32n * 1024n * 1024n);
  assert.equal(fileDigest(systemctl), busPins[0]!.sha256);
  const binaryIdentity = { dev: String(binary.dev), ino: String(binary.ino), bytes: String(binary.size), sha256: busPins[0]!.sha256 };
  const group = "/system.slice/" + unit;
  assert.equal(boundedCommand("/usr/bin/systemctl", ["show", unit, "--property=ControlGroup", "--value"], deadline, 2000).trim(), group);
  const pids = new Set<number>(); let groups = 0;
  function scan(path: string, depth: number): void {
    assert(++groups <= 128 && depth <= 8); remaining(deadline);
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink());
    for (const row of proc(path + "/cgroup.procs", 32768).trim().split("\n").filter(Boolean)) {
      assert(/^[1-9][0-9]*$/.test(row)); pids.add(Number(row)); assert(pids.size <= 256);
    }
    const names = readdirSync(path); assert(names.length <= 512);
    for (const name of names) { assert(/^[A-Za-z0-9_.:@-]+$/.test(name));
      const child = lstatSync(path + "/" + name); if (child.isDirectory()) scan(path + "/" + name, depth + 1); }
  }
  scan("/sys/fs/cgroup" + group, 0);
  const candidates = [...pids].filter(pid => {
    try { const ids = /^NSpid:\s+([0-9 \t]+)$/m.exec(proc(`/proc/${pid}/status`, 16384))?.[1]?.trim().split(/\s+/).map(Number);
      return ids && ids.length >= 2 && ids[0] === pid && ids.at(-1) === 1;
    } catch { return false; }
  });
  assert.equal(candidates.length, 1); const pid = candidates[0]!;
  function identity() {
    const currentBinary = lstatSync(systemctl, { bigint: true });
    assert(currentBinary.isFile() && currentBinary.uid === 0n && currentBinary.nlink === 1n && (currentBinary.mode & 0o6022n) === 0n &&
      currentBinary.dev === binary.dev && currentBinary.ino === binary.ino && currentBinary.size === binary.size);
    assert.equal(fileDigest(systemctl), binaryIdentity.sha256);
    const status = proc(`/proc/${pid}/status`, 16384); assert.match(status, /^Uid:\s+0\s+0\s+0\s+0$/m);
    const ids = /^NSpid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
    assert(ids && ids.length >= 2 && ids[0] === pid && ids.at(-1) === 1);
    const cg = proc(`/proc/${pid}/cgroup`, 4096).trim(); assert(cg === "0::" + group || cg.startsWith("0::" + group + "/"));
    const stat = proc(`/proc/${pid}/stat`, 4096), fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    assert.match(fields[19] ?? "", /^[1-9][0-9]*$/);
    const currentRoot = statSync(`/proc/${pid}/root`, { bigint: true });
    assert(currentRoot.isDirectory() && String(currentRoot.dev) === registered.dev && String(currentRoot.ino) === registered.ino);
    assert.deepEqual(directoryIdentity(root), registered);
    const exe = statSync(`/proc/${pid}/exe`, { bigint: true }), expected = lstatSync(root + "/usr/lib/systemd/systemd", { bigint: true });
    assert(expected.isFile() && expected.uid === 0n && expected.nlink === 1n && (expected.mode & 0o022n) === 0n);
    assert(exe.dev === expected.dev && exe.ino === expected.ino);
    const mnt = readlinkSync(`/proc/${pid}/ns/mnt`), pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`);
    assert(mnt !== readlinkSync("/proc/self/ns/mnt") && pidNamespace !== readlinkSync("/proc/self/ns/pid"));
    // /run is the guest's runtime tmpfs, visible through the authenticated
    // process-root magic link, not the underlying extracted host directory.
    const socket = lstatSync(`/proc/${pid}/root/run/systemd/private`, { bigint: true }); assert(socket.isSocket() && socket.uid === 0n);
    const descriptors = readdirSync(`/proc/${pid}/fd`); assert(descriptors.length <= 4096); const held = new Set<string>();
    for (const fd of descriptors) { assert(/^[0-9]+$/.test(fd));
      try { const match = /^socket:\[([1-9][0-9]*)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (match) held.add(match[1]!); }
      catch { /* A concurrently closed FD supplies no listener identity. */ }
    }
    const rows = proc(`/proc/${pid}/net/unix`, 2 * 1024 * 1024).trim().split("\n").slice(1); assert(rows.length <= 65536);
    const listeners = rows.map(row => row.trim().split(/\s+/)).filter(row => row.length === 8 && row[7] === "/run/systemd/private" &&
      row[4] === "0001" && (Number.parseInt(row[3]!, 16) & 0x10000) !== 0 && held.has(row[6]!));
    assert.equal(listeners.length, 1);
    return { pid, birth: fields[19]!, invocationId, group: cg, rootDev: registered.dev, rootIno: registered.ino,
      mnt, pidNamespace, listenerInode: listeners[0]![6]!, socketDev: String(socket.dev), socketIno: String(socket.ino) };
  }
  const before = identity(); const observations: unknown[] = [], retained: number[] = [];
  try {
  // Retained namespace/root handles prevent a target PID reuse between the
  // checks and nsenter from redirecting even a read-only query outside TEST.
  for (const suffix of ["ns/mnt", "ns/pid", "root"] as const)
    retained.push(openSync(`/proc/${pid}/${suffix}`, constants.O_RDONLY));
  assert.equal(String(fstatSync(retained[0]!, { bigint: true }).ino), /^mnt:\[([0-9]+)\]$/.exec(before.mnt)?.[1]);
  assert.equal(String(fstatSync(retained[1]!, { bigint: true }).ino), /^pid:\[([0-9]+)\]$/.exec(before.pidNamespace)?.[1]);
  const retainedRoot = fstatSync(retained[2]!, { bigint: true }); assert(retainedRoot.isDirectory() &&
    String(retainedRoot.dev) === registered.dev && String(retainedRoot.ino) === registered.ino);
  assert.deepEqual(identity(), before);
  if (backingObservation) { backingObservation(before, retained); assert.deepEqual(identity(), before); }
  function query(name: "dbus.socket" | "dbus.service" | "TEST-retention-supervisor.service" | "TEST-retention.target") {
      assert.deepEqual(identity(), before);
      const keys = ["Id", "LoadState", "ActiveState", "SubState", "Job", "Result", "MainPID", "ExecMainCode", "ExecMainStatus", "TimeoutStartUSec"];
      if (sink) keys.push("InvocationID", "NRestarts", "ControlGroup", "StartLimitBurst", "StartLimitIntervalUSec",
        "LimitFSIZE", "LimitCORE", "StandardError", "DropInPaths", "Restart", "Type");
      const result = spawnSync("/usr/bin/nsenter", ["--mount=/proc/self/fd/3", "--pid=/proc/self/fd/4", "--root=/proc/self/fd/5", "--wdns=/", "--",
        "/usr/bin/systemctl", "--system", "--no-pager", "--no-ask-password", "show", "--property=" + keys.join(","), "--", name],
        { env: { ...cleanEnv, DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/run/systemd/private" }, encoding: "utf8",
          timeout: Math.min(2000, remaining(deadline)), maxBuffer: 8192,
          stdio: ["ignore", "pipe", "pipe", retained[0]!, retained[1]!, retained[2]!] });
      assert.deepEqual(identity(), before);
      const rows = result.status === 0 && !result.error && result.signal === null ? result.stdout.trim().split("\n") : [];
      assert(rows.length <= keys.length); const properties: Record<string, string> = {};
      for (const row of rows) {
        const [key, value, ...extra] = row.split("=");
        assert(key && keys.includes(key) && value !== undefined && extra.length === 0 && !(key in properties));
        // Only fixed scalar status/timer fields, no paths, environment, raw
        // journal or arbitrary unit/provider names are copied to evidence.
        assert(key === "ControlGroup" ? value === "" || value === "/system.slice/dbus.service" || value === "/system.slice/dbus.socket" :
          key === "DropInPaths" ? value === "" || value === busDiagnosticDropInPath : /^[A-Za-z0-9_. -]{0,80}$/.test(value));
        if (key === "Id") assert.equal(value, name);
        properties[key] = value;
      }
      if (rows.length) assert(properties.Id === name && properties.LoadState && properties.ActiveState && properties.SubState);
      return { unit: name, status: result.status, signal: result.signal,
        failed: !!result.error, properties, diagnostic: setupDiagnostic(result.stderr ?? "") };
  }
  for (const name of sink ? ["dbus.socket", "dbus.service"] as const :
    ["dbus.socket", "dbus.service", "TEST-retention-supervisor.service", "TEST-retention.target"] as const) observations.push(query(name));
  let stderr: Record<string, unknown> | undefined;
  if (sink) {
    stderr = { capture: "unavailable", purpose: "TEST_fixed_unit_stderr_only" };
    try {
      const service = query("dbus.service"); const properties = service.properties;
      assert(service.status === 0 && !service.failed && service.signal === null && properties.MainPID === "0" &&
        properties.ActiveState === "failed" && properties.NRestarts === "0" && properties.Result === "exit-code" &&
        properties.ExecMainCode === "1" && /^[a-f0-9]{32}$/.test(properties.InvocationID ?? ""));
      assert(properties.StartLimitBurst === "1" && properties.StartLimitIntervalUSec === "infinity" &&
        properties.LimitFSIZE === "65536" && properties.LimitCORE === "0" && properties.StandardError === "append" &&
        properties.DropInPaths === busDiagnosticDropInPath && properties.Restart === "no" && properties.Type === "notify");
      const verifyDropIn = () => {
        for (const suffix of ["/etc", "/etc/systemd", "/etc/systemd/test-units", dirname(busDiagnosticDropInPath)]) {
          const parent = lstatSync(`/proc/${pid}/root` + suffix, { bigint: true });
          assert(parent.isDirectory() && parent.uid === 0n && parent.gid === 0n && !(parent.mode & 0o022n));
        }
        const path = `/proc/${pid}/root` + busDiagnosticDropInPath, prior = lstatSync(path, { bigint: true });
        assert(prior.isFile() && prior.uid === 0n && prior.gid === 0n && prior.nlink === 1n &&
          (prior.mode & 0o7777n) === 0o644n && prior.size <= 4096n); assert.equal(proc(path, 4096), busDiagnosticDropIn);
        const after = lstatSync(path, { bigint: true });
        for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], prior[key]);
      };
      const quiescent = () => {
        assert.equal(statfsSync(`/proc/${pid}/root/sys/fs/cgroup`, { bigint: true }).type, 0x63677270n);
        let visited = 0;
        function empty(path: string, depth: number): void {
          remaining(deadline); assert(++visited <= 32 && depth <= 4);
          assert(lstatSync(path).isDirectory()); assert.equal(proc(path + "/cgroup.procs", 4096).trim(), "");
          const names = readdirSync(path); assert(names.length <= 256);
          for (const name of names) { assert(/^[A-Za-z0-9_.:@-]+$/.test(name));
            const child = lstatSync(path + "/" + name); if (child.isDirectory()) empty(path + "/" + name, depth + 1); }
        }
        const path = `/proc/${pid}/root/sys/fs/cgroup/system.slice/dbus.service`;
        try { lstatSync(path); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); return; }
        empty(path, 0);
      };
      verifyDropIn(); quiescent(); assert.deepEqual(identity(), before); remaining(deadline);
      const prior = sinkState(`/proc/${pid}/root`, registered, sink); sinkState(root, registered, sink);
      assert(prior.size < 65536n); const bytes = Buffer.alloc(65536); let size = 0, count = 0;
      while ((count = readSync(sink.fd, bytes, size, bytes.length - size, size)) > 0) { size += count; assert(size < 65536); }
      const after = sinkState(`/proc/${pid}/root`, registered, sink); sinkState(root, registered, sink);
      for (const key of ["size", "mtimeNs", "ctimeNs"] as const) assert.equal(after[key], prior[key]);
      assert.equal(BigInt(size), prior.size); verifyDropIn(); quiescent(); assert.deepEqual(identity(), before);
      assert.deepEqual(query("dbus.service").properties, properties); remaining(deadline);
      stderr = { purpose: "TEST_fixed_unit_stderr_only", capture: size ? "observed" : "empty",
        bytes: size, dev: String(prior.dev), ino: String(prior.ino), serviceInvocationId: properties.InvocationID,
        classifications: classifyBusStderr(bytes.subarray(0, size)) };
    } catch { stderr = { purpose: "TEST_fixed_unit_stderr_only", capture: "inconclusive" }; }
  }
  assert.deepEqual(identity(), before);
  return { purpose: "TEST_failed_guest_boot_observation_only", invocationId, pid1: before,
    address: "unix:path=/run/systemd/private", systemctl: binaryIdentity, observations, ...(sink ? { stderr } : {}) };
  } finally { for (const fd of retained) closeSync(fd); }
}
