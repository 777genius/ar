import { strict as assert } from "node:assert";
import { test } from "vitest";
import { prepareHostScratchCaches, prepareHostScratchTemp, resolveHostScratchTempRoot, type ScratchTempHost } from "../host-scratch-temp";

const root = "/srv/workers";
const uuid = "d0f2cac1-2009-4e9d-a710-e156f417938f";
const configPath = "/etc/subscription-runtime/scratch-temp.json";
function fixture() {
  type Info = ReturnType<ScratchTempHost["lstat"]>;
  const directory = (mode = 0o755, uid = 0): Info => ({ uid, mode, dev: 12, ino: 34, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
  const nodes = new Map<string, Info>(["/", "/etc", "/etc/subscription-runtime", "/srv", root, `${root}/runtime-tmp`, `${root}/runtime-caches`, "/home", "/home/codex", "/jobs", "/jobs/a", "/jobs/b"].map((path) => [path, directory()]));
  nodes.set(configPath, { ...directory(0o600), isDirectory: () => false, isFile: () => true });
  let config = JSON.stringify({ schemaVersion: 1, root, uuid });
  const mounts = new Map<string, ReturnType<ScratchTempHost["inspectMount"]>>([[root, { target: root, uuid, fsroot: "/" }]]);
  const contents = new Map<string, string[]>();
  const mutations: string[] = [];
  const host: ScratchTempHost = {
    uid: 0,
    realpath: (path) => path,
    lstat(path) {
      const info = nodes.get(path);
      if (!info) throw Object.assign(new Error("Missing fixture path"), { code: "ENOENT" });
      return info;
    },
    read: () => config,
    inspectMount: (path) => mounts.get(path),
    statfs: () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }),
    mkdir(path, mode) { if (nodes.has(path)) throw Object.assign(new Error("Exists"), { code: "EEXIST" }); mutations.push(`mkdir ${path}`); nodes.set(path, directory(mode)); },
    removeLock(path) { mutations.push(`removeLock ${path}`); nodes.delete(path); },
    chmod(path, mode) { mutations.push(`chmod ${path}`); nodes.set(path, { ...nodes.get(path)!, mode }); },
    entries: (path) => contents.get(path) ?? [],
    bind(source, target) {
      mutations.push(`bind ${source} ${target}`);
      mounts.set(target, { target, uuid, fsroot: source.slice(root.length) });
    },
  };
  return { host, nodes, mounts, contents, mutations, directory, setConfig: (value: unknown) => { config = JSON.stringify(value); } };
}

// Regressions: portable or trusted managed jobs unexpectedly change their layout.
test("absent policy and managed marker perform no mutations", async () => {
  const portable = fixture();
  portable.nodes.delete(configPath);
  await prepareHostScratchTemp("/jobs/a", { SUBSCRIPTION_RUNTIME_TMPDIR: "/custom/tmp" }, portable.host);
  assert.equal(resolveHostScratchTempRoot("/jobs/a", portable.host), undefined);
  assert.deepEqual(portable.mutations, []);
  const managed = fixture();
  managed.host.read = () => { throw new Error("Managed must bypass unmanaged policy"); };
  await prepareHostScratchTemp("/jobs/a", { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, managed.host);
  assert.deepEqual(managed.mutations, []);
});

// Regression: root spill or replacement scratch volume accepts jobs before validation.
test("invalid mount and independent volume pressure reject before mutation", async () => {
  for (const mount of [{ target: "/", uuid, fsroot: "/" }, { target: root, uuid: "wrong", fsroot: "/" }]) {
    const f = fixture();
    f.mounts.set(root, mount);
    await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /Scratch mount/);
    assert.deepEqual(f.mutations, []);
  }
  for (const lowVolume of ["/", root]) {
    const f = fixture();
    f.host.statfs = (path) => ({ bavail: (path === lowVolume ? 4 : 10) * 1024 ** 3, bsize: 1 });
    await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /5 GiB/);
    assert.deepEqual(f.mutations, []);
  }
  const atFloor = fixture();
  atFloor.host.statfs = () => ({ bavail: 5 * 1024 ** 3, bsize: 1 });
  assert.ok(resolveHostScratchTempRoot("/jobs/a", atFloor.host));
});

