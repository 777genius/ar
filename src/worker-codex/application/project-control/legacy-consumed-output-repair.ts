import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
  type WorkspaceLockPort,
} from "@vioxen/subscription-runtime/worker-core";

const MAX_LEDGER_RECORD_BYTES = 1024 * 1024;
const LEGACY_FAILED_NO_OUTPUT_EVIDENCE =
  "failed_no_output record contradicts non-empty workspace status evidence";

export type LegacyConsumedOutputCandidate = {
  readonly ledgerPath: string;
  readonly ledgerRoot: string;
  readonly jobId: string;
  readonly status: string;
  readonly commitSha?: string;
  readonly closedAt: string;
  readonly workspace?: string;
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Buffer;
  readonly metadata: Stats;
};

export type LegacyConsumedOutputProof =
  | { readonly eligible: true; readonly evidence: readonly string[] }
  | { readonly eligible: false; readonly reasons: readonly string[] };

export type LegacyConsumedOutputRepairItem = {
  readonly ledgerPath: string;
  readonly jobId?: string;
  readonly status?: string;
  readonly sha256?: string;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly quarantinePath?: string;
};

export type LegacyConsumedOutputRepairResult = {
  readonly ok: boolean;
  readonly mode: "preview" | "confirmed";
  readonly eligibleCount: number;
  readonly refusedCount: number;
  readonly quarantinedCount: number;
  readonly items: readonly LegacyConsumedOutputRepairItem[];
};

export async function repairLegacyConsumedOutputDebt(input: {
  readonly projectId: string;
  readonly registryRootDir: string;
  readonly authorizedLedgerRoots: readonly string[];
  readonly admissionSnapshot: ProjectAdmissionSnapshot;
  readonly confirm?: boolean;
  readonly locks: WorkspaceLockPort;
  readonly prove: (
    candidate: LegacyConsumedOutputCandidate,
  ) => Promise<LegacyConsumedOutputProof>;
  /** Test-only race injector. Production callers must omit this hook. */
  readonly beforeQuarantine?: (
    candidate: LegacyConsumedOutputCandidate,
  ) => Promise<void>;
}): Promise<LegacyConsumedOutputRepairResult> {
  const roots = await canonicalLedgerRoots(input.authorizedLedgerRoots);
  const lock = await input.locks.acquire({
    workspacePath: input.registryRootDir,
    owner: `legacy-output-repair:${input.projectId}`,
  });
  try {
    const subjects = admissionLegacySubjects(input.admissionSnapshot);
    const prepared: Array<{
      readonly candidate: LegacyConsumedOutputCandidate;
      readonly proof: Extract<LegacyConsumedOutputProof, { eligible: true }>;
    }> = [];
    const items: LegacyConsumedOutputRepairItem[] = [];
    for (const subject of subjects) {
      const loaded = await loadCandidate(subject, roots, input.admissionSnapshot);
      if (!loaded.ok) {
        items.push({ ledgerPath: subject, eligible: false, reasons: loaded.reasons });
        continue;
      }
      const proof = await input.prove(loaded.candidate);
      if (!proof.eligible) {
        items.push({
          ledgerPath: subject,
          jobId: loaded.candidate.jobId,
          status: loaded.candidate.status,
          sha256: loaded.candidate.sha256,
          eligible: false,
          reasons: proof.reasons,
        });
        continue;
      }
      prepared.push({ candidate: loaded.candidate, proof });
      items.push({
        ledgerPath: subject,
        jobId: loaded.candidate.jobId,
        status: loaded.candidate.status,
        sha256: loaded.candidate.sha256,
        eligible: true,
        reasons: proof.evidence,
      });
    }

    if (input.confirm !== true) {
      return result("preview", items, 0);
    }

    const quarantinePaths = new Map<string, string>();
    for (const entry of prepared) {
      await input.beforeQuarantine?.(entry.candidate);
      await assertActiveItemsDirectory(entry.candidate);
      await assertCandidateUnchanged(entry.candidate);
      const quarantinePath = await quarantineCandidate(entry.candidate, entry.proof);
      quarantinePaths.set(entry.candidate.ledgerPath, quarantinePath);
    }
    return result(
      "confirmed",
      items.map((item) => {
        const quarantinePath = quarantinePaths.get(item.ledgerPath);
        return quarantinePath ? { ...item, quarantinePath } : item;
      }),
      quarantinePaths.size,
    );
  } finally {
    await input.locks.release(lock);
  }
}

