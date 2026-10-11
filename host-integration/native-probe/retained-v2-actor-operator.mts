import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runRetainedV2ActorRootOperation } from "./retained-v2-operator.mjs";
// Fixed separately measured B1a parent. No caller profile/command selection.
if(resolve(process.argv[1]??"")===fileURLToPath(import.meta.url)) {
  runRetainedV2ActorRootOperation().catch(error=>{
    process.stderr.write(String(error)+"\n");process.exitCode=77;
  });
}
