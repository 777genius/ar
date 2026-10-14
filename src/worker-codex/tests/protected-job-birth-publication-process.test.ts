import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const native = process.platform === "linux" && process.getuid?.() === 0;
const roots: string[] = [], children = new Set<ChildProcess>();
let bundle = "";
beforeAll(async () => {
  if (!native) return;
  const root = fresh(), source = join(root, "child.ts"); bundle = join(root, "child.mjs");
  const production = fileURLToPath(new URL("../protected-job-birth.ts", import.meta.url));
  writeFileSync(source, `import {withProtectedCodexGoalJobBirthPublication as hold,recoverProtectedCodexGoalJobBirthPublication as recover} from ${JSON.stringify(production)};
const mode=process.argv[2];
if(mode==='hold') await hold(async()=>{process.stdin.resume(); console.log('held'); await new Promise(()=>{});});
else {console.log('ready'); await new Promise(r=>process.stdin.once('data',r)); try{recover(JSON.parse(process.argv[4])); console.log('recovered');}catch{console.log('refused');}}
`);
  // Only TEST authority ancestry and the cgroup location are synthetic. Actual
  // PID/start ticks, namespaces, boot, file syscalls, flock and SIGKILL are real.
  await build({ configFile: false, logLevel: "silent", plugins: [{ name: "TEST-publication-authority", enforce: "pre",
    resolveId(id) { if (id === "./research-launch-files" || id === "./research-launch-host") return "\0TEST" + id; },
    load(id) {
      if (id === production) return readFileSync(production, "utf8").replace("'/sys/fs/cgroup'", "os.readlink('/proc/self/fd/4')+'/TEST-cgroups'");
      if (id === "\0TEST./research-launch-host") return `import{readFileSync,readlinkSync}from'node:fs';
export function assertResearchInitialRoot(){if(process.platform!=='linux'||process.getuid()!==0)throw Error('TEST_root_required');}
export function researchProcessIdentity(){const s=readFileSync('/proc/self/stat','utf8');return{pid:process.pid,birthTicks:s.slice(s.lastIndexOf(')')+2).split(/\\s+/)[19],bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),machineId:readFileSync('/etc/machine-id','utf8').trim(),controlGroup:'/TEST-publication-'+process.argv[3].split('/').at(-1),namespaces:Object.fromEntries(['user','mnt','pid','net'].map(k=>[k,readlinkSync('/proc/1/ns/'+k)]))};}`;
      if (id === "\0TEST./research-launch-files") return `import{closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{dirname}from'node:path';
export const researchAuthorityRoot=process.argv[3];
export function researchCustody(p){if(p==='/usr/bin/python3'||p===realpathSync('/usr/bin/python3'))return; if(!(p===researchAuthorityRoot||p.startsWith(researchAuthorityRoot+'/'))||realpathSync(p)!==p||lstatSync(p).uid!==0||(lstatSync(p).mode&0o022))throw Error('TEST_custody');}
export function researchPrivateDirectory(p){try{researchCustody(p);}catch(e){if(e.code!=='ENOENT')throw e;mkdirSync(p,{mode:0o700});researchCustody(p);}}
export function researchPublish(p,v){const fd=openSync(p,'wx',0o600);try{writeFileSync(fd,JSON.stringify(v)+'\\n');fsyncSync(fd);}finally{closeSync(fd);}const d=openSync(dirname(p),'r');try{fsyncSync(d);}finally{closeSync(d);}}
export const researchHash=x=>createHash('sha256').update(x).digest('hex');
export const researchDirectoryIdentity=p=>({path:p,device:lstatSync(p).dev,inode:lstatSync(p).ino});
export const assertResearchDirectory=x=>{const s=lstatSync(x.path);if(s.dev!==x.device||s.ino!==x.inode)throw Error('TEST_drift');};
export const researchJson=x=>JSON.parse(x.toString()),researchRead=p=>readFileSync(p),researchPath=p=>p,researchArtifactDigest=()=>{throw Error('TEST_no_runtime_effect');};`;
    } }], build: { outDir: root, emptyOutDir: false, target: "node20", ssr: source,
      rollupOptions: { output: { entryFileNames: "child.mjs" } } } });
});
afterEach(async () => {
  for (const child of children) { const ended = once(child, "close"); child.kill("SIGKILL"); await ended; }
  children.clear();
});

