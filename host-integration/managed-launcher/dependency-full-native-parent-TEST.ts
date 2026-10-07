/** Fixed no-argument parent. Runs ONLY through original HostJobs admission. */
import { pathToFileURL } from "node:url";
import { fullNativeInputBase, retainCurrentFullParent } from "./dependency-full-native-TEST.js";
async function main(){
  const parent=retainCurrentFullParent();
  try{parent.revalidate();await import(pathToFileURL(fullNativeInputBase+"/"+process.env.TEST_SOURCE_SHA+"/source/scripts/dependency-retention-os-test/current-full-outer.js").href);parent.revalidate();}
  finally{parent.close();}
}
main().catch(()=>{console.error("TEST full managed ingress Held");process.exitCode=70;});
