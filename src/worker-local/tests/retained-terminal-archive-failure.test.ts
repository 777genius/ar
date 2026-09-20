import { mkdtemp, mkdir, readdir, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ readPath: "", reads: 0, change: "growth" }));
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
            if (fault.change === "read-and-close") throw new Error("injected-read");
            if (fault.change === "growth") await fs.appendFile(path, "growth");
            if (fault.change === "truncate") await fs.truncate(path, 1);
            if (fault.change === "overwrite") await fs.writeFile(path, Buffer.alloc(128 * 1024, 1));
          }
          return result;
        }) as typeof handle.read;
        if (fault.change === "read-and-close") {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); throw new Error("injected-close"); };
        }
      }
      return handle;
    },
  };
});
import { MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES } from "@vioxen/subscription-runtime/worker-core";
import { LocalConsumedOutputLedgerMutationLock, LocalConsumedOutputLedgerWriter } from "../consumed-output-ledger-local-adapter";
import { inspectRetainedTerminalArchive } from "../retained-terminal-archive-io";
const roots: string[] = [];
afterEach(async () => { fault.readPath = ""; fault.reads = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(["growth", "truncate", "overwrite"])("bounds descriptor reads and rejects controlled %s", async (change) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archive-read-change-"))); roots.push(root);
  const path = join(root, "patch"); await writeFile(path, Buffer.alloc(128 * 1024));
  fault.readPath = path; fault.change = change;
  await expect(inspectRetainedTerminalArchive(path)).rejects.toThrow(change === "truncate" ? "file_truncated" : "file_changed");
  expect(fault.reads).toBe(2);
});


it("rechecks the archive cap under the publication lock and releases locks on rejection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archive-locked-bound-"))); roots.push(root);
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

it("preserves the read error when descriptor close also fails", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archive-close-failure-"))); roots.push(root);
  const path = join(root, "patch"); await writeFile(path, "patch");
  fault.readPath = path; fault.change = "read-and-close";
  await expect(inspectRetainedTerminalArchive(path)).rejects.toThrow("injected-read");
});

it("classifies a canonical identity race as changed evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archive-identity-"))); roots.push(root);
  const path = join(root, "patch"); await writeFile(path, "patch");
  await expect(inspectRetainedTerminalArchive(path, { expectedCanonicalPath: join(root, "previous") }))
    .rejects.toThrow("consumed_output_evidence_file_changed");
  expect((await inspectRetainedTerminalArchive(path, { collect: true })).bytes).toEqual(Buffer.from("patch"));
});