// Regression: concurrent jobs share mutable temp, or provider logical paths change.
test("distinct jobs bind distinct sources while retaining logical tmp targets", async () => {
  const f = fixture();
  const a = resolveHostScratchTempRoot("/jobs/a", f.host)!;
  const b = resolveHostScratchTempRoot("/jobs/b", f.host)!;
  assert.notEqual(a.source, b.source);
  assert.match(a.source, /^\/srv\/workers\/runtime-tmp\/[a-f0-9]{64}$/);
  assert.deepEqual(f.mutations, []);
  await prepareHostScratchTemp("/jobs/a", { SUBSCRIPTION_RUNTIME_TMPDIR: "/jobs/a/tmp" }, f.host);
  assert.equal(f.mounts.get("/jobs/a/tmp")?.fsroot, a.fsroot);
  assert.equal(f.nodes.get(a.source)?.mode, 0o701);
  assert.equal(f.nodes.get("/jobs/a/tmp")?.mode, 0o701);
  const before = [...f.mutations];
  f.host.uid = 1000;
  await prepareHostScratchTemp("/jobs/a", {}, f.host);
  assert.deepEqual(f.mutations, before);
});

test("nonempty legacy temp, unknown mount, and env spill fail without mutation", async () => {
  for (const scenario of ["legacy", "mount", "spill"]) {
    const f = fixture();
    f.nodes.set("/jobs/a/tmp", f.directory(0o701));
    if (scenario === "legacy") f.contents.set("/jobs/a/tmp", ["active-cache"]);
    if (scenario === "mount") f.mounts.set("/jobs/a/tmp", { target: "/jobs/a/tmp", uuid, fsroot: "/foreign" });
    await assert.rejects(prepareHostScratchTemp("/jobs/a", scenario === "spill" ? { SUBSCRIPTION_RUNTIME_TMPDIR: "/tmp/shared" } : {}, f.host));
    assert.deepEqual(f.mutations, []);
  }
});

test("config trust, symlink targets, and mount verification fail closed", async () => {
  const writableConfig = fixture();
  writableConfig.nodes.set(configPath, { ...writableConfig.nodes.get(configPath)!, mode: 0o666 });
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, writableConfig.host), /root-owned regular file/);
  assert.deepEqual(writableConfig.mutations, []);
  const config = fixture();
  config.setConfig({ schemaVersion: 2, root, uuid });
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, config.host), /Invalid scratch/);
  const symlink = fixture();
  symlink.nodes.set("/jobs/a/tmp", { ...symlink.directory(0o701), isSymbolicLink: () => true });
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, symlink.host), /Unsafe scratch directory/);
  assert.deepEqual(symlink.mutations, []);
  const badBind = fixture();
  badBind.host.bind = () => {};
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, badBind.host), /verification failed/);
  const unprivileged = fixture();
  unprivileged.host.uid = 1000;
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, unprivileged.host), /Root privilege/);
  assert.deepEqual(unprivileged.mutations, []);
});


// Regression: allowlisting permits a replacement directory or mutates legacy traversable temp.
test("legacy identity preserves exact directory; replacement inode is rejected", async () => {
  const f = fixture();
  const target = "/jobs/a/tmp";
  f.nodes.set(target, f.directory(0o711));
  f.contents.set(target, ["existing-running-data"]);
  f.setConfig({ schemaVersion: 1, root, uuid, legacyTemps: { [target]: { device: 12, inode: 34 } } });
  // Shared ancestors belong to the legitimate worker-state group; only job root is checked.
  f.nodes.set("/jobs", f.directory(0o2771, 999));
  await prepareHostScratchTemp("/jobs/a", {}, f.host);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.nodes.get(target)?.mode, 0o711);
  f.nodes.set(target, { ...f.directory(0o711), ino: 35 });
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /device\/inode changed/);
  assert.deepEqual(f.mutations, []);
});

