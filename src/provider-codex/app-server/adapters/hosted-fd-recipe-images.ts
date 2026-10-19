import { AppServerObserverPoint as Point, retainObserverFailure } from "../domain/app-server-observer-failure";
import { hostedDependencySystemdRunExecutable } from "./hosted-dependency-systemd-command";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, statSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import type { FdExecutablePin } from "../../../core/host-infrastructure/fd-collector-profile";
import { observedProcessCgroup } from "../../../core/host-infrastructure/process-cgroup";
import type { HostedFdProcess } from "./hosted-fd-observation";
import type { HostedFdNamespaceProcess } from "./hosted-fd-namespace-stages";
export interface HostedFdRecipeImages { readonly processes: readonly HostedFdNamespaceProcess[]; revalidate(): void; }
const wrappers = ["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/bin/tini", hostedDependencySystemdRunExecutable];
function denied(): never { throw new Error("hosted_fd_namespace_stage_unresolved"); }
const identity = (info: BigIntStats) => [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.ctimeNs, info.mtimeNs].join(":");
function protectedDirectory(path: string): BigIntStats {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n || (info.mode & 0o022n)) denied();
  return info;
}
function ancestry(path: string): void { for (let at = path;; at = dirname(at)) { protectedDirectory(at); if (at === "/") return; } }
function executable(info: BigIntStats): void {
  if (!info.isFile() || info.uid !== 0n || (info.mode & 0o022n) || !(info.mode & 0o111n) || info.nlink !== 1n || info.size < 64n || info.size > 256n * 1024n * 1024n) denied();
}
function same(left: BigIntStats, right: BigIntStats): void { if (identity(left) !== identity(right)) denied(); }
/** The caller has already joined the current unit root to its retained producer
 * root. This projection authenticates fixed wrapper images only; it cannot enroll
 * a process or replace the raw observations used by confinement and FD checks. */
export function readHostedFdRecipeImages(processes: readonly HostedFdProcess[], pins: readonly FdExecutablePin[], root: string,
  remaining: () => number): HostedFdRecipeImages {
  const began = process.hrtime.bigint(); let point = Point.ImageAlias;
  const reject = (error: unknown): never => {
    const message = typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
    const wrapped = message === "hosted_fd_boundary_unresolved" || message === "hosted_fd_namespace_stage_unresolved" ? error as Error : new Error("hosted_fd_namespace_stage_unresolved");
    retainObserverFailure(error, point, Math.min(60000, Math.max(0, Number((process.hrtime.bigint() - began) / 1000000n))), wrapped);
    throw wrapped;
  };
  try {
  if (!/^\/var\/lib\/subscription-runtime-host-policy\/dependency-provider-roots\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(root)) denied();
  point = Point.ImageRoot; ancestry(root); const originalRoot = lstatSync(root, { bigint: true });
  if (originalRoot.mode & 0o077n) denied();
  const retained: { process: HostedFdProcess; pin: FdExecutablePin; image: string }[] = [];
  function inspect(process: HostedFdProcess, pin: FdExecutablePin): string {
    point = Point.ImageRoot; remaining(); ancestry(root); same(originalRoot, lstatSync(root, { bigint: true }));
    point = Point.ImageSource; ancestry(dirname(pin.path));
    const proc = `/proc/${process.pid}`;
    const current = () => {
      remaining();
      const stat = readFileSync(proc + "/stat", "utf8"), at = stat.lastIndexOf(") "), fields = stat.slice(at + 2).trim().split(/\s+/);
      if (!stat.startsWith(`${process.pid} (`) || at < 0 || `${process.pid}:${fields[19]}` !== process.birth || Number(fields[1]) !== process.parentPid ||
          readlinkSync(proc + "/exe") !== process.exe || !readFileSync(proc + "/cmdline").equals(Buffer.from([...process.argv, ""].join("\0"))) ||
          observedProcessCgroup(readFileSync(proc + "/cgroup", "utf8")) !== process.group) denied();
      const actualRoot = statSync(proc + "/root", { bigint: true });
      if (!actualRoot.isDirectory() || actualRoot.dev !== originalRoot.dev || actualRoot.ino !== originalRoot.ino) denied();
    };
    point = Point.ImageRoot; current();
    const opened: number[] = [];
    try {
      point = Point.ImageSource;
      const source = openSync(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); opened.push(source);
      point = Point.ImageOpen;
      const image = openSync(proc + "/exe", constants.O_RDONLY | constants.O_NONBLOCK); opened.push(image);
      point = Point.ImageView;
      const view = openSync(proc + "/root" + pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); opened.push(view);
      point = Point.ImageSource; const before = fstatSync(source, { bigint: true }); executable(before);
      same(before, lstatSync(pin.path, { bigint: true }));
      point = Point.ImageOpen; same(before, fstatSync(image, { bigint: true }));
      point = Point.ImageView; same(before, fstatSync(view, { bigint: true }));
      point = Point.ImageSource; const bytes = readFileSync(source); remaining();
      point = Point.ImageElf;
      if (BigInt(bytes.length) !== before.size || !bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) || bytes.readUInt16LE(18) !== 62) denied();
      point = Point.ImageHash; if (createHash("sha256").update(bytes).digest("hex") !== pin.sha256) denied();
      point = Point.ImageRejoin;
      same(before, fstatSync(source, { bigint: true })); same(before, fstatSync(image, { bigint: true })); same(before, fstatSync(view, { bigint: true })); same(before, lstatSync(pin.path, { bigint: true }));
      const namedView = lstatSync(proc + "/root" + pin.path, { bigint: true }); same(before, namedView);
      same(before, statSync(proc + "/exe", { bigint: true }));
      current(); same(originalRoot, lstatSync(root, { bigint: true })); remaining();
      return identity(before);
    } finally {
      let failed = false, closeError: unknown;
      for (const fd of opened.reverse()) { try { closeSync(fd); } catch (error) { failed = true; closeError ??= error; } }
      if (failed) { point = Point.ImageClose; throw closeError; }
    }
  }
  const projected = processes.map(process => {
    // argv[0] selects a fixed image to authenticate; it never authorizes the
    // projection. Observer-visible /proc exe spelling may reflect a private
    // mount alias. Only the physical source/image/root-view proof below does.
    const selected = pins.filter(pin => wrappers.includes(pin.path) && process.argv[0] === pin.path);
    if (!selected.length) return process;
    point = Point.ImageAlias;
    if (selected.length !== 1 || !/^[a-f0-9]{64}$/.test(selected[0]!.sha256)) denied();
    const pin = selected[0]!, image = inspect(process, pin);
    retained.push({ process, pin, image });
    return Object.freeze({ pid: process.pid, parentPid: process.parentPid, argv: process.argv, exe: pin.path });
  });
  return Object.freeze({ processes: Object.freeze(projected), revalidate() {
    try {
      for (const row of retained) { const current = inspect(row.process, row.pin); point = Point.ImageRejoin; if (current !== row.image) denied(); }
    } catch (error) { reject(error); }
  } });
  } catch (error) { return reject(error); }
}
