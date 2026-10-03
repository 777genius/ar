import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { IntegrationAttempt } from "@vioxen/subscription-runtime/worker-core";
import {
  decodeAdoptionCapturedBytes,
  LocalIntegratedOutputLedgerAdapter,
} from "../consumed-output-ledger-local-adapter";
import { localProjectControlEvidenceCustodySupported } from
  "../project-control-evidence-custody-local-adapter";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("accepts an 8 MiB immutable adoption capture without stack exhaustion", () => {
  // The former repeated-group base64 regex overflowed the stack at this size,
  // even though the capture is below the supported 32 MiB decoded limit.
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const encoded = bytes.toString("base64");
  const sha = createHash("sha256").update(bytes).digest("hex");
  expect(decodeAdoptionCapturedBytes(encoded, sha).equals(bytes)).toBe(true);
  expect(() => decodeAdoptionCapturedBytes(`${encoded.slice(0, -1)}!`, sha))
    .toThrow("published_commit_adoption_capture_invalid");
});

it.runIf(localProjectControlEvidenceCustodySupported)(
  "reuses an old-format preparation after worker drift without changing normal push bytes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "integration-ledger-replay-"));
    roots.push(root);
    const workspacePath = join(root, "workspace");
    const ledgerRoot = join(root, "ledger");
    const archiveRoot = join(root, "archives");
    await Promise.all([mkdir(workspacePath), mkdir(ledgerRoot), mkdir(archiveRoot)]);
    const git = async (...args: string[]) => (await run("git", args, {
      cwd: workspacePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com",
        GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com",
      },
    })).stdout.trim();
    await git("init", "-q", "-b", "main");
    await writeFile(join(workspacePath, "output.txt"), "base\n");
    await git("add", "output.txt");
    await git("commit", "-qm", "test: base");
    await writeFile(join(workspacePath, "output.txt"), "reviewed\n");
    await git("add", "output.txt");
    await git("commit", "-qm", "fix(test): reviewed output");
    const commitSha = await git("rev-parse", "HEAD");
    const attempt = {
      attemptId: "synthetic-attempt", targetWorkspacePath: workspacePath,
      checkedReviewedTree: await git("rev-parse", "HEAD^{tree}"),
      workerOutput: {
        workerJobId: "synthetic-worker", workspacePath, changedFiles: ["output.txt"],
        reviewedOutputId: "d".repeat(64),
      },
    } as unknown as IntegrationAttempt;
    const adapter = new LocalIntegratedOutputLedgerAdapter({
      ledgerRoots: [ledgerRoot], evidenceRoots: [archiveRoot],
      activeEvidenceRoot: archiveRoot, custodyRoot: root,
    });
    const first = await adapter.prepare({ attempt, commitSha });
    expect(Object.keys(first)).toEqual([
      "attemptId", "workerJobId", "workerWorkspacePath", "commitSha",
      "archivePath", "statusPath", "patchPath", "numstatPath",
    ]);
    const preparationPath = join(ledgerRoot, "preparations", "synthetic-attempt.json");
    const oldFormatBytes = `${JSON.stringify(first, null, 2)}\n`;
    expect(await readFile(preparationPath, "utf8")).toBe(oldFormatBytes);
    expect(await adapter.prepare({ attempt, commitSha })).toEqual(first);

    await writeFile(join(workspacePath, "new-worker-file.txt"), "later change\n");
    expect(await adapter.readPrepared({ attempt, commitSha })).toEqual(first);
    await expect(adapter.prepare({ attempt, commitSha }))
      .rejects.toThrow("evidence_custody_immutable_conflict");
    await adapter.preflightFinalize({ preparation: first, pushedAt: "2026-09-28T12:00:00.000Z" });
    await adapter.finalize({ preparation: first, pushedAt: "2026-09-28T12:00:00.000Z" });
    expect(await adapter.readPrepared({ attempt, commitSha })).toEqual(first);

    const adoptionAttempt = { ...attempt, attemptId: "adoption-attempt" };
    const adoption = await adapter.prepareAdoption({ attempt: adoptionAttempt, commitSha });
    const frozenStatus = await readFile(adoption.statusPath);
    // Synthetic crash image: capture and first archive file survived, but
    // neither the remaining archive files nor preparation were published.
    await Promise.all([
      rm(join(ledgerRoot, "preparations", "adoption-attempt.json")),
      rm(adoption.patchPath), rm(adoption.numstatPath),
    ]);
    await writeFile(join(workspacePath, "post-crash-file.txt"), "worker drift\n");
    expect(await adapter.readPrepared({ attempt: adoptionAttempt, commitSha })).toBeUndefined();
    const recovered = await adapter.prepareAdoption({ attempt: adoptionAttempt, commitSha });
    expect(recovered).toEqual(adoption);
    expect(await readFile(recovered.statusPath)).toEqual(frozenStatus);
    expect(await adapter.readPrepared({ attempt: adoptionAttempt, commitSha })).toEqual(adoption);
  },
);
