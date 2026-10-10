import { readFile, writeFile, readdir, mkdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const delivery = join(root, "delivery/a0-native-probe"), preimages = join(delivery, "preimages"), postimages = join(delivery, "postimages");
const owned = ["src/hosted-native-bootstrap", "src/hosted-native-probe", "src/worker-core/hosted-custody/domain/native-test-bootstrap.ts", "src/worker-core/hosted-custody/ports/native-test-bootstrap.ts", "src/worker-core/hosted-custody/application/native-test-bootstrap.ts", "src/worker-core/hosted-custody/domain/native-probe.ts", "src/worker-core/hosted-custody/ports/native-probe.ts", "src/worker-core/hosted-custody/application/native-probe.ts", "host-integration/native-test-bootstrap", "host-integration/native-probe", "host-integration/host-jobs/endpoint.mjs", "host-integration/host-jobs/read-request.mjs", "scripts/ops/host-job-cli.mjs", "scripts/ops/host-job-transport.mjs", "scripts/ops/host-job-cli.d.mts", "scripts/ops/host-job-transport.d.mts", "package.json", ".github/workflows/ci.yml"];
function allowed(path: string): boolean { return !path.split("/").some(part => part === "." || part === ".." || part === "") && owned.some(prefix => path === prefix || path.startsWith(prefix + "/")); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid delivery metadata"); return value as Record<string, unknown>; }
const baseline = record(JSON.parse(await readFile(join(delivery, "baseline.json"), "utf8")) as unknown);
if (baseline.operatorBoundBase !== "ccf0fed9132209996a62776099c188351fddd5a9" || !Array.isArray(baseline.preimages)) throw new Error("baseline binding missing");
const before = new Map<string, { digest: string; mode: string }>();
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
for (const value of baseline.preimages) {
  const row = record(value); if (typeof row.path !== "string" || !allowed(row.path)) throw new Error("foreign preimage");
  if (row.state === "present") {
    if (typeof row.sha256 !== "string" || typeof row.mode !== "string" || hash(await readFile(join(preimages, row.path))) !== row.sha256) throw new Error("preimage changed");
    before.set(row.path, { digest: row.sha256, mode: row.mode });
  }
}
const current = new Map<string, { bytes: Buffer; digest: string; mode: string }>();
async function visit(path: string): Promise<void> {
  let stat; try { stat = await lstat(join(root, path)); } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) throw new Error("source symlink refused");
  if (stat.isDirectory()) { for (const child of await readdir(join(root, path))) await visit(path + "/" + child); return; }
  if (!stat.isFile() || !allowed(path)) throw new Error("foreign source path");
  const bytes = await readFile(join(root, path)); current.set(path, { bytes, digest: hash(bytes), mode: "0o" + (stat.mode & 0o777).toString(8) });
}
for (const path of owned) await visit(path);
const changed: Array<{ path: string; change: string; preimage: { sha256: string; mode: string } | null; postimage: { sha256: string; mode: string; bytes: number } | null }> = [];
let patch = "", lines = 0; const diff = promisify(execFile);
for (const path of [...new Set([...before.keys(), ...current.keys()])].sort()) {
  const old = before.get(path), next = current.get(path); if (old?.digest === next?.digest && old?.mode === next?.mode) continue;
  if (next) { const target = join(postimages, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, next.bytes); lines += next.bytes.toString().split("\n").length - 1; }
  const args = ["--label", old ? "a/" + path : "/dev/null", "--label", next ? "b/" + path : "/dev/null", "-u", old ? join(preimages, path) : "/dev/null", next ? join(postimages, path) : "/dev/null"];
  try { patch += (await diff("/usr/bin/diff", args, { maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string") patch += error.stdout; else throw error; }
  changed.push({ path, change: old ? next ? "changed" : "deleted" : "added", preimage: old ? { sha256: old.digest, mode: old.mode } : null, postimage: next ? { sha256: next.digest, mode: next.mode, bytes: next.bytes.length } : null });
}
await writeFile(join(delivery, "exact-source.patch"), patch);
const evidence = (await readdir(delivery)).filter(path => path.endsWith(".log") || path.startsWith("source-check-")).sort();
await writeFile(join(delivery, "manifest.json"), JSON.stringify({ version: 1, operatorBoundBase: baseline.operatorBoundBase, baseVerifiedByWorker: false, specificationSha256: baseline.specificationSha256, implementationComplete: false, qualification: "unqualified-source-work-in-progress", sourcePostimageLines: lines, patchSha256: hash(Buffer.from(patch)), changedFiles: changed, evidence }, null, 2) + "\n");
console.log(`Exact checkpoint: ${changed.length} source paths; ${lines} postimage lines; ${hash(Buffer.from(patch))}`);
