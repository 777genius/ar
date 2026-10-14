import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { inspectVisibleScratchMount } from "../dist/worker-codex/host-scratch-mount.js";

// Run only with sudo unshare --mount --propagation private on a disposable TEST VM.
// Refuse the initial namespace before creating any directories or mounts.
assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 0);
const namespace = readlinkSync("/proc/self/ns/mnt");
assert.notEqual(namespace, readlinkSync("/proc/1/ns/mnt"));
const original = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n");
assert.ok(original.every(line => { const p = line.split(" "), separator = p.indexOf("-"); return separator === 6; }));
const root = mkdtempSync("/tmp/TEST-scratch-mount-propagation-");
const source = join(root, "source"), target = join(root, "target");
for (const path of [source, target]) mkdirSync(path, { mode: 0o700 });
const mount = (...args: string[]) => execFileSync("/usr/bin/mount", args, { timeout: 2000, stdio: "pipe" });
mount("--bind", source, source); mount("--make-shared", source);
const sharedSource = inspectVisibleScratchMount(source); assert.ok(sharedSource); assert.equal(sharedSource.isPrivate, false);
mount("--bind", source, target);
const bound = inspectVisibleScratchMount(target); assert.ok(bound); assert.equal(bound.isPrivate, false);
const backing = lstatSync(source), mounted = lstatSync(target);
assert.equal(mounted.dev, backing.dev); assert.equal(mounted.ino, backing.ino);
mount("--make-private", target);
const isolated = inspectVisibleScratchMount(target); assert.ok(isolated); assert.equal(isolated.isPrivate, true);
assert.equal(isolated.mountId, bound.mountId); assert.equal(isolated.fsroot, bound.fsroot); assert.equal(isolated.uuid, bound.uuid);
const retainedSource = inspectVisibleScratchMount(source); assert.ok(retainedSource);
assert.equal(retainedSource.mountId, sharedSource.mountId); assert.equal(retainedSource.isPrivate, false);
assert.equal(lstatSync(target).dev, backing.dev); assert.equal(lstatSync(target).ino, backing.ino);
execFileSync("/usr/bin/umount", [target], { timeout: 2000, stdio: "pipe" });
assert.equal(inspectVisibleScratchMount(target), undefined);
assert.equal(readlinkSync("/proc/self/ns/mnt"), namespace);
process.stdout.write(JSON.stringify({ status: "passed", namespace, bound, isolated, retainedSource,
  normalUnmountPassed: true, sourceStillShared: true, realProductionAdapter: true }) + "\n");
// Namespace exit releases the owned shared source mount; no host-global mounts were changed.
