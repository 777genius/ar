import { createHash } from "node:crypto";
import { opendir, readdir, readFile, readlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export type LegacyAttemptProcessEvidence = {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly inspectedPidCount: number;
  readonly inventorySha256: string;
  readonly custodyPaths: readonly string[];
  readonly blockers: readonly {
    readonly pid: number;
    readonly startTime: string;
    readonly argvSha256: string;
    readonly cwd: string;
  }[];
};

const MAX_PROCESS_COUNT = 65_536;
// Bound the whole observation, rather than rejecting an unrelated process
// solely because its descriptor table exceeds a small per-process limit.
const MAX_TOTAL_FD_COUNT = 262_144;
const MAX_INVENTORY_DURATION_MS = 30_000;
const MAX_CMDLINE_BYTES = 1024 * 1024;

export function assertLegacyAttemptProcessEvidence(
  evidence: LegacyAttemptProcessEvidence,
  custodyPaths: readonly string[],
): void {
  if (evidence.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    JSON.stringify(evidence.custodyPaths) !== JSON.stringify(custodyPaths) ||
    !Number.isSafeInteger(evidence.inspectedPidCount) ||
    !/^[a-f0-9]{64}$/.test(evidence.inventorySha256) ||
    !Array.isArray(evidence.blockers)) {
    throw new Error("legacy_attempt_quarantine_process_evidence_invalid");
  }
  if (evidence.blockers.length > 0) {
    throw new Error("legacy_attempt_quarantine_processes_active");
  }
}

/**
 * Capture fail-closed Linux process evidence for legacy integration custody.
 * Raw argv is deliberately not persisted because it can contain credentials.
 */
export async function captureLegacyAttemptProcessEvidence(input: {
  readonly custodyPaths: readonly string[];
  readonly selfPid?: number;
  readonly now?: () => Date;
  readonly procRoot?: string;
}): Promise<LegacyAttemptProcessEvidence> {
  const fdBudget = { remaining: MAX_TOTAL_FD_COUNT,
    deadline: performance.now() + MAX_INVENTORY_DURATION_MS };
  const procRoot = resolve(input.procRoot ?? "/proc");
  const custodyPaths = [...new Set(input.custodyPaths.map((path) => resolve(path)))]
    .sort();
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    throw new Error("legacy_attempt_quarantine_process_inventory_unavailable");
  }
  if (entries.length > MAX_PROCESS_COUNT) {
    throw new Error("legacy_attempt_quarantine_process_inventory_too_large");
  }
  const blockers: LegacyAttemptProcessEvidence["blockers"][number][] = [];
  const inventory: string[] = [];
  let inspectedPidCount = 0;
  for (const entry of entries.filter((value) => /^\d+$/.test(value)).sort()) {
    const pid = Number(entry);
    if (pid === (input.selfPid ?? process.pid)) continue;
    try {
      if (performance.now() > fdBudget.deadline) {
        throw new Error("legacy_attempt_quarantine_process_inventory_timeout");
      }
      const before = await processStartTime(procRoot, pid);
      const [cmdline, cwd] = await Promise.all([
        readFile(`${procRoot}/${pid}/cmdline`),
        readlink(`${procRoot}/${pid}/cwd`),
      ]);
      const fdTargets = await processFileDescriptorTargets(procRoot, pid, fdBudget);
      if (cmdline.length > MAX_CMDLINE_BYTES) {
        throw new Error("legacy_attempt_quarantine_process_cmdline_too_large");
      }
      const after = await processStartTime(procRoot, pid);
      if (before !== after) {
        throw new Error("legacy_attempt_quarantine_process_pid_churn");
      }
      inspectedPidCount += 1;
      const argv = cmdline.toString("utf8").split("\0").filter(Boolean);
      const resolvedCwd = resolve(cwd);
      inventory.push(JSON.stringify({
        pid,
        startTime: before,
        argvSha256: createHash("sha256").update(cmdline).digest("hex"),
        cwd: resolvedCwd,
        fdTargetsSha256: createHash("sha256")
          .update(fdTargets.join("\n")).digest("hex"),
      }));
      if (!custodyPaths.some((path) => pathInside(resolvedCwd, path) ||
        argv.some((value) => {
          const resolvedValue = resolveIfAbsolute(value);
          return resolvedValue !== undefined && pathInside(resolvedValue, path);
        }) || fdTargets.some((value) => pathInside(value, path)))) continue;
      blockers.push({
        pid,
        startTime: before,
        argvSha256: createHash("sha256").update(cmdline).digest("hex"),
        cwd: resolvedCwd,
      });
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `legacy_attempt_quarantine_process_inventory_indeterminate:${pid}:${message}`,
      );
    }
  }
  const inventorySha256 = createHash("sha256")
    .update(inventory.sort().join("\n")).digest("hex");
  if (performance.now() > fdBudget.deadline) {
    throw new Error("legacy_attempt_quarantine_process_inventory_timeout");
  }
  return {
    schemaVersion: 1,
    observedAt: (input.now?.() ?? new Date()).toISOString(),
    inspectedPidCount,
    inventorySha256,
    custodyPaths,
    blockers,
  };
}

async function processFileDescriptorTargets(
  procRoot: string,
  pid: number,
  budget: { remaining: number; readonly deadline: number },
): Promise<readonly string[]> {
  const root = `${procRoot}/${pid}/fd`;
  const targets: string[] = [];
  // Stream every descriptor, including unrelated ones: cwd/argv alone do
  // not prove that a process holds no open custody file. No truncation.
  for await (const entry of await opendir(root)) {
    if (performance.now() > budget.deadline) {
      throw new Error("legacy_attempt_quarantine_process_inventory_timeout");
    }
    if (--budget.remaining < 0) {
      throw new Error("legacy_attempt_quarantine_process_fd_inventory_too_large");
    }
    const name = entry.name;
    if (!/^\d+$/.test(name)) {
      throw new Error("legacy_attempt_quarantine_process_fd_invalid");
    }
    try {
      const target = await readlink(`${root}/${name}`);
      const normalized = target.endsWith(" (deleted)")
        ? target.slice(0, -" (deleted)".length)
        : target;
      if (normalized.startsWith("/")) targets.push(resolve(normalized));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
  }
  if (performance.now() > budget.deadline) {
    throw new Error("legacy_attempt_quarantine_process_inventory_timeout");
  }
  return [...new Set(targets)].sort();
}

function resolveIfAbsolute(value: string): string | undefined {
  return value.startsWith("/") ? resolve(value) : undefined;
}

function pathInside(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

async function processStartTime(procRoot: string, pid: number): Promise<string> {
  const value = await readFile(`${procRoot}/${pid}/stat`, "utf8");
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("legacy_attempt_quarantine_process_stat_invalid");
  const startTime = value.slice(close + 2).trim().split(/\s+/)[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error("legacy_attempt_quarantine_process_stat_invalid");
  }
  return startTime;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
