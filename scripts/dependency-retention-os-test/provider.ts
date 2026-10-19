#!/usr/bin/env -S /opt/subscription-runtime-dependency-os-TEST/toolchain/bin/node --experimental-strip-types
/** Synthetic protocols only. No auth reads, network imports or production-provider
 * acceptance. Legacy app-server probe and new finite exec observation are separate. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, readSync, openSync, closeSync, readFileSync, readlinkSync, realpathSync, readdirSync, writeFileSync, type Stats } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { createTestCatalogProtocol } from "./default-codex-catalog-protocol.ts";

const defaultTestPackage = "/opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/codex";
const defaultTestAlias = "/opt/subscription-runtime-dependency-os-TEST/toolchain/bin/codex";
const defaultTestTarget = defaultTestPackage + "/bin/provider.ts";
function actualDefaultTestExecutable(): boolean {
  // argv preserves the entry alias; ESM's main identity resolves separately.
  // Only these two literal paths are eligible, never any path resolving here.
  if (process.argv[1] !== defaultTestAlias && process.argv[1] !== defaultTestTarget) return false;
  assert.equal(fileURLToPath(import.meta.url), defaultTestTarget);
  const viaAlias = process.argv[1] === defaultTestAlias;
  const directories = [defaultTestPackage + "/bin", ...(viaAlias ? ["/opt/subscription-runtime-dependency-os-TEST/toolchain/bin"] : [])];
  for (const start of directories) {
    for (let path = start;; path = path.slice(0, path.lastIndexOf("/")) || "/") {
      const stat = lstatSync(path);
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 65532 && stat.gid === 65532 && !(stat.mode & 0o022));
      assert.equal(realpathSync(path), path);
      if (path === "/") break;
    }
  }
  const target = "../lib/node_modules/codex/bin/provider.ts";
  const link = viaAlias ? lstatSync(defaultTestAlias) : undefined;
  if (link) {
    assert(link.isSymbolicLink() && link.uid === 65532 && link.gid === 65532 && link.nlink === 1);
    assert.equal(readlinkSync(defaultTestAlias), target);
    assert.equal(realpathSync(defaultTestAlias), defaultTestTarget);
  }
  assert.equal(realpathSync(defaultTestTarget), defaultTestTarget);
  const before = lstatSync(defaultTestTarget);
  assert(before.isFile() && !before.isSymbolicLink() && before.uid === 65532 && before.gid === 65532 && before.nlink === 1);
  assert.equal(before.mode & 0o7777, 0o555); assert(before.size > 0 && before.size <= 32768);
  const fd = openSync(defaultTestTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    for (const current of [fstatSync(fd), lstatSync(defaultTestTarget)]) {
      assert(current.isFile() && !current.isSymbolicLink());
      for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const)
        assert.equal(current[key], before[key]);
    }
    if (link) {
      const after = lstatSync(defaultTestAlias);
      assert(after.isSymbolicLink());
      for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const)
        assert.equal(after[key], link[key]);
      assert.equal(readlinkSync(defaultTestAlias), target);
      assert.equal(realpathSync(defaultTestAlias), defaultTestTarget);
    }
    // Genuine FDA frames may normalize the command to this literal target;
    // that finite child root need not mount the outer default alias directory.
  } finally { closeSync(fd); }
  return true;
}
let defaultTestExecutable: boolean;
try { defaultTestExecutable = actualDefaultTestExecutable(); }
catch { process.stderr.write("TEST_default_executable_identity_failed\n"); process.exit(71); }

/** Literal finite package files only; no caller pathname or fallback. The
 * fixed executable startup already joins readonly package/bin ancestors. */
function readDefaultTestPackageFile(name: "TEST-refresh-probe.json" | "TEST-catalog-module.json" | "bin/default-codex-catalog-protocol.js"): string {
  const configPath = defaultTestPackage + "/" + name;
  const fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let configText: string;
  try {
    const before = fstatSync(fd);
    assert(before.isFile() && before.uid === 65532 && before.gid === 65532 && before.nlink === 1 && !(before.mode & 0o022));
    if (name === "bin/default-codex-catalog-protocol.js") assert.equal(before.mode & 0o7777, 0o555);
    if (name === "TEST-catalog-module.json") assert.equal(before.mode & 0o7777, 0o444);
    assert(before.size > 0 && before.size <= (name === "bin/default-codex-catalog-protocol.js" ? 32768 : 4096));
    const data = Buffer.alloc(before.size + 1); let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, length);
      if (!count) break; length += count;
    }
    assert.equal(length, before.size);
    const after = fstatSync(fd), named = lstatSync(configPath);
    for (const current of [after, named]) {
      assert(current.isFile() && !current.isSymbolicLink());
      for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const)
        assert.equal(current[key], before[key]);
    }
    configText = new TextDecoder("utf-8", {fatal: true}).decode(data.subarray(0, length));
  } finally { closeSync(fd); }
  return configText;
}

