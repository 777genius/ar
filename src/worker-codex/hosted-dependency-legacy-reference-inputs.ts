import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, opendirSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { assertHostedDependencyPhysicalWorkspace, type HostedDependencyBinding } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import type { HostedDependencyLocalKeyInputs } from "./hosted-dependency-materialization-context";
import { qualifyHostedDependencyLocalInstallerInputs } from "./hosted-dependency-installer-inputs";
import { readHostedDependencyInstallerProfile } from "./hosted-dependency-installer-recipe";
import { HostedDependencyStageEntryKind as Kind, writeHostedDependencyLocalStage } from "./hosted-dependency-installer-local-stage";
import { referenceFailure as fail } from "./hosted-dependency-legacy-reference-records";

const stable = (a: BigIntStats, b: BigIntStats) => a.dev===b.dev && a.ino===b.ino && a.mode===b.mode && a.uid===b.uid && a.gid===b.gid &&
  (!a.isFile() || a.nlink===b.nlink && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs);
/** Input-only finite stage placement. The caller holds both real exclusions.
 * Retained fresh parent, O_EXCL generated entries and exact bounded membership
 * exclude node_modules; the output-stage observer is deliberately not used. */
export function copyHostedLegacyLocalReferenceInputs(binding: HostedDependencyBinding, inputs: HostedDependencyLocalKeyInputs): void {
  assertHostedDependencyPhysicalWorkspace(binding);
  const qualified=qualifyHostedDependencyLocalInstallerInputs(inputs.capture,readHostedDependencyInstallerProfile());
  if (qualified.installKey!==inputs.key.installKey || qualified.sha256!==inputs.capture.closureDigest) fail();
  const started=performance.now();const check=()=>{if (performance.now()-started>10000) fail();};
  const names=(path:string):string[]=>{const result:string[]=[],dir=opendirSync(path,{encoding:"latin1",bufferSize:32});
    try {for (;;) {check();const entry=dir.readSync();if (!entry) break;if (result.length>=16384) fail();
      const raw=Buffer.from(entry.name,"latin1"),name=new TextDecoder("utf-8",{fatal:true}).decode(raw);if (!Buffer.from(name).equals(raw)) fail();result.push(name);}
    } finally {dir.closeSync();}return result;};
  const fd=openSync(binding.workspace.canonicalPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const retained:{fd:number;path:string;before:BigIntStats}[]=[];
  try {
    const before=fstatSync(fd,{bigint:true}),root=`/proc/self/fd/${fd}`;
    if (!before.isDirectory() || before.uid!==0n || (before.mode&0o7777n)!==0o755n || String(before.dev)!==binding.workspace.dev || String(before.ino)!==binding.workspace.ino ||
        JSON.stringify(names(root))!==JSON.stringify([".git"])) fail();
    const git=lstatSync(root+"/.git",{bigint:true});if (git.isSymbolicLink() || !git.isFile() && !git.isDirectory() || git.dev!==before.dev || git.uid!==0n) fail();
    writeHostedDependencyLocalStage(root,qualified.stage,qualified.files);
    const children=new Map<string,string[]>([["",[".git"]]]);
    for (const entry of qualified.stage.entries) if (entry.path) {
      const parent=dirname(entry.path)==="."?"":dirname(entry.path),names=children.get(parent)??[];
      names.push(entry.path.slice(parent?parent.length+1:0));children.set(parent,names);
    }
    const sorted=(names:string[])=>names.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    for (const entry of qualified.stage.entries) {
      check();const path=root+(entry.path?"/"+entry.path:""),stat=lstatSync(path,{bigint:true});
      if (stat.dev!==before.dev || stat.uid!==0n || Number(stat.mode&0o7777n)!==entry.mode || stat.isSymbolicLink()) fail();
      if (entry.kind===Kind.Directory) {
        if (!stat.isDirectory() || JSON.stringify(sorted(names(path)))!==JSON.stringify(sorted(children.get(entry.path)??[]))) fail();
      } else if (!stat.isFile() || stat.nlink!==1n || stat.size!==BigInt(entry.bytes)) fail();
      const child=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(entry.kind===Kind.Directory?constants.O_DIRECTORY:0));
      retained.push({fd:child,path,before:stat});if (!stable(stat,fstatSync(child,{bigint:true}))) fail();
      if (entry.kind===Kind.File) {
        const content=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;
        while (offset<entry.bytes) {check();const count=readSync(child,buffer,0,Math.min(buffer.length,entry.bytes-offset),offset);if (!count) fail();content.update(buffer.subarray(0,count));offset+=count;}
        if (readSync(child,buffer,0,1,offset) || content.digest("hex")!==entry.sha256) fail();
      }
    }
    for (const entry of qualified.stage.entries) if (entry.kind===Kind.Directory &&
        JSON.stringify(sorted(names(root+(entry.path?"/"+entry.path:""))))!==JSON.stringify(sorted(children.get(entry.path)??[]))) fail();
    for (const item of retained) if (!stable(item.before,fstatSync(item.fd,{bigint:true})) || !stable(item.before,lstatSync(item.path,{bigint:true}))) fail();
    if (!stable(git,lstatSync(root+"/.git",{bigint:true})) || !stable(before,fstatSync(fd,{bigint:true})) || !stable(before,lstatSync(binding.workspace.canonicalPath,{bigint:true}))) fail();
    assertHostedDependencyPhysicalWorkspace(binding);
  } finally {
    let failed=false;for (const item of retained.reverse()) try {closeSync(item.fd);} catch {failed=true;}
    try {closeSync(fd);} catch {failed=true;}if (failed) fail();
  }
}
