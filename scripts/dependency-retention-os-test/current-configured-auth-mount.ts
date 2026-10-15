import { configuredAuthUnderlyingIdentity, observeConfiguredAuthAttachmentData, assertConfiguredAuthAttachmentPhysical } from "../../dist/provider-codex/app-server/adapters/hosted-configured-auth-attachment.js";
import { readHostedDependencyBinding, assertHostedDependencyPhysicalWorkspace } from "../../dist/provider-codex/app-server/adapters/hosted-dependency-workspace.js";
import { assertHostedForegroundResult, readHostedForegroundLaunchObservation } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
/** TEST-only opaque seed attachment. Never reads, hashes, copies or prints credentials. */
import assert from "node:assert/strict";
import { constants, existsSync, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { assertReadonlyHostOperator } from "../../dist/worker-codex/hosted-readonly-authority.js";
import { assertCurrentClosedEntry, assertCurrentUnverifiedClosedEntry } from "./current-closed-entry.js";
import { withHostedActivationFence } from "../../dist/provider-codex/app-server/adapters/hosted-process-activation.js";
import type { HostedForegroundResult } from "../../dist/provider-codex/app-server/adapters/hosted-fd-launch.js";
import { command, directory } from "./common.ts";
const configuredPool = "/srv/worker-state/account-pools/live-codex-auth";
const guestSeedRoot = "/run/TEST-configured-codex-auth";
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function assertConfiguredAccountName(name: string): void {
  assert(typeof name === "string" && namePattern.test(name));
}
function fileIdentity(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    assert(s.isFile() && s.uid === 0n && s.gid === 0n && s.nlink === 1n && (s.mode & 0o7777n) === 0o600n && s.size > 0n && s.size <= 65536n);
    assert(s.dev === named.dev && s.ino === named.ino && s.ctimeNs === named.ctimeNs && s.size === named.size);
    return `${s.dev}:${s.ino}:${s.size}:${s.ctimeNs}:${s.mtimeNs}`;
  } finally { closeSync(fd); }
}
function ancestorMountId(fd: number): string {
  const raw = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"); assert(Buffer.byteLength(raw) <= 4096);
  const rows = [...raw.matchAll(/^mnt_id:\s+([1-9][0-9]{0,19})$/gm)], id = rows[0]?.[1];
  assert(rows.length === 1 && id); return id;
}
function safeAncestry(path: string) {
  const held: { path: string; fd: number; identity: string; mountId: string; parent: number | null }[] = [];
  const identity = (fd: number) => { const s = fstatSync(fd); return [s.dev, s.ino, s.uid, s.gid, s.mode].join(":"); };
  let closed = false;
  const close = () => { if (closed) return; closed = true; for (const e of held.reverse()) closeSync(e.fd); };
  function validate() {
    assert(!closed);
    for (const e of held) {
      const fresh = openSync(e.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
      try {
        assert.equal(identity(fresh), e.identity); assert.equal(identity(e.fd), e.identity);
        assert.equal(ancestorMountId(fresh), e.mountId); assert.equal(ancestorMountId(e.fd), e.mountId);
        assert.equal(realpathSync(`/proc/self/fd/${e.fd}`), e.path);
        if (e.path === "/srv/worker-state") { assert(e.parent !== null); assert.equal(e.mountId, ancestorMountId(e.parent)); }
      } finally { closeSync(fresh); }
    }
    assert.equal(realpathSync(path), path);
  }
  try {
    const paths: string[] = []; for (let p = dirname(path);; p = dirname(p)) { paths.unshift(p); if (p === "/") break; }
    for (const p of paths) {
      const parent = held.at(-1)?.fd ?? null;
      const fd = openSync(parent === null ? "/" : `/proc/self/fd/${parent}/${basename(p)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
      try {
        const s = fstatSync(fd), shared = p === "/srv/worker-state";
        assert(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022));
        if (shared) {
          assert(parent !== null && s.gid === 987 && (s.mode & 0o7777) === 0o751 && s.dev === 2306 && s.ino === 13631491);
          assert.equal(s.dev, fstatSync(parent).dev); assert.equal(ancestorMountId(fd), ancestorMountId(parent));
        } else assert.equal(s.gid, 0);
        held.push({ path: p, fd, identity: identity(fd), mountId: ancestorMountId(fd), parent });
      } catch (error) { closeSync(fd); throw error; }
    }
    validate(); return { validate, close };
  } catch (error) { close(); throw error; }
}
/** Called by the trusted owned-OS ROOT setup after actual runtime slot discovery.
 * The exact configured name is preserved, never account-u <-> u inferred.
 * This selects input data in ONE fixed configured pool, not account availability. */
export function configuredAuthNspawnBinding(accountName: string): string {
  assertReadonlyHostOperator(); assertConfiguredAccountName(accountName);
  const source = `${configuredPool}/${accountName}/auth.json`, target = `${guestSeedRoot}/${accountName}/auth.json`;
  const ancestry = safeAncestry(source);
  try {
    fileIdentity(source); ancestry.validate();
    // All names are closed path atoms; no shell interpolation, options or env origin.
    return `--bind-ro=${source}:${target}`;
  } finally { ancestry.close(); }
}
function mounts() {
  const bytes = readFileSync("/proc/self/mountinfo", "utf8"); assert(Buffer.byteLength(bytes) <= 1024 * 1024);
  return bytes.trimEnd().split("\n").map(line => {
    const fields = line.split(" "), at = fields.indexOf("-");
    assert(at > 5 && /^[1-9][0-9]*$/.test(fields[0] ?? ""));
    return { id: fields[0]!, dev: fields[2]!, root: fields[3]!, target: fields[4]!, options: fields[5]!.split(",") };
  });
}
/** Mount belongs to this TEST issuer's current PID1 namespace. No credential content
 * copy and no retained source FD crosses the actual provider/collector boundary. */
export function mountCurrentConfiguredAuth(jobRoot: string, accountName: string, originalArgs: readonly string[]) {
  assertReadonlyHostOperator(); assertConfiguredAccountName(accountName);
  assert(/^\/var\/lib\/subscription-runtime-host-policy\/dependency-test-jobs\/jobs\/TEST-os-[a-f0-9-]{36}$/.test(jobRoot));
  const source = `${guestSeedRoot}/${accountName}/auth.json`, target = `${jobRoot}/auth/${accountName}/auth.json`;
  const ancestry = safeAncestry(source);
  try {
  const sourceIdentity = fileIdentity(source); ancestry.validate();
  const initial = mounts().filter(row => row.target === source); assert.equal(initial.length, 1); assert(initial[0]!.options.includes("ro"));
  directory(jobRoot + "/auth"); directory(jobRoot + "/auth/" + accountName);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const own = fstatSync(fd, { bigint: true }); closeSync(fd);
  const underlying = configuredAuthUnderlyingIdentity(target);
  assert(own.isFile() && own.size === 0n && own.nlink === 1n);
  assert(!mounts().some(row => row.target === target || row.target.startsWith(target + "/")));
  // Any uncertain mount/remount holds its exact owned target; no automatic retry/unmount.
  command("/usr/bin/mount", ["--bind", source, target]);
  command("/usr/bin/mount", ["-o", "remount,bind,ro,nosuid,nodev,noexec", target]);
  const attached = mounts().filter(row => row.target === target); assert.equal(attached.length, 1);
  const record = attached[0]!; assert(record.options.includes("ro") && record.options.includes("nosuid") && record.options.includes("nodev") && record.options.includes("noexec"));
  ancestry.validate();
  assert.equal(fileIdentity(source), sourceIdentity); assert.equal(fileIdentity(target), sourceIdentity);
  const profile=observeConfiguredAuthAttachmentData(jobRoot,accountName,underlying,originalArgs);
  assertConfiguredAuthAttachmentPhysical(profile);
  let closed = false;
  return Object.freeze({
    profile,
    /** Original branded completion plus current CLOSED/no-live-reader state is
     * required. A bool or caller-authored release receipt is never accepted. */
    close(result: HostedForegroundResult) {
      return withHostedActivationFence(fence => {
      assertHostedForegroundResult(result);
      const observed=readHostedForegroundLaunchObservation(result);
      if(existsSync("/var/lib/subscription-runtime-host-policy/dependency-unverified-r-releases/"+observed.startId+".json"))assertCurrentUnverifiedClosedEntry(fence,jobRoot,result);
      else assertCurrentClosedEntry(fence, jobRoot, result); assertReadonlyHostOperator(); assert(!closed);
      const binding=readHostedDependencyBinding(jobRoot.slice(jobRoot.lastIndexOf("/")+1)); assert(binding && binding.version===2);
      assertHostedDependencyPhysicalWorkspace(binding); assertConfiguredAuthAttachmentPhysical(profile);
      const current = mounts().filter(row => row.target === target); assert.equal(current.length, 1);
      assert.deepEqual(current[0], record); assert.equal(fileIdentity(target), sourceIdentity);
      command("/usr/bin/umount", ["--", target]);
      assert(!mounts().some(row => row.target === target));
      const after = lstatSync(target, { bigint: true });
      assert(after.isFile() && !after.isSymbolicLink() && after.dev === own.dev && after.ino === own.ino && after.size === 0n && after.nlink === 1n);
      assert.deepEqual(configuredAuthUnderlyingIdentity(target),underlying);
      unlinkSync(target); closed = true;
      });
    },
  });
  } finally { ancestry.close(); }
}
