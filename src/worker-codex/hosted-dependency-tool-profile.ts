import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DependencyAdmissionError, DependencyAdmissionFailure, DependencyOwnerPhase, sameDependencyAttempt, type DependencyAttempt } from "@vioxen/subscription-runtime/core";
import { DependencyInstallProofKind, DependencyReceiptState, DependencyTreeObservationStatus } from "@vioxen/subscription-runtime/worker-core";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { dependencyToolCachePath, dependencyToolGuestConfig, dependencyToolPins, dependencyToolQualificationRecordName,
  DependencyToolProfileId, parseDependencyToolProfile, parseDependencyToolQualification, parseDependencyToolRegistration,
  type DependencyToolFile, type DependencyToolGuestConfig, type DependencyToolProfile, type DependencyToolQualification,
  type DependencyToolRegistration } from "../core/dependency-environment/dependency-tool-profile";
import { readHostedOrdinaryProcessOrigin, readHostedActivationBytes, decodeHostedActivationBytes } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readHostedDependencyAttempt, readHostedDependencyBinding, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { observeDependencyTree } from "../worker-local/dependency-environment/observe-dependency-tree";
import { openHostedDependencyManifestPlacement } from "./hosted-dependency-manifest-placement";
import { readHostedDependencyKeyInputs, readHostedDependencyReceipt, assertHostedDependencyKeyInputsCurrent, sameHostedDependencyKeyInputs,
  hostedDependencyObservationLimits, matchesHostedDependencyReady } from "./hosted-dependency-materialization";
import { isHostedOrdinaryRuntime } from "./hosted-installation-activation";

const policyRoot = "/var/lib/subscription-runtime-host-policy";
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
const hash = (v: Uint8Array): string => createHash("sha256").update(v).digest("hex");
// Exact supported registry distributions, sourced from the reviewed root lock.
// This is additional qualification, never a substitute for the full byte proof.
const toolDistributionIntegrity = Object.freeze({
  vite: "sha512-h9bXPmJichP5fLmVQo3PyaGSDE2n3aPuomeAlVRm0JLmt4rY6zmPKd59HYI4LNW8oTK7tlTsuC7l/m7awx9Jcw==",
  vitest: "sha512-flY6ScbCIt9HThs+C5HS7jvGOB560DJtk/Z15IQROTA6zEy49Nh8T/dofWTQL+n3vswqn87sbJNiuqw1SDp5Ig==",
});

/** Operator-only configuration publication while installation is CLOSED.
 * Actual binding issuer verifies host principal, inventory and fresh enrollment.
 */
export function createHostedDependencyToolProfile(jobRootDir: string, registration: DependencyToolRegistration): DependencyToolProfile {
  const parsed = parseDependencyToolRegistration(registration), cachePath = dependencyToolCachePath(jobRootDir);
  for (const path of [join(jobRootDir, "tool-cache"), cachePath, ...["vite", "transforms", "tmp"].map(n => join(cachePath, n))]) {
    mkdirSync(path, { mode: 0o700 });
    const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    trustedDirectory(path);
  }
  const cache = lstatSync(cachePath, { bigint: true });
  assertHelperPackageScope();
  const readonlyFiles = expectedHelperPaths().map(trustedFile);
  const helper = readonlyFiles[0]; if (!helper) fail();
  return parseDependencyToolProfile({ version: 1, profileId: DependencyToolProfileId.ViteVitestConfigFreeV1,
    pins: dependencyToolPins, ...parsed, cache: { canonicalPath: cachePath, dev: String(cache.dev), ino: String(cache.ino) },
    node: trustedFile(realpathSync(process.execPath)), helper, readonlyFiles });
}

/** v1 has no capability; v2 is strict at the protected provider binding parser. */
export function hostedDependencyToolProfile(binding: HostedDependencyBinding): DependencyToolProfile | undefined {
  const value: unknown = binding;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (v.version === 1) return undefined;
  if (v.version !== 2) fail();
  const profile = parseDependencyToolProfile(v.toolProfile);
  if (profile.cache.canonicalPath !== dependencyToolCachePath(binding.jobRootDir)) fail();
  return profile;
}

/** N3-only current byte qualification, not generic Ready hot attestation.
 * All awaits are bracketed by actual ExclusiveMutation owner/fence checks.
 */
