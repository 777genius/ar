import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname } from "node:path";
import { isProxy } from "node:util/types";

/** Protected host transport facts only. Parsing never grants a root purpose. */
export enum HostedDependencyRootGitRecipe { RootGitReadV1 = "root_git_read_v1" }
export type HostedDependencyRootGitFilePin = Readonly<{ path: string; sha256: string; dev: string; ino: string;
  mountId: string; uid: 0; gid: 0; mode: number; size: string }>;
export type HostedDependencyRootGitProfile = Readonly<{ version: 1; recipe: HostedDependencyRootGitRecipe.RootGitReadV1;
  executable: HostedDependencyRootGitFilePin; libraries: readonly HostedDependencyRootGitFilePin[] }>;
const fileLimit = 32 * 1024 * 1024, totalLimit = 256 * 1024 * 1024;
function fail(): never { throw new Error("dependency_root_git_profile_unsupported"); }
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.split(",").length || names.some(key => typeof key !== "string") || names.sort().join(",") !== keys) fail();
  const snapshot: Record<string,unknown> = Object.create(null);
  for (const name of names as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value,name);
    if (!descriptor) fail();
    if (!("value" in descriptor) || !descriptor.enumerable) fail(); snapshot[name] = descriptor.value;
  }
  return snapshot;
}
function list(value: unknown): readonly unknown[] {
  if (!value || typeof value !== "object" || isProxy(value) || !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) fail();
  const length = Object.getOwnPropertyDescriptor(value,"length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 1 || length.value > 32 ||
      Reflect.ownKeys(value).length !== length.value + 1) fail();
  const snapshot: unknown[] = [];
  for (let i = 0; i < length.value; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value,String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(); snapshot.push(descriptor.value);
  }
  return snapshot;
}
function path(v: unknown): v is string {
  return typeof v === "string" && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(v) &&
    !v.split("/").some(part => part === "." || part === "..");
}
function decimal(v: unknown, positive = false): v is string {
  return typeof v === "string" && (positive ? /^[1-9][0-9]*$/ : /^(?:0|[1-9][0-9]*)$/).test(v) && v.length <= 32;
}
function filePin(value: unknown, executable: boolean): HostedDependencyRootGitFilePin {
  const v = record(value,"dev,gid,ino,mode,mountId,path,sha256,size,uid");
  if (!path(v.path) ||
      (executable ? v.path !== "/usr/bin/git" : !v.path.startsWith("/usr/lib/")) ||
      typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256) || !decimal(v.dev) || !decimal(v.ino,true) ||
      !decimal(v.mountId,true) || !decimal(v.size,true) || BigInt(v.size) > BigInt(fileLimit) || v.uid !== 0 || v.gid !== 0 ||
      typeof v.mode !== "number" || !Number.isSafeInteger(v.mode) || v.mode < 0 || v.mode > 0o7777 ||
      (v.mode & 0o6022) !== 0 || (executable && (v.mode & 0o111) === 0)) fail();
  return Object.freeze({path:v.path,sha256:v.sha256,dev:v.dev,ino:v.ino,mountId:v.mountId,uid:0,gid:0,mode:v.mode,size:v.size});
}
export function parseHostedDependencyRootGitProfile(value: unknown): HostedDependencyRootGitProfile {
  const v = record(value,"executable,libraries,recipe,version");
  if (v.version !== 1 || v.recipe !== HostedDependencyRootGitRecipe.RootGitReadV1) fail();
  const executable = filePin(v.executable,true), libraries = list(v.libraries).map(value => filePin(value,false));
  if (libraries.some((v,i) => i > 0 && Buffer.compare(Buffer.from(libraries[i-1]!.path),Buffer.from(v.path)) >= 0) ||
      !libraries.some(v => /\/ld-linux-x86-64\.so\.2$/.test(v.path)) || !libraries.some(v => /\/libc\.so\.[0-9]+$/.test(v.path)) ||
      libraries.reduce((sum,v) => sum + BigInt(v.size),BigInt(executable.size)) > BigInt(totalLimit)) fail();
  return Object.freeze({version:1,recipe:HostedDependencyRootGitRecipe.RootGitReadV1,executable,libraries:Object.freeze(libraries)});
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid &&
    a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function mountId(fd: number): string {
  const input = openSync(`/proc/self/fdinfo/${fd}`,constants.O_RDONLY | constants.O_NOFOLLOW), bytes = Buffer.alloc(16385);
  let length = 0;
  try { while (length < bytes.length) { const count = readSync(input,bytes,length,bytes.length-length,null);
    if (!count) break; length += count; } } finally { closeSync(input); }
  if (length > 16384) fail(); const info = bytes.subarray(0,length).toString("utf8");
  const matches = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (matches.length !== 1 || !matches[0]?.[1]) fail(); return matches[0][1];
}
type Retained = { fd: number; pin: HostedDependencyRootGitFilePin; stat: BigIntStats;
  ancestors: readonly {path:string;stat:BigIntStats}[] };
function assertRetained(file: Retained): void {
  if (!same(file.stat,fstatSync(file.fd,{bigint:true})) || !same(file.stat,lstatSync(file.pin.path,{bigint:true})) ||
      mountId(file.fd) !== file.pin.mountId || realpathSync(file.pin.path) !== file.pin.path) fail();
  for (const parent of file.ancestors) if (!same(parent.stat,lstatSync(parent.path,{bigint:true}))) fail();
}
/** Caller passes its existing monotonic allowance; never reset it per leaf.
 * All descriptors remain retained through the final cross-file revalidation. */
export function assertHostedDependencyRootGitProfile(value: unknown, remaining: () => number): HostedDependencyRootGitProfile {
  const profile = parseHostedDependencyRootGitProfile(value), retained: Retained[] = [];
  const budget = () => { const left = remaining(); if (!Number.isFinite(left) || left <= 0) fail(); };
  let total = 0;
  try {
    for (const pin of [profile.executable,...profile.libraries]) {
      budget(); const ancestors: Retained["ancestors"][number][] = [];
      for (let parent = dirname(pin.path);; parent = dirname(parent)) {
        budget(); const stat = lstatSync(parent,{bigint:true});
        if (!stat.isDirectory() || stat.uid !== 0n || stat.gid !== 0n || (stat.mode & 0o022n)) fail();
        ancestors.push({path:parent,stat}); if (parent === "/") break;
      }
      if (realpathSync(pin.path) !== pin.path) fail();
      const fd = openSync(pin.path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // Register immediately: every opened descriptor closes on all failure paths.
      let stat: BigIntStats;
      try { stat = fstatSync(fd,{bigint:true}); } catch (error) { closeSync(fd); throw error; }
      const file = {fd,pin,stat,ancestors}; retained.push(file);
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== 0n || stat.gid !== 0n ||
          String(stat.dev) !== pin.dev || String(stat.ino) !== pin.ino || Number(stat.mode & 0o7777n) !== pin.mode ||
          String(stat.size) !== pin.size || mountId(fd) !== pin.mountId || !same(stat,lstatSync(pin.path,{bigint:true}))) fail();
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let offset = 0;
      while (offset < Number(stat.size)) {
        budget(); const count = readSync(fd,buffer,0,Math.min(buffer.length,Number(stat.size)-offset),offset);
        if (count <= 0 || (total += count) > totalLimit) fail(); hash.update(buffer.subarray(0,count)); offset += count;
      }
      budget(); if (readSync(fd,buffer,0,1,offset) !== 0 || hash.digest("hex") !== pin.sha256) fail();
      assertRetained(file);
    }
    for (const file of retained) { budget(); assertRetained(file); }
    budget(); return profile;
  } finally { for (const file of retained) closeSync(file.fd); }
}
