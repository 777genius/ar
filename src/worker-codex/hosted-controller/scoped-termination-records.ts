import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { assertHostedActivationFence, assertHostedActivationOperator, decodeHostedActivationBytes, type HostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { parseRetainedScopeIdentity, parseScopedInvocation, parseScopedOperation, parseScopedReceipt,
  parseScopedStartCorrelation, parseScopedSubmitter, type ScopedSubmitter, type RetainedScopeIdentity, type ScopedTerminationOperation, type ScopedTerminationReceipt, type ScopedStartCorrelation, type ScopedInvocation } from "../../worker-core/hosted-custody/domain/scoped-termination";

const root = "/var/lib/subscription-runtime-host-policy";
const max = 4 * 1024 * 1024;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
export const scopedRecordDigest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n");
export interface ScopedTerminatingMarker { readonly schemaVersion: 1; readonly identity: RetainedScopeIdentity;
  readonly operationGeneration: number; readonly reservationIds: readonly string[] }
function marker(value: unknown): ScopedTerminatingMarker {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "identity,operationGeneration,reservationIds,schemaVersion") throw new Error("scoped_marker_invalid");
  const v = value as ScopedTerminatingMarker, identity = parseRetainedScopeIdentity(v.identity);
  if (v.schemaVersion !== 1 || !Number.isSafeInteger(v.operationGeneration) || v.operationGeneration < 1 ||
      !Array.isArray(v.reservationIds) || !v.reservationIds.length || v.reservationIds.length > 256 ||
      v.reservationIds.some(id => !/^[a-f0-9-]{36}$/.test(id)) || new Set(v.reservationIds).size !== v.reservationIds.length) throw new Error("scoped_marker_invalid");
  return Object.freeze({ ...v, identity, reservationIds: Object.freeze([...v.reservationIds]) });
}
/** Fixed private namespace. Ancestry is pinned before access, anchored through
 * directory descriptors, then rechecked after the LAST fsync. No path arguments,
 * creation of namespaces, overwrite, stale recovery or default missing proof. */
