/** Fixed bubblewrap argv for one private, read-only tool image and authenticated
 * input directory. No external writable binding or caller-selected command. */
import assert from "node:assert/strict";
import {readlinkSync} from "node:fs";
import {posix} from "node:path";
import {H1SemanticFamily,h1PatchedSourceLimits} from "./current-h1-source-semantics-TEST.ts";
export function h1SourceSandboxArgv(toolRoot:string,inputs:string,family:H1SemanticFamily,dsc:string){
 for(const path of [toolRoot,inputs])assert(path.length<4096&&path.startsWith("/")&&posix.normalize(path)===path&&path!=="/"&&!/[\x00-\x1f\x7f]/.test(path));
 assert(toolRoot!==inputs&&!toolRoot.startsWith(inputs+"/")&&!inputs.startsWith(toolRoot+"/"));assert(Object.values(H1SemanticFamily).includes(family));assert(/^[A-Za-z0-9_.+%:~-]+\.dsc$/.test(dsc));
 return Object.freeze(["--unshare-all","--die-with-parent","--new-session","--cap-drop","ALL","--ro-bind",toolRoot,"/","--ro-bind",inputs,"/inputs","--size",String(h1PatchedSourceLimits.totalBytes),"--tmpfs","/output","--size",String(32*1024*1024),"--tmpfs","/tmp","--proc","/proc","--dev","/dev","--clearenv","--setenv","PATH","/usr/bin:/bin","--setenv","LANG","C","--setenv","LC_ALL","C","--setenv","HOME","/nonexistent","--setenv","TMPDIR","/tmp","--setenv","DEB_VENDOR","Ubuntu","--setenv","TEST_OUTER_mnt",readlinkSync("/proc/self/ns/mnt"),"--setenv","TEST_OUTER_net",readlinkSync("/proc/self/ns/net"),"--setenv","TEST_OUTER_pid",readlinkSync("/proc/self/ns/pid"),"--setenv","TEST_OUTER_user",readlinkSync("/proc/self/ns/user"),"--chdir","/output","--","/runtime/node","/runtime/current-h1-source-extraction-child-TEST.js",family,dsc]);
}
