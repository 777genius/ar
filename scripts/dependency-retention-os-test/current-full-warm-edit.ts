/** Natural user edit in the owned C-only TEST cohort between fully drained uses. */
import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import { assertHostedForegroundResult, type HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { readHostedDependencyBinding } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { readHostedDependencyEstablishedReceipt } from "../../dist/worker-codex/hosted-dependency-receipts.js";
import { DependencyReceiptState } from "../../dist/worker-core/index.js";
import { assertCurrentClosedEntry } from "./current-closed-entry.js";
import { assertRootScope, type CurrentColdHotRoots } from "./current-cold-hot-root.js";
const original = Buffer.from("export const liveValue = 6;\n"), changed = Buffer.from("export const liveValue = 6;\nexport const liveRevision = 'TEST-live-v2';\n");
/** The result only reauthenticates CURRENT closure. Actual ROOT ownership,
 * common exclusion, idle/native/barrier census authorize this one own edit.
 * No current-origin symbol/issuer/DTO is reconstructed or supplied. */
export function editCurrentPureLinkedLeaf(roots: CurrentColdHotRoots, result: HostedForegroundResult) {
  assertHostedForegroundResult(result); assertRootScope(roots);
  return withHostedActivationFence(fence => {
    const closed = assertCurrentClosedEntry(fence,roots.jobRoot,result);
    const binding = readHostedDependencyBinding(roots.candidateJobId); assert(binding && binding.version===2);
    const receipt = readHostedDependencyEstablishedReceipt(binding); assert(receipt && receipt.state===DependencyReceiptState.Ready);
    const nodeModules = lstatSync(roots.workspace+"/node_modules"); assert(nodeModules.isDirectory() && !nodeModules.isSymbolicLink());
    const path = roots.workspace+"/packages/live/index.ts";
    // Final-leaf NOFOLLOW alone cannot protect symlinked parent directories.
    // Only this original TEST workspace and its literal pure-link ancestry.
    for (const parent of [roots.workspace, roots.workspace+"/packages", roots.workspace+"/packages/live"]) {
      const s=lstatSync(parent);assert(s.isDirectory() && !s.isSymbolicLink() && s.uid===0 && s.gid===0 && !(s.mode & 0o022));
      assert.equal(realpathSync(parent),parent);
    }
    assert.equal(realpathSync(path),path);
    const fd = openSync(path,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const before=fstatSync(fd),named=lstatSync(path);
      assert(before.isFile() && !named.isSymbolicLink() && before.uid===0 && before.gid===0 && before.nlink===1 && (before.mode & 0o7777)===0o644);
      assert.equal(named.dev,before.dev);assert.equal(named.ino,before.ino);assert.equal(before.size,original.length);
      const bytes=Buffer.alloc(original.length+1);assert.equal(readSync(fd,bytes,0,bytes.length,0),original.length);assert(bytes.subarray(0,original.length).equals(original));
      let offset=0;while(offset<changed.length) {const n=writeSync(fd,changed,offset,changed.length-offset,offset);assert(n>0);offset+=n;}
      fsyncSync(fd);const after=fstatSync(fd),last=lstatSync(path);
      for(const stat of [after,last]) {assert(stat.isFile() && !stat.isSymbolicLink());
        for(const key of ["dev","ino","mode","uid","gid","nlink"] as const)assert.equal(stat[key],before[key]);assert.equal(stat.size,changed.length);}
      const verified=Buffer.alloc(changed.length+1);assert.equal(readSync(fd,verified,0,verified.length,0),changed.length);assert(verified.subarray(0,changed.length).equals(changed));
    } finally {closeSync(fd);}
    // No leaf/proof FD remains open during the fresh physical census.
    assertCurrentClosedEntry(fence,roots.jobRoot,result);
    const latest=readHostedDependencyEstablishedReceipt(binding);assert(latest && latest.state===DependencyReceiptState.Ready);
    assert.equal(latest.installKey,receipt.installKey);assert.equal(latest.revision,receipt.revision);
    const observed=lstatSync(roots.workspace+"/node_modules");assert.equal(observed.dev,nodeModules.dev);assert.equal(observed.ino,nodeModules.ino);
    return Object.freeze({sourceClosedSha256:closed.sourceClosedSha256,installKey:receipt.installKey,nodeModulesPreserved:true});
  });
}
