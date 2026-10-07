import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { fenceDependencyConsumer, isDependencyConsumerOwner } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedDependencyQualifiedInventory, hostedDependencyBindingName, hostedDependencyBindingRoot, hostedDependencyOwnerRoot, hostedDependencyJobsRoot, hostedDependencyJobRoot, isHostedDependencyWorkspace, parseHostedDependencyBinding, assertHostedDependencyPhysicalWorkspace, readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, unlinkSync, openSync, fsyncSync, closeSync } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertHostedTestEgressIdentity,
  parseHostedTestEgressGrant,
  type HostedTestEgressGrant,
  type HostedTestEgressIdentity,
} from "./hosted-test-egress-contract";

// Already hidden by InaccessiblePaths=-/run/user in older hosted installations.
export const hostedTestEgressGrantRoot =
  "/run/user/0/subscription-runtime-host-policy/codex-egress";

export async function assertHostedTestEgressOperator(): Promise<void> {
  try {
    if (process.platform !== "linux" || process.getuid?.() !== 0 ||
        !(await readFile("/proc/self/uid_map", "utf8"))
          .trim().match(/^0\s+0\s+4294967295$/)) throw new Error();
    for (const namespace of ["user", "mnt", "pid"]) {
      if (await readlink(`/proc/self/ns/${namespace}`) !==
          await readlink(`/proc/1/ns/${namespace}`)) throw new Error();
    }
  } catch {
    throw new Error("hosted_test_egress_host_operator_required");
  }
}

export function hostedTestEgressGrantName(jobId: string): string {
  return createHash("sha256").update(jobId).digest("hex") + ".json";
}

export async function canonicalHostedTestIdentity(
  identity: HostedTestEgressIdentity,
  ownerUid = 0,
): Promise<HostedTestEgressIdentity> {
  // A hosted tool may edit workspace contents, never an ancestor of either identity.
  if (identity.jobRootDir.startsWith(identity.workspacePath + "/")) {
    throw new Error("hosted_test_egress_identity_invalid");
  }
  for (const path of [identity.jobRootDir, identity.workspacePath]) {
    if (!isAbsolute(path) || resolve(path) !== path ||
        hostedTestEgressGrantRoot === path ||
        hostedTestEgressGrantRoot.startsWith(path.endsWith("/") ? path : path + "/") ||
        !await assertHostedTestEgressDirectory(path, false, ownerUid, false)) {
      throw new Error("hosted_test_egress_identity_invalid");
    }
  }
  return identity;
}

/** Adapter seam for disposable tests; production callers always use the fixed root. */
export async function assertHostedTestEgressDirectory(
  root: string,
  create = false,
  ownerUid = 0,
  privateLeaf = true,
): Promise<boolean> {
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error("hosted_test_egress_custody_invalid");
  }
  const parents: string[] = [];
  for (let p = root; p !== dirname(p); p = dirname(p)) parents.unshift(p);
  parents.unshift("/");
  // Walk from / downward: each checked parent prevents an untrusted actor from
  // renaming the next component while it is inspected or later used at launch.
  // Host root/mount orchestration remains trusted; a second realpath cannot do this.
  for (const path of parents) {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return false;
      await mkdir(path, { mode: 0o700 });
      stat = await lstat(path);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (stat.uid !== 0 && stat.uid !== ownerUid) || (stat.mode & 0o022) !== 0 ||
        (privateLeaf && path === root && (stat.mode & 0o077) !== 0)) {
      throw new Error("hosted_test_egress_custody_invalid");
    }
  }
  return true;
}

