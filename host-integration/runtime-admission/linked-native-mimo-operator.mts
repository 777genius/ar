#!/usr/bin/env node
/** Fixed TEST-only initial-root service bootstrap. It never owns detached native workers. */
import assert from "node:assert/strict";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const Operation = { Start: "start", Status: "status", Stop: "stop" } as const;
type Operation = (typeof Operation)[keyof typeof Operation];
const OuterState = { Live: "live", Terminal: "terminal", Unknown: "unknown" } as const;
type OuterState = (typeof OuterState)[keyof typeof OuterState];
type Json = Record<string, unknown>;
type Request = { schemaVersion: 1; operationId: string; expectedMachineId: string; expectedBootId: string;
  runtimeDirectory: string; expectedArtifactSha256: string; expectedNodeSha256: string; expectedRunnerSha256: string;
  expectedOperatorSha256: string; configPath: string; configSha256: string; testParentDirectory: string };
type Identity = { invocationId: string; fragmentSha256: string; process: { pid: number; birthTicks: string } | null };
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
function check(value: unknown, code: string): asserts value { assert(value, "TEST_operator_" + code); }
function object(value: unknown): Json { check(value && typeof value === "object" && !Array.isArray(value), "object_required"); return value as Json; }
function finiteCode(error: unknown): string { return error instanceof Error ? /^[A-Za-z][A-Za-z0-9_]{0,159}(?=[:;\s]|$)/.exec(error.message)?.[0] ?? "TEST_operator_failed" : "TEST_operator_failed"; }
function custody(path: string, privateLeaf = false): void {
  check(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path), "canonical_path_required");
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    check(!stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022) && (current === path || stat.isDirectory()) && (!privateLeaf || current !== path || !(stat.mode & 0o077)), "custody_required");
    if (current === "/") return;
  }
}
function privateBytes(path: string, maximum = 65536, privateLeaf = true): Buffer {
  custody(path, privateLeaf); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); check(before.isFile() && before.uid === 0 && !(before.mode & (privateLeaf ? 0o077 : 0o022)) && before.nlink === 1 && before.size <= maximum, "private_file_required");
    const bytes = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path);
    check(bytes.length === before.size && before.ino === current.ino && before.dev === current.dev && before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs && before.size === after.size && !current.isSymbolicLink(), "private_file_changed"); return bytes;
  } finally { closeSync(fd); }
}
function createBytes(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
const help = `Fixed TEST bootstrap only; no host-job profile or global activation is installed or widened.
The ordinary host-job-cli payload is contained and cannot satisfy the native initial-root operator requirement.
This bounded administrator bootstrap creates one owned root system service in the initial host namespaces. It never launches an arbitrary payload.

Prepare through the authorized installation/bootstrap channel, without starting providers:
1. Stage both .mts files in the immutable root-owned qualified candidate at host-integration/runtime-admission/. Build/typecheck there with npm run typecheck before qualification.
2. Independently qualify the candidate artifact, Node executable and both script SHA256 values. Use an approved Linux TEST host with no global/managed policy fences and existing native scratch/systemd/provider prerequisites.
3. Create a fresh root:root 0700 empty directory under the approved scratch parent named exactly TEST-linked-native-operator-OPERATION_UUID. Stage the harness config and this request in a separate canonical root-private operator directory (0700/0600); never include credentials.
4. The config has exactly the harness --help fields; runtimeDirectory, expectedArtifactSha256, expectedMachineId and testParentDirectory must equal this request. Source candidateCommit remains independently qualified in that config.

Closed request schema (all fields required; no argv/environment/service-property fields):
{"schemaVersion":1,"operationId":"lowercase-UUID","expectedMachineId":"32-hex","expectedBootId":"lowercase-UUID","runtimeDirectory":"/QUALIFIED/CANDIDATE","expectedArtifactSha256":"64-hex","expectedNodeSha256":"64-hex","expectedRunnerSha256":"64-hex","expectedOperatorSha256":"64-hex","configPath":"/ROOT-PRIVATE/TEST/config.json","configSha256":"64-hex-exact-config-bytes","testParentDirectory":"/APPROVED-SCRATCH/TEST-linked-native-operator-OPERATION_UUID"}

Exact bounded admin-bootstrap invocation, using the qualified Node and exact request-byte SHA256:
  /usr/bin/timeout --foreground --kill-after=5s 180s /QUALIFIED/NODE /QUALIFIED/CANDIDATE/host-integration/runtime-admission/linked-native-mimo-operator.mts start /ROOT-PRIVATE/TEST/request.json REQUEST_SHA256
Use the same paths, operation UUID and digest with status or stop. A repeated start only inspects the existing record; it never resubmits.
No nohup/disown/setsid/background shell or direct harness fallback. Long work runs only in the owned fixed service (60-second start-job deadline including queueing, 30-second activation, 45-minute active-runtime limit, 120-second stop; no restart).

Outer service completion/stop does not prove detached native cleanup. The harness report retains every planned job, exact start and unsettled public exchange. This operator reports that evidence location and always retains native reconciliation separately; preserve unknowns, pins and evidence. Never retry an uncertain launch with a new UUID as recovery.
`;
if (process.argv.includes("--help")) process.stdout.write(help);
else await main().catch(error => { process.stderr.write(JSON.stringify({ outcome: "unknown-retained", code: finiteCode(error), nativeReconciliationRequired: true }) + "\n"); process.exitCode = 1; });

async function main(): Promise<void> {
  check(process.argv.length === 5 && Object.values(Operation).includes(process.argv[2] as Operation) && digest.test(process.argv[4]!), "use_help");
  const operation = process.argv[2] as Operation, requestPath = process.argv[3]!, requestSha256 = process.argv[4]!;
  check(process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0, "initial_root_required");
  const requestBytes = privateBytes(requestPath); check(hash(requestBytes) === requestSha256, "request_digest_changed");
  const value = object(JSON.parse(requestBytes.toString("utf8"))), fields = ["schemaVersion", "operationId", "expectedMachineId", "expectedBootId", "runtimeDirectory", "expectedArtifactSha256", "expectedNodeSha256", "expectedRunnerSha256", "expectedOperatorSha256", "configPath", "configSha256", "testParentDirectory"];
  check(Object.keys(value).sort().join() === fields.sort().join() && value.schemaVersion === 1, "request_shape");
  const request = value as unknown as Request;
  check(uuid.test(request.operationId) && uuid.test(request.expectedBootId) && /^[a-f0-9]{32}$/.test(request.expectedMachineId), "request_identity");
  for (const name of ["expectedArtifactSha256", "expectedNodeSha256", "expectedRunnerSha256", "expectedOperatorSha256", "configSha256"] as const) check(digest.test(request[name]), "request_digest");
  for (const path of [request.runtimeDirectory, request.testParentDirectory, request.configPath, process.execPath]) custody(path, path === request.configPath || path === request.testParentDirectory);
  check(basename(request.testParentDirectory) === "TEST-linked-native-operator-" + request.operationId && lstatSync(request.testParentDirectory).isDirectory(), "dedicated_TEST_parent_required");
  const runner = join(request.runtimeDirectory, "host-integration/runtime-admission/linked-native-mimo-smoke.mts");
  const operator = join(request.runtimeDirectory, "host-integration/runtime-admission/linked-native-mimo-operator.mts");
  custody(runner); custody(operator); check(realpathSync(fileURLToPath(import.meta.url)) === operator, "operator_candidate_mismatch");
  check(hash(privateBytes(runner, 1024 * 1024, false)) === request.expectedRunnerSha256 && hash(privateBytes(operator, 1024 * 1024, false)) === request.expectedOperatorSha256, "script_digest_changed");
  const moduleUrl = (name: string): string => pathToFileURL(join(request.runtimeDirectory, "dist", name + ".js")).href;
  const files: typeof import("../../src/worker-codex/research-launch-files") = await import(moduleUrl("worker-codex/research-launch-files"));
  const host: typeof import("../../src/worker-codex/research-launch-host") = await import(moduleUrl("worker-codex/research-launch-host"));
  const admission: typeof import("../../src/worker-codex/research-launch-admission") = await import(moduleUrl("worker-codex/research-launch-admission"));
  host.assertResearchInitialRoot(true);
  const machine = host.researchProcessIdentity(); check(machine.machineId === request.expectedMachineId && machine.bootId === request.expectedBootId, "machine_or_boot_changed");
  check(admission.installedResearchRuntimeDirectory() === request.runtimeDirectory && files.researchArtifactDigest(request.runtimeDirectory) === request.expectedArtifactSha256, "artifact_qualification_changed");
  check(host.researchExecutableDigest(process.execPath) === request.expectedNodeSha256, "node_digest_changed");
  const configBytes = privateBytes(request.configPath); check(hash(configBytes) === request.configSha256, "config_digest_changed");
  const config = object(JSON.parse(configBytes.toString("utf8"))), configFields = ["schemaVersion", "runtimeDirectory", "candidateCommit", "expectedArtifactSha256", "expectedMachineId", "testParentDirectory", "authRootDir", "codexBinaryPath"];
  check(Object.keys(config).sort().join() === configFields.sort().join() && config.schemaVersion === 1 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(config.candidateCommit)), "harness_config_shape");
  for (const name of ["runtimeDirectory", "expectedArtifactSha256", "expectedMachineId", "testParentDirectory"] as const) check(config[name] === request[name], "harness_config_binding");
  const authority = join(files.researchAuthorityRoot, "test-operators"); files.researchPrivateDirectory(files.researchAuthorityRoot); files.researchPrivateDirectory(authority);
  const directory = join(authority, request.operationId), specPath = join(directory, "spec.json"), bindingPath = join(directory, "binding.json");
  const unit = "subscription-runtime-test-operator-" + request.operationId + ".service", description = "subscription-runtime-test-operator:" + requestSha256;
  const stagedConfig = join(directory, "config.json"), stdout = join(directory, "stdout.jsonl"), stderr = join(directory, "stderr.jsonl");
  const fixedArgv = [process.execPath, runner, "--allow-live", stagedConfig];
  const show = (): Json => {
    const output = host.researchCommand("/usr/bin/systemctl", ["show", unit, "--no-pager", "--property=Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,Description,Transient,FragmentPath,DropInPaths,KillMode,Restart,User,Group,ExecStart,RuntimeMaxUSec,TimeoutStartUSec,TimeoutStopUSec,JobTimeoutUSec,Slice,TasksMax,MemoryMax,CPUQuotaPerSecUSec,LimitCORE,UMask"]);
    return Object.fromEntries(output.trim().split("\n").map(line => { const index = line.indexOf("="); check(index > 0, "unit_observation_invalid"); return [line.slice(0, index), line.slice(index + 1)]; }));
  };
  const queued = (): boolean => host.researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]).trim().split("\n").some(line => { const parts = line.trim().split(/\s+/); return parts[1] === unit && parts[2] === "start"; });
  const parent = lstatSync(request.testParentDirectory), parentIdentity = { device: parent.dev, inode: parent.ino };
  let spec: Json;
  if (operation === Operation.Start && !existsSync(directory)) {
    host.assertResearchSharedHost(); check(readdirSync(request.testParentDirectory).length === 0, "TEST_parent_not_empty");
    check(show().LoadState === "not-found" && !queued(), "unowned_unit_collision");
    mkdirSync(directory, { mode: 0o700 }); // Exclusive operation birth; a crash is retained, never replayed.
    createBytes(join(directory, "request.json"), requestBytes); createBytes(stagedConfig, configBytes);
    createBytes(stdout, Buffer.alloc(0)); createBytes(stderr, Buffer.alloc(0));
    spec = { schemaVersion: 1, requestSha256, request, unit, description, nodePath: process.execPath, runner, stagedConfig, parentIdentity, createdAt: new Date().toISOString() };
    files.researchPublish(specPath, spec, true);
    // A durable unknown precedes submission. Losing transport never authorizes replay.
    files.researchPublish(join(directory, "submission.json"), { phase: "uncertain", requestSha256 }, true);
    try {
      host.researchCommand("/usr/bin/systemd-run", ["--quiet", `--unit=${unit}`, `--description=${description}`, `--working-directory=${request.testParentDirectory}`, "--service-type=exec", "--expand-environment=no",
        ...["User=root", "Group=root", "Slice=system.slice", "KillMode=control-group", "Restart=no", "RuntimeMaxSec=2700", "JobTimeoutSec=60", "TimeoutStartSec=30", "TimeoutStopSec=120", "TasksMax=128", "MemoryMax=1G", "CPUQuota=100%", "LimitCORE=0", "UMask=0077", `StandardOutput=append:${stdout}`, `StandardError=append:${stderr}`].map(item => "--property=" + item), "--", ...fixedArgv]);
      files.researchPublish(join(directory, "submission.json"), { phase: "submitted", requestSha256 });
    } catch { /* Inspect the original unit below; no replacement is launched. */ }
  } else {
    check(existsSync(specPath), "operation_unknown_retained"); spec = object(files.researchJson(files.researchRead(specPath)));
  }
  check(spec.requestSha256 === requestSha256 && JSON.stringify(spec.request) === JSON.stringify(request) && spec.unit === unit && spec.description === description && spec.nodePath === process.execPath && spec.runner === runner && spec.stagedConfig === stagedConfig && JSON.stringify(spec.parentIdentity) === JSON.stringify(parentIdentity), "original_spec_changed");
  check(hash(privateBytes(stagedConfig)) === request.configSha256 && hash(privateBytes(join(directory, "request.json"))) === requestSha256, "staged_input_changed");
  const observation = (): { state: OuterState; fields: Json; identity?: Identity } => {
    const current = show(); check(current.Id === unit, "unit_id_changed");
    if (current.LoadState === "not-found") return { state: existsSync(bindingPath) && !queued() ? OuterState.Terminal : OuterState.Unknown, fields: current };
    check(current.Transient === "yes" && current.Description === description && current.DropInPaths === "" && current.FragmentPath === "/run/systemd/transient/" + unit && current.KillMode === "control-group" && current.Restart === "no" && current.User === "root" && current.Group === "root" && current.RuntimeMaxUSec === "45min" && current.TimeoutStartUSec === "30s" && current.TimeoutStopUSec === "2min" && current.JobTimeoutUSec === "1min" && current.Slice === "system.slice" && current.TasksMax === "128" && current.MemoryMax === "1073741824" && current.CPUQuotaPerSecUSec === "1s" && current.LimitCORE === "0" && current.UMask === "0077", "unit_properties_changed");
    const exec = String(current.ExecStart), prefix = "{ path=" + process.execPath + " ; argv[]=" + fixedArgv.join(" ") + " ; ignore_errors=no ;";
    check(exec.startsWith(prefix) && exec.split("{").length === 2 && exec.split("}").length === 2 && exec.endsWith("}"), "unit_command_changed");
    custody(String(current.FragmentPath)); const fragmentSha256 = hash(files.researchRead(String(current.FragmentPath), false));
    check(typeof current.InvocationID === "string" && /^[a-f0-9]{32}$/.test(current.InvocationID), "invocation_unknown");
    const pid = Number(current.MainPID); check(Number.isSafeInteger(pid) && pid >= 0, "pid_unknown");
    const process = pid > 0 ? host.researchProcessIdentity(pid) : null;
    if (process) check(process.machineId === machine.machineId && process.bootId === machine.bootId && process.controlGroup === "/system.slice/" + unit && current.ControlGroup === process.controlGroup && JSON.stringify(process.namespaces) === JSON.stringify(machine.namespaces), "operator_process_changed");
    const identity: Identity = { invocationId: current.InvocationID, fragmentSha256, process: process ? { pid: process.pid, birthTicks: process.birthTicks } : null };
    const live = current.ActiveState === "active" && current.SubState === "running" && pid > 0;
    const terminal = ["inactive", "failed"].includes(String(current.ActiveState)) && pid === 0 && !queued();
    if (existsSync(bindingPath)) {
      const original = object(files.researchJson(files.researchRead(bindingPath))) as unknown as Identity;
      check(original.invocationId === identity.invocationId && original.fragmentSha256 === identity.fragmentSha256 && (!process || JSON.stringify(original.process) === JSON.stringify(identity.process)), "original_lifetime_changed");
    } else if (live || terminal) files.researchPublish(bindingPath, identity, true);
    // A pending MainPID-zero service cannot bind a future process lifetime.
    else return { state: OuterState.Unknown, fields: current };
    return { state: live ? OuterState.Live : terminal ? OuterState.Terminal : OuterState.Unknown, fields: current, identity };
  };
  let outer = observation();
  if (operation === Operation.Stop && outer.state !== OuterState.Terminal) {
    check(outer.state === OuterState.Live && outer.identity?.process, "stop_original_owner_unknown");
    // Only this exact outer service. Detached native workers retain separate ownership.
    host.researchCommand("/usr/bin/systemctl", ["stop", "--no-block", unit]); outer = observation();
  }
  const children = readdirSync(request.testParentDirectory); check(children.length <= 1 && children.every(name => /^TEST-runtime-admission-[a-f0-9-]{36}$/.test(name)), "TEST_children_unknown");
  const reportPath = children[0] ? join(request.testParentDirectory, children[0], "report.json") : undefined;
  let harness: Json | undefined;
  if (reportPath && existsSync(reportPath)) {
    const report = object(JSON.parse(privateBytes(reportPath, 2 * 1024 * 1024).toString("utf8")));
    check(report.root === dirname(reportPath) && report.machineId === machine.machineId && report.bootId === machine.bootId && report.runtimeDirectory === request.runtimeDirectory && report.artifactSha256 === request.expectedArtifactSha256, "harness_report_binding_changed");
    harness = { outcome: report.outcome, completedAt: report.completedAt, plannedJobIds: report.plannedJobIds, starts: report.starts, publicRequests: report.publicRequests, cleanup: report.cleanup };
  }
  const result = { operation, operationId: request.operationId, requestSha256, directory, outer, reportPath, harness,
    nativeReconciliationRequired: true, retainedForReconciliation: true, nativeCleanupConclusion: "not-certified-by-outer-service" };
  files.researchPublish(join(directory, "last-observation.json"), result); process.stdout.write(JSON.stringify(result) + "\n");
  if (outer.state === OuterState.Unknown) process.exitCode = 1;
}
