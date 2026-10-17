import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostedManifestLimitsRevision as Revision, HostedManifestPlacementFailure as Failure,
  issueFreshHostedManifestPlacement as issue, openHostedDependencyManifestPlacement as open } from "../hosted-dependency-manifest-placement";
import * as privateInputs from "../../provider-codex/app-server/adapters/hosted-private-physical-inputs";
import { DependencyManifestStorageFailure as BlobFailure, LocalDependencyManifestBlobStore } from "../../store-local-file/dependency-environment/local-dependency-manifest-blob-store";

// Actual private TEST files and retained descriptors; only the initial host
// namespace/operator/kernel inventory facts are synthetic, as in installation
// composition tests. These tests do not certify real host admission or mounts.
const fixture = vi.hoisted(() => ({ root: "", boot: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", blocked: false, mountAlias: "", fence: Object.freeze({ held: true as const }), inventory: {} as unknown }));
const policyRoot = "/var/lib/subscription-runtime-host-policy", scratch = "/mnt/TEST-private-scratch";
function local(path: string): string {
  if (path === scratch || path.startsWith(scratch + "/")) return join(fixture.root, "scratch", path.slice(scratch.length));
  if (path === policyRoot || path.startsWith(policyRoot + "/")) return join(fixture.root, "policy", path.slice(policyRoot.length));
  const volatile = "/run/user/0/subscription-runtime-host-policy";
  if (path === volatile || path.startsWith(volatile + "/")) return join(fixture.root, "volatile", path.slice(volatile.length));
  if (["/", "/mnt", "/var", "/var/lib", "/run", "/run/user", "/run/user/0"].includes(path)) return fixture.root;
  return path;
}
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: string, options?: { bigint?: boolean }) => Object.assign(real.lstatSync(local(path), options as { bigint: true }), { uid: options?.bigint ? 0n : 0 }),
    fstatSync: (fd: number, options?: { bigint?: boolean }) => Object.assign(real.fstatSync(fd, options as { bigint: true }), { uid: options?.bigint ? 0n : 0 }),
    realpathSync: (path: string) => { const mapped = local(path), actual = real.realpathSync(mapped); return mapped === actual ? path : actual; },
    readFileSync: (path: string | number, options?: Parameters<typeof real.readFileSync>[1]) => {
      if (path === "/proc/sys/kernel/random/boot_id") return fixture.boot + "\n";
      if (path === "/proc/self/mountinfo") {
        // Namespace facts are synthetic in this fixture. Join its actual
        // scratch filesystem/mount ID without importing unrelated Host mounts.
        const fd = real.openSync(fixture.root, real.constants.O_RDONLY | real.constants.O_DIRECTORY | real.constants.O_NOFOLLOW);
        try {
          const id = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(real.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
          if (!id) throw new Error("TEST mount identity unavailable");
          const dev = BigInt(real.fstatSync(fd).dev);
          const major = (dev >> 8n & 0xfffn) | (dev >> 32n & 0xfffff000n);
          const minor = (dev & 0xffn) | (dev >> 12n & 0xffffff00n);
          const bytes = Buffer.from(`${id} 0 ${major}:${minor} / / rw - ext4 /dev/TEST rw\n` + fixture.mountAlias);
          const encoding = typeof options === "string" ? options : options?.encoding;
          return encoding ? bytes.toString(encoding) : bytes;
        } finally { real.closeSync(fd); }
      }
      return real.readFileSync(typeof path === "string" ? local(path) : path, options);
    },
    openSync: (path: string, flags: number, mode?: number) => real.openSync(local(path), flags, mode),
    mkdirSync: (path: string, options?: Parameters<typeof real.mkdirSync>[1]) => real.mkdirSync(local(path), options),
    writeFileSync: (path: string | number, data: Parameters<typeof real.writeFileSync>[1], options?: Parameters<typeof real.writeFileSync>[2]) =>
      real.writeFileSync(typeof path === "string" ? local(path) : path, data, options),
  };
});
// Promise I/O in the existing blob store uses the same concrete private files.
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, realpath: async (path: string) => {
    const mapped = local(path), actual = await real.realpath(mapped); return mapped === actual ? path : actual;
  }, lstat: (path: string, options?: { bigint?: boolean }) => real.lstat(local(path), options as { bigint: true }),
    open: (path: string, flags: Parameters<typeof real.open>[1], mode?: number) => real.open(local(path), flags, mode),
  };
});
vi.mock("../hosted-readonly-host-kernel", () => ({ readHostedReadonlyHostInventory: () => fixture.inventory,
  HostedReadonlyHostKernel: class {
    operatorSession() { if (fixture.blocked) throw new Error("TEST actors not closed"); return { hostId: "a".repeat(32), bootId: fixture.boot, supervisorId: "123:456" }; }
    verifyExclusiveInventory() { if (fixture.blocked) throw new Error("TEST actors not closed"); }
    verifyDescriptorBoundary() { if (fixture.blocked) throw new Error("TEST unsafe descriptor"); }
  } }));
