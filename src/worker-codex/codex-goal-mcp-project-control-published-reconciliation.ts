import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { LocalConsumedOutputLedgerWriter, LocalProjectControlEvidenceCustody } from "@vioxen/subscription-runtime/worker-local";
import { loadJobLaunch, loadProjectControlController } from "./codex-goal-mcp-project-control-deps";
import { codexGoalStatusInputFromLaunch } from "./codex-goal-mcp-status-input";
import { collectCodexGoalStatus, resolveCodexGoalWorkerLiveness } from "./codex-goal-ops";
import { mcpJson } from "./codex-goal-mcp-response";
import { projectControlConsumedOutputEvidenceRoot } from "./codex-goal-mcp-project-scope";
import { projectControlCanonicalWorkspacePath } from "./application/project-control/codex-goal-project-workspace-scope";
import { projectControlWorkspaceLocks, withValidatedProjectWorkspaceLock } from "./codex-goal-project-workspace-lock";
import { localReviewedWorkerOutputDeps, reviewedWorkerOutputRoot,
  assertReviewedWorkerOutputStillMatchesLocked } from "./reviewed-worker-output";
import { incorporationBytes, incorporationHash, incorporationPermitSchema, incorporationReceiptSchema, incorporationEvidenceReferences } from
  "./published-output-reconciliation/domain/publication-incorporation";
import { verifyPublishedOutputIncorporation } from "./published-output-reconciliation/adapters/local-git-incorporation";
import { reconcilePublishedReviewedOutput } from "./published-output-reconciliation/application/reconcile-published-reviewed-output";
import { readRuntimeResultBrief } from "./application/codex-goal-runtime-result";

export type PublishedReconciliationMcpArgs = {
  registryRootDir?: string; cwd?: string; controllerJobId: string; reviewedOutputId: string;
  permitFile: string; expectedPermitSha256: string; confirmReconciliation?: boolean;
};

export async function readPublishedReconciliationPermit(args: PublishedReconciliationMcpArgs) {
  if (process.geteuid?.() !== 0) throw new Error("published_output_reconciliation_root_required");
  if (!isAbsolute(args.permitFile)) throw new Error("published_output_permit_absolute_required");
  const handle = await open(args.permitFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600 || stat.size > 128 * 1024) {
      throw new Error("published_output_permit_security_invalid");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs ||
        incorporationHash(bytes) !== args.expectedPermitSha256) throw new Error("published_output_permit_hash_mismatch");
    const permit = incorporationPermitSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (permit.controllerJobId !== args.controllerJobId || permit.reviewedOutputId !== args.reviewedOutputId) {
      throw new Error("published_output_permit_caller_binding_mismatch");
    }
    return { permit, bytes };
  } finally { await handle.close(); }
}

