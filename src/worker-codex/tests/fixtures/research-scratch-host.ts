import { dirname } from "node:path";
import { prepareHostScratchCaches, prepareHostScratchTemp, type ScratchTempHost } from "../../host-scratch-temp";

/** Entirely synthetic Host: preparation exercises the existing algorithm, while
 * findmnt, filesystem identities and private namespace data are explicit facts. */
export async function preparedResearchScratch(job: string, home: string) {
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
  const mounts = new Map<string, ReturnType<ScratchTempHost["inspectMount"]>>([[root, { target: root, uuid, fsroot: "/" }]]);
  const mutations: string[] = [], prepared: { source: string; target: string }[] = [];
  const host: ScratchTempHost = {
    uid: 0, realpath: path => path,
    lstat: path => { const node = nodes.get(path); if (!node) throw Object.assign(new Error("Missing TEST node"), { code: "ENOENT" }); return node; },
    read: () => JSON.stringify(policy), inspectMount: path => mounts.get(path), statfs: () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }),
    mkdir: (path, mode) => { mutations.push(path); nodes.set(path, directory(mode)); },
    chmod: (path, mode) => { mutations.push(path); nodes.set(path, { ...nodes.get(path)!, mode }); },
    entries: () => [], removeLock: path => { mutations.push(path); nodes.delete(path); },
    bind: (source, target) => { mutations.push(target); prepared.push({ source, target }); nodes.set(target, { ...nodes.get(source)! });
      mounts.set(target, { target, uuid, fsroot: source.slice(root.length) }); },
  };
  await prepareHostScratchTemp(job, {}, host); await prepareHostScratchCaches(home, {}, host);
  mutations.length = 0;
  return { host, root, uuid, configPath, nodes, mounts, mutations, prepared, directory,
    setPolicy: (value: unknown) => { policy = value; } };
}
