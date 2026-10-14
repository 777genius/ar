import { types } from "node:util";
import { readHostedDependencyParentRecipe } from "./hosted-dependency-parent-recipe";
import { assertHostedDependencyBindingInventoryRevision, HostedDependencyReferenceKind } from "./hosted-dependency-workspace";
import { HostedCustodyReservationState, DependencyReceiptState } from "@vioxen/subscription-runtime/worker-core";
import { LocalDependencyOwnerStore } from "../store-local-file/dependency-environment/local-dependency-owner-store";
import { fenceDependencyConsumer, isDependencyConsumerOwner } from "@vioxen/subscription-runtime/worker-core";
import { assertHostedDependencyQualifiedInventory, hostedDependencyBindingName, hostedDependencyBindingRoot, hostedDependencyOwnerRoot, hostedDependencyJobsRoot, hostedDependencyJobRoot, isHostedDependencyWorkspace, parseHostedDependencyBinding, assertHostedDependencyPhysicalWorkspace, readHostedDependencyBinding } from "./hosted-dependency-workspace";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import { withHostedActivationFence } from "./hosted-dependency-activation";
import { HostedActivationPhase } from "@vioxen/subscription-runtime/worker-core";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, unlinkSync, openSync, fsyncSync, closeSync, fstatSync, readdirSync } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, link, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseDependencyToolRegistration, type DependencyToolRegistration } from "../core/dependency-environment/dependency-tool-profile";
import { createHostedDependencyToolProfile, assertHostedDependencyToolProfileFiles } from "./hosted-dependency-tool-profile-files";
import {
  assertHostedTestEgressIdentity,
  parseHostedTestEgressGrant,
  type HostedTestEgressGrant,
  type HostedTestEgressIdentity,
} from "./hosted-test-egress-contract";

import { hostedTestEgressGrantRoot } from "./hosted-test-egress-paths";
export { hostedTestEgressGrantRoot } from "./hosted-test-egress-paths";

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

/** Finite selection data only; no caller operation/proof/profile/binding. The
 * SAME original issuer generates and authenticates the protected v3 record. */
export type HostedDependencyReferenceEnrollment = Readonly<{
  candidateJobId: string;
  kind: HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1;
}>;
function localReferenceSelection(value: unknown): HostedDependencyReferenceEnrollment {
  if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) referenceEnrollmentFailed();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes("candidateJobId") || !keys.includes("kind") ||
      !Object.values(descriptors).every(d => "value" in d)) referenceEnrollmentFailed();
  const candidateJobId: unknown = descriptors.candidateJobId!.value, kind: unknown = descriptors.kind!.value;
  if (typeof candidateJobId !== "string" || kind !== HostedDependencyReferenceKind.LegacyLocalNoLifecycleV1) referenceEnrollmentFailed();
  hostedDependencyJobRoot(candidateJobId);
  return Object.freeze({ candidateJobId, kind });
}
function referenceEnrollmentFailed(): never { throw new Error("hosted_dependency_reference_fresh_closed_enrollment_required"); }