export async function projectControlReconcilePublishedReviewedOutput(args: PublishedReconciliationMcpArgs) {
  const { permit, bytes: permitBytes } = await readPublishedReconciliationPermit(args);
  const controller = await loadProjectControlController(args);
  if (!args.confirmReconciliation) return mcpJson({ ok: false, reason: "confirm_reconciliation_required" });
  await projectControlCanonicalWorkspacePath(permit.targetWorkspace, controller.scope);
  const loaded = await loadJobLaunch({ registryRootDir: controller.registryRootDir, jobId: permit.workerJobId });
  if (loaded.manifest.workspacePath !== permit.sourceWorkspace ||
      loaded.manifest.projectAccessScope?.projectId !== permit.projectId) throw new Error("published_output_source_job_binding_mismatch");
  const reviewed = localReviewedWorkerOutputDeps({ rootDir: reviewedWorkerOutputRoot(controller.registryRootDir) });
  const custody = new LocalProjectControlEvidenceCustody();
  const evidenceRoot = projectControlConsumedOutputEvidenceRoot(controller.scope);
  const name = `published-${permit.reviewedOutputId}-${permit.publishedSha}`;
  const archivePath = join(evidenceRoot, name);
  const ledgerRoot = controller.scope.consumedOutputLedgerRoots?.[0];
  if (!ledgerRoot || controller.scope.consumedOutputLedgerRoots?.length !== 1) throw new Error("published_output_reconciliation_ledger_required");
  const writer = new LocalConsumedOutputLedgerWriter(undefined, dirname(controller.registryRootDir), controller.scope.consumedOutputEvidenceRoots);
  const read = async (file: string) => Buffer.from((await custody.readImmutableFile(join(archivePath, file), 16 * 1024 * 1024)).bytes);
  return await withValidatedProjectWorkspaceLock({ locks: projectControlWorkspaceLocks(controller.registryRootDir),
    scope: controller.scope, requestedWorkspacePath: permit.sourceWorkspace,
    expectedCanonicalWorkspacePath: permit.sourceWorkspace, owner: `publication-reconciliation:${permit.workerJobId}`,
    effect: async ({ lease }) => {
      const result = await reconcilePublishedReviewedOutput({
        loadSnapshot: async (id) => {
          const snapshot = await reviewed.store.get(id);
          if (snapshot && snapshot.taskId !== loaded.manifest.taskId) throw new Error("published_output_task_binding_mismatch");
          return snapshot;
        },
        readPatch: (snapshot) => reviewed.store.readPatch(snapshot),
        assertSourceMatches: async (snapshot) => {
          await assertReviewedWorkerOutputStillMatchesLocked(reviewed, snapshot, lease);
        },
        assertQuiescent: async () => {
          const status = await collectCodexGoalStatus(codexGoalStatusInputFromLaunch(loaded.launch));
          const result = status.resultPath ? await readRuntimeResultBrief(status.resultPath) : {};
          if (status.tmuxAlive !== false || resolveCodexGoalWorkerLiveness({ status }).alive ||
              status.progressProcessAlive === true ||
              (status.progressPid !== undefined && status.progressProcessAlive !== false) ||
              status.resultExists !== true || result.strict !== true || result.status !== "done") {
            throw new Error("published_output_source_not_quiescent");
          }
        },
        verify: (snapshot, patch) => verifyPublishedOutputIncorporation({ permit, patch,
          changedFiles: snapshot.changedFiles, tempRoot: join(controller.controller.jobRootDir, ".publication-verification") }),
        readStatus: async () => Buffer.from((await promisify(execFile)("git",
          ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: permit.sourceWorkspace,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000 })).stdout),
        readPrepared: async () => {
          if (await custody.pathKind(join(archivePath, "publication-incorporation.json")) === "absent") return undefined;
          const receipt = incorporationReceiptSchema.parse(JSON.parse((await read("publication-incorporation.json")).toString()));
          if (!(await read("permit.json")).equals(permitBytes) ||
              incorporationHash(await read("tracked.diff")) !== permit.patchSha256) throw new Error("published_output_preparation_conflict");
          for (const proof of incorporationEvidenceReferences(permit)) {
            if (incorporationHash(await read(`proof-${proof.sha256}.json`)) !== proof.sha256) throw new Error("published_output_raw_evidence_hash_mismatch");
          }
          return { receipt, status: await read("git-status.txt") };
        },
        publish: async (receipt, patch, status) => {
          for (const proof of incorporationEvidenceReferences(permit)) {
            const stat = await lstat(proof.path);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
              throw new Error("published_output_raw_evidence_security_invalid");
            }
            const raw = await custody.readImmutableFile(proof.path, 16 * 1024 * 1024);
            if (raw.sha256 !== proof.sha256) throw new Error("published_output_raw_evidence_hash_mismatch");
            await custody.publishImmutableBytes({ root: evidenceRoot, directories: [name],
              fileName: `proof-${proof.sha256}.json`, bytes: raw.bytes, expectedSha256: proof.sha256 });
          }
          for (const [fileName, contents] of [["permit.json", permitBytes], ["tracked.diff", Buffer.from(patch)],
            ["git-status.txt", status], ["publication-incorporation.json", incorporationBytes(receipt)]] as const) {
            await custody.publishImmutableBytes({ root: evidenceRoot, directories: [name], fileName,
              bytes: contents, expectedSha256: incorporationHash(contents) });
          }
        },
        writer,
        isCommitted: async (decision) => {
          await writer.assertCanRecord({ ledgerRoot, decision });
          return await custody.pathKind(join(ledgerRoot, "items", `${permit.workerJobId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`)) === "file";
        },
      }, { scope: controller.scope, controllerJobId: controller.controller.jobId,
        permit, permitSha256: args.expectedPermitSha256, archivePath });
      return mcpJson({ ok: true, provenance: "operator_attested_publication_incorporation", result });
    },
  });
}
