#!/usr/bin/env node
/** Operator-only admission repair. No job creation, start, manifest or authority publication. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const exchangeProgram = "import ctypes,os,sys\nl=ctypes.CDLL(None,use_errno=True)\nf=l.renameat2\nf.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nf.restype=ctypes.c_int\ndef ident(s): return (s.st_dev,s.st_ino)\np,a,b=tuple(map(int,sys.argv[3:5])),tuple(map(int,sys.argv[5:7])),tuple(map(int,sys.argv[7:9]))\ndef stat(n): return os.stat(n,dir_fd=3,follow_symlinks=False)\nassert ident(os.fstat(3))==p and ident(stat(sys.argv[1]))==a and ident(stat(sys.argv[2]))==b\nr=f(3,os.fsencode(sys.argv[1]),3,os.fsencode(sys.argv[2]),2)\nif r: raise OSError(ctypes.get_errno(),'admission_directory_exchange_failed')\nassert ident(os.fstat(3))==p and ident(stat(sys.argv[1]))==b and ident(stat(sys.argv[2]))==a\nos.fsync(3)\n";
export function exchangeAdmissionDirectories(admissionRoot: string, stagedRoot: string): void {
  check(process.platform === "linux" && dirname(admissionRoot) === dirname(stagedRoot), "linux_exchange_required");
  const parent = dirname(admissionRoot), fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const root = fstatSync(fd), admission = lstatSync(admissionRoot), staged = lstatSync(stagedRoot);
    check(admission.isDirectory() && staged.isDirectory() && !admission.isSymbolicLink() && !staged.isSymbolicLink(), "exchange_directories_required");
    const namedRoot = lstatSync(parent);
    check(namedRoot.dev === root.dev && namedRoot.ino === root.ino && !namedRoot.isSymbolicLink(), "exchange_parent_changed");
    execFileSync("/usr/bin/python3", ["-I", "-c", exchangeProgram, basename(admissionRoot), basename(stagedRoot),
      ...[root, admission, staged].flatMap(stat => [String(stat.dev), String(stat.ino)])],
      { timeout: 10000, stdio: ["pipe", "pipe", "pipe", fd], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    fsyncSync(fd);
    const after = lstatSync(parent);
    check(after.dev === root.dev && after.ino === root.ino && !after.isSymbolicLink(), "exchange_parent_changed");
  } finally { closeSync(fd); }
}

/** First commit is the exchange. Precondition failures never rewrite admission;
 * failure after exchange retains both exact triples and audit for reconciliation. */
export async function publishRepairedAdmission(input: {
  readonly jobRootDir: string; readonly operationSha256: string;
  readonly contract: WorkerLaunchSpec; readonly state: WorkerLaunchState; readonly receipt: Json;
  readonly assertCurrent: () => Promise<void>;
  readonly exchange: typeof exchangeAdmissionDirectories;
}): Promise<{ readonly retainedPreviousAdmissionPath: string; readonly receiptSha256: string }> {
  const admissionRoot = join(input.jobRootDir, "pre-start-admission");
  const stagedRoot = join(input.jobRootDir, ".admission-repair-" + input.operationSha256);
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
  syncDirectory(stagedRoot); syncDirectory(input.jobRootDir);
  await input.assertCurrent();
  input.exchange(admissionRoot, stagedRoot);
  check(readFileSync(join(admissionRoot, "receipt.json")).equals(receiptBytes), "publication_uncertain");
  return { retainedPreviousAdmissionPath: stagedRoot, receiptSha256: hash(receiptBytes) };
}

export async function repairHostedMimoJobAdmission(planPath: string | RepairPlan, expectedPlanSha256: string, runtimeDirectory: string,
  expectedArtifactSha256: string): Promise<unknown> {
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
              const publication = await publishRepairedAdmission({ jobRootDir: job.jobRootDir, operationSha256: expectedPlanSha256,
                ...repaired, receipt, assertCurrent: async () => { await assertStableBinding(); await assertCurrent(); }, exchange: exchangeAdmissionDirectories });
              await admission.assertProjectPreStartAdmissionLaunchBinding({ manifest: job, scope: controller.scope });
              for (const manifest of [controller.controller, job]) check((await birth.observeProtectedCodexGoalJobBirth(manifest)).status === "released", "post_publication_birth_changed");
              return { ok: true, jobId: job.jobId, planSha256: expectedPlanSha256, manifestSha256: plan.expectedManifestSha256,
                controllerManifestSha256: plan.expectedControllerManifestSha256, workKey: repaired.contract.workKey,
                contractSha256: receipt.contractSha256, stateSha256: receipt.stateSha256, ...publication };
            } }) }) }) });
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
