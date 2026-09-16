import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ stage: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const path = String(args[0]);
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
import { recordRejectedUncapturedOutput } from "../codex-goal-mcp-project-control-reviewed-rejection";
const roots: string[] = [];
afterEach(async () => { fault.stage = ""; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each(["archive-write", "archive-sync", "archive-link", "ledger-write", "ledger-link"])("preserves immutable history and exact retry after %s failure", async (stage) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archive-publication-failure-"))); roots.push(root);
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
