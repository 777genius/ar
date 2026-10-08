import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { AccessBoundary, ReviewDecisionStatus, createAccessPolicyService, detectSecretLikeContent, recordTerminalOutputDecision,
  type TerminalOutputDecision } from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerMutationLock, LocalConsumedOutputLedgerWriter } from
  "../worker-local/consumed-output-ledger-local-adapter";
import { LocalProjectControlEvidenceCustody } from "../worker-local/project-control-evidence-custody-local-adapter";
import { recoveryDirectoryIdentities, revalidateRecoveryDirectoryIdentities } from
  "../worker-local/project-control-recovery-directory-identity";
import { loadJobLaunch, loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { codexGoalJobManifestPath } from "./codex-goal-jobs";
import { collectCodexGoalStatus, resolveCodexGoalWorkerLiveness } from "./codex-goal-ops";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import { LocalConsumedOutputLedgerSource } from "./application/project-control/codex-goal-consumed-output-ledger-io";
import { assertProjectControlCreateManifestPaths, projectControlConsumedOutputEvidenceRoot } from "./codex-goal-mcp-project-scope";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "./codex-goal-project-workspace-lock";
import { localReviewedWorkerOutputDeps, reviewedWorkerOutputRoot,
  assertReviewedWorkerOutputStillMatchesLocked } from "./reviewed-worker-output";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { mcpJson } from "./codex-goal-mcp-response";

/** Brokered root-admin adapter into existing custody, workspace and terminal ports. */
export async function projectControlArchiveReviewedOutput(args: ReviewedArchiveMcpArgs) {
  const { permit, bytes: intent } = await readReviewedArchivePermit(args);
  const controller = await loadProjectControlController(args);
  const { scope, registryRootDir } = controller;
  const access = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope });
  const evidenceRoot = projectControlConsumedOutputEvidenceRoot(scope);
  const ledgerRoot = scope.consumedOutputLedgerRoots?.[0];
  const name = `approved-archive-${permit.reviewedOutputId}`;
  if (registryRootDir !== permit.registryRootDir || scope.registryRoot !== registryRootDir ||
      scope.projectId !== permit.projectId || controller.controller.jobId !== permit.controllerJobId ||
      scope.consumedOutputLedgerRoots?.length !== 1 || ledgerRoot !== permit.ledgerRoot.path ||
      evidenceRoot !== permit.evidenceRoot.path || permit.archivePath !== join(evidenceRoot, name) ||
      !access.canStartWorker({ jobId: permit.workerJobId, workspacePath: permit.sourceWorkspace }).allowed) {
    throw new Error("reviewed_archive_scope_binding_mismatch");
  }
  await revalidateRecoveryDirectoryIdentities([permit.evidenceRoot, permit.ledgerRoot]);
  const loaded = await loadJobLaunch({ registryRootDir, jobId: permit.workerJobId });
  assertProjectControlCreateManifestPaths({ scope, registryRootDir, manifest: loaded.manifest });
  if (loaded.manifest.workspacePath !== permit.sourceWorkspace || loaded.manifest.jobRootDir !== permit.workerJobRootDir ||
      loaded.manifest.taskId !== permit.taskId || loaded.manifest.projectAccessScope?.projectId !== permit.projectId) {
    throw new Error("reviewed_archive_job_binding_mismatch");
  }
  const reviewedRoot = reviewedWorkerOutputRoot(registryRootDir);
  const snapshotRoot = join(reviewedRoot, permit.reviewedOutputId);
  const identities = await recoveryDirectoryIdentities([registryRootDir, dirname(registryRootDir), controller.controller.jobRootDir,
    loaded.manifest.jobRootDir, permit.sourceWorkspace, snapshotRoot,
    ...scope.consumedOutputEvidenceRoots!, ledgerRoot]);
  const custody = new LocalProjectControlEvidenceCustody();
  let archiveIdentity: (typeof identities)[number] | undefined;
  let verifiedBackup: { receiptSha256: string; files: Readonly<Record<string, string>> } | undefined;
  let verifiedPreparationSha256: string | undefined;
  let validateFirstConsumption: (() => Promise<void>) | undefined;
  const receiptPath = join(permit.archivePath, "approved-output-archive.json");
  // Outside the replaceable archive directory, under the already pinned
  // evidence root. This independently binds interrupted preparation/recovery.
  const preparationPath = join(evidenceRoot, `${name}.preparation.json`);
  const assertDirectories = async () => {
    await revalidateRecoveryDirectoryIdentities(identities);
    await revalidateRecoveryDirectoryIdentities([permit.evidenceRoot, permit.ledgerRoot,
      ...(archiveIdentity ? [archiveIdentity] : [])]);
  };
  const read = async (path: string) => {
    await assertDirectories();
    const file = await custody.readImmutableFile(path, 16 * 1024 * 1024);
    await assertDirectories();
    return Buffer.from(file.bytes);
  };
  const reviewed = localReviewedWorkerOutputDeps({ rootDir: reviewedRoot });
  const assertVerifiedBackup = async () => {
    if (!verifiedPreparationSha256 || archiveHash(await read(preparationPath)) !== verifiedPreparationSha256) {
      throw new Error("reviewed_archive_preparation_anchor_mismatch");
    }
    if (!verifiedBackup || archiveHash(await read(receiptPath)) !== verifiedBackup.receiptSha256) {
      throw new Error("reviewed_archive_receipt_hash_mismatch");
    }
    for (const [file, hash] of Object.entries(verifiedBackup.files)) {
      if (archiveHash(await read(join(permit.archivePath, file))) !== hash) throw new Error("reviewed_archive_backup_hash_mismatch");
    }
  };
  const ledgerPath = join(ledgerRoot, "items", `${permit.workerJobId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  const ledgerSource = new LocalConsumedOutputLedgerSource(scope.consumedOutputEvidenceRoots!);
  const assertNoOtherDisposition = async () => {
    await assertDirectories();
    const loaded = await ledgerSource.readEntries({ roots: [ledgerRoot] });
    const safeJobId = permit.workerJobId.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (loaded.failures.some(failure => failure.subject === ledgerRoot || failure.subject === dirname(ledgerPath) ||
      basename(failure.subject) === `${safeJobId}.json` || basename(failure.subject).startsWith(`${safeJobId}--`)) || loaded.entries.some(entry =>
      typeof entry.value === "object" && entry.value !== null && "jobId" in entry.value &&
      entry.value.jobId === permit.workerJobId && entry.ledgerPath !== ledgerPath)) {
      throw new Error("consumed_output_ledger_terminal_conflict");
    }
    await assertDirectories();
  };
  let decision: TerminalOutputDecision = {
    schemaVersion: 1, jobId: permit.workerJobId, status: "archived",
    closedAt: permit.requestedAt, archivePath: permit.archivePath,
    note: `Approved output ${permit.reviewedOutputId} retained; owner ${permit.owner}; intent ${args.expectedPermitSha256}: ${permit.reason}`,
    backup: { workspace: permit.sourceWorkspace, statusPath: join(permit.archivePath, "git-status.txt"),
      patchPath: join(permit.archivePath, "tracked.diff"), numstatPath: join(permit.archivePath, "tracked.numstat") },
  };
  const anchoredNote = (receiptSha256: string, directory: (typeof identities)[number]) =>
    `Approved output ${permit.reviewedOutputId} retained; owner ${permit.owner}; intent ${args.expectedPermitSha256}: ${permit.reason}; receipt ${receiptSha256}; archive ${directory.device}:${directory.inode}`;
  // Keep the configured identities in the native writer's existing mutation-lock
  // checks too. No new writer, lock protocol or decision schema is introduced.
  class BoundMutationLocks extends LocalConsumedOutputLedgerMutationLock {
    override async assertHeld(lease: Parameters<LocalConsumedOutputLedgerMutationLock["assertHeld"]>[0]) {
      await super.assertHeld(lease);
      await assertDirectories();
      for (const [jobId, sha256] of [[permit.controllerJobId, permit.controllerManifestSha256],
        [permit.workerJobId, permit.workerManifestSha256]]) {
        const manifest = await read(codexGoalJobManifestPath({ registryRootDir, jobId: jobId! }));
        if (archiveHash(manifest) !== sha256) throw new Error("reviewed_archive_manifest_binding_mismatch");
      }
      await assertNoOtherDisposition();
      await assertVerifiedBackup();
      await validateFirstConsumption?.();
    }
  }
  const writer = new LocalConsumedOutputLedgerWriter(new BoundMutationLocks(), dirname(registryRootDir), scope.consumedOutputEvidenceRoots);
  return await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(registryRootDir), scope,
    requestedWorkspacePath: permit.sourceWorkspace, expectedCanonicalWorkspacePath: permit.sourceWorkspace,
    owner: `reviewed-archive:${permit.workerJobId}`, effect: async ({ lease }) => {
      const originals = async () => {
        const controllerBytes = await read(codexGoalJobManifestPath({ registryRootDir, jobId: permit.controllerJobId }));
        const workerBytes = await read(codexGoalJobManifestPath({ registryRootDir, jobId: permit.workerJobId }));
        if (archiveHash(controllerBytes) !== permit.controllerManifestSha256 || archiveHash(workerBytes) !== permit.workerManifestSha256) {
          throw new Error("reviewed_archive_manifest_binding_mismatch");
        }
        const snapshot = await reviewed.store.get(permit.reviewedOutputId);
        if (!snapshot || snapshot.reviewDecision.decision !== ReviewDecisionStatus.Approved || snapshot.patchByteLength === 0 ||
            snapshot.workerJobId !== permit.workerJobId || snapshot.controllerJobId !== permit.controllerJobId ||
            snapshot.projectId !== permit.projectId || snapshot.taskId !== permit.taskId ||
            snapshot.sourceWorkspacePath !== permit.sourceWorkspace || snapshot.patchSha256 !== permit.patchSha256 ||
            archiveHash(JSON.stringify(snapshot.reviewDecision)) !== permit.reviewDecisionSha256) {
          throw new Error("reviewed_archive_approved_snapshot_required");
        }
        const manifest = await read(join(snapshotRoot, "manifest.json"));
        const nativeApprovalFile = await custody.pathKind(join(snapshotRoot, "review-attestation.json")) === "absent"
          ? "approval.json" : "review-attestation.json";
        if (permit.approvalFile !== nativeApprovalFile) throw new Error("reviewed_archive_original_approval_required");
        const approval = await read(join(snapshotRoot, permit.approvalFile));
        const marker = await read(join(snapshotRoot, `review-marker-${permit.reviewMarkerSha256}.json`));
        const patch = await read(snapshot.patchPath);
        const approvalBinding: unknown = JSON.parse(approval.toString());
        if (archiveHash(manifest) !== permit.snapshotSha256 || archiveHash(approval) !== permit.approvalSha256 ||
            archiveHash(marker) !== permit.reviewMarkerSha256 || archiveHash(patch) !== permit.patchSha256 ||
            typeof approvalBinding !== "object" || approvalBinding === null ||
            !("reviewedOutputId" in approvalBinding) || approvalBinding.reviewedOutputId !== permit.reviewedOutputId ||
            !("reviewMarkerSha256" in approvalBinding) || approvalBinding.reviewMarkerSha256 !== permit.reviewMarkerSha256) {
          throw new Error("reviewed_archive_original_hash_mismatch");
        }
        if ([manifest, approval, marker].some(bytes => detectSecretLikeContent(bytes))) {
          throw new Error("reviewed_archive_original_secret_like_content");
        }
        return { snapshot, files: { "original-manifest.json": manifest, "original-approval.json": approval,
          "original-review-marker.json": marker, "tracked.diff": patch, "owner-intent.json": intent } };
      };
      const assertQuiescent = async () => {
        await assertDirectories();
        const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(loaded.launch));
        const observation = async (path: string): Promise<unknown> => {
          try { return JSON.parse((await read(path)).toString()); }
          catch (cause) { throw new Error("reviewed_archive_source_not_quiescent", { cause }); }
        };
        // A present progress record is authoritative, including fields the
        // common status projection omits when malformed. Absence is separate.
        if (status.progressPath && await custody.pathKind(status.progressPath) !== "absent") {
          const progress = reviewedArchiveProgressSchema.safeParse(await observation(status.progressPath));
          if (!progress.success ||
              (progress.data.pid === undefined && !reviewedArchiveTerminalProgressSchema.safeParse(progress.data.status).success) ||
              progress.data.pid !== status.progressPid || progress.data.status !== status.progressStatus) {
            throw new Error("reviewed_archive_source_not_quiescent");
          }
        }
        // Validate the strict native result shape against bytes read under
        // canonical regular-file/no-follow custody, never a redirected path read.
        const result = status.resultPath
          ? reviewedArchiveDoneResultSchema.safeParse(await observation(status.resultPath))
          : undefined;
        if (status.tmuxAlive !== false || resolveCodexGoalWorkerLiveness({ status }).alive ||
            status.progressProcessAlive === true || (status.progressPid !== undefined && status.progressProcessAlive !== false) ||
            status.warnings.some(warning => warning !== "tmux session is not alive" && /tmux|progress.*unreadable/.test(warning)) ||
            status.resultExists !== true || result?.success !== true) {
          throw new Error("reviewed_archive_source_not_quiescent");
        }
        await assertDirectories();
      };
      validateFirstConsumption = async () => {
        // Once the immutable native record exists, exact replay needs no mutable
        // source recapture. All checks below precede first atomic publication.
        if (await custody.pathKind(ledgerPath) !== "absent") return;
        const current = await originals();
        await assertReviewedWorkerOutputStillMatchesLocked(reviewed, current.snapshot, lease);
        await assertQuiescent();
      };
      let original = await originals();
      await assertNoOtherDisposition();
      const archiveKind = await custody.pathKind(permit.archivePath);
      if (archiveKind !== "absent" && archiveKind !== "directory") throw new Error("reviewed_archive_location_invalid");
      if (archiveKind === "directory") {
        archiveIdentity = (await recoveryDirectoryIdentities([permit.archivePath]))[0]!;
        const intentPath = join(permit.archivePath, "owner-intent.json");
        if (await custody.pathKind(intentPath) !== "absent" && !(await read(intentPath)).equals(intent)) {
          throw new Error("reviewed_archive_preparation_conflict");
        }
      }
      const committed = await custody.pathKind(ledgerPath) !== "absent";
      let preparation: z.infer<typeof reviewedArchivePreparationSchema> | undefined;
      if (await custody.pathKind(preparationPath) !== "absent") {
        const bytes = await read(preparationPath);
        preparation = reviewedArchivePreparationSchema.parse(JSON.parse(bytes.toString()));
        if (preparation.permitSha256 !== args.expectedPermitSha256 || preparation.archiveDirectory.path !== permit.archivePath) {
          throw new Error("reviewed_archive_preparation_conflict");
        }
        await revalidateRecoveryDirectoryIdentities([preparation.archiveDirectory]);
        verifiedPreparationSha256 = archiveHash(bytes);
      }
      const hasReceipt = await custody.pathKind(receiptPath) !== "absent";
      if (hasReceipt) {
        const receiptBytes = await read(receiptPath);
        const receipt = reviewedArchiveReceiptSchema.parse(JSON.parse(receiptBytes.toString()));
        archiveIdentity = receipt.archiveDirectory;
        if (receipt.permitSha256 !== args.expectedPermitSha256 || archiveIdentity.path !== permit.archivePath) {
          throw new Error("reviewed_archive_preparation_conflict");
        }
        await assertDirectories();
        const receiptSha256 = archiveHash(receiptBytes);
        const note = anchoredNote(receiptSha256, archiveIdentity);
        // The immutable native decision, rather than the receipt's own fields,
        // anchors committed replay. Verify before adopting any receipt hashes.
        if (committed) {
          const retained = z.object({ note: z.string() }).parse(JSON.parse((await read(ledgerPath)).toString()));
          if (retained.note !== note) throw new Error("reviewed_archive_receipt_anchor_mismatch");
        }
        if (!preparation || preparation.receiptSha256 !== receiptSha256 ||
            !isDeepStrictEqual(preparation.archiveDirectory, archiveIdentity)) {
          throw new Error("reviewed_archive_preparation_anchor_mismatch");
        }
        const expectedNames = [...Object.keys(original.files), "git-status.txt", "tracked.numstat"].sort();
        if (!isDeepStrictEqual(Object.keys(receipt.files).sort(), expectedNames)) throw new Error("reviewed_archive_receipt_incomplete");
        for (const [file, hash] of Object.entries(receipt.files)) {
          if (archiveHash(await read(join(permit.archivePath, file))) !== hash) throw new Error("reviewed_archive_backup_hash_mismatch");
        }
        for (const [file, bytes] of Object.entries(original.files)) {
          if (receipt.files[file] !== archiveHash(bytes)) throw new Error("reviewed_archive_preparation_conflict");
        }
        verifiedBackup = { receiptSha256, files: receipt.files };
        decision = { ...decision, note };
      } else if (committed) throw new Error("reviewed_archive_receipt_required");
      if (!committed) {
        await assertQuiescent();
        await assertReviewedWorkerOutputStillMatchesLocked(reviewed, original.snapshot, lease);
        await assertDirectories();
      }
      if (args.confirmArchive !== true) return mcpJson({ ok: false, reason: "confirm_archive_required",
        reviewedOutputId: permit.reviewedOutputId, archivePath: permit.archivePath, permitSha256: args.expectedPermitSha256 });
      if (!hasReceipt) {
        const git = async (...argv: string[]) => Buffer.from((await promisify(execFile)("git", argv,
          { cwd: permit.sourceWorkspace, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000,
            maxBuffer: 16 * 1024 * 1024 })).stdout);
        const files = { ...original.files, "git-status.txt": await git("status", "--short", "--untracked-files=all"),
          "tracked.numstat": await git("apply", "--numstat", original.snapshot.patchPath) };
        const publish = async (fileName: string, bytes: Buffer) => {
          await assertDirectories();
          await custody.publishImmutableBytes({ root: evidenceRoot, directories: [name], fileName, bytes, expectedSha256: archiveHash(bytes) });
          archiveIdentity ??= (await recoveryDirectoryIdentities([permit.archivePath]))[0]!;
          await assertDirectories();
        };
        // Intent first prevents a different owner request from adopting partial backup.
        await publish("owner-intent.json", intent);
        const prepared = reviewedArchiveReceiptSchema.parse({ schemaVersion: 1, permitSha256: args.expectedPermitSha256,
          archiveDirectory: archiveIdentity, files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, archiveHash(bytes)])) });
        const receiptBytes = archiveBytes(prepared), receiptSha256 = archiveHash(receiptBytes);
        const preparationBytes = archiveBytes(reviewedArchivePreparationSchema.parse({
          permitSha256: args.expectedPermitSha256, receiptSha256, archiveDirectory: archiveIdentity,
        }));
        await assertDirectories();
        await custody.publishImmutableBytes({ root: evidenceRoot, directories: [], fileName: basename(preparationPath),
          bytes: preparationBytes, expectedSha256: archiveHash(preparationBytes) });
        verifiedPreparationSha256 = archiveHash(preparationBytes);
        await assertDirectories();
        for (const [file, bytes] of Object.entries(files)) {
          await publish(file, bytes);
          if (!(await read(join(permit.archivePath, file))).equals(bytes)) throw new Error("reviewed_archive_backup_hash_mismatch");
        }
        await assertQuiescent();
        await assertReviewedWorkerOutputStillMatchesLocked(reviewed, original.snapshot, lease);
        original = await originals();
        await publish("approved-output-archive.json", receiptBytes);
        verifiedBackup = { receiptSha256, files: prepared.files };
        decision = { ...decision, note: anchoredNote(receiptSha256, prepared.archiveDirectory) };
      }
      if (!committed) {
        await assertQuiescent();
        await assertReviewedWorkerOutputStillMatchesLocked(reviewed, original.snapshot, lease);
        await originals();
      }
      await assertDirectories();
      await assertVerifiedBackup();
      await writer.assertCanRecord({ ledgerRoot, decision });
      const result = await recordTerminalOutputDecision({ writer }, { allowedLedgerRoots: scope.consumedOutputLedgerRoots!, ledgerRoot, decision });
      return mcpJson({ ok: true, disposition: "archived", result });
    } });
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().refine(value => isAbsolute(value) && resolve(value) === value && !value.includes("\\"));
const text = z.string().min(1).max(1024).refine(value => value.trim() === value && !/[\x00-\x1f]/.test(value));
const identity = z.object({ path, device: z.number().int().nonnegative(), inode: z.number().int().positive() }).strict();
const reviewedArchiveProgressSchema = z.object({
  status: z.string().min(1), pid: z.number().int().positive().max(2_147_483_647).optional(),
});
const reviewedArchiveTerminalProgressSchema = z.enum(["stopped", "maintenance_paused", "completed", "partial", "failed"]);
const reviewedArchiveDoneResultSchema = z.object({
  status: z.literal("done"), changedFiles: z.array(z.string()), evidence: z.array(z.string()),
  blockers: z.array(z.string()), nextAction: z.string(),
});
const reviewedArchivePreparationSchema = z.object({
  permitSha256: hash, receiptSha256: hash, archiveDirectory: identity,
}).strict();

/** Private root-admin intent, not a new shared terminal-decision contract. */
export const reviewedArchivePermitSchema = z.object({
  schemaVersion: z.literal(1), operation: z.literal("archive_reviewed_output"),
  controllerJobId: text, projectId: text, workerJobId: text, taskId: text,
  registryRootDir: path, workerJobRootDir: path, sourceWorkspace: path,
  controllerManifestSha256: hash, workerManifestSha256: hash,
  reviewedOutputId: hash, snapshotSha256: hash, patchSha256: hash,
  reviewDecisionSha256: hash, approvalFile: z.enum(["approval.json", "review-attestation.json"]),
  approvalSha256: hash, reviewMarkerSha256: hash,
  archivePath: path, evidenceRoot: identity, ledgerRoot: identity,
  owner: text, reason: text, requestedAt: z.iso.datetime(),
}).strict();
export type ReviewedArchivePermit = z.infer<typeof reviewedArchivePermitSchema>;
export type ReviewedArchiveMcpArgs = {
  registryRootDir?: string; cwd?: string; controllerJobId: string; reviewedOutputId: string;
  permitFile: string; expectedPermitSha256: string; confirmArchive?: boolean | undefined;
};
export const archiveHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const archiveBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export const reviewedArchiveReceiptSchema = z.object({
  schemaVersion: z.literal(1), permitSha256: hash, archiveDirectory: identity,
  files: z.record(z.string(), hash),
}).strict();

export async function readReviewedArchivePermit(args: ReviewedArchiveMcpArgs) {
  if (process.geteuid?.() !== 0) throw new Error("reviewed_archive_root_required");
  path.parse(args.permitFile);
  hash.parse(args.expectedPermitSha256);
  await new LocalProjectControlEvidenceCustody().canonicalDirectory(dirname(args.permitFile));
  const handle = await open(args.permitFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || (before.mode & 0o777n) !== 0o600n || before.size > 128n * 1024n) {
      throw new Error("reviewed_archive_permit_security_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.length) !== before.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        archiveHash(bytes) !== args.expectedPermitSha256) throw new Error("reviewed_archive_permit_hash_mismatch");
    const permit = reviewedArchivePermitSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (permit.controllerJobId !== args.controllerJobId || permit.reviewedOutputId !== args.reviewedOutputId) {
      throw new Error("reviewed_archive_permit_caller_mismatch");
    }
    if (detectSecretLikeContent(bytes)) throw new Error("reviewed_archive_permit_secret_like_content");
    return { permit, bytes };
  } finally { await handle.close(); }
}
