import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_RETAINED_TERMINAL_ARCHIVE_PATCH_BYTES as cap, type ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { captureLocalTerminalOutputBackup, LocalIntegratedOutputLedgerAdapter, LocalConsumedOutputLedgerWriter, inspectRetainedTerminalArchive } from "@vioxen/subscription-runtime/worker-local";
import { recordRejectedUncapturedOutput } from "../codex-goal-mcp-project-control-reviewed-rejection";
import { assertGitPatchBlobsSecretSafe } from "../git-patch-secret-validator";
import { captureGitWorkspacePatch } from "../codex-goal-runtime-result-io";
import { LocalConsumedOutputLedgerSource, readCodexGoalConsumedOutputLedgers, rejectedUncapturedOutputPatchSha256 } from "../application/project-control/codex-goal-consumed-output-ledger-io";
import { restrictedLedgerEpochEvidenceSource, bindLedgerEpochEvidencePath, assertLedgerEpochEvidenceBindingsUnchanged, scanLedgerEpochRoot } from "../application/project-control/codex-goal-ledger-epoch-evidence";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "retained-archive-bound-"))); roots.push(root);
  const workspace = join(root, "workspace"), archive = join(root, "archive"), ledger = join(root, "ledger");
  for (const path of [workspace, archive, ledger]) await mkdir(path);
  execFileSync("git", ["init", "--quiet", workspace]);
  return { root, workspace, archive, ledger };
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("roundtrips real uncaptured rejection >16 MiB through admission, replay and continuation tamper checks", async () => {
  const f = await fixture();
  // Aggregate retention also covers multiple files.
  for (const name of ["a", "b", "c"]) await writeFile(join(f.workspace, name), ("x".repeat(1023) + "\n").repeat(9 * 1024));
  const scope: ProjectAccessScope = { projectId: "test", consumedOutputLedgerRoots: [f.ledger], consumedOutputEvidenceRoots: [f.archive] };
  const input = { scope, custodyRoot: f.root, jobId: "large", jobRootDir: join(f.root, "jobs", "large"), workspacePath: f.workspace, closedAt: "2026-09-13T00:00:00Z", reason: "test" };
  const receipt = await recordRejectedUncapturedOutput(input);
  const bytes = await readFile(receipt.decision.backup.patchPath!);
  expect(bytes.length).toBeGreaterThan(16 * 1024 * 1024); expect(bytes.length).toBeLessThanOrEqual(cap);
  const ledgerBytes = await readFile(receipt.ledgerPath);
  const read = () => readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archive] });
  const result = await read();
  expect(result.debt).toEqual([]);
  expect(result.byJobId.get("large")).toMatchObject({ valid: true, backupPatchSha256: digest(bytes) });
  expect(rejectedUncapturedOutputPatchSha256(result.byJobId.get("large")!)).toBe(digest(bytes));
  expect((await recordRejectedUncapturedOutput(input)).idempotentReplay).toBe(true);
  expect(await readFile(receipt.ledgerPath)).toEqual(ledgerBytes);
  expect((await readFile(receipt.decision.backup.patchPath!)).equals(bytes)).toBe(true);
  bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
  await writeFile(receipt.decision.backup.patchPath!, bytes);
  expect(rejectedUncapturedOutputPatchSha256((await read()).byJobId.get("large")!)).toBeUndefined();
  await expect(recordRejectedUncapturedOutput(input)).rejects.toThrow("immutable_conflict");
  expect(await readFile(receipt.ledgerPath)).toEqual(ledgerBytes);
});

it("accepts exact cap from bytes/path; refuses cap+1 before archive and direct terminal publication", async () => {
  const f = await fixture();
  const input = { archiveRoot: f.archive, archiveName: "exact", workspacePath: f.workspace, changedFiles: [] };
  const bytes = Buffer.alloc(cap, 120);
  const backup = await captureLocalTerminalOutputBackup({ ...input, sourcePatchBytes: bytes });
  expect(await inspectRetainedTerminalArchive(backup.patchPath)).toMatchObject({ size: cap, sha256: digest(bytes) });
  const copied = await captureLocalTerminalOutputBackup({ ...input, archiveName: "path", sourcePatchPath: backup.patchPath });
  expect((await readFile(copied.patchPath)).equals(bytes)).toBe(true);
  await expect(captureLocalTerminalOutputBackup({ ...input, archiveName: "oversize", sourcePatchBytes: Buffer.alloc(cap + 1) })).rejects.toThrow("too_large");
  await truncate(backup.patchPath, cap + 1);
  await expect(captureLocalTerminalOutputBackup({ ...input, archiveName: "oversize-path", sourcePatchPath: backup.patchPath })).rejects.toThrow("too_large");
  const writer = new LocalConsumedOutputLedgerWriter(undefined, f.root, [f.archive]);
  const record = { ledgerRoot: f.ledger, decision: { schemaVersion: 1 as const, jobId: "oversize", status: "rejected" as const, closedAt: "2026-09-13T00:00:00Z", note: "test", backup: { workspace: f.workspace, statusPath: backup.statusPath, patchPath: backup.patchPath } } };
  await expect(writer.assertCanRecord(record)).rejects.toThrow("too_large");
  await expect(writer.record(record)).rejects.toThrow("too_large");
  expect(await readdir(f.ledger)).not.toContain("items");
  expect(await readdir(f.archive)).toEqual(expect.arrayContaining(["exact", "path"]));
  expect(await readdir(f.archive)).not.toContain("oversize");
  expect(await readdir(f.archive)).not.toContain("oversize-path");
  await expect(new LocalConsumedOutputLedgerSource([f.archive]).pathSha256(backup.patchPath)).rejects.toThrow("too_large");
});

