import { createHash } from "node:crypto";
import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LocalEncryptedFileStore } from "@vioxen/subscription-runtime/store-local-file";
import { codexAuthJsonFromArtifact, sessionArtifactFromCodexAuthJson, readCodexAuthJsonFreshness } from "@vioxen/subscription-runtime/provider-codex";
import { codexSessionCapacityAccountId } from "./codex-session-capacity-identity";

const providerInstanceId = "codex:seed-writeback";
const reservationPattern = /^[0-9]{12}$/;
const retentionLimit = 4096;
enum RecordKind { Published = "published", Recovery = "recovery" }

/** Sanitized ancestry from the selected encrypted publication, in this source's
 * custody scope. No ancestry is inferred from timestamps, tickets or bytes. */
export type CodexSeedRefreshSnapshot = {
  readonly bytes: string;
  readonly ancestorSessionIds: readonly string[];
};

/** Immutable encrypted publication tickets, rather than a crash-sensitive lock.
 * mkdir assigns a unique monotonically ordered ticket across local processes.
 * Each ticket has exactly one writer and its own existing encrypted store. An
 * incomplete/crashed ticket has no record and never prevents a later writer.
 * Readers preserve causal descendants and provider refresh chronology, so a
 * delayed older result cannot replace a newer refresh. Indistinguishable sibling
 * rotations produce a supported conflict, retaining both encrypted records.
 * No process liveness guess or elapsed-time stealing occurs. These timestamps
 * order custody inside ONE source authorization; they never recover eligibility.
 *
 * Admission checks the caller's captured authorization against the source and
 * retained lineage. This is NOT a CAS against the login writer or a mutable
 * shared file. Already-running jobs retain later rotations even when another
 * job has published first. An unrelated captured session gets a durable recovery
 * record and explicit conflict, never a silently discarded token.
 * Retention is bounded; compaction belongs to a future trusted custody owner.
 */
export class CodexSeedRefreshJournal {
  constructor(private readonly root: string, private readonly encryptionKey: Uint8Array) {}

  async read(): Promise<string | null> {
    return (await this.readWithProvenance())?.bytes ?? null;
  }

  async readWithProvenance(): Promise<CodexSeedRefreshSnapshot | null> {
    const reservations = await this.reservations();
    const records: { bytes: string; ticket: string; parent: string; identity: string; refreshedAt: number | null }[] = [];
    for (const ticket of reservations.sort().reverse()) {
      const session = await this.store(ticket).read({ providerInstanceId, expectedProviderId: "codex", purpose: "seed" });
      if (session) {
        const bytes = codexAuthJsonFromArtifact(session.artifact);
        const identity = codexSessionCapacityAccountId(JSON.parse(bytes));
        const parent = session.metadata.parentSessionId;
        if (!identity || !parent) throw new Error("codex_seed_publication_record_invalid");
        records.push({ bytes, ticket, identity, parent,
          refreshedAt: readCodexAuthJsonFreshness({ authJsonBytes: bytes }).lastRefreshAt?.getTime() ?? null });
      }
    }
    // A known child rotation supersedes its captured parent regardless of
    // clock skew. Same-refresh access updates use the later publication ticket.
    const parents = new Set(records.filter(row => row.parent !== row.identity).map(row => row.parent));
    const leaves = records.filter(row => !parents.has(row.identity));
    if (!leaves.length) {
      if (records.length) throw new Error("codex_seed_publication_lineage_conflict");
      return null;
    }
    leaves.sort((a, b) => (b.refreshedAt ?? -Infinity) - (a.refreshedAt ?? -Infinity) || b.ticket.localeCompare(a.ticket));
    const winner = leaves[0]!;
    if (leaves.some(row => row.identity !== winner.identity &&
      (row.refreshedAt === null || winner.refreshedAt === null || row.refreshedAt === winner.refreshedAt))) {
      throw new Error("codex_seed_publication_ambiguous_rotation_recovery_retained");
    }
    const ancestors = new Set<string>();
    const pending = [winner.identity];
    const visited = new Set<string>();
    while (pending.length) {
      const identity = pending.pop()!;
      if (visited.has(identity)) continue;
      visited.add(identity);
      for (const row of records) {
        if (row.identity !== identity || row.parent === identity) continue;
        ancestors.add(row.parent);
        pending.push(row.parent);
      }
    }
    ancestors.delete(winner.identity);
    return { bytes: winner.bytes, ancestorSessionIds: [...ancestors] };
  }

