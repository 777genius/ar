import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DependencyOwnerPhase, sameDependencyAttempt, sameDependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { assertCurrentHostedDependencyAttempt, prepareCurrentHostedDependencyRootPurpose,
  readHostedDependencyRootDirectoryPin, readHostedDependencyRootGitConfigPin, CurrentHostedDependencyOriginKind } from "../provider-codex/app-server/adapters/hosted-current-dependency-origin";
import type { HostedDependencyRootPreparationRecord } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
import { assertHostedDependencyRootGitConfigBytes } from "../provider-codex/app-server/adapters/hosted-dependency-root-git-config";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readCurrentHostedDependencyRootQualification } from "./hosted-dependency-tool-profile";
import { HostedDependencyInstallerRecipe } from "./hosted-dependency-installer-inputs";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
import { ensureHostedDependencyDirectory, readHostedDependencyCommittedReady, readHostedDependencyEstablishedReceipt } from "./hosted-dependency-receipts";
import { createReadonlyPrivateRecord } from "./hosted-readonly-custody";

const root = "/var/lib/subscription-runtime-host-policy";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)+"\n");
function invalid(): never { throw new Error("hosted_dependency_root_preparation_unresolved"); }
function privatePin(path: string, maximum: number) {
  const bytes = readHostedPrivateBytes(path,maximum); if (!bytes) invalid();
  const pin = pinReferenceFile(path,maximum); if (!pin.bytes.equals(bytes)) invalid(); return pin;
}
function syncDirectory(path: string): void {
  const fd = openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Only the one actual completed qualifier supplies facts. No caller path,
 * profile, Ready/ref, source list, config or transport permit is accepted.
 * Called before Running; every uncertain side effect retains its registration.
 */
export function prepareHostedDependencyRootHelpers(fence: HostedActivationFence): void {
  const qualified = readCurrentHostedDependencyRootQualification(fence), {context,binding,attempt,inputs,receipt} = qualified;
  const current = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (current.facts.kind !== CurrentHostedDependencyOriginKind.ManagedReadonlyLocal) return;
  if (qualified.phase !== DependencyOwnerPhase.ExclusiveMutation || !sameDependencyAttempt(current.attempt,attempt) ||
      inputs.recipe !== HostedDependencyInstallerRecipe.NpmLocalNoLifecycleV1 || !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(receipt))) invalid();
  const profile = readHostedDependencyInstallerProfile();
  if (profile.schemaVersion !== 2 || createHash("sha256").update(encode(profile)).digest("hex") !== inputs.profileSha256) invalid();
  const profilePin = privatePin(root+"/dependency-installer-profile.json",16384);
  if (!profilePin.bytes.equals(encode(profile))) invalid();
  // Candidate C argv/root is independently selected again by the actual issuer.
  const durablePath = binding.jobRootDir+"/durable-handoffs";
  ensureHostedDependencyDirectory(durablePath); const durableHandoffRoot = readHostedDependencyRootDirectoryPin(durablePath);
  if (durableHandoffRoot.dev !== binding.workspace.dev) invalid();
  const scratchRoot = root+"/dependency-root-scratch";
  ensureHostedDependencyDirectory(scratchRoot); const scratchRootPin = readHostedDependencyRootDirectoryPin(scratchRoot);
  const protectedRoot = readHostedDependencyRootDirectoryPin(root);
  if (scratchRootPin.dev !== protectedRoot.dev || scratchRootPin.mountId !== protectedRoot.mountId) invalid();
  const scratchPath = `${scratchRoot}/${attempt.launch.startId}`;
  mkdirSync(scratchPath,{mode:0o700}); // Collision/replay is held evidence.
  const scratchStat = lstatSync(scratchPath);
  if (scratchStat.uid !== 0 || scratchStat.gid !== 0 || (scratchStat.mode & 0o7777) !== 0o700) invalid();
  syncDirectory(scratchPath); syncDirectory(scratchRoot);
  const scratchParent = readHostedDependencyRootDirectoryPin(scratchPath);
  if (scratchParent.dev !== scratchRootPin.dev || scratchParent.mountId !== scratchRootPin.mountId) invalid();
  const authoredRoots = [readHostedDependencyRootDirectoryPin(binding.workspace.canonicalPath),
    ...qualified.readonlySources.map(source => {
      const pin = readHostedDependencyRootDirectoryPin(source.canonicalPath);
      if (pin.dev !== source.identity.dev || pin.ino !== source.identity.ino) invalid(); return pin;
    })];
  if (durableHandoffRoot.mountId !== authoredRoots[0]!.mountId) invalid();
  const generatedRoots = [readHostedDependencyRootDirectoryPin(join(binding.workspace.canonicalPath,"node_modules"))];
  if (generatedRoots[0]!.dev !== receipt.tree.dev || generatedRoots[0]!.ino !== receipt.tree.ino) invalid();
  const sourceLookupAncestors = [...new Set(inputs.capture.ancestorPins.map(pin => pin.path))].sort().map(relative => {
    const pin = inputs.capture.ancestorPins.find(value => value.path === relative); if (!pin) invalid();
    const actual = readHostedDependencyRootDirectoryPin(join(binding.workspace.canonicalPath,relative));
    if (actual.dev !== pin.dev || actual.ino !== pin.ino || actual.mountId !== pin.mountId) invalid(); return actual;
  });
  // The existing source parser checks .git protection and bounded config.
  // Hash+physical reference is retained and reread by every actual purpose assert.
  const configPin = readHostedDependencyRootGitConfigPin(binding.workspace.canonicalPath);
  assertHostedDependencyRootGitConfigBytes(configPin.bytes);
  const qualification = privatePin(root+"/"+dependencyToolQualificationRecordName(attempt.launch.startId),16384);
  const committed = readHostedDependencyCommittedReady(binding,receipt.revision);
  if (!encode(committed.receipt).equals(encode(receipt))) invalid();
  const record: HostedDependencyRootPreparationRecord = {version:1,attempt,custodyReference:current.facts.association.reference,
    qualification:qualification.reference,ready:committed.reference,readyRevision:receipt.revision,
    protectedProfile:profilePin.reference,config:configPin.reference,configAncestors:configPin.ancestors,durableHandoffRoot,scratchParent,authoredRoots,generatedRoots,sourceLookupAncestors};
  ensureHostedDependencyDirectory(root+"/dependency-root-preparations");
  const recordPath = `${root}/dependency-root-preparations/${attempt.launch.startId}.json`;
  createReadonlyPrivateRecord(recordPath,encode(record));
  if (!privatePin(recordPath,65536).bytes.equals(encode(record))) invalid();
  const after = assertCurrentHostedDependencyAttempt(context,fence,DependencyOwnerPhase.ExclusiveMutation);
  if (!sameDependencyAttempt(after.attempt,attempt) || !sameDependencyProtectedReference(after.facts.kind === CurrentHostedDependencyOriginKind.ManagedReadonlyLocal ?
      after.facts.association.reference : invalid(),record.custodyReference) || !encode(readHostedDependencyEstablishedReceipt(binding)).equals(encode(receipt))) invalid();
  prepareCurrentHostedDependencyRootPurpose(context,fence);
}
