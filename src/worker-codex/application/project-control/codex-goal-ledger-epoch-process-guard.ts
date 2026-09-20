import { readdir, readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

export type LedgerEpochProcessSnapshot = {
  readonly pid: number;
  readonly startTime: string;
  readonly argv: readonly string[];
  readonly executablePath: string;
  readonly cwd: string;
  readonly cgroup: string;
};

export type LedgerEpochWriterSelector = {
  readonly registryRootDir: string;
  readonly controllerJobId: string;
  readonly ledgerRoot: string;
  readonly selfPid: number;
  readonly workspacePaths?: readonly string[];
};

const MCP_ENTRYPOINTS = new Set([
  "subscription-runtime-codex-goal-mcp",
  "codex-goal-mcp.js",
  "codex-goal-mcp-http.js",
]);
const CLI_ENTRYPOINTS = new Set([
  "subscription-runtime-codex-goal",
  "codex-goal-cli.js",
]);

export function ledgerEpochProcessBlocks(
  snapshot: LedgerEpochProcessSnapshot,
  selector: LedgerEpochWriterSelector,
): boolean {
  if (snapshot.pid === selector.selfPid) return false;
  if (selector.workspacePaths?.some((path) => snapshot.cwd === path ||
    snapshot.cwd.startsWith(`${path}/`) || snapshot.argv.includes(path))) return true;
  const entrypoint = processEntrypoint(snapshot.argv);
  if (entrypoint !== undefined && MCP_ENTRYPOINTS.has(entrypoint)) return true;
  if (entrypoint === undefined || !CLI_ENTRYPOINTS.has(entrypoint)) return false;
  if (snapshot.argv.some((value) => value === "controller-supervise" ||
    value === "project-controller-supervise")) return true;
  return snapshot.argv.some((value) =>
    value === selector.registryRootDir || value === selector.controllerJobId ||
    value === selector.ledgerRoot
  );
}

function processEntrypoint(argv: readonly string[]): string | undefined {
  const executable = argv[0] ? basename(argv[0]) : undefined;
  if (!executable) return undefined;
  if (MCP_ENTRYPOINTS.has(executable) || CLI_ENTRYPOINTS.has(executable)) {
    return executable;
  }
  if (["node", "nodejs", "bun", "deno"].includes(executable)) {
    // Runtime option grammars evolve and several options consume a following
    // value. Locating only an exact, recognized entrypoint is conservative in
    // both directions: options cannot hide a writer, while option payloads and
    // eval source cannot spoof one through a substring.
    for (const argument of argv.slice(1)) {
      const candidate = basename(argument);
      if (MCP_ENTRYPOINTS.has(candidate) || CLI_ENTRYPOINTS.has(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
  return executable;
}

export async function assertNoLedgerEpochWriterProcesses(
  selector: LedgerEpochWriterSelector,
): Promise<void> {
  const snapshots = await readStableProcSnapshots();
  const blockers = snapshots.filter((snapshot) =>
    ledgerEpochProcessBlocks(snapshot, selector)
  );
  if (blockers.length > 0) {
    throw new Error(
      `ledger_epoch_legacy_writer_processes_active:${blockers.map(({ pid }) => pid).join(",")}`,
    );
  }
}

async function readStableProcSnapshots(): Promise<readonly LedgerEpochProcessSnapshot[]> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    throw new Error("ledger_epoch_process_inventory_unavailable");
  }
  const snapshots: LedgerEpochProcessSnapshot[] = [];
  for (const value of entries.filter((entry) => /^\d+$/.test(entry)).sort()) {
    const pid = Number(value);
    try {
      const before = await procStartTime(pid);
      const [cmdline, executablePath, cwd, cgroup] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`),
        readlink(`/proc/${pid}/exe`),
        readlink(`/proc/${pid}/cwd`),
        readFile(`/proc/${pid}/cgroup`, "utf8"),
      ]);
      const after = await procStartTime(pid);
      if (before !== after) throw new Error("ledger_epoch_process_pid_churn");
      snapshots.push({
        pid,
        startTime: before,
        argv: cmdline.toString("utf8").split("\0").filter(Boolean),
        executablePath,
        cwd,
        cgroup,
      });
    } catch (error) {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH")) continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ledger_epoch_process_inventory_indeterminate:${pid}:${message}`);
    }
  }
  return snapshots;
}

async function procStartTime(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const close = value.lastIndexOf(")");
  if (close < 0) throw new Error("ledger_epoch_process_stat_invalid");
  const fields = value.slice(close + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error("ledger_epoch_process_stat_invalid");
  }
  return startTime;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
