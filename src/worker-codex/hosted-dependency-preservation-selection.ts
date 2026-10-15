import { isDependencyCustodyObject, isDependencyProtectedReference, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import { readdirSync } from "node:fs";
import { DependencyOwnerKind, DependencyOwnerPhase, DependencyReceiptParseStatus, DependencyReceiptState,
  parseDependencyOwner, parseDependencyReceipt,
  sameDependencyProtectedReference, type DependencyOwnerRecord, type DependencyReceipt,
  type DependencyTrashIntent } from "@vioxen/subscription-runtime/worker-core";
import { parseHostedDependencyBinding, type HostedDependencyBinding } from "./hosted-dependency-workspace";
import { pinReferenceFile, encodeReference as encode } from "./hosted-dependency-legacy-reference-records";
import { hostedDependencyPreservationRoot, hostedDependencyQuarantineRoot } from "./hosted-dependency-preservation";

export enum HostedDependencyPreservationLineageKind {
  Active = "active", OrdinaryUnverified = "ordinary_unverified", ReadonlyUnverified = "readonly_unverified",
}
export enum HostedDependencyPreservationRequestKind { ExplicitReinstallation = "explicit_reinstallation" }
type Pin = DependencyProtectedReference;
type PriorReceipt = Extract<DependencyReceipt, { state: DependencyReceiptState.Ready | DependencyReceiptState.Unverified }>;
export type HostedDependencyPreservationLineage =
  | Readonly<{ kind: HostedDependencyPreservationLineageKind.Active; idle: Pin; sourceClosed: Pin }>
  | Readonly<{ kind: HostedDependencyPreservationLineageKind.OrdinaryUnverified; start: Pin; final: Pin }>
  | Readonly<{ kind: HostedDependencyPreservationLineageKind.ReadonlyUnverified; release: Pin; fda: Pin }>;
/** Immutable request facts, never a permission. The defining original issuer
 * authenticates native lineage and current owner around every transition. */
export type HostedDependencyPreservationSelection = Readonly<{
  version: 1; kind: HostedDependencyPreservationRequestKind.ExplicitReinstallation; operationId: string;
  binding: HostedDependencyBinding; prior: { owner: DependencyOwnerRecord; receipt: { receipt: PriorReceipt; reference: Pin } };
  claimedOwner: DependencyOwnerRecord; sourceTree: DependencyTrashIntent["originalTree"]; destinationParent: DependencyTrashIntent["destinationParent"];
  lineage: HostedDependencyPreservationLineage;
}>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function held(): never { throw new Error("hosted_dependency_preservation_selection_held"); }
function equal(a: unknown,b: unknown) { return encode(a).equals(encode(b)); }
export function hostedDependencyPreservationSelectionPath(operationId: string): string {
  if (!uuid.test(operationId)) held(); return `${hostedDependencyPreservationRoot}/${operationId}.selection.json`;
}
export function hostedDependencyPreservationSelectionIndexPath(binding: HostedDependencyBinding, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1) held();
  return `${hostedDependencyPreservationRoot}/${binding.workspace.dev}-${binding.workspace.ino}-${revision}.selection-index.json`;
}
export function readHostedDependencyPreservationSelection(binding: HostedDependencyBinding, operationId: string) {
  const pin = pinReferenceFile(hostedDependencyPreservationSelectionPath(operationId), 65536), v: unknown = JSON.parse(pin.bytes.toString("utf8"));
  if (!isDependencyCustodyObject(v,"binding,claimedOwner,destinationParent,kind,lineage,operationId,prior,sourceTree,version") ||
      v.version !== 1 || v.kind !== HostedDependencyPreservationRequestKind.ExplicitReinstallation || v.operationId !== operationId ||
      binding.version !== 2 || !equal(parseHostedDependencyBinding(v.binding),binding) || !pin.bytes.equals(encode(v)) ||
      !isDependencyCustodyObject(v.prior,"owner,receipt") || !isDependencyCustodyObject(v.prior.receipt,"receipt,reference") ||
      !isDependencyProtectedReference(v.prior.receipt.reference)) held();
  const previous = parseDependencyOwner(v.prior.owner), claimed = parseDependencyOwner(v.claimedOwner), parsed = parseDependencyReceipt(v.prior.receipt.receipt);
  if (previous.version === 1 || previous.owner || claimed.version !== previous.version ||
      !equal(previous.workspace,binding.workspace) || parsed.status !== DependencyReceiptParseStatus.Valid ||
      (parsed.receipt.state !== DependencyReceiptState.Ready && parsed.receipt.state !== DependencyReceiptState.Unverified) ||
      !equal(parsed.receipt.workspace,binding.workspace) || claimed.owner?.kind !== DependencyOwnerKind.Maintenance ||
      claimed.owner.phase !== DependencyOwnerPhase.ExclusiveMutation || claimed.owner.attempt.operationId !== operationId ||
      !equal(claimed,parseDependencyOwner({...previous,revision:previous.revision+1,epoch:previous.epoch+1,owner:claimed.owner})) ||
      claimed.owner.attempt.host.installationId !== binding.installationId || claimed.owner.attempt.host.runtimeSha !== binding.runtimeSha ||
      claimed.owner.attempt.host.grantDigest !== binding.grantDigest ||
      !isDependencyCustodyObject(v.sourceTree,"dev,ino") || v.sourceTree.dev !== binding.workspace.dev ||
      typeof v.sourceTree.ino !== "string" || !/^[1-9][0-9]{0,39}$/.test(v.sourceTree.ino) ||
      !isDependencyCustodyObject(v.destinationParent,"canonicalPath,dev,ino") || v.destinationParent.canonicalPath !== hostedDependencyQuarantineRoot ||
      v.destinationParent.dev !== binding.workspace.dev || typeof v.destinationParent.ino !== "string" || !/^[1-9][0-9]{0,39}$/.test(v.destinationParent.ino)) held();
  const l = v.lineage;
  if (!(isDependencyCustodyObject(l,"idle,kind,sourceClosed") && l.kind === HostedDependencyPreservationLineageKind.Active &&
        isDependencyProtectedReference(l.idle) && isDependencyProtectedReference(l.sourceClosed) ||
      isDependencyCustodyObject(l,"final,kind,start") && l.kind === HostedDependencyPreservationLineageKind.OrdinaryUnverified &&
        isDependencyProtectedReference(l.final) && isDependencyProtectedReference(l.start) ||
      isDependencyCustodyObject(l,"fda,kind,release") && l.kind === HostedDependencyPreservationLineageKind.ReadonlyUnverified &&
        isDependencyProtectedReference(l.fda) && isDependencyProtectedReference(l.release))) held();
  return { header: v as unknown as HostedDependencyPreservationSelection, reference: pin.reference };
}
/** Index activation precedes claim CAS. Even an old ordinary Ready receipt is
 * blocked by this immutable pending selection. Missing selected bytes are held;
 * an unindexed selection is merely unactivated request facts. */