it("stops aggregate untracked capture before archive or terminal publication", async () => {
  const f = await fixture();
  for (const name of ["a", "b", "c", "d"]) await writeFile(join(f.workspace, name), ("x".repeat(1023) + "\n").repeat(9 * 1024));
  await expect(captureGitWorkspacePatch({ workspacePath: f.workspace })).rejects.toThrow("too_large");
  expect(await readdir(f.archive)).toEqual([]); expect(await readdir(f.ledger)).toEqual([]);
});

it("uses the archive bound for epoch external hashing/bindings but keeps tree reads at 16 MiB", async () => {
  const f = await fixture(); const path = join(f.archive, "large.patch");
  await writeFile(path, Buffer.alloc(17 * 1024 * 1024, 120));
  const input = { roots: [f.archive], canonicalRoots: [f.archive], deniedRoots: [], canonicalDeniedRoots: [] };
  const source = restrictedLedgerEpochEvidenceSource(input);
  expect(await source.pathExists(path)).toBe(true); expect(await source.pathSize(path)).toBe(17 * 1024 * 1024);
  const binding = await bindLedgerEpochEvidencePath({ ...input, declaredPath: path });
  expect(binding).toMatchObject({ state: "file", sha256: await source.pathSha256(path) });
  await assertLedgerEpochEvidenceBindingsUnchanged([binding]);
  await expect(scanLedgerEpochRoot(f.archive)).rejects.toThrow("ledger_epoch_file_too_large");
  await truncate(path, cap + 1);
  expect(await source.pathSha256(path)).toBeUndefined();
});

