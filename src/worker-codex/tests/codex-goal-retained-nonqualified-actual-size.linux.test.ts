import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RetainedNonqualifiedResourcePolicyId, retainedNonqualifiedResourceLimits } from "@vioxen/subscription-runtime/worker-core";
import { buildTar } from "../codex-goal-handoff-untracked-tar";
import { captureRetainedWorkspaceInventory } from "../application/project-control/codex-goal-retained-nonqualified-inventory";
import { retainedMemoryRequirementBytes, sampleRetainedProcessMemory } from "../application/project-control/codex-goal-retained-nonqualified-resources";

// OPT-IN, LINUX-ONLY, ACTUAL-SIZE TEST runner for the finite retained_nonqualified resource policy.
//
// It is skipped everywhere unless RETAINED_ACTUAL_SIZE_TEST=1 on Linux AND RETAINED_ACTUAL_SIZE_DIR names a
// directory whose path contains a ".tmp-retention-capacity-worker-a1" component (the scratch rule of this
// task). It builds a deterministic, nonsecret corpus whose DIRTY inventory is exactly 12,288 untracked
// entries / 263,341,675 bytes (largest file 123,655,872 bytes). One extra tracked, UNCHANGED base file
// (`tracked.txt`, 18 bytes) exists only so a HEAD commit exists; it is not an inventory entry, so it is
// outside both numbers (on-disk bytes are 18 larger than the inventory total). It drives the SAME
// inventory / tar / staged code the operation and admission use under the expanded policy, restores the raw custody tar into an
// empty directory and compares every file independently, and prints a per-phase peak table
// (RSS / heapUsed / external / arrayBuffers / cgroup-effective allowance) that qualifies or refutes the
// conservative "8 x permitted complete backup + 256 MiB" memory threshold.
//
// Scope, stated honestly: this runner exercises the inventory, tar, restore and refusal-before-allocation
// layers at real size. It does NOT start the MCP operation, so the lifecycle bytes, the tracked-patch child
// process, receipt publication and same-permit partial recovery at real size are measured by the operator
// through the operation fixture with this corpus (docs/retained-nonqualified-attempt.md, "Actual-size TEST").
// Nothing here has been run by its author.
const enabled = process.platform === "linux" && process.env.RETAINED_ACTUAL_SIZE_TEST === "1" && Boolean(process.env.RETAINED_ACTUAL_SIZE_DIR);
const SCRATCH_MARK = ".tmp-retention-capacity-worker-a1";
const TOTAL_BYTES = 263_341_675, TOTAL_PATHS = 12_288, LARGEST_BYTES = 123_655_872, SECOND_BYTES = 64_000_000;
const MIB = 1024 * 1024;

type Phase = { name: string; rssPeak: number; heapPeak: number; externalPeak: number; arrayBuffersPeak: number; cgroupEffectiveMin: number | null; ms: number };
const phases: Phase[] = [];
let scratch: string | undefined;

