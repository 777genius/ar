import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { SourceWorkerState, assertSourceWorkerSuccessor, type SourceWorkerRequestIdentity,
  type SourceWorkerRequestRecord, type SourceWorkerRevision, type SourceWorkerQuiescenceProof,
  type SourceWorkerRequestStorePort } from "@vioxen/subscription-runtime/worker-core";
import { durablePublishJsonFile, DurableJsonPublishStatus } from "./project-control-operation-file-store";
import { parseSourceWorkerIdentity, parseSourceWorkerRequestRecord } from "./source-worker-request-codec";

type FileIdentity = { readonly dev: number; readonly ino: number };
/** The installed broker supplies an authenticated custody receipt reader. The
 * request JSON itself, including supplied proof facts, grants no terminal authority. */
export type SourceWorkerTerminalProofReader = (record: SourceWorkerRequestRecord) => SourceWorkerQuiescenceProof;
export class SourceWorkerRequestStore implements SourceWorkerRequestStorePort {
  private readonly root: string;
  private readonly directories = new Map<string, FileIdentity>();
  private readonly files = new Map<string, FileIdentity & { readonly mtimeMs: number; readonly ctimeMs: number; readonly size: number }>();
  constructor(requestAuthorityRootDir: string, private readonly terminalProof?: SourceWorkerTerminalProofReader) {
    // Production composition selects the existing protected host-policy root.
    // A mutable project registry cannot own permanent no-replay authority.
    if (!isAbsolute(requestAuthorityRootDir) || normalize(requestAuthorityRootDir) !== requestAuthorityRootDir) invalid();
    this.inspectAncestors(requestAuthorityRootDir);
    this.root = join(requestAuthorityRootDir, "source-worker-requests");
    try { mkdirSync(this.root, { mode: 0o700 }); } catch (error) { if (!exists(error)) throw error; }
    this.inspectAncestors(this.root); this.syncAncestors(this.root);
  }
  async accept(value: SourceWorkerRequestIdentity): Promise<{ readonly created: boolean; readonly record: SourceWorkerRequestRecord }> {
    const identity = parseSourceWorkerIdentity(value), directory = this.directory(identity.workstreamId, identity.requestId);
    this.inspectAncestors(this.root);
    let fresh = false;
    try { mkdirSync(directory, { mode: 0o700 }); fresh = true; } catch (error) { if (!exists(error)) throw error; }
    this.inspectAncestors(directory); this.syncAncestors(directory);
    if (!fresh) {
      const record = await this.observeAccepted(identity.workstreamId, identity.requestId);
      if (!record || record.identity.fingerprint !== identity.fingerprint) throw new Error(record ? "source_worker_request_conflict" : "source_worker_publication_uncertain");
      return { created: false, record };
    }
    const record: SourceWorkerRequestRecord = { identity, revision: 1, state: SourceWorkerState.Reserved, outcome: null,
      brokerEpochId: null, runtimeStartId: null, sourceSpecSha256: null, terminationFenceSha256: null, terminalReceiptSha256: null };
    // A failed publication leaves this directory permanently occupied. Retrying
    // cannot convert an incomplete original accept into fresh dispatch authority.
    await this.publish(directory, record);
    return { created: true, record: (await this.read(identity.workstreamId, identity.requestId))! };
  }
  async read(workstreamId: string, requestId: string): Promise<SourceWorkerRequestRecord | null> {
    this.inspectAncestors(this.root);
    const directory = this.directory(workstreamId, requestId);
    try { this.inspectAncestors(directory); } catch (error) { if (missing(error)) return null; throw error; }
    const names = readdirSync(directory).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    if (!names.length || names.length > 256 || names.some(name => !/^[1-9][0-9]*\.json$/.test(name))) throw new Error("source_worker_publication_uncertain");
    let prior: SourceWorkerRequestRecord | undefined;
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== `${i + 1}.json`) throw new Error("source_worker_publication_uncertain");
      const record = this.readRecord(join(directory, names[i]!));
      if (record.revision !== i + 1 || record.identity.workstreamId !== workstreamId || record.identity.requestId !== requestId) invalid();
      if (prior) {
        if (record.identity.fingerprint !== prior.identity.fingerprint) invalid();
        assertSourceWorkerSuccessor(prior, record, record.state === SourceWorkerState.Terminal ? this.proof(record) : undefined);
      } else if (record.state !== SourceWorkerState.Reserved || record.outcome !== null || record.runtimeStartId !== null ||
        record.brokerEpochId !== null || record.sourceSpecSha256 !== null || record.terminationFenceSha256 !== null) invalid();
      prior = record;
    }
    this.inspectAncestors(directory); return prior!;
  }
  async list(workstreamId: string): Promise<readonly SourceWorkerRequestRecord[]> {
    this.directory(workstreamId, "list"); // Validate the declared finite ID, never a caller path.
    this.inspectAncestors(this.root);
    const names = readdirSync(this.root).sort(), records: SourceWorkerRequestRecord[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/.test(name)) invalid();
      const directory = join(this.root, name);
      this.inspectAncestors(directory);
      let original: SourceWorkerRequestRecord;
      try { original = this.readRecord(join(directory, "1.json")); }
      catch (error) { if (missing(error)) throw new Error("source_worker_publication_uncertain"); throw error; }
      if (this.directory(original.identity.workstreamId, original.identity.requestId) !== directory ||
          original.revision !== 1 || original.state !== SourceWorkerState.Reserved || original.outcome !== null ||
          original.runtimeStartId !== null || original.brokerEpochId !== null || original.sourceSpecSha256 !== null ||
          original.terminationFenceSha256 !== null) invalid();
      if (original.identity.workstreamId !== workstreamId) continue;
      const record = await this.read(workstreamId, original.identity.requestId);
      if (!record) throw new Error("source_worker_publication_uncertain");
      records.push(record);
    }
    this.inspectAncestors(this.root);
    if (JSON.stringify(readdirSync(this.root).sort()) !== JSON.stringify(names)) throw new Error("source_worker_publication_uncertain");
    return Object.freeze(records);
  }
  async revise(workstreamId: string, requestId: string, expectedRevision: number, next: SourceWorkerRevision,
    suppliedProof?: SourceWorkerQuiescenceProof): Promise<SourceWorkerRequestRecord> {
    const prior = await this.read(workstreamId, requestId);
    if (!prior || prior.revision !== expectedRevision || expectedRevision >= 256) throw new Error("source_worker_revision_conflict");
    const record = parseSourceWorkerRequestRecord({ ...next, identity: prior.identity, revision: expectedRevision + 1 });
    const proof = record.state === SourceWorkerState.Terminal ? this.proof(record) : undefined;
    if (suppliedProof && (!proof || Object.keys(suppliedProof).length !== Object.keys(proof).length ||
        Object.keys(proof).some(key => suppliedProof[key as keyof SourceWorkerQuiescenceProof] !== proof[key as keyof SourceWorkerQuiescenceProof]))) throw new Error("source_worker_terminal_proof_mismatch");
    assertSourceWorkerSuccessor(prior, record, proof);
    const directory = this.directory(workstreamId, requestId);
    await this.publish(directory, record);
    return (await this.read(workstreamId, requestId))!;
  }
  private async observeAccepted(workstreamId: string, requestId: string): Promise<SourceWorkerRequestRecord | null> {
    // A concurrent accept may still be syncing its first inode. Observe only;
    // timeout leaves the original ID occupied and grants no replacement dispatch.
    for (let attempt = 0;; attempt++) {
      try { return await this.read(workstreamId, requestId); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "source_worker_publication_uncertain" || attempt >= 20) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    }
  }
  private proof(record: SourceWorkerRequestRecord): SourceWorkerQuiescenceProof {
    if (!this.terminalProof) throw new Error("source_worker_terminal_authority_required");
    return this.terminalProof(record);
  }
  private directory(workstreamId: string, requestId: string): string {
    if (![workstreamId, requestId].every(id => /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(id))) invalid();
    return join(this.root, createHash("sha256").update(JSON.stringify([workstreamId, requestId])).digest("hex"));
  }
  private async publish(directory: string, record: SourceWorkerRequestRecord): Promise<void> {
    this.inspectAncestors(directory);
    const path = join(directory, `${record.revision}.json`);
    const status = await durablePublishJsonFile({ path, value: record });
    this.inspectAncestors(directory); this.syncAncestors(directory);
    const retained = this.readRecord(path);
    if (JSON.stringify(retained) !== JSON.stringify(record)) throw new Error("source_worker_revision_conflict");
    // Never reinterpret a concurrent successor or uncertain write as a fresh effect.
    if (status !== DurableJsonPublishStatus.Published) throw new Error("source_worker_revision_conflict");
  }
  private readRecord(path: string): SourceWorkerRequestRecord {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd), previous = this.files.get(path);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.uid !== process.geteuid?.() || stat.size > 64 * 1024 ||
          (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino || previous.mtimeMs !== stat.mtimeMs || previous.ctimeMs !== stat.ctimeMs || previous.size !== stat.size))) invalid();
      const bytes = readFileSync(fd), current = lstatSync(path);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) invalid();
      // Reconfirm durability on read/duplicate ACK, including a previous fsync failure.
      fsyncSync(fd); this.syncAncestors(dirname(path));
      this.files.set(path, stat); return parseSourceWorkerRequestRecord(JSON.parse(bytes.toString("utf8")));
    } finally { closeSync(fd); }
  }
  private inspectAncestors(directory: string): void {
    const owner = process.geteuid?.();
    if (owner === undefined) invalid();
    let childOwner: number | undefined;
    for (let path = directory;; path = dirname(path)) {
      const stat = lstatSync(path), previous = this.directories.get(path);
      // A root-owned sticky /tmp protects this operator's TEST child entry;
      // writable nonsticky or foreign-owned parents can replace the ledger.
      const stickyParent = stat.uid === 0 && (stat.mode & 0o1000) !== 0 &&
        (childOwner === owner || childOwner === 0);
      if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== owner) ||
          ((stat.mode & 0o022) !== 0 && !stickyParent) ||
          (previous && (stat.dev !== previous.dev || stat.ino !== previous.ino)) ||
          ((path === this.root || path.startsWith(this.root + "/")) && ((stat.mode & 0o077) !== 0 || stat.uid !== owner))) invalid();
      this.directories.set(path, stat); childOwner = stat.uid; if (path === "/") break;
    }
  }
  private syncAncestors(directory: string): void {
    for (let path = directory;; path = dirname(path)) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { const stat = fstatSync(fd), expected = this.directories.get(path);
        if (!expected || stat.dev !== expected.dev || stat.ino !== expected.ino) invalid(); fsyncSync(fd);
      } finally { closeSync(fd); }
      if (path === "/") break;
    }
  }
}
function invalid(): never { throw new Error("source_worker_storage_identity_invalid"); }
function exists(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "EEXIST"; }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
