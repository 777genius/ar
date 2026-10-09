import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, relative } from "node:path";

const invalid = (): never => { throw new Error("hosted_mimo_worker_material_invalid"); };
const cache = new Map<string, { signature: string; digest: string }>();
function signature(stat: Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]);
}
function custody(path: string): void {
  for (let current = path;; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || (current !== path && !stat.isDirectory())) invalid();
    if (current === "/") break;
  }
}
function fileDigest(path: string, deadline: number, executable = false): string {
  custody(path);
  const beforePath = lstatSync(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), id = signature(before);
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 || (before.mode & 0o022) ||
        before.size > 512 * 1024 * 1024 || signature(beforePath) !== id || (executable && !(before.mode & 0o111))) invalid();
    let digest = cache.get(path)?.signature === id ? cache.get(path)!.digest : undefined;
    if (!digest) {
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(65536);
      let position = 0;
      while (position < before.size) {
        if (performance.now() > deadline) invalid();
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!count) invalid();
        hash.update(buffer.subarray(0, count)); position += count;
      }
      if (readSync(fd, buffer, 0, 1, position)) invalid();
      digest = hash.digest("hex");
    }
    custody(path);
    if (signature(fstatSync(fd)) !== id || signature(lstatSync(path)) !== id || performance.now() > deadline) invalid();
    if (cache.size >= 50032 && !cache.has(path)) cache.clear();
    cache.set(path, { signature: id, digest });
    return digest;
  } finally { closeSync(fd); }
}
/** Same immutable artifact wire hash as the owner, independently traversed. */
export function assertHostedMimoWorkerMaterial(spec: Record<string, unknown>, directory: string): void {
  const runtime = String(spec.runtimeDirectory), request = spec.request as Record<string, unknown>;
  const deadline = performance.now() + 30_000, rows: string[] = [], visited = new Set<string>();
  let size = 0;
  custody(runtime);
  const visit = (path: string): void => {
    if (visited.has(path)) return;
    visited.add(path);
    if (visited.size > 50000 || performance.now() > deadline) invalid();
    const stat = lstatSync(path), name = relative(runtime, path);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022))) invalid();
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(runtime + "/")) invalid();
      custody(target); rows.push(`${name}:link:${readlinkSync(path)}`); visit(target);
    } else if (stat.isDirectory()) {
      rows.push(`${name}:dir:${stat.mode & 0o777}`);
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isFile()) {
      size += stat.size;
      if (size > 512 * 1024 * 1024) invalid();
      rows.push(`${name}:${stat.mode & 0o777}:${fileDigest(path, deadline)}`);
    } else invalid();
  };
  for (const name of ["dist", "host-integration", "node_modules", "package.json"]) visit(join(runtime, name));
  if (createHash("sha256").update(JSON.stringify(rows)).digest("hex") !== spec.artifactSha256 ||
      fileDigest(process.execPath, performance.now() + 30_000, true) !== spec.nodeSha256 ||
      fileDigest(String(request.codexBinaryPath), performance.now() + 30_000, true) !== spec.codexSha256) invalid();
  for (const [name, field] of [["job", "jobDirectory"], ["workspace", "workspaceDirectory"]] as const) {
    const identity = spec[field] as Record<string, unknown>;
    for (const path of [String(identity.path), join(directory, "pins", name)]) {
      for (let current = path;; current = dirname(current)) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink() ||
            (current === path && (stat.uid !== 0 || (stat.mode & 0o022) || stat.dev !== identity.device || stat.ino !== identity.inode))) invalid();
        if (current === "/") break;
      }
    }
  }
}