export async function writeHostedTestEgressGrant(
  grant: HostedTestEgressGrant,
  toolRegistration?: DependencyToolRegistration,
  referenceEnrollment?: HostedDependencyReferenceEnrollment,
): Promise<void> {
  const reference = referenceEnrollment === undefined ? undefined : localReferenceSelection(referenceEnrollment);
  if (reference && toolRegistration !== undefined) referenceEnrollmentFailed();
  const detachedGrant = reference ? parseHostedTestEgressGrant(grant) : undefined;
  await assertHostedTestEgressOperator();
  const validated = detachedGrant ?? parseHostedTestEgressGrant(grant);
  await canonicalHostedTestIdentity(validated);
  const tools = toolRegistration === undefined ? undefined : parseDependencyToolRegistration(toolRegistration);
  if (tools && (!isHostedDependencyWorkspace(validated.workspacePath) || validated.schemaVersion !== 1 ||
      validated.profileId !== CodexProviderEgressProfileId.TestNpmQualification)) throw new Error("hosted_dependency_tool_profile_unsupported");
  if (isHostedDependencyWorkspace(validated.workspacePath) &&
      (validated.schemaVersion !== 1 || validated.profileId !== CodexProviderEgressProfileId.TestNpmQualification ||
       validated.jobRootDir !== hostedDependencyJobRoot(validated.jobId) ||
       validated.workspacePath !== validated.jobRootDir + "/workspace")) {
    throw new Error("hosted_dependency_profile_unsupported");
  }

  const target = join(hostedTestEgressGrantRoot, hostedTestEgressGrantName(reference ? validated.jobId : grant.jobId));
  if (reference) {
    if (validated.schemaVersion !== 1 || validated.profileId !== CodexProviderEgressProfileId.TestNpmQualification ||
        validated.jobRootDir !== hostedDependencyJobRoot(validated.jobId) || validated.workspacePath !== validated.jobRootDir + "/workspace") referenceEnrollmentFailed();
    // Lazy original adapters keep the existing non-reference import/behavior
    // surface unchanged; all asynchronous work finishes BEFORE the fence.
    const { readHostedInstallationActivation } = await import("./hosted-installation-activation");
    const { createReadonlyPrivateRecord } = await import("./hosted-readonly-custody");
    const { assertInspectedInstallation, assertActivationSession } = await import("./hosted-installation-physical-facts");
    const { HostedReadonlyHostKernel, readHostedReadonlyHostInventory } = await import("./hosted-readonly-host-kernel");
    const { pinReferenceFile, referencePath } = await import("./hosted-dependency-legacy-reference-records");
    const { readHostedDependencyEstablishedReceipt, hostedDependencyReceiptHistoryRoot } = await import("./hosted-dependency-receipts");
    withHostedActivationFence(fence => {
      const original = readHostedInstallationActivation(), kernel = new HostedReadonlyHostKernel(), session = kernel.operatorSession();
      if (original.activation.phase !== HostedActivationPhase.Closed ||
          original.activation.ordinaryStarts.some(row => row.state !== HostedCustodyReservationState.Terminal)) referenceEnrollmentFailed();
      assertInspectedInstallation(original.installation); assertActivationSession(original.activation,session);
      assertHostedDependencyQualifiedInventory(); kernel.verifyExclusiveInventory(fence); kernel.verifyDescriptorBoundary();
      const candidate = readHostedDependencyBinding(reference.candidateJobId);
      if (!candidate || candidate.version !== 2 || candidate.jobId === validated.jobId ||
          candidate.installationId !== original.installation.installationId || candidate.runtimeSha !== original.installation.runtimeSha) referenceEnrollmentFailed();
      assertHostedDependencyPhysicalWorkspace(candidate); assertHostedDependencyToolProfileFiles(candidate.toolProfile,candidate.jobRootDir);
      const candidateBindingPath = "/var/lib/subscription-runtime-host-policy/" + hostedDependencyBindingName(candidate.jobId);
      const candidatePin = pinReferenceFile(candidateBindingPath), candidateGrantPath = join(hostedTestEgressGrantRoot,hostedTestEgressGrantName(candidate.jobId));
      const candidateGrant = pinReferenceFile(candidateGrantPath,4096), parsedCandidateGrant = parseHostedTestEgressGrant(JSON.parse(candidateGrant.bytes.toString("utf8")));
      assertHostedTestEgressIdentity(parsedCandidateGrant,{jobId:candidate.jobId,jobRootDir:candidate.jobRootDir,workspacePath:candidate.workspace.canonicalPath});
      if (parsedCandidateGrant.schemaVersion !== 1 || parsedCandidateGrant.profileId !== CodexProviderEgressProfileId.TestNpmQualification ||
          candidateGrant.reference.sha256 !== candidate.grantDigest || !candidatePin.bytes.equals(Buffer.from(JSON.stringify(candidate)+"\n"))) referenceEnrollmentFailed();
      // Established read never initializes or migrates history. A missing
      // history root is observed separately, not created by eligibility checks.
      let historyPresent = true;
      try { lstatSync(hostedDependencyReceiptHistoryRoot); } catch(error) { if (!isMissing(error)) throw error; historyPresent = false; }
      const prior = historyPresent ? readHostedDependencyEstablishedReceipt(candidate) : null;
      if (prior && prior.state !== DependencyReceiptState.Unverified) referenceEnrollmentFailed();
      const owners = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
      let candidateOwner: ReturnType<LocalDependencyOwnerStore["read"]>;
      try { candidateOwner = owners.read(candidate.workspace); } finally { owners.close(); }
      if (candidateOwner?.owner) referenceEnrollmentFailed();
      const stat = lstatSync(validated.workspacePath,{bigint:true}), bytes = Buffer.from(JSON.stringify(validated)+"\n");
      const workspace = {canonicalPath:validated.workspacePath,dev:String(stat.dev),ino:String(stat.ino)};
      if (workspace.canonicalPath === candidate.workspace.canonicalPath || workspace.dev === candidate.workspace.dev && workspace.ino === candidate.workspace.ino || bytes.length > 4096) referenceEnrollmentFailed();
      const bindingPath = "/var/lib/subscription-runtime-host-policy/" + hostedDependencyBindingName(validated.jobId);
      const absencePath = `/var/lib/subscription-runtime-host-policy/dependency-fresh-absence/${workspace.dev}-${workspace.ino}.json`;
      const absent = (path: string) => { try { lstatSync(path); referenceEnrollmentFailed(); } catch(error) { if (!isMissing(error)) throw error; } };
      // Existing/partial leaves forbid re-entry BEFORE another UUID can exist.
      for (const path of [bindingPath,target,absencePath,hostedDependencyOwnerRoot+`/${workspace.dev}-${workspace.ino}.json`,
        `/var/lib/subscription-runtime-host-policy/dependency-receipts/${workspace.dev}-${workspace.ino}`,
        `/var/lib/subscription-runtime-host-policy/ordinary-origins/${hostedTestEgressGrantName(validated.jobId)}`]) absent(path);
      const inventory = readHostedReadonlyHostInventory();
      for (const jobId of [candidate.jobId,validated.jobId]) if (inventory.ordinaryCreators.filter(row=>row.jobId===jobId).length !== 1) referenceEnrollmentFailed();
      for (const [jobId,root,path] of [[candidate.jobId,candidate.jobRootDir,candidate.workspace.canonicalPath],
        [validated.jobId,validated.jobRootDir,workspace.canonicalPath]] as const) {
        const creator = inventory.ordinaryCreators.find(row=>row.jobId===jobId)!;
        readHostedDependencyParentRecipe(creator.launch,root,path);
      }
      const assertReferenceHistoryAbsent = () => {
        let present = true;
        try { lstatSync(hostedDependencyReceiptHistoryRoot); } catch(error) { if (!isMissing(error)) throw error; present = false; }
        if (present !== historyPresent) referenceEnrollmentFailed();
        if (present) {
          const names = readdirSync(hostedDependencyReceiptHistoryRoot);
          if (names.length > 4096 || names.some(name=>name.startsWith(`${workspace.dev}-${workspace.ino}.`))) referenceEnrollmentFailed();
        }
        absent(`/var/lib/subscription-runtime-host-policy/dependency-receipts/${workspace.dev}-${workspace.ino}`);
        const ownerNames = readdirSync(hostedDependencyOwnerRoot);
        if (ownerNames.length > 4096 || ownerNames.some(name=>name.startsWith(`${workspace.dev}-${workspace.ino}.`))) referenceEnrollmentFailed();
      };
      assertReferenceHistoryAbsent();
      absent(`/var/lib/subscription-runtime-host-policy/dependency-receipts/${candidate.workspace.dev}-${candidate.workspace.ino}`);
      for (const row of original.activation.ordinaryStarts) {
        const start = pinReferenceFile(`/var/lib/subscription-runtime-host-policy/ordinary-starts/${row.startId}.json`);
        if (JSON.parse(start.bytes.toString("utf8")).workspacePath === workspace.canonicalPath) referenceEnrollmentFailed();
      }
      // The reference body is issued here, never supplied by a TEST seed.
      const operationId = randomUUID();
      const binding = parseHostedDependencyBinding({version:3,jobId:validated.jobId,jobRootDir:validated.jobRootDir,workspace,
        installationId:original.installation.installationId,runtimeSha:original.installation.runtimeSha,
        grantDigest:createHash("sha256").update(bytes).digest("hex"),reference:{kind:reference.kind,operationId}});
      assertHostedDependencyBindingInventoryRevision(binding,inventory.schemaVersion);
      for (const row of inventory.ordinaryCreators) {
        const retained = readHostedDependencyBinding(row.jobId);
        if (retained?.version === 3 && retained.reference.operationId === operationId) referenceEnrollmentFailed();
      }
      for (const suffix of ["reference","reference-start","reference-entry","reference-result","reference-release","comparison"] as const) absent(referencePath(operationId,suffix));
      assertHostedDependencyPhysicalWorkspace(binding);
      for (const path of [hostedDependencyJobsRoot,validated.jobRootDir]) if (lstatSync(path).mode & 0o077) referenceEnrollmentFailed();
      const fd = openSync(workspace.canonicalPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      const bindingBytes = Buffer.from(JSON.stringify(binding)+"\n"), absenceBytes = Buffer.from(JSON.stringify({version:1,workspace,
        coverageRevision:createHash("sha256").update(bindingBytes).digest("hex")})+"\n");
      try {
        const physical = fstatSync(fd,{bigint:true});
        const rejoin = (published: 0 | 1 | 2 | 3) => {
          const current = readHostedInstallationActivation();
          if (JSON.stringify(current) !== JSON.stringify(original)) referenceEnrollmentFailed();
          assertActivationSession(current.activation,kernel.operatorSession()); assertInspectedInstallation(current.installation);
          assertHostedDependencyPhysicalWorkspace(candidate); assertHostedDependencyPhysicalWorkspace(binding);
          assertHostedDependencyToolProfileFiles(candidate.toolProfile,candidate.jobRootDir);
          assertHostedDependencyQualifiedInventory(); kernel.verifyExclusiveInventory(fence);
          assertReferenceHistoryAbsent();
          absent(`/var/lib/subscription-runtime-host-policy/ordinary-origins/${hostedTestEgressGrantName(validated.jobId)}`);
          for (const suffix of ["reference","reference-start","reference-entry","reference-result","reference-release","comparison"] as const) absent(referencePath(operationId,suffix));
          const currentOwners = LocalDependencyOwnerStore.open({rootPath:hostedDependencyOwnerRoot,maxRecordBytes:16384});
          try { if (JSON.stringify(currentOwners.read(candidate.workspace)) !== JSON.stringify(candidateOwner)) referenceEnrollmentFailed(); }
          finally { currentOwners.close(); }
          if (JSON.stringify(historyPresent ? readHostedDependencyEstablishedReceipt(candidate) : null) !== JSON.stringify(prior)) referenceEnrollmentFailed();
          absent(`/var/lib/subscription-runtime-host-policy/dependency-receipts/${candidate.workspace.dev}-${candidate.workspace.ino}`);
          const currentBinding = pinReferenceFile(candidateBindingPath), currentGrant = pinReferenceFile(candidateGrantPath,4096);
          if (!currentBinding.bytes.equals(candidatePin.bytes) || !currentGrant.bytes.equals(candidateGrant.bytes) ||
              JSON.stringify(currentBinding.reference) !== JSON.stringify(candidatePin.reference) ||
              JSON.stringify(currentGrant.reference) !== JSON.stringify(candidateGrant.reference)) referenceEnrollmentFailed();
          const held = fstatSync(fd,{bigint:true}), named = lstatSync(workspace.canonicalPath,{bigint:true});
          for (const value of [held,named]) if (!value.isDirectory() || value.uid !== 0n || value.dev !== physical.dev || value.ino !== physical.ino ||
            value.dev.toString() !== workspace.dev || value.ino.toString() !== workspace.ino || value.ctimeNs !== physical.ctimeNs || value.mtimeNs !== physical.mtimeNs) referenceEnrollmentFailed();
          const names = readdirSync(`/proc/self/fd/${fd}`); if (names.length !== 1 || names[0] !== ".git") referenceEnrollmentFailed();
          const git = lstatSync(workspace.canonicalPath+"/.git"); if (!git.isDirectory() || git.isSymbolicLink() || git.uid !== 0 || git.mode & 0o022) referenceEnrollmentFailed();
          for (const [index,path,value] of [[1,bindingPath,bindingBytes],[2,absencePath,absenceBytes],[3,target,bytes]] as const) {
            if (published < index) absent(path); else if (!pinReferenceFile(path,65536).bytes.equals(value)) referenceEnrollmentFailed();
          }
        };
        rejoin(0);
        for (const path of [hostedDependencyBindingRoot,hostedDependencyOwnerRoot,hostedTestEgressGrantRoot,
          "/var/lib/subscription-runtime-host-policy/dependency-fresh-absence","/var/lib/subscription-runtime-host-policy/dependency-provider-attempts",
          "/var/lib/subscription-runtime-host-policy/dependency-attempt-fences","/var/lib/subscription-runtime-host-policy/dependency-installers"])
          createPrivateGrantDirectory(path);
        rejoin(0);
        // Every interrupted prefix remains refused by original consumers:
        // binding without grant has no matching origin; no original prepared
        // relation exists. Grant is the LAST leaf, never an early bypass.
        createReadonlyPrivateRecord(bindingPath,bindingBytes); rejoin(1);
        createReadonlyPrivateRecord(absencePath,absenceBytes); rejoin(2);
        createReadonlyPrivateRecord(target,bytes); rejoin(3);
      } finally { closeSync(fd); }
    });
    return;
  }
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
      const { installation, activation } = readHostedInstallationActivation();
      if (tools && (activation.phase !== HostedActivationPhase.Closed || readHostedDependencyBinding(validated.jobId))) {
        throw new Error("hosted_dependency_tool_fresh_closed_enrollment_required");
      }
      assertHostedDependencyQualifiedInventory();
      const stat = lstatSync(validated.workspacePath, { bigint: true });
      const binding = parseHostedDependencyBinding({ version: tools ? 2 : 1, jobId: validated.jobId,
        jobRootDir: validated.jobRootDir, workspace: { canonicalPath: validated.workspacePath,
          dev: stat.dev.toString(), ino: stat.ino.toString() }, installationId: installation.installationId,
        runtimeSha: installation.runtimeSha,
        grantDigest: createHash("sha256").update(Buffer.from(JSON.stringify(validated) + "\n")).digest("hex"),
        ...(tools ? { toolProfile: createHostedDependencyToolProfile(validated.jobRootDir, tools) } : {}) });
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