// Regression: broad cache mounts hide credentials, journals, or another cache's state.
test("cache binds touch only two leaves with distinct scratch sources", async () => {
  const f = fixture();
  f.nodes.set("/home/codex/auth.json", { ...f.directory(0o600), isDirectory: () => false, isFile: () => true });
  const credential = f.nodes.get("/home/codex/auth.json");
  await prepareHostScratchCaches("/home/codex", {}, f.host);
  const targets = ["/home/codex/plugins/cache", "/home/codex/cache/remote_plugin_catalog"];
  assert.equal(f.mutations.filter((action) => action.startsWith("bind ")).length, 2);
  assert.notEqual(f.mounts.get(targets[0]!)?.fsroot, f.mounts.get(targets[1]!)?.fsroot);
  for (const target of targets) assert.match(f.mounts.get(target)?.fsroot ?? "", /^\/runtime-caches\/[a-f0-9]{64}$/);
  assert.equal(f.nodes.get("/home/codex/auth.json"), credential);
  assert.ok(!f.mutations.some((action) => /auth|journal|session/.test(action)));
  const before = [...f.mutations];
  await prepareHostScratchCaches("/home/codex", { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: "1" }, f.host);
  assert.deepEqual(f.mutations, before);
});

test("existing cache allowlist preserves exact inode", async () => {
  const f = fixture();
  const targets = ["/home/codex/plugins/cache", "/home/codex/cache/remote_plugin_catalog"];
  for (const path of ["/home/codex/plugins", "/home/codex/cache", ...targets]) f.nodes.set(path, f.directory(0o700));
  for (const target of targets) f.contents.set(target, ["legacy-catalog"]);
  f.setConfig({ schemaVersion: 1, root, uuid, legacyTemps: Object.fromEntries(targets.map((target) => [target, { device: 12, inode: 34 }])) });
  await prepareHostScratchCaches("/home/codex", {}, f.host);
  assert.deepEqual(f.mutations, []);
});

// Regression: concurrent writers bind twice or remove another writer's mutex.
test("busy bind mutex fails closed without deleting foreign lock", async () => {
  const f = fixture();
  const layout = resolveHostScratchTempRoot("/jobs/a", f.host)!;
  const lock = `${layout.source}.lock`;
  f.nodes.set(lock, f.directory(0o700));
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /busy/);
  assert.deepEqual(f.mutations, []);
  assert.ok(f.nodes.has(lock));
});

test("failed bind verification removes only its own mutex", async () => {
  const f = fixture();
  const layout = resolveHostScratchTempRoot("/jobs/a", f.host)!;
  f.host.bind = () => {};
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /verification failed/);
  assert.ok(!f.nodes.has(`${layout.source}.lock`));
});

// RED: preparation claims success for an old bind whose physical source was replaced.
test("preparation denies replaced source without rebinding the existing target", async () => {
  const f = fixture(), layout = resolveHostScratchTempRoot("/jobs/a", f.host)!;
  await prepareHostScratchTemp("/jobs/a", {}, f.host);
  f.nodes.set(layout.source, { ...f.nodes.get(layout.source)!, ino: 99 });
  const before = [...f.mutations];
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /Prepared scratch source identity changed/);
  assert.deepEqual(f.mutations, before);
});

// RED: a tuple-only post-bind check accepts a mount that names another directory.
test("new bind must establish physical source identity before preparation succeeds", async () => {
  const f = fixture(), bind = f.host.bind;
  f.host.bind = (source, target) => {
    bind(source, target);
    f.nodes.set(target, { ...f.nodes.get(target)!, ino: 99 });
  };
  await assert.rejects(prepareHostScratchTemp("/jobs/a", {}, f.host), /Prepared scratch source identity changed/);
  assert.equal(f.mutations.filter(action => action.startsWith("bind ")).length, 1);
  assert.ok(![...f.nodes.keys()].some(path => path.endsWith(".lock")));
});
