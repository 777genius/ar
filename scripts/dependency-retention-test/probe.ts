/** Trusted TEST reader mounted as one extra read-only file in the installer root.
 * This is not an authenticated provider or ordinary-consumer acceptance probe.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const mode = process.argv[3];
assert(mode === "hidden" || mode === "exposed");
const observedIds = { uid: process.getuid?.(), euid: process.geteuid?.(),
  gid: process.getgid?.(), egid: process.getegid?.() };
assert.deepEqual(observedIds, { uid: 65532, euid: 65532, gid: 65532, egid: 65532 });
assert.deepEqual(process.getgroups?.(), [65532]); // Node includes effective GID.
process.stdout.write(JSON.stringify({ schemaVersion: 1, scenario: "typed_installer_root_probe_ready" }) + "\n");
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TEST host credential observation missing")), 15000);
  process.stdin.once("data", bytes => { clearTimeout(timer); bytes.equals(Buffer.from("observed\n")) ? resolve() : reject(new Error("TEST invalid release")); });
  process.stdin.resume();
});
const staging = process.argv[2];
assert(staging && /^\/var\/lib\/subscription-runtime-host-policy\/dependency-installers\/[a-f0-9-]{36}\/staging$/.test(staging));
const canaries: unknown = JSON.parse(process.argv[4] ?? "null");
assert(Array.isArray(canaries) && canaries.length === 7);
const dependency: unknown = createRequire(import.meta.url)(staging + "/node_modules/is-number");
assert.equal(typeof dependency, "function");
if (typeof dependency !== "function") throw new Error("TEST dependency capability missing");
assert.equal(dependency(42), true);
const paths = new Set<string>();
for (const value of canaries as unknown[]) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.equal(Object.keys(value).sort().join(","), "path,sha256");
  const { path, sha256 } = value as { path?: unknown; sha256?: unknown };
  assert(typeof path === "string" && path.startsWith("/var/lib/subscription-runtime-host-policy/") &&
    /^\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/.test(path) && !path.split("/").some(part => part === "." || part === ".."));
  assert(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256));
  assert(!paths.has(path)); paths.add(path);
  // Inspect the real guest target ancestry in BOTH runs. EACCES must never
  // substitute for namespace denial, even before the exposure control runs.
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o7777) === 0o755);
    if (parent === "/") break;
  }
  if (mode === "exposed") {
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && stat.nlink === 1 && (stat.mode & 0o7777) === 0o644);
    assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), sha256);
  } else {
    assert.throws(() => readFileSync(path), (error: unknown) => error instanceof Error && "code" in error &&
      error.code === "ENOENT", "TEST readable canary must be absent, never merely unreadable");
  }
}
process.stdout.write(JSON.stringify({ schemaVersion: 1, scenario: "typed_installer_root_probe", observedIds,
  dependencyRead: "passed", canaryCount: paths.size, canaryObservation: mode === "exposed" ? "readable_hashes_matched" : "absent_ENOENT",
  targetAncestry: "traversable_755" }) + "\n");