export async function readHostedTestEgressGrantFile(
  root: string,
  identity: HostedTestEgressIdentity,
  ownerUid = 0,
): Promise<HostedTestEgressGrant | null> {
  if (!await assertHostedTestEgressDirectory(root, false, ownerUid)) return null;
  let file;
  try {
    file = await open(join(root, hostedTestEgressGrantName(identity.jobId)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("hosted_test_egress_custody_invalid");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== ownerUid || stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 || stat.size > 4096) {
      throw new Error("hosted_test_egress_custody_invalid");
    }
    const grant = parseHostedTestEgressGrant(JSON.parse(await file.readFile("utf8")));
    assertHostedTestEgressIdentity(grant, identity);
    await canonicalHostedTestIdentity(identity, ownerUid);
    return grant;
  } catch {
    throw new Error("hosted_test_egress_grant_invalid");
  } finally {
    await file.close();
  }
}

export async function writeHostedTestEgressGrant(
  grant: HostedTestEgressGrant,
): Promise<void> {
  await assertHostedTestEgressOperator();
  const validated = parseHostedTestEgressGrant(grant);
  await canonicalHostedTestIdentity(validated);
  if (isHostedDependencyWorkspace(validated.workspacePath) &&
      (validated.schemaVersion !== 1 || validated.profileId !== CodexProviderEgressProfileId.TestNpmQualification ||
       validated.jobRootDir !== hostedDependencyJobRoot(validated.jobId) ||
       validated.workspacePath !== validated.jobRootDir + "/workspace")) {
    throw new Error("hosted_dependency_profile_unsupported");
  }

  const target = join(hostedTestEgressGrantRoot, hostedTestEgressGrantName(grant.jobId));
  if (validated.schemaVersion === 3) {
    const { readHostedInstallationActivation } = await import("./hosted-installation-activation");
    const { createReadonlyPrivateRecord } = await import("./hosted-readonly-custody");
    withHostedActivationFence(() => {
      if (readHostedInstallationActivation().activation.phase !== HostedActivationPhase.Closed) throw new Error("hosted_child_enrollment_closed_required");
      createPrivateGrantDirectory(hostedTestEgressGrantRoot);
      const bytes = Buffer.from(JSON.stringify(validated) + "\n");
      if (bytes.length > 4096) throw new Error("hosted_test_egress_grant_invalid");
      createReadonlyPrivateRecord(target, bytes);
    });
    return;
  }
  await assertHostedTestEgressDirectory(hostedTestEgressGrantRoot, true);
  await publishImmutableHostedGrantFile(hostedTestEgressGrantRoot, validated);
  if (isHostedDependencyWorkspace(validated.workspacePath)) {
    const { readHostedInstallationActivation } = await import("./hosted-installation-activation");
    const { createReadonlyPrivateRecord } = await import("./hosted-readonly-custody");
    withHostedActivationFence(() => {
      const { installation } = readHostedInstallationActivation();
      assertHostedDependencyQualifiedInventory();
      const stat = lstatSync(validated.workspacePath, { bigint: true });
      const binding = parseHostedDependencyBinding({ version: 1, jobId: validated.jobId,
        jobRootDir: validated.jobRootDir, workspace: { canonicalPath: validated.workspacePath,
          dev: stat.dev.toString(), ino: stat.ino.toString() }, installationId: installation.installationId,
        runtimeSha: installation.runtimeSha,
        grantDigest: createHash("sha256").update(Buffer.from(JSON.stringify(validated) + "\n")).digest("hex") });
      assertHostedDependencyPhysicalWorkspace(binding);
      // This namespace is a fresh TEST backing, not a flag on an arbitrary user
      // path. Old managed profiles already hide the entire policy prefix.
      for (const path of [hostedDependencyJobsRoot, validated.jobRootDir]) {
        if ((lstatSync(path).mode & 0o077) !== 0) throw new Error("hosted_dependency_backing_private_required");
      }
      createPrivateGrantDirectory(hostedDependencyBindingRoot);
      createPrivateGrantDirectory(hostedDependencyOwnerRoot);
      createPrivateGrantDirectory("/var/lib/subscription-runtime-host-policy/dependency-provider-attempts");
      createPrivateGrantDirectory("/var/lib/subscription-runtime-host-policy/dependency-attempt-fences");
      createPrivateGrantDirectory("/var/lib/subscription-runtime-host-policy/dependency-installers");
      createPrivateGrantDirectory("/var/lib/subscription-runtime-host-policy/dependency-fresh-absence");
      // Enrollment captures fresh absence only before any binding has existed.
      // Reissuing an old grant after a user removed a tree cannot mint absence.
      if (!readHostedDependencyBinding(validated.jobId)) {
        let absent = false;
        try { lstatSync(validated.workspacePath + "/node_modules"); }
        catch (error) { if (!isMissing(error)) throw error; absent = true; }
        if (absent) createReadonlyPrivateRecord(`/var/lib/subscription-runtime-host-policy/dependency-fresh-absence/${binding.workspace.dev}-${binding.workspace.ino}.json`,
          Buffer.from(JSON.stringify({ version: 1, workspace: binding.workspace,
            coverageRevision: createHash("sha256").update(Buffer.from(JSON.stringify(binding) + "\n")).digest("hex") }) + "\n"));
      }
      createReadonlyPrivateRecord("/var/lib/subscription-runtime-host-policy/" + hostedDependencyBindingName(validated.jobId),
        Buffer.from(JSON.stringify(binding) + "\n"));
    });
  }
}

/** Filesystem publication seam for fresh disposable TEST registries. Production
 * enrollment uses the fixed root and CLOSED fence above. */
export async function publishImmutableHostedGrantFile(root: string, grant: HostedTestEgressGrant): Promise<void> {
  const validated = parseHostedTestEgressGrant(grant);
  if (validated.schemaVersion === 3) throw new Error("hosted_child_enrollment_closed_required");
  await assertHostedTestEgressDirectory(root);
  const bytes = Buffer.from(JSON.stringify(validated) + "\n");
  if (bytes.length > 4096) throw new Error("hosted_test_egress_grant_invalid");
  const target = join(root, hostedTestEgressGrantName(validated.jobId));
  const temporary = target + "." + randomUUID() + ".tmp";
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const retained = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await retained.stat();
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077) ||
            stat.size > 4096 || !(await retained.readFile()).equals(bytes)) {
          throw new Error("hosted_test_egress_immutable_conflict");
        }
      } finally { await retained.close(); }
    }
    await unlink(temporary); created = false;
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (created) await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}