async function assertActiveItemsDirectory(
  candidate: LegacyConsumedOutputCandidate,
): Promise<void> {
  const itemsDir = dirname(candidate.ledgerPath);
  const metadata = await lstat(itemsDir);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("project_control_legacy_output_items_path_unsafe");
  }
  const [canonicalRoot, canonicalItems] = await Promise.all([
    realpath(candidate.ledgerRoot),
    realpath(itemsDir),
  ]);
  if (!pathInsideOrEqual(canonicalItems, canonicalRoot)) {
    throw new Error("project_control_legacy_output_items_path_unsafe");
  }
}

function admissionLegacySubjects(snapshot: ProjectAdmissionSnapshot): readonly string[] {
  return [...new Set(snapshot.debt
    .filter((item) =>
      item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord ||
      item.reason === ProjectDebtReason.LegacyOutputQuarantineRequired
    )
    .map((item) => item.subject))]
    .sort();
}

async function canonicalLedgerRoots(roots: readonly string[]): Promise<readonly string[]> {
  const canonical: string[] = [];
  for (const rootInput of [...new Set(roots.map((root) => resolve(root)))]) {
    const metadata = await lstat(rootInput);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("project_control_legacy_output_ledger_root_unsafe");
    }
    const itemsMetadata = await lstat(join(rootInput, "items"));
    if (itemsMetadata.isSymbolicLink() || !itemsMetadata.isDirectory()) {
      throw new Error("project_control_legacy_output_ledger_root_unsafe");
    }
    // Preserve the caller spelling (for example macOS /var -> /private/var)
    // for lexical authorization. The non-symlink root/items checks above and
    // O_NOFOLLOW on every record close the traversal surface.
    await realpath(rootInput);
    canonical.push(rootInput);
  }
  return canonical;
}

async function loadCandidate(
  ledgerPathInput: string,
  roots: readonly string[],
  snapshot: ProjectAdmissionSnapshot,
): Promise<
  | { readonly ok: true; readonly candidate: LegacyConsumedOutputCandidate }
  | { readonly ok: false; readonly reasons: readonly string[] }
> {
  const ledgerPath = resolve(ledgerPathInput);
  const ledgerRoot = roots.find((root) => {
    const items = join(root, "items");
    return dirname(ledgerPath) === items && pathInsideOrEqual(ledgerPath, items);
  });
  if (!ledgerRoot || !basename(ledgerPath).endsWith(".json")) {
    return { ok: false, reasons: ["ledger path is outside controller-authorized items roots"] };
  }
  let handle;
  try {
    const metadata = await lstat(ledgerPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return { ok: false, reasons: ["ledger record is not a regular non-symlink file"] };
    }
    handle = await open(ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!sameFile(metadata, opened) || opened.size > MAX_LEDGER_RECORD_BYTES) {
      return { ok: false, reasons: ["ledger record changed or exceeds the repair size limit"] };
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        return { ok: false, reasons: ["ledger record changed while being read"] };
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameFile(opened, after)) {
      return { ok: false, reasons: ["ledger record changed while being hashed"] };
    }
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!isRecord(parsed)) throw new Error("not_object");
      value = parsed;
    } catch {
      return { ok: false, reasons: ["ledger record is not valid object JSON"] };
    }
    const jobId = stringValue(value.jobId);
    const status = stringValue(value.status);
    const closedAt = stringValue(value.closedAt);
    const debt = snapshot.debt.find((item) =>
      resolve(item.subject) === ledgerPath &&
      (item.reason === ProjectDebtReason.IncompleteConsumedOutputRecord ||
        item.reason === ProjectDebtReason.LegacyOutputQuarantineRequired)
    );
    const legacyFailedNoOutput = status === "failed_no_output" &&
      value.schemaVersion === 1 &&
      debt?.evidence.includes(LEGACY_FAILED_NO_OUTPUT_EVIDENCE) === true &&
      !isRecord(value.preexistingWorkspacePatch);
    const predatesSchemaVersionOne = value.schemaVersion !== 1;
    if (
      !jobId || !status ||
      !["failed_no_output", "rejected", "integrated"].includes(status) ||
      !closedAt || !Number.isFinite(Date.parse(closedAt)) ||
      isRecord(value.claim) || value.active === true || value.claimed === true ||
      (!legacyFailedNoOutput && !predatesSchemaVersionOne)
    ) {
      return {
        ok: false,
        reasons: ["record is not proven to predate current failed-no-output retention evidence"],
      };
    }
    const backup = isRecord(value.backup) ? value.backup : undefined;
    const workspace = backup ? stringValue(backup.workspace) : undefined;
    const commitSha = integratedCommit(value);
    return {
      ok: true,
      candidate: {
        ledgerPath,
        ledgerRoot,
        jobId,
        status,
        ...(commitSha ? { commitSha } : {}),
        closedAt,
        ...(workspace ? { workspace } : {}),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        bytes,
        metadata: after,
      },
    };
  } catch (error) {
    return { ok: false, reasons: [`ledger record unavailable: ${errorMessage(error)}`] };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function integratedCommit(value: Record<string, unknown>): string | undefined {
  for (const key of ["commitSha", "commit", "integratedCommitSha"]) {
    const commit = stringValue(value[key]);
    if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) return commit;
  }
  const notes = Array.isArray(value.notes) ? value.notes : [];
  for (const note of notes) {
    if (!isRecord(note)) continue;
    const commit = stringValue(note.commit);
    if (commit && /^[0-9a-f]{7,40}$/i.test(commit)) return commit;
  }
  return undefined;
}