export async function qualifyHostedDependencyToolClosure(binding: HostedDependencyBinding, attempt: DependencyAttempt): Promise<void> {
  const profile = hostedDependencyToolProfile(binding); if (!profile) return;
  const assertExclusive = () => withHostedActivationFence(fence => {
      const origin = readHostedOrdinaryProcessOrigin(fence);
    if (!sameDependencyAttempt(readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation), attempt) ||
        !encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding))) fail();
  });
  assertExclusive(); assertProfileFiles(profile, binding.jobRootDir);
  const before = await readHostedDependencyKeyInputs(binding); assertExclusive();
  const receipt = readHostedDependencyReceipt(binding);
  if (!receipt || receipt.state !== DependencyReceiptState.Ready || receipt.provenance.kind !== DependencyInstallProofKind.CompletedInstall ||
      !matchesHostedDependencyReady(binding, receipt, before)) fail();
  const placement = await openHostedDependencyManifestPlacement();
  let manifest: Uint8Array;
  try { assertExclusive(); manifest = await placement.get(receipt.manifestDigest); assertExclusive(); }
  finally { await placement.close(); assertExclusive(); }
  const observed = await observeDependencyTree({ workspacePath: binding.workspace.canonicalPath, treeName: "node_modules",
    expectedWorkspace: binding.workspace, expectedTree: receipt.tree, limits: hostedDependencyObservationLimits });
  assertExclusive();
  if (observed.status !== DependencyTreeObservationStatus.Complete || observed.digest !== receipt.manifestDigest ||
      !Buffer.from(manifest).equals(observed.canonicalBytes)) fail(DependencyAdmissionFailure.UnsafeTree);
  assertInstalledPins(binding.workspace.canonicalPath, profile, before.lockBytes);
  const after = await readHostedDependencyKeyInputs(binding); assertExclusive();
  if (!sameHostedDependencyKeyInputs(before, after)) fail();
  const qualification = parseDependencyToolQualification({ version: 1, kind: "n3-authenticated-tool-closure",
    installationId: binding.installationId, runtimeSha: binding.runtimeSha, grantDigest: binding.grantDigest,
    workspace: binding.workspace, startId: attempt.launch.startId, attemptId: attempt.attemptId, epoch: attempt.epoch,
    readyRevision: receipt.revision, installKey: receipt.installKey, tree: observed.tree, manifestDigest: observed.digest, profile,
    measurement: { entries: observed.entries.length, bytes: observed.totalBytes, durationMs: Number(observed.measurement.observedScanDurationMs) } });
  withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence);
    if (!sameDependencyAttempt(readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId), DependencyOwnerPhase.ExclusiveMutation), attempt) ||
        !encode(readHostedDependencyBinding(binding.jobId)).equals(encode(binding)) || !encode(readHostedDependencyReceipt(binding)).equals(encode(receipt))) fail();
    assertHostedDependencyKeyInputsCurrent(binding, after); placement.assertCurrent(fence);
    assertProfileFiles(profile, binding.jobRootDir);
    const current = lstatSync(`${binding.workspace.canonicalPath}/node_modules`, { bigint: true });
    if (!current.isDirectory() || String(current.dev) !== observed.tree.dev || String(current.ino) !== observed.tree.ino) fail();
    // Fixed actual start ID only. Collision is held evidence, never adoption.
    const path = join(policyRoot, dependencyToolQualificationRecordName(attempt.launch.startId));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, encode(qualification)); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  });
}

/** Resolve config only from a protected qualification plus the genuine Running
 * owner. The shared provider launch must independently validate these facts.
 */
