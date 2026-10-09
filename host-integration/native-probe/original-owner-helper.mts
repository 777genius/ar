import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { scrypt } from "node:crypto";
import { promisify } from "node:util";

// Fixed protected bootstrap. No exported loader/constructor, Source callback,
// path/env selector, descriptor import or resource operation is available.
interface InternalOwner { readonly observe: () => boolean; readonly close: () => boolean }
const module = { exports: {} as unknown };
process.dlopen(module, "/proc/self/fd/6");
const exports: unknown = module.exports;
assert.ok(exports && typeof exports === "object" && "observe" in exports && typeof exports.observe === "function" && "close" in exports && typeof exports.close === "function");
const observe = exports.observe, close = exports.close;
const original: InternalOwner = Object.freeze({
  observe: () => Reflect.apply(observe, exports, []) === true,
  close: () => Reflect.apply(close, exports, []) === true,
});
assert.equal(original.observe(), true);
const status = readFileSync("/proc/self/status", "utf8");
const field = (name: string): string => { const match = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status); assert.ok(match); return match[1]!.trim(); };
assert.equal(field("Uid"), "65532\t65532\t65532\t65532");
assert.equal(field("Gid"), "65532\t65532\t65532\t65532");
for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.equal(field(name), "0000000000000000");
assert.equal(field("NoNewPrivs"), "1"); assert.equal(field("Seccomp"), "2");
// Real libuv work after the original TSYNC seal. The existing v1 contracts
// separately cover preexisting/fresh Node workers and every filter refusal.
const key: unknown = await promisify(scrypt)("original-owned-fixture", "sealed", 16);
assert.ok(Buffer.isBuffer(key) && key.length === 16);
assert.equal(original.observe(), true);
process.stdout.write(JSON.stringify({ stage: "helper", uid: process.getuid!(), gid: process.getgid!(), cap0: true, nnp: true, threads: readdirSync("/proc/self/task").length, libuvAfterSeal: true }) + "\n");
// This endpoint belongs to the original Source lifetime. Its natural EOF
// permits environment teardown; the native cleanup hook closes admission and
// parent-held kernel objects outlive this environment.
const heartbeat = setInterval(() => {
  if (!original.observe()) { clearInterval(heartbeat); process.stdin.destroy(); }
}, 1000);
try {
  await new Promise<void>((accept, reject) => {
    process.stdin.once("end", accept); process.stdin.once("close", accept); process.stdin.once("error", reject);
    process.stdin.on("data", () => { /* input bytes carry no native authority */ });
    process.stdin.resume();
  });
} finally { clearInterval(heartbeat); }
