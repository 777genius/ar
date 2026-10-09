import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const entry = process.env.NP_ORIGINAL_OWNER;
const importChild = process.argv[2] === "addon-refusal-child";
if (!importChild) assert.ok(entry, "use the owned native source harness");
const admitted = process.env.NP_ORIGINAL_OWNER_PRIVILEGED === "65532-seal-admitted";
interface Result { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stdout: string; readonly stderr: string }
function decode(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function refusal(args: readonly string[]): Promise<Result> {
  const child = spawn(entry!, [...args], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(); let stdout = "", stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  return new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => accept({ code, signal, stdout, stderr }));
  });
}
if (importChild) {
  // A real new environment has no original kernel endpoint or native held
  // launch. Loading the actual addon must refuse; exported JS DATA cannot bind.
  const addon = process.argv[3]; assert.ok(addon);
  const children = (): string => readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim();
  assert.equal(children(), "");
  assert.throws(() => process.dlopen({ exports: {} }, addon), /original native startup refused/);
  assert.equal(children(), "");
  process.stdout.write(JSON.stringify({ refused: true, children: 0, pid: process.pid, parent: process.ppid }) + "\n");
} else {
// Red: an arbitrary actual Node environment, with valid addon bytes but no
// original parent endpoint/seal, can register by loading/copied exported DATA.
test("actual foreign Node environment cannot bootstrap the original bridge", async () => {
  const addon = process.env.NP_ORIGINAL_OWNER_ADDON; assert.ok(addon);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "addon-refusal-child", addon], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  const facts = decode(stdout.trim()); assert.equal(facts.refused, true); assert.equal(facts.children, 0);
});
// Red: a real silent seqpacket at fd3 blocks before peer validation or startup
// bounds. The native fixture retains an original child handle; on old code it
// closes only its own silent endpoint, joins naturally, and reports timeout RED.
test("silent and wrong-peer original startup endpoints settle without admission", { timeout: 15000 }, async () => {
  const fixture = process.env.NP_ORIGINAL_OWNER_REFUSAL_FIXTURE; assert.ok(fixture);
  for (const mode of ["silent", "wrong-peer"]) {
    const child = spawn(fixture, [mode], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null }, `${mode}: ${stderr} ${stdout}`);
    const rows = stdout.trim().split("\n").map(decode);
    const refusal = rows.find(row => row.refused === true), settled = rows.find(row => row.stage === "refusal-fixture");
    assert.ok(refusal && settled, mode); assert.equal(refusal.children, 0);
    assert.equal(settled.timedOut, false); assert.equal(settled.childJoined, true); assert.equal(settled.socketClosed, true);
    assert.equal(refusal.parent, mode === "silent" ? settled.peerOwner : settled.launcher);
    if (mode === "wrong-peer") assert.notEqual(refusal.parent, settled.peerOwner);
  }
});
// Red: the fixed native entry starts accepting argv-selected modes, executables,
// PIDs or copied snapshot DATA. Rejection happens before the native reservation.
test("original owner entry has no public import or launch selector", async () => {
  for (const argument of ["attachByFD=3", "pid=1", '{"committed":true}', "--node=/bin/true"]) {
    const result = await refusal([argument]);
    assert.equal(result.code, 64); assert.equal(result.signal, null);
    assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});
// Red: an ordinary same-UID process gains a native original owner, starts a
// helper, or reports qualification without the genuine trusted privilege setup.
test("unprivileged original entry refuses before helper launch", { skip: process.geteuid?.() === 0 ? "root fixture cannot prove ordinary-UID refusal" : false }, async () => {
  const result = await refusal([]);
  assert.equal(result.code, 77); assert.equal(result.signal, null);
  const facts = decode(result.stdout.trim());
  assert.equal(facts.stage, "refused"); assert.equal(facts.effects, 0); assert.equal(facts.error, 1);
});
// Red: seal HELLO renews the anchor, proc EACCES is bypassed, a JS object mints
// commit, EOF disposal drops parent custody, or an exit text substitutes for
// original wait + both pipe closes. This uses the actual 65532 sealed helper.
test("original held birth commits once and survives actual environment disposal", { skip: !admitted ? "separately admitted NEWTEST privileged setup required" : false, timeout: 190000 }, async () => {
  assert.equal(process.geteuid?.(), 0, "the separately admitted fixture must provide root setup");
  const child = spawn(entry!, [], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
  const attempts = process.env.NP_ORIGINAL_OWNER_ATTEMPTS; assert.ok(attempts);
  const attempt = randomUUID(), prefix = join(attempts, attempt);
  const rawOut: Buffer[] = [], rawErr: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { rawOut.push(bytes); });
  child.stderr.on("data", (bytes: Buffer) => { rawErr.push(bytes); stderr += bytes.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout });
  const observed: Array<Record<string, unknown>> = [];
  let committed: Record<string, unknown> | undefined, helper: Record<string, unknown> | undefined;
  try {
    await writeFile(`${prefix}-started.json`, JSON.stringify({ attempt, kind: "original-owner-seal", parent: process.pid, pid: child.pid ?? null, entry, fixture: attempts, naturalClose: false, joined: false }) + "\n", { flag: "wx" });
    for await (const line of lines) {
      const facts = decode(line); observed.push(facts);
      if (facts.stage === "committed") committed = facts;
      if (facts.stage === "helper") helper = facts;
      if (committed && helper) child.stdin.end();
    }
    const exit = await closed;
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.ok(committed, `no committed original owner: ${JSON.stringify(observed)} ${stderr}`);
    assert.ok(helper, "no actual sealed Node helper observation");
    assert.equal(committed.committed, true); assert.equal(committed.legacyRefused, true);
    assert.equal(committed.live, true); assert.equal(committed.retained, true); assert.equal(committed.effects, 0);
    assert.equal(helper.uid, 65532); assert.equal(helper.gid, 65532); assert.equal(helper.cap0, true);
    assert.equal(helper.nnp, true); assert.equal(helper.libuvAfterSeal, true);
    assert.ok(typeof helper.threads === "number" && helper.threads > 1);
    assert.ok(typeof committed.anchor === "string" && typeof committed.preparationEnd === "string" && typeof committed.cleanupEnd === "string" && typeof committed.coldEnd === "string");
    const anchor = BigInt(committed.anchor);
    assert.equal(BigInt(committed.preparationEnd) - anchor, 120000000000n);
    assert.equal(BigInt(committed.cleanupEnd) - anchor, 180000000000n);
    assert.equal(BigInt(committed.coldEnd) - anchor, 10000000000n);
    const lost = observed.find(facts => facts.stage === "closed"); assert.ok(lost);
    assert.equal(lost.state, 3); assert.equal(lost.loss, 4); assert.equal(lost.retained, true);
    assert.equal(lost.committed, true); assert.equal(lost.uncertain, true); assert.equal(lost.effects, 0);
    for (const key of ["anchor", "preparationEnd", "cleanupEnd", "coldEnd", "helper"]) assert.equal(lost[key], committed[key], key);
    assert.ok(typeof lost.attemptEnd === "string" && BigInt(lost.attemptEnd) <= BigInt(committed.cleanupEnd));
    assert.equal(observed.filter(facts => facts.stage === "committed").length, 1);
    assert.equal(observed.filter(facts => facts.stage === "joined").length, 1);
    const repeated = observed.find(facts => facts.stage === "closed-again"); assert.ok(repeated);
    assert.equal(repeated.state, 3); assert.equal(repeated.loss, lost.loss); assert.equal(repeated.retained, true);
    for (const key of ["anchor", "preparationEnd", "cleanupEnd", "coldEnd", "attemptEnd", "helper", "sequence"]) assert.equal(repeated[key], lost[key], key);
  } finally {
    child.stdin.end(); lines.close();
    // Do not replace/kill/retry an uncertain helper. Natural original close is
    // retained by the harness even when an assertion fails.
    const result = await closed;
    await writeFile(`${prefix}.stdout`, Buffer.concat(rawOut), { flag: "wx" });
    await writeFile(`${prefix}.stderr`, Buffer.concat(rawErr), { flag: "wx" });
    await writeFile(`${prefix}-result.json`, JSON.stringify({ attempt, kind: "original-owner-seal", pid: child.pid ?? null, entry, fixture: attempts, naturalClose: true, ...result, joined: result.code === 0 && result.signal === null && observed.some(row => row.stage === "joined"), observations: observed, stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr` }) + "\n", { flag: "wx" });
  }
});
}
