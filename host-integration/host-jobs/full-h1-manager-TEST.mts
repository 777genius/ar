/** No payload ingress. The installed original native producer supplies the sole request. */
import {HostJobs} from "./manager.mjs";
import {ManagedLauncherProfile} from "../managed-launcher/launch.mjs";
import {fullH1TestManager, fullH1TestRoot} from "../managed-launcher/full-h1-test-profile.mjs";
import {readFileSync,readlinkSync} from "node:fs";
const node="/opt/nodejs/node-v24.21.0-linux-x64/bin/node";
try {
  if(process.execPath!==node || process.argv.length!==2 || process.argv[0]!==node || process.argv[1]!==fullH1TestManager || readlinkSync("/proc/self/exe")!==node || !readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv, ""].join("\0")))) throw new Error("TEST manager Held");
  // Fixed installed alias, byte-identical to the catalog-bound compiler output.
  const native=await import(fullH1TestRoot+"/managed-launcher/dependency-full-native-TEST.mjs");
  if(typeof native.fullH1ManagedStartRequest!=="function" || typeof native.readFullH1StartedHeld!=="function") throw new Error("TEST module Held");
  const request=native.fullH1ManagedStartRequest();
  const manager=new HostJobs({stateDir:"/root/.local/state/subscription-runtime/host-jobs",launcherProfile:ManagedLauncherProfile.FixedFullH1Test});
  const result=await manager.start(request);
  if(result.phase!=="started" || result.retry) throw new Error("same-job uncertain; reconcile only");
  process.stdout.write(JSON.stringify(native.readFullH1StartedHeld())+"\n");
} catch {process.exitCode=70;}
