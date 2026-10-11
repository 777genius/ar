#!/usr/bin/env -S /opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node --experimental-strip-types
/** Synthetic protocol only. No auth reads, network imports, refresh/login/exec
 * modes, or production-provider acceptance. Kernel/filesystem probe is real. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { openSync, closeSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

assert(process.argv.slice(2).includes("app-server"), "TEST provider refuses non app-server mode");
const config = JSON.parse(readFileSync("/opt/subscription-runtime-dependency-os-TEST/codex/TEST-probe.json", "utf8")) as {
  scenario?: "readonly"; failSecondReadonlyTurn?: true; inputSha256?: string; workspace: string; guestNamespaces: Record<"user" | "mnt" | "pid", string> };
const workspace = config.workspace;
if (config.scenario === "readonly") assert.match(workspace, /^\/mnt\/TEST-retention-readonly-storage\/jobs\/TEST-readonly-[a-f0-9-]{36}\/workspace$/);
else assert.match(workspace, /^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-os-[a-f0-9-]{36}\/workspace$/);
assert.equal(process.cwd(), process.env.HOME);
assert(process.cwd().startsWith(workspace.slice(0, -"/workspace".length) + "/home/"));
let objective = "TEST dependency read", complete = false, initialized = false, started = false, turned = false;
const threadId = "TEST-thread", turnId = "TEST-turn";
function send(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
function probe(): boolean {
  const ids = { uid: process.getuid!(), euid: process.geteuid!(), gid: process.getgid!(), egid: process.getegid!() };
  assert.deepEqual(ids, { uid: 65532, euid: 65532, gid: 65532, egid: 65532 });
  const status = readFileSync("/proc/self/status", "utf8");
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.match(status, new RegExp(`^${name}:\\s+0+$`, "m"));
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.match(status, /^Groups:\s*$/m);
  const uidMap = readFileSync("/proc/self/uid_map", "utf8").trim(), gidMap = readFileSync("/proc/self/gid_map", "utf8").trim();
  assert.match(uidMap, /^65532\s+0\s+1$/); assert.match(gidMap, /^65532\s+0\s+1$/);
  const namespaces = { user: readlinkSync("/proc/self/ns/user"), mnt: readlinkSync("/proc/self/ns/mnt"), pid: readlinkSync("/proc/self/ns/pid") };
  for (const kind of ["user", "mnt", "pid"] as const) {
    assert.match(config.guestNamespaces[kind], new RegExp(`^${kind}:\\[\\d+\\]$`));
    assert.match(namespaces[kind], new RegExp(`^${kind}:\\[\\d+\\]$`));
    assert.notEqual(namespaces[kind], config.guestNamespaces[kind], `TEST actual ${kind} namespace isolation required`);
  }
  if (config.scenario === "readonly") {
    assert.equal(config.failSecondReadonlyTurn, true);
    const count = readdirSync(workspace).filter(name => /^TEST-readonly(?:-failed)?-probe\.json$/.test(name)).length;
    assert(count === 0 || count === 1, "TEST readonly provider refuses another turn");
    const input = workspace + "/reviewed/input.txt";
    assert.equal(createHash("sha256").update(readFileSync(input)).digest("hex"), config.inputSha256);
    assert.throws(() => { const fd = openSync(input, "a"); closeSync(fd); },
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EROFS");
    for (const path of ["/run/dbus/system_bus_socket", "/run/systemd/private", "/var/lib/subscription-runtime-host-policy/host-installation.json"])
      assert.throws(() => readFileSync(path), (error: unknown) => ["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""));
    writeFileSync(workspace + (count === 0 ? "/TEST-readonly-probe.json" : "/TEST-readonly-failed-probe.json"), JSON.stringify({ schemaVersion: 1, result: "actual_readonly_mount_and_bus_denial_passed",
      ids, uidMap, gidMap, namespaces, noNewPrivs: 1, capabilities: "zero" }) + "\n", { flag: "wx", mode: 0o600 });
    // TEST protocol data only. The real CLI decides its result and exit code;
    // this fixture never writes an envelope, receipt or foreground result.
    return count === 1;
  }
  const require = createRequire(workspace + "/package.json");
  assert.equal((require("is-number") as (value: unknown) => boolean)(42), true);
  for (const path of [workspace.slice(0, -"/workspace".length) + "/key-sentinel",
    workspace.slice(0, -"/workspace".length) + "/state-sentinel", workspace.slice(0, -"/workspace".length) + "/output-sentinel",
    workspace.slice(0, -"/workspace".length) + "/encryption-key.hex",
    "/var/lib/subscription-runtime-host-policy/privileged-sibling-sentinel", "/root", "/home/runner",
    "/run/dbus/system_bus_socket", "/run/systemd/private"])
    assert.throws(() => readFileSync(path), (e: unknown) => ["ENOENT", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? ""));
  assert.throws(() => { const fd = openSync(workspace + "/.git/config", "a"); closeSync(fd); },
    (e: unknown) => ["EROFS", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? ""));
  const count = readdirSync(workspace).filter(name => /^TEST-provider-probe-[123]\.json$/.test(name)).length;
  assert(count < 3);
  writeFileSync(workspace + `/TEST-provider-probe-${count + 1}.json`, JSON.stringify({ schemaVersion: 1,
    result: "dependency_read_and_actual_enclosure_denial_passed", ids, uidMap, gidMap, namespaces, noNewPrivs: 1, capabilities: "zero" }) + "\n", { flag: "wx", mode: 0o600 });
  return false;
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requests = 0;
lines.on("line", line => {
  try {
    assert(++requests <= 32 && Buffer.byteLength(line) <= 1024 * 1024);
    const request = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (request.method === "initialized") { assert(initialized && request.id === undefined); return; }
    assert(typeof request.id === "number");
    let result: unknown;
    switch (request.method) {
      case "initialize": assert(!initialized); initialized = true; result = { userAgent: "TEST-synthetic-provider" }; break;
      case "account/rateLimits/read": assert(initialized); result = { rateLimits: { primary: null, secondary: null } }; break;
      case "thread/start": case "thread/resume": assert(initialized && !started);
        if (request.method === "thread/start") assert.equal(request.params?.cwd, workspace);
        started = true; result = { thread: { id: threadId } }; break;
      case "thread/goal/set": assert(started); assert(typeof request.params?.objective === "string"); objective = request.params.objective;
        result = { goal: { threadId, objective, status: "active" } }; break;
      case "thread/goal/get": assert(started); result = { goal: { threadId, objective, status: complete ? "complete" : "active" } }; break;
      case "turn/start": {
        assert(started && !turned); turned = true; const failed = probe(); complete = !failed;
        send({ id: request.id, result: { turn: { id: turnId } } });
        send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
        if (failed) {
          send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed",
            error: { message: "TEST declared terminal failure after actual readonly probe", codexErrorInfo: "other" } } } });
          return;
        }
        send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", text: JSON.stringify({ outcome: "done",
          evidence: ["actual dependency read and enclosure probe completed"], blockers: [], nextActionHint: "", summary: "Synthetic TEST probe passed" }) } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } }); return;
      }
      default: throw new Error("TEST unsupported protocol mode");
    }
    send({ id: request.id, result });
  } catch { process.stderr.write("TEST_provider_protocol_or_probe_failed\n"); process.exit(70); }
});
lines.once("close", () => process.exit(0));
setTimeout(() => { process.stderr.write("TEST_provider_deadline\n"); process.exit(70); }, 90000).unref();
