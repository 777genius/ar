/** Owned TEST topology only. A mode/physical fact never grants origin or custody. */
import assert from "node:assert/strict";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statfsSync } from "node:fs";
import { runtime } from "./common.ts";
export enum CurrentBackingGeometry { Existing = "existing", Adoptable = "current-adoptable-backing" }
export const currentBackingStorage = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs";
export const currentGeometryMarker = runtime + "/TEST-current-backing.json";
export enum CurrentGeometryQualification { ClosedOnly = "native_current_closed_registration_on_adoptable_backing_only" }
export function readCurrentBackingGeometry(): CurrentBackingGeometry {
  if (!existsSync(currentGeometryMarker)) return CurrentBackingGeometry.Existing;
  const before = lstatSync(currentGeometryMarker);
  assert(before.isFile() && !before.isSymbolicLink() && before.uid === 0 && before.gid === 0 && before.nlink === 1 &&
    !(before.mode & 0o022) && before.size > 0 && before.size <= 256);
  const fd = openSync(currentGeometryMarker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(before.size); assert.equal(readSync(fd, bytes, 0, bytes.length, 0), bytes.length);
    for (const stat of [fstatSync(fd), lstatSync(currentGeometryMarker)])
      assert(stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size &&
        stat.nlink === 1 && stat.uid === 0 && stat.gid === 0 && !(stat.mode & 0o022) &&
        stat.ctimeMs === before.ctimeMs && stat.mtimeMs === before.mtimeMs);
    assert.equal(bytes.toString("utf8"), JSON.stringify({ schemaVersion: 1, geometry: CurrentBackingGeometry.Adoptable }) + "\n");
    return CurrentBackingGeometry.Adoptable;
  } finally { closeSync(fd); }
}
/** Call immediately after initial fresh C/ref directories, before ANY input,
 * .git, binding, source mapping, receipt or baseline captures. No late copy. */
export function observeInitialCurrentBacking(candidateWorkspace: string, referenceWorkspace: string) {
  for (const path of [candidateWorkspace, referenceWorkspace]) {
    assert(typeof path === "string" && new RegExp("^" + currentBackingStorage + "/jobs/TEST-[A-Za-z0-9_.-]{1,123}/workspace$").test(path));
    assert.equal(realpathSync(path), path);
  }
  const storage = lstatSync(currentBackingStorage), root = lstatSync("/");
  assert(storage.isDirectory() && !storage.isSymbolicLink() && storage.uid === 0 && storage.gid === 0 &&
    !(storage.mode & 0o022) && storage.dev !== root.dev);
  assert.equal(statfsSync(currentBackingStorage).type, 0xef53);
  const facts = [candidateWorkspace, referenceWorkspace].map(path => {
    const stat = lstatSync(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && stat.gid === 0 &&
      (stat.mode & 0o7777) === 0o700 && stat.dev === storage.dev);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  });
  assert.notDeepEqual(facts[0], facts[1]);
  const mounts = readFileSync("/proc/self/mountinfo", "utf8"); assert(Buffer.byteLength(mounts) <= 1024 * 1024);
  const rows = mounts.trimEnd().split("\n").map(line => line.split(" "));
  const own = rows.filter(row => row[4] === currentBackingStorage); assert.equal(own.length, 1);
  const mount = own[0]!; assert(/^\d+:\d+$/.test(mount[2] ?? ""));
  assert.equal(rows.filter(row => row[2] === mount[2]).length, 1, "TEST backing has an alternate exposure");
  const after = lstatSync(currentBackingStorage); assert(after.dev === storage.dev && after.ino === storage.ino);
  return { qualification: "TEST_initial_physical_topology_only", filesystem: "ext4", storage: { dev: String(storage.dev), ino: String(storage.ino) },
    candidate: facts[0]!, reference: facts[1]!, observedBeforeInputsAndBindings: true } as const;
}
