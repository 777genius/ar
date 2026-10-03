import { execFileSync } from "node:child_process";

// Node has no renameat2 binding. Fixed isolated Python uses the existing Linux
// libc primitive; there is no shell, credential environment, task-bearing input,
// path selection, or model-facing capability. Missing Python/libc/filesystem
// support fails closed with both durable publication obligations retained.
const exchange = `import ctypes, re, sys
name = sys.argv[1]
if not re.fullmatch(r"[a-f0-9]{64}\\.json", name): sys.exit(1)
libc = ctypes.CDLL(None, use_errno=True)
rename = libc.renameat2
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
base = name[:-5]
if len(sys.argv) == 2:
    if rename(3, (base + ".next").encode(), 3, name.encode(), 2) != 0: sys.exit(1)
else:
    generation = sys.argv[2]
    if not re.fullmatch(r"[1-9][0-9]*", generation): sys.exit(1)
    for source, target in [(".next", ".previous."), (".hold", ".history.")]:
        if rename(3, (base + source).encode(), 3, (base + target + generation).encode(), 1) != 0: sys.exit(1)
`;

/** Host adapter internal only: RENAME_EXCHANGE retains BOTH operand inodes.
 * The caller holds the common fence and verifies exchanged identities/bytes;
 * any ambiguity must leave .hold and .next for separate host investigation. */
export function exchangeKeyedLedgerFiles(parent: number, name: string): void {
  run(parent, name);
}

/** No inode is deleted, including a foreign replacement during cleanup. */
export function archiveKeyedLedgerFiles(parent: number, name: string, generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("keyed_ledger_invalid_generation");
  run(parent, name, generation);
}
function run(parent: number, name: string, generation?: number): void {
  if (process.platform !== "linux" || !/^[a-f0-9]{64}\.json$/.test(name)) {
    throw new Error("keyed_ledger_linux_exchange_required");
  }
  try {
    execFileSync("/usr/bin/python3", ["-I", "-c", exchange, name, ...(generation === undefined ? [] : [String(generation)])], {
      env: {}, stdio: ["ignore", "ignore", "ignore", parent], timeout: 5000,
    });
  } catch { throw new Error("keyed_ledger_exchange_failed"); }
}
