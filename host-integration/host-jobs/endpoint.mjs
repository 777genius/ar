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
import { readResearchOperatorIngress } from './native-probe/hosted-native-probe/research-operator-ingress.js';

// This fixed endpoint receives data only on stdin, never executable shell text.
try {
  const original = await readRequestBytes(process.stdin);
  const research = readResearchOperatorIngress(original);
  const routed = research ? { native: false, request: research } : routeProbeIngress(original);
  if (routed.native) {
    let result;
    try { result = await installedNativeProbe(routed.request); }
    catch { throw new Error("NativeProbe original producer unavailable"); }
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } else {
  const request = routed.request;
  if (request.kind === "ResearchOperator") {
    const entry = realpathSync("/opt/subscription-runtime/current/dist/worker-codex/research-operator-ingress-cli.js");
    for (let path = entry;; path = dirname(path)) {
      const stat = lstatSync(path);
      if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink() ||
          (path === entry ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error("research_operator_runtime_invalid");
      if (path === "/") break;
    }
    const response = spawnSync(process.execPath, [entry], { input: JSON.stringify(request), encoding: "utf8", timeout: 110000,
      maxBuffer: 1048576, env: { PATH: "/usr/bin:/bin", HOME: "/root", USER: "root", LOGNAME: "root" } });
    if (response.error || response.signal || !response.stdout.trim()) throw new Error("research_operator_outcome_unknown");
    const parsed = JSON.parse(response.stdout);
    if (typeof parsed.ok !== "boolean") throw new Error("research_operator_response_invalid");
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
