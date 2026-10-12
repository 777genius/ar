#!/usr/bin/env node
/** Operator-only admission repair. No job creation, start, manifest or authority publication. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, isAbsolute, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { CodexGoalJobManifest } from "../../src/worker-codex/codex-goal-jobs";
import { isDeepStrictEqual } from "node:util";
import type { WorkerLaunchSpec, WorkerLaunchState } from "../../src/worker-codex/application/project-control/worker-launch-spec";

type Json = Readonly<Record<string, unknown>>;
export type RepairPlan = Readonly<{
  schemaVersion: 1; projectId: string; workstreamId: string; machineId: string; jobId: string;
  expectedBindingSha256: string; expectedControllerManifestSha256: string; expectedManifestSha256: string;
  expectedContractSha256: string; expectedStateSha256: string; expectedReceiptSha256: string;
  ownedPaths: readonly string[];
}>;
type Files = typeof import("../../src/worker-codex/research-launch-files");
type Host = typeof import("../../src/worker-codex/research-launch-host");
type Birth = typeof import("../../src/worker-codex/protected-job-birth");
type Admission = typeof import("../../src/worker-codex/application/project-control/codex-goal-project-pre-start-admission");
type Binding = typeof import("../../src/worker-codex/application/project-control/codex-goal-project-pre-start-binding");
type Core = typeof import("../../src/worker-core/index");
type Provider = typeof import("../../src/provider-codex/index");
type Builtin = typeof import("../../src/worker-codex/application/project-control/codex-goal-project-builtin-pre-start-admission");
type Locks = typeof import("../../src/worker-codex/codex-goal-project-workspace-lock");
type Deps = typeof import("../../src/worker-codex/codex-goal-mcp-project-control-deps");
type Policy = typeof import("../../src/worker-codex/codex-goal-mcp-project-controller-launch-policy");
type Mutation = typeof import("../../src/worker-codex/codex-goal-job-manifest-revision");
type Jobs = typeof import("../../src/worker-codex/codex-goal-jobs");
type Bridge = typeof import("../../src/worker-codex/hosted-mimo-project-bridge");
type Contract = typeof import("../../src/worker-codex/hosted-mimo-project-bridge-contract");
const digest = /^[a-f0-9]{64}$/;
const id = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, code: string): asserts value { assert(value, "mimo_admission_repair_" + code); }
function object(value: unknown): Json { check(value && typeof value === "object" && !Array.isArray(value), "object_required"); return value as Json; }
export function parseRepairPlan(value: unknown): RepairPlan {
  const row = object(value);
  const fields = ["schemaVersion", "projectId", "workstreamId", "machineId", "jobId", "expectedBindingSha256", "expectedControllerManifestSha256", "expectedManifestSha256", "expectedContractSha256", "expectedStateSha256", "expectedReceiptSha256", "ownedPaths"];
  check(Object.keys(row).sort().join() === fields.sort().join() && row.schemaVersion === 1, "plan_shape");
  for (const field of ["projectId", "workstreamId", "jobId"]) check(typeof row[field] === "string" && id.test(row[field]), "plan_identity");
  check(typeof row.machineId === "string" && /^[a-f0-9]{32}$/.test(row.machineId), "machine_identity");
  for (const field of fields.filter(field => field.startsWith("expected"))) check(typeof row[field] === "string" && digest.test(row[field]), "plan_digest");
  check(Array.isArray(row.ownedPaths) && row.ownedPaths.length > 0 && row.ownedPaths.length <= 256 && row.ownedPaths.every(path => typeof path === "string"), "owned_paths");
  for (const path of row.ownedPaths as string[]) {
    const parts = path.endsWith("/") ? path.slice(0, -1).split("/") : path.split("/");
    check(path.length <= 4096 && !/[\\\u0000-\u001f\u007f]/u.test(path) && parts.every(part => part !== "" && part !== "." && part !== ".."), "owned_path_invalid");
  }
  check(new Set(row.ownedPaths).size === row.ownedPaths.length, "owned_paths_duplicate");
  return row as RepairPlan;
}
export function buildRepairedAdmission(input: {
  readonly contract: WorkerLaunchSpec; readonly state: WorkerLaunchState; readonly receipt: Json;
  readonly manifest: CodexGoalJobManifest; readonly ownedPaths: readonly string[];
  readonly materialize: Builtin["materializeBuiltinWorkerLaunchSpec"];
}): { contract: WorkerLaunchSpec; state: WorkerLaunchState } {
  // Original materialization owns the work-key algorithm. Recompute only its
  // derived key, preserving all other caller and runtime-owned identity fields.
  const requested: Record<string, unknown> = { ...input.contract, ownedPaths: input.ownedPaths };
  for (const field of ["jobId", "workerId", "registryStatus", "jobRoot", "workspaceRoot", "promptPath", "workKey", "revision", "retryCount", "supersedes"]) delete requested[field];
  const result = input.materialize({ contract: requested, manifest: input.manifest }).contract as WorkerLaunchSpec;
  const expected = { ...input.contract, ownedPaths: [...input.ownedPaths], workKey: result.workKey };
  check(isDeepStrictEqual({ ...result, workerId: input.contract.workerId }, expected), "identity_change_denied");
  check(input.state.records.length === 1 && input.state.records[0]?.workKey === input.contract.workKey && input.state.records[0]?.status === "queued", "state_binding");
  check(input.receipt.status === "validated_not_launched", "never_authorized_required");
  return { contract: expected, state: { ...input.state, records: input.state.records.map(record => ({ ...record, workKey: result.workKey })) } };
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + "\n");
// The only process invocation is a bounded, fixed Linux atomic directory syscall.
// Both operands already belong to this exact root-owned job; no shell is involved.
const exchangeProgram = "import ctypes,os,sys\nl=ctypes.CDLL(None,use_errno=True)\nf=l.renameat2\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nf.restype=ctypes.c_int\ndef ident(s): return (s.st_dev,s.st_ino)\np,q,a,b=[tuple(map(int,sys.argv[i:i+2])) for i in (3,5,7,9)]\ndef stat(n,d): return os.stat(n,dir_fd=d,follow_symlinks=False)\nassert ident(os.fstat(3))==p and ident(os.fstat(4))==q and ident(stat(sys.argv[1],3))==a and ident(stat(sys.argv[2],4))==b\nr=f(3,os.fsencode(sys.argv[1]),4,os.fsencode(sys.argv[2]),2)\nif r: raise OSError(ctypes.get_errno(),'admission_directory_exchange_failed')\nassert ident(os.fstat(3))==p and ident(os.fstat(4))==q and ident(stat(sys.argv[1],3))==b and ident(stat(sys.argv[2],4))==a\nos.fsync(3)\nos.fsync(4)\n";
export function exchangeAdmissionDirectories(admissionRoot: string, stagedRoot: string): void {
  check(process.platform === "linux", "linux_exchange_required");
  const parents = [dirname(admissionRoot), dirname(stagedRoot)];
  const fds = parents.map(parent => openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  try {
    const roots = fds.map(fd => fstatSync(fd)), admission = lstatSync(admissionRoot), staged = lstatSync(stagedRoot);
    check(admission.isDirectory() && staged.isDirectory() && !admission.isSymbolicLink() && !staged.isSymbolicLink() && admission.dev === staged.dev, "exchange_directories_required");
    const assertParents = (): void => parents.forEach((parent, index) => {
      const named = lstatSync(parent), root = roots[index]!;
      check(named.dev === root.dev && named.ino === root.ino && !named.isSymbolicLink(), "exchange_parent_changed");
    });
    assertParents();
    execFileSync("/usr/bin/python3", ["-I", "-c", exchangeProgram, basename(admissionRoot), basename(stagedRoot),
      ...[...roots, admission, staged].flatMap(stat => [String(stat.dev), String(stat.ino)])],
      { timeout: 10000, stdio: ["pipe", "pipe", "pipe", ...fds], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    fds.forEach(fd => fsyncSync(fd)); assertParents();
  } finally { fds.forEach(fd => closeSync(fd)); }
}

/** First commit is the exchange. Precondition failures never rewrite admission;
 * failure after exchange retains both exact triples and audit for reconciliation. */
