import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FullBackingExposure, fullBackingDescriptor, fullBackingMounts, retainFullProcProcess } from "./current-full-backing-collector.js";

import { MountRootKind, fullReadonlyMountData, readFullMountTable } from "../../host-integration/managed-launcher/dependency-full-native-TEST.js";

// The owned child is the same compiled TS fixture and exits through its private
// IPC channel. No numeric-PID signal or external process is used for cleanup.
if(process.argv[2]==="--TEST-full-proc-anchor-child") {
  assert(process.send);
  process.once("message",message=>{if(message==="TEST-proc-anchor-exit")process.exit(0);});
  process.once("disconnect",()=>process.exit(0));
  process.send("TEST-proc-anchor-ready");
} else {
  // A host containing persistent namespace mounts must not fail before the
  // selected path's descriptor join. Magic roots must never become path roots.
  const rootRow="1 1 8:1 / / ro - ext4 /dev/root ro\n";
  const namespaceRow=(root:string,filesystem="nsfs")=>`2 1 0:4 ${root} /run/netns/TEST ro - ${filesystem} nsfs ro\n`;
  test("persistent namespace roots coexist with readonly descriptor joins",()=>{
    for(const name of ["cgroup","ipc","mnt","net","pid","time","user","uts"]){
      const raw=rootRow+namespaceRow(name+":"+"[18446744073709551615]");
      const mount=fullBackingMounts(raw)[1]!;
      assert.deepEqual(mount.root,{kind:MountRootKind.Namespace,name,inode:"18446744073709551615"});
      assert.equal(mount.point,"/run/netns/TEST");
      assert.doesNotThrow(()=>fullReadonlyMountData(raw,"/TEST-input","1","8:1"));
    }
    assert.deepEqual(fullBackingMounts(rootRow)[0]!.root,{kind:MountRootKind.Path,path:"/"});
    for(const value of ["unknown:[1]","pid_for_children:[1]","time_for_children:[1]","net:[0]","net:[01]","net:[-1]","net:[18446744073709551616]","net:[1]suffix","net:\\134[1]"]){
      for(const parse of [fullBackingMounts,(raw:string)=>fullReadonlyMountData(raw,"/TEST-input","1","8:1")])assert.throws(()=>parse(rootRow+namespaceRow(value)));
    }
    for(const raw of [rootRow+namespaceRow("net:[1]","ext4"),rootRow+namespaceRow("net:[1]").replace("/run/netns/TEST","net:[2]"),rootRow+namespaceRow("/bad\\777")]){
      assert.throws(()=>fullBackingMounts(raw));assert.throws(()=>fullReadonlyMountData(raw,"/TEST-input","1","8:1"));
    }
  });
  test("complete mount tables accept large host views and refuse truncation and every bound",()=>{
    const rows=Array.from({length:32768},(_,i)=>`${i+1} 1 8:1 / /TEST-${i} ro - ext4 /dev/root ro\n`).join("");
    assert.equal(fullBackingMounts(rows).length,32768);
    assert.throws(()=>fullBackingMounts(rows+"32769 1 8:1 / /extra ro - ext4 /dev/root ro\n"));
    assert.throws(()=>fullBackingMounts(rows.slice(0,-1)));
    assert.throws(()=>fullBackingMounts(rootRow+"\n"));
    const large=Array.from({length:15144},(_,i)=>`${i+1} 1 8:1 / /TEST-${i} ro - ext4 /dev/root ro,${"x".repeat(310)}\n`).join("");
    assert(Buffer.byteLength(large)>5*1024*1024);assert.equal(fullBackingMounts(large).length,15144);
    assert.doesNotThrow(()=>fullReadonlyMountData(large.replace("/TEST-0","/"),"/TEST-input","1","8:1"));
    const prefix="2 1 8:1 / /TEST ro - ext4 /dev/root ro,",line=prefix+"x".repeat(65536-Buffer.byteLength(prefix));
    assert.equal(fullBackingMounts(rootRow+line+"\n").length,2);
    assert.throws(()=>fullBackingMounts(rootRow+line+"x\n"));
    const exactRows=Array.from({length:128},(_,i)=>{
      const prefix=`${i+1} 1 8:1 / /TEST-${i} ro - ext4 /dev/root ro,`;
      return prefix+"x".repeat(65535-Buffer.byteLength(prefix))+"\n";
    }).join("");
    assert.equal(Buffer.byteLength(exactRows),8*1024*1024);assert.equal(fullBackingMounts(exactRows).length,128);
    const directory=mkdtempSync(join(tmpdir(),"TEST-full-mount-table-")),path=join(directory,"mountinfo");
    try {
      writeFileSync(path,exactRows);assert.equal(readFullMountTable(path),exactRows);
      writeFileSync(path,exactRows+rootRow);assert.throws(()=>readFullMountTable(path));assert.throws(()=>fullBackingMounts(exactRows+rootRow));
      writeFileSync(path,large.slice(0,-1));assert.throws(()=>readFullMountTable(path));
      writeFileSync(path,large);assert.equal(fullBackingMounts(readFullMountTable(path)).length,15144);
      let checkpoints=0;assert.throws(()=>readFullMountTable(path,()=>{if(++checkpoints===2)throw Error("TEST cumulative budget exhausted");}));
    }finally{rmSync(directory,{recursive:true});}
  });

  // A regression discharging readonly/O_PATH or reopening a replaced named path
  // would hide an actual retained foreign raw image descriptor from the census.
  test("actual readonly and O_PATH descriptors retain image exposure after named replacement", {skip:process.platform!=="linux"},()=>{
    const directory=mkdtempSync(join(tmpdir(),"TEST-full-backing-descriptor-")),path=join(directory,"image"),fds:number[]=[];
    try {
      writeFileSync(path,"TEST disposable descriptor identity",{flag:"wx",mode:0o600});
      // Linux UAPI O_PATH; Node's portable constants intentionally omit it.
      for(const flags of [constants.O_RDONLY,0x200000])fds.push(openSync(path,flags|constants.O_NOFOLLOW));
      const s=fstatSync(fds[0]!,{bigint:true}),target={image:{dev:String(s.dev),ino:String(s.ino)},ancestors:[],loopRdev:null,storageDevice:null};
      renameSync(path,path+".held");writeFileSync(path,"different current named image",{flag:"wx",mode:0o600});
      for(const fd of fds)assert.equal(fullBackingDescriptor(fstatSync(fd,{bigint:true}),target),FullBackingExposure.ImageDescriptor);
      const capturedReplacement=statSync(path,{bigint:true});
      assert.equal(fullBackingDescriptor(capturedReplacement,target),null);
      renameSync(path,path+".replacement");renameSync(path+".held",path);
      assert.equal(fullBackingDescriptor(capturedReplacement,target),null);
      assert.equal(fullBackingDescriptor(statSync(path,{bigint:true}),target),FullBackingExposure.ImageDescriptor);
    }finally{for(const fd of fds)closeSync(fd);rmSync(directory,{recursive:true});}
  });

  // Kernel fdinfo mount IDs must join actual mountinfo rather than a textual
  // prefix/parent assumption; otherwise a mount namespace observation is unusable.
  test("actual descriptor mount ID joins its current kernel mount and device",{skip:process.platform!=="linux"},()=>{
    const fd=openSync("/",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try {
      const id=/^mnt_id:\s+([1-9][0-9]*)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`,"utf8"))?.[1];assert(id);
      const mounts=fullBackingMounts(readFullMountTable("/proc/self/mountinfo")),matches=mounts.filter(m=>m.id===id);
      assert.equal(matches.length,1);assert.equal(matches[0]!.point,"/");
      const target={image:{dev:"0",ino:"0"},ancestors:[],loopRdev:null,storageDevice:matches[0]!.device};
      assert.equal(fullBackingDescriptor(fstatSync(fd,{bigint:true}),target),FullBackingExposure.StorageDescriptor);
      assert.throws(()=>fullBackingMounts(readFileSync("/proc/self/mountinfo","utf8")+readFileSync("/proc/self/mountinfo","utf8")));
    }finally{closeSync(fd);}
  });


  // If a future refactor trusts cached directory fstat/birth without reading the
  // retained process object, an exited task could falsely retain joined owner facts.
  test("retained proc/task anchors reject their original owned child after exit",{skip:process.platform!=="linux",timeout:10000},async()=>{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),"--TEST-full-proc-anchor-child"],{env:{PATH:"/usr/bin:/bin",LANG:"C",TMPDIR:tmpdir()},stdio:["ignore","ignore","ignore","ipc"]});
    let processAnchor:ReturnType<typeof retainFullProcProcess>|undefined;
    try {
      const [ready]=await once(child,"message",{signal:AbortSignal.timeout(5000)});
      assert.equal(ready,"TEST-proc-anchor-ready");assert(child.pid);
      processAnchor=retainFullProcProcess(child.pid,()=>{});
      assert(processAnchor.taskIds().includes(String(child.pid)));
      const task=processAnchor.retainTask(child.pid);
      try {
        task.revalidate();
        assert.match(readFileSync(task.path+"/status","utf8"),new RegExp("^Pid:\\s+"+child.pid+"$","m"));
        const exited=once(child,"exit",{signal:AbortSignal.timeout(5000)});
        child.send("TEST-proc-anchor-exit");
        const [code,signal]=await exited;assert.equal(code,0);assert.equal(signal,null);
        assert.throws(()=>task.revalidate());
        assert.throws(()=>processAnchor!.revalidate());
      }finally{task.close();}
    }finally{processAnchor?.close();if(child.connected)child.disconnect();}
  });

}
