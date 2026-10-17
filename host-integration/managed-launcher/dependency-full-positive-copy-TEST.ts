/** Fixed TEST installer copy primitive; no admission, issuer or submit API. */
import { constants, closeSync, fsyncSync, fstatSync, fchmodSync, mkdirSync, openSync, readSync, writeSync, type Stats } from "node:fs";
import { performance } from "node:perf_hooks";
export type FullPositiveCopyRow=Readonly<{sourceFd:number;sourceIdentity:string;name:string;mode:number;children:readonly FullPositiveCopyRow[]|null}>;
function check(value:unknown):asserts value {if(!value)throw new Error("TEST full Positive copy Held");}
function identity(s:Stats){return [s.dev,s.ino,s.uid,s.gid,s.mode,...(s.isDirectory()?[]:[s.nlink,s.size,s.mtimeMs,s.ctimeMs])].map(String).join(":");}
/** The retained-FD boundary is shared by both leaf and directory creation. */
export function restoreFullPositiveInstallationMode(fd:number,mode:number):void {
  check(Number.isInteger(mode) && mode>=0 && mode<=0o777 && !(mode&0o022));
  const before=fstatSync(fd);check(before.isFile() || before.isDirectory());
  // Creation modes are filtered by the caller's umask. Change only the held
  // exclusively created object, never reopen a mutable pathname for chmod.
  fchmodSync(fd,mode);const after=fstatSync(fd);
  check(after.dev===before.dev && after.ino===before.ino && after.uid===before.uid && after.gid===before.gid && after.nlink===before.nlink && (after.mode&0o7777)===mode);
}
export function writeFullPositiveInstallationFile(row:FullPositiveCopyRow,fd:number,deadline:number):void {
  check(row.children===null && identity(fstatSync(row.sourceFd))===row.sourceIdentity);
  restoreFullPositiveInstallationMode(fd,row.mode);
  const buffer=Buffer.alloc(65536);let offset=0,n=0;while((n=readSync(row.sourceFd,buffer,0,buffer.length,offset))>0){let written=0;while(written<n){const amount=writeSync(fd,buffer,written,n-written);check(amount>0);written+=amount;}offset+=n;check(performance.now()<deadline);}fsyncSync(fd);
  check(identity(fstatSync(row.sourceFd))===row.sourceIdentity);
}
export function copyFullPositiveInstallationRow(row:FullPositiveCopyRow,parent:number,deadline:number):void {
  check(/^[A-Za-z0-9_@+.-]+$/.test(row.name) && row.name!=="." && row.name!=="..");
  check(performance.now()<deadline && identity(fstatSync(row.sourceFd))===row.sourceIdentity);const path=`/proc/self/fd/${parent}/${row.name}`;
  if(row.children){mkdirSync(path,{mode:row.mode});const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{restoreFullPositiveInstallationMode(fd,row.mode);for(const child of row.children)copyFullPositiveInstallationRow(child,fd,deadline);fsyncSync(fd);}finally{closeSync(fd);}}
  else{const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,row.mode);try{writeFullPositiveInstallationFile(row,fd,deadline);}finally{closeSync(fd);}}
  check(identity(fstatSync(row.sourceFd))===row.sourceIdentity);fsyncSync(parent);
}
