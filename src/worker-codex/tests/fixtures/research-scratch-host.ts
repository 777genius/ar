import { dirname } from "node:path";
import { vi } from "vitest";
import { prepareHostScratchCaches, prepareHostScratchTemp, type ScratchTempHost } from "../../host-scratch-temp";
import { researchScratchBackingPath, host as researchHost } from "../research-launch-fixture";

/** Synthetic mount observations over disposable lower directories and policy
 * bytes. Preparation exercises the existing algorithm without any OS mounts. */
export async function preparedResearchScratch(job: string, home: string, partialCaches = false) {
  // Diagnostic-only callers have an in-memory host and need no physical files.
  // Integration callers allocate a private TEST root first. Bypass optional fs
  // mocks and pass only explicit contained physical paths to native writes.
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  function backing(path: string): string | undefined {
    const physical = researchScratchBackingPath(path);
    if (!physical) return undefined;
    for (let parent = physical; parent !== researchHost.root; parent = dirname(parent)) {
      let info: import("node:fs").Stats;
      try { info = fs.lstatSync(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || parent !== physical && !info.isDirectory()) throw new Error("Unsafe TEST scratch backing ancestor");
    }
    return physical;
  }
  function persistPolicy(): void { const path = backing(configPath); if (path) {
    const parent = backing(dirname(configPath));
    if (!parent) throw new Error("Missing owned TEST policy parent");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(policy)); } finally { fs.closeSync(fd); }
  } }
  const root = "/TEST-nvme", uuid = "d0f2cac1-2009-4e9d-a710-e156f417938f", configPath = "/etc/subscription-runtime/scratch-temp.json";
  type Info = ReturnType<ScratchTempHost["lstat"]>;
  let inode = 100;
  const directory = (mode = 0o700): Info => ({ uid: 0, mode, dev: 11, ino: inode++,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
  const nodes = new Map<string, Info>();
  for (const leaf of ["/etc/subscription-runtime", `${root}/runtime-tmp`, `${root}/runtime-caches`, job, home]) {
    for (let path = leaf;; path = dirname(path)) { if (!nodes.has(path)) nodes.set(path, directory()); if (path === "/") break; }
  }
  nodes.set(configPath, { ...directory(0o600), isDirectory: () => false, isFile: () => true });
  let policy: unknown = { schemaVersion: 1, root, uuid };
  persistPolicy();
  const mounts = new Map<string, ReturnType<ScratchTempHost["inspectMount"]>>([[root, { target: root, uuid, fsroot: "/" }]]);
  const mutations: string[] = [], prepared: { source: string; target: string }[] = [];
  const cacheFailure = new Error("TEST second cache preparation failed"); let observedCacheFailure: Error | undefined;
  const host: ScratchTempHost = {
    uid: 0, realpath: path => path,
    lstat: path => { const node = nodes.get(path); if (!node) throw Object.assign(new Error("Missing TEST node"), { code: "ENOENT" }); return node; },
    read: () => JSON.stringify(policy), inspectMount: path => mounts.get(path), statfs: () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }),
    mkdir: (path, mode) => { if (partialCaches && path === `${home}/cache/remote_plugin_catalog`) throw cacheFailure; mutations.push(path); nodes.set(path, directory(mode)); },
    chmod: (path, mode) => { mutations.push(path); nodes.set(path, { ...nodes.get(path)!, mode }); },
    entries: () => [], removeLock: path => { mutations.push(path); nodes.delete(path); },
    bind: (source, target) => { const physical = backing(target); if (physical) fs.mkdirSync(physical, { recursive: true, mode: 0o701 }); mutations.push(target); prepared.push({ source, target }); nodes.set(target, { ...nodes.get(source)! });
      mounts.set(target, { target, uuid, fsroot: source.slice(root.length) });
      for (const [path, info] of nodes) if (path === root || path.startsWith(root + "/") || prepared.some(bind => bind.target === path || dirname(bind.target) === path && path !== job)) researchHost.scratchNodes.set(path, info);
      for (const [path, mount] of mounts) researchHost.scratchMounts.set(path, mount);
    },
  };
  await prepareHostScratchTemp(job, {}, host);
  try { await prepareHostScratchCaches(home, {}, host); }
  catch (error) { if (error !== cacheFailure) throw error; observedCacheFailure = cacheFailure; }
  if (partialCaches && !observedCacheFailure) throw new Error("TEST missing partial cache failure");
  // Publish this fixture's kernel/stat observations to the shared native adapter
  // substitute. Do not replace retained job or system identities with synthetic ones.
  for (const [path, info] of nodes) if (path === root || path.startsWith(root + "/") || prepared.some(bind => bind.target === path || dirname(bind.target) === path && path !== job)) researchHost.scratchNodes.set(path, info);
  for (const [path, mount] of mounts) researchHost.scratchMounts.set(path, mount);
  mutations.length = 0;
  return { host, root, uuid, configPath, nodes, mounts, mutations, prepared, directory, observedCacheFailure,
    setPolicy: (value: unknown) => { policy = value; persistPolicy(); } };
}
