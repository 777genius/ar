import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  AccessBoundary, RETAINED_NONQUALIFIED_BACKUP_PAYLOADS, RETAINED_NONQUALIFIED_RECEIPT_FILE, RETAINED_NONQUALIFIED_STATUS, RetainedNonqualifiedOriginalKind,
  RetainedNonqualifiedResourcePolicyId, assertRetainedNonqualifiedReceipt, createAccessPolicyService, detectSecretLikeContent,
  recordTerminalOutputDecision, retainedNonqualifiedResourceLimits,
  type RetainedNonqualifiedReceipt, type TerminalOutputDecision,
} from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerMutationLock, LocalConsumedOutputLedgerWriter } from
  "../worker-local/consumed-output-ledger-local-adapter";
import { LocalProjectControlEvidenceCustody } from "../worker-local/project-control-evidence-custody-local-adapter";
import { hashHeldImmutableFile } from "../worker-local/project-control-evidence-custody-held-stat";
import type { LinuxMemoryAvailability } from "../worker-local/linux-memory-availability";
import { recoveryDirectoryIdentities, revalidateRecoveryDirectoryIdentities } from
  "../worker-local/project-control-recovery-directory-identity";
import { loadJobLaunch, loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { codexGoalJobManifestPath } from "./codex-goal-jobs";
import { collectCodexGoalStatus, resolveCodexGoalWorkerLiveness } from "./codex-goal-ops";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import { assertRetainedReservationInactive, captureRetainedLifecycle, lifecycleBytes, retainedLifecyclePaths, retainedLifecycleTar } from "./application/project-control/codex-goal-retained-nonqualified-lifecycle";
import { LocalConsumedOutputLedgerSource } from "./application/project-control/codex-goal-consumed-output-ledger-io";
import { assertNoConflictingTerminalDisposition, terminalLedgerItemPath } from
  "./application/project-control/codex-goal-terminal-disposition-guard";
import { assertLegacyAttemptProcessEvidence, captureLegacyAttemptProcessEvidence } from
  "./application/project-control/codex-goal-legacy-attempt-process-evidence";
import { captureRetainedWorkspaceInventory } from "./application/project-control/codex-goal-retained-nonqualified-inventory";
import { captureRetainedTrackedPatch } from "./application/project-control/codex-goal-retained-nonqualified-tracked-patch";
import {
  RETAINED_CAPACITY_MARGIN_BYTES, assertRetainedActualWithinBudget, assertRetainedNonqualifiedCapacity,
  preflightRetainedResources, retainedFreeBytes, retainedScratchRoot, serializeRetainedHeavyWork, type RetainedPayloadName,
} from "./application/project-control/codex-goal-retained-nonqualified-resources";
import { defaultProjectControlGitPort } from "./application/project-control/adapters/host-command-adapters";
import { buildTar } from "./codex-goal-handoff-untracked-tar";
import { assertProjectControlCreateManifestPaths, projectControlConsumedOutputEvidenceRoot } from "./codex-goal-mcp-project-scope";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "./codex-goal-project-workspace-lock";
import { permitAbsolutePath, permitHash, readRootOwnedPermitBytes, rootPermitSha256 } from "./codex-goal-mcp-project-control-root-permit";
import { mcpJson } from "./codex-goal-mcp-response";

export { assertRetainedNonqualifiedCapacity };

const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Private root-admin intent. Not a shared contract; the shared part is the receipt. */
export const retainedNonqualifiedPermitSchema = z.object({
  schemaVersion: z.literal(1), operation: z.literal("retain_nonqualified_attempt"),
  kind: z.enum(RetainedNonqualifiedOriginalKind),
  controllerJobId: z.string().min(1).max(255), projectId: z.string().min(1).max(255),
  workerJobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/), taskId: z.string().min(1).max(255),
  registryRootDir: permitAbsolutePath, workerJobRootDir: permitAbsolutePath, sourceWorkspace: permitAbsolutePath,
  controllerManifestSha256: permitHash, workerManifestSha256: permitHash,
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  archivePath: permitAbsolutePath,
  evidenceRoot: z.object({ path: permitAbsolutePath, device: z.number().int().nonnegative(), inode: z.number().int().positive() }).strict(),
  ledgerRoot: z.object({ path: permitAbsolutePath, device: z.number().int().nonnegative(), inode: z.number().int().positive() }).strict(),
  // Exact relative paths of ignored files that are useful INPUT and must be retained. Every other ignored file
  // refuses unless it sits under a dependency/cache directory; credentials are never retained.
  ignoredRetain: z.array(z.string().min(1).max(1024).refine(value => !value.startsWith("/") &&
    !value.split("/").some(part => part === "" || part === "." || part === ".." || part === ".git"))).max(1000),
  // The finite reviewed resource policy this retention is admitted under. The permit hash binds it; there is
  // no unbounded value, environment override or caller-selected multiplier.
  resourcePolicy: z.enum(RetainedNonqualifiedResourcePolicyId),
  owner: z.string().min(1).max(1024), reason: z.string().min(1).max(1024), requestedAt: z.iso.datetime(),
}).strict();
export type RetainedNonqualifiedPermit = z.infer<typeof retainedNonqualifiedPermitSchema>;