export function readAdmittedHostedDependencyToolConfig(workspacePath: string | undefined): DependencyToolGuestConfig | undefined {
  if (!isHostedOrdinaryRuntime() || workspacePath === undefined) return undefined;
  return withHostedActivationFence(fence => {
    const origin = readHostedOrdinaryProcessOrigin(fence), binding = readHostedDependencyBinding(String(origin.start.jobId));
    if (!binding) return undefined;
    const profile = hostedDependencyToolProfile(binding); if (!profile) return undefined;
    if (workspacePath !== binding.workspace.canonicalPath) fail();
    const attempt = readHostedDependencyAttempt(binding, origin.start, String(origin.reservation.startId));
    const name = dependencyToolQualificationRecordName(attempt.launch.startId), path = join(policyRoot, name);
    const before = lstatSync(path, { bigint: true });
    const bytes = readHostedActivationBytes(name); if (!bytes) fail();
    const q = parseDependencyToolQualification(decodeHostedActivationBytes(bytes));
    const after = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino ||
        before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || !encode(q).equals(bytes)) fail();
    assertQualification(q, binding, attempt); assertProfileFiles(profile, binding.jobRootDir);
    return dependencyToolGuestConfig(q);
  });
}
export function hostedDependencyToolInstruction(config: DependencyToolGuestConfig): string {
  const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
  const command = `${quote(config.profile.node.path)} ${quote(config.profile.helper.path)}`;
  return ["This admitted task supports config-free Node checks and dependency optimization.",
    `Run ${command} optimize or ${command} test using the native exec tool.`,
    `Registered test files: ${config.profile.testFiles.join(", ")}. Registered optimizer dependencies: ${config.profile.optimizerDependencies.join(", ")}.`,
    "Root node_modules is read-only for this consumer. Source/output edits follow the task permissions. Dependency installation, patching, and writes into node_modules are unsupported during this consumer.",
    "This command uses a fixed qualified tool profile and does not load user Vite/Vitest config. Do not substitute custom config or flags."].join("\n");
}
function assertQualification(q: DependencyToolQualification, binding: HostedDependencyBinding, attempt: DependencyAttempt): void {
  const receipt = readHostedDependencyReceipt(binding), tree = lstatSync(`${binding.workspace.canonicalPath}/node_modules`, { bigint: true });
  if (q.installationId !== binding.installationId || q.runtimeSha !== binding.runtimeSha || q.grantDigest !== binding.grantDigest ||
      !encode(q.workspace).equals(encode(binding.workspace)) || q.startId !== attempt.launch.startId || q.attemptId !== attempt.attemptId || q.epoch !== attempt.epoch ||
      !receipt || receipt.state !== DependencyReceiptState.Ready || receipt.provenance.kind !== DependencyInstallProofKind.CompletedInstall ||
      q.readyRevision !== receipt.revision || q.installKey !== receipt.installKey || q.manifestDigest !== receipt.manifestDigest ||
      q.tree.dev !== receipt.tree.dev || q.tree.ino !== receipt.tree.ino || !tree.isDirectory() || String(tree.dev) !== q.tree.dev || String(tree.ino) !== q.tree.ino ||
      !encode(q.profile).equals(encode(hostedDependencyToolProfile(binding)))) fail();
}
function expectedHelperPaths(): readonly string[] {
  return ["../worker-local/dependency-environment/config-free-tool-entry.js", "../core/dependency-environment/dependency-tool-profile.js",
    "./hosted-global-scan-pre-tool-hook.js", "./hosted-global-scan-hook-policy.js", "./code-mode-exec-command-parser.js",
    "../worker-core/host-command/global-filesystem-scan-policy.js", "../../package.json"].map(p => fileURLToPath(new URL(p, import.meta.url)));
}
function assertProfileFiles(profile: DependencyToolProfile, jobRootDir: string): void {
  assertHelperPackageScope();
  const expected = expectedHelperPaths();
  if (profile.cache.canonicalPath !== dependencyToolCachePath(jobRootDir) || profile.node.path !== realpathSync(process.execPath) ||
      profile.helper.path !== expected[0] || profile.readonlyFiles.some((f, i) => f.path !== expected[i] || trustedFile(f.path).sha256 !== f.sha256) ||
      trustedFile(profile.node.path).sha256 !== profile.node.sha256) fail();
  trustedDirectory(profile.cache.canonicalPath);
  const cache = lstatSync(profile.cache.canonicalPath, { bigint: true });
  if (String(cache.dev) !== profile.cache.dev || String(cache.ino) !== profile.cache.ino) fail();
  for (const name of ["vite", "transforms", "tmp"]) trustedDirectory(join(profile.cache.canonicalPath, name));
}
function assertHelperPackageScope(): void {
  const paths = expectedHelperPaths(), metadata = paths[6]; if (!metadata) fail();
  trustedFile(metadata);
  const value: unknown = JSON.parse(readFileSync(metadata, "utf8"));
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "module") fail();
  const root = dirname(metadata);
  for (const js of paths.slice(0, 6)) {
    if (!js.startsWith(root + "/dist/")) fail();
    // Node selects the nearest package scope, not merely any ancestor JSON.
    for (let directory = dirname(js); directory !== root; directory = dirname(directory)) {
      try { lstatSync(join(directory, "package.json")); fail(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
function assertInstalledPins(workspace: string, profile: DependencyToolProfile, lockBytes: Uint8Array): void {
  const lock: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  if (!lock || typeof lock !== "object" || Array.isArray(lock) || !("packages" in lock) ||
      !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) fail();
  const packages = lock.packages as Record<string, unknown>;
  for (const [name, version] of Object.entries(dependencyToolPins)) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("version" in entry) || entry.version !== version ||
        !("resolved" in entry) || entry.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` ||
        !("integrity" in entry) || entry.integrity !== toolDistributionIntegrity[name as keyof typeof toolDistributionIntegrity]) fail();
    const path = join(workspace, "node_modules", name, "package.json"), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || realpathSync(path) !== path) fail();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || !("name" in value) || value.name !== name || !("version" in value) || value.version !== version) fail();
  }
  for (const dependency of profile.optimizerDependencies) {
    const path = join(workspace, "node_modules", dependency);
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) fail();
  }
}
function trustedFile(path: string): DependencyToolFile {
  trustedDirectory(dirname(path));
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) || before.size > 256n * 1024n * 1024n || realpathSync(path) !== path) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  const after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== before.size) fail();
  return { path, sha256: hash(bytes) };
}
function trustedDirectory(path: string): void {
  for (let p = path;; p = dirname(p)) {
    const stat = lstatSync(p);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(p) !== p) fail();
    if (p === "/") break;
  }
}
function fail(reason = DependencyAdmissionFailure.Unsupported): never { throw new DependencyAdmissionError(reason); }