export async function publishRepairedAdmission(input: {
  readonly jobRootDir: string; readonly archiveRootDir: string; readonly operationSha256: string;
  readonly contract: WorkerLaunchSpec; readonly state: WorkerLaunchState; readonly receipt: Json;
  readonly assertCurrent: () => Promise<void>;
  readonly exchange: typeof exchangeAdmissionDirectories;
}): Promise<{ readonly retainedPreviousAdmissionPath: string; readonly receiptSha256: string }> {
  const admissionRoot = join(input.jobRootDir, "pre-start-admission");
  check(realpathSync(input.archiveRootDir) === input.archiveRootDir && !input.archiveRootDir.startsWith(input.jobRootDir + "/") && input.archiveRootDir !== input.jobRootDir &&
    lstatSync(input.archiveRootDir).isDirectory() && lstatSync(input.archiveRootDir).dev === lstatSync(input.jobRootDir).dev, "external_same_device_archive_required");
  const stagedRoot = join(input.archiveRootDir, basename(input.jobRootDir) + "." + input.operationSha256);
  check(digest.test(input.operationSha256), "operation_digest");
  const contractBytes = jsonBytes(input.contract), stateBytes = jsonBytes(input.state), receiptBytes = jsonBytes(input.receipt);
  check(contractBytes.length <= 262144 && stateBytes.length <= 1048576 && receiptBytes.length <= 65536, "artifact_size_limit");
  await input.assertCurrent();
  // Exclusive stage creation also makes an uncertain retry fail closed. Never
  // adopt or remove a pre-existing stage, including a previously exchanged one.
  mkdirSync(stagedRoot, { mode: 0o700 });
  createFile(join(stagedRoot, "contract.json"), contractBytes);
  createFile(join(stagedRoot, "state.json"), stateBytes);
  createFile(join(stagedRoot, "receipt.json"), receiptBytes);
  syncDirectory(stagedRoot); syncDirectory(input.archiveRootDir);
  await input.assertCurrent();
  input.exchange(admissionRoot, stagedRoot);
  check(readFileSync(join(admissionRoot, "receipt.json")).equals(receiptBytes), "publication_uncertain");
  return { retainedPreviousAdmissionPath: stagedRoot, receiptSha256: hash(receiptBytes) };
}

