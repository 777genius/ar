import { constants, closeSync, copyFileSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { retainedResourceDigest } from "../../src/core/scoped-retained-resource-contract.js";
import type { InstallationFile } from "./root-origin-operator.mjs";
const target = "/opt/subscription-runtime/native-probe", candidate = join(target,"root-candidate");
interface CandidateManifest { readonly version: 1; readonly profile: "NativeOriginalA0"; readonly daemonUid: number; readonly daemonGid: number; readonly files: readonly InstallationFile[] }
function protectedAncestors(path: string): void {
  for(let p=dirname(path);;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw new Error("unprotected candidate ancestor");if(p==="/")break;}
}
export function readMeasuredLeaf(path: string, expected: InstallationFile): Buffer {
  protectedAncestors(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=fstatSync(fd,{bigint:true});const bytes=readFileSync(fd),after=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
    if(!before.isFile()||before.uid!==0n||before.gid!==0n||before.nlink!==1n||before.dev!==named.dev||before.ino!==named.ino||before.size!==after.size||before.mode!==after.mode||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||Number(before.size)!==expected.bytes||Number(before.mode&0o7777n)!==expected.mode||(before.mode&0o022n)||createHash("sha256").update(bytes).digest("hex")!==expected.sha256)throw new Error("changed reviewed candidate leaf");
    return bytes;
  } finally {closeSync(fd);}
}
export function installOriginalCandidate(): void {
  if(process.argv.length!==2||process.getuid?.()!==0||process.getgid?.()!==0)throw new Error("fixed Root-only candidate installation required");
  protectedAncestors(join(candidate,"manifest.json"));
  const raw=readFileSync(join(candidate,"manifest.json"));
  if(raw.length>65536)throw new Error("candidate manifest capacity");
  const m=JSON.parse(raw.toString("utf8")) as CandidateManifest;
  if(m.version!==1||m.profile!=="NativeOriginalA0"||!Array.isArray(m.files)||m.files.length<6||m.files.length>128)throw new Error("invalid candidate manifest");
  const seen=new Set<string>(),admitted:Array<{file:InstallationFile;source:string;bytes:Buffer}>=[];
  for(const file of m.files){
    if(typeof file.path!=="string"||resolve(file.path)!==file.path||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<=0||!Number.isSafeInteger(file.mode)||(file.mode&0o022)||!/^[0-9a-f]{64}$/.test(file.sha256))throw new Error("invalid candidate entry");seen.add(file.path);
    const own=file.path.startsWith(target+"/");
    if(!own&&file.path!=="/usr/bin/dbus-daemon"&&!file.path.startsWith("/usr/lib/")&&file.path!=="/usr/bin/node"&&file.path!=="/opt/subscription-runtime/runtime/node")throw new Error("unsupported shared runtime input");
    const source=own?join(candidate,file.path.slice(target.length+1)):file.path;
    const bytes=readMeasuredLeaf(source,file);admitted.push({file,source,bytes});
    if(own){let exists=true;try{lstatSync(file.path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;exists=false;}if(exists)readMeasuredLeaf(file.path,file);}
  }
  // All admission checks precede the first installed write. Shared host
  // libraries/daemon are measured, never copied, restarted or replaced.
  for(const {file,source} of admitted){if(!file.path.startsWith(target+"/"))continue;
    mkdirSync(dirname(file.path),{recursive:true,mode:0o755});protectedAncestors(file.path);
    try{copyFileSync(source,file.path,constants.COPYFILE_EXCL);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    // copyFile preserves ordinary mode; reject unexpected metadata before reuse.
    readMeasuredLeaf(file.path,file);const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);fsyncSync(fd);closeSync(fd);
  }
  for(const name of ["proc","tmp"])mkdirSync(join(target,"test-root",name),{mode:0o755});
  const manifestPath=join(target,"root-installation.json");
  writeFileSync(manifestPath,JSON.stringify(m)+"\n",{flag:"wx",mode:0o644});const manifestFd=openSync(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW);fsyncSync(manifestFd);closeSync(manifestFd);
  const parent=openSync(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(parent);closeSync(parent);
  // Installation is not Origin issuance. Admin creates a fresh finite permit
  // and private NEWTEST operation directory only after reviewing these hashes.
  process.stdout.write(JSON.stringify({installationDigest:retainedResourceDigest(m),files:m.files.length,authorityIssued:false})+"\n");
}
export function installRetainedV2Candidate(): void {
  installRetainedCandidate(false);
}
export function installRetainedV2ActorCandidate(): void {
  installRetainedCandidate(true);
}
function installRetainedCandidate(actors: boolean): void {
  const target=actors?"/opt/subscription-runtime/native-retained-v2-b1a":"/opt/subscription-runtime/native-retained-v2",candidate=join(target,"source-candidate");
  const profile=actors?"NativeRetainedV2B1a":"NativeRetainedV2A1";
  if(process.argv.length!==3||process.argv[2]!==(actors?"--retained-v2-b1a":"--retained-v2-a1")||process.getuid?.()!==0||process.getgid?.()!==0)throw new Error("fixed Root-only candidate installation required");
  protectedAncestors(join(candidate,"manifest.json"));
  const raw=readFileSync(join(candidate,"manifest.json"));
  if(raw.length>65536)throw new Error("candidate manifest capacity");
  const m=JSON.parse(raw.toString("utf8")) as Omit<CandidateManifest,"profile"> & {readonly profile:"NativeRetainedV2A1"|"NativeRetainedV2B1a"};
  if(Object.keys(m).sort().join(",")!=="daemonGid,daemonUid,files,profile,version"||![m.daemonUid,m.daemonGid].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff)||m.version!==1||m.profile!==profile||!Array.isArray(m.files)||m.files.length<7||m.files.length>128)throw new Error("invalid candidate manifest");
  const required=[join(target,actors?"retained-v2-actor-entry":"retained-v2-entry"),join(target,"test-root/opt/native/node"),join(target,"test-root/opt/native/original-owner-helper.mjs"),join(target,"test-root/opt/native/original-owner-associated.node"),"/usr/bin/dbus-daemon",join(target,"admin/host-integration/native-probe",actors?"retained-v2-actor-operator.mjs":"retained-v2-operator.mjs"),join(target,"expected-helper-policy.json")];
  if(required.some((path,index)=>m.files[index]?.path!==path))throw new Error("missing fixed retained V2 cohort");
  const seen=new Set<string>(),admitted:Array<{file:InstallationFile;source:string;bytes:Buffer}>=[];
  for(const file of m.files){
    if(Object.keys(file).sort().join(",")!=="bytes,mode,path,sha256"||typeof file.path!=="string"||resolve(file.path)!==file.path||seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<=0||!Number.isSafeInteger(file.mode)||(file.mode&0o022)||!/^[0-9a-f]{64}$/.test(file.sha256))throw new Error("invalid candidate entry");seen.add(file.path);
    const own=file.path.startsWith(target+"/");
    if(!own&&file.path!=="/usr/bin/dbus-daemon"&&!file.path.startsWith("/usr/lib/")&&file.path!=="/usr/bin/node"&&file.path!=="/opt/subscription-runtime/runtime/node")throw new Error("unsupported shared runtime input");
    const source=own?join(candidate,file.path.slice(target.length+1)):file.path;
    const bytes=readMeasuredLeaf(source,file);
    if(file.path===required[6]&&!bytes.equals(Buffer.from('{"kind":"NativeRetainedV2ExpectedLeafV1","postExec":"np_helper_filter_v1","preExec":"np_helper_preexec_filter_v1","source":false,"work":false}\n')))throw new Error("unsupported expected leaf policy");
    admitted.push({file,source,bytes});
    if(own){let exists=true;try{lstatSync(file.path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;exists=false;}if(exists)readMeasuredLeaf(file.path,file);}
  }
  // All admission checks precede the first installed write. Shared host
  // libraries/daemon are measured, never copied, restarted or replaced.
  for(const {file,source} of admitted){if(!file.path.startsWith(target+"/"))continue;
    mkdirSync(dirname(file.path),{recursive:true,mode:0o755});protectedAncestors(file.path);
    try{copyFileSync(source,file.path,constants.COPYFILE_EXCL);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    // copyFile preserves ordinary mode; reject unexpected metadata before reuse.
    readMeasuredLeaf(file.path,file);const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);fsyncSync(fd);closeSync(fd);
    for(let path=dirname(file.path);;path=dirname(path)){const parent=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}if(path==="/")break;}
  }
  for(const name of ["proc","tmp"])mkdirSync(join(target,"test-root",name),{mode:0o755});
  const manifestPath=join(target,"root-installation.json");
  writeFileSync(manifestPath,JSON.stringify(m)+"\n",{flag:"wx",mode:0o644});const manifestFd=openSync(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW);fsyncSync(manifestFd);closeSync(manifestFd);
  for(let path=target;;path=dirname(path)){const parent=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(parent);}finally{closeSync(parent);}if(path==="/")break;}
  // Installation is not Origin issuance. Admin creates a fresh finite permit
  // and private NEWTEST operation directory only after reviewing these hashes.
  process.stdout.write(JSON.stringify({installationDigest:retainedResourceDigest(m),files:m.files.length,authorityIssued:false})+"\n");
}
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url))try{if(process.argv[2]==="--retained-v2-a1")installRetainedV2Candidate();else if(process.argv[2]==="--retained-v2-b1a")installRetainedV2ActorCandidate();else installOriginalCandidate();}catch(error){process.stderr.write(String(error)+"\n");process.exitCode=77;}