export type RetainedNonqualifiedMcpArgs = {
  registryRootDir?: string; cwd?: string; controllerJobId: string; workerJobId: string;
  permitFile: string; expectedPermitSha256: string;
  expectedPlanSha256?: string | undefined; confirmRetention?: boolean | undefined;
};

const preparationSchema = z.object({
  permitSha256: permitHash, receiptSha256: permitHash,
  archiveDirectory: z.object({ path: permitAbsolutePath, device: z.number().int().nonnegative(), inode: z.number().int().positive() }).strict(),
}).strict();

export async function readRetainedNonqualifiedPermit(args: RetainedNonqualifiedMcpArgs) {
  const bytes = await readRootOwnedPermitBytes({ permitFile: args.permitFile,
    expectedPermitSha256: args.expectedPermitSha256, errorPrefix: "retained_nonqualified" });
  const permit = retainedNonqualifiedPermitSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (permit.controllerJobId !== args.controllerJobId || permit.workerJobId !== args.workerJobId) {
    throw new Error("retained_nonqualified_permit_caller_mismatch");
  }
  if (detectSecretLikeContent(bytes)) throw new Error("retained_nonqualified_permit_secret_like_content");
  return { permit, bytes };
}

/**
 * Brokered root-admin retention of a stopped original attempt whose terminal
 * result is absent or genuinely FAILED. It publishes private immutable custody
 * evidence first and the native `retained_nonqualified` ledger decision last,
 * under the canonical workspace lock. It never stops, replays, approves or
 * rewrites anything and creates no stop, DONE, no-output or qualification fact.
 */
export async function projectControlRetainNonqualifiedAttempt(args: RetainedNonqualifiedMcpArgs, memory?: RetainedMemoryAvailabilityPort) {
  const { permit, bytes: intent } = await readRetainedNonqualifiedPermit(args);
  return await retainNonqualifiedAttempt({ permit, intent, args, ...(memory === undefined ? {} : { memory }) });
}

/**
 * The live memory observation of the expanded policy, supplied ONLY by the Host's retention operator role after it
 * authenticated the installation, the finite operation and the memory topology. The MCP registration never passes one,
 * so a plain tool call, a permit, the environment or any caller value cannot admit `expanded_v1`: without the port the
 * first-consumption preflight refuses (`retained_nonqualified_memory_unknown`). The default policy never consults it.
 */
export type RetainedMemoryAvailabilityPort = () => Promise<LinuxMemoryAvailability>;

