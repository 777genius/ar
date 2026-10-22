/** Static installed TEST attachment data. Metadata is not a credential or grant. */
export enum HostedConfiguredAuthAttachmentKind { ReadonlyLeafV1 = "configured_readonly_auth_leaf_v1" }
export type HostedAuthFileIdentity = Readonly<{ dev:string; ino:string; mode:string; uid:string; gid:string; nlink:string; size:string; mtimeNs:string; ctimeNs:string }>;
export type HostedAuthAncestor = Readonly<{ path:string; dev:string; ino:string; mode:string; uid:string; gid:string; mountId:string }>;
export type HostedConfiguredAuthAttachment = Readonly<{
  kind:HostedConfiguredAuthAttachmentKind.ReadonlyLeafV1; account:string; source:string; target:string;
  bootId:string; mountNamespace:string; issuerBirth:string; issuerGroup:string;
  sourceMount:string; targetMount:string; file:HostedAuthFileIdentity; underlying:HostedAuthFileIdentity;
  ancestors:readonly HostedAuthAncestor[];
}>;
const atom=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function object(v:unknown,keys:string):Record<string,unknown> {
  if(!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).sort().join(",")!==keys) bad();
  return v as Record<string,unknown>;
}
const decimal=(v:unknown):v is string=>typeof v==="string" && /^(?:0|[1-9][0-9]{0,29})$/.test(v);
function file(v:unknown):HostedAuthFileIdentity {
  const r=object(v,"ctimeNs,dev,gid,ino,mode,mtimeNs,nlink,size,uid");
  if(!Object.values(r).every(decimal) || r.ino==="0" || r.uid!=="0" || r.gid!=="0" || r.nlink!=="1" || r.mode!==String(0o100600)) bad();
  return Object.freeze(r) as HostedAuthFileIdentity;
}
export function parseHostedConfiguredAuthAttachment(value:unknown,job:string,args:readonly string[]):HostedConfiguredAuthAttachment {
  const r=object(value,"account,ancestors,bootId,file,issuerBirth,issuerGroup,kind,mountNamespace,source,sourceMount,target,targetMount,underlying");
  if(r.kind!==HostedConfiguredAuthAttachmentKind.ReadonlyLeafV1 || typeof r.account!=="string" || !atom.test(r.account) ||
    !/^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-os-[a-f0-9-]{36}$/.test(job) ||
    args.filter(x=>x==="--accounts").length!==1 || args[args.indexOf("--accounts")+1]!==r.account ||
    args.filter(x=>x==="--auth-root").length!==1 || args[args.indexOf("--auth-root")+1]!==job+"/auth" ||
    r.source!==`/run/TEST-configured-codex-auth/${r.account}/auth.json` || r.target!==`${job}/auth/${r.account}/auth.json` ||
    typeof r.bootId!=="string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.bootId) ||
    typeof r.mountNamespace!=="string" || !/^mnt:\[[1-9][0-9]{0,19}\]$/.test(r.mountNamespace) ||
    typeof r.issuerBirth!=="string" || !/^[1-9][0-9]{0,9}:[1-9][0-9]{0,19}$/.test(r.issuerBirth) ||
    typeof r.issuerGroup!=="string" || !/^0::\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(r.issuerGroup)) bad();
  for(const k of ["sourceMount","targetMount"] as const) if(typeof r[k]!=="string" || !r[k].length || r[k].length>8192 || /[\n\r\0]/.test(r[k])) bad();
  for(const [key,point] of [["sourceMount",r.source],["targetMount",r.target]] as const) {
    const parts=(r[key] as string).split(" "),at=parts.indexOf("-"),flags=parts[5]?.split(",")??[];
    if(at<6 || parts.length!==at+4 || !/^[1-9][0-9]{0,19}$/.test(parts[0]??"") || !/^[0-9]+$/.test(parts[1]??"") || !/^[0-9]+:[0-9]+$/.test(parts[2]??"") || parts[4]!==point || !flags.includes("ro") ||
      key==="targetMount" && ["nosuid","nodev","noexec"].some(f=>!flags.includes(f))) bad();
  }
  const f=file(r.file), underlying=file(r.underlying);
  if(BigInt(f.size)<1n || BigInt(f.size)>65536n || underlying.size!=="0" || !Array.isArray(r.ancestors) || !r.ancestors.length || r.ancestors.length>64) bad();
  const ancestors=r.ancestors.map(v=>{
    const a=object(v,"dev,gid,ino,mode,mountId,path,uid");
    if(typeof a.path!=="string" || !(a.path==="/" || /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(a.path)) ||
      a.path.split("/").some(p=>p==="." || p==="..") || !Object.entries(a).filter(([k])=>k!=="path").every(([,v])=>decimal(v)) ||
      a.uid!=="0" || a.gid!=="0" || a.ino==="0" || a.mountId==="0" || (BigInt(a.mode as string)&0o170000n)!==0o040000n || (BigInt(a.mode as string)&0o022n)!==0n) bad();
    return Object.freeze(a) as HostedAuthAncestor;
  });
  if(new Set(ancestors.map(a=>a.path)).size!==ancestors.length) bad();
  const expected=new Set<string>();
  for(const leaf of [r.source as string,r.target as string]) { let p=leaf.slice(0,leaf.lastIndexOf("/"));for(;;){expected.add(p);if(p==="/")break;p=p.slice(0,p.lastIndexOf("/"))||"/";} }
  if(expected.size!==ancestors.length || ancestors.some(a=>!expected.has(a.path))) bad();
  return Object.freeze({...r,file:f,underlying,ancestors:Object.freeze(ancestors)}) as HostedConfiguredAuthAttachment;
}
function bad():never {throw new Error("hosted_configured_auth_attachment_invalid");}