describe.runIf(native)("real protected publication recovery", () => {
  it("refuses descendant-populated, missing and unknown cgroup events before recursive emptiness is proven", async () => {
    const root = fresh(), held = child("hold", root); await line(held);
    const ended = once(held, "close"); held.kill("SIGKILL"); await ended;
    const expected = pins(root), group = join(root, "job-births/TEST-cgroups", "TEST-publication-" + root.split("/").at(-1));
    mkdirSync(group, { recursive: true, mode: 0o700 });
    // The direct group may contain no PIDs while descendants remain populated.
    writeFileSync(join(group, "cgroup.procs"), "");
    expect(await recovery(root, expected)).toBe("refused"); // Existing group, missing evidence.
    for (const events of ["populated 1\nfrozen 0\n", "frozen 0\n", "populated unknown\n", "populated 0\npopulated 0\n"]) {
      writeFileSync(join(group, "cgroup.events"), events);
      expect(await recovery(root, expected)).toBe("refused");
      expect(statSync(join(root, "job-births/publication.lock")).ino).toBe(expected.inode);
    }
    writeFileSync(join(group, "cgroup.events"), "populated 0\nfrozen 0\n");
    expect(await recovery(root, expected)).toBe("recovered");
  });
  it("refuses an alive owner, recovers after SIGKILL, and preserves its audit", async () => {
    const root = fresh(), held = child("hold", root); expect(await line(held)).toBe("held");
    const expected = pins(root); expect(await recovery(root, expected)).toBe("refused");
    const ended = once(held, "close"); held.kill("SIGKILL"); await ended;
    expect(await recovery(root, expected)).toBe("recovered");
    const owner = JSON.parse(readFileSync(join(root, "job-births", `.publication-${expected.nonce}.owner.json`), "utf8"));
    expect(owner.process.pid).toBe(held.pid);
    expect(() => statSync(join(root, "job-births/publication.lock"))).toThrow();
  });
  it("handles PID reuse and permits only one of concurrent CAS recoverers", async () => {
    const root = fresh(), held = child("hold", root); await line(held);
    const ended = once(held, "close"); held.kill("SIGKILL"); await ended;
    const path = join(root, "job-births/publication.lock"), owner = JSON.parse(readFileSync(path, "utf8"));
    owner.process.pid = process.pid;
    const current = readFileSync("/proc/self/stat", "utf8");
    owner.process.birthTicks = String(BigInt(current.slice(current.lastIndexOf(")") + 2).split(/\s+/)[19]!) + 1n);
    writeFileSync(path, JSON.stringify(owner) + "\n"); // TEST models the old PID's later reuse.
    const expected = pins(root), attempts = [child("recover", root, expected), child("recover", root, expected)];
    await Promise.all(attempts.map(line));
    const results = attempts.map(line); attempts.forEach(c => c.stdin!.end("go"));
    expect((await Promise.all(results)).sort()).toEqual(["recovered", "refused"]);
    const replacement = child("hold", root); await line(replacement);
    expect(await recovery(root, expected)).toBe("refused");
  });
});

afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
function fresh(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "TEST-publication-process-"))); roots.push(root); return root; }
function pins(root: string) { const path = join(root, "job-births/publication.lock"), stat = statSync(path), bytes = readFileSync(path);
  return { device: stat.dev, inode: stat.ino, ownerSha256: createHash("sha256").update(bytes).digest("hex"), nonce: JSON.parse(bytes.toString()).nonce }; }
function child(mode: string, root: string, expected?: unknown): ChildProcess {
  const process = spawn(globalThis.process.execPath, [bundle, mode, root, JSON.stringify(expected ?? null)], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  children.add(process); process.once("close", () => children.delete(process)); return process;
}
function line(child: ChildProcess): Promise<string> { return new Promise((resolve, reject) => {
  let text = ""; const timer = setTimeout(() => { cleanup(); reject(new Error("TEST_child_timeout")); }, 10000);
  const data = (part: Buffer) => { text += part.toString(); if (text.includes("\n")) { cleanup(); resolve(text.split("\n")[0]!); } };
  const close = () => { cleanup(); reject(new Error("TEST_child_exited")); };
  const cleanup = () => { clearTimeout(timer); child.stdout!.off("data", data); child.off("close", close); };
  child.stdout!.on("data", data); child.once("close", close);
}); }
async function recovery(root: string, expected: unknown): Promise<string> { const attempt = child("recover", root, expected);
  expect(await line(attempt)).toBe("ready"); const result = line(attempt); attempt.stdin!.end("go"); return result; }