export function readHostedDependencyPreservationSelections(binding: HostedDependencyBinding) {
  let names: string[];
  try { names = readdirSync(hostedDependencyPreservationRoot); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const prefix = `${binding.workspace.dev}-${binding.workspace.ino}-`, suffix = ".selection-index.json";
  const selected = names.filter(n => n.startsWith(prefix) && n.endsWith(suffix));
  if (selected.length > 2048) held();
  return selected.map(name => {
    const revision = Number(name.slice(prefix.length,-suffix.length));
    if (name !== `${prefix}${revision}${suffix}` || !Number.isSafeInteger(revision) || revision < 1) held();
    const index = pinReferenceFile(hostedDependencyPreservationSelectionIndexPath(binding,revision),4096), v: unknown = JSON.parse(index.bytes.toString("utf8"));
    if (!isDependencyCustodyObject(v,"selection,version") || v.version !== 1 || !isDependencyProtectedReference(v.selection) || !index.bytes.equals(encode(v))) held();
    const match = /\/([a-f0-9-]{36})\.selection\.json$/.exec(v.selection.path); if (!match) held();
    const selection = readHostedDependencyPreservationSelection(binding,match[1]!);
    if (!sameDependencyProtectedReference(selection.reference,v.selection) || selection.header.prior.receipt.receipt.revision !== revision) held();
    return {...selection,index:index.reference};
  });
}
/** Whole-census factual discovery starts with activated indexes. Unindexed
 * request files, including a crashed partial request, confer no allowance. */
export function readHostedDependencyActivatedPreservationSelections() {
  let names:string[];try{names=readdirSync(hostedDependencyPreservationRoot);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
  if(names.length>8192)held();const result=new Map<string,ReturnType<typeof readHostedDependencyPreservationSelections>[number]>();
  for(const name of names.filter(n=>n.endsWith(".selection-index.json"))) {
    if(!/^(0|[1-9][0-9]{0,39})-[1-9][0-9]{0,39}-[1-9][0-9]*\.selection-index\.json$/.test(name))held();
    const index=pinReferenceFile(`${hostedDependencyPreservationRoot}/${name}`,4096),v:unknown=JSON.parse(index.bytes.toString("utf8"));
    if(!isDependencyCustodyObject(v,"selection,version") || v.version!==1 || !isDependencyProtectedReference(v.selection) || !index.bytes.equals(encode(v)))held();
    const match=new RegExp("^"+hostedDependencyPreservationRoot+"/([a-f0-9-]{36})\\.selection\\.json$").exec(v.selection.path);if(!match)held();
    const selected=pinReferenceFile(hostedDependencyPreservationSelectionPath(match[1]!),65536),row:unknown=JSON.parse(selected.bytes.toString("utf8"));
    if(!row || typeof row!=="object" || !("binding" in row))held();const binding=parseHostedDependencyBinding(row.binding);
    const actual=readHostedDependencyPreservationSelections(binding).find(v=>v.header.operationId===match[1]);
    if(!actual || !sameDependencyProtectedReference(actual.index,index.reference) || !sameDependencyProtectedReference(actual.reference,v.selection))held();
    result.set(actual.header.operationId,actual);
  }
  return [...result.values()];
}
