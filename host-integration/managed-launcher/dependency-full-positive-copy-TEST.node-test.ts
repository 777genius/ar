/** Genuine temporary filesystem FDs; no host/native context or runtime outcome. */
import assert from "node:assert/strict";
import test from "node:test";
import { constants,closeSync,fchmodSync,fstatSync,mkdtempSync,mkdirSync,openSync,readFileSync,rmSync,writeFileSync,type Stats } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {performance} from "node:perf_hooks";
import {restoreFullPositiveInstallationMode,writeFullPositiveInstallationFile} from "./dependency-full-positive-copy-TEST.js";
function identity(s:Stats){return [s.dev,s.ino,s.uid,s.gid,s.mode,...(s.isDirectory()?[]:[s.nlink,s.size,s.mtimeMs,s.ctimeMs])].map(String).join(":");}
test("real retained file copy preserves authenticated executable mode under umask077",()=>{
  const root=mkdtempSync(join(tmpdir(),"sr-positive-mode-file-")),old=process.umask(0o077);let source=-1,destination=-1;
  try{const src=join(root,"source"),dst=join(root,"copied");writeFileSync(src,"actual bounded source bytes\n",{mode:0o700});source=openSync(src,constants.O_RDONLY|constants.O_NOFOLLOW);fchmodSync(source,0o755);const stat=fstatSync(source);destination=openSync(dst,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o755);
    assert.equal(fstatSync(destination).mode&0o777,0o700);
    writeFullPositiveInstallationFile({sourceFd:source,sourceIdentity:identity(stat),name:"copied",mode:0o755,children:null},destination,performance.now()+1000);
    assert.equal(fstatSync(destination).mode&0o777,0o755);assert.equal(readFileSync(dst,"utf8"),"actual bounded source bytes\n");
  }finally{if(source>=0)closeSync(source);if(destination>=0)closeSync(destination);process.umask(old);rmSync(root,{recursive:true,force:true});}
});
test("real retained created directory restores authenticated mode under umask077",()=>{
  const root=mkdtempSync(join(tmpdir(),"sr-positive-mode-directory-")),old=process.umask(0o077);let fd=-1;
  try{const path=join(root,"directory");mkdirSync(path,{mode:0o755});fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const before=fstatSync(fd);assert.equal(before.mode&0o777,0o700);restoreFullPositiveInstallationMode(fd,0o755);const after=fstatSync(fd);assert.equal(after.dev,before.dev);assert.equal(after.ino,before.ino);assert.equal(after.mode&0o777,0o755);
  }finally{if(fd>=0)closeSync(fd);process.umask(old);rmSync(root,{recursive:true,force:true});}
});
