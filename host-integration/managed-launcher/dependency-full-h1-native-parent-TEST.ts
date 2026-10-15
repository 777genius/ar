/** Fixed no-argument parent. Runs ONLY through original HostJobs admission. */
import { pathToFileURL } from "node:url";
import { readOriginalFullParentPaths, retainCurrentFullH1Parent } from "./dependency-full-native-TEST.js";
async function main(){
  const parent=retainCurrentFullH1Parent();
  const {fullNativeInputBase}=readOriginalFullParentPaths(parent);
  let terminal:unknown;
  try{parent.revalidate();const outer=await import(pathToFileURL(fullNativeInputBase+"/"+process.env.TEST_SOURCE_SHA+"/source/scripts/dependency-retention-os-test/current-full-outer.js").href);terminal=outer.fullParentTerminal;parent.revalidate();}
  finally{
    // Failed/uncertain outer completion must retain source/proc custody while
    // this actual parent remains live. Its death invalidates the bound pair.
    if(terminal!==undefined)await parent.close(terminal);
  }
}
main().catch(()=>{console.error("TEST full managed ingress Held");process.exitCode=70;});
