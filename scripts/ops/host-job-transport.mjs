import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostLock } from './host-job-lock.mjs';

const hosts = new Map();
export function sshOutput(code, output) {
  if (code === 0 || (code !== 255 && output.trim().startsWith('{'))) return output;
  throw new Error(`ssh failed (${code})`);
}
function command(args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // PAM can spend 25s activating logind before the forced endpoint starts.
    // Give a request time to reach that endpoint; connection-only checks stay
    // short. A deadline still makes the outcome uncertain and never replays it.
    const timeoutMs = stdin === '' ? 25000 : 45000;
    const deadline = performance.now() + timeoutMs;
    let output = '', exited = false, code = null, signal = null;
    let stdoutEnded = false, stdinFinished = false, closed = false, done = false;
    let failure;
    // A multiplex master may keep stderr open after the foreground SSH exits.
    // Consume its diagnostics until the original deadline, without retaining them.
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.resume();
      child.stderr.unref();
      child.unref();
      const drain = setTimeout(() => child.stderr.destroy(), Math.max(0, deadline - performance.now()));
      drain.unref();
      if (failure) { reject(failure); return; }
      try { resolve(sshOutput(code, output)); } catch (error) { reject(error); }
    }
    function progress() {
      if (done) return;
      // Nonzero structured endpoint responses still require complete diagnostics.
      if (exited && signal === null && stdoutEnded && stdinFinished && !failure &&
          (code === 0 || closed)) finish();
      else if (closed) { failure ??= new Error('ssh streams or input incomplete'); finish(); }
    }
    const timer = setTimeout(() => {
      failure ??= new Error('ssh command deadline exceeded');
      if (!exited) child.kill('SIGKILL');
      finish();
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (done || failure) return;
      output += chunk;
      if (output.length > 1048576) {
        failure = new Error('ssh stdout limit exceeded');
        child.kill('SIGKILL');
      }
    });
    child.stdout.on('end', () => { stdoutEnded = true; progress(); });
    child.stdout.on('error', error => { failure ??= error; progress(); });
    child.stderr.resume();
    child.stderr.on('error', error => { if (!done) { failure ??= error; progress(); } });
    child.stdin.on('finish', () => { stdinFinished = true; progress(); });
    child.stdin.on('error', error => { failure ??= error; progress(); });
    child.on('error', error => { failure ??= error; finish(); });
    child.on('exit', (status, exitSignal) => {
      exited = true; code = status; signal = exitSignal;
      if (status === null || exitSignal !== null) failure ??= new Error('ssh exited without a normal status');
      progress();
    });
    child.on('close', () => { closed = true; progress(); });
    child.stdin.end(stdin);
  });
}
export function hostTransport({ host, machineId, socketDir, run = command }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host) || !/^[a-f0-9]{32}$/.test(machineId)) throw new Error('invalid host identity');
  if (host.includes('@')) throw new Error('restricted transport requires a host alias without a user');
  const destination = `sr-transport@${host}`;
  const key = `${destination}:${machineId}:restricted`;
  if (hosts.has(key)) return hosts.get(key);
  const socket = join(socketDir, createHash('sha256').update(key).digest('hex').slice(0, 24));
  let ready;
  let active = 0;
  let starts = 0;
  const queue = [];
  const base = ['-oBatchMode=yes', '-oConnectTimeout=10', '-oServerAliveInterval=5', '-oServerAliveCountMax=2', '-S', socket];
  async function connect() {
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    // Explicit master creation. A failed check never falls back to standalone SSH.
    try { await run([...base, '-O', 'check', destination]); }
    catch { await run([...base, '-M', '-N', '-f', '-oControlPersist=600', destination]); }
  }
  function drain() {
    for (let i = 0; i < queue.length && active < 4;) {
      const item = queue[i];
      if (item.start && starts >= 3) { i++; continue; }
      queue.splice(i, 1); active++; if (item.start) starts++;
      item.resolve(() => { active--; if (item.start) starts--; drain(); });
    }
  }
  const transport = {
    async request(request) {
      if (!(request.kind === 'MimoProject' ? ['create', 'start', 'status', 'stop'] : ['start', 'status', 'stop']).includes(request.operation)) throw new Error('invalid operation');
      if (request.machineId !== machineId) throw new Error('machine identity mismatch');
      const release = await new Promise(resolve => { queue.push({ start: request.operation === 'start', resolve }); drain(); });
      let unlock;
      try {
        unlock = await hostLock(socketDir, createHash('sha256').update(key).digest('hex').slice(0, 24));
        ready ??= connect().catch(error => { ready = undefined; throw error; });
        const generation = ready;
        await generation;
        // ProxyCommand=false prevents OpenSSH opening a fresh connection if the
        // multiplex socket vanishes between check and command dispatch.
        const args = [...base, '-T', '-oControlMaster=no', '-oProxyCommand=false', destination];
        let output;
        try { output = await run(args, JSON.stringify(request)); }
        catch (error) {
          // A rejected body may already have been accepted. Never replay it.
          if (ready === generation) ready = undefined;
          throw new Error('ssh request outcome unknown', { cause: error });
        }
        const response = JSON.parse(output);
        if (!response.ok) throw new Error(response.error);
        return response.result;
      } finally { try { if (unlock) await unlock(); } finally { release(); } }
    },
  };
  hosts.set(key, transport);
  return transport;
}