it("preserves root, symlink, filetype, missing and truncated evidence checks and bounded source paths", async () => {
  const f = await fixture(); const path = join(f.archive, "patch"); await writeFile(path, "patch\n");
  const source = new LocalConsumedOutputLedgerSource([f.archive]);
  await symlink(path, join(f.archive, "leaf"));
  await symlink(f.workspace, join(f.archive, "escape"));
  await writeFile(join(f.workspace, "outside"), "outside");
  for (const denied of [join(f.archive, "leaf"), join(f.archive, "escape", "outside"), join(f.workspace, "outside"), f.archive]) {
    await expect(source.pathSha256(denied)).rejects.toThrow();
  }
  expect(await source.pathSha256(join(f.archive, "missing"))).toBeUndefined();
  const before = await source.pathSha256(path);
  await new LocalConsumedOutputLedgerWriter(undefined, f.root, [f.archive]).record({
    ledgerRoot: f.ledger,
    decision: { schemaVersion: 1, jobId: "expected-hash", status: "rejected", closedAt: "2026-09-13T00:00:00Z", note: "test",
      backup: { workspace: f.workspace, statusPath: path, patchPath: path },
      preexistingWorkspacePatch: { path, sha256: before! } },
  });
  await truncate(path, 1);
  const tampered = await readCodexGoalConsumedOutputLedgers({ roots: [f.ledger], evidenceRoots: [f.archive] });
  expect(tampered.byJobId.get("expected-hash")?.preexistingWorkspacePatchValid).toBe(false);
  expect(tampered.byJobId.get("expected-hash")?.evidence.join(" ")).toContain("hash mismatch");
  expect(await source.pathSha256(path)).not.toBe(before);
  await expect(captureLocalTerminalOutputBackup({ archiveRoot: f.archive, archiveName: "denied", workspacePath: f.workspace, changedFiles: [], sourcePatchPath: join(f.archive, "leaf") })).rejects.toThrow();
  execFileSync("git", ["-C", f.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "add", "outside"]);
  execFileSync("git", ["-C", f.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test: base"]);
  await writeFile(join(f.workspace, "outside"), "changed\n");
  const fallback = await captureLocalTerminalOutputBackup({ archiveRoot: f.archive, archiveName: "fallback", workspacePath: f.workspace, changedFiles: ["outside"] });
  expect((await readFile(fallback.patchPath, "utf8"))).toContain("+changed");
});


it("keeps scanner patch inputs at 16 MiB despite the larger retention budget", async () => {
  const f = await fixture();
  await expect(assertGitPatchBlobsSecretSafe({ workspacePath: f.workspace, baseCommit: "a".repeat(40), changedPaths: ["output"], tempRootDir: f.root, patch: Buffer.alloc(16 * 1024 * 1024 + 1) })).rejects.toThrow("git_patch_secret_patch_limit_exceeded");
});

it("accounts for UTF-8 and final newlines at the exact aggregate cap and cap+1", async () => {
  const f = await fixture();
  const shim = join(f.root, "git-shim");
  const script = (extra: number) => `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("rev-parse")) process.exit(1);
if (args.includes("ls-files")) { process.stdout.write("a\\0b\\0c\\0"); }
else if (args.includes("--no-index")) {
  const name = args.at(-1);
  const size = name === "c" ? 12 * 1024 * 1024 + ${extra} : 10 * 1024 * 1024;
  // Two-byte UTF-8 content, plus an ASCII byte if necessary; no trailing newline.
  const length = size - 1;
  process.stdout.write("é".repeat(Math.floor(length / 2)) + (length % 2 ? "x" : ""));
  process.exitCode = 1;
}
`;
  await writeFile(shim, script(0), { mode: 0o700 });
  expect(Buffer.byteLength(await captureGitWorkspacePatch({ workspacePath: f.workspace, gitBinaryPath: shim }))).toBe(cap);
  await writeFile(shim, script(1), { mode: 0o700 });
  await expect(captureGitWorkspacePatch({ workspacePath: f.workspace, gitBinaryPath: shim })).rejects.toThrow("too_large");
});

it("rejects disappearance during the final metadata recheck", async () => {
  const f = await fixture(); const path = join(f.archive, "patch"); await writeFile(path, "patch");
  const source = new LocalConsumedOutputLedgerSource([f.archive]);
  const internals = source as unknown as { evidenceFileMetadata(path: string): Promise<import("node:fs").Stats | undefined> };
  const metadata = internals.evidenceFileMetadata.bind(source);
  let calls = 0;
  vi.spyOn(internals, "evidenceFileMetadata").mockImplementation(async (value) => {
    if (++calls === 2) await rm(value);
    return metadata(value);
  });
  await expect(source.pathSha256(path)).rejects.toThrow("consumed_output_evidence_file_changed");
});

it.each(["tracked", "untracked"])("retains a single real 17 MiB %s diff and retention fallback", async (kind) => {
  const f = await fixture(); const path = join(f.workspace, "large");
  if (kind === "tracked") {
    await writeFile(path, "base\n");
    execFileSync("git", ["-C", f.workspace, "add", "large"]);
    execFileSync("git", ["-C", f.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test: base"]);
  }
  await writeFile(path, ("x".repeat(1023) + "\n").repeat(17 * 1024));
  const patch = await captureGitWorkspacePatch({ workspacePath: f.workspace });
  expect(Buffer.byteLength(patch)).toBeGreaterThan(17 * 1024 * 1024);
  expect(Buffer.byteLength(patch)).toBeLessThan(cap);
  if (kind === "tracked") {
    const backup = await captureLocalTerminalOutputBackup({ archiveRoot: f.archive, archiveName: "fallback-large", workspacePath: f.workspace, changedFiles: ["large"] });
    expect(await readFile(backup.patchPath, "utf8")).toBe(patch);
  }
});

it.each(["tracked", "untracked", "fallback", "integrated-show"])("uses the exact retention cap for a single %s command", async (kind) => {
  const f = await fixture(); const shim = join(f.root, "git-shim");
  const script = (size: number) => `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("rev-parse")) process.exit(0);
if (args.includes("ls-files")) process.stdout.write(${JSON.stringify(kind === "untracked" ? "large\0" : "")});
else if (args.includes("--binary") && (${JSON.stringify(kind)} !== "untracked" || args.includes("--no-index"))) {
  process.stdout.write("x".repeat(${size} - 1) + "\\n");
  if (args.includes("--no-index")) process.exitCode = 1;
}
`;
  const integrated = new LocalIntegratedOutputLedgerAdapter({ ledgerRoots: [f.ledger], evidenceRoots: [f.archive], gitBinaryPath: shim }) as unknown as {
    gitOutputBytes(cwd: string, args: readonly string[]): Promise<Buffer>;
  };
  const capture = () => kind === "integrated-show"
    ? integrated.gitOutputBytes(f.workspace, ["show", "--binary", "--format=", "HEAD"])
    : kind === "fallback"
    ? captureLocalTerminalOutputBackup({ archiveRoot: f.archive, archiveName: "exact-fallback", workspacePath: f.workspace, changedFiles: ["large"], gitBinaryPath: shim })
    : captureGitWorkspacePatch({ workspacePath: f.workspace, gitBinaryPath: shim });
  await writeFile(shim, script(cap), { mode: 0o700 });
  const exact = await capture();
  expect(typeof exact === "string" ? Buffer.byteLength(exact) : Buffer.isBuffer(exact) ? exact.length : (await readFile(exact.patchPath)).length).toBe(cap);
  await writeFile(shim, script(cap + 1), { mode: 0o700 });
  await expect(capture()).rejects.toThrow("retained_terminal_archive_patch_too_large");
});