export async function revokeHostedTestEgressGrant(jobId: string): Promise<void> {
  await assertHostedTestEgressOperator();
  if (!await assertHostedTestEgressDirectory(hostedTestEgressGrantRoot)) return;
  const target = join(hostedTestEgressGrantRoot, hostedTestEgressGrantName(jobId));
  let record;
  try { record = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isMissing(error)) return; throw new Error("hosted_test_egress_custody_invalid"); }
  let grant;
  try {
    const stat = await record.stat();
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 4096) throw new Error();
    grant = parseHostedTestEgressGrant(JSON.parse(await record.readFile("utf8")));
  } catch { throw new Error("hosted_test_egress_grant_invalid"); }
  finally { await record.close(); }
  if (grant.schemaVersion === 3) throw new Error("hosted_child_grant_immutable");
  const binding = readHostedDependencyBinding(jobId);
  if (binding) {
    const { createReadonlyPrivateRecord } = await import("./hosted-readonly-custody");
    withHostedActivationFence(() => {
      const store = LocalDependencyOwnerStore.open({ rootPath: hostedDependencyOwnerRoot, maxRecordBytes: 16384 });
      try {
        const owner = store.read(binding.workspace);
        if (owner?.owner) {
          if (!isDependencyConsumerOwner(owner.owner)) throw new Error("dependency_maintenance_busy");
          const attempt = owner.owner.attempt;
          fenceDependencyConsumer(store, binding.workspace, attempt);
          createReadonlyPrivateRecord(`/var/lib/subscription-runtime-host-policy/dependency-attempt-fences/${attempt.launch.startId}.json`,
            Buffer.from(JSON.stringify({ version: 1, startId: attempt.launch.startId, attemptId: attempt.attemptId, epoch: attempt.epoch }) + "\n"));
        }
        unlinkSync(target);
        const parent = openSync(hostedTestEgressGrantRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      } finally { store.close(); }
    });
    // Revocation alone never releases Running or a mapped/uncertain child.
    return;
  }
  await unlink(target)
    .catch((error: unknown) => { if (!isMissing(error)) throw error; });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function createPrivateGrantDirectory(root: string): void {
  const parents: string[] = [];
  for (let path = root;; path = dirname(path)) { parents.unshift(path); if (path === "/") break; }
  for (const path of parents) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (!isMissing(error)) throw error;
      mkdirSync(path, { mode: 0o700 }); stat = lstatSync(path);
    }
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) ||
        (path === root && (stat.mode & 0o077))) throw new Error("hosted_test_egress_custody_invalid");
  }
}
