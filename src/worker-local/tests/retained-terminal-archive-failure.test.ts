import { mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ stage: "", readPath: "", reads: 0, change: "growth" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const path = String(args[0]);
      if (path === fault.readPath) {
        const read = handle.read.bind(handle);
        handle.read = (async (...input: Parameters<typeof read>) => {
          fault.reads++;
          const result = await read(...input);
          if (fault.reads === 1) {
            if (fault.change === "growth") await fs.appendFile(path, "growth");
            if (fault.change === "truncate") await fs.truncate(path, 1);
            if (fault.change === "overwrite") await fs.writeFile(path, Buffer.alloc(128 * 1024, 1));
          }
          return result;
        }) as typeof handle.read;
      }
      if (path.includes(createHash("sha256").update("tracked.diff").digest("hex").slice(0, 16)) && path.endsWith(".tmp")) {
        const write = handle.write.bind(handle), sync = handle.sync.bind(handle);
        handle.write = (async (...input: Parameters<typeof write>) => {
          if (fault.stage === "archive-write") throw new Error("injected-archive-write");
          return write(...input);
        }) as typeof handle.write;
        handle.sync = async () => { if (fault.stage === "archive-sync") throw new Error("injected-archive-sync"); await sync(); };
      }
      return handle;
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      if (fault.stage === "archive-link" && String(args[1]).endsWith("tracked.diff")) throw new Error("injected-archive-link");
      if (fault.stage === "ledger-link" && String(args[1]).endsWith(".json")) throw new Error("injected-ledger-link");
      return fs.link(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (fault.stage === "ledger-write" && String(args[0]).includes("/items/") && String(args[0]).includes(".json.") && String(args[0]).endsWith(".tmp")) {
        await fs.writeFile(args[0], "partial", { flag: "wx" }); throw new Error("injected-ledger-write");
      }
      return fs.writeFile(...args);
    },
  };
});
import { MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES } from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerMutationLock, LocalConsumedOutputLedgerWriter } from "../consumed-output-ledger-local-adapter";
import { inspectRetainedTerminalArchive } from "../retained-terminal-archive-io";
import { recordRejectedUncapturedOutput } from "../../worker-codex/codex-goal-mcp-project-control-reviewed-rejection";
const roots: string[] = [];
afterEach(async () => { fault.stage = ""; fault.readPath = ""; fault.reads = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(["growth", "truncate", "overwrite"])("bounds descriptor reads and rejects controlled %s", async (change) => {
  const root = await mkdtemp(join(tmpdir(), "archive-read-change-")); roots.push(root);
  const path = join(root, "patch"); await writeFile(path, Buffer.alloc(128 * 1024));
  fault.readPath = path; fault.change = change;
  await expect(inspectRetainedTerminalArchive(path)).rejects.toThrow(change === "truncate" ? "file_truncated" : "file_changed");
  expect(fault.reads).toBe(2);
});

it.each(["archive-write", "archive-sync", "archive-link", "ledger-write", "ledger-link"])("preserves immutable history and exact retry after %s failure", async (stage) => {
  const root = await mkdtemp(join(tmpdir(), "archive-publication-failure-")); roots.push(root);
  const workspace = join(root, "workspace"), archive = join(root, "archive"), ledger = join(root, "ledger");
  for (const path of [workspace, archive, ledger]) await mkdir(path);
  execFileSync("git", ["init", "--quiet", workspace]); await writeFile(join(workspace, "output"), "authored\n");
  const input = { scope: { projectId: "test", consumedOutputLedgerRoots: [ledger], consumedOutputEvidenceRoots: [archive] }, custodyRoot: root, jobId: "earlier", jobRootDir: join(root, "jobs", "test"), workspacePath: workspace, closedAt: "2026-09-13T00:00:00Z", reason: "test" };
  const earlier = await recordRejectedUncapturedOutput(input);
  const earlierLedger = await readFile(earlier.ledgerPath), earlierPatch = await readFile(earlier.decision.backup.patchPath!);
  fault.stage = stage;
  await expect(recordRejectedUncapturedOutput({ ...input, jobId: "next" })).rejects.toThrow(`injected-${stage}`);
  fault.stage = "";
  expect((await readdir(join(ledger, "items"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  // Awaiting replay also waits for independently published siblings and verifies exact bytes.
  const retry = await recordRejectedUncapturedOutput({ ...input, jobId: "next" });
  expect(retry.idempotentReplay).toBe(false);
  expect((await recordRejectedUncapturedOutput({ ...input, jobId: "next" })).idempotentReplay).toBe(true);
  expect(await readFile(earlier.ledgerPath)).toEqual(earlierLedger);
  expect(await readFile(earlier.decision.backup.patchPath!)).toEqual(earlierPatch);
  expect((await readdir(join(ledger, "items"))).some((name) => name.endsWith(".tmp"))).toBe(false);
});


it("rechecks the archive cap under the publication lock and releases locks on rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "archive-locked-bound-")); roots.push(root);
  const ledgerRoot = join(root, "ledger"), archive = join(root, "archive");
  await mkdir(ledgerRoot); await mkdir(archive);
  const patchPath = join(archive, "tracked.diff"), statusPath = join(archive, "status.txt");
  await writeFile(patchPath, "patch\n"); await writeFile(statusPath, "M output\n");
  const locks = new LocalConsumedOutputLedgerMutationLock();
  const writer = new LocalConsumedOutputLedgerWriter(locks, root, [archive]);
  const input = { ledgerRoot, decision: { schemaVersion: 1 as const, jobId: "locked-bound", status: "rejected" as const,
    closedAt: "2026-09-13T00:00:00Z", note: "test", backup: { workspace: root, statusPath, patchPath } } };
  await writer.assertCanRecord(input);
  const acquire = locks.acquire.bind(locks);
  const spy = vi.spyOn(locks, "acquire").mockImplementationOnce(async (request) => {
    const lease = await acquire(request);
    await truncate(patchPath, MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES + 1);
    return lease;
  });
  try {
    await expect(writer.record(input)).rejects.toThrow("retained_terminal_archive_patch_too_large");
    expect(spy).toHaveBeenCalledOnce();
    expect(await readdir(ledgerRoot)).not.toContain("items");
  } finally {
    spy.mockRestore();
  }
  await writeFile(patchPath, "patch\n");
  expect((await writer.record(input)).idempotentReplay).toBe(false);
  expect((await writer.record(input)).idempotentReplay).toBe(true);
});
