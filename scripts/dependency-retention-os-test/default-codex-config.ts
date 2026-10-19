/** Fixed TEST expectation/publication only, never model availability, authority,
 * current home/use, production argument-file auth or a provider receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, readlinkSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";
const runtime = "/opt/subscription-runtime-dependency-os-TEST";
const packageRoot = runtime + "/toolchain/lib/node_modules/codex";
const requestedModel = "gpt-6.1-sol" as const; // Owner-selected TEST request, not availability.
const requestSha256 = "8195cddffe837e20239f7f12b531f1799d4ba80bf238e37685137e9c98a93ce4";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("TEST_default_model_expectation_missing_or_invalid"); }
export function parseDefaultTestRequestedModel(bytes: Uint8Array): typeof requestedModel {
  if (bytes.byteLength < 1 || bytes.byteLength > 512 || hash(bytes) !== requestSha256) invalid();
  return requestedModel;
}
function protectedDirectory(path: string): void {
  const stat = lstatSync(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022));
  assert.equal(realpathSync(path), path);
}
function sameFile(before: Stats, after: Stats): void {
  assert(after.isFile() && !after.isSymbolicLink());
  for (const key of ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeMs", "ctimeMs"] as const)
    assert.equal(after[key], before[key]);
}
function fixedFileBytes(path: string, maximum: number): Buffer {
  for (let ancestor = dirname(path);; ancestor = dirname(ancestor)) { protectedDirectory(ancestor); if (ancestor === "/") break; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd); assert(before.isFile() && before.uid === 0 && before.gid === 0 && before.nlink === 1 && !(before.mode & 0o022));
    assert(before.size > 0 && before.size <= maximum); sameFile(before,lstatSync(path));
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd,bytes,length,bytes.length-length,length); if (!count) break; length += count; }
    assert.equal(length,before.size); sameFile(before,fstatSync(fd)); sameFile(before,lstatSync(path));
    return bytes.subarray(0,length);
  } finally { closeSync(fd); }
}
/** Only empty guest prefix or the existing fresh owned extraction is supported.
 * This fixed TEST input file is distinct from the pending real R2 args handoff. */
