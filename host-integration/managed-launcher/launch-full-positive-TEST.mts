/** Actual fixed entry, same single launcher main and custody WeakMap. */
import {runManagedLauncherMain, fullPositiveTestJob, fullPositiveTestEntry} from "./launch.mjs";
import {readFileSync, readlinkSync} from "node:fs";
const node="/opt/nodejs/node-v24.21.0-linux-x64/bin/node";
try {
  if(process.execPath!==node || process.argv.length!==4 || process.argv[0]!==node || process.argv[1]!==fullPositiveTestEntry || process.argv[2]!=="job" || readlinkSync("/proc/self/exe")!==node || !readFileSync("/proc/self/cmdline").equals(Buffer.from([...process.argv, ""].join("\0")))) throw new Error("TEST entry Held");
  const value:unknown=JSON.parse(process.argv[3]!);
  if(!value || typeof value!=="object" || !("jobId" in value) || value.jobId!==fullPositiveTestJob) throw new Error("TEST entry Held");
  await runManagedLauncherMain();
} catch {process.exitCode=70;}