export async function retainNonqualifiedAttempt(input: {
  readonly permit: RetainedNonqualifiedPermit; readonly intent: Buffer; readonly args: RetainedNonqualifiedMcpArgs;
  readonly memory?: RetainedMemoryAvailabilityPort;
}) {
  const { permit, intent, args } = input;
  // One validated policy bounds every sink below (collection, recheck, publication, replay); an unsupported one refuses first.
  const limits = retainedNonqualifiedResourceLimits(permit.resourcePolicy);
  if (limits === undefined) throw new Error("retained_nonqualified_resource_policy_unsupported");
  const controller = await loadProjectControlController(args);
  const { scope, registryRootDir } = controller;
  const access = createAccessPolicyService({ boundary: AccessBoundary.ProjectScopedControl, scope });
  const evidenceRoot = projectControlConsumedOutputEvidenceRoot(scope);
  const ledgerRoot = scope.consumedOutputLedgerRoots?.[0];
  const name = `nonqualified-retention-${permit.workerJobId}`;
  if (registryRootDir !== permit.registryRootDir || scope.registryRoot !== registryRootDir ||
      scope.projectId !== permit.projectId || controller.controller.jobId !== permit.controllerJobId ||
      permit.workerJobId === permit.controllerJobId || scope.consumedOutputLedgerRoots?.length !== 1 ||
      ledgerRoot !== permit.ledgerRoot.path || evidenceRoot !== permit.evidenceRoot.path ||
      permit.archivePath !== join(evidenceRoot, name) ||
      !access.canStartWorker({ jobId: permit.workerJobId, workspacePath: permit.sourceWorkspace }).allowed) {
    throw new Error("retained_nonqualified_scope_binding_mismatch");
  }
  await revalidateRecoveryDirectoryIdentities([permit.evidenceRoot, permit.ledgerRoot]);
  const loaded = await loadJobLaunch({ registryRootDir, jobId: permit.workerJobId });
  assertProjectControlCreateManifestPaths({ scope, registryRootDir, manifest: loaded.manifest });
  if (loaded.manifest.workspacePath !== permit.sourceWorkspace || loaded.manifest.jobRootDir !== permit.workerJobRootDir ||
      loaded.manifest.taskId !== permit.taskId || loaded.manifest.projectAccessScope?.projectId !== permit.projectId) {
    throw new Error("retained_nonqualified_job_binding_mismatch");
  }
  const identities = await recoveryDirectoryIdentities([registryRootDir, dirname(registryRootDir),
    controller.controller.jobRootDir, loaded.manifest.jobRootDir, permit.sourceWorkspace,
    ...scope.consumedOutputEvidenceRoots!, ledgerRoot]);
  const custody = new LocalProjectControlEvidenceCustody();
  let archiveIdentity: (typeof identities)[number] | undefined;
  const assertDirectories = async () => {
    await revalidateRecoveryDirectoryIdentities(identities);
    await revalidateRecoveryDirectoryIdentities([permit.evidenceRoot, permit.ledgerRoot, ...(archiveIdentity ? [archiveIdentity] : [])]);
  };
  /** Held custody read with an explicit byte cap; the custody buffer is returned without a second copy. */
  const read = async (path: string, max: number = limits.gitMetadataBytes) => {
    await assertDirectories();
    const file = await custody.readImmutableFile(path, max);
    await assertDirectories();
    return Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes);
  };
  const manifestHashes = async () => {
    for (const [jobId, sha256] of [[permit.controllerJobId, permit.controllerManifestSha256],
      [permit.workerJobId, permit.workerManifestSha256]] as const) {
      if (rootPermitSha256(await read(codexGoalJobManifestPath({ registryRootDir, jobId }))) !== sha256) {
        throw new Error("retained_nonqualified_manifest_binding_mismatch");
      }
    }
  };
  const ledgerSource = new LocalConsumedOutputLedgerSource(scope.consumedOutputEvidenceRoots!);
  const ledgerPath = terminalLedgerItemPath(ledgerRoot, permit.workerJobId);
  const assertNoOtherDisposition = async () => {
    await assertDirectories();
    await assertNoConflictingTerminalDisposition({ source: ledgerSource, ledgerRoot, jobId: permit.workerJobId });
    await assertDirectories();
  };
  const receiptPath = join(permit.archivePath, RETAINED_NONQUALIFIED_RECEIPT_FILE);
  // Outside the replaceable directory, under the pinned evidence root: binds an
  // interrupted preparation to this exact permit, receipt and directory.
  const preparationPath = join(evidenceRoot, `${name}.preparation.json`);
  const backupNames = RETAINED_NONQUALIFIED_BACKUP_PAYLOADS;
  let verified: { receiptSha256: string; files: Readonly<Record<string, string>>;
    lengths: Readonly<Record<string, number>> | undefined } | undefined;
  const assertVerifiedBackup = async () => {
    if (!verified || rootPermitSha256(await read(receiptPath, limits.receiptBytes)) !== verified.receiptSha256) {
      throw new Error("retained_nonqualified_receipt_hash_mismatch");
    }
    for (const [file, hash] of Object.entries(verified.files)) {
      // A v2 receipt records each payload's actual length: the read is capped at it and must match it exactly. The
      // payload is hashed as a stream through the held descriptor, so verification never allocates the payload.
      const declared = verified.lengths?.[file];
      await assertDirectories();
      const actual = await hashHeldImmutableFile(join(permit.archivePath, file), declared ?? limits.payloadBytes);
      await assertDirectories();
      if ((declared !== undefined && actual.length !== declared) || actual.sha256 !== hash) {
        throw new Error("retained_nonqualified_backup_hash_mismatch");
      }
    }
  };
  const decisionFor = (receiptSha256: string, directory: { device: number; inode: number }): TerminalOutputDecision => ({
    schemaVersion: 1, jobId: permit.workerJobId, status: RETAINED_NONQUALIFIED_STATUS, closedAt: permit.requestedAt,
    archivePath: permit.archivePath,
    note: `Retained nonqualified original attempt (${permit.kind}); owner ${permit.owner}; intent ${args.expectedPermitSha256}: ` +
      `${permit.reason}; receipt ${receiptSha256}; archive ${directory.device}:${directory.inode}. ` +
      "Custody only: no approval, stop, result, output or qualification is implied and replay is not authorized.",
    retention: { schemaVersion: 1, kind: permit.kind, receiptPath, receiptSha256, sourceQualification: "not_assessed", replayAuthorized: false },
    backup: { workspace: permit.sourceWorkspace, statusPath: join(permit.archivePath, "git-status.txt"),
      patchPath: join(permit.archivePath, "tracked.diff"), numstatPath: join(permit.archivePath, "tracked.numstat"),
      untrackedArchivePath: join(permit.archivePath, "untracked.tar") },
  });

  /** Observation of the stopped original attempt, rechecked at every boundary. */
  let lockedLaunch = loaded.launch;
  let recheck: (() => Promise<void>) | undefined;
  class BoundMutationLocks extends LocalConsumedOutputLedgerMutationLock {
    override async assertHeld(lease: Parameters<LocalConsumedOutputLedgerMutationLock["assertHeld"]>[0]) {
      await super.assertHeld(lease);
      await assertDirectories();
      await manifestHashes();
      await assertNoOtherDisposition();
      await assertVerifiedBackup();
      // First consumption only: replay of the immutable native record needs no source recapture.
      if (await custody.pathKind(ledgerPath) === "absent") await recheck?.();
    }
  }
  const writer = new LocalConsumedOutputLedgerWriter(new BoundMutationLocks(), dirname(registryRootDir), scope.consumedOutputEvidenceRoots);
  // Heavy buffering runs one operation at a time in this process; other processes are not coordinated.
  return await serializeRetainedHeavyWork(async () => await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(registryRootDir), scope,
    requestedWorkspacePath: permit.sourceWorkspace, expectedCanonicalWorkspacePath: permit.sourceWorkspace,
    owner: `retain-nonqualified:${permit.workerJobId}`, effect: async () => {
      await manifestHashes();
      await assertNoOtherDisposition();
      const archiveKind = await custody.pathKind(permit.archivePath);
      if (archiveKind !== "absent" && archiveKind !== "directory") throw new Error("retained_nonqualified_location_invalid");
      if (archiveKind === "directory") {
        archiveIdentity = (await recoveryDirectoryIdentities([permit.archivePath]))[0]!;
        const intentPath = join(permit.archivePath, "owner-intent.json");
        // An existing owner intent must equal THIS permit's intent byte for byte, so the read is capped at exactly
        // intent.length: a grown or tampered file is refused by the custody reader before it is buffered, never
        // admitted at the generic payload allowance (512 MiB under the expanded policy) ahead of memory admission.
        if (await custody.pathKind(intentPath) !== "absent") {
          let existing: Buffer;
          try { existing = await read(intentPath, intent.length); }
          catch (cause) { throw new Error("retained_nonqualified_preparation_conflict", { cause }); }
          if (!existing.equals(intent)) throw new Error("retained_nonqualified_preparation_conflict");
        }
      }
      let preparation: z.infer<typeof preparationSchema> | undefined;
      if (await custody.pathKind(preparationPath) !== "absent") {
        preparation = preparationSchema.parse(JSON.parse((await read(preparationPath)).toString()));
        if (preparation.permitSha256 !== args.expectedPermitSha256 || preparation.archiveDirectory.path !== permit.archivePath) {
          throw new Error("retained_nonqualified_preparation_conflict");
        }
        await revalidateRecoveryDirectoryIdentities([preparation.archiveDirectory]);
        archiveIdentity = preparation.archiveDirectory;
      }
      // Committed replay: the immutable native record is the anchor. Verify the
      // retained bytes it names and let the writer confirm exact idempotence.
      if (await custody.pathKind(ledgerPath) !== "absent") {
        if (!preparation) throw new Error("retained_nonqualified_preparation_required");
        const receiptBytes = await read(receiptPath, limits.receiptBytes);
        const receipt = assertRetainedNonqualifiedReceipt(JSON.parse(receiptBytes.toString()));
        // The receipt's own validated policy must be the one this permit names; its lengths bound every read below.
        const receiptPolicy = receipt.schemaVersion === 2 ? receipt.resourcePolicy : RetainedNonqualifiedResourcePolicyId.Default;
        if (receipt.permitSha256 !== args.expectedPermitSha256 || receipt.workerJobId !== permit.workerJobId ||
            receiptPolicy !== permit.resourcePolicy) {
          throw new Error("retained_nonqualified_receipt_conflict");
        }
        // Complete policy and lengths are validated above (receipt validator) BEFORE any large read. Replay only streams
        // hashes of the payloads (never a payload allocation), so it needs no memory authority under any policy.
        verified = { receiptSha256: rootPermitSha256(receiptBytes), files: receipt.backupFiles, lengths: receipt.payloadLengths };
        if (preparation.receiptSha256 !== verified.receiptSha256) throw new Error("retained_nonqualified_preparation_anchor_mismatch");
        const replay = await recordTerminalOutputDecision({ writer }, { allowedLedgerRoots: scope.consumedOutputLedgerRoots!, ledgerRoot,
          decision: decisionFor(verified.receiptSha256, preparation.archiveDirectory) });
        return mcpJson({ ok: true, disposition: RETAINED_NONQUALIFIED_STATUS, result: replay });
      }

      // ---- First consumption: observe the stopped attempt and build the exact plan.
      const custodyPaths = [permit.sourceWorkspace, permit.workerJobRootDir].sort(); // the evidence contract expects sorted paths
      const lifecyclePaths = retainedLifecyclePaths(loaded.manifest, registryRootDir);
      const inventoryOptions = { ignoredRetain: [...permit.ignoredRetain].sort(), limits };
      // Resource preflight BEFORE any full-buffer collection: metadata-only listing and held-descriptor sizes,
      // the complete backup budget, actual durable and scratch free space, and (expanded policy) memory admission.
      const preflight = await preflightRetainedResources({ policy: permit.resourcePolicy, limits, workspacePath: permit.sourceWorkspace,
        ignoredRetain: inventoryOptions.ignoredRetain, lifecyclePaths, intentBytes: intent.length, durablePath: evidenceRoot,
        ...(input.memory === undefined ? {} : { readMemory: input.memory }) });
      const observe = async () => {
        await assertDirectories();
        const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(lockedLaunch));
        // Every lifecycle original is captured as exact bytes + mode (or an absent state) from manifest-derived paths.
        const lifecycleCapture = await captureRetainedLifecycle(lifecyclePaths, { collect: true, maxBytes: limits.lifecycleBytes });
        const progress = lifecycleCapture.states.progress;
        if (progress.state === "present") {
          const parsed = z.object({ status: z.string().min(1), pid: z.number().int().positive().max(2_147_483_647).optional() })
            .safeParse(JSON.parse(lifecycleBytes(lifecycleCapture, "progress")!.toString()));
          if (!parsed.success || parsed.data.pid !== status.progressPid || parsed.data.status !== status.progressStatus) {
            throw new Error("retained_nonqualified_source_not_quiescent");
          }
        }
        // A stale "running" progress record is expected here; a live process is not.
        if (status.tmuxAlive !== false || resolveCodexGoalWorkerLiveness({ status }).alive || status.progressProcessAlive === true ||
            (status.progressPid !== undefined && status.progressProcessAlive !== false) ||
            status.warnings.some(warning => warning !== "tmux session is not alive" && /tmux|progress.*unreadable/.test(warning))) {
          throw new Error("retained_nonqualified_source_not_quiescent");
        }
        // No descendant or other process may hold the workspace or job root.
        let processes;
        try { processes = await captureLegacyAttemptProcessEvidence({ custodyPaths }); }
        catch (cause) {
          throw new Error(`retained_nonqualified_process_inventory_unavailable:${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
        if (processes.blockers.length > 0) {
          throw new Error(`retained_nonqualified_writer_present:pids=${processes.blockers.map(blocker => blocker.pid).join(",")}`);
        }
        assertLegacyAttemptProcessEvidence(processes, custodyPaths);
        let resultStatus: "failed" | undefined;
        if (lifecycleCapture.states.result.state === "present") {
          const parsed: unknown = JSON.parse(lifecycleBytes(lifecycleCapture, "result")!.toString());
          // Only a genuine FAILED result qualifies; done/partial/blocked/etc. are other facts.
          if (typeof parsed !== "object" || parsed === null || !("status" in parsed) || parsed.status !== "failed") {
            throw new Error("retained_nonqualified_result_not_failed");
          }
          resultStatus = "failed";
        }
        const kind = resultStatus === undefined ? RetainedNonqualifiedOriginalKind.ResultMissing : RetainedNonqualifiedOriginalKind.FailedCheckpoint;
        if (kind !== permit.kind) throw new Error("retained_nonqualified_kind_mismatch");
        assertRetainedReservationInactive(lifecycleBytes(lifecycleCapture, "accountReservation"));
        await assertDirectories();
        return { lifecycleCapture, resultStatus };
      };
      const git = async (...argv: string[]) => Buffer.from((await defaultProjectControlGitPort.runBuffered({
        args: ["-C", permit.sourceWorkspace, ...argv], timeoutMs: 20_000, maxBuffer: limits.gitMetadataBytes,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout);
      // The raw per-file arrays and lifecycle buffers live only inside this scope; once the archives are built
      // only their small summaries survive, so the large copies can be released before publication.
      const collectPlan = async () => {
        const lifecycle = await observe();
        const inventory = await captureRetainedWorkspaceInventory(permit.sourceWorkspace, { ...inventoryOptions, collect: true });
        if (inventory.headCommit !== permit.baseCommit) throw new Error("retained_nonqualified_base_mismatch");
        if (inventory.entries.length === 0) throw new Error("retained_nonqualified_inventory_empty");
        const files: Record<RetainedPayloadName, Buffer> = {
          "owner-intent.json": intent,
          "git-status.txt": await git("status", "--short", "--untracked-files=all"),
          // Tracked-only HEAD-to-worktree patch; untracked and retained ignored bytes are in untracked.tar.
          "tracked.diff": await captureRetainedTrackedPatch({ workspacePath: permit.sourceWorkspace, maxBytes: limits.patchBytes }),
          "tracked.numstat": await git("diff", "--numstat", "--no-renames", "HEAD", "--"),
          "untracked.tar": buildTar(inventory.untrackedFiles),
          "staged.tar": buildTar(inventory.stagedFiles),
          "lifecycle.tar": retainedLifecycleTar(lifecycle.lifecycleCapture.files),
        };
        return { files, states: lifecycle.lifecycleCapture.states, resultStatus: lifecycle.resultStatus,
          summary: { headCommit: inventory.headCommit, digest: inventory.digest, totalBytes: inventory.totalBytes,
            entries: inventory.entries, disposableListing: inventory.disposableListing } };
      };
      const plan = await collectPlan();
      const files = plan.files;
      const backupFiles = Object.fromEntries(backupNames.map(file => [file, rootPermitSha256(files[file])]));
      const payloadLengths = Object.fromEntries(backupNames.map(file => [file, files[file].length])) as Record<RetainedPayloadName, number>;
      const receipt: RetainedNonqualifiedReceipt = { schemaVersion: 2, resourcePolicy: permit.resourcePolicy, payloadLengths,
        operation: "retain_nonqualified_attempt", kind: permit.kind,
        sourceQualification: "not_assessed", replayAuthorized: false, permitSha256: args.expectedPermitSha256,
        projectId: permit.projectId, controllerJobId: permit.controllerJobId, workerJobId: permit.workerJobId, taskId: permit.taskId,
        workspace: permit.sourceWorkspace, headCommit: plan.summary.headCommit,
        controllerManifestSha256: permit.controllerManifestSha256, workerManifestSha256: permit.workerManifestSha256,
        original: { ...plan.states, ...(plan.resultStatus ? { resultStatus: plan.resultStatus } : {}) },
        ignored: { retain: inventoryOptions.ignoredRetain, disposableListing: plan.summary.disposableListing },
        inventory: { digest: plan.summary.digest, totalBytes: plan.summary.totalBytes, entries: plan.summary.entries },
        backupFiles, retainedAt: permit.requestedAt };
      assertRetainedNonqualifiedReceipt(receipt);
      const receiptBytes = jsonBytes(receipt), receiptSha256 = rootPermitSha256(receiptBytes);
      // Actual lengths must still be inside what the preflight admitted: growth refuses, nothing is truncated.
      assertRetainedActualWithinBudget(preflight.budget, limits, payloadLengths, receiptBytes.length);
      if (detectSecretLikeContent(receiptBytes)) throw new Error("retained_nonqualified_receipt_secret_like_content");
      if (preparation && preparation.receiptSha256 !== receiptSha256) throw new Error("retained_nonqualified_preparation_conflict");
      const planSha256 = receiptSha256;
      // Exact measured requirement against current free space on both the durable target and scratch.
      const requiredBytes = Object.values(payloadLengths).reduce((sum, length) => sum + length, receiptBytes.length) + RETAINED_CAPACITY_MARGIN_BYTES;
      const capacity = assertRetainedNonqualifiedCapacity({ requiredBytes, durableFreeBytes: await retainedFreeBytes(evidenceRoot),
        scratchFreeBytes: await retainedFreeBytes(retainedScratchRoot()) });
      recheck = async () => {
        const again = await observe();
        const current = await captureRetainedWorkspaceInventory(permit.sourceWorkspace, inventoryOptions);
        // The whole lifecycle (result, progress, events, stop event, reservation, manifest, log, prompt) and the
        // complete inventory including the independent index must still be exactly what the plan archived.
        if (current.digest !== plan.summary.digest || !isDeepStrictEqual(again.lifecycleCapture.states, plan.states)) {
          throw new Error("retained_nonqualified_source_changed");
        }
      };
      if (args.confirmRetention !== true) {
        return mcpJson({ ok: false, reason: "confirm_retention_required", planSha256, kind: permit.kind, archivePath: permit.archivePath,
          permitSha256: args.expectedPermitSha256, headCommit: plan.summary.headCommit, inventoryDigest: plan.summary.digest,
          inventoryEntries: plan.summary.entries.length, inventoryBytes: plan.summary.totalBytes, resourcePolicy: permit.resourcePolicy,
          backupFiles, payloadLengths, capacity, memory: preflight.memory ?? null });
      }
      if (args.expectedPlanSha256 !== planSha256) throw new Error("retained_nonqualified_plan_mismatch");

      // ---- Publish private complete evidence first; receipt last; then the native decision.
      const publish = async (fileName: string, bytes: Buffer) => {
        await assertDirectories();
        await custody.publishImmutableBytes({ root: evidenceRoot, directories: [name], fileName, bytes, expectedSha256: rootPermitSha256(bytes) });
        archiveIdentity ??= (await recoveryDirectoryIdentities([permit.archivePath]))[0]!;
        await assertDirectories();
      };
      await publish("owner-intent.json", intent); // intent first: another request cannot adopt a partial backup
      const preparationBytes = jsonBytes(preparationSchema.parse({ permitSha256: args.expectedPermitSha256, receiptSha256, archiveDirectory: archiveIdentity }));
      await custody.publishImmutableBytes({ root: evidenceRoot, directories: [], fileName: basename(preparationPath), bytes: preparationBytes,
        expectedSha256: rootPermitSha256(preparationBytes) });
      await assertDirectories();
      for (const file of backupNames) {
        await publish(file, files[file]);
        if (!(await read(join(permit.archivePath, file), files[file].length)).equals(files[file])) {
          throw new Error("retained_nonqualified_backup_hash_mismatch");
        }
      }
      await recheck();
      await publish(RETAINED_NONQUALIFIED_RECEIPT_FILE, receiptBytes);
      verified = { receiptSha256, files: backupFiles, lengths: payloadLengths };
      await recheck();
      await assertDirectories();
      await assertVerifiedBackup();
      const decision = decisionFor(receiptSha256, archiveIdentity!);
      await writer.assertCanRecord({ ledgerRoot, decision });
      const result = await recordTerminalOutputDecision({ writer }, { allowedLedgerRoots: scope.consumedOutputLedgerRoots!, ledgerRoot, decision });
      return mcpJson({ ok: true, disposition: RETAINED_NONQUALIFIED_STATUS, planSha256, result });
    } }));
}