// This branch is a finite synthetic protocol observation only. It never reads
// auth, refreshes credentials, writes authority or reconstructs current origin.
async function fixedTestRefreshProtocol(): Promise<void> {
  const runtime = "/opt/subscription-runtime-dependency-os-TEST";
  assert.equal(defaultTestExecutable, true);
  const home = process.env.HOME, codexHome = process.env.CODEX_HOME;
  assert(typeof home === "string" && typeof codexHome === "string");
  const ordinaryRoot = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-os-";
  const readonlyRoot = "/mnt/TEST-retention-readonly-storage/jobs/TEST-readonly-";
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  assert(new RegExp(`^(?:${ordinaryRoot}|${readonlyRoot})${uuid}/home/codex-session-cache/dependency-${uuid}/home$`).test(home));
  const sessionRoot = home.slice(0, -"/home".length), empty = sessionRoot + "/empty-workdir";
  assert.equal(codexHome, sessionRoot + "/codex-home");
  assert.equal(process.cwd(), empty);
  assert.equal(process.env.REVIEWROUTER_CODEX_AUTH_PATH, codexHome + "/auth.json");
  assert.equal(process.env.CI, "1");
  assert.equal(process.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND, "hosted-codex-job");
  // Finite expected TEST data is published before artifact digest. Matching it
  // attests exact protocol bytes only, not active-account catalog availability.
  const configText = readDefaultTestPackageFile("TEST-refresh-probe.json");
  const expected: unknown = JSON.parse(configText);
  assert(expected !== null && typeof expected === "object" && !Array.isArray(expected));
  const config = expected as {schemaVersion?: unknown; kind?: unknown; model?: unknown};
  assert.deepEqual(Object.keys(config), ["schemaVersion", "kind", "model"]);
  assert.equal(config.schemaVersion, 1); assert.equal(config.kind, "TEST_synthetic_refresh_protocol");
  assert(typeof config.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(config.model));
  assert.equal(configText, JSON.stringify(config) + "\n"); // Duplicate keys/noncanonical input refuse.
  // Independent finite ProviderApi grammar; exact model comes only from this
  // inventoried TEST expectation, never a runner/consumer argument or fallback.
  assert.deepEqual(process.argv.slice(2), ["exec", "--model", config.model,
    "--config", "sandbox_workspace_write.network_access=true",
    "--config", "features.network_proxy.enabled=true",
    "--config", 'features.network_proxy.domains={ "api.openai.com" = "allow" }',
    "--sandbox", "read-only", "--ignore-rules", "--ephemeral", "-C", empty,
    "--skip-git-repo-check", "-"]);
  const prompt = Buffer.from("Respond with OK only.", "utf8");
  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0;
    const deadline = setTimeout(() => reject(new Error("TEST fixed stdin deadline")), 5000);
    process.stdin.once("error", reject);
    process.stdin.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > prompt.length) { reject(new Error("TEST fixed stdin bound")); return; }
      chunks.push(chunk);
    });
    process.stdin.once("end", () => {
      clearTimeout(deadline);
      if (!Buffer.concat(chunks, bytes).equals(prompt)) { reject(new Error("TEST fixed stdin mismatch")); return; }
      resolve();
    });
  });
  // No paths, argv contents, auth or arbitrary errors escape. These are factual
  // protocol observations only, never a provider completion/lease receipt.
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "TEST_synthetic_exec_protocol",
    argv: "fixed_refresh_v1", model: "exact_TEST_expectation_match", catalogProof: "none", argumentCount: 17, home: "fixed_TEST_session_home",
    codexHome: "same_TEST_session_root", cwd: "fixed_empty_workdir", stdin: "fixed_OK_prompt",
    authIO: "none", authority: "none" }) + "\n");
}
if (process.argv[2] === "exec") {
  try { await fixedTestRefreshProtocol(); process.exit(0); }
  catch { process.stderr.write("TEST_fixed_refresh_protocol_failed\n"); process.exit(72); }
}

