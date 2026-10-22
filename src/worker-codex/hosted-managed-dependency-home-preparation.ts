import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { sameDependencyAttempt, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";
import type { HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { readCurrentHostedDependencyHomePreparation, type CurrentHostedDependencySessionHome } from "./hosted-current-dependency-origin";
import { readHostedDependencyRootDirectoryPin } from "./hosted-dependency-root-physical-facts";
import type { HostedDependencyRootDirectoryPin } from "../provider-codex/app-server/adapters/hosted-dependency-root-purpose-record";
function invalid(): never { throw new Error("hosted_dependency_current_origin_unresolved"); }
/** Actual fixed pending-home IO. Only the sole original issuer can retain and
 * subsequently publish the unescaped opaque home; returned pins grant nothing. */
export function preparePhysicalOriginalHostedDependencySessionHome(home: CurrentHostedDependencySessionHome, fence: HostedActivationFence) {
    const held = readCurrentHostedDependencyHomePreparation(home,fence);
    const create = (path:string,parent:HostedDependencyRootDirectoryPin,fresh:boolean) => {
      const before = readHostedDependencyRootDirectoryPin(parent.canonicalPath), stat = lstatSync(parent.canonicalPath);
      if (JSON.stringify(before) !== JSON.stringify(parent) || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o700) invalid();
      try { mkdirSync(path,{mode:0o700}); } catch (error) { if (fresh || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const pin = readHostedDependencyRootDirectoryPin(path), named = lstatSync(path);
      if (named.uid !== 0 || named.gid !== 0 || (named.mode & 0o7777) !== 0o700 || pin.dev !== parent.dev || pin.mountId !== parent.mountId ||
          JSON.stringify(readHostedDependencyRootDirectoryPin(parent.canonicalPath)) !== JSON.stringify(parent)) invalid();
      return pin;
    };
    const job = held.jobRoot, parent = create(job.canonicalPath+"/home",job,false), cache = create(parent.canonicalPath+"/codex-session-cache",parent,false);
    const root = create(held.rootPath,cache,true), homePin = create(root.canonicalPath+"/home",root,true);
    const codexHome = create(root.canonicalPath+"/codex-home",root,true), emptyWorkdir = create(root.canonicalPath+"/empty-workdir",root,true);
    const path = codexHome.canonicalPath+"/config.toml", fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { writeFileSync(fd,held.configBytes); fsyncSync(fd); } finally { closeSync(fd); }
    const parentFd = openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    const named = lstatSync(path,{bigint:true}), after = readCurrentHostedDependencyHomePreparation(home,fence);
    if (!named.isFile() || named.uid !== 0n || named.gid !== 0n || named.nlink !== 1n || (named.mode & 0o7777n) !== 0o600n ||
        !sameDependencyAttempt(after.attempt,held.attempt) || !after.configBytes.equals(held.configBytes)) invalid();
    const config: DependencyProtectedReference = {path,identity:{dev:String(named.dev),ino:String(named.ino)},sha256:createHash("sha256").update(held.configBytes).digest("hex")};
    return {root,home:homePin,codexHome,emptyWorkdir,config,configBytes:held.configBytes};
}