export function readDefaultTestRequestedModel(rootPrefix = ""): typeof requestedModel {
  try {
    // Keep this shared guest module self-contained: guest artifacts omit the
    // host-only native launcher helper. Accept only its exact fixed FULL root.
    assert(rootPrefix === "" ||
      /^\/var\/lib\/subscription-runtime-os-TEST\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/root$/.test(rootPrefix) ||
      /^\/srv\/workers\/jobs\/TEST-dependency-full-positive-scoped-20261014-r1\/os-TEST\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/root$/.test(rootPrefix) ||
      /^\/srv\/workers\/jobs\/TEST-dependency-full-h1-signed-distro-20261016-r1\/os-TEST\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/root$/.test(rootPrefix));
    return parseDefaultTestRequestedModel(fixedFileBytes(rootPrefix + runtime + "/scripts/dependency-retention-os-test/default-codex-requested-model.json",512));
  } catch { return invalid(); }
}
function freshConfig(name: "TEST-probe.json" | "TEST-refresh-probe.json", value: unknown): string {
  protectedDirectory(packageRoot);
  const path = packageRoot + "/" + name, bytes = Buffer.from(JSON.stringify(value)+"\n");
  assert(bytes.length > 0 && bytes.length <= 4096);
  const fd = openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);
  try { fchmodSync(fd,0o644); writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(packageRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  const reread = fixedFileBytes(path,4096); assert(reread.equals(bytes)); return hash(reread);
}
type NamespaceFacts = Readonly<Record<"user" | "mnt" | "pid", string>>;
type TestProbeInput = { readonly workspace: string; readonly guestNamespaces: NamespaceFacts } &
  ({ readonly scenario?: undefined } | { readonly scenario: "readonly"; readonly failSecondReadonlyTurn: true; readonly inputSha256: string });
function catalogModulePin(): string {
  const recordPath = packageRoot + "/TEST-catalog-module.json", modulePath = packageRoot + "/bin/default-codex-catalog-protocol.js";
  assert.equal(lstatSync(recordPath).mode & 0o7777,0o444); assert.equal(lstatSync(modulePath).mode & 0o7777,0o555);
  const text = fixedFileBytes(recordPath,4096).toString("utf8"), raw: unknown = JSON.parse(text);
  assert(raw && typeof raw === "object" && !Array.isArray(raw));
  const pin = raw as {schemaVersion?:unknown;kind?:unknown;sourceSha256?:unknown;moduleSha256?:unknown};
  assert.deepEqual(Object.keys(pin),["schemaVersion","kind","sourceSha256","moduleSha256"]);
  assert.equal(pin.schemaVersion,1); assert.equal(pin.kind,"TEST_compiled_catalog_closure");
  assert.equal(pin.sourceSha256,"41c102229b801eb6d8f5fea546c9dd3c169711718617dc66a6d58162a69523f9");
  assert(typeof pin.moduleSha256 === "string" && /^[a-f0-9]{64}$/.test(pin.moduleSha256));
  assert.equal(text,JSON.stringify(pin)+"\n");
  assert.equal(hash(fixedFileBytes(modulePath,32768)),pin.moduleSha256); return pin.moduleSha256;
}
/** Actual owned guest observation, never a home/use/executable grant. */
function canonicalDefaultAliasPin(): string {
  const alias = "/usr/local/bin/codex", executable = packageRoot + "/bin/provider.ts";
  const target = "../../../opt/subscription-runtime-dependency-os-TEST/toolchain/lib/node_modules/codex/bin/provider.ts";
  for (const path of ["/", "/usr", "/usr/local", "/usr/local/bin"]) protectedDirectory(path);
  const parents: {path:string;fd:number;stat:Stats}[] = [];
  try {
    for (const path of ["/", "/usr", "/usr/local", "/usr/local/bin"]) {
      const fd = openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd), named = lstatSync(path);
        assert(stat.isDirectory() && named.isDirectory() && !named.isSymbolicLink());
        for (const key of ["dev","ino","uid","gid","mode"] as const) assert.equal(stat[key],named[key]);
        parents.push({path,fd,stat});
      } catch (error) { closeSync(fd); throw error; }
    }
    const before = lstatSync(alias);
    assert(before.isSymbolicLink() && before.uid === 0 && before.gid === 0 && before.nlink === 1);
    assert.equal(readlinkSync(alias),target); assert.equal(realpathSync(alias),executable);
    const providerSha256 = "feaddc5dae05eb99b536c17cbce97b46b10e2d6bd6a61e3bf62b47529034474f";
    assert.equal(lstatSync(executable).mode & 0o7777,0o555);
    assert.equal(hash(fixedFileBytes(executable,32768)),providerSha256);
    const recordPath = packageRoot + "/TEST-default-alias.json";
    assert.equal(lstatSync(recordPath).mode & 0o7777,0o444);
    const record = fixedFileBytes(recordPath,4096);
    assert.equal(record.toString("utf8"),JSON.stringify({schemaVersion:1,kind:"TEST_canonical_default_alias",
      alias,target,executable,providerSha256})+"\n");
    const after = lstatSync(alias);
    for (const key of ["dev","ino","uid","gid","mode","nlink","size","mtimeMs","ctimeMs"] as const)
      assert.equal(after[key],before[key]);
    assert.equal(readlinkSync(alias),target); assert.equal(realpathSync(alias),executable);
    for (const path of ["/", "/usr", "/usr/local", "/usr/local/bin"]) protectedDirectory(path);
    for (const parent of parents) {
      protectedDirectory(parent.path);
      for (const current of [fstatSync(parent.fd),lstatSync(parent.path)]) {
        assert(current.isDirectory() && !current.isSymbolicLink());
        for (const key of ["dev","ino","uid","gid","mode"] as const) assert.equal(current[key],parent.stat[key]);
      }
    }
    return hash(record);
  } finally {
    let failure: unknown;
    for (const parent of parents.reverse()) {
      try { closeSync(parent.fd); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
}
/** Guest calls before artifact digest/profile/install. Planned workspace is
 * DATA; no job directory, opaque home, owner/preclaim/grant or args permit exists
 * by this publication. Actual namespaces are independently read back here. */
export function publishDefaultTestCodexConfig(input: TestProbeInput) {
  assert.equal(process.getuid!(),0); assert.equal(process.geteuid!(),0);
  const model = readDefaultTestRequestedModel(), catalogHelperSha256 = catalogModulePin(), uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const ordinary = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-os-";
  const readonly = "/mnt/TEST-retention-readonly-storage/jobs/TEST-readonly-";
  assert(new RegExp(`^${input.scenario === "readonly" ? readonly : ordinary}${uuid}/workspace$`).test(input.workspace));
  for (const kind of ["user","mnt","pid"] as const) assert.equal(input.guestNamespaces[kind],readlinkSync("/proc/self/ns/"+kind));
  const probe = input.scenario === "readonly" ? {scenario:"readonly",failSecondReadonlyTurn:true,
    workspace:input.workspace,guestNamespaces:input.guestNamespaces,inputSha256:input.inputSha256} :
    {workspace:input.workspace,guestNamespaces:input.guestNamespaces};
  if (input.scenario === "readonly") assert.match(input.inputSha256,/^[a-f0-9]{64}$/);
  const defaultAliasSha256 = canonicalDefaultAliasPin();
  const probeSha256 = freshConfig("TEST-probe.json",probe);
  const refreshSha256 = freshConfig("TEST-refresh-probe.json",{schemaVersion:1,kind:"TEST_synthetic_refresh_protocol",model});
  return Object.freeze({requestedModel:model,defaultAliasSha256,probeSha256,refreshSha256,catalogHelperSha256,catalogProof:"none",homeOrUseProof:"none"} as const);
}