/** Synthetic catalog protocol on the real default package, never an account
 * identity/availability grant. Historical task branch remains below unchanged. */
async function fixedTestCatalogProtocol(): Promise<void> {
  assert.equal(defaultTestExecutable, true);
  const home = process.env.HOME, codexHome = process.env.CODEX_HOME;
  assert(typeof home === "string" && typeof codexHome === "string");
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  assert(new RegExp(`^(?:/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-os-|/mnt/TEST-retention-readonly-storage/jobs/TEST-readonly-)${uuid}/home/codex-session-cache/dependency-${uuid}/home$`).test(home));
  const root = home.slice(0, -"/home".length);
  assert.equal(codexHome, root + "/codex-home"); assert.equal(process.cwd(), root + "/empty-workdir");
  assert.equal(process.env.CI, "1"); assert.equal(process.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND, "hosted-codex-job");
  assert.equal(process.env.REVIEWROUTER_CODEX_AUTH_PATH, undefined);
  assert.deepEqual(process.argv.slice(2), ["--dangerously-bypass-hook-trust", "app-server", "--listen", "stdio://"]);
  const pinText = readDefaultTestPackageFile("TEST-catalog-module.json"), pin: unknown = JSON.parse(pinText);
  assert(pin && typeof pin === "object" && !Array.isArray(pin));
  const record = pin as {schemaVersion?: unknown; kind?: unknown; sourceSha256?: unknown; moduleSha256?: unknown};
  assert.deepEqual(Object.keys(record), ["schemaVersion", "kind", "sourceSha256", "moduleSha256"]);
  assert.equal(record.schemaVersion, 1); assert.equal(record.kind, "TEST_compiled_catalog_closure");
  assert.equal(record.sourceSha256, "41c102229b801eb6d8f5fea546c9dd3c169711718617dc66a6d58162a69523f9");
  assert(typeof record.moduleSha256 === "string" && /^[a-f0-9]{64}$/.test(record.moduleSha256));
  assert.equal(pinText, JSON.stringify(record) + "\n");
  const modulePath = defaultTestPackage + "/bin/default-codex-catalog-protocol.js";
  assert.equal(realpathSync(modulePath), modulePath);
  const moduleAncestors: {path:string; stat:Stats}[] = [];
  for (let path = defaultTestPackage + "/bin";; path = path.slice(0,path.lastIndexOf("/")) || "/") {
    const stat = lstatSync(path); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 65532 && stat.gid === 65532 && !(stat.mode & 0o022));
    assert.equal(realpathSync(path),path); moduleAncestors.push({path,stat}); if (path === "/") break;
  }
  const moduleStat = lstatSync(modulePath), moduleText = readDefaultTestPackageFile("bin/default-codex-catalog-protocol.js");
  assert.equal(createHash("sha256").update(moduleText).digest("hex"), record.moduleSha256);
  const loaded = await import(pathToFileURL(modulePath).href) as {createTestCatalogProtocol?: typeof createTestCatalogProtocol};
  const after = lstatSync(modulePath);
  for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const)
    assert.equal(after[key], moduleStat[key]);
  for (const parent of moduleAncestors) {
    const current = lstatSync(parent.path); assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(realpathSync(parent.path),parent.path);
    for (const key of ["dev","ino","uid","gid","mode"] as const) assert.equal(current[key],parent.stat[key]);
  }
  assert.equal(readDefaultTestPackageFile("bin/default-codex-catalog-protocol.js"), moduleText);
  assert.equal(readDefaultTestPackageFile("TEST-catalog-module.json"), pinText);
  assert.equal(typeof loaded.createTestCatalogProtocol, "function");
  const protocol = loaded.createTestCatalogProtocol!(Buffer.from(readDefaultTestPackageFile("TEST-refresh-probe.json")));
  await new Promise<void>((resolve, reject) => {
    let buffer = "", bytes = 0;
    const deadline = setTimeout(() => reject(new Error("TEST_catalog_protocol_refused")), 30000);
    const done = (): void => { try { assert.equal(buffer, ""); protocol.finish(); clearTimeout(deadline); resolve(); } catch { reject(new Error("TEST_catalog_protocol_refused")); } };
    process.once("SIGTERM", done); process.stdin.once("error", reject);
    process.stdin.on("data", (chunk: Buffer) => {
      try {
        assert(Buffer.isBuffer(chunk)); bytes += chunk.length; assert(bytes <= 16384);
        buffer += new TextDecoder("utf-8", {fatal:true}).decode(chunk);
        assert(Buffer.byteLength(buffer) <= 16384);
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end+1);
          const reply = protocol.receive(line); if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
        }
        assert(Buffer.byteLength(buffer) <= 4096);
      } catch { reject(new Error("TEST_catalog_protocol_refused")); }
    });
    process.stdin.once("end", done);
  });
}
if (defaultTestExecutable && process.cwd() !== process.env.HOME) {
  try { await fixedTestCatalogProtocol(); process.exit(0); }
  catch { process.stderr.write("TEST_catalog_protocol_refused\n"); process.exit(73); }
}

