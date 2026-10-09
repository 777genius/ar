#!/usr/bin/env node
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { HostJobs } from './manager.mjs';
import { readRequestBytes } from './read-request.mjs';
import { installedNativeProbe } from './native-probe/hosted-native-probe/original-owner-adapter.js';
import { routeProbeIngress } from './native-probe/hosted-native-probe/ingress.js';
import { readMimoProjectIngress } from './native-probe/hosted-native-probe/mimo-project-ingress.js';

// This fixed endpoint receives data only on stdin, never executable shell text.
try {
  const original = await readRequestBytes(process.stdin);
  const mimo = readMimoProjectIngress(original);
  const routed = mimo ? { native: false, request: mimo } : routeProbeIngress(original);
  if (routed.native) {
    let result;
    try { result = await installedNativeProbe(routed.request); }
    catch { throw new Error("NativeProbe original producer unavailable"); }
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } else {
  const request = routed.request;
  if (request.kind === "MimoProject") {
    // A finite independently admitted root operation, never an outer-job payload
    // or a caller-selected executable. The installed release is trusted custody.
    const entry = realpathSync("/opt/subscription-runtime/mimo-project-bridge-current/dist/worker-codex/hosted-mimo-project-bridge-cli.js");
    for (let path = entry;; path = dirname(path)) {
      const stat = lstatSync(path);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink() ||
          (path === entry ? !stat.isFile() : !stat.isDirectory())) throw new Error("MiMo project bridge unavailable");
      if (path === "/") break;
    }
    const response = spawnSync(process.execPath, [entry], { input: JSON.stringify(request), encoding: "utf8",
      timeout: 110000, maxBuffer: 1048576, env: { PATH: "/usr/bin:/bin", HOME: "/root", USER: "root", LOGNAME: "root" } });
    if (response.error || response.signal || !response.stdout.trim()) throw new Error("MiMo project bridge outcome unknown");
    const parsed = JSON.parse(response.stdout);
    if (typeof parsed.ok !== "boolean") throw new Error("MiMo project bridge response invalid");
    process.stdout.write(JSON.stringify(parsed) + "\n");
    if (!parsed.ok) process.exitCode = 1;
  } else {
  const manager = new HostJobs({ stateDir: join(homedir(), '.local/state/subscription-runtime/host-jobs') });
  let result;
  switch (request.operation) {
    case 'start': result = await manager.start(request); break;
    case 'status': result = await manager.status(request.jobId, request.machineId); break;
    case 'stop': result = await manager.stop(request.jobId, request.machineId); break;
    default: throw new Error('unknown operation');
  }
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  }
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
  process.exitCode = 1;
}