export class ScopedTerminationRecords {
  constructor(private readonly authenticate: () => void) {}
  #access<T>(namespace: string, id: string, action: (path: string, parents: readonly number[], verify: () => void) => T): T {
    this.authenticate(); assertHostedActivationOperator();
    if (!/^(?:ordinary-correlations|ordinary-invocations|ordinary-submitters|ordinary-submitter-exits|scoped-terminating|scoped-operations|scoped-observations|scoped-receipts|keyed-child-owners|host-activation)$/.test(namespace) || !(namespace === "host-activation" ? id === "record" : namespace === "keyed-child-owners" ? /^[a-f0-9]{64}$/.test(id) : /^[a-f0-9-]{36}$/.test(id))) throw new Error("scoped_record_name_invalid");
    const path = namespace === "host-activation" ? root : root + "/" + namespace, pinned: { path: string; stat: Stats; fd: number }[] = [];
    try {
      for (let current = path;; current = dirname(current)) {
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & (current === path ? 0o077 : 0o022))) throw new Error("scoped_record_parent_invalid");
        const fd = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        pinned.push({ path: current, stat, fd });
        if (!same(stat, fstatSync(fd))) throw new Error("scoped_record_parent_changed");
        if (current === "/") break;
      }
      const verify = () => { for (const [i, p] of pinned.entries()) {
        for (const current of [lstatSync(p.path), fstatSync(p.fd)]) if (!same(p.stat, current) || !current.isDirectory() || current.uid !== 0 ||
            (current.mode & (i === 0 ? 0o077 : 0o022))) throw new Error("scoped_record_parent_changed");
      } };
      verify(); const result = action(`/proc/self/fd/${pinned[0]!.fd}/${namespace === "host-activation" ? "host-activation.json" : id + ".json"}`, pinned.map(p => p.fd), verify); verify(); return result;
    } finally { for (const p of pinned.reverse()) closeSync(p.fd); }
  }
  #bytes(fd: number): { bytes: Buffer; stat: Stats } {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > max) throw new Error("scoped_record_file_invalid");
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fstatSync(fd);
    if (offset !== stat.size || !same(stat, after) || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs) throw new Error("scoped_record_file_changed");
    return { bytes: bytes.subarray(0, offset), stat };
  }
  read(namespace: string, id: string): Buffer | null {
    return this.#access(namespace, id, (path, _parents, verify) => {
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { verify(); return null; } throw e; }
      try { const { bytes, stat } = this.#bytes(fd); if (!same(stat, lstatSync(path))) throw new Error("scoped_record_file_changed"); return bytes; }
      finally { closeSync(fd); }
    });
  }
  write(fence: HostedActivationFence, namespace: string, id: string, bytes: Buffer): void {
    this.authenticate(); assertHostedActivationFence(fence);
    if (bytes.length > max) throw new Error("scoped_record_limit");
    this.#access(namespace, id, (path, parents, verify) => {
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (n < 1) throw new Error("scoped_record_write_failed"); offset += n; } }
        catch (e) { closeSync(fd); throw e; }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
      try {
        const before = this.#bytes(fd);
        if (!before.bytes.equals(bytes)) throw new Error("scoped_record_conflict");
        fsyncSync(fd); for (const parent of parents) fsyncSync(parent);
        // Do not add a durability interval after this validation.
        const after = this.#bytes(fd);
        if (!after.bytes.equals(bytes) || !same(before.stat, after.stat) || after.stat.ctimeMs !== before.stat.ctimeMs ||
            after.stat.mtimeMs !== before.stat.mtimeMs || !same(after.stat, lstatSync(path))) throw new Error("scoped_record_file_changed");
        verify();
      } finally { closeSync(fd); }
    });
  }
  /** Exact no-op ordinary replay must repair file AND parent durability before
   * any keyed successor. It cannot create/replace a missing activation record. */
  synchronizeActivation(fence: HostedActivationFence, bytes: Buffer): void {
    this.authenticate(); assertHostedActivationFence(fence);
    this.#access("host-activation", "record", (path, parents, verify) => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = this.#bytes(fd);
        if (!before.bytes.equals(bytes)) throw new Error("scoped_activation_conflict");
        fsyncSync(fd); for (const parent of parents) fsyncSync(parent);
        const after = this.#bytes(fd);
        if (!after.bytes.equals(bytes) || !same(before.stat, after.stat) || after.stat.ctimeMs !== before.stat.ctimeMs ||
            after.stat.mtimeMs !== before.stat.mtimeMs || !same(after.stat, lstatSync(path))) throw new Error("scoped_activation_changed");
        verify();
      } finally { closeSync(fd); }
    });
  }
  #parse<T>(namespace: string, id: string, parser: (v: unknown) => T): T | null {
    const bytes = this.read(namespace, id); if (!bytes) return null;
    const result = parser(decodeHostedActivationBytes(bytes));
    if (!encode(result).equals(bytes)) throw new Error("scoped_record_noncanonical"); return result;
  }
  correlation(id: string): ScopedStartCorrelation | null { return this.#parse("ordinary-correlations", id, parseScopedStartCorrelation); }
  invocation(id: string): ScopedInvocation | null { return this.#parse("ordinary-invocations", id, parseScopedInvocation); }
  submitter(id: string): ScopedSubmitter | null { return this.#parse("ordinary-submitters", id, parseScopedSubmitter); }
  submitterExited(id: string, digest: string): boolean {
    const bytes = this.read("ordinary-submitter-exits", id);
    if (!bytes) return false;
    if (!bytes.equals(encode({ schemaVersion: 1, submitterDigest: digest, exitObserved: true }))) throw new Error("scoped_submitter_exit_invalid"); return true;
  }
  retainSubmitterExit(f: HostedActivationFence, id: string, digest: string): void {
    this.write(f, "ordinary-submitter-exits", id, encode({ schemaVersion: 1, submitterDigest: digest, exitObserved: true }));
  }
  terminating(id: string): ScopedTerminatingMarker | null { return this.#parse("scoped-terminating", id, marker); }
  operation(id: string): ScopedTerminationOperation | null { return this.#parse("scoped-operations", id, parseScopedOperation); }
  receipt(id: string): ScopedTerminationReceipt | null { return this.#parse("scoped-receipts", id, parseScopedReceipt); }
  retainMarker(f: HostedActivationFence, v: ScopedTerminatingMarker): void { this.write(f, "scoped-terminating", v.identity.parentStartId, encode(marker(v))); }
  retainOperation(f: HostedActivationFence, v: ScopedTerminationOperation): void { this.write(f, "scoped-operations", v.identity.parentStartId, encode(parseScopedOperation(v))); }
  retainObservations(f: HostedActivationFence, receipt: ScopedTerminationReceipt): void {
    this.write(f, "scoped-observations", receipt.operation.identity.parentStartId, encode({ schemaVersion: 1,
      operationDigest: scopedRecordDigest(encode(receipt.operation)), observations: receipt.observations }));
  }
  validateObservations(receipt: ScopedTerminationReceipt): void {
    const bytes = this.read("scoped-observations", receipt.operation.identity.parentStartId);
    if (!bytes?.equals(encode({ schemaVersion: 1, operationDigest: scopedRecordDigest(encode(receipt.operation)), observations: receipt.observations }))) throw new Error("scoped_observation_evidence_invalid");
  }
  retainReceipt(f: HostedActivationFence, v: ScopedTerminationReceipt): string {
    const bytes = encode(parseScopedReceipt(v)); this.write(f, "scoped-receipts", v.operation.identity.parentStartId, bytes); return scopedRecordDigest(bytes);
  }
}