assert(process.argv.slice(2).includes("app-server"), "TEST provider refuses non app-server mode");
// The default package has its own pre-issuance, inventoried TEST configuration.
// Historical explicitly selected provider keeps its original path and behavior.
const providerConfig = defaultTestExecutable
  ? defaultTestPackage + "/TEST-probe.json" : "/opt/subscription-runtime-dependency-os-TEST/codex/TEST-probe.json";
const config = JSON.parse(readFileSync(providerConfig, "utf8")) as {
  scenario?: "readonly"; failSecondReadonlyTurn?: true; inputSha256?: string; workspace: string; guestNamespaces: Record<"user" | "mnt" | "pid", string> };
const workspace = config.workspace;
if (config.scenario === "readonly") assert.match(workspace, /^\/mnt\/TEST-retention-readonly-storage\/jobs\/TEST-readonly-[a-f0-9-]{36}\/workspace$/);
else assert.match(workspace, /^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-os-[a-f0-9-]{36}\/workspace$/);
assert.equal(process.cwd(), process.env.HOME);
assert(process.cwd().startsWith(workspace.slice(0, -"/workspace".length) + "/home/"));
let objective = "TEST dependency read", complete = false, initialized = false, started = false, turned = false;
const threadId = "TEST-thread", turnId = "TEST-turn";
function send(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
// Closed per-site exit codes are the only diagnostic channel that survives as exited:NN (71 identity, 72 refresh, 73 catalog, 74 protocol, 75 deadline, 80-84 probe groups).
let probeFailureCode = 80;
function probe(): boolean {
  probeFailureCode = 80;
  const ids = { uid: process.getuid!(), euid: process.geteuid!(), gid: process.getgid!(), egid: process.getegid!() };
  assert.deepEqual(ids, { uid: 65532, euid: 65532, gid: 65532, egid: 65532 });
  const status = readFileSync("/proc/self/status", "utf8");
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.match(status, new RegExp(`^${name}:\\s+0+$`, "m"));
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.match(status, /^Groups:\s*$/m);
  const uidMap = readFileSync("/proc/self/uid_map", "utf8").trim(), gidMap = readFileSync("/proc/self/gid_map", "utf8").trim();
  assert.match(uidMap, /^65532\s+0\s+1$/); assert.match(gidMap, /^65532\s+0\s+1$/);
  probeFailureCode = 81;
  const namespaces = { user: readlinkSync("/proc/self/ns/user"), mnt: readlinkSync("/proc/self/ns/mnt"), pid: readlinkSync("/proc/self/ns/pid") };
  for (const kind of ["user", "mnt", "pid"] as const) {
    assert.match(config.guestNamespaces[kind], new RegExp(`^${kind}:\\[\\d+\\]$`));
    assert.match(namespaces[kind], new RegExp(`^${kind}:\\[\\d+\\]$`));
    assert.notEqual(namespaces[kind], config.guestNamespaces[kind], `TEST actual ${kind} namespace isolation required`);
  }
  if (config.scenario === "readonly") {
    probeFailureCode = 82;
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
  probeFailureCode = 83;
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
  probeFailureCode = 84;
  const count = readdirSync(workspace).filter(name => /^TEST-provider-probe-[1234]\.json$/.test(name)).length;
  assert(count < 4);
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
        assert(started && !turned); turned = true;
        let failed: boolean;
        try { failed = probe(); }
        catch { process.stderr.write("TEST_provider_protocol_or_probe_failed\n"); process.exit(probeFailureCode); }
        complete = !failed;
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
  } catch { process.stderr.write("TEST_provider_protocol_or_probe_failed\n"); process.exit(74); }
});
lines.once("close", () => process.exit(0));
setTimeout(() => { process.stderr.write("TEST_provider_deadline\n"); process.exit(75); }, 90000).unref();
