import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, statfsSync, writeFileSync, type BigIntStats } from "node:fs";
import { isDependencyProtectedReference, type DependencyProtectedReference } from "@vioxen/subscription-runtime/core";

const root = "/var/lib/subscription-runtime-host-policy";
const archiveRoot = `${root}/activation-fence-retired`;
const operations = `${root}/dependency-transactions/`;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export enum HostedRetirementMutexFailure { Held = "held", Busy = "busy", Unsupported = "unsupported" }
export class HostedRetirementMutexError extends Error {
  constructor(readonly reason: HostedRetirementMutexFailure) { super(`hosted_retirement_mutex_${reason}`); }
}
export type HostedRemovalRetirementReferences = Readonly<{ claim: DependencyProtectedReference;
  actor: DependencyProtectedReference; lock: DependencyProtectedReference; completion: DependencyProtectedReference }>;
type Identity = Readonly<{ dev: string; ino: string }>;
export type HostedRemovalRetirementWitness = HostedRemovalRetirementReferences & Readonly<{
  version: 1; purpose: "retire_completed_dependency_removal_v1"; acquisitionId: string;
  bootId: string; parent: Identity; mutex: Identity }>;
type Pin = { fd: number; path: string; stat: BigIntStats; mount: string };
function held(): never { throw new HostedRetirementMutexError(HostedRetirementMutexFailure.Held); }
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
const identity = (s: BigIntStats): Identity => ({ dev: String(s.dev), ino: String(s.ino) });
function equal(a: unknown, b: unknown): boolean { return encode(a).equals(encode(b)); }
function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function object(v: unknown, fields: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== fields.split(",").sort().join(",")) held();
}
function validateReferences(v: unknown): asserts v is HostedRemovalRetirementReferences {
  object(v, "claim,actor,lock,completion");
  for (const [name, suffix] of [["claim", ".removal-claim.json"], ["actor", ".removal-actor.json"],
    ["completion", ".removal-session-closed.json"], ["lock", ".remove.lock"]] as const) {
    const ref = v[name]; if (!isDependencyProtectedReference(ref) || !ref.path.startsWith(operations) ||
      !ref.path.endsWith(suffix) || !uuid.test(ref.path.slice(operations.length, -suffix.length))) held();
  }
  const refs = v as unknown as HostedRemovalRetirementReferences;
  const id = refs.claim.path.slice(operations.length, -".removal-claim.json".length);
  if (refs.actor.path !== `${operations}${id}.removal-actor.json` || refs.completion.path !== `${operations}${id}.removal-session-closed.json`) held();
}
function parseWitness(v: unknown): HostedRemovalRetirementWitness {
  object(v, "version,purpose,acquisitionId,bootId,parent,mutex,claim,actor,lock,completion");
  if (v.version !== 1 || v.purpose !== "retire_completed_dependency_removal_v1" || typeof v.acquisitionId !== "string" ||
    !uuid.test(v.acquisitionId) || typeof v.bootId !== "string" || !uuid.test(v.bootId)) held();
  for (const s of [v.parent, v.mutex]) { object(s, "dev,ino"); if (![s.dev, s.ino].every(n => typeof n === "string" && /^(0|[1-9][0-9]{0,39})$/.test(n))) held(); }
  validateReferences({ claim: v.claim, actor: v.actor, lock: v.lock, completion: v.completion });
  return v as unknown as HostedRemovalRetirementWitness;
}
function fdIdentity(fd: number): string {
  const text = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
  return ["flags", "mnt_id", "ino"].map(field => { const match = new RegExp(`^${field}:\\s+([0-9]+)$`, "m").exec(text); if (!match) held(); return `${field}:\t${match[1]}`; }).join("\n");
}
function pin(path: string): Pin {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const p = { fd, path, stat: fstatSync(fd, { bigint: true }), mount: fdIdentity(fd) };
    validatePin(p); return p;
  } catch (error) { closeSync(fd); throw error; }
}
function validatePin(p: Pin): void {
  const s = fstatSync(p.fd, { bigint: true }), n = lstatSync(p.path, { bigint: true });
  if (!s.isDirectory() || !n.isDirectory() || s.uid !== 0n || (s.mode & 0o7777n) !== 0o700n ||
    !same(s, p.stat) || !same(s, n) || n.uid !== 0n || n.mode !== s.mode || s.mode !== p.stat.mode || fdIdentity(p.fd) !== p.mount ||
    !/^flags:\s+([0-7]+)$/m.test(p.mount) || !(Number.parseInt(/^flags:\s+([0-7]+)$/m.exec(p.mount)![1]!, 8) & 0o2000000)) held();
}
// Fixed program shares fd3's OFD with Node; helper exit MUST NOT unlock it.
const lockProgram = "import fcntl,os\ntry: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB); print('locked')\nexcept BlockingIOError: print('busy')\nfinally: os.close(3)";
// Directory descriptors are inherited explicitly; names never select a host path.
const archiveProgram = `import ctypes,os,sys
lib=ctypes.CDLL(None,use_errno=True); rename=lib.renameat2
rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
rename.restype=ctypes.c_int
if rename(3,sys.argv[1].encode(),4,sys.argv[2].encode(),1)!=0: raise OSError(ctypes.get_errno(),'renameat2')
print('archived')`;
function helper(program: string, args: string[], descriptors: number[], expected: string): void {
  const r = spawnSync("/usr/bin/python3", ["-I", "-c", program, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ...descriptors],
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096 });
  if (!r.error && !r.signal && r.status === 0 && !r.stderr && program === lockProgram && r.stdout === "busy\n")
    throw new HostedRetirementMutexError(HostedRetirementMutexFailure.Busy);
  if (r.error || r.signal || r.status !== 0 || r.stderr || r.stdout !== expected + "\n") held();
}