vi.mock("../../provider-codex/app-server/adapters/hosted-process-activation", () => ({
  assertHostedActivationOperator() {}, assertHostedActivationFence(fence: unknown) { if (fence !== fixture.fence) throw new Error("TEST unheld fence"); },
  // These fixtures install the ORIGINAL fixed records (no successor selection), which is what the real resolver returns for them.
  selectedHostedInstallationRecordName: (name: string) => name,
}));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const runtimeDirectory = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const installationId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function installation() {
  return { schemaVersion: 1 as const, installationId, hostId: "a".repeat(32), runtimeDirectory,
    runtimeSha: "c".repeat(40), runtimeManifestSha256: "d".repeat(64), inventorySha256: hash(encode(fixture.inventory)) };
}
function scratchPin() {
  const fd = openSync(scratch, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = lstatSync(scratch, { bigint: true }), text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    const mountId = /^mnt_id:\s+([1-9][0-9]*)$/m.exec(text)?.[1]; if (!mountId) throw new Error("TEST mount identity");
    return { canonicalPath: scratch, dev: String(stat.dev), ino: String(stat.ino), mountId };
  } finally { closeSync(fd); }
}
async function put(name: string, value: unknown) { await writeFile(local(join(policyRoot, name)), encode(value), { mode: 0o600 }); }
async function configure() { await put("dependency-manifest-storage-policy.json", { version: 1, scratchRoot: scratchPin(), bootId: fixture.boot, limitsRevision: Revision.TestUnqualifiedV1 }); }
async function issued() { await configure(); issue(fixture.fence, installation()); await put("host-installation.json", installation()); return open(); }
type Store = Awaited<ReturnType<typeof open>>;
let store: Store | undefined;
beforeEach(async () => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), "manifest-placement-TEST-"))); fixture.blocked = false; fixture.mountAlias = "";
  for (const dir of ["policy", "scratch", "volatile", "volatile/codex-readonly-stages"]) await mkdir(join(fixture.root, dir), { mode: 0o700 });
  const jobRoot = policyRoot + "/dependency-test-jobs/jobs/TEST-placement", workspace = jobRoot + "/workspace";
  const launch = { command: process.execPath, args: [runtimeDirectory + "/dist/worker-codex/codex-goal-cli.js", "run"], cwd: workspace };
  fixture.inventory = { schemaVersion: 2, hostId: "a".repeat(32), supervisorUnit: "TEST.service", units: [], disabledCreators: [],
    ordinaryCreators: [{ creatorId: "TEST", jobId: "TEST-placement", jobRootDir: jobRoot, workspacePath: workspace, launch }], runtimeLaunch: launch };
  await put("readonly-inventory.json", fixture.inventory);
  await writeFile(join(fixture.root, "volatile/codex-readonly-stages", hash(Buffer.from(runtimeDirectory)) + ".json"),
    encode({ schemaVersion: 1, runtimeDirectory, runtimeSha: "c".repeat(40), runtimeManifestSha256: "d".repeat(64) }), { mode: 0o600 });
  await writeFile(join(fixture.root, "sentinel"), "TEST original source bytes");
});
afterEach(async () => { await store?.close(); store = undefined; await rm(fixture.root, { recursive: true, force: true }); });

