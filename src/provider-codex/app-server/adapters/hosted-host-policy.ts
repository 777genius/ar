import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readSync, type Stats } from "node:fs";
import { dirname, basename, join } from "node:path";

// Private Host policy, also emitted into the independently installed launcher.
// Neither environment, request arguments nor inventory presence selects a mode.
const modePath = "/etc/subscription-runtime/host-activation-mode";
const policyRoot = "/var/lib/subscription-runtime-host-policy";
const volatileRoot = "/run/user/0/subscription-runtime-host-policy";
export enum HostedActivationMode { Disabled = "disabled", Required = "required" }
function invalid(): never { throw new Error("hosted_activation_mode_invalid"); }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
  a.mode === b.mode && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs;

/** Optional fixed records only. Missing ancestors are absence only after every
 * existing ancestor is pinned, checked and reread. The strict custody reader
 * deliberately retains its stronger requirement for complete private ancestry. */
function optionalBytes(path: string, maxBytes: number, privateFile: boolean, emptyDirectory = false): Buffer | null {
  const parent = dirname(path), directories: string[] = [];
  for (let p = parent;; p = dirname(p)) { directories.unshift(p); if (p === "/") break; }
  const ancestry: { path: string; stat: Stats; fd: number }[] = [];
  const directory = (p: string, stat: Stats) => {
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) ||
        (privateFile && p === parent && (stat.mode & 0o077))) invalid();
  };
  const check = () => {
    for (const entry of ancestry) {
      const current = lstatSync(entry.path), opened = fstatSync(entry.fd);
      directory(entry.path, current); directory(entry.path, opened);
      if (!same(entry.stat, current) || !same(entry.stat, opened)) invalid();
    }
  };
  const absent = (p: string): null => {
    check();
    try { lstatSync(p); invalid(); } catch (error) { if (!missing(error)) throw error; }
    check(); return null;
  };
  try {
    for (const p of directories) {
      let stat: Stats;
      try { stat = lstatSync(p); } catch (error) { if (missing(error)) return absent(p); throw error; }
      directory(p, stat);
      const fd = openSync(p, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      ancestry.push({ path: p, stat, fd }); check();
    }
    const anchored = `/proc/self/fd/${ancestry[ancestry.length - 1]!.fd}/${basename(path)}`;
    let fd: number;
    try { fd = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (emptyDirectory ? constants.O_DIRECTORY : 0)); }
    catch (error) { if (missing(error)) return absent(path); throw error; }
    try {
      check();
      const before = fstatSync(fd);
      if (emptyDirectory) {
        const privateDirectory = (stat: Stats) => {
          directory(path, stat);
          if (stat.mode & 0o077) invalid();
        };
        privateDirectory(before);
        const stream = opendirSync(`/proc/self/fd/${fd}`, { bufferSize: 1 });
        let occupied: boolean;
        try { occupied = stream.readSync() !== null; }
        finally { stream.closeSync(); }
        const after = fstatSync(fd), named = lstatSync(path);
        privateDirectory(after); privateDirectory(named);
        if (!same(before, after) || !same(after, named)) invalid();
        check();
        // A one-byte presence marker retains the existing refusal boundary.
        return occupied ? Buffer.alloc(1) : null;
      }
      const file = (stat: Stats) => {
        if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 ||
            (stat.mode & (privateFile ? 0o077 : 0o022)) || stat.size > maxBytes) invalid();
      };
      file(before);
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, length);
        if (!count) break; length += count;
      }
      const after = fstatSync(fd), named = lstatSync(path); file(after); file(named);
      if (length !== before.size || after.size !== before.size || !same(before, after) || !same(after, named)) invalid();
      check(); return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  } catch { return invalid(); }
  finally { for (const entry of ancestry.reverse()) closeSync(entry.fd); }
}

export function readHostedActivationMode(): HostedActivationMode {
  if (process.platform !== "linux") return HostedActivationMode.Disabled;
  const bytes = optionalBytes(modePath, 9, false);
  if (!bytes) return HostedActivationMode.Disabled;
  if (!bytes.equals(Buffer.from("required\n"))) invalid();
  return HostedActivationMode.Required;
}

// Containment is only ever proven by cgroup evidence; an absent cgroup file
// (non-Linux kernel, unmounted cgroupfs) is simply "not proven", never a raw
// ENOENT leaking past the closed hosted contract.
function readSelfCgroup(): string | undefined {
  try { return readFileSync("/proc/self/cgroup", "utf8"); }
  catch { return undefined; }
}

export function isHostedContainment(env: Readonly<Record<string, string | undefined>>): boolean {
  if (process.platform !== "linux") return false;
  if (env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job" ||
      process.env.SUBSCRIPTION_RUNTIME_SANDBOX_KIND === "hosted-codex-job" ||
      /\/subscription-runtime-(?:ordinary|outer|hosted|research)-/.test(readSelfCgroup() ?? "")) return true;
  return false;
}

export function hasHostedActivationOrigin(): boolean {
  return process.platform === "linux" &&
    /\/subscription-runtime-(?:ordinary|outer)-/.test(readSelfCgroup() ?? "");
}

/** No explicit enrollment can become a baseline launch after grant loss,
 * revocation or disabling the optional host feature. No records are created. */
export function assertHostedBaselineIdentity(jobId?: string): void {
  if (process.platform === "linux" && /\/subscription-runtime-research-/.test(readFileSync("/proc/self/cgroup", "utf8"))) {
    throw new Error("hosted_research_launch_denied");
  }
  if (readHostedActivationMode() !== HostedActivationMode.Disabled || hasHostedActivationOrigin()) {
    throw new Error("hosted_activation_authority_required");
  }
  const paths = ["host-installation.json", "host-activation.json", "host-activation.next",
    "ordinary-origins.json", "ordinary-origins.next", "readonly-enrollment.json", "readonly-epoch.json", "readonly-epoch.next"]
    .map(file => join(policyRoot, file));
  if (jobId !== undefined) {
    if (!jobId || jobId.length > 256 || /[\u0000-\u001f\u007f]/.test(jobId)) invalid();
    const name = createHash("sha256").update(jobId).digest("hex") + ".json";
    paths.push(join(volatileRoot, "codex-egress", name), join(volatileRoot, "codex-readonly", name),
    ...["codex-readonly-custody", "codex-readonly-revoked", "ordinary-origins", "dependency-bindings"]
      .map(root => join(policyRoot, root, name)));
  }
  for (const path of paths) if (optionalBytes(path, 4 * 1024 * 1024, true)) {
    throw new Error("hosted_readonly_managed_grant_required");
  }
  if (jobId === undefined) {
    const directories = [join(volatileRoot, "codex-egress"), join(volatileRoot, "codex-readonly"),
      ...["codex-readonly-custody", "codex-readonly-revoked", "ordinary-origins", "dependency-bindings"]
        .map(root => join(policyRoot, root))];
    for (const directory of directories) if (optionalBytes(directory, 0, true, true)) {
      throw new Error("hosted_readonly_managed_grant_required");
    }
  }
}
