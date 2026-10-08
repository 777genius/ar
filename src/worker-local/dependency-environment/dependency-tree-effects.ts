import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, type BigIntStats } from "node:fs";
import { lstat, open, readFile, rename, rmdir, statfs, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { DependencyReceiptState, sameDependencyTree, sameDependencyWorkspace,
  type DependencyTreeIdentity, type DependencyTrashIntent, type DependencyWorkspaceIdentity } from "../../worker-core/dependency-environment/domain/dependency-receipt";
import { parseDependencyReceipt, DependencyReceiptParseStatus } from "../../worker-core/dependency-environment/domain/parse-dependency-receipt";
import { DependencyManifestEntryKind as Kind, DependencyTreeObservationStatus as Status, encodeDependencyTreeManifest,
  type DependencyCapturedTreeObservation, type DependencyManifestEntry, type DependencyTreeObservationLimits } from "../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import type { DependencyLogicalSourceLink } from "../../worker-core/dependency-environment/domain/dependency-tree-manifest";
import { dependencySourceLinkEffectProof, DependencySourceLinkEffectProofKind, readDependencySourceLinkSession, type DependencySourceLinkSession } from "./dependency-source-binding";
import { observeDependencyDirectoryRoot } from "./observe-dependency-tree";
import { observeDependencyPinnedFile } from "./observe-dependency-pinned-file";

export enum DependencyTreeEffectFailure { Unsupported = "unsupported", Conflict = "conflict", IdentityChanged = "identity_changed",
  ManifestMismatch = "manifest_mismatch", InvalidCommit = "invalid_commit", Bounds = "bounds", Closed = "closed" }
export class DependencyTreeEffectError extends Error {
  constructor(readonly reason: DependencyTreeEffectFailure) { super(`dependency_tree_effect:${reason}`); }
}
export type DependencyTreeEffectInput = {
  readonly workspace: DependencyWorkspaceIdentity; readonly trash: DependencyTrashIntent;
  readonly manifestCanonicalBytes: Uint8Array; readonly manifestDigest: string; readonly limits: DependencyTreeObservationLimits;
  readonly sourceLinkSession?: DependencySourceLinkSession;
};
export type ProtectedDependencyEvictionCommit = {
  /** Immutable protected canonical Absent receipt, published after invalidation.
   * Its identity/digest are read independently from the protected commit store. */
  readonly path: string; readonly identity: DependencyTreeIdentity; readonly sha256: string;
};
type Anchor = { handle: FileHandle; before: BigIntStats; mountId: string; parent?: Anchor; name?: Buffer };
/** Opaque, local effect-session facts. JSON or a copied object is never genuine. */
export type DependencyTreeEffectReferenceSession = Readonly<{ operationId: string }>;
type ReferenceDescriptor = { readonly fd: number; readonly dev: string; readonly ino: string; readonly flags: string; readonly mountId: string };
const referenceSessions = new WeakMap<object, { anchors: Anchors; input: DependencyTreeEffectInput;
  birth: string; descriptors: readonly ReferenceDescriptor[] }>();
function ownBirth(): string {
  const text = readFileSync("/proc/self/stat", "utf8"), start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  if (!start || !/^[0-9]+$/.test(start)) fail(DependencyTreeEffectFailure.Unsupported);
  return `${process.pid}:${start}`;
}
function referenceDescriptor(item: Anchor): ReferenceDescriptor {
  const stat = fstatSync(item.handle.fd, { bigint: true }), info = readFileSync(`/proc/self/fdinfo/${item.handle.fd}`, "utf8");
  const flags = /^flags:\s*([0-7]+)\s*$/m.exec(info)?.[1], mountId = /^mnt_id:\s*([0-9]+)\s*$/m.exec(info)?.[1];
  if (info.length > 65536 || !flags || !mountId || mountId !== item.mountId || !stat.isDirectory() || !stable(item.before, stat)) fail(DependencyTreeEffectFailure.IdentityChanged);
  return { fd: item.handle.fd, ...identity(stat), flags, mountId };
}
function referenceSession(anchors: Anchors, input: DependencyTreeEffectInput): DependencyTreeEffectReferenceSession {
  const session = Object.freeze({ operationId: input.trash.operationId });
  referenceSessions.set(session, { anchors, input, birth: ownBirth(), descriptors: anchors.retained.map(referenceDescriptor) });
  return session;
}
export function readDependencyTreeEffectReferenceAnchors(session: DependencyTreeEffectReferenceSession,
  expected: { workspace: DependencyWorkspaceIdentity; trashPath: string; operationId: string }): readonly ReferenceDescriptor[] {
  const retained = referenceSessions.get(session);
  if (!retained || !retained.anchors.retained.length) fail(DependencyTreeEffectFailure.Closed);
  retained.anchors.check();
  if (retained.birth !== ownBirth() || retained.input.trash.operationId !== expected.operationId ||
      !sameDependencyWorkspace(retained.input.workspace, expected.workspace) ||
      `${retained.input.trash.destinationParent.canonicalPath}/${retained.input.trash.destinationName}` !== expected.trashPath ||
      retained.anchors.retained.length !== retained.descriptors.length) fail(DependencyTreeEffectFailure.IdentityChanged);
  const current = retained.anchors.retained.map(referenceDescriptor);
  if (JSON.stringify(current) !== JSON.stringify(retained.descriptors)) fail(DependencyTreeEffectFailure.IdentityChanged);
  return current;
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const pathFlags = 0x200000 | constants.O_NOFOLLOW;
const key = (path: readonly string[]): string => JSON.stringify(path);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
function fail(reason: DependencyTreeEffectFailure): never { throw new DependencyTreeEffectError(reason); }
const identity = (s: BigIntStats): DependencyTreeIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
const stable = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const anchored = (parent: Anchor, name: Buffer): Buffer => Buffer.concat([Buffer.from(`/proc/self/fd/${parent.handle.fd}/`), name]);
const detach = (input: DependencyTreeEffectInput): DependencyTreeEffectInput => ({ workspace: { ...input.workspace },
  trash: { ...input.trash, originalTree: { ...input.trash.originalTree }, destinationParent: { ...input.trash.destinationParent } },
  manifestCanonicalBytes: Buffer.from(input.manifestCanonicalBytes), manifestDigest: input.manifestDigest, limits: { ...input.limits },
  ...(input.sourceLinkSession ? { sourceLinkSession: input.sourceLinkSession } : {}) });
async function mount(handle: FileHandle): Promise<string> {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8"), id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id || info.length > 65536) fail(DependencyTreeEffectFailure.Unsupported); return id;
}
function mountSync(fd: number): string {
  const info = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"), id = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!id || info.length > 65536) fail(DependencyTreeEffectFailure.Unsupported); return id;
}
function component(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value || bytes.includes(0) || bytes.includes(47) ||
      bytes.equals(Buffer.from(".")) || bytes.equals(Buffer.from("..")) || bytes.equals(Buffer.from(".git"))) fail(DependencyTreeEffectFailure.Unsupported);
  return bytes;
}
/** Exact target join for a genuine compared protected session. Detached
 * comparison authority was independently authenticated by its store opener. */
function sourceProof(input: DependencyTreeEffectInput, detached = false) {
  if (!input.sourceLinkSession) fail(DependencyTreeEffectFailure.ManifestMismatch);
  const proof = dependencySourceLinkEffectProof(input.sourceLinkSession);
  if (proof.kind === DependencySourceLinkEffectProofKind.InstalledLocal) return proof.record;
  readDependencySourceLinkSession(input.sourceLinkSession,
    detached ? input.trash.destinationParent : input.workspace, detached ? input.trash.destinationName : "node_modules");
  return { ...proof.record.candidate, sourceLinks: proof.record.sourceLinks };
}
function manifest(input: DependencyTreeEffectInput, detached = false): Map<string, DependencyManifestEntry> {
  if (!input.manifestCanonicalBytes.length || input.manifestCanonicalBytes.length > input.limits.maxManifestBytes ||
      digest(input.manifestCanonicalBytes) !== input.manifestDigest) fail(DependencyTreeEffectFailure.ManifestMismatch);
  let value: { version: number; entries: DependencyManifestEntry[]; sourceLinks?: DependencyLogicalSourceLink[] };
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.manifestCanonicalBytes)); }
  catch { fail(DependencyTreeEffectFailure.ManifestMismatch); }
  if (!value || ![1, 2].includes(value.version) || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > input.limits.maxEntries ||
      Object.keys(value).sort().join(",") !== (value.version === 1 ? "entries,version" : "entries,sourceLinks,version")) fail(DependencyTreeEffectFailure.ManifestMismatch);
  if (value.version === 2) {
    if (!input.sourceLinkSession || !Array.isArray(value.sourceLinks)) fail(DependencyTreeEffectFailure.ManifestMismatch);
    const record = sourceProof(input, detached);
    if (record.manifestDigest !== input.manifestDigest || !sameDependencyWorkspace(record.workspace, input.workspace) ||
        !sameDependencyTree(record.tree, input.trash.originalTree) ||
        JSON.stringify(record.sourceLinks) !== JSON.stringify(value.sourceLinks)) fail(DependencyTreeEffectFailure.ManifestMismatch);
  } else if (input.sourceLinkSession) fail(DependencyTreeEffectFailure.ManifestMismatch);
  const result = new Map<string, DependencyManifestEntry>();
  for (const entry of value.entries) {
    if (!entry || !Array.isArray(entry.path) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777 ||
        !Object.values(Kind).includes(entry.kind)) fail(DependencyTreeEffectFailure.ManifestMismatch);
    for (const part of entry.path) { if (typeof part !== "string") fail(DependencyTreeEffectFailure.ManifestMismatch); component(part); }
    if (result.has(key(entry.path))) fail(DependencyTreeEffectFailure.ManifestMismatch);
    if (entry.kind === Kind.File && (typeof entry.size !== "string" || typeof entry.sha256 !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(entry.size) || !/^[a-f0-9]{64}$/.test(entry.sha256))) fail(DependencyTreeEffectFailure.ManifestMismatch);
    if (entry.kind === Kind.Symlink && (typeof entry.target !== "string" || Buffer.from(entry.target, "base64").toString("base64") !== entry.target)) fail(DependencyTreeEffectFailure.ManifestMismatch);
    result.set(key(entry.path), entry);
  }
  if (result.get("[]")?.kind !== Kind.Directory ||
      !Buffer.from(encodeDependencyTreeManifest(value.entries, value.sourceLinks)).equals(Buffer.from(input.manifestCanonicalBytes))) fail(DependencyTreeEffectFailure.ManifestMismatch);
  for (const entry of result.values()) {
    if (entry.path.length && result.get(key(entry.path.slice(0, -1)))?.kind !== Kind.Directory) fail(DependencyTreeEffectFailure.ManifestMismatch);
  }
  return result;
}
function validate(input: DependencyTreeEffectInput): void {
  if (process.platform !== "linux" || !Object.values(input.limits).every(n => Number.isSafeInteger(n) && n > 0) ||
      Object.keys(input.limits).length !== 4 || input.workspace.canonicalPath === "/" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.trash.operationId) ||
      input.trash.destinationName !== `dependency-${input.trash.operationId}` || input.trash.destinationParent.dev !== input.workspace.dev ||
      input.trash.originalTree.dev !== input.workspace.dev || sameDependencyTree(input.workspace, input.trash.destinationParent) ||
      sameDependencyTree(input.trash.originalTree, input.trash.destinationParent) ||
      input.trash.destinationParent.canonicalPath === input.workspace.canonicalPath ||
      input.trash.destinationParent.canonicalPath.startsWith(input.workspace.canonicalPath + "/")) fail(DependencyTreeEffectFailure.Unsupported);
}
class Anchors {
  readonly retained: Anchor[] = [];
  readonly deadline: number;
  private uncertainCloseFailures = 0;
  constructor(readonly limits: DependencyTreeObservationLimits) { this.deadline = performance.now() + limits.maxDurationMs; }
  check(): void { if (performance.now() > this.deadline) fail(DependencyTreeEffectFailure.Bounds); }
  async retain(path: string | Buffer, parent?: Anchor, name?: Buffer): Promise<Anchor> {
    this.check(); const before = await lstat(path, { bigint: true });
    if (!before.isDirectory()) fail(DependencyTreeEffectFailure.Unsupported);
    const handle = await open(path, directoryFlags);
    try {
      if (!stable(before, await handle.stat({ bigint: true }))) fail(DependencyTreeEffectFailure.IdentityChanged);
      const item: Anchor = { handle, before, mountId: await mount(handle), ...(parent ? { parent } : {}), ...(name ? { name } : {}) };
      this.retained.push(item); return item;
    } catch (error) { await handle.close(); throw error; }
  }
  async path(path: string, expected: DependencyWorkspaceIdentity): Promise<Anchor> {
    if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0") || path.split("/").includes(".git") ||
        Buffer.from(path).toString() !== path) fail(DependencyTreeEffectFailure.Unsupported);
    let current = await this.retain("/");
    for (const part of path.split("/").filter(Boolean)) {
      const name = Buffer.from(part); current = await this.retain(anchored(current, name), current, name);
    }
    if (!sameDependencyTree(identity(current.before), expected)) fail(DependencyTreeEffectFailure.IdentityChanged);
    return current;
  }
  async verify(items = this.retained): Promise<void> {
    for (const item of items) {
      this.check();
      if (!stable(item.before, await item.handle.stat({ bigint: true })) || await mount(item.handle) !== item.mountId) fail(DependencyTreeEffectFailure.IdentityChanged);
      if (item.parent && item.name) {
        const fresh = await open(anchored(item.parent, item.name), directoryFlags);
        try { if (!stable(item.before, await fresh.stat({ bigint: true })) || await mount(fresh) !== item.mountId) fail(DependencyTreeEffectFailure.IdentityChanged); }
        finally { await fresh.close(); }
      }
    }
  }
  verifySync(items = this.retained): void {
    for (const item of items) {
      this.check();
      if (!stable(item.before, fstatSync(item.handle.fd, { bigint: true })) || mountSync(item.handle.fd) !== item.mountId) fail(DependencyTreeEffectFailure.IdentityChanged);
      if (item.parent && item.name) {
        const fresh = openSync(anchored(item.parent, item.name), directoryFlags | constants.O_NONBLOCK);
        let failed = false;
        try { if (!stable(item.before, fstatSync(fresh, { bigint: true })) || mountSync(fresh) !== item.mountId) fail(DependencyTreeEffectFailure.IdentityChanged); }
        catch (error) { failed = true; throw error; }
        finally { this.closeTemporary(fresh, failed); }
      }
    }
  }
  closeTemporary(fd: number, priorFailure: boolean): void {
    try { closeSync(fd); } catch (error) {
      this.uncertainCloseFailures++; // Never retry an uncertain numeric FD that could have been reused.
      if (!priorFailure) throw error; // Preserve the original failed submission.
    }
  }
  async close(): Promise<{ readonly closeFailures: number }> {
    for (const item of this.retained.splice(0).reverse()) { try { await item.handle.close(); } catch { this.uncertainCloseFailures++; } }
    return { closeFailures: this.uncertainCloseFailures }; // Cleanup facts never replace an effect outcome.
  }
}
async function protectTrash(parent: Anchor): Promise<void> {
  if ((parent.before.mode & 0o7777n) !== 0o700n || parent.before.uid !== BigInt(process.geteuid!())) fail(DependencyTreeEffectFailure.Unsupported);
}
async function observe(input: DependencyTreeEffectInput, parent: Anchor, name: string,
  original: Map<string, DependencyManifestEntry>, subset: boolean): Promise<Extract<DependencyCapturedTreeObservation, { status: Status.Complete }>> {
  const result = await observeDependencyDirectoryRoot({ parentPath: name === "node_modules" ? input.workspace.canonicalPath : input.trash.destinationParent.canonicalPath,
    name, expectedTree: input.trash.originalTree, limits: input.limits,
    ...(input.sourceLinkSession ? { sourceLinkSession: input.sourceLinkSession } : {}) });
  if (result.status !== Status.Complete || result.mountId !== parent.mountId) fail(DependencyTreeEffectFailure.ManifestMismatch);
  if (!subset && result.digest !== input.manifestDigest) fail(DependencyTreeEffectFailure.ManifestMismatch);
  for (const entry of result.entries) if (JSON.stringify(entry) !== JSON.stringify(original.get(key(entry.path)))) fail(DependencyTreeEffectFailure.ManifestMismatch);
  return result;
}
async function absent(parent: Anchor, name: Buffer): Promise<void> {
  try { await lstat(anchored(parent, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  fail(DependencyTreeEffectFailure.Conflict);
}

/** Requires actual caller-enforced exclusion of source mutations AND destination
 * name creators. Protected mode and DTOs do not authenticate that authority.
 * Node has no atomic NOREPLACE rename: other writers make this Unsupported.
 * No overwrite or path-only fallback is provided for an uncontrolled boundary.
 */
export async function openDependencyTreeRename(request: DependencyTreeEffectInput): Promise<{
  readonly referenceSession: DependencyTreeEffectReferenceSession;
  rename(): Promise<{ readonly tree: DependencyTreeIdentity; readonly manifestDigest: string }>;
  prepareSynchronousRename(): Promise<Readonly<{ referenceSession:DependencyTreeEffectReferenceSession; commit(): { readonly tree: DependencyTreeIdentity; readonly manifestDigest: string } }>>;
  close(): Promise<{ readonly closeFailures: number }>;
}> {
  const input = detach(request); validate(input); const original = manifest(input), anchors = new Anchors(input.limits);
  let finished = false, closed = false, preparationFailed = false, running: Promise<void> | undefined, preparing: Promise<Readonly<{referenceSession:DependencyTreeEffectReferenceSession;commit():{tree:DependencyTreeIdentity;manifestDigest:string}}>> | undefined;
  try {
    if ((await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) fail(DependencyTreeEffectFailure.Unsupported);
    const source = await anchors.path(input.workspace.canonicalPath, input.workspace), destination = await anchors.path(input.trash.destinationParent.canonicalPath, input.trash.destinationParent);
    await protectTrash(destination);
    if (source.mountId !== destination.mountId) fail(DependencyTreeEffectFailure.Unsupported);
    await observe(input, source, "node_modules", original, false);
    const tree = await anchors.retain(anchored(source, Buffer.from("node_modules")), source, Buffer.from("node_modules"));
    if (!sameDependencyTree(identity(tree.before), input.trash.originalTree) || tree.mountId !== source.mountId) fail(DependencyTreeEffectFailure.IdentityChanged);
    const target = Buffer.from(input.trash.destinationName);
    await absent(destination, target); await anchors.verify();
    const prepare = async () => {
      if(finished || closed || preparationFailed || !anchors.retained.length)fail(DependencyTreeEffectFailure.Closed);
      finished=true; // Preparation owns this exact one-use physical session.
      preparing=(async()=>{
        await anchors.verify();const current=await observe(input,source,"node_modules",original,false);
        await anchors.verify();await absent(destination,target);
        const captured=new Map(current.identities.map(item=>[key(item.path),item])),directories=new Map<string,Anchor>([["[]",tree]]);
        for(const entry of current.entries.filter(item=>item.kind===Kind.Directory && item.path.length)) {
          const parent=directories.get(key(entry.path.slice(0,-1)));if(!parent)fail(DependencyTreeEffectFailure.ManifestMismatch);
          const name=component(entry.path[entry.path.length-1]!),dir=await anchors.retain(anchored(parent,name),parent,name);
          if(!sameDependencyTree(identity(dir.before),captured.get(key(entry.path))!.identity) || dir.mountId!==tree.mountId)fail(DependencyTreeEffectFailure.IdentityChanged);
          directories.set(key(entry.path),dir);
        }
        await anchors.verify();let submitted=false;
        return Object.freeze({referenceSession:referenceSession(anchors,input),commit() {
          if(closed || preparationFailed || submitted || !anchors.retained.length)fail(DependencyTreeEffectFailure.Closed);
          submitted=true; // Failure/uncertain publication cannot be replayed.
          try {
            anchors.verifySync();if(input.sourceLinkSession)sourceProof(input);
            for(const entry of current.entries) {
              anchors.check();const parent=entry.path.length ? directories.get(key(entry.path.slice(0,-1)))! : source,
                name=entry.path.length ? component(entry.path[entry.path.length-1]!) : Buffer.from("node_modules"),path=anchored(parent,name);
              const fd=openSync(path,pathFlags);let failed=false;
              try {
                const info=fstatSync(fd,{bigint:true});
                if(!sameDependencyTree(identity(info),captured.get(key(entry.path))!.identity) || (info.mode&0o7777n)!==BigInt(entry.mode) ||
                    mountSync(fd)!==tree.mountId || !info.isDirectory() && info.nlink!==1n)fail(DependencyTreeEffectFailure.IdentityChanged);
                if(entry.kind===Kind.File) {
                  if(!info.isFile() || info.size!==BigInt(entry.size) || info.size>BigInt(input.limits.maxTotalBytes))fail(DependencyTreeEffectFailure.ManifestMismatch);
                  const file=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let fileFailed=false;
                  try {
                    const before=fstatSync(file,{bigint:true});
                    if(!stable(info,before) || before.size!==info.size || mountSync(file)!==tree.mountId)fail(DependencyTreeEffectFailure.IdentityChanged);
                    const bytes=Buffer.alloc(65536),hash=createHash("sha256");let length=0;
                    while(length<=Number(before.size)) {
                      anchors.check();const count=readSync(file,bytes,0,Math.min(bytes.length,Number(before.size)-length+1),length);
                      if(!count)break;hash.update(bytes.subarray(0,count));length+=count;
                      if(BigInt(length)>before.size)fail(DependencyTreeEffectFailure.ManifestMismatch);
                    }
                    const after=fstatSync(file,{bigint:true});
                    if(BigInt(length)!==before.size || hash.digest("hex")!==entry.sha256 || !stable(before,after) ||
                        before.size!==after.size || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs)fail(DependencyTreeEffectFailure.ManifestMismatch);
                  }catch(error){fileFailed=true;throw error;}finally{anchors.closeTemporary(file,fileFailed);}
                }else if(entry.kind===Kind.Symlink) {
                  if(!info.isSymbolicLink() || readlinkSync(path,{encoding:"buffer"}).toString("base64")!==entry.target)fail(DependencyTreeEffectFailure.ManifestMismatch);
                }else {
                  if(!info.isDirectory())fail(DependencyTreeEffectFailure.ManifestMismatch);
                  const names=readdirSync(path,{encoding:"buffer"}).map(v=>v.toString("base64")).sort(),
                    expected=current.entries.filter(v=>v.path.length===entry.path.length+1 && key(v.path.slice(0,-1))===key(entry.path)).map(v=>v.path[v.path.length-1]!).sort();
                  if(JSON.stringify(names)!==JSON.stringify(expected))fail(DependencyTreeEffectFailure.ManifestMismatch);
                }
                const after=lstatSync(path,{bigint:true});
                if(!stable(info,after) || info.nlink!==after.nlink || info.size!==after.size || info.mtimeNs!==after.mtimeNs || info.ctimeNs!==after.ctimeNs)fail(DependencyTreeEffectFailure.IdentityChanged);
              }catch(error){failed=true;throw error;}finally{anchors.closeTemporary(fd,failed);}
            }
            anchors.verifySync();if(input.sourceLinkSession)sourceProof(input);
            try{lstatSync(anchored(destination,target));fail(DependencyTreeEffectFailure.Conflict);}
            catch(error){if(!(error instanceof Error) || !("code" in error) || error.code!=="ENOENT")throw error;}
            renameSync(anchored(source,Buffer.from("node_modules")),anchored(destination,target));
            const moved=openSync(anchored(destination,target),directoryFlags|constants.O_NONBLOCK);let failed=false;
            try{if(!stable(tree.before,fstatSync(moved,{bigint:true})) || mountSync(moved)!==destination.mountId)fail(DependencyTreeEffectFailure.IdentityChanged);}
            catch(error){failed=true;throw error;}finally{anchors.closeTemporary(moved,failed);}
            try{lstatSync(anchored(source,Buffer.from("node_modules")));fail(DependencyTreeEffectFailure.Conflict);}
            catch(error){if(!(error instanceof Error) || !("code" in error) || error.code!=="ENOENT")throw error;}
            // Retained descendant FDs remain the same tree under its new name;
            // named checks now run relative to the relocated actual tree FD.
            anchors.verifySync(anchors.retained.filter(item=>item!==tree));
            fsyncSync(source.handle.fd);fsyncSync(destination.handle.fd);
            return {tree:identity(tree.before),manifestDigest:input.manifestDigest};
          }catch(error){preparationFailed=true;throw error;}
        }});
      })();
      try{return await preparing;}catch(error){preparationFailed=true;await anchors.close();throw error;}finally{preparing=undefined;}
    };
    return { referenceSession: referenceSession(anchors, input), prepareSynchronousRename:prepare, async rename() {
      if (finished || anchors.retained.length === 0) fail(DependencyTreeEffectFailure.Closed);
      finished = true; // Single-use, including an uncertain or failed publication.
      let settle!: () => void; running = new Promise<void>(done => { settle = done; });
      try {
      await anchors.verify(); await observe(input, source, "node_modules", original, false); await anchors.verify(); await absent(destination, target);
      if (input.sourceLinkSession) sourceProof(input);
      await rename(anchored(source, Buffer.from("node_modules")), anchored(destination, target));
      finished = true; // Any post-publication error preserves intent for reconciliation.
      const moved = await open(anchored(destination, target), directoryFlags);
      try { if (!stable(tree.before, await moved.stat({ bigint: true })) || await mount(moved) !== destination.mountId) fail(DependencyTreeEffectFailure.IdentityChanged); }
      finally { await moved.close(); }
      await absent(source, Buffer.from("node_modules")); await anchors.verify(anchors.retained.filter(a => a !== tree));
      await source.handle.sync(); await destination.handle.sync();
      return { tree: identity(tree.before), manifestDigest: input.manifestDigest };
      } finally { settle(); }
    }, async close() { closed=true;finished = true; await preparing?.then(()=>undefined,()=>undefined);await running; return anchors.close(); } };
  } catch (error) { await anchors.close(); throw error; }
}

async function committed(input: DependencyTreeEffectInput, commit: ProtectedDependencyEvictionCommit, anchors: Anchors): Promise<Anchor> {
  if (commit.path.startsWith(input.workspace.canonicalPath + "/") ||
      commit.path.startsWith(`${input.trash.destinationParent.canonicalPath}/${input.trash.destinationName}/`) ||
      !/^[a-f0-9]{64}$/.test(commit.sha256)) fail(DependencyTreeEffectFailure.InvalidCommit);
  const parentPath = dirname(commit.path), info = await lstat(parentPath, { bigint: true });
  const parent = await anchors.path(parentPath, { canonicalPath: parentPath, ...identity(info) }); await protectTrash(parent);
  const observed = await observeDependencyPinnedFile({ path: commit.path, maxBytes: 16384, maxDurationMs: input.limits.maxDurationMs });
  if (observed.status !== Status.Complete || !sameDependencyTree(observed.identity, commit.identity) || observed.sha256 !== commit.sha256 || observed.mountId !== parent.mountId) fail(DependencyTreeEffectFailure.InvalidCommit);
  const file = await open(anchored(parent, Buffer.from(basename(commit.path))), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.size < 1n || stat.size > 16384n || (stat.mode & 0o7777n) !== 0o600n || stat.uid !== BigInt(process.geteuid!()) || stat.nlink !== 1n ||
        !sameDependencyTree(identity(stat), commit.identity) || await mount(file) !== parent.mountId) fail(DependencyTreeEffectFailure.InvalidCommit);
    const buffer = Buffer.alloc(16385), read = await file.read(buffer, 0, buffer.length, 0); anchors.check();
    if (BigInt(read.bytesRead) !== stat.size) fail(DependencyTreeEffectFailure.InvalidCommit);
    const bytes = buffer.subarray(0, read.bytesRead); if (digest(bytes) !== commit.sha256) fail(DependencyTreeEffectFailure.InvalidCommit);
    const parsed = parseDependencyReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (parsed.status !== DependencyReceiptParseStatus.Valid) fail(DependencyTreeEffectFailure.InvalidCommit);
    const receipt = parsed.receipt;
    if (receipt.state !== DependencyReceiptState.Absent || !sameDependencyWorkspace(receipt.workspace, input.workspace) ||
        receipt.operationId !== input.trash.operationId || receipt.evictionCommit.manifestDigest !== input.manifestDigest ||
        !sameDependencyTree(receipt.evictionCommit.trash.originalTree, input.trash.originalTree) ||
        !sameDependencyWorkspace(receipt.evictionCommit.trash.destinationParent, input.trash.destinationParent) ||
        receipt.evictionCommit.trash.destinationName !== input.trash.destinationName) fail(DependencyTreeEffectFailure.InvalidCommit);
    if (input.sourceLinkSession) {
      const record = sourceProof(input, true);
      if (record.generation !== receipt.generation || record.coverageRevision !== receipt.coverageRevision || record.installKey !== receipt.installKey ||
          record.manifestDigest !== receipt.evictionCommit.manifestDigest || !sameDependencyTree(record.tree, receipt.evictionCommit.tree)) fail(DependencyTreeEffectFailure.InvalidCommit);
    }
    if (!stable(stat, await file.stat({ bigint: true }))) fail(DependencyTreeEffectFailure.InvalidCommit);
  } finally { await file.close(); }
  await anchors.verify();
  return parent;
}

/** Only a verified remaining subset of an independently captured original full
 * manifest is removable. Caller holds fenced/drained exclusive mutation through
 * every await; partial effects retain commit+trash, never mint Absent/Ready.
 */
export type DependencyCommittedTrashRemovalProgress = Readonly<{
  operationId: string; removedEntries: number; remainingEntries: number;
}>;
/** Physical effect session, never an authorization token. The hosted original
 * owner retains this exact session and supplies its own genuine fence at each
 * synchronous submission. No path, permission callback or FD list is accepted. */
export type DependencyCommittedTrashRemovalSteps = Readonly<{
  referenceSession: DependencyTreeEffectReferenceSession;
  progress(): DependencyCommittedTrashRemovalProgress;
  removeNext(): DependencyCommittedTrashRemovalProgress;
}>;
/** Separate name-negative observer for last-unlink recovery. It reports only
 * a durable absence fact; the host must join authenticated v2 intent, revoked
 * actor lifetime and actual owner before publishing recovered completion.
 * The ordinary removal opener still requires an existing named root. */
export async function openCommittedDependencyTrashAbsence(request: DependencyTreeEffectInput & {
  readonly commit: ProtectedDependencyEvictionCommit;
}): Promise<Readonly<{ referenceSession: DependencyTreeEffectReferenceSession; confirmAbsence(): Readonly<{ operationId: string }>;
  close(): Promise<{ readonly closeFailures: number }> }>> {
  const input = { ...detach(request), commit: { ...request.commit, identity: { ...request.commit.identity } } }, anchors = new Anchors(input.limits);
  validate(input); manifest(input, true); let closed = false, held = false;
  try {
    if ((await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) fail(DependencyTreeEffectFailure.Unsupported);
    const parent = await anchors.path(input.trash.destinationParent.canonicalPath, input.trash.destinationParent); await protectTrash(parent);
    const commitParent = await committed(input, input.commit, anchors); await anchors.verify();
    const name = Buffer.from(input.trash.destinationName), negative = () => {
      try { lstatSync(anchored(parent, name)); fail(DependencyTreeEffectFailure.Conflict); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    negative();
    const commitCurrent = () => {
      const path = anchored(commitParent, Buffer.from(basename(input.commit.path))), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let failed = false;
      try {
        const before = fstatSync(fd, { bigint: true }), buffer = Buffer.alloc(16385);
        if (!before.isFile() || before.size < 1n || before.size > 16384n || before.nlink !== 1n || before.uid !== BigInt(process.geteuid!()) ||
            (before.mode & 0o7777n) !== 0o600n || !sameDependencyTree(identity(before), input.commit.identity) || mountSync(fd) !== commitParent.mountId)
          fail(DependencyTreeEffectFailure.InvalidCommit);
        const count = readSync(fd, buffer, 0, buffer.length, 0), after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
        if (BigInt(count) !== before.size || digest(buffer.subarray(0, count)) !== input.commit.sha256 || !stable(before, after) || !stable(before, named) ||
            before.size !== after.size || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.nlink !== named.nlink ||
            before.size !== named.size || before.ctimeNs !== named.ctimeNs || before.mtimeNs !== named.mtimeNs)
          fail(DependencyTreeEffectFailure.InvalidCommit);
      } catch (error) { failed = true; throw error; }
      finally { anchors.closeTemporary(fd, failed); }
    };
    const session = referenceSession(anchors, input);
    return Object.freeze({ referenceSession: session, confirmAbsence() {
      if (closed || held) fail(DependencyTreeEffectFailure.Closed);
      try {
        anchors.verifySync(); commitCurrent(); negative(); fsyncSync(parent.handle.fd); anchors.verifySync(); commitCurrent(); negative();
        return Object.freeze({ operationId: input.trash.operationId });
      } catch (error) { held = true; throw error; }
    }, async close() { closed = true; return anchors.close(); } });
  } catch (error) { await anchors.close(); throw error; }
}
export async function openCommittedDependencyTrashRemoval(request: DependencyTreeEffectInput & {
  readonly commit: ProtectedDependencyEvictionCommit; readonly maxRemovals: number;
}): Promise<{
  remove(): Promise<{ readonly operationId: string; readonly removedEntries: number }>;
  prepareSynchronousRemoval(): Promise<DependencyCommittedTrashRemovalSteps>;
  close(): Promise<{ readonly closeFailures: number }>;
}> {
  const input = { ...detach(request), commit: { ...request.commit, identity: { ...request.commit.identity } }, maxRemovals: request.maxRemovals };
  validate(input); const original = manifest(input, true), anchors = new Anchors(input.limits);
  let closed = false, preparationFailed = false, running: Promise<void> | undefined, preparing: Promise<DependencyCommittedTrashRemovalSteps> | undefined;
  let steps: DependencyCommittedTrashRemovalSteps | undefined;
  if (!Number.isSafeInteger(input.maxRemovals) || input.maxRemovals < 1) fail(DependencyTreeEffectFailure.Bounds);
  try {
    if ((await statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) fail(DependencyTreeEffectFailure.Unsupported);
    const parent = await anchors.path(input.trash.destinationParent.canonicalPath, input.trash.destinationParent); await protectTrash(parent);
    const name = Buffer.from(input.trash.destinationName);
    const root = await anchors.retain(anchored(parent, name), parent, name);
    if (!sameDependencyTree(identity(root.before), input.trash.originalTree) || root.mountId !== parent.mountId) fail(DependencyTreeEffectFailure.IdentityChanged);
    await committed(input, input.commit, anchors); await observe(input, parent, input.trash.destinationName, original, true); await anchors.verify();
    const prepare = async (): Promise<DependencyCommittedTrashRemovalSteps> => {
      if (closed || preparationFailed || steps || preparing || !anchors.retained.length) fail(DependencyTreeEffectFailure.Closed);
      preparing = (async () => {
        await anchors.verify(); await committed(input, input.commit, anchors);
        const current = await observe(input, parent, input.trash.destinationName, original, true); await anchors.verify();
        const directories = new Map<string, Anchor>([["[]", root]]), captured = new Map(current.identities.map(item => [key(item.path), item]));
        for (const entry of current.entries.filter(e => e.kind === Kind.Directory && e.path.length > 0)) {
          const owner = directories.get(key(entry.path.slice(0, -1)))!;
          const part = component(entry.path[entry.path.length - 1]!);
          const dir = await anchors.retain(anchored(owner, part), owner, part);
          if (!sameDependencyTree(identity(dir.before), captured.get(key(entry.path))!.identity) || dir.mountId !== root.mountId) fail(DependencyTreeEffectFailure.IdentityChanged);
          directories.set(key(entry.path), dir);
        }
        await anchors.verify();
        // Every remaining leaf is inspected before any submission. No mount or
        // hardlink is exempted by this session or its factual reference handle.
        for (const entry of current.entries) {
          const owner = entry.path.length ? directories.get(key(entry.path.slice(0, -1)))! : parent;
          const path = entry.path.length ? anchored(owner, component(entry.path[entry.path.length - 1]!)) : anchored(parent, name);
          const pin = await open(path, pathFlags);
          try {
            const info = await pin.stat({ bigint: true });
            if (!sameDependencyTree(identity(info), captured.get(key(entry.path))!.identity) || (info.mode & 0o7777n) !== BigInt(entry.mode) ||
                await mount(pin) !== root.mountId || (!info.isDirectory() && info.nlink !== 1n)) fail(DependencyTreeEffectFailure.IdentityChanged);
          } finally { await pin.close(); }
        }
        await anchors.verify(); if (closed) fail(DependencyTreeEffectFailure.Closed);
        const pending = [...current.entries].reverse(), deleted = new Set<Anchor>(); let removed = 0, failed = false;
        const progress = (): DependencyCommittedTrashRemovalProgress => ({ operationId: input.trash.operationId, removedEntries: removed, remainingEntries: pending.length - removed });
        steps = Object.freeze({ referenceSession: referenceSession(anchors, input), progress() {
          if (closed || failed || !anchors.retained.length) fail(DependencyTreeEffectFailure.Closed);
          return progress(); // Recorded progress only; no IO or authority.
        }, removeNext() {
          if (closed || failed || !anchors.retained.length) fail(DependencyTreeEffectFailure.Closed);
          try {
          anchors.check(); anchors.verifySync(anchors.retained.filter(item => !deleted.has(item)));
          if (input.sourceLinkSession) sourceProof(input, true);
          const entry = pending[removed];
          if (!entry) return progress();
          if (removed >= input.maxRemovals) fail(DependencyTreeEffectFailure.Bounds);
          const owner = entry.path.length ? directories.get(key(entry.path.slice(0, -1)))! : parent;
          const path = entry.path.length ? anchored(owner, component(entry.path[entry.path.length - 1]!)) : anchored(parent, name);
          const pin = openSync(path, pathFlags); let pinFailure = false;
          try {
            const info = fstatSync(pin, { bigint: true });
            if (!sameDependencyTree(identity(info), captured.get(key(entry.path))!.identity) || (info.mode & 0o7777n) !== BigInt(entry.mode) || mountSync(pin) !== root.mountId)
              fail(DependencyTreeEffectFailure.IdentityChanged);
            if ((entry.kind === Kind.File && (!info.isFile() || info.nlink !== 1n)) || (entry.kind === Kind.Symlink && (!info.isSymbolicLink() || info.nlink !== 1n)) ||
                (entry.kind === Kind.Directory && !info.isDirectory())) fail(DependencyTreeEffectFailure.ManifestMismatch);
            if (entry.kind === Kind.File) {
              if (info.size !== BigInt(entry.size) || info.size > BigInt(input.limits.maxTotalBytes)) fail(DependencyTreeEffectFailure.ManifestMismatch);
              const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let fileFailure = false;
              try {
                const before = fstatSync(file, { bigint: true });
                if (!stable(info, before) || before.size !== info.size || mountSync(file) !== root.mountId) fail(DependencyTreeEffectFailure.IdentityChanged);
                const bytes = Buffer.alloc(65536), hash = createHash("sha256"); let length = 0;
                while (length <= Number(before.size)) {
                  const count = readSync(file, bytes, 0, Math.min(bytes.length, Number(before.size) - length + 1), length);
                  if (!count) break; hash.update(bytes.subarray(0, count)); length += count; anchors.check();
                  if (BigInt(length) > before.size) fail(DependencyTreeEffectFailure.ManifestMismatch);
                }
                const after = fstatSync(file, { bigint: true });
                if (BigInt(length) !== before.size || hash.digest("hex") !== entry.sha256 || !stable(before, after) ||
                    before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail(DependencyTreeEffectFailure.ManifestMismatch);
              } catch (error) { fileFailure = true; throw error; }
              finally { anchors.closeTemporary(file, fileFailure); }
            } else if (entry.kind === Kind.Symlink && readlinkSync(path, { encoding: "buffer" }).toString("base64") !== entry.target) fail(DependencyTreeEffectFailure.ManifestMismatch);
            // Recheck the named leaf immediately before the single synchronous
            // effect; caller exclusion remains necessary between observations.
            const named = lstatSync(path, { bigint: true });
            if (!stable(info, named) || named.nlink !== info.nlink || named.size !== info.size || named.mtimeNs !== info.mtimeNs || named.ctimeNs !== info.ctimeNs)
              fail(DependencyTreeEffectFailure.IdentityChanged);
            anchors.verifySync(anchors.retained.filter(item => !deleted.has(item)));
            if (entry.kind === Kind.Directory) { rmdirSync(path); deleted.add(directories.get(key(entry.path))!); } else unlinkSync(path);
            removed++; fsyncSync(owner.handle.fd);
          } catch (error) { pinFailure = true; throw error; }
          finally { anchors.closeTemporary(pin, pinFailure); }
          if (removed === pending.length) {
            try { lstatSync(anchored(parent, name)); fail(DependencyTreeEffectFailure.Conflict); }
            catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
            anchors.verifySync(anchors.retained.filter(item => !deleted.has(item))); fsyncSync(parent.handle.fd);
          }
          return progress();
          } catch (error) { failed = true; throw error; } // Uncertain step never authorizes a later effect.
        } });
        return steps;
      })();
      try { return await preparing; } catch (error) { preparationFailed = true; throw error; } finally { preparing = undefined; }
    };
    return {
      prepareSynchronousRemoval: prepare,
      async remove() {
        if (closed || preparationFailed || steps || preparing || running) fail(DependencyTreeEffectFailure.Closed);
        let settle!: () => void; running = new Promise<void>(done => { settle = done; });
        try {
          const prepared = await prepare(); let result = prepared.removeNext();
          while (result.remainingEntries) result = prepared.removeNext();
          return { operationId: result.operationId, removedEntries: result.removedEntries };
        } finally { settle(); }
      },
      async close() { closed = true; await preparing?.then(() => undefined, () => undefined); await running; return anchors.close(); },
    };
  } catch (error) { await anchors.close(); throw error; }
}
