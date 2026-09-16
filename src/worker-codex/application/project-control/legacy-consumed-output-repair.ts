import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ProjectDebtReason,
  type ProjectAdmissionSnapshot,
} from "@vioxen/subscription-runtime/worker-core";
import type {
  ConsumedOutputLedgerMutationLease,
  LocalConsumedOutputLedgerMutationLock,
} from "@vioxen/subscription-runtime/worker-local";

const MAX_LEDGER_RECORD_BYTES = 1024 * 1024;
const LEGACY_FAILED_NO_OUTPUT_EVIDENCE =
  "failed_no_output record contradicts non-empty workspace status evidence";

export type LegacyConsumedOutputCandidate = {
  readonly ledgerPath: string;
  readonly ledgerRoot: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly status: string;
  readonly closedAt: string;
  readonly workspace?: string;
  readonly retainedStatusPath: string;
  readonly retainedPayloadPaths: readonly string[];
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
  readonly allowedJobIdPrefixes: readonly string[];
  readonly admissionSnapshot: ProjectAdmissionSnapshot;
  readonly confirm?: boolean;
  readonly mutationLocks: Pick<
    LocalConsumedOutputLedgerMutationLock,
    "acquire" | "release"
  >;
  readonly prove: (
    candidate: LegacyConsumedOutputCandidate,
  ) => Promise<LegacyConsumedOutputProof>;
  /** Test-only race injector. Production callers must omit this hook. */
  readonly beforeQuarantine?: (
    candidate: LegacyConsumedOutputCandidate,
  ) => Promise<void>;
  readonly afterRename?: (
    candidate: LegacyConsumedOutputCandidate,
  ) => Promise<void>;
  readonly afterReceipt?: (candidate: LegacyConsumedOutputCandidate) => Promise<void>;
  readonly beforeManifestTailTruncate?: (manifestPath: string) => Promise<void>;
}): Promise<LegacyConsumedOutputRepairResult> {
  const roots = await canonicalLedgerRoots(input.authorizedLedgerRoots);
  let lease: ConsumedOutputLedgerMutationLease | undefined;
  if (input.confirm === true) {
    lease = await input.mutationLocks.acquire({
      ledgerRoots: roots,
      owner: `legacy-output-repair:${input.projectId}`,
    });
  }
  try {
    const recovered = input.confirm === true
      ? await reconcilePreparedReceipts(
          roots,
          input.projectId,
          input.allowedJobIdPrefixes,
          input.beforeManifestTailTruncate,
        )
      : new Map<string, string>();
    const subjects = admissionLegacySubjects(input.admissionSnapshot);
    const prepared: Array<{
      readonly candidate: LegacyConsumedOutputCandidate;
      readonly proof: Extract<LegacyConsumedOutputProof, { eligible: true }>;
    }> = [];
    const items: LegacyConsumedOutputRepairItem[] = [];
    for (const subject of subjects) {
      const recoveredPath = recovered.get(resolve(subject));
      if (recoveredPath) {
        items.push({
          ledgerPath: subject,
          eligible: true,
          reasons: ["recovered and verified a prepared quarantine receipt"],
          quarantinePath: recoveredPath,
        });
        continue;
      }
      const loaded = await loadCandidate(
        subject,
        roots,
        input.admissionSnapshot,
        input.projectId,
        input.allowedJobIdPrefixes,
      );
      if (!loaded.ok) {
        items.push({ ledgerPath: subject, eligible: false, reasons: loaded.reasons });
        continue;
      }
      const retainedProof = await proveEmptyRetainedEvidence(loaded.candidate);
      if (!retainedProof.eligible) {
        items.push({
          ledgerPath: subject,
          jobId: loaded.candidate.jobId,
          status: loaded.candidate.status,
          sha256: loaded.candidate.sha256,
          eligible: false,
          reasons: retainedProof.reasons,
        });
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
      const completeProof = {
        eligible: true as const,
        evidence: [...retainedProof.evidence, ...proof.evidence],
      };
      prepared.push({ candidate: loaded.candidate, proof: completeProof });
      items.push({
        ledgerPath: subject,
        jobId: loaded.candidate.jobId,
        status: loaded.candidate.status,
        sha256: loaded.candidate.sha256,
        eligible: true,
        reasons: completeProof.evidence,
      });
    }

    if (input.confirm !== true) {
      return result("preview", items, 0);
    }

    const quarantinePaths = new Map(recovered);
    for (const entry of prepared) {
      await input.beforeQuarantine?.(entry.candidate);
      await assertActiveItemsDirectory(entry.candidate);
      await assertCandidateUnchanged(entry.candidate);
      const quarantinePath = await quarantineCandidate(
        entry.candidate,
        entry.proof,
        input.afterRename,
        input.afterReceipt,
        async () => {
          const retainedProof = await proveEmptyRetainedEvidence(entry.candidate);
          const liveProof = await input.prove(entry.candidate);
          if (!retainedProof.eligible || !liveProof.eligible) {
            throw new Error("project_control_legacy_output_late_proof_changed");
          }
        },
      );
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
    if (lease) await input.mutationLocks.release(lease);
  }
}

type QuarantineReceipt = {
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly phase: "prepared" | "quarantined" | "aborted";
  readonly sourcePath: string;
  readonly quarantinePath: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly size: number;
  readonly sha256: string;
  readonly [key: string]: unknown;
};

async function reconcilePreparedReceipts(
  roots: readonly string[],
  projectId: string,
  allowedJobIdPrefixes: readonly string[],
  beforeManifestTailTruncate?: (manifestPath: string) => Promise<void>,
): Promise<Map<string, string>> {
  const recovered = new Map<string, string>();
  for (const ledgerRoot of roots) {
    const quarantineRoot = join(ledgerRoot, "quarantine", "legacy-consumed-output");
    const recordsDir = join(quarantineRoot, "records");
    const manifestPath = join(quarantineRoot, "manifest.jsonl");
    let contents: string;
    let manifestHandle: FileHandle | undefined;
    try {
      await assertSafeQuarantineDirectory(ledgerRoot, quarantineRoot);
      await assertSafeQuarantineDirectory(ledgerRoot, recordsDir);
      manifestHandle = await open(
        manifestPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      const metadata = await manifestHandle.stat();
      if (!metadata.isFile()) {
        throw new Error("project_control_legacy_output_manifest_unsafe");
      }
      contents = await manifestHandle.readFile("utf8");
    } catch (error) {
      await manifestHandle?.close().catch(() => undefined);
      if (nodeErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    let parsedManifest: ReturnType<typeof parseManifestReceipts>;
    try {
      parsedManifest = parseManifestReceipts(contents);
      if (parsedManifest.validPrefixBytes !== undefined) {
        await beforeManifestTailTruncate?.(manifestPath);
        await manifestHandle.truncate(parsedManifest.validPrefixBytes);
        await manifestHandle.sync();
      }
    } finally {
      await manifestHandle.close();
    }
    const receipts = parsedManifest.receipts;
    const completed = new Set(
      receipts
        .filter((receipt) => receipt.phase !== "prepared")
        .map((receipt) => receipt.receiptId),
    );
    for (const prepared of receipts.filter((receipt) =>
      receipt.phase === "prepared" && !completed.has(receipt.receiptId)
    )) {
      if (
        prepared.projectId !== projectId ||
        !allowedJobIdPrefixes.some((prefix) => prepared.jobId.startsWith(prefix))
      ) {
        throw new Error("project_control_legacy_output_manifest_project_mismatch");
      }
      assertReceiptPaths(prepared, ledgerRoot, recordsDir);
      const sourceExists = await regularFileExists(prepared.sourcePath);
      const quarantineExists = await regularFileExists(prepared.quarantinePath);
      if (quarantineExists && !sourceExists) {
        await assertQuarantineBytes(
          prepared.quarantinePath,
          prepared.sha256,
          prepared.size,
        );
        await chmod(prepared.quarantinePath, 0o400);
        await fsyncFile(prepared.quarantinePath);
        await appendReceipt(manifestPath, {
          ...prepared,
          phase: "quarantined",
          recordedAt: new Date().toISOString(),
          recovered: true,
          ...(parsedManifest.tornTailSha256
            ? { recoveredTornTailSha256: parsedManifest.tornTailSha256 }
            : {}),
        }, {
          prefixNewline: false,
        });
        await fsyncDirectory(recordsDir);
        recovered.set(resolve(prepared.sourcePath), prepared.quarantinePath);
        continue;
      }
      if (sourceExists && !quarantineExists) {
        await appendReceipt(manifestPath, {
          ...prepared,
          phase: "aborted",
          recordedAt: new Date().toISOString(),
          recovered: true,
          ...(parsedManifest.tornTailSha256
            ? { recoveredTornTailSha256: parsedManifest.tornTailSha256 }
            : {}),
        }, {
          prefixNewline: false,
        });
        continue;
      }
      throw new Error("project_control_legacy_output_prepared_receipt_inconsistent");
    }
  }
  return recovered;
}

function parseManifestReceipts(contents: string): {
  readonly receipts: readonly QuarantineReceipt[];
  readonly tornTailSha256?: string;
  readonly validPrefixBytes?: number;
} {
  const lines = contents.split("\n");
  const receipts: QuarantineReceipt[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    try {
      receipts.push(parseQuarantineReceipt(line));
    } catch (error) {
      const next = lines[index + 1];
      const sha256 = createHash("sha256").update(line).digest("hex");
      if (index === lines.length - 1 && !contents.endsWith("\n")) {
        const prefix = contents.slice(0, contents.lastIndexOf("\n") + 1);
        return {
          receipts,
          tornTailSha256: sha256,
          validPrefixBytes: Buffer.byteLength(prefix),
        };
      }
      if (next) {
        const recovery = parseQuarantineReceipt(next);
        if (recovery.recoveredTornTailSha256 === sha256) {
          receipts.push(recovery);
          index += 1;
          continue;
        }
      }
      throw error;
    }
  }
  return { receipts };
}

function parseQuarantineReceipt(line: string): QuarantineReceipt {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("project_control_legacy_output_manifest_invalid");
  }
  if (
    !isRecord(value) || value.schemaVersion !== 1 ||
    !stringValue(value.receiptId) ||
    !["prepared", "quarantined", "aborted"].includes(String(value.phase)) ||
    !stringValue(value.sourcePath) || !stringValue(value.quarantinePath) ||
    !stringValue(value.projectId) || !stringValue(value.jobId) ||
    typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error("project_control_legacy_output_manifest_invalid");
  }
  return value as QuarantineReceipt;
}

function assertReceiptPaths(
  receipt: QuarantineReceipt,
  ledgerRoot: string,
  recordsDir: string,
): void {
  if (
    dirname(resolve(receipt.sourcePath)) !== join(ledgerRoot, "items") ||
    dirname(resolve(receipt.quarantinePath)) !== recordsDir
  ) {
    throw new Error("project_control_legacy_output_manifest_path_unsafe");
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("project_control_legacy_output_recovery_path_unsafe");
    }
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function proveEmptyRetainedEvidence(
  candidate: LegacyConsumedOutputCandidate,
): Promise<LegacyConsumedOutputProof> {
  const statusPath = candidate.retainedStatusPath;
  const payloadPaths = candidate.retainedPayloadPaths;
  if (payloadPaths.length < 2) {
    return { eligible: false, reasons: ["complete retained output proof is unavailable"] };
  }
  const backupRoot = dirname(statusPath);
  let canonicalEvidenceRoot: string;
  try {
    canonicalEvidenceRoot = await realpath(dirname(dirname(candidate.ledgerRoot)));
  } catch (error) {
    return {
      eligible: false,
      reasons: [`retained evidence root is unavailable: ${errorMessage(error)}`],
    };
  }
  for (const path of [statusPath, ...payloadPaths]) {
    if (!isAbsolute(path) || dirname(path) !== backupRoot) {
      return { eligible: false, reasons: ["retained output path provenance is invalid"] };
    }
    try {
      const canonicalPath = await realpath(path);
      if (!pathInsideOrEqual(canonicalPath, canonicalEvidenceRoot)) {
        return { eligible: false, reasons: ["retained output path escapes project evidence custody"] };
      }
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        return { eligible: false, reasons: ["retained output evidence is not a regular file"] };
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (
          !sameFile(metadata, opened) ||
          (path !== statusPath && opened.size !== 0)
        ) {
          return {
            eligible: false,
            reasons: [`retained output evidence is non-empty or changed: ${path}`],
          };
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      return {
        eligible: false,
        reasons: [`retained output evidence is unavailable: ${errorMessage(error)}`],
      };
    }
  }
  return {
    eligible: true,
    evidence: ["retained result flags plus empty patch/numstat/untracked evidence prove no authored output"],
  };
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
  projectId: string,
  allowedJobIdPrefixes: readonly string[],
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
    const failure = isRecord(value.failure) ? value.failure : undefined;
    const output = isRecord(value.output) ? value.output : undefined;
    const legacyFailedNoOutput = status === "failed_no_output" &&
      value.schemaVersion === 1 &&
      debt?.evidence.length === 1 &&
      debt.evidence[0] === LEGACY_FAILED_NO_OUTPUT_EVIDENCE &&
      failure !== undefined &&
      onlyKnownKeys(failure, ["category", "code"]) &&
      stringValue(failure.category) !== undefined &&
      stringValue(failure.code) !== undefined &&
      output !== undefined &&
      onlyKnownKeys(output, ["authoredChanges", "workspaceDirty"]) &&
      output.authoredChanges === false && output.workspaceDirty === false &&
      !isRecord(value.preexistingWorkspacePatch);
    const safeJobId = jobId ? safeName(jobId) : "";
    const ledgerName = basename(ledgerPath, ".json");
    if (
      !jobId || !allowedJobIdPrefixes.some((prefix) => jobId.startsWith(prefix)) ||
      (ledgerName !== safeJobId && !ledgerName.startsWith(`${safeJobId}--`)) ||
      status !== "failed_no_output" ||
      !closedAt || !Number.isFinite(Date.parse(closedAt)) ||
      isRecord(value.claim) || value.active === true || value.claimed === true ||
      !legacyFailedNoOutput ||
      !onlyKnownKeys(value, [
        "schemaVersion",
        "jobId",
        "attemptId",
        "status",
        "closedAt",
        "failure",
        "output",
        "note",
        "backup",
        "archivePath",
      ])
    ) {
      return {
        ok: false,
        reasons: ["record is not proven to predate current failed-no-output retention evidence"],
      };
    }
    const backup = isRecord(value.backup) ? value.backup : undefined;
    if (!backup || !onlyKnownKeys(backup, [
      "workspace",
      "statusPath",
      "patchPath",
      "numstatPath",
      "untrackedArchivePath",
      "archivePath",
    ])) {
      return {
        ok: false,
        reasons: ["record does not match the known legacy backup schema"],
      };
    }
    const workspace = backup ? stringValue(backup.workspace) : undefined;
    const statusPath = backup ? stringValue(backup.statusPath) : undefined;
    const patchPath = backup ? stringValue(backup.patchPath) : undefined;
    const numstatPath = backup ? stringValue(backup.numstatPath) : undefined;
    const untrackedArchivePath = backup
      ? stringValue(backup.untrackedArchivePath)
      : undefined;
    if (!statusPath || !patchPath || !numstatPath || !untrackedArchivePath) {
      return {
        ok: false,
        reasons: [
          "complete retained status/patch/numstat/untracked proof is unavailable",
        ],
      };
    }
    return {
      ok: true,
      candidate: {
        ledgerPath,
        ledgerRoot,
        projectId,
        jobId,
        status,
        closedAt,
        ...(workspace ? { workspace } : {}),
        retainedStatusPath: statusPath,
        retainedPayloadPaths: [
          patchPath,
          numstatPath,
          untrackedArchivePath,
        ],
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
  afterRename?: (candidate: LegacyConsumedOutputCandidate) => Promise<void>,
  afterReceipt?: (candidate: LegacyConsumedOutputCandidate) => Promise<void>,
  finalValidate?: () => Promise<void>,
): Promise<string> {
  const quarantineRoot = join(candidate.ledgerRoot, "quarantine", "legacy-consumed-output");
  const recordsDir = join(quarantineRoot, "records");
  await ensureSafeQuarantineTree(candidate.ledgerRoot, [
    join(candidate.ledgerRoot, "quarantine"),
    quarantineRoot,
    recordsDir,
  ]);
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
    projectId: candidate.projectId,
    jobId: candidate.jobId,
    status: candidate.status,
    closedAt: candidate.closedAt,
    size: candidate.size,
    sha256: candidate.sha256,
    proof: proof.evidence,
  };
  await appendReceipt(join(quarantineRoot, "manifest.jsonl"), receipt);
  await fsyncDirectory(quarantineRoot);
  await afterReceipt?.(candidate);
  try {
    await lstat(quarantinePath);
    throw new Error("project_control_legacy_output_quarantine_collision");
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  await finalValidate?.();
  await rename(candidate.ledgerPath, quarantinePath);
  await fsyncFile(quarantinePath);
  await fsyncDirectory(recordsDir);
  await fsyncDirectory(dirname(candidate.ledgerPath));
  await afterRename?.(candidate);
  await assertQuarantineBytes(quarantinePath, candidate.sha256, candidate.size);
  await chmod(quarantinePath, 0o400);
  await fsyncFile(quarantinePath);
  await appendReceipt(join(quarantineRoot, "manifest.jsonl"), {
    ...receipt,
    phase: "quarantined",
    recordedAt: new Date().toISOString(),
  });
  return quarantinePath;
}

async function ensureSafeQuarantineTree(
  ledgerRoot: string,
  paths: readonly string[],
): Promise<void> {
  await assertSafeQuarantineDirectory(ledgerRoot, ledgerRoot);
  let parent = ledgerRoot;
  for (const path of paths) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("project_control_legacy_output_quarantine_path_unsafe");
      }
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") throw error;
      await mkdir(path, { recursive: false, mode: 0o700 });
      await fsyncDirectory(parent);
    }
    await assertSafeQuarantineDirectory(ledgerRoot, path);
    parent = path;
  }
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

async function appendReceipt(
  path: string,
  value: unknown,
  options: { readonly prefixNewline?: boolean } = {},
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.write(`${options.prefixNewline ? "\n" : ""}${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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

function onlyKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