export type AdmissionRepairIdentity = Readonly<{ schemaVersion: 1; machineId: string; projectId: string; workstreamId: string; jobId: string }>;
export type PreviousStartHashes = Readonly<{ ownerSha256: string; requestSha256: string; resultSha256: string }>;
type Finalization = Readonly<{ priorPlan: RepairPlan; priorResult: Json }>;
function operatorBytes(path: string, maximum = 1048576): Buffer {
  check(isAbsolute(path) && resolve(path) === path, "proof_path");
  for (let current = path;; current = dirname(current)) {
    const stat = lstatSync(current);
    check(stat.uid === 0 && !stat.isSymbolicLink() && !(stat.mode & 0o022) && (current === path || stat.isDirectory()), "proof_custody");
    if (current === "/") break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    check(before.isFile() && before.nlink === 1n && !(before.mode & 0o077n) && before.size <= BigInt(maximum), "proof_file");
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    check(before.dev === named.dev && before.ino === named.ino && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs && BigInt(bytes.length) === before.size, "proof_changed");
    return bytes;
  } finally { closeSync(fd); }
}
function absent(path: string): boolean { try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } }
const witness = (path: string): string => {
  const stat = lstatSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(":");
};
const directoryIdentity = (path: string) => { const stat = lstatSync(path); check(stat.isDirectory() && !stat.isSymbolicLink(), "directory_required"); return { path, device: stat.dev, inode: stat.ino }; };
const relocationProgram = "import ctypes,os,sys\nl=ctypes.CDLL(None,use_errno=True)\nf=l.renameat2\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nf.restype=ctypes.c_int\ndef ident(s): return (s.st_dev,s.st_ino)\np,q,a=[tuple(map(int,sys.argv[i:i+2])) for i in (3,5,7)]\nassert ident(os.fstat(3))==p and ident(os.fstat(4))==q and ident(os.stat(sys.argv[1],dir_fd=3,follow_symlinks=False))==a\nr=f(3,os.fsencode(sys.argv[1]),4,os.fsencode(sys.argv[2]),1)\nif r: raise OSError(ctypes.get_errno(),'admission_archive_move_failed')\nassert ident(os.stat(sys.argv[2],dir_fd=4,follow_symlinks=False))==a\nos.fsync(3)\nos.fsync(4)\n";
export function relocateAdmissionArchive(source: string, destination: string): void {
  check(process.platform === "linux", "linux_archive_required");
  const parents = [dirname(source), dirname(destination)], fds = parents.map(path => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  try {
    const roots = fds.map(fd => fstatSync(fd)), archive = lstatSync(source);
    check(archive.isDirectory() && !archive.isSymbolicLink() && roots[0]!.dev === roots[1]!.dev && !existsSync(destination), "archive_destination");
    execFileSync("/usr/bin/python3", ["-I", "-c", relocationProgram, basename(source), basename(destination),
      ...[...roots, archive].flatMap(stat => [String(stat.dev), String(stat.ino)])],
      { timeout: 10000, stdio: ["pipe", "pipe", "pipe", ...fds], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    parents.forEach((path, index) => { const stat = lstatSync(path); check(stat.dev === roots[index]!.dev && stat.ino === roots[index]!.ino, "archive_parent_changed"); });
  } finally { fds.forEach(fd => closeSync(fd)); }
}
export function resolveRetainedAdmissionArchive(jobRootDir: string, archiveRootDir: string,
  priorPlanSha256: string, retainedPreviousAdmissionPath: unknown): { source: string; destination: string } {
  const legacySource = join(jobRootDir, ".admission-repair-" + priorPlanSha256);
  const destination = join(archiveRootDir, basename(jobRootDir) + "." + priorPlanSha256);
  check(retainedPreviousAdmissionPath === legacySource || retainedPreviousAdmissionPath === destination, "retained_archive_binding");
  return { source: retainedPreviousAdmissionPath, destination };
}
export async function finalizeRetainedAdmissionArchive(input: {
  readonly source: string; readonly destination: string; readonly priorPlanSha256: string;
  readonly priorHashes: Readonly<{ contract: string; state: string; receipt: string }>;
  readonly assertCurrent: () => Promise<void>; readonly proof?: Json;
  readonly move?: typeof relocateAdmissionArchive;
}): Promise<unknown> {
  await input.assertCurrent();
  const identity = directoryIdentity(input.source);
  const jobId = input.proof?.jobId ?? basename(dirname(input.source));
  check(typeof jobId === "string" && id.test(jobId), "archive_job_identity");
  const alreadyExternal = input.source === input.destination;
  if (alreadyExternal) check(basename(input.source) === jobId + "." + input.priorPlanSha256, "retained_archive_binding");
  else check(!existsSync(input.destination), "archive_destination_exists");
  await input.assertCurrent();
  check(isDeepStrictEqual(directoryIdentity(input.source), identity), "archive_directory_changed");
  if (!alreadyExternal) (input.move ?? relocateAdmissionArchive)(input.source, input.destination);
  check((alreadyExternal || !existsSync(input.source)) && directoryIdentity(input.destination).device === identity.device && directoryIdentity(input.destination).inode === identity.inode, "archive_move_uncertain");
  const receipt = { schemaVersion: 1, priorPlanSha256: input.priorPlanSha256, priorHashes: input.priorHashes,
    originalSource: input.source, archivePath: input.destination, archiveDirectory: { ...identity, path: input.destination }, ...input.proof };
  const receiptPath = join(dirname(input.destination), jobId + ".finalization.json");
  createFile(receiptPath, jsonBytes(receipt)); syncDirectory(dirname(receiptPath));
  return { ok: true, jobId, archivePath: input.destination, receiptPath,
    receiptSha256: hash(jsonBytes(receipt)), previousStart: input.proof?.previousStart ?? null };
}

async function operateHostedMimoJobAdmission(planPath: string | RepairPlan, expectedPlanSha256: string, runtimeDirectory: string,
  expectedArtifactSha256: string, finalization?: Finalization): Promise<unknown> {
  check(process.platform === "linux" && digest.test(expectedPlanSha256) && digest.test(expectedArtifactSha256), "operator_arguments");
  // Bootstrap chooses one reviewed ORIGINAL release, never a remote plan field.
  check(/^\/opt\/subscription-runtime\/releases\/[a-f0-9]{40}$/.test(runtimeDirectory) && realpathSync(runtimeDirectory) === runtimeDirectory, "original_runtime_required");
  const moduleUrl = (name: string): string => pathToFileURL(join(runtimeDirectory, "dist/worker-codex", name + ".js")).href;
  // Verify ancestry/custody before importing executable runtime bytes. This
  // standalone script itself is pinned by the finite trusted operator bootstrap.
  for (let path = runtimeDirectory;; path = dirname(path)) {
    const stat = lstatSync(path); check(stat.uid === 0 && !stat.isSymbolicLink() && !(stat.mode & 0o022), "runtime_custody");
    if (path === "/") break;
  }
  const files: Files = await import(moduleUrl("research-launch-files"));
  check(files.researchArtifactDigest(runtimeDirectory) === expectedArtifactSha256, "original_artifact_changed");
  const host: Host = await import(moduleUrl("research-launch-host"));
  host.assertResearchInitialRoot(true); host.assertResearchSharedHost();
  const privateBytes = (path: string, maximum = 1048576): Buffer => files.researchRead(path, true, maximum);
  const planBytes = typeof planPath === "string" ? privateBytes(planPath, 65536) : Buffer.from(JSON.stringify(parseRepairPlan(planPath)));
  check(planBytes.length <= 65536 && hash(planBytes) === expectedPlanSha256, "plan_changed");
  const plan = parseRepairPlan(JSON.parse(planBytes.toString()));
  check(host.researchProcessIdentity().machineId === plan.machineId, "machine_changed");
  const birth: Birth = await import(moduleUrl("protected-job-birth"));
  const jobs: Jobs = await import(moduleUrl("codex-goal-jobs"));
  const bridge: Bridge = await import(moduleUrl("hosted-mimo-project-bridge"));
  const contract: Contract = await import(moduleUrl("hosted-mimo-project-bridge-contract"));
  const request = contract.parseMimoProjectBridgeRequest({ kind: "MimoProject", schemaVersion: 1,
    operation: contract.MimoProjectBridgeOperation.Status, projectId: plan.projectId, workstreamId: plan.workstreamId, machineId: plan.machineId, jobId: plan.jobId });
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${plan.projectId}/${plan.workstreamId}.json`;
  const bindingBytes = bridge.hostedMimoBridgeMetadataBytes(bindingPath);
  check(hash(bindingBytes) === plan.expectedBindingSha256, "binding_changed");
  const binding = bridge.parseHostedMimoProjectBinding(JSON.parse(bindingBytes.toString()), request);
  const deps: Deps = await import(moduleUrl("codex-goal-mcp-project-control-deps"));
  const admission: Admission = await import(moduleUrl("application/project-control/codex-goal-project-pre-start-admission"));
  const bindingCapture: Binding = await import(moduleUrl("application/project-control/codex-goal-project-pre-start-binding"));
  const core: Core = await import(pathToFileURL(join(runtimeDirectory, "dist/worker-core/index.js")).href);
  const provider: Provider = await import(pathToFileURL(join(runtimeDirectory, "dist/provider-codex/index.js")).href);
  const builtin: Builtin = await import(moduleUrl("application/project-control/codex-goal-project-builtin-pre-start-admission"));
  const locks: Locks = await import(moduleUrl("codex-goal-project-workspace-lock"));
  const policy: Policy = await import(moduleUrl("codex-goal-mcp-project-controller-launch-policy"));
  const mutation: Mutation = await import(moduleUrl("codex-goal-job-manifest-revision"));
  const args = { registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId, jobId: plan.jobId };
  const controller = await deps.loadProjectControlController(args);
  const job = await jobs.readCodexGoalJob({ registryRootDir: binding.registryRootDir, jobId: plan.jobId });
  const descriptor = job.projectPreStartAdmission;
  check(descriptor && "mode" in descriptor && descriptor.mode === "serial-builtin", "builtin_required");
  admission.assertProjectPreStartAdmissionDescriptorPaths(descriptor, job.jobRootDir);
  check(plan.jobId !== controller.controller.jobId && job.jobRootDir === join(binding.stateRoot, "jobs", plan.jobId) &&
    job.workspacePath === join(binding.scratchRoot, "workspaces", plan.jobId) && job.accessBoundary === core.AccessBoundary.IsolatedWorkspaceWrite &&
    job.modelBackend === provider.CodexModelBackend.XiaomiMimoTokenPlan && controller.scope.projectId === binding.projectId, "job_scope_denied");
  files.researchCustody(realpathSync("/usr/bin/python3"));
  execFileSync("/usr/bin/python3", ["-I", "-c", "import ctypes; getattr(ctypes.CDLL(None),'renameat2')"], { timeout: 10000, stdio: "pipe", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const manifestPath = join(binding.registryRootDir, plan.jobId, "job.json"), controllerPath = join(binding.registryRootDir, controller.controller.jobId, "job.json");
  const observed = { contract: privateBytes(descriptor.contractPath, 262144), state: privateBytes(descriptor.statePath), receipt: privateBytes(descriptor.receiptPath, 65536) };
  const assertCurrent = async (): Promise<void> => {
    host.assertResearchInitialRoot(true); host.assertResearchSharedHost();
    check(host.researchProcessIdentity().machineId === plan.machineId && (typeof planPath !== "string" || privateBytes(planPath, 65536).equals(planBytes)) && bridge.hostedMimoBridgeMetadataBytes(bindingPath).equals(bindingBytes), "operator_binding_changed");
    check(hash(bridge.hostedMimoBridgeMetadataBytes(manifestPath, 1048576)) === plan.expectedManifestSha256 && hash(bridge.hostedMimoBridgeMetadataBytes(controllerPath, 1048576)) === plan.expectedControllerManifestSha256, "manifest_changed");
    for (const [name, expected] of [["contract", plan.expectedContractSha256], ["state", plan.expectedStateSha256], ["receipt", plan.expectedReceiptSha256]] as const) {
      check(hash(observed[name]) === expected && privateBytes(descriptor[`${name}Path`], name === "contract" ? 262144 : name === "receipt" ? 65536 : 1048576).equals(observed[name]), "admission_changed");
    }
    for (const manifest of [controller.controller, job]) check((await birth.observeProtectedCodexGoalJobBirth(manifest)).status === "released", "never_started_original_runtime_required");
    check(readdirSync(dirname(descriptor.contractPath)).sort().join() === "contract.json,receipt.json,state.json", "admission_extra_files");
    check(files.researchArtifactDigest(runtimeDirectory) === expectedArtifactSha256, "original_artifact_changed");
  };
  return await policy.withCurrentControllerLaunchPolicy({ registryRootDir: binding.registryRootDir, controllerJobId: binding.controllerJobId,
    expectedScope: controller.scope, loadCurrentController: () => deps.loadProjectControlController(args), effect: async () =>
      mutation.withCodexGoalRegistryMutation({ registryRootDir: binding.registryRootDir, requireExistingRegistryRoot: true, effect: async () =>
        locks.withProjectAdmissionPublicationLock({ registryRootDir: binding.registryRootDir, owner: "admission-repair:" + expectedPlanSha256, effect: async () =>
          locks.withValidatedProjectWorkspaceLock({ locks: locks.projectControlWorkspaceLocks(binding.registryRootDir), scope: controller.scope,
            requestedWorkspacePath: job.workspacePath, owner: "admission-repair:" + expectedPlanSha256, effect: async () => {
              await assertCurrent();
              await admission.assertProjectPreStartAdmissionLaunchBinding({ manifest: job, scope: controller.scope });
              const originalBinding = await bindingCapture.captureProjectPreStartBinding(job, descriptor);
              const archiveRootDir = join(binding.stateRoot, "admission-repair-archives");
              files.researchCustody(binding.stateRoot, true);
              try { mkdirSync(archiveRootDir, { mode: 0o700 }); syncDirectory(binding.stateRoot); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
              files.researchCustody(archiveRootDir, true);
              if (finalization) {
                const priorPlanSha256 = hash(JSON.stringify(finalization.priorPlan));
                const { source, destination } = resolveRetainedAdmissionArchive(job.jobRootDir, archiveRootDir,
                  priorPlanSha256, finalization.priorResult.retainedPreviousAdmissionPath);
                const pins = { contract: finalization.priorPlan.expectedContractSha256,
                  state: finalization.priorPlan.expectedStateSha256, receipt: finalization.priorPlan.expectedReceiptSha256 };
                const assertArchiveCurrent = async (): Promise<void> => {
                  await assertCurrent();
                  check(isDeepStrictEqual(await bindingCapture.captureProjectPreStartBinding(job, descriptor), originalBinding), "immutable_binding_changed");
                  files.researchCustody(source, true);
                  check(readdirSync(source).sort().join() === "contract.json,receipt.json,state.json", "archive_extra_files");
                  for (const name of ["contract", "state", "receipt"] as const)
                    check(hash(privateBytes(join(source, name + ".json"), name === "contract" ? 262144 : name === "receipt" ? 65536 : 1048576)) === pins[name], "archive_changed");
                };
                const startPrefix = join(binding.stateRoot, "mimo-bridge-operations", job.jobId + ".start");
                const startPaths = { owner: startPrefix + ".owner.json", request: startPrefix + ".request.json", result: startPrefix + ".result.json" };
                let previousStart: Json | null = null;
                if (Object.values(startPaths).some(path => existsSync(path))) {
                  const start = Object.fromEntries(Object.entries(startPaths).map(([name, path]) => [name, privateBytes(path)])) as Record<keyof typeof startPaths, Buffer>;
                  const startOwner = object(JSON.parse(start.owner.toString())), startRequest = object(JSON.parse(start.request.toString())), startResult = object(JSON.parse(start.result.toString()));
                  const startHash = hash(JSON.stringify(Object.fromEntries(Object.entries(startRequest).sort(([a], [b]) => a.localeCompare(b)))));
                  const unit = `subscription-runtime-mimo-project-${hash(startHash + ":0")}.service`;
                  check(startOwner.generation === 0 && startOwner.requestSha256 === startHash && startOwner.unit === unit &&
                    startRequest.operation === "start" && startRequest.jobId === job.jobId && startRequest.projectId === binding.projectId &&
                    startRequest.workstreamId === binding.workstreamId && startRequest.machineId === plan.machineId &&
                    startResult.ok === false && startResult.error === "project_control_admission_denied", "previous_start_not_admission_denied");
                  const unitState = Object.fromEntries(host.researchCommand("/usr/bin/systemctl", ["show", unit, "--property=Id,Description,LoadState,ActiveState,MainPID"]).trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
                  check(unitState.Id === unit && unitState.Description === startOwner.description && unitState.LoadState === "loaded" &&
                    ["inactive", "failed"].includes(unitState.ActiveState ?? "") && unitState.MainPID === "0", "previous_start_not_terminal");
                  check(!host.researchCommand("/usr/bin/systemctl", ["list-jobs", "--no-legend", "--no-pager"]).trim().split("\n").some(line => line.trim().split(/\s+/)[1] === unit), "previous_start_queued");
                  previousStart = { ownerSha256: hash(start.owner), requestSha256: hash(start.request), resultSha256: hash(start.result), terminalVerified: true };
                }
                const birthWitnesses = [controller.controller, job].map(manifest => {
                  const directory = directoryIdentity(manifest.jobRootDir);
                  const roots = [hash(manifest.jobRootDir), `physical-${directory.device}-${directory.inode}`];
                  const births = roots.map(key => { const path = join(files.researchAuthorityRoot, "job-births", key + ".json"); return { path, sha256: hash(privateBytes(path)), firstEffectPath: join(files.researchAuthorityRoot, "job-births", key + ".first-effect.json") }; });
                  return { directory, births };
                });
                await assertArchiveCurrent();
                const proof = { projectId: plan.projectId, workstreamId: plan.workstreamId, machineId: plan.machineId, jobId: job.jobId,
                  previousStart, runtimeDirectory, expectedArtifactSha256, birthWitnesses,
                  directories: [directoryIdentity(binding.registryRootDir), directoryIdentity(job.workspacePath)],
                  bindings: [{ path: bindingPath, sha256: hash(bindingBytes), witness: witness(bindingPath) },
                    { path: controllerPath, sha256: plan.expectedControllerManifestSha256, witness: witness(controllerPath) },
                    { path: manifestPath, sha256: plan.expectedManifestSha256, witness: witness(manifestPath) },
                    { path: job.promptPath, sha256: originalBinding.promptSha256, witness: witness(job.promptPath) },
                    ...(["contract", "state", "receipt"] as const).map(name => ({ path: descriptor[`${name}Path`], sha256: hash(observed[name]), witness: witness(descriptor[`${name}Path`]) }))] };
                const finalized = await finalizeRetainedAdmissionArchive({ source, destination, priorPlanSha256,
                  priorHashes: pins, assertCurrent: assertArchiveCurrent, proof });
                await assertCurrent();
                check(isDeepStrictEqual(await bindingCapture.captureProjectPreStartBinding(job, descriptor), originalBinding), "immutable_binding_changed");
                return finalized;
              }
              const repaired = buildRepairedAdmission({ contract: JSON.parse(observed.contract.toString()) as WorkerLaunchSpec,
                state: JSON.parse(observed.state.toString()) as WorkerLaunchState, receipt: object(JSON.parse(observed.receipt.toString())),
                manifest: job, ownedPaths: plan.ownedPaths, materialize: builtin.materializeBuiltinWorkerLaunchSpec });
              await builtin.validateBuiltinWorkerLaunchSpec({ ...repaired, manifest: job, scope: controller.scope });
              const assertStableBinding = async (): Promise<void> => {
                const currentBinding = await bindingCapture.captureProjectPreStartBinding(job, descriptor, undefined,
                  { contractBytes: observed.contract, stateBytes: observed.state });
                check(isDeepStrictEqual(currentBinding, originalBinding), "immutable_binding_changed");
              };
              await assertStableBinding();
              const candidateBinding = await bindingCapture.captureProjectPreStartBinding(job, descriptor, undefined,
                { contractBytes: jsonBytes(repaired.contract), stateBytes: jsonBytes(repaired.state) });
              check(isDeepStrictEqual({ ...candidateBinding, contractSha256: originalBinding.contractSha256,
                stateSha256: originalBinding.stateSha256 }, originalBinding), "candidate_binding_changed");
              const receipt = { ...object(JSON.parse(observed.receipt.toString())), workKey: repaired.contract.workKey,
                contractSha256: hash(jsonBytes(repaired.contract)), stateSha256: hash(jsonBytes(repaired.state)),
                admissionOwnedPathsRepair: { schemaVersion: 1, planSha256: expectedPlanSha256, originalRuntimeDirectory: runtimeDirectory,
                  originalArtifactSha256: expectedArtifactSha256, previousContractSha256: plan.expectedContractSha256,
                  previousStateSha256: plan.expectedStateSha256, previousReceiptSha256: plan.expectedReceiptSha256,
                  ownedPaths: plan.ownedPaths, repairedAt: new Date().toISOString() } };
              const publication = await publishRepairedAdmission({ jobRootDir: job.jobRootDir, archiveRootDir, operationSha256: expectedPlanSha256,
                ...repaired, receipt, assertCurrent: async () => { await assertStableBinding(); await assertCurrent(); }, exchange: exchangeAdmissionDirectories });
              await admission.assertProjectPreStartAdmissionLaunchBinding({ manifest: job, scope: controller.scope });
              for (const manifest of [controller.controller, job]) check((await birth.observeProtectedCodexGoalJobBirth(manifest)).status === "released", "post_publication_birth_changed");
              return { ok: true, jobId: job.jobId, planSha256: expectedPlanSha256, manifestSha256: plan.expectedManifestSha256,
                controllerManifestSha256: plan.expectedControllerManifestSha256, workKey: repaired.contract.workKey,
                contractSha256: receipt.contractSha256, stateSha256: receipt.stateSha256, ...publication };
            } }) }) }) });
}

export async function repairHostedMimoJobAdmission(planPath: string | RepairPlan, expectedPlanSha256: string,
  runtimeDirectory: string, expectedArtifactSha256: string): Promise<unknown> {
  return operateHostedMimoJobAdmission(planPath, expectedPlanSha256, runtimeDirectory, expectedArtifactSha256);
}

export async function finalizeHostedMimoJobAdmissionRepair(identity: AdmissionRepairIdentity, runtimeDirectory: string,
  expectedArtifactSha256: string): Promise<unknown> {
  const stateRoot = `/srv/worker-state/mimo-projects/${identity.projectId}/${identity.workstreamId}`;
  const operation = join(stateRoot, "mimo-bridge-operations", identity.jobId + ".repair-admission");
  const request = object(JSON.parse(operatorBytes(operation + ".request.json").toString()));
  const plan = parseRepairPlan(request.repairPlan), envelope = object(JSON.parse(operatorBytes(operation + ".result.json").toString()));
  const result = object(envelope.result);
  check(envelope.ok === true && result.ok === true && result.jobId === identity.jobId && result.planSha256 === hash(JSON.stringify(plan)), "prior_repair_required");
  for (const field of ["projectId", "workstreamId", "machineId", "jobId"] as const) check(plan[field] === identity[field], "finalization_identity");
  const bindingPath = `/etc/subscription-runtime/mimo-projects/${identity.projectId}/${identity.workstreamId}.json`;
  const binding = object(JSON.parse(operatorBytes(bindingPath).toString()));
  check(binding.projectId === identity.projectId && binding.workstreamId === identity.workstreamId && binding.machineId === identity.machineId &&
    binding.stateRoot === stateRoot && binding.registryRootDir === join(stateRoot, "registry") && typeof binding.controllerJobId === "string", "finalization_binding");
  const receiptPath = join(stateRoot, "jobs", identity.jobId, "pre-start-admission", "receipt.json");
  const currentPlan: RepairPlan = { ...plan, expectedReceiptSha256: hash(operatorBytes(receiptPath, 65536)),
    expectedContractSha256: String(result.contractSha256), expectedStateSha256: String(result.stateSha256) };
  check(result.manifestSha256 === plan.expectedManifestSha256 && result.controllerManifestSha256 === plan.expectedControllerManifestSha256, "prior_manifest_binding");
  return operateHostedMimoJobAdmission(currentPlan, hash(JSON.stringify(currentPlan)), runtimeDirectory, expectedArtifactSha256,
    { priorPlan: plan, priorResult: result });
}
export async function assertHostedMimoAdmissionRepairStartRearm(identity: AdmissionRepairIdentity,
  previousStart: PreviousStartHashes): Promise<{ receiptSha256: string }> {
  check(process.getuid?.() === 0 && process.platform === "linux", "initial_root_required");
  const receiptPath = `/srv/worker-state/mimo-projects/${identity.projectId}/${identity.workstreamId}/admission-repair-archives/${identity.jobId}.finalization.json`;
  const bytes = operatorBytes(receiptPath), proof = object(JSON.parse(bytes.toString()));
  verifyAdmissionRepairStartRearmProof(proof, identity, previousStart, {
    readBytes: operatorBytes, witness, absent, directoryIdentity: path => {
      const stat = lstatSync(path);
      check(stat.uid === 0 && !(stat.mode & 0o022) && realpathSync(path) === path, "rearm_directory_custody");
      return directoryIdentity(path);
    },
  });
  return { receiptSha256: hash(bytes) };
}

export function verifyAdmissionRepairStartRearmProof(proof: Json, identity: AdmissionRepairIdentity,
  previousStart: PreviousStartHashes, ports: Readonly<{ readBytes(path: string): Buffer; witness(path: string): string;
    directoryIdentity(path: string): { path: string; device: number; inode: number }; absent(path: string): boolean }>): void {
  for (const field of ["projectId", "workstreamId", "machineId", "jobId"] as const) check(proof[field] === identity[field], "rearm_identity");
  const prior = object(proof.previousStart);
  check(prior.terminalVerified === true && prior.ownerSha256 === previousStart.ownerSha256 && prior.requestSha256 === previousStart.requestSha256 && prior.resultSha256 === previousStart.resultSha256, "rearm_previous_start");
  check(Array.isArray(proof.bindings) && Array.isArray(proof.directories) && Array.isArray(proof.birthWitnesses) && proof.birthWitnesses.length === 2, "rearm_proof_shape");
  for (const value of proof.bindings) { const row = object(value); check(typeof row.path === "string" && hash(ports.readBytes(row.path)) === row.sha256 && ports.witness(row.path) === row.witness, "rearm_binding_changed"); }
  for (const value of [...proof.directories, ...proof.birthWitnesses.map(value => object(value).directory)]) {
    const row = object(value); check(typeof row.path === "string" && isDeepStrictEqual(ports.directoryIdentity(row.path), row), "rearm_directory_changed");
  }
  for (const value of proof.birthWitnesses) {
    const row = object(value); check(Array.isArray(row.births) && row.births.length === 2, "rearm_birth_shape");
    for (const value of row.births) { const birth = object(value); check(typeof birth.path === "string" && typeof birth.firstEffectPath === "string" &&
      hash(ports.readBytes(birth.path)) === birth.sha256 && ports.absent(birth.firstEffectPath), "rearm_first_effect_or_birth_changed"); }
  }
}

/** Fixed managed operation receives an immutable request snapshot; executable
 * routing remains a separately trusted host-composition input. */
export async function repairHostedMimoJobAdmissionPlan(value: RepairPlan, runtimeDirectory: string,
  expectedArtifactSha256: string): Promise<unknown> {
  const plan = parseRepairPlan(JSON.parse(JSON.stringify(value)));
  return repairHostedMimoJobAdmission(plan, hash(JSON.stringify(plan)), runtimeDirectory, expectedArtifactSha256);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv[2] === "--help") process.stdout.write("Operator-only: PLAN_PATH PLAN_SHA256 ORIGINAL_RUNTIME_DIRECTORY ORIGINAL_ARTIFACT_SHA256\nChanges only never-started job admission ownedPaths and derived bindings. Atomic Linux directory exchange; retained prior triple. No create/start.\n");
  else {
    check(process.argv.length === 6, "arguments_required");
    await repairHostedMimoJobAdmission(process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]!).then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(() => {
      process.stderr.write('{"ok":false,"code":"mimo_admission_repair_denied_or_uncertain","reconciliationRequired":true}\n'); process.exitCode = 1;
    });
  }
}
