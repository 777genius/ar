/** Fixed41 selected-image DATA entry. Never a native permission constructor. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { preflightFixedH1ArchiveRole, serializeFixedH1ArchiveRole, type FixedH1ArchiveRoleData } from "./current-h1-archive-path-graph-TEST.ts";
import { FixedGnuMemberKind as Kind } from "./current-h1-archive-members-TEST.ts";
import { writeOwnedSelectedToolrootData, readSelectedPhysicalHoldFacts, SelectedPhysicalHeld, SelectedPhysicalHold, SelectedPhysicalPhase, SelectedOutputOrigin, SelectedTransformation, selectedRecipeSha256, type SelectedFilesystemInput, type SelectedOutputRow, type SelectedRetainedStreamData } from "./current-h1-selected-toolroot-filesystem-TEST.ts";

export interface FixedSelectedToolrootInput {
 readonly sourceSha:string;readonly scratch:string;readonly evidence:string;readonly deadline:number;
 readonly originals:readonly SelectedRetainedStreamData[];readonly graph:FixedH1ArchiveRoleData;
 readonly graphBytes:Buffer;readonly selectionBytes:Buffer;
}
const hash=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const vector="76a701735a773c8a1909ea320a711c7b9f521796c383191c985ac67854024187";
const literal=(b64:string)=>Buffer.from(b64,"base64").toString("ascii");
function assertPlainGraph(value:unknown):void {
 const seen=new Set<object>();let work=0;
 const visit=(v:unknown,depth=0):void=>{
  assert(++work<=2000000&&depth<=128);
  if(v===null||typeof v!=="object"){assert(v===null||typeof v==="string"||typeof v==="boolean"||(typeof v==="number"&&Number.isSafeInteger(v)&&v>=0));return;}
  assert(!types.isProxy(v)&&!seen.has(v));seen.add(v);const d=Object.getOwnPropertyDescriptors(v);
  if(Array.isArray(v)){assert(Object.getPrototypeOf(v)===Array.prototype&&v.length<=20000&&Reflect.ownKeys(d).length===v.length+1);for(let i=0;i<v.length;i++){const p=d[String(i)];assert(p&&"value" in p&&p.enumerable);visit(p.value,depth+1);}}
  else {assert(Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(d).every(k=>typeof k==="string"&&k!=="toJSON"));for(const p of Object.values(d)){assert("value" in p&&p.enumerable);visit(p.value,depth+1);}}
  seen.delete(v);
 };visit(value);
}
/** Genuine existing CI supplies signed origins and original retained handles.
 * These typed values and the resulting records alone grant no authority. */
