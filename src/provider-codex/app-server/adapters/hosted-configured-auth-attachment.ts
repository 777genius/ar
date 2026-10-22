/** Metadata-only physical fact reader. It never creates installed authority. */
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,readlinkSync,realpathSync,type BigIntStats} from "node:fs";
import {dirname,basename} from "node:path";
import {HostedConfiguredAuthAttachmentKind,parseHostedConfiguredAuthAttachment,type HostedConfiguredAuthAttachment,type HostedAuthFileIdentity,type HostedAuthAncestor} from "../../../core/host-infrastructure/configured-auth-attachment";
const encode=(v:unknown)=>JSON.stringify(v);
function bad():never {throw new Error("hosted_configured_auth_attachment_unresolved");}
function bounded(path:string,max:number):string {const s=readFileSync(path,"utf8");if(Buffer.byteLength(s)>max)bad();return s;}
function birth(pid:string):string {const s=bounded(`/proc/${pid}/stat`,8192), at=s.lastIndexOf(") ");const fields=s.slice(at+2).trim().split(/\s+/);if(at<1 || !/^[1-9][0-9]*$/.test(fields[19]??""))bad();return pid+":"+fields[19];}
function mountId(fd:number):string {const s=bounded(`/proc/self/fdinfo/${fd}`,4096),m=[...s.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)];if(m.length!==1)bad();return m[0]![1]!;}
function file(s:BigIntStats):HostedAuthFileIdentity {
 if(!s.isFile() || s.uid!==0n || s.gid!==0n || s.nlink!==1n || s.mode!==0o100600n || s.size<0n || s.size>65536n)bad();
 return {dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),nlink:String(s.nlink),size:String(s.size),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)};
}
export function configuredAuthUnderlyingIdentity(path:string):HostedAuthFileIdentity { return file(lstatSync(path,{bigint:true})); }
function rows():string[] {
 const s=bounded("/proc/self/mountinfo",1024*1024);const lines=s.trimEnd().split("\n");
 for(const line of lines){const f=line.split(" "),at=f.indexOf("-");if(at<6 || f.length<at+4 || !/^[1-9][0-9]*$/.test(f[0]??"") || !/^[0-9]+$/.test(f[1]??""))bad();}
 return lines;
}
function selectedMount(lines:readonly string[],path:string,strict:boolean):string {
 const a=lines.filter(l=>l.split(" ")[4]===path);if(a.length!==1)bad();const f=a[0]!.split(" "),flags=f[5]!.split(",");
 if(!flags.includes("ro") || strict && ["nosuid","nodev","noexec"].some(x=>!flags.includes(x)))bad();return a[0]!;
}
function observe(source:string,target:string) {
 const held=new Map<string,{fd:number;fact:HostedAuthAncestor}>();
 const openParent=(path:string):number=>{
  const prior=held.get(path);if(prior)return prior.fd;
  const fd=path==="/" ? openSync("/",constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY) :
    openSync(`/proc/self/fd/${openParent(dirname(path))}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_DIRECTORY);
  try{const s=fstatSync(fd,{bigint:true});if(!s.isDirectory() || s.uid!==0n || s.gid!==0n || (s.mode&0o022n)!==0n || realpathSync(`/proc/self/fd/${fd}`)!==path)bad();
   const fact={path,dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),mountId:mountId(fd)};
   held.set(path,{fd,fact});return fd;
  }catch(e){closeSync(fd);throw e;}
 };
 const leaf=(path:string)=>{const fd=openSync(`/proc/self/fd/${openParent(dirname(path))}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const first=file(fstatSync(fd,{bigint:true})),named=file(lstatSync(path,{bigint:true}));if(encode(first)!==encode(named) || realpathSync(`/proc/self/fd/${fd}`)!==path)bad();
   const id=mountId(fd);if(encode(first)!==encode(file(fstatSync(fd,{bigint:true}))) || encode(first)!==encode(file(lstatSync(path,{bigint:true}))))bad();return {file:first,mountId:id};
  }finally{closeSync(fd);}};
 try{
  const before=rows(),sourceMount=selectedMount(before,source,false),targetMount=selectedMount(before,target,true),a=leaf(source),b=leaf(target);
  if(encode(a.file)!==encode(b.file) || a.file.size==="0" || a.mountId!==sourceMount.split(" ")[0] || b.mountId!==targetMount.split(" ")[0])bad();
  for(const {fd,fact} of held.values()){
   const s=fstatSync(fd,{bigint:true}),n=lstatSync(fact.path,{bigint:true});
   const actual={path:fact.path,dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),mountId:mountId(fd)};
   if(encode(actual)!==encode(fact) || s.dev!==n.dev || s.ino!==n.ino || s.mode!==n.mode || s.uid!==n.uid || s.gid!==n.gid || realpathSync(`/proc/self/fd/${fd}`)!==fact.path)bad();
  }
  const after=rows();if(selectedMount(after,source,false)!==sourceMount || selectedMount(after,target,true)!==targetMount)bad();
  return {sourceMount,targetMount,file:a.file,ancestors:[...held.values()].map(x=>x.fact).sort((a,b)=>a.path.localeCompare(b.path))};
 }finally{for(const h of [...held.values()].reverse())closeSync(h.fd);}
}
/** TEST original producer measures DATA; installation's independent review is
 * separately required. No call here can install a profile or admit a runtime. */
export function observeConfiguredAuthAttachmentData(job:string,account:string,underlying:HostedAuthFileIdentity,args:readonly string[]):HostedConfiguredAuthAttachment {
 if(!/^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-os-[a-f0-9-]{36}$/.test(job) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account) ||
  args.filter(x=>x==="--accounts").length!==1 || args[args.indexOf("--accounts")+1]!==account || args.filter(x=>x==="--auth-root").length!==1 || args[args.indexOf("--auth-root")+1]!==job+"/auth")bad();
 const source=`/run/TEST-configured-codex-auth/${account}/auth.json`,target=`${job}/auth/${account}/auth.json`;
 const actual=observe(source,target);
 return parseHostedConfiguredAuthAttachment({kind:HostedConfiguredAuthAttachmentKind.ReadonlyLeafV1,account,source,target,
  bootId:bounded("/proc/sys/kernel/random/boot_id",128).trim(),mountNamespace:readlinkSync("/proc/self/ns/mnt"),
  issuerBirth:birth(String(process.pid)),issuerGroup:bounded("/proc/self/cgroup",4096).trim(),underlying,...actual},job,args);
}
/** Factual preinstall verifier only; installed callers independently resolve
 * the authenticated original inventory before selecting this exact profile. */
export function assertConfiguredAuthAttachmentPhysical(profile:HostedConfiguredAuthAttachment):void {
 const pid=profile.issuerBirth.split(":")[0]!;
 const owner=()=>{if(bounded("/proc/sys/kernel/random/boot_id",128).trim()!==profile.bootId ||
  readlinkSync("/proc/self/ns/mnt")!==profile.mountNamespace || readlinkSync(`/proc/${pid}/ns/mnt`)!==profile.mountNamespace ||
  birth(pid)!==profile.issuerBirth || bounded(`/proc/${pid}/cgroup`,4096).trim()!==profile.issuerGroup)bad();};
 owner();const actual=observe(profile.source,profile.target);
 if(actual.sourceMount!==profile.sourceMount || actual.targetMount!==profile.targetMount || encode(actual.file)!==encode(profile.file) || encode(actual.ancestors)!==encode(profile.ancestors))bad();owner();
}
