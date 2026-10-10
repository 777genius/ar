#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HostJobs } from './manager.mjs';
import { readRequestBytes } from './read-request.mjs';
import { installedNativeProbe } from './native-probe/hosted-native-probe/original-owner-adapter.js';
import { routeProbeIngress } from './native-probe/hosted-native-probe/ingress.js';

// This fixed endpoint receives data only on stdin, never executable shell text.
try {
  const routed = routeProbeIngress(await readRequestBytes(process.stdin));
  if (routed.native) {
    let result;
    try { result = await installedNativeProbe(routed.request); }
    catch { throw new Error("NativeProbe original producer unavailable"); }
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } else {
  const request = routed.request;
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
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
  process.exitCode = 1;
}
