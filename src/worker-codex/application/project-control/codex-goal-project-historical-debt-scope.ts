import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  ProjectDebtReason, ProjectDebtScope,
  type ProjectAdmissionScopedContext, type ProjectAdmissionPhysicalRoot, type ProjectDebtItem,
} from "@vioxen/subscription-runtime/worker-core";
import { readKernelMountTable } from "../../host-scratch-mount";
import { prospectiveAdmissionResourceBacking } from "./codex-goal-project-admission-paths";
import { pathInsideOrEqual } from "./codex-goal-project-utils";
import type { WriterCensusEntry } from "./codex-goal-project-scoped-admission";

/** Attribution is not authority. Only a fresh exact source record, current
 * owner and all retained resource backings may retire historical blocking debt.
 * Missing/relocated/ambiguous history remains conservative; no repair is made. */
export async function historicalDebtIsPhysicallyUnrelated(
  item: ProjectDebtItem,
  target: ProjectAdmissionScopedContext["target"],
  census: readonly WriterCensusEntry[],
  requestedJobId: string | undefined,
  revalidate: (entry: WriterCensusEntry) => Promise<boolean>,
): Promise<boolean> {
  if (item.reason !== ProjectDebtReason.IncompleteConsumedOutputRecord ||
      item.scope !== ProjectDebtScope.RetainedOutput || !item.retainedOutput ||
      !target.physicalWritableRoots?.length) return false;
  const record = item.retainedOutput;
  if (record.jobId === requestedJobId || !/^[a-f0-9]{64}$/.test(record.ledgerSha256)) return false;
  const matches = census.filter(entry => entry.jobId === record.jobId);
  const writer = matches.length === 1 ? matches[0] : undefined;
  if (!writer?.manifest || writer.authority === "unknown" ||
      writer.manifest.workspacePath !== record.workspacePath ||
      writer.workspacePath !== record.workspacePath || !writer.canonicalWorkspacePath) return false;
  if (writer.authority === "allocated" && (!writer.writableRoots?.length ||
      writer.writableRoots.some(root => target.physicalWritableRoots!.some(candidate =>
        root.device === candidate.device && overlaps(root.backingPath, candidate.backingPath))))) return false;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (await realpath(record.workspacePath) !== writer.canonicalWorkspacePath ||
        await realpath(record.ledgerPath) !== record.ledgerPath) return false;
    file = await open(record.ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 1_048_576n) return false;
    const table = readKernelMountTable();
    const currentTargets = (await Promise.all((target.writableRoots ?? []).map(prospectiveAdmissionResourceBacking))).flat();
    if (currentTargets.some(root => root === undefined) || !currentTargets.length ||
        JSON.stringify(currentTargets) !== JSON.stringify(target.physicalWritableRoots)) return false;
    // The source may grow after stat. Never read beyond the actual byte bound.
    const limit = 1_048_576;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) return false;
    const bytes = buffer.subarray(0, length);
    if (createHash("sha256").update(bytes).digest("hex") !== record.ledgerSha256) return false;
    const resourceBindings: (readonly ProjectAdmissionPhysicalRoot[])[] = [];
    for (const path of record.resourcePaths) {
      const roots = await prospectiveAdmissionResourceBacking(path);
      if (!roots?.length || roots.some(root => target.physicalWritableRoots!.some(candidate =>
        root.device === candidate.device && overlaps(root.backingPath, candidate.backingPath)))) return false;
      resourceBindings.push(roots);
    }
    if (!await revalidate(writer) || readKernelMountTable() !== table) return false;
    // Owner reads can yield. Recheck each observed name, not only the ledger:
    // replacing a backup or target leaf does not necessarily change mountinfo.
    const finalTargets = (await Promise.all((target.writableRoots ?? []).map(prospectiveAdmissionResourceBacking))).flat();
    const finalResources = await Promise.all(record.resourcePaths.map(prospectiveAdmissionResourceBacking));
    if (!isDeepStrictEqual(finalTargets, currentTargets) ||
        !isDeepStrictEqual(finalResources, resourceBindings) || readKernelMountTable() !== table) return false;
    const after = await file.stat({ bigint: true }), visible = await lstat(record.ledgerPath, { bigint: true });
    return !visible.isSymbolicLink() && visible.isFile() && visible.nlink === 1n &&
      [after, visible].every(info => info.dev === before.dev && info.ino === before.ino &&
        info.size === before.size && info.ctimeNs === before.ctimeNs && info.mtimeNs === before.mtimeNs) &&
      await realpath(record.ledgerPath) === record.ledgerPath &&
      await realpath(record.workspacePath) === writer.canonicalWorkspacePath;
  } catch { return false; }
  finally { await file?.close(); }
}

function overlaps(left: string, right: string): boolean {
  return pathInsideOrEqual(left, right) || pathInsideOrEqual(right, left);
}