async function assertCandidateUnchanged(candidate: LegacyConsumedOutputCandidate): Promise<void> {
  let handle;
  try {
    const metadata = await lstat(candidate.ledgerPath);
    if (metadata.isSymbolicLink() || !sameFile(candidate.metadata, metadata)) {
      throw new Error("project_control_legacy_output_concurrent_mutation");
    }
    handle = await open(
      candidate.ledgerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const bytes = Buffer.alloc(candidate.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("project_control_legacy_output_concurrent_mutation");
      }
      offset += read.bytesRead;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== candidate.sha256) {
      throw new Error("project_control_legacy_output_hash_mismatch");
    }
    const after = await handle.stat();
    if (!sameFile(candidate.metadata, after)) {
      throw new Error("project_control_legacy_output_concurrent_mutation");
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function quarantineCandidate(
  candidate: LegacyConsumedOutputCandidate,
  proof: Extract<LegacyConsumedOutputProof, { eligible: true }>,
): Promise<string> {
  const quarantineRoot = join(candidate.ledgerRoot, "quarantine", "legacy-consumed-output");
  const recordsDir = join(quarantineRoot, "records");
  await mkdir(recordsDir, { recursive: true, mode: 0o700 });
  await assertSafeQuarantineDirectory(candidate.ledgerRoot, quarantineRoot);
  await assertSafeQuarantineDirectory(candidate.ledgerRoot, recordsDir);
  const receiptId = randomUUID();
  const quarantinePath = join(
    recordsDir,
    `${candidate.sha256}-${receiptId}-${safeName(basename(candidate.ledgerPath))}`,
  );
  const receipt = {
    schemaVersion: 1,
    receiptId,
    phase: "prepared",
    recordedAt: new Date().toISOString(),
    sourcePath: candidate.ledgerPath,
    quarantinePath,
    jobId: candidate.jobId,
    status: candidate.status,
    closedAt: candidate.closedAt,
    size: candidate.size,
    sha256: candidate.sha256,
    proof: proof.evidence,
  };
  await appendReceipt(join(quarantineRoot, "manifest.jsonl"), receipt);
  try {
    await lstat(quarantinePath);
    throw new Error("project_control_legacy_output_quarantine_collision");
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  await rename(candidate.ledgerPath, quarantinePath);
  await assertQuarantineBytes(quarantinePath, candidate.sha256, candidate.size);
  await chmod(quarantinePath, 0o400);
  await appendReceipt(join(quarantineRoot, "manifest.jsonl"), {
    ...receipt,
    phase: "quarantined",
    recordedAt: new Date().toISOString(),
  });
  return quarantinePath;
}

async function assertSafeQuarantineDirectory(
  ledgerRoot: string,
  path: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("project_control_legacy_output_quarantine_path_unsafe");
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(ledgerRoot),
    realpath(path),
  ]);
  if (!pathInsideOrEqual(canonicalPath, canonicalRoot)) {
    throw new Error("project_control_legacy_output_quarantine_path_unsafe");
  }
}

async function appendReceipt(path: string, value: unknown): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertQuarantineBytes(
  path: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== expectedSize) {
      throw new Error("project_control_legacy_output_quarantine_verification_failed");
    }
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error("project_control_legacy_output_quarantine_verification_failed");
      }
      offset += read.bytesRead;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw new Error("project_control_legacy_output_quarantine_verification_failed");
    }
  } finally {
    await handle.close();
  }
}

function result(
  mode: "preview" | "confirmed",
  items: readonly LegacyConsumedOutputRepairItem[],
  quarantinedCount: number,
): LegacyConsumedOutputRepairResult {
  return {
    ok: items.length === 0 ||
      (mode === "confirmed" && items.every((item) => item.eligible)),
    mode,
    eligibleCount: items.filter((item) => item.eligible).length,
    refusedCount: items.filter((item) => !item.eligible).length,
    quarantinedCount,
    items,
  };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const rest = relative(resolve(root), resolve(path));
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
