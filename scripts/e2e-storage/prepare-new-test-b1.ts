import { constants } from "node:fs";
import { lstat, open, readlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { boundedDigest, boundedFields } from "../../src/worker-core/storage/bounded-storage-policy";
import { withNewDedicatedTestOwner, NewDedicatedTestPurpose, type NewDedicatedTestOwner } from "../../host-integration/bounded-storage/native-bounded-storage-host";

/** Future operator runner; called by the explicitly selected native Vitest
 * suite. Merely importing this TypeScript module performs no setup. The input
 * contains creation parents/policy/code only: never existing FS/registration or
 * a caller-assigned generation/receipt. Native code performs all actual effects. */
export async function prepareNewTestB1<T>(configPath: string, use: (owner: NewDedicatedTestOwner) => Promise<T>): Promise<T> {
  if (!isAbsolute(configPath) || configPath.includes("\0")) throw new Error("TEST_creation_config_path");
  for (let ancestor = dirname(configPath); ; ancestor = dirname(ancestor)) {
    const s = await lstat(ancestor, { bigint: true });
    if (!s.isDirectory() || s.uid !== 0n || (s.mode & 0o022n)) throw new Error("TEST_creation_ancestry");
    if (ancestor === "/") break;
  }
  const config = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const handles: FileHandle[] = [config];
  try {
    const before = await config.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n || before.nlink !== 1n || (before.mode & 0o7777n) !== 0o400n || before.size < 1n || before.size > 8192n) throw new Error("TEST_creation_config_identity");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) { const r = await config.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
    const after = await config.stat({ bigint: true });
    if (used !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("TEST_creation_config_changed");
    const fields = boundedFields(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))) as unknown,
      ["purpose", "backingParent", "controlParent", "policyPath", "helperPath", "helperSha256"]);
    if (fields.purpose !== NewDedicatedTestPurpose.B1) throw new Error("TEST_creation_purpose");
    for (const key of ["backingParent", "controlParent", "policyPath", "helperPath"] as const) {
      if (typeof fields[key] !== "string" || !isAbsolute(fields[key]) || fields[key].includes("\0") || fields[key].length > 4096) throw new Error("TEST_creation_path");
    }
    const backing = await open(fields.backingParent as string, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(backing);
    const control = await open(fields.controlParent as string, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); handles.push(control);
    const policy = await open(fields.policyPath as string, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(policy);
    const helper = await open(fields.helperPath as string, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(helper);
    return await withNewDedicatedTestOwner({ purpose: NewDedicatedTestPurpose.B1, backingParent: backing, controlParent: control,
      policy, helper, helperSha256: boundedDigest(fields.helperSha256) }, use);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

/** Bounded read of kernel observations; procfs sizes are not regular-file sizes.
 * Unsupported/hidden procfs is a test failure, never lock/death evidence. */
async function procText(path: string, maximum = 65536): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maximum + 1);
    let used = 0;
    while (used < bytes.length) { const r = await fd.read(bytes, used, bytes.length - used, null); if (!r.bytesRead) break; used += r.bytesRead; }
    if (used > maximum) throw new Error("TEST_proc_observation_oversized");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally { await fd.close(); }
}
export type RetainedTestProcess = { readonly pid: number; readonly startTicks: string };
async function processStat(pid: number): Promise<{ startTicks: string; parent: number; terminated: boolean }> {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("TEST_proc_pid");
  const bytes = await procText(`/proc/${pid}/stat`);
  const fields = bytes.slice(bytes.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!bytes.startsWith(`${pid} (`) || !/^[0-9]+$/.test(fields[19] ?? "") || !/^[0-9]+$/.test(fields[1] ?? "") || !/^[RSDZTtWXIP]$/.test(fields[0] ?? "")) throw new Error("TEST_proc_stat_unsupported");
  return { startTicks: fields[19]!, parent: Number(fields[1]), terminated: fields[0] === "Z" || fields[0] === "X" };
}
export async function retainOwnedTestProcess(pid: number, parent: number): Promise<RetainedTestProcess> {
  const self = await procText("/proc/self/status"), target = await procText(`/proc/${pid}/status`);
  // /proc/locks is filtered and its PIDs rendered in the procfs mount's PID
  // namespace. WAIT1 uses getpid(). Refuse an ancestor-mounted procfs rather
  // than confusing that PID with an unrelated process. TEST never unshares PID.
  for (const [status, expected] of [[self, process.pid], [target, pid]] as const) {
    const ids = /^NSpid:\s+([0-9 \t]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
    if (!ids?.length || ids[0] !== expected || ids.at(-1) !== expected) throw new Error("TEST_proc_pid_namespace_unsupported");
  }
  if (await readlink(`/proc/${pid}/ns/pid`) !== await readlink("/proc/self/ns/pid")) throw new Error("TEST_proc_foreign_pid_namespace");
  const stat = await processStat(pid);
  if (stat.parent !== parent || stat.terminated) throw new Error("TEST_proc_owned_pid_not_live");
  return { pid, startTicks: stat.startTicks };
}
export async function observeOwnedTestTermination(retained: RetainedTestProcess): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      const stat = await processStat(retained.pid);
      if (stat.startTicks !== retained.startTicks) throw new Error("TEST_proc_pid_replaced");
      if (stat.terminated) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("TEST_owned_process_still_live");
}
export type TestFenceWaitEvidence = { readonly blocker: RetainedTestProcess; readonly waiter: RetainedTestProcess; readonly kernelRows: readonly string[] };
export async function observeOwnedFenceWait(ownerPid: number, blockerPid: number, waiterPid: number,
  device: bigint, inode: bigint, timeoutMs = 5000): Promise<TestFenceWaitEvidence> {
  if (process.platform !== "linux" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000 || blockerPid === waiterPid || device < 0n || inode < 1n) throw new Error("TEST_fence_observation_input");
  const blocker = await retainOwnedTestProcess(blockerPid, ownerPid), waiter = await retainOwnedTestProcess(waiterPid, ownerPid);
  // Linux dev_t encoding; /proc/locks prints major/minor in hex, inode decimal.
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    for (const retained of [blocker, waiter]) {
      const stat = await processStat(retained.pid);
      if (stat.startTicks !== retained.startTicks || stat.parent !== ownerPid || stat.terminated) throw new Error("TEST_fence_owned_pid_changed");
    }
    const rows = (await procText("/proc/locks", 4194304)).trim().split("\n");
    const parsed = rows.flatMap(row => {
      const m = /^([0-9]+):\s+(->\s+)?FLOCK\s+ADVISORY\s+WRITE\s+([0-9]+)\s+([0-9a-fA-F]+):([0-9a-fA-F]+):([0-9]+)\s+0\s+EOF$/.exec(row);
      if (!m || BigInt(`0x${m[4]}`) !== major || BigInt(`0x${m[5]}`) !== minor || BigInt(m[6]!) !== inode) return [];
      return [{ id: m[1]!, waiting: !!m[2], pid: Number(m[3]), row }];
    });
    const held = parsed.find(row => !row.waiting && row.pid === blockerPid);
    const waiting = parsed.find(row => row.waiting && row.pid === waiterPid && row.id === held?.id);
    if (held && waiting) return { blocker, waiter, kernelRows: [held.row, waiting.row] };
    // This is bounded observation polling, never a sleep offered as proof.
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("TEST_exact_fence_kernel_wait_not_observed");
}