/** Fixed purpose only. Not exported by the provider index; no caller path,
 * descriptor list, policy registration, PID/age reclaim or store-lock recovery. */
export class HostedRemovalRetirementMutex {
  private witnessBytes: Buffer | undefined;
  private closed = false;
  private archived = false;
  private archive: Pin | undefined;
  private constructor(private readonly boot: string, private readonly parent: Pin, private readonly directory: Pin) {}
  static open(boot: string, existing: boolean): HostedRemovalRetirementMutex {
    if (process.platform !== "linux" || statfsSync(root, { bigint: true }).type !== 0xef53n)
      throw new HostedRetirementMutexError(HostedRetirementMutexFailure.Unsupported);
    if (!uuid.test(boot)) held();
    const parent = pin(root), name = `readonly-epoch.${boot}.lock`, path = `${root}/${name}`;
    let directory: Pin | undefined;
    try {
      if (!existing) { try { mkdirSync(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HostedRetirementMutexError(HostedRetirementMutexFailure.Busy); throw e; } }
      directory = pin(path);if(directory.stat.dev!==parent.stat.dev)held();
      helper(lockProgram, [], [directory.fd], "locked");
      const result = new HostedRemovalRetirementMutex(boot, parent, directory); result.check();
      if (existing) result.readWitness(); return result;
    } catch (e) { if (directory) closeSync(directory.fd); closeSync(parent.fd); throw e; }
  }
  /** Post-rename process-crash acknowledgment only. Matching existing refs select
   * immutable original archive; this never claims/deletes canonical namespace. */
  static openArchived(boot:string,refs:HostedRemovalRetirementReferences):HostedRemovalRetirementMutex|undefined {
    validateReferences(refs);if(!uuid.test(boot))held();
    try { lstatSync(archiveRoot); } catch(e) { if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw e; }
    if(process.platform!=="linux" || statfsSync(root,{bigint:true}).type!==0xef53n)
      throw new HostedRetirementMutexError(HostedRetirementMutexFailure.Unsupported);
    const parent=pin(root);let archive:Pin;
    try{archive=pin(archiveRoot);}catch(e){closeSync(parent.fd);throw e;}
    let selected:HostedRemovalRetirementMutex|undefined;
    try {
      if(archive.stat.dev!==parent.stat.dev)held();
      const names=readdirSync(`/proc/self/fd/${archive.fd}`);if(names.length>4096)held();
      for(const name of names) {
        if(!uuid.test(name))held();const directory=pin(`${archiveRoot}/${name}`);
        try {
          if(directory.stat.dev!==archive.stat.dev)held();
          const candidate=new HostedRemovalRetirementMutex(boot,parent,directory);candidate.archive=archive;candidate.archived=true;
          const witness=candidate.loadWitness(false);
          if(witness.acquisitionId!==name)held();
          if(witness.bootId===boot && equal({claim:witness.claim,actor:witness.actor,lock:witness.lock,completion:witness.completion},refs)) {
            if(selected)held();selected=candidate;
          } else closeSync(directory.fd);
        }catch(e){if(selected?.directory!==directory)closeSync(directory.fd);throw e;}
      }
      if(!selected){closeSync(archive.fd);closeSync(parent.fd);return undefined;}
      helper(lockProgram,[],[selected.directory.fd],"locked");selected.readWitness();return selected;
    }catch(e){if(selected)closeSync(selected.directory.fd);closeSync(archive.fd);closeSync(parent.fd);throw e;}
  }
  acknowledgeArchived():void {
    if(!this.archived || !this.archive)held();this.readWitness();
    fsyncSync(this.directory.fd);fsyncSync(this.parent.fd);fsyncSync(this.archive.fd);this.readWitness();
  }
  check(): void { if (this.closed) held(); validatePin(this.parent); validatePin(this.directory); if (this.archive) validatePin(this.archive); }
  ownsDescriptor(fd: number): boolean {
    this.check(); return [this.parent, this.directory, this.archive].some(p => p?.fd === fd);
  }
  publishWitness(refs: HostedRemovalRetirementReferences): HostedRemovalRetirementWitness {
    this.check(); if (this.witnessBytes) held(); validateReferences(refs);
    const witness = parseWitness({ version: 1, purpose: "retire_completed_dependency_removal_v1", acquisitionId: randomUUID(),
      bootId: this.boot, parent: identity(this.parent.stat), mutex: identity(this.directory.stat), ...refs }), bytes = encode(witness),
      fd = openSync(`/proc/self/fd/${this.directory.fd}/owner.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { const s = fstatSync(fd, { bigint: true }); if (!s.isFile() || s.uid !== 0n || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o600n) held();
      writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncSync(this.directory.fd); fsyncSync(this.parent.fd); this.witnessBytes = bytes; return this.readWitness();
  }
  readWitness(): HostedRemovalRetirementWitness { return this.loadWitness(true); }
  private loadWitness(requireBoot:boolean):HostedRemovalRetirementWitness {
    this.check(); if (!equal(readdirSync(`/proc/self/fd/${this.directory.fd}`).sort(), ["owner.json"])) held();
    const path = `/proc/self/fd/${this.directory.fd}/owner.json`, fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try { const before = fstatSync(fd, { bigint: true }); if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n ||
      (before.mode & 0o7777n) !== 0o600n || before.size < 1n || before.size > 16384n) held();
      bytes = readFileSync(fd); const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
      if (!same(before, after) || !same(before, named) || before.size !== BigInt(bytes.length) || after.size !== before.size ||
        before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== named.ctimeNs ||
        [after, named].some(s => s.uid !== 0n || s.nlink !== 1n || (s.mode & 0o7777n) !== 0o600n || s.size !== before.size || s.mtimeNs !== before.mtimeNs)) held();
    } finally { closeSync(fd); }
    const witness = parseWitness(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (!bytes.equals(encode(witness)) || this.witnessBytes && !this.witnessBytes.equals(bytes) || requireBoot && witness.bootId !== this.boot ||
      !equal(witness.parent, identity(this.parent.stat)) || !equal(witness.mutex, identity(this.directory.stat))) held();
    this.witnessBytes = bytes; this.check(); return witness;
  }
  archiveCompleted(): void {
    const witness = this.readWitness(); if (this.archived) held();
    try { mkdirSync(`/proc/self/fd/${this.parent.fd}/activation-fence-retired`, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    this.archive = pin(archiveRoot); this.check();
    if (this.archive.stat.dev !== this.directory.stat.dev) held();
    try { helper(archiveProgram, [`readonly-epoch.${this.boot}.lock`, witness.acquisitionId], [this.parent.fd, this.archive.fd], "archived"); }
    catch (error) {
      // Uncertain helper result: reconcile ONLY the original exact archived inode,
      // not canonical (a replacement generation may already exist there).
      const moved = lstatSync(`/proc/self/fd/${this.archive.fd}/${witness.acquisitionId}`, { bigint: true });
      if (!moved.isDirectory() || !same(moved, this.directory.stat)) throw error;
    }
    // Never cleanup canonical here: it may already be a DIFFERENT generation.
    this.directory.path = `${archiveRoot}/${witness.acquisitionId}`; this.archived = true;
    fsyncSync(this.parent.fd); fsyncSync(this.archive.fd); this.readWitness(); this.check();
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const p of [this.archive, this.directory, this.parent]) if (p) closeSync(p.fd);
  }
}