  async publish(input: { readonly sourceIdentity: string; readonly expected: string; readonly next: string; readonly current: () => Promise<string> }): Promise<void> {
    // Reserve BEFORE publication: order survives the publisher being paused or
    // killed inside the actual store.write. Empty reservations are harmless.
    const ticket = await this.reserve();
    const current = await input.current();
    const parentSessionId = codexSessionCapacityAccountId(JSON.parse(input.expected));
    if (!parentSessionId) throw new Error("codex_seed_publication_parent_required");
    const currentSessionId = codexSessionCapacityAccountId(JSON.parse(current));
    // Formatting/access renewal is not a different authorization generation.
    const known = new Set([input.sourceIdentity, currentSessionId]);
    for (const previous of await this.reservations()) {
      const session = await this.store(previous).read({ providerInstanceId, expectedProviderId: "codex", purpose: "publication-lineage" });
      if (session) {
        known.add(session.metadata.parentSessionId ?? null);
        known.add(codexSessionCapacityAccountId(JSON.parse(codexAuthJsonFromArtifact(session.artifact))));
      }
    }
    const conflict = !known.has(parentSessionId);
    const store = this.store(ticket, conflict ? RecordKind.Recovery : RecordKind.Published, { parentSessionId });
    const result = await store.write({
      providerInstanceId, expectedGeneration: 0,
      nextArtifact: sessionArtifactFromCodexAuthJson(input.next),
      idempotencyKey: createHash("sha256").update(input.expected).update("\0").update(input.next).digest("hex"),
      leaseId: `source-bound-refresh:${ticket}`,
    });
    if (result.status === "stale_generation") throw new Error("codex_seed_publication_failed");
    // LocalEncryptedFileStore atomically renames its record. Flush the record
    // and containing directories before acknowledging credential custody.
    const directory = join(this.root, ticket, conflict ? RecordKind.Recovery : RecordKind.Published);
    const record = join(directory, createHash("sha256").update(providerInstanceId).digest("hex") + ".json");
    await sync(record);
    await sync(directory);
    await sync(join(this.root, ticket));
    await sync(this.root);
    // Include the lineage and private sidecar parents created by recursive
    // mkdir. This does not relax the enclosing host mount permissions.
    await sync(join(this.root, ".."));
    await sync(join(this.root, "../.."));
    await sync(join(this.root, "../../.."));
    if (conflict) throw new Error("codex_seed_publication_conflict_recovery_retained");
    // Detect an ambiguous concurrent sibling before acknowledging completion.
    // The immutable records remain readable to trusted recovery custody.
    await this.read();
  }

  private store(ticket: string, kind = RecordKind.Published, metadata?: Readonly<Record<string, string>>): LocalEncryptedFileStore {
    return new LocalEncryptedFileStore({ providerId: "codex", rootDir: join(this.root, ticket, kind), encryptionKey: this.encryptionKey,
      ...(metadata ? { metadata } : {}) });
  }

  private async reserve(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 64; attempt++) {
      const existing = await this.reservations();
      if (existing.length >= retentionLimit) throw new Error("codex_seed_publication_retention_required");
      const highest = Math.max(0, ...existing.map(Number));
      if (highest >= 999999999999) throw new Error("codex_seed_publication_retention_required");
      const ticket = String(highest + 1).padStart(12, "0");
      try { await mkdir(join(this.root, ticket), { mode: 0o700 }); return ticket; }
      catch (error) { if (!isCode(error, "EEXIST")) throw error; }
    }
    throw new Error("codex_seed_publication_contention");
  }

  private async reservations(): Promise<string[]> {
    let entries: string[];
    try { entries = await readdir(this.root); }
    catch (error) { if (isCode(error, "ENOENT")) return []; throw error; }
    return entries.filter(name => reservationPattern.test(name));
  }
}

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
