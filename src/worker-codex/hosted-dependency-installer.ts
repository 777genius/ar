import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withHostedActivationFence, CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { DependencyOwnerPhase, sameDependencyAttempt, type DependencyAttempt } from "../worker-core/dependency-environment/domain/dependency-owner";
import type { DependencyWorkspaceIdentity } from "../worker-core/dependency-environment/domain/dependency-receipt";
import { DependencyNpmLockName } from "../worker-core/dependency-environment/domain/dependency-install-key";
import { readHostedDependencyBinding, readHostedDependencyAttempt } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { readHostedOrdinaryRuntime } from "./hosted-installation-activation";
import { assertReadonlyHostOperator, decodePrivateJson, readonlyIdentityName } from "./hosted-readonly-authority";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { hostedTestEgressGrantRoot } from "./hosted-test-egress-files";
import { parseHostedTestEgressGrant, assertHostedTestEgressIdentity } from "./hosted-test-egress-contract";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";
import { collectJobs, collectProcessBirth, collectProcessCgroup, fenceScopedSubmitter } from "./hosted-readonly-linux-collector";
import { parseScopedManagerJobs } from "./hosted-readonly-observations";
import { observeInstallerCgroupEmpty } from "./hosted-dependency-installer-cgroup";
import { assertInstallerTerminalUnit } from "./hosted-dependency-installer-unit";
import { TrustedCustodyLaunchRole, hostedFdCustodySystemdLaunch } from "./trusted-custody-systemd-launch";
import { readHostedFdProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { spawnHostedFdChild, hostedFdLaunch, HostedFdLaunchKind, hostedInstallerReleaseMarker } from "../provider-codex/app-server/adapters/hosted-fd-launch";
import { retryHostedFenceAcquisition } from "../provider-codex/app-server/adapters/hosted-fd-fence";
import { qualifyHostedDependencyInstallerInputs, HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { createHostedDependencyInstallerPlan, assertHostedDependencyInstallerPlan, hostedDependencyInstallerRoot, type HostedDependencyInstallerPlan } from "./hosted-dependency-installer-recipe";

export type HostedDependencyInstallerRequest = {
  readonly workspace: DependencyWorkspaceIdentity; readonly attempt: DependencyAttempt;
  readonly lockName: DependencyNpmLockName;
  readonly packageBytes: Buffer; readonly lockBytes: Buffer;
};
export type HostedDependencyInstallerCompletion = {
  readonly lockName: DependencyNpmLockName;
  readonly recipe: HostedDependencyInstallerRecipe; readonly startId: string; readonly unit: string;
  readonly inputSha256: string; readonly profileSha256: string; readonly completionSha256: string;
  readonly output: DependencyWorkspaceIdentity;
};
const encode = (v: unknown): Buffer => Buffer.from(JSON.stringify(v) + "\n");
const digest = (v: Buffer): string => createHash("sha256").update(v).digest("hex");
function fail(): never { throw new Error("dependency_installer_unresolved"); }
function assertOwner(fence: HostedActivationFence, request: HostedDependencyInstallerRequest): void {
  assertReadonlyHostOperator();
  const origin = readHostedOrdinaryRuntime(fence), { start, installation, reservation } = origin, a = request.attempt.launch;
  const binding = readHostedDependencyBinding(start.jobId);
  if (!binding || binding.workspace.canonicalPath !== request.workspace.canonicalPath || binding.workspace.dev !== request.workspace.dev ||
      binding.workspace.ino !== request.workspace.ino ||
      request.workspace.canonicalPath !== start.workspacePath || a.installationId !== installation.installationId ||
      a.runtimeSha !== installation.runtimeSha || a.startId !== reservation.startId || a.unit !== start.unit || a.bootId !== start.bootId ||
      a.grantDigest !== start.grantSha256) fail();
  const bytes = readHostedPrivateBytes(join(hostedTestEgressGrantRoot, readonlyIdentityName(start.jobId)), 4096);
  if (!bytes || digest(bytes) !== a.grantDigest) fail();
  const grant = parseHostedTestEgressGrant(decodePrivateJson(bytes));
  assertHostedTestEgressIdentity(grant, start);
  if (grant.profileId !== CodexProviderEgressProfileId.TestNpmQualification) fail();
  const identity = lstatSync(request.workspace.canonicalPath, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || String(identity.dev) !== request.workspace.dev ||
      String(identity.ino) !== request.workspace.ino) fail();
  const admitted = readHostedDependencyAttempt(binding, start, reservation.startId, DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(admitted, request.attempt)) fail();
}

/** Recursive anchored cgroup observation. Missing or changed child directories
 * are unresolved, not a truncated empty proof. No test-controlled observer can
 * assert terminal authority for the production installer.
 */
function recursiveEmpty(unit: string): string {
  const group = `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${unit}`;
  return observeInstallerCgroupEmpty("/sys/fs/cgroup" + group);
}
function drain(plan: Pick<HostedDependencyInstallerPlan, "directory" | "startId">, unit: string): string {
  const record = (name: string) => readHostedPrivateBytes(join(plan.directory, name), 64 * 1024);
  const start = record("start.json"), completion = record("creator-completion.json"), consumed = record("consumed.json"), creator = record("creator.json");
  if (!start || !completion || !consumed || !creator) fail();
  const retained = decodePrivateJson(start) as { startId: string; unit: string };
  if (retained.startId !== plan.startId || retained.unit !== unit ||
      !completion.equals(encode({ schemaVersion: 1, startId: plan.startId, startSha256: digest(start), creatorSha256: digest(creator), status: 0, creatorWaitReturned: true })) ||
      !consumed.equals(encode({ schemaVersion: 1, startId: plan.startId, startSha256: digest(start) })) ||
      !record("revoked.json")?.equals(encode({ schemaVersion: 1, startId: plan.startId, completionSha256: digest(completion) }))) fail();
  // Revocation was retained before queue or cgroup inspection. Every future
  // installer enqueue requires create-once consumed.json and rejects its replay.
  if (parseScopedManagerJobs(collectJobs()).some(job => job.unit === unit)) fail();
  assertInstallerTerminalUnit(unit);
  const empty = recursiveEmpty(unit);
  if (parseScopedManagerJobs(collectJobs()).some(job => job.unit === unit) || !record("creator-completion.json")?.equals(completion) ||
      !record("consumed.json")?.equals(consumed)) fail();
  return empty;
}
function retainOnce(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  createReadonlyPrivateRecord(path, bytes);
}

/** Host reconciliation includes this separate sibling unit before releasing an
 * old dependency attempt. Missing completion/terminal never becomes Idle. The
 * namespace itself must have been initialized under the host's protected root.
 */
export function assertHostedDependencyInstallerAttemptDrained(attempt: DependencyAttempt): void {
  assertReadonlyHostOperator();
  const bytes = readHostedPrivateBytes(join(hostedDependencyInstallerRoot, `attempt-${attempt.attemptId}.json`), 4096);
  if (!bytes) return;
  const row = decodePrivateJson(bytes) as { schemaVersion: number; startId: string; unit: string; attempt: DependencyAttempt };
  if (!row || Object.keys(row).sort().join(",") !== "attempt,schemaVersion,startId,unit" || row.schemaVersion !== 1 ||
      !sameDependencyAttempt(row.attempt, attempt) || !/^[a-f0-9-]{36}$/.test(row.startId) ||
      row.unit !== `subscription-runtime-installer-${row.startId}.service`) fail();
  const directory = join(hostedDependencyInstallerRoot, row.startId);
  const startBytes = readHostedPrivateBytes(join(directory, "start.json"), 64 * 1024), terminalBytes = readHostedPrivateBytes(join(directory, "terminal.json"), 4096);
  if (!startBytes || !terminalBytes) fail();
  const start = decodePrivateJson(startBytes) as { attempt: DependencyAttempt }, terminal = decodePrivateJson(terminalBytes) as { startId: string };
  if (!sameDependencyAttempt(start.attempt, attempt) || terminal.startId !== row.startId) fail();
  drain({ directory, startId: row.startId }, row.unit);
}

/** Containment of an uncertain actual submitter. Positive native pidfd discharge
 * is retained, never inferred from missing PID. This does not accept partial
 * installation or synthesize successful completion/Ready; unresolved output and
 * owner remain held until their separate exact service reconciliation succeeds.
 */
export function fenceHostedDependencyInstallerSubmitter(attempt: DependencyAttempt, remainingMs: number): void {
  assertReadonlyHostOperator();
  const bytes = readHostedPrivateBytes(join(hostedDependencyInstallerRoot, `attempt-${attempt.attemptId}.json`), 4096);
  if (!bytes) fail();
  const row = decodePrivateJson(bytes) as { startId: string; attempt: DependencyAttempt };
  if (!sameDependencyAttempt(row.attempt, attempt) || !/^[a-f0-9-]{36}$/.test(row.startId)) fail();
  const directory = join(hostedDependencyInstallerRoot, row.startId), creatorBytes = readHostedPrivateBytes(join(directory, "creator.json"), 4096);
  if (!creatorBytes) fail();
  const creator = decodePrivateJson(creatorBytes) as { schemaVersion: number; startId: string; startSha256: string; pidBirth: string; controlGroup: string };
  const start = readHostedPrivateBytes(join(directory, "start.json"), 64 * 1024);
  if (!start || creator.schemaVersion !== 1 || creator.startId !== row.startId || creator.startSha256 !== digest(start) ||
      creator.controlGroup !== `/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${attempt.launch.unit}`) fail();
  const discharge = encode({ schemaVersion: 1, startId: row.startId, creatorSha256: digest(creatorBytes), exitObserved: true });
  const path = join(directory, "submitter-fenced.json"), existing = readHostedPrivateBytes(path, 4096);
  if (existing) { if (!existing.equals(discharge)) fail(); return; }
  fenceScopedSubmitter(creator.pidBirth, creator.controlGroup, remainingMs);
  createReadonlyPrivateRecord(path, discharge);
}

export class HostedDependencyInstaller {
  /** Factual completion only. Unknown start/completion/drain retains every
   * partial output and the caller's durable ExclusiveMutation ownership. */
  async install(request: HostedDependencyInstallerRequest): Promise<HostedDependencyInstallerCompletion> {
    if (!Object.values(DependencyNpmLockName).includes(request.lockName)) fail();
    const inputs = qualifyHostedDependencyInstallerInputs(request.packageBytes, request.lockBytes, request.lockName), startId = randomUUID();
    const unit = `subscription-runtime-installer-${startId}.service`;
    const prepared = withHostedActivationFence(fence => {
      assertOwner(fence, request);
      const plan = createHostedDependencyInstallerPlan(startId, inputs), profileSha256 = digest(encode(plan.profile));
      // One manager invocation per exact private attempt, including uncertainty.
      // A new random startId cannot resurrect a consumed or revoked attempt.
      const attemptPath = join(hostedDependencyInstallerRoot, `attempt-${request.attempt.attemptId}.json`);
      retainOnce(attemptPath, encode({ schemaVersion: 1, startId, unit, attempt: request.attempt }));
      const start = encode({ schemaVersion: 1, startId, unit, recipe: HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1,
        workspace: request.workspace, attempt: request.attempt, inputSha256: inputs.sha256, profileSha256 });
      createReadonlyPrivateRecord(join(plan.directory, "start.json"), start);
      // O_EXCL supplies future-start exclusion. Unlike idempotent record
      // publication, this marker must never permit a second manager submission.
      retainOnce(join(plan.directory, "consumed.json"), encode({ schemaVersion: 1, startId, startSha256: digest(start) }));
      const fdProfile = readHostedFdProfile();
      const launch = hostedFdCustodySystemdLaunch(TrustedCustodyLaunchRole.Installer, startId, plan.stagingDirectory, plan);
      // Actual submitter birth occurs in the final admission fence, never from a
      // precomputed command returned to a later caller. Its child identity is
      // retained so scoped host termination can fence this exact future creator.
      assertOwner(fence, request);
      const child = fdProfile ? spawnHostedFdChild(launch.command, launch.args, { cwd: "/" }, unit, HostedFdLaunchKind.Installer) :
        spawn(launch.command, launch.args, { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: "ignore" });
      const waited = new Promise<boolean>(resolve => {
        let errored = false;
        const timer = setTimeout(() => resolve(false), 21 * 60 * 1000); timer.unref();
        child.on("error", () => { errored = true; clearTimeout(timer); resolve(false); });
        child.on("exit", (status, signal) => { clearTimeout(timer); resolve(!errored && status === 0 && signal === null); });
      });
      if (!child.pid) fail();
      const pidBirth = collectProcessBirth(String(child.pid)), group = collectProcessCgroup(String(child.pid));
      if (group !== `0::/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/${request.attempt.launch.unit}`) fail();
      const creator = encode({ schemaVersion: 1, startId, startSha256: digest(start), pidBirth, controlGroup: group.slice(3) });
      createReadonlyPrivateRecord(join(plan.directory, "creator.json"), creator);
      return { plan, start, creator, profileSha256, waited, child, guard: fdProfile ? hostedFdLaunch(child) : undefined };
    });
    if (prepared.guard) {
      const guard = prepared.guard;
      try {
        await guard.observe();
        await retryHostedFenceAcquisition(() => withHostedActivationFence(fence => {
          const revalidate = () => {
            assertOwner(fence, request); assertHostedDependencyInstallerPlan(prepared.plan);
            const record = (name: string) => readHostedPrivateBytes(join(prepared.plan.directory, name), 64 * 1024);
            if (!record("start.json")?.equals(prepared.start) || !record("creator.json")?.equals(prepared.creator) ||
                !record("consumed.json")?.equals(encode({ schemaVersion: 1, startId, startSha256: digest(prepared.start) })) ||
                record("revoked.json") || record("creator-completion.json") || !prepared.child.pid) fail();
            const creator = decodePrivateJson(prepared.creator) as { pidBirth: string; controlGroup: string };
            if (collectProcessBirth(String(prepared.child.pid)) !== creator.pidBirth ||
                collectProcessCgroup(String(prepared.child.pid)) !== `0::${creator.controlGroup}`) fail();
          };
          revalidate(); guard.release(fence, hostedInstallerReleaseMarker, true, revalidate);
        }), guard.remainingSetupMs());
      } catch { guard.invalidate(); prepared.child.kill("SIGTERM"); fail(); }
    }
    if (!await prepared.waited) fail();
    return withHostedActivationFence(fence => {
      assertOwner(fence, request); assertHostedDependencyInstallerPlan(prepared.plan);
      const completion = encode({ schemaVersion: 1, startId, startSha256: digest(prepared.start), creatorSha256: digest(prepared.creator), status: 0, creatorWaitReturned: true });
      createReadonlyPrivateRecord(join(prepared.plan.directory, "creator-completion.json"), completion);
      createReadonlyPrivateRecord(join(prepared.plan.directory, "revoked.json"), encode({ schemaVersion: 1, startId, completionSha256: digest(completion) }));
      const emptySha256 = drain(prepared.plan, unit), path = join(prepared.plan.stagingDirectory, "node_modules");
      const before = lstatSync(path, { bigint: true }); if (!before.isDirectory() || before.isSymbolicLink()) fail();
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true }), after = lstatSync(path, { bigint: true });
        if (before.dev !== opened.dev || before.ino !== opened.ino || before.dev !== after.dev || before.ino !== after.ino) fail();
        createReadonlyPrivateRecord(join(prepared.plan.directory, "terminal.json"), encode({ schemaVersion: 1, startId, emptySha256, completionSha256: digest(completion), output: { dev: String(before.dev), ino: String(before.ino) } }));
        return { lockName: inputs.lockName, recipe: HostedDependencyInstallerRecipe.NpmRegistryNoScriptsV1, startId, unit, inputSha256: inputs.sha256,
          profileSha256: prepared.profileSha256, completionSha256: digest(completion), output: { canonicalPath: path, dev: String(before.dev), ino: String(before.ino) } };
      } finally { closeSync(fd); }
    });
  }
}