// Red regressions: a misplaced blob/fallback loses the quota or touches state;
// a replaced path/config authenticates another directory; stale refs permit a
// placement switch; an unresolved issuer proceeds despite closed-publisher veto.
describe.skipIf(process.platform !== "linux")("fresh protected scratch manifests", () => {
  it("publishes installation-bound placement and deduplicates only on the private scratch leaf", async () => {
    store = await issued(); const bytes = Buffer.from("TEST exact manifest bytes"), digest = await store.put(bytes);
    expect(store.limitsRevision).toBe(Revision.TestUnqualifiedV1); expect(store.placementRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(await store.put(bytes)).toBe(digest); expect(await store.get(digest)).toEqual(bytes);
    const leaf = join(fixture.root, "scratch/dependency-manifests", installationId);
    expect(await readdir(leaf)).toEqual([digest + ".gz"]);
    expect(await readdir(join(fixture.root, "policy"))).not.toContain("dependency-manifests");
    expect(await readFile(join(fixture.root, "sentinel"), "utf8")).toBe("TEST original source bytes");
    expect(() => store?.assertCurrent(fixture.fence)).toThrow(`dependency_manifest_placement:${Failure.Closed}`);
    await store.close(); expect(() => store?.assertCurrent(fixture.fence)).not.toThrow();
    await expect(store.put(bytes)).rejects.toMatchObject({ reason: Failure.Closed });
  });
  // Red: a second close resolves before the real descriptor close, or a failed
  // close is forgotten and permits a later receipt-placement assertion.
  it("joins concurrent closes and vetoes placement assertion until actual closure succeeds", async () => {
    store = await issued(); const opened = store, original = LocalDependencyManifestBlobStore.prototype.close;
    let release = () => {}; const barrier = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(LocalDependencyManifestBlobStore.prototype, "close").mockImplementation(async function (this: LocalDependencyManifestBlobStore) {
      await barrier; await original.call(this);
    });
    const first = opened.close(), second = opened.close(); let finished = false;
    void second.then(() => { finished = true; }, () => {});
    try {
      expect(second).toBe(first); await Promise.resolve(); expect(finished).toBe(false);
      expect(() => opened.assertCurrent(fixture.fence)).toThrow(`dependency_manifest_placement:${Failure.Closed}`);
      release(); await Promise.all([first, second]); expect(spy).toHaveBeenCalledTimes(1);
      expect(() => opened.assertCurrent(fixture.fence)).not.toThrow();
    } finally { release(); try { await first; } finally { spy.mockRestore(); } }
  });
  it("retains failed closure and denies later placement assertions without retrying it", async () => {
    store = await issued(); const opened = store, original = LocalDependencyManifestBlobStore.prototype.close;
    let underlying: LocalDependencyManifestBlobStore | undefined;
    const spy = vi.spyOn(LocalDependencyManifestBlobStore.prototype, "close").mockImplementation(function (this: LocalDependencyManifestBlobStore) {
      underlying = this; return Promise.reject(new Error("TEST close failure"));
    });
    try {
      const first = opened.close(); await expect(first).rejects.toThrow("TEST close failure");
      const second = opened.close(); expect(second).toBe(first); await expect(second).rejects.toThrow("TEST close failure");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(() => opened.assertCurrent(fixture.fence)).toThrow(`dependency_manifest_placement:${Failure.Closed}`);
      expect(await readFile(join(fixture.root, "sentinel"), "utf8")).toBe("TEST original source bytes");
    } finally {
      spy.mockRestore(); try { if (underlying) await original.call(underlying); else await opened.close(); } finally { store = undefined; }
    }
  });
  it.each(["dependency-receipts", "dependency-receipt-history", "dependency-bindings", "dependency-installers", "dependency-transactions"])
    ("rejects retained %s before scratch effects", async name => {
      await configure(); await mkdir(local(join(policyRoot, name)), { mode: 0o700 });
      const retained = local(join(policyRoot, name, "TEST-intent")); await writeFile(retained, "TEST retained original", { mode: 0o600 });
      expect(() => issue(fixture.fence, installation())).toThrow(`dependency_manifest_placement:${Failure.Retained}`);
      expect(await readdir(join(fixture.root, "scratch"))).toEqual([]); expect(await readFile(retained, "utf8")).toBe("TEST retained original");
    });
  it("leaves unmanaged install untouched and never treats absent config as scratch attestation", async () => {
    issue(fixture.fence, installation()); expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
    await expect(open()).rejects.toMatchObject({ reason: Failure.Unsupported });
    expect(await readdir(join(fixture.root, "policy"))).toEqual(["readonly-inventory.json"]);
  });
  it("vetoes managed enrollment, unresolved actors and unheld fence before publication", async () => {
    await configure(); await put("readonly-enrollment.json", { TEST: "retained enrollment" });
    expect(() => issue(fixture.fence, installation())).toThrow(`dependency_manifest_placement:${Failure.Retained}`);
    await rm(local(join(policyRoot, "readonly-enrollment.json"))); fixture.blocked = true;
    expect(() => issue(fixture.fence, installation())).toThrow("TEST actors not closed");
    fixture.blocked = false; expect(() => issue({ held: true }, installation())).toThrow("TEST unheld fence");
    expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
  });
  it.each(["ino", "mountId"])("rejects configured %s mismatch before publication", async kind => {
    const expected = { ...scratchPin(), [kind]: "999999999999" };
    await put("dependency-manifest-storage-policy.json", { version: 1, scratchRoot: expected, bootId: fixture.boot, limitsRevision: Revision.TestUnqualifiedV1 });
    expect(() => issue(fixture.fence, installation())).toThrow();
    expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
    expect(await readdir(join(fixture.root, "policy"))).not.toContain("dependency-manifest-placement.json");
  });
  it("refuses a scratch path within a provider/tool grant family", async () => {
    await put("dependency-manifest-storage-policy.json", { version: 1, scratchRoot: { ...scratchPin(), canonicalPath: "/usr/TEST-manifests" },
      bootId: fixture.boot, limitsRevision: Revision.TestUnqualifiedV1 });
    expect(() => issue(fixture.fence, installation())).toThrow(`dependency_manifest_placement:${Failure.Unsupported}`);
    expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
  });
  it("vetoes a same-device filesystem-root alias through the actual grant exclusion boundary", async () => {
    await configure(); const own = scratchPin();
    const row = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find(line => line.split(" ")[0] === own.mountId);
    const device = row?.split(" ")[2]; if (!device) throw new Error("TEST mount device");
    // Synthetic kernel observation only; no real mount or native evidence claim.
    // The original overlap('scratch', '/') bug would issue a placement here.
    fixture.mountAlias = `999999999 1 ${device} / /usr/TEST-root-alias rw - TEST /dev/TEST rw\n`;
    expect(() => issue(fixture.fence, installation())).toThrow(`dependency_manifest_placement:${Failure.Unsupported}`);
    expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
    expect(await readdir(join(fixture.root, "policy"))).not.toContain("dependency-manifest-placement.json");
    expect(await readFile(join(fixture.root, "sentinel"), "utf8")).toBe("TEST original source bytes");
  });
  it.each(["scratch", "leaf", "mode", "policy", "installation", "inventory"])("rejects %s drift without root-state fallback", async kind => {
    store = await issued(); const bytes = Buffer.from("TEST manifest"), digest = await store.put(bytes);
    const leaf = join(fixture.root, "scratch/dependency-manifests", installationId);
    if (kind === "scratch" || kind === "leaf") {
      const replaced = kind === "scratch" ? join(fixture.root, "scratch") : leaf;
      await rename(replaced, replaced + ".original"); await mkdir(replaced, { mode: 0o700 });
    }
    if (kind === "mode") await chmod(leaf, 0o755);
    if (kind === "policy") await put("dependency-manifest-storage-policy.json", { version: 1, scratchRoot: { ...scratchPin(), ino: "987654321" }, bootId: fixture.boot, limitsRevision: Revision.TestUnqualifiedV1 });
    if (kind === "installation") await put("host-installation.json", { ...installation(), installationId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
    if (kind === "inventory") await put("readonly-inventory.json", { TEST: "different inventory bytes" });
    await expect(store.get(digest)).rejects.toThrow(); await expect(store.put(bytes)).rejects.toThrow(); expect(() => store?.assertCurrent(fixture.fence)).toThrow();
    expect(await readdir(join(fixture.root, "policy"))).not.toContain("dependency-manifests");
    expect(await readFile(join(fixture.root, "sentinel"), "utf8")).toBe("TEST original source bytes");
  });
  it.each(["unknown-version", "legacy-backing", "full-ordinary", "missing-contract", "wrong-contract", "extra", "noncanonical", "sha", "manifest"])
    ("rejects invalid stage %s before placement publication", async fault => {
      await configure();
      const path = local("/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + hash(Buffer.from(runtimeDirectory)) + ".json");
      const value = { schemaVersion: 1, runtimeDirectory, runtimeSha: "c".repeat(40), runtimeManifestSha256: "d".repeat(64) };
      const changed = fault === "unknown-version" ? { ...value, schemaVersion: 3 }
        : fault === "legacy-backing" ? { ...value, backingInterval: "original_full_parent_proc_v1" }
        : fault === "full-ordinary" ? { ...value, schemaVersion: 2, backingInterval: "original_full_parent_proc_v1" }
        : fault === "missing-contract" ? { ...value, schemaVersion: 2 }
        : fault === "wrong-contract" ? { ...value, schemaVersion: 2, backingInterval: "wrong" }
        : fault === "extra" ? { ...value, extra: true }
        : fault === "sha" ? { ...value, runtimeSha: "e".repeat(40) }
        : fault === "manifest" ? { ...value, runtimeManifestSha256: "e".repeat(64) } : value;
      const bytes = fault === "noncanonical" ? Buffer.from(JSON.stringify(value, null, 2) + "\n") : encode(changed);
      await writeFile(path, bytes, { mode: 0o600 });
      expect(() => issue(fixture.fence, installation())).toThrow(`dependency_manifest_placement:${Failure.Unsafe}`);
      expect(await readFile(path)).toEqual(bytes); expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
      expect(await readdir(join(fixture.root, "policy"))).not.toContain("dependency-manifest-placement.json");
      expect(await readFile(join(fixture.root, "sentinel"), "utf8")).toBe("TEST original source bytes");
    });
  it("binds the real decoder reread to the originally held stage bytes", async () => {
    await configure();
    const stagePath = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/" + hash(Buffer.from(runtimeDirectory)) + ".json";
    const path = local(stagePath), value = { schemaVersion: 1, runtimeDirectory, runtimeSha: "c".repeat(40), runtimeManifestSha256: "d".repeat(64) };
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    const actual = privateInputs.readHostedPrivateBytes, real = await vi.importActual<typeof import("node:fs")>("node:fs");
    let reads = 0;
    const spy = vi.spyOn(privateInputs, "readHostedPrivateBytes").mockImplementation((selected, bound) => {
      const bytes = actual(selected, bound);
      if (selected === stagePath && ++reads === 1) real.writeFileSync(path, encode(value), { mode: 0o600 });
      return bytes;
    });
    try {
      // A fresh canonical reread alone succeeds; the old loose held parse would
      // also succeed. The actual consumer must refuse their different bytes.
      expect(() => issue(fixture.fence, installation())).toThrow(`dependency_manifest_placement:${Failure.Unsafe}`);
      expect(reads).toBe(2); expect(await readFile(path)).toEqual(encode(value));
      expect(await readdir(join(fixture.root, "scratch"))).toEqual([]);
      expect(await readdir(join(fixture.root, "policy"))).not.toContain("dependency-manifest-placement.json");
    } finally { spy.mockRestore(); }
  });
  it("holds actual configured byte quota on scratch and keeps existing bytes untouched", async () => {
    store = await issued(); const leaf = join(fixture.root, "scratch/dependency-manifests", installationId);
    const retained = join(leaf, "f".repeat(64) + ".gz"); await writeFile(retained, "TEST", { mode: 0o600 });
    await truncate(retained, 512 * 1024 * 1024); // Sparse TEST file, no large payload allocation.
    await expect(store.put(Buffer.from("TEST next manifest"))).rejects.toMatchObject({ reason: BlobFailure.Quota });
    expect(await readdir(leaf)).toEqual(["f".repeat(64) + ".gz"]);
    await expect((await import("node:fs/promises")).stat(retained).then(stat => stat.size)).resolves.toBe(512 * 1024 * 1024);
  });
});
