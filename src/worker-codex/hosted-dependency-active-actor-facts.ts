import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { assertHostedActivationFence, readHostedActivationBytes,
  type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedDependencyQualifiedInventory, assertHostedDependencyPhysicalWorkspace,
  readHostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedDependencyParentRecipe } from "../provider-codex/app-server/adapters/hosted-dependency-parent-recipe";
import { readHostedReadonlyHostInventory, HostedReadonlyHostKernel, ordinaryCompletionBytes,
  ordinaryCompletionPath } from "./hosted-readonly-host-kernel";
import { readHostedInstallationActivation } from "./hosted-installation-origin-facts";
import { assertInspectedInstallation } from "./hosted-installation-physical-facts";
import { pinReferenceFile, referencePath, parseReferenceStart, parseReferenceEntry, parseReferenceResult,
  parseReferenceRelease, readReferenceRelation, encodeReference } from "./hosted-dependency-legacy-reference-records";
import { HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { assertOriginalHostedDependencyPhysicalRecordAccess } from "./hosted-current-dependency-origin";
import { assertOriginalHostedDependencyRemoverLock } from "./hosted-dependency-removal-context";

const digest = (bytes:Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid():never { throw new Error("hosted_dependency_active_actor_unresolved"); }
/** Fixed installed actor census, not a coverage DTO or exclusion permit. The
 * original map must join these facts to its own barrier and current attempt.
 * EVERY creator participates, including a distinct nominal workspace. */
export function readHostedDependencyActiveActorFacts(fence:HostedActivationFence,access:symbol) {
  // Consumer callers are already bracketed by the SAME original C/R context;
  // operator publication supplies its independent actual operator boundary.
  // This fixed factual reader cannot manufacture either principal.
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  // A pre-existing async removal lock has no authenticated future-effect
  // lifetime. Missing current PID/Terminal is not a discharge proof.
  const operations="/var/lib/subscription-runtime-host-policy/dependency-transactions";
  try {
    const before=lstatSync(operations,{bigint:true});if(!before.isDirectory() || before.uid!==0n || (before.mode&0o7777n)!==0o700n)invalid();
    const names=readdirSync(operations);if(names.length>4096)invalid();
    for(const name of names.filter(name=>name.endsWith(".remove.lock")))if(!assertOriginalHostedDependencyRemoverLock(`${operations}/${name}`,fence,access))return undefined;
    const after=lstatSync(operations,{bigint:true});if(before.dev!==after.dev || before.ino!==after.ino || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs)invalid();
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  assertHostedDependencyQualifiedInventory();
  const {installation,activation} = readHostedInstallationActivation();
  assertInspectedInstallation(installation);
  const inventory = readHostedReadonlyHostInventory(), inventoryBytes = readHostedActivationBytes("readonly-inventory.json");
  if (!inventoryBytes || digest(inventoryBytes)!==installation.inventorySha256 || inventory.schemaVersion!==4 ||
      !inventory.collectorProfile || !inventory.systemBusInfrastructure ||
      activation.bootId!==readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim() ||
      inventory.ordinaryCreators.length<1 || inventory.ordinaryCreators.length>128) invalid();
  const bindings=[];
  for (const creator of inventory.ordinaryCreators) {
    const binding = readHostedDependencyBinding(creator.jobId);
    // Explicit unclassified installed creators make Active unavailable. They
    // do not invent exclusion, and unchanged cold/Usable routes stay supported.
    if (!binding || binding.version===1) return undefined;
    if (creator.childSlotSha256!==undefined ||
        binding.installationId!==installation.installationId || binding.runtimeSha!==installation.runtimeSha ||
        binding.jobRootDir!==creator.jobRootDir || binding.workspace.canonicalPath!==creator.workspacePath) invalid();
    assertHostedDependencyPhysicalWorkspace(binding);
    assertHostedDependencyParentRecipe(creator.launch.args,binding.jobRootDir,binding.workspace.canonicalPath);
    if (binding.version===3) {
      const release=readHostedActivationBytes(referencePath(binding.reference.operationId,"reference-release").slice("/var/lib/subscription-runtime-host-policy/".length));
      if (!release) return undefined;
      assertClosedReferenceCreator(fence,binding.reference.operationId,binding.workspace,activation);
    }
    // Configuration alone does not authenticate a barrier. Pins below bind
    // the closed installed callgraph selected by the original producer.
    bindings.push({creatorId:creator.creatorId,binding});
  }
  const after = readHostedInstallationActivation();
  if (JSON.stringify(after)!==JSON.stringify({installation,activation}) ||
      !readHostedActivationBytes("readonly-inventory.json")?.equals(inventoryBytes)) invalid();
  return Object.freeze({installationId:installation.installationId,runtimeSha:installation.runtimeSha,
    runtimeManifestSha256:installation.runtimeManifestSha256,inventorySha256:installation.inventorySha256,
    bootId:activation.bootId,supervisorId:activation.supervisorId,
    creatorBindingsSha256:digest(encodeReference(bindings)),collectorProfileSha256:digest(encodeReference(inventory.collectorProfile)),
    // Catalog additions are authenticated above, not pinned as an immutable
    // generation. They must also pass the real reservation/claim boundary.
    enforcingRecipeSha256:digest(encodeReference(inventory.ordinaryCreators.map(creator=>creator.launch)))});
}
/** A v3 reference is finite and once-only. Its immutable seal is issued by the
 * existing private prepared copy; all later reserve attempts independently
 * refuse that consumed operation. A current empty scan is insufficient. */
export function readHostedDependencyActiveReferenceUnits(fence:HostedActivationFence,access:symbol):readonly string[] {
  assertOriginalHostedDependencyPhysicalRecordAccess(access);assertHostedActivationFence(fence);
  const initial=readHostedInstallationActivation(),inventory=readHostedReadonlyHostInventory(),units:string[]=[];
  if(inventory.ordinaryCreators.length>128)invalid();
  for(const creator of inventory.ordinaryCreators) {
    const binding=readHostedDependencyBinding(creator.jobId);if(binding?.version!==3)continue;
    if(binding.installationId!==initial.installation.installationId || binding.runtimeSha!==initial.installation.runtimeSha ||
        binding.jobRootDir!==creator.jobRootDir || binding.workspace.canonicalPath!==creator.workspacePath)invalid();
    assertClosedReferenceCreator(fence,binding.reference.operationId,binding.workspace,initial.activation);
    const start=parseReferenceStart(JSON.parse(pinReferenceFile(referencePath(binding.reference.operationId,"reference-start")).bytes.toString("utf8")));
    units.push(start.reservation.unit);
  }
  if(new Set(units).size!==units.length || JSON.stringify(readHostedInstallationActivation())!==JSON.stringify(initial))invalid();
  assertHostedActivationFence(fence);return Object.freeze(units);
}
function assertClosedReferenceCreator(fence:HostedActivationFence,operationId:string,
  workspace:{canonicalPath:string;dev:string;ino:string},activation:ReturnType<typeof readHostedInstallationActivation>["activation"]):void {
  const relation=readReferenceRelation(operationId), startPin=pinReferenceFile(referencePath(operationId,"reference-start")),
    entryPin=pinReferenceFile(referencePath(operationId,"reference-entry")),resultPin=pinReferenceFile(referencePath(operationId,"reference-result")),
    releasePin=pinReferenceFile(referencePath(operationId,"reference-release"));
  const start=parseReferenceStart(JSON.parse(startPin.bytes.toString("utf8"))),
    entry=parseReferenceEntry(JSON.parse(entryPin.bytes.toString("utf8")),workspace),
    result=parseReferenceResult(JSON.parse(resultPin.bytes.toString("utf8"))),
    release=parseReferenceRelease(JSON.parse(releasePin.bytes.toString("utf8")),workspace);
  const same=(a:unknown,b:unknown)=>encodeReference(a).equals(encodeReference(b));
  const row=activation.ordinaryStarts.find(value=>value.startId===start.startId);
  if (!row || row.state!==HostedCustodyReservationState.Terminal || start.reservation.state!==HostedCustodyReservationState.Reserved ||
      row.unit!==start.reservation.unit || row.creatorId!==start.reservation.creatorId || row.originSha256!==start.reservation.originSha256 ||
      row.generation!==start.reservation.generation || ![start.operationId,entry.operationId,result.operationId,release.operationId].every(value=>value===operationId) ||
      !same(relation.value.reference.binding.workspace,workspace) || !same(start.relation,relation.reference) ||
      !same(entry.referenceStart,startPin.reference) || !same(entry.relation,relation.reference) ||
      !same(result.referenceEntry,entryPin.reference) || !same(result.referenceStart,startPin.reference) ||
      !same(result.relation,relation.reference) || !same(release.referenceResult,resultPin.reference) ||
      !same(release.attempt,entry.attempt) || release.startId!==start.startId || !same(release.ordinaryStart,start.start)) invalid();
  const ordinary=pinReferenceFile(start.start.path),completion=pinReferenceFile(ordinaryCompletionPath(start.startId),4096),
    fenced=pinReferenceFile(`/var/lib/subscription-runtime-host-policy/dependency-attempt-fences/${start.startId}.json`,4096);
  if (!same(ordinary.reference,start.start) || !same(completion.reference,release.ordinaryCompletion) ||
      !completion.bytes.equals(ordinaryCompletionBytes(start.startId,ordinary.reference.sha256)) ||
      !same(fenced.reference,release.attemptFence) || !fenced.bytes.equals(encodeReference({version:1,startId:start.startId,
        attemptId:entry.attempt.attemptId,epoch:entry.attempt.epoch}))) invalid();
  // Native revalidation belongs to the actual operator publication phase.
  // Consumers rejoin its immutable completion/future-fence chain and the
  // unchanged enforcing recipe; they cannot fabricate an operator role.
  assertHostedActivationFence(fence);
  const kernel=new HostedReadonlyHostKernel();
  kernel.drainOrdinaryQueue(row);kernel.confirmOrdinaryDescendants(row);
}