/** xorshift32: deterministic nonsecret filler, identical on every run. */
function filler(seed: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

async function measurePhase<T>(name: string, work: () => Promise<T>): Promise<T> {
  const phase: Phase = { name, rssPeak: 0, heapPeak: 0, externalPeak: 0, arrayBuffersPeak: 0, cgroupEffectiveMin: null, ms: 0 };
  const sample = () => {
    const memory = sampleRetainedProcessMemory();
    phase.rssPeak = Math.max(phase.rssPeak, memory.rss); phase.heapPeak = Math.max(phase.heapPeak, memory.heapUsed);
    phase.externalPeak = Math.max(phase.externalPeak, memory.external); phase.arrayBuffersPeak = Math.max(phase.arrayBuffersPeak, memory.arrayBuffers);
    // cgroupEffectiveMin stays null: no admitted memory authority exists, so this runner cannot sample the effective
    // allowance. The operator records the cgroup high-water (memory.peak / events) and enclosing limits externally.
  };
  const started = Date.now();
  sample();
  const timer = setInterval(sample, 25);
  try { return await work(); }
  finally { clearInterval(timer); sample(); phase.ms = Date.now() - started; phases.push(phase); }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Corpus layout: 2 large files, the rest small, summing to exactly TOTAL_BYTES across TOTAL_PATHS untracked inventory entries. */
function corpusPlan() {
  const smallCount = TOTAL_PATHS - 2 /* large */;
  const smallTotal = TOTAL_BYTES - LARGEST_BYTES - SECOND_BYTES;
  const base = Math.floor(smallTotal / smallCount), extra = smallTotal - base * smallCount;
  const files: { path: string; size: number; seed: number }[] = [
    { path: "corpus/large/largest.bin", size: LARGEST_BYTES, seed: 1 },
    { path: "corpus/large/second.bin", size: SECOND_BYTES, seed: 2 },
  ];
  for (let index = 0; index < smallCount; index += 1) {
    files.push({ path: `corpus/d${String(index % 128).padStart(3, "0")}/f${String(index).padStart(5, "0")}.bin`, size: base + (index < extra ? 1 : 0), seed: 3 + index });
  }
  return files;
}

async function writeCorpus(workspace: string) {
  for (const file of corpusPlan()) {
    const target = join(workspace, file.path);
    await mkdir(dirname(target), { recursive: true });
    if (file.size <= 8 * MIB) { await writeFile(target, filler(file.seed, file.size), { mode: 0o644 }); continue; }
    const handle = await open(target, "w", 0o644); // large files are written in 4 MiB chunks, never held whole
    try {
      for (let written = 0, chunk = 0; written < file.size; chunk += 1) {
        const length = Math.min(4 * MIB, file.size - written);
        await handle.write(filler(file.seed + chunk * 7919, length), 0, length, written); written += length;
      }
    } finally { await handle.close(); }
  }
}

function git(workspace: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

describe.skipIf(!enabled)("retained_nonqualified actual-size finite resource policy (Linux, opt-in)", () => {
  const expanded = retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.ExpandedV1)!;
  const ordinary = retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.Default)!;

  afterAll(async () => {
    // The peak table is the deliverable: the operator copies it into the evidence record verbatim.
    console.log(`RETAINED_ACTUAL_SIZE_PEAKS ${JSON.stringify({ requiredBytes: retainedMemoryRequirementBytes(expanded), node: process.version, phases }, null, 2)}`);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("builds the deterministic corpus with the exact size, path count and largest file", async () => {
    const base = resolve(process.env.RETAINED_ACTUAL_SIZE_DIR!);
    if (!base.split(sep).includes(SCRATCH_MARK)) throw new Error(`RETAINED_ACTUAL_SIZE_DIR must contain a ${SCRATCH_MARK} component`);
    await mkdir(base, { recursive: true });
    scratch = await mkdtemp(join(base, "actual-size-"));
    const workspace = join(scratch, "workspace");
    await mkdir(workspace);
    await measurePhase("corpus-write", async () => {
      git(workspace, "init", "-q", "-b", "main");
      // Owner rule: even disposable fixtures commit as iliya <iliyazelenkog@gmail.com>; no hook is bypassed.
      git(workspace, "config", "user.name", "iliya"); git(workspace, "config", "user.email", "iliyazelenkog@gmail.com");
      for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
        expect(git(workspace, "var", variable)).toMatch(/^iliya <iliyazelenkog@gmail\.com> /); // effective identity, env overrides included
      }
      await writeFile(join(workspace, "tracked.txt"), "tracked TEST file\n");
      git(workspace, "add", "tracked.txt"); git(workspace, "commit", "-q", "-m", "test(retention): add actual-size fixture base");
      await writeCorpus(workspace);
    });
    const plan = corpusPlan();
    expect(plan.reduce((sum, file) => sum + file.size, 0)).toBe(TOTAL_BYTES);
    expect(plan.length).toBe(TOTAL_PATHS); // dirty inventory entries; the unchanged tracked base file is not one
    expect(Math.max(...plan.map(file => file.size))).toBe(LARGEST_BYTES);
    expect((await stat(join(workspace, "corpus/large/largest.bin"))).size).toBe(LARGEST_BYTES);
  });

  it("the ordinary policy refuses the corpus from metadata alone, before any body allocation", async () => {
    const workspace = join(scratch!, "workspace");
    const before = sampleRetainedProcessMemory().arrayBuffers;
    await measurePhase("ordinary-refusal-metadata-only", async () => {
      await expect(captureRetainedWorkspaceInventory(workspace, { limits: ordinary, measureOnly: true })).rejects.toThrow("retained_nonqualified_inventory_too_large");
    });
    expect(sampleRetainedProcessMemory().arrayBuffers - before).toBeLessThan(64 * MIB);
  });

  it("measures the expanded corpus from held-descriptor metadata, matching what collection later archives", async () => {
    const workspace = join(scratch!, "workspace");
    const measured = await measurePhase("expanded-measure-only", () => captureRetainedWorkspaceInventory(workspace, { limits: expanded, measureOnly: true }));
    expect(measured.measure.worktreeBytes).toBe(TOTAL_BYTES);
    expect(measured.measure.largestFileBytes).toBe(LARGEST_BYTES);
    expect(measured.measure.untrackedTarBytes).toBeLessThanOrEqual(expanded.payloadBytes);
    expect(measured.measure.receiptEntriesBoundBytes).toBeLessThan(expanded.receiptBytes);
    expect(measured.untrackedFiles).toHaveLength(0); // measuring allocates no bodies
  });

  it("collects, archives and restores every byte exactly, and the archived length equals the measured length", async () => {
    const workspace = join(scratch!, "workspace");
    const measured = await captureRetainedWorkspaceInventory(workspace, { limits: expanded, measureOnly: true });
    const inventory = await measurePhase("expanded-collect", () => captureRetainedWorkspaceInventory(workspace, { limits: expanded, collect: true }));
    expect(inventory.totalBytes).toBe(TOTAL_BYTES);
    expect(inventory.entries.length).toBe(TOTAL_PATHS); // every dirty entry is untracked; tracked.txt is unchanged from HEAD
    const untrackedTar = await measurePhase("untracked-tar-build", async () => buildTar(inventory.untrackedFiles));
    expect(untrackedTar.length).toBe(measured.measure.untrackedTarBytes);
    expect(untrackedTar.length).toBeLessThanOrEqual(expanded.payloadBytes);
    const archive = join(scratch!, "untracked.tar");
    await writeFile(archive, untrackedTar);
    const restored = join(scratch!, "restored");
    await mkdir(restored);
    await measurePhase("restore-extract", async () => {
      expect(spawnSync("tar", ["-xf", archive, "-C", restored]).status).toBe(0);
    });
    // Independent comparison: streamed hashes of the restored tree against the live source tree, plus mode.
    const compared = await measurePhase("restore-compare", async () => {
      let count = 0;
      const walk = async (relative: string): Promise<void> => {
        for (const entry of await readdir(join(workspace, relative), { withFileTypes: true })) {
          const path = join(relative, entry.name);
          if (path === ".git" || path.startsWith(`.git${sep}`) || path === "tracked.txt") continue;
          if (entry.isDirectory()) { await walk(path); continue; }
          const [source, copy] = await Promise.all([stat(join(workspace, path)), stat(join(restored, path))]);
          expect(copy.size).toBe(source.size);
          expect(copy.mode & 0o777).toBe(source.mode & 0o777);
          expect(await sha256File(join(restored, path))).toBe(await sha256File(join(workspace, path)));
          count += 1;
        }
      };
      await walk(".");
      return count;
    });
    expect(compared).toBe(TOTAL_PATHS);
    expect(basename(restored)).toBe("restored");
  });

  it("a corpus past the combined cap refuses with the exact error and without effects", async () => {
    const workspace = join(scratch!, "workspace");
    await measurePhase("over-aggregate-refusal", async () => {
      // 384 MiB cap: the corpus plus a 128 MiB file (sparse) crosses it from sizes alone.
      const extra = join(workspace, "corpus", "over.bin");
      await writeFile(extra, "");
      const handle = await open(extra, "r+");
      try { await handle.truncate(128 * MIB); } finally { await handle.close(); }
      await expect(captureRetainedWorkspaceInventory(workspace, { limits: expanded, measureOnly: true })).rejects.toThrow("retained_nonqualified_inventory_too_large");
      await rm(extra);
    });
  });
});