export async function materializeFixedH1SelectedToolrootData(input:FixedSelectedToolrootInput):ReturnType<typeof writeOwnedSelectedToolrootData> {
 let phase=SelectedPhysicalPhase.Input;
 try {
 assert(input!==null&&!types.isProxy(input)&&Object.getPrototypeOf(input)===Object.prototype&&Reflect.ownKeys(input).every(k=>typeof k==="string"&&k!=="toJSON")&&Object.values(Object.getOwnPropertyDescriptors(input)).every(d=>"value" in d&&d.enumerable));
 const deadline=Math.min(input.deadline,performance.now()+30000);
 const tick=()=>{if(!Number.isFinite(deadline)||performance.now()>=deadline)throw new SelectedPhysicalHeld(SelectedPhysicalHold.Deadline,false,phase,0);};
 tick();assert(/^[a-f0-9]{40}$/.test(input.sourceSha));
 assert(Array.isArray(input.originals)&&!types.isProxy(input.originals)&&Object.getPrototypeOf(input.originals)===Array.prototype);
 assert.equal(input.originals.length,41,"exact original archive count");
 assert(Reflect.ownKeys(input.originals).length===42&&Object.values(Object.getOwnPropertyDescriptors(input.originals)).every(d=>"value" in d));
 const archives=Object.freeze(input.originals.map(o=>{assert(o!==null&&!types.isProxy(o)&&Object.getPrototypeOf(o)===Object.prototype&&Reflect.ownKeys(o).every(k=>typeof k==="string")&&Object.values(Object.getOwnPropertyDescriptors(o)).every(d=>"value" in d&&d.enumerable));return o.members;}));
 let streamBytes=0;
 phase=SelectedPhysicalPhase.Originals;for(const original of input.originals){
  assertPlainGraph(original.members);assert(Buffer.isBuffer(original.bytes)&&!types.isProxy(original.bytes));
  assert(original.archive!==null&&!types.isProxy(original.archive)&&Object.getPrototypeOf(original.archive)===Object.prototype&&Object.values(Object.getOwnPropertyDescriptors(original.archive)).every(d=>"value" in d&&d.enumerable));
  tick();original.archive.rejoin();
  assert.equal(original.archive.sha256,original.members.package.sha256);
  assert.equal(original.archive.size,original.members.package.size);
  assert.equal(original.bytes.length,original.members.stream.bytes);
  streamBytes+=original.bytes.length;assert(streamBytes<=512*1024*1024);
  assert.equal(hash(original.bytes),original.members.stream.sha256);tick();original.archive.rejoin();
 }
 phase=SelectedPhysicalPhase.Graph;const graph=preflightFixedH1ArchiveRole(archives,vector,deadline);
 assertPlainGraph(input.graph);tick();
 assert.equal(JSON.stringify(input.graph),JSON.stringify(graph),"recomputed complete fixed graph");
 const serialized=serializeFixedH1ArchiveRole(graph,archives,input.sourceSha,deadline);
 assert(Buffer.isBuffer(input.graphBytes)&&!types.isProxy(input.graphBytes)&&Buffer.isBuffer(input.selectionBytes)&&!types.isProxy(input.selectionBytes));
 assert(serialized.graph.equals(input.graphBytes)&&serialized.selection.equals(input.selectionBytes),"original complete graph/selection bytes");
 assert.equal(archives.reduce((n,a)=>n+a.rows.length,0),2506);
 phase=SelectedPhysicalPhase.Recipe;const selectedSet=new Set(graph.selected),nodes=graph.nodes.filter(n=>selectedSet.has(n.path));
 assert.equal(nodes.length,1054);
 for(const [kind,count] of [[Kind.Directory,64],[Kind.Regular,951],[Kind.Symlink,39]] as const)assert.equal(nodes.filter(n=>n.kind===kind).length,count);
 assert(!selectedSet.has("usr/bin/su")&&!selectedSet.has("usr/share/zoneinfo/localtime")&&!graph.nodes.some(n=>n.path==="lib64"));
 const sourceRows:SelectedOutputRow[]=nodes.map(node=>{
  const origin=node.origins[0];assert(origin);
  const rewrite=node.path==="usr/lib/python3.12/sitecustomize.py";
  return Object.freeze({path:node.path,kind:node.kind,origin:SelectedOutputOrigin.Archive,
   transformation:rewrite?SelectedTransformation.SitecustomizeRelative:SelectedTransformation.Identity,
   origins:node.origins,mode:origin.row.mode,mtime:node.kind===Kind.Directory?0:origin.row.mtime,
   outputLiteral:node.kind===Kind.Symlink?rewrite?"../../../etc/python3.12/sitecustomize.py":literal(origin.row.linkBytesBase64):""});
 });
 sourceRows.push(Object.freeze({path:"lib64",kind:Kind.Symlink,origin:SelectedOutputOrigin.Recipe,
  transformation:SelectedTransformation.LoaderNamespace,origins:Object.freeze([]),mode:0o777,mtime:0,outputLiteral:"usr/lib64"}));
 const rows=Object.freeze(sourceRows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0));
 const provenance=Object.freeze({sourceSha:input.sourceSha,packageVectorSha256:vector,recipeSha256:selectedRecipeSha256,
  graph:{bytes:serialized.graph.length,sha256:serialized.graphSha256,nodes:graph.nodes.length},
  selection:{bytes:serialized.selection.length,sha256:hash(serialized.selection),selected:1054},
  memberRecords:serialized.memberRecords,archives:graph.archives,unselected:graph.unselected,
  heldObjects:graph.aliases.filter(a=>!selectedSet.has(a.path)),rootSentinels:graph.roots});
 tick();for(const original of input.originals)original.archive.rejoin();
 const physicalInput:SelectedFilesystemInput={sourceSha:input.sourceSha,scratch:input.scratch,evidence:input.evidence,
  deadline,originals:input.originals,rows,provenance};
 return await writeOwnedSelectedToolrootData(physicalInput);
 }catch(error){
  if(readSelectedPhysicalHoldFacts(error))throw error;
  throw new SelectedPhysicalHeld(SelectedPhysicalHold.Unknown,false,phase,0);
 }
}
