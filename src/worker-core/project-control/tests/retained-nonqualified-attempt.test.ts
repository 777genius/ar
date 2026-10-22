import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RETAINED_NONQUALIFIED_BACKUP_PAYLOADS,
  RETAINED_NONQUALIFIED_STATUS,
  RetainedNonqualifiedOriginalKind,
  RetainedNonqualifiedResourcePolicyId,
  assertRetainedNonqualifiedReceipt,
  assertTerminalOutputDecision,
  consumedOutputRecordFromJson,
  retainedNonqualifiedReceiptLimits,
  retainedNonqualifiedResourceLimits,
  type ConsumedOutputLedgerSourcePort,
  type RetainedNonqualifiedReceipt,
  type TerminalOutputDecision,
} from "../index";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

// Real files and real hashes, the same shape the native ledger source reports.
const source: Pick<ConsumedOutputLedgerSourcePort, "pathExists" | "pathSize" | "pathSha256" | "resolveWorkspacePath"> = {
  async pathExists(path) { return await stat(path).then(() => true, () => false); },
  async pathSize(path) { return await stat(path).then(item => item.size, () => undefined); },
  async pathSha256(path) { return await readFile(path).then(sha256, () => undefined); },
  async resolveWorkspacePath(path) { return path; },
};

function receiptFor(workspace: string, kind: RetainedNonqualifiedOriginalKind): RetainedNonqualifiedReceipt {
  const file = (name: string) => ({ state: "absent" as const, path: join(workspace, "..", "job", name) });
  const present = (name: string) => ({ state: "present" as const, path: join(workspace, "..", "job", name), sha256: "e".repeat(64), size: 9, mode: 0o644 });
  const missing = kind === RetainedNonqualifiedOriginalKind.ResultMissing;
  return {
    schemaVersion: 1, operation: "retain_nonqualified_attempt", kind, sourceQualification: "not_assessed", replayAuthorized: false,
    permitSha256: "a".repeat(64), projectId: "TEST-project", controllerJobId: "TEST-controller", workerJobId: "TEST-worker",
    taskId: "TEST-worker", workspace, headCommit: "b".repeat(40), controllerManifestSha256: "c".repeat(64),
    workerManifestSha256: "d".repeat(64),
    original: {
      result: missing ? file("result.json") : present("result.json"),
      ...(missing ? {} : { resultStatus: "failed" as const }),
      progress: file("progress.json"), events: file("events.jsonl"), stopEvent: file("stop-event.json"), accountReservation: file("account.json"),
      manifest: present("job.json"), log: file("job.log"), prompt: present("prompt.md"),
    },
    ignored: { retain: ["logs/validation.log"], disposableListing: ["node_modules/"] },
    inventory: { digest: "f".repeat(64), totalBytes: 5, entries: [{ path: "input.txt", status: "??", layer: "untracked", kind: "file", mode: 0o644, size: 5, sha256: sha256("input") },
      { path: "staged.txt", status: "MM", layer: "tracked", kind: "file", mode: 0o644, size: 3, sha256: sha256("B"), index: { mode: "100644", oid: "a".repeat(40) } }] },
    backupFiles: Object.fromEntries(RETAINED_NONQUALIFIED_BACKUP_PAYLOADS.map(name => [name, sha256(name)])), retainedAt: "2026-10-10T10:00:00.000Z",
  };
}

async function fixture(kind = RetainedNonqualifiedOriginalKind.ResultMissing) {
  const root = await mkdtemp(join(tmpdir(), "retained-nonqualified-TEST-"));
  roots.push(root);
  const workspace = join(root, "workspace"), archive = join(root, "evidence", "nonqualified-retention-TEST-worker");
  await mkdir(workspace, { recursive: true }); await mkdir(archive, { recursive: true });
  const files = { status: "?? input.txt\n", patch: "diff --git a/input.txt b/input.txt\n", numstat: "", tar: "TAR-BYTES" };
  // Every archival payload must exist beside the receipt (owner intent, staged index blobs, lifecycle originals).
  for (const extra of ["owner-intent.json", "staged.tar", "lifecycle.tar"]) await writeFile(join(archive, extra), extra);
  const paths = { statusPath: join(archive, "git-status.txt"), patchPath: join(archive, "tracked.diff"),
    numstatPath: join(archive, "tracked.numstat"), untrackedArchivePath: join(archive, "untracked.tar") };
  await writeFile(paths.statusPath, files.status); await writeFile(paths.patchPath, files.patch);
  await writeFile(paths.numstatPath, files.numstat); await writeFile(paths.untrackedArchivePath, files.tar);
  const receiptPath = join(archive, "retained-nonqualified-attempt.json");
  const receiptBytes = Buffer.from(JSON.stringify(receiptFor(workspace, kind)));
  await writeFile(receiptPath, receiptBytes);
  const decision = (): TerminalOutputDecision => ({
    schemaVersion: 1, jobId: "TEST-worker", status: RETAINED_NONQUALIFIED_STATUS, closedAt: "2026-10-10T10:00:00.000Z",
    archivePath: archive, note: "custody only",
    retention: { schemaVersion: 1, kind, receiptPath, receiptSha256: sha256(receiptBytes), sourceQualification: "not_assessed", replayAuthorized: false },
    backup: { workspace, ...paths },
  });
  const read = (value: unknown) => consumedOutputRecordFromJson({ value, ledgerPath: join(root, "ledger", "items", "TEST-worker.json"), source });
  return { root, workspace, archive, receiptPath, receiptBytes, paths, decision, read };
}

describe("retained_nonqualified terminal disposition", () => {
  it.each([RetainedNonqualifiedOriginalKind.ResultMissing, RetainedNonqualifiedOriginalKind.FailedCheckpoint])(
    "accepts %s only as hash-bound custody, with no authored-output, approval or workspace-consumption claim", async kind => {
      const f = await fixture(kind);
      const record = await f.read({ ...f.decision(), consumedAt: "2026-10-10T10:00:00.000Z" });
      expect(record).toMatchObject({ status: "retained_nonqualified", valid: true, structurallyValid: true,
        retainedNonqualified: { kind, receiptSha256: sha256(f.receiptBytes) } });
      // Retention never reads as the old archived/approved disposition...
      expect(record?.status).not.toBe("archived");
      // ...and never consumes a different job's workspace: the ledger keeps it job-scoped.
      expect(assertRetainedNonqualifiedReceipt(JSON.parse(f.receiptBytes.toString()))).toMatchObject({
        sourceQualification: "not_assessed", replayAuthorized: false });
    });

  it("the old archived route still rejects the same input-only backup, so the new status is not a loosened archive", async () => {
    const f = await fixture();
    await writeFile(f.paths.untrackedArchivePath, ""); await writeFile(f.paths.patchPath, "");
    const { retention: _retention, ...base } = f.decision();
    const archived = await f.read({ ...base, status: "archived" });
    expect(archived).toMatchObject({ valid: false, hasAuthoredOutput: false });
    expect(archived?.evidence.join(" ")).toContain("no authored output evidence");
    // The new discriminated route accepts the identical backup because it claims no output.
    expect(await f.read(f.decision())).toMatchObject({ valid: true });
  });

  it.each([
    ["missing receipt bytes", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(f.receiptPath); }, "receipt bytes are missing"],
    ["changed receipt bytes", async (f: Awaited<ReturnType<typeof fixture>>) => { await writeFile(f.receiptPath, "{}"); }, "receipt hash mismatch"],
    ["missing patch backup", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(f.paths.patchPath); }, ""],
    ["missing untracked archive backup", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(f.paths.untrackedArchivePath); }, ""],
    ["missing lifecycle archive payload", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(join(f.archive, "lifecycle.tar")); }, "payload lifecycle.tar is missing"],
    ["missing staged index archive payload", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(join(f.archive, "staged.tar")); }, "payload staged.tar is missing"],
    ["missing owner intent payload", async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(join(f.archive, "owner-intent.json")); }, "payload owner-intent.json is missing"],
  ])("never suppresses debt on %s", async (_name, damage, evidence) => {
    const f = await fixture();
    await damage(f);
    const record = await f.read(f.decision());
    expect(record).toMatchObject({ valid: false, structurallyValid: false });
    expect(record).not.toHaveProperty("retainedNonqualified");
    expect(record?.evidence.join(" ")).toContain(evidence);
  });

  it.each([
    ["receipt outside the backup root", (d: TerminalOutputDecision, f: Awaited<ReturnType<typeof fixture>>) =>
      ({ ...d, retention: { ...d.retention!, receiptPath: join(dirname(f.archive), "other.json") } })],
    ["replay authorized", (d: TerminalOutputDecision) => ({ ...d, retention: { ...d.retention!, replayAuthorized: true } })],
    ["source qualification asserted", (d: TerminalOutputDecision) => ({ ...d, retention: { ...d.retention!, sourceQualification: "approved" } })],
    ["no retention block", ({ retention: _drop, ...d }: TerminalOutputDecision) => d],
    ["forged commit", (d: TerminalOutputDecision) => ({ ...d, commitSha: "1234567" })],
    ["forged no-output evidence", (d: TerminalOutputDecision) => ({ ...d, failure: { category: "infrastructure", code: "x" }, output: { authoredChanges: false, workspaceDirty: false } })],
    ["forged attempt id", (d: TerminalOutputDecision) => ({ ...d, attemptId: "attempt-1" })],
  ])("marks %s as blocking structural debt", async (_name, tamper) => {
    const f = await fixture();
    const record = await f.read(tamper(f.decision(), f));
    expect(record).toMatchObject({ valid: false, structurallyValid: false });
    expect(record).not.toHaveProperty("retainedNonqualified");
  });

  it.each(["archived", "rejected", "duplicate", "superseded"])("rejects a forged retention block on a %s record", async status => {
    const f = await fixture();
    const record = await f.read({ ...f.decision(), status });
    expect(record).toMatchObject({ valid: false });
    expect(record?.evidence.join(" ")).toContain("must not carry retention");
  });
});

const MIB = 1024 * 1024;
describe("finite resource policy", () => {
  const base = (kind = RetainedNonqualifiedOriginalKind.ResultMissing) => receiptFor("/w", kind);
  const lengths = (each: number) => Object.fromEntries(RETAINED_NONQUALIFIED_BACKUP_PAYLOADS.map(name => [name, each]));
  const v2 = (policy: unknown, change: Record<string, unknown> = {}) =>
    ({ ...base(), schemaVersion: 2, resourcePolicy: policy, payloadLengths: lengths(10), ...change });
  const withEntry = (size: number, totalBytes: number) => {
    const receipt = base();
    return { inventory: { ...receipt.inventory, totalBytes, entries: [{ ...receipt.inventory.entries[0]!, size }] } };
  };

  it("dispatches strictly: the two reviewed policies carry their finite limits and nothing else resolves", () => {
    expect(retainedNonqualifiedResourceLimits("default_v1")).toEqual({ entries: 20_000, inventoryBytes: 64 * MIB, fileBytes: 64 * MIB,
      lifecycleBytes: 64 * MIB, patchBytes: 32 * MIB, payloadBytes: 128 * MIB, backupBytes: 256 * MIB, receiptBytes: 8 * MIB, gitMetadataBytes: 16 * MIB });
    expect(retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.ExpandedV1)).toEqual({ entries: 20_000,
      inventoryBytes: 384 * MIB, fileBytes: 128 * MIB, lifecycleBytes: 64 * MIB, patchBytes: 32 * MIB, payloadBytes: 512 * MIB,
      backupBytes: 512 * MIB, receiptBytes: 8 * MIB, gitMetadataBytes: 16 * MIB });
    for (const unsupported of ["unlimited", "expanded_v2", "EXPANDED_V1", "", undefined, null, 1, {}, ["expanded_v1"]]) {
      expect(retainedNonqualifiedResourceLimits(unsupported)).toBeUndefined();
    }
    expect(() => retainedNonqualifiedReceiptLimits({ schemaVersion: 2, resourcePolicy: "nope" as never })).toThrow("resource_policy_unsupported");
    // A v1 receipt keeps the ordinary semantics; it can never be widened by omission.
    expect(retainedNonqualifiedReceiptLimits({ schemaVersion: 1 }).inventoryBytes).toBe(64 * MIB);
  });

  it("accepts a v2 receipt that names its policy and every actual payload length, and still accepts a v1 receipt", () => {
    expect(assertRetainedNonqualifiedReceipt(v2("default_v1"))).toMatchObject({ schemaVersion: 2, resourcePolicy: "default_v1" });
    expect(assertRetainedNonqualifiedReceipt(v2("expanded_v1"))).toMatchObject({ schemaVersion: 2, resourcePolicy: "expanded_v1" });
    expect(assertRetainedNonqualifiedReceipt(base())).toMatchObject({ schemaVersion: 1 });
  });

  it.each([
    ["an unknown policy", v2("unlimited"), "resourcePolicy is unsupported"],
    ["a missing policy", (() => { const { resourcePolicy: _drop, ...rest } = v2("default_v1"); return rest; })(), "invalid shape"],
    ["missing payload lengths", (() => { const { payloadLengths: _drop, ...rest } = v2("default_v1"); return rest; })(), "invalid shape"],
    ["a v1 receipt carrying v2 fields", { ...base(), resourcePolicy: "expanded_v1", payloadLengths: lengths(1) }, "invalid shape"],
    ["an unknown schema version", { ...base(), schemaVersion: 3 }, "schemaVersion is unsupported"],
    ["an extra payload length", v2("default_v1", { payloadLengths: { ...lengths(1), "extra.bin": 1 } }), "payloadLengths is invalid"],
    ["a missing payload length", v2("default_v1", { payloadLengths: { ...lengths(1), "staged.tar": undefined } }), "payloadLengths is invalid"],
    ["a negative payload length", v2("default_v1", { payloadLengths: { ...lengths(1), "staged.tar": -1 } }), "payloadLengths is invalid"],
    ["a fractional payload length", v2("default_v1", { payloadLengths: { ...lengths(1), "staged.tar": 1.5 } }), "payloadLengths is invalid"],
    ["one default payload byte over its cap", v2("default_v1", { payloadLengths: { ...lengths(1), "untracked.tar": 128 * MIB + 1 } }), "payloadLengths is invalid"],
    ["one expanded payload byte over its cap", v2("expanded_v1", { payloadLengths: { ...lengths(1), "untracked.tar": 512 * MIB + 1 } }), "payloadLengths is invalid"],
    ["payloads leaving no room for the maximum receipt", v2("expanded_v1", { payloadLengths: { ...lengths(0), "untracked.tar": 400 * MIB, "staged.tar": 112 * MIB } }), "payloadLengths is invalid"],
  ])("refuses %s", (_name, value, problem) => {
    expect(() => assertRetainedNonqualifiedReceipt(value)).toThrow(problem);
  });

  it("binds the inventory bounds to the receipt's own policy, one byte at a time", () => {
    const canaryFile = 123_655_872, canaryTotal = 263_341_675;
    // The reviewed canary-size envelope: refused by the ordinary policy, accepted by the expanded one.
    expect(() => assertRetainedNonqualifiedReceipt(v2("default_v1", withEntry(canaryFile, canaryTotal)))).toThrow("inventory");
    expect(assertRetainedNonqualifiedReceipt(v2("expanded_v1", withEntry(canaryFile, canaryTotal)))).toMatchObject({ resourcePolicy: "expanded_v1" });
    // Exactly at each bound is accepted; one byte beyond is refused.
    expect(assertRetainedNonqualifiedReceipt(v2("default_v1", withEntry(64 * MIB, 64 * MIB)))).toBeDefined();
    expect(() => assertRetainedNonqualifiedReceipt(v2("default_v1", withEntry(64 * MIB + 1, 64 * MIB + 1)))).toThrow("inventory");
    expect(assertRetainedNonqualifiedReceipt(v2("expanded_v1", withEntry(128 * MIB, 384 * MIB)))).toBeDefined();
    expect(() => assertRetainedNonqualifiedReceipt(v2("expanded_v1", withEntry(128 * MIB + 1, 384 * MIB)))).toThrow("inventory");
    expect(() => assertRetainedNonqualifiedReceipt(v2("expanded_v1", withEntry(1, 384 * MIB + 1)))).toThrow("inventory");
    // A v1 receipt is read under the default limits and can never claim the expanded envelope.
    expect(() => assertRetainedNonqualifiedReceipt({ ...base(), ...withEntry(canaryFile, canaryTotal) })).toThrow("inventory");
  });

  it("bounds the entry count and the ignored lists by the policy's entry limit", () => {
    const entry = base().inventory.entries[0]!;
    const many = Array.from({ length: 20_001 }, (_unused, index) => ({ ...entry, path: `f/${index}` }));
    expect(() => assertRetainedNonqualifiedReceipt(v2("expanded_v1", { inventory: { ...base().inventory, entries: many } }))).toThrow("inventory");
    expect(() => assertRetainedNonqualifiedReceipt(v2("expanded_v1", { ignored: { retain: many.map(item => item.path), disposableListing: [] } })))
      .toThrow("ignored classification");
  });
});

describe("terminal decision writer guard", () => {
  it("requires the receipt discriminator and forbids every claim other statuses make", async () => {
    const f = await fixture();
    const { retention: _retention, ...withoutRetention } = f.decision();
    expect(() => assertTerminalOutputDecision(f.decision())).not.toThrow();
    expect(() => assertTerminalOutputDecision(withoutRetention)).toThrow("terminal_output_retained_nonqualified_retention_required");
    expect(() => assertTerminalOutputDecision({ ...f.decision(), commitSha: "1234567" })).toThrow("terminal_output_retained_nonqualified_claims_forbidden");
    expect(() => assertTerminalOutputDecision({ ...f.decision(), failure: { category: "a", code: "b" } })).toThrow("claims_forbidden");
    expect(() => assertTerminalOutputDecision({ ...f.decision(), retention: { ...f.decision().retention!, receiptPath: join(dirname(f.archive), "x.json") } }))
      .toThrow("retained_nonqualified_retention_required");
    expect(() => assertTerminalOutputDecision({ ...f.decision(), backup: { ...f.decision().backup, untrackedArchivePath: undefined as unknown as string } }))
      .toThrow("retained_nonqualified_retention_required");
    // A forged retention field cannot turn an ordinary disposition into this one.
    expect(() => assertTerminalOutputDecision({ ...f.decision(), status: "archived" })).toThrow("terminal_output_retention_forbidden");
  });

  it("binds the receipt kind to the preserved facts instead of trusting the label", () => {
    const missing = receiptFor("/w", RetainedNonqualifiedOriginalKind.ResultMissing);
    expect(() => assertRetainedNonqualifiedReceipt({ ...missing, kind: RetainedNonqualifiedOriginalKind.FailedCheckpoint })).toThrow("original_failed_checkpoint requires");
    const failed = receiptFor("/w", RetainedNonqualifiedOriginalKind.FailedCheckpoint);
    expect(() => assertRetainedNonqualifiedReceipt({ ...failed, kind: RetainedNonqualifiedOriginalKind.ResultMissing })).toThrow("original_result_missing requires");
    expect(() => assertRetainedNonqualifiedReceipt({ ...failed, original: { ...failed.original, resultStatus: "done" } })).toThrow();
    expect(() => assertRetainedNonqualifiedReceipt({ ...missing, inventory: { ...missing.inventory,
      entries: [{ ...missing.inventory.entries[0]!, path: "../escape" }] } })).toThrow("inventory entry is invalid");
    // The staged side must be a real stage-zero git identity, and the lifecycle must be complete.
    expect(() => assertRetainedNonqualifiedReceipt({ ...missing, inventory: { ...missing.inventory,
      entries: [{ ...missing.inventory.entries[1]!, index: { mode: "160000", oid: "a".repeat(40) } }] } })).toThrow("inventory entry is invalid");
    const { manifest: _manifest, ...incomplete } = missing.original;
    expect(() => assertRetainedNonqualifiedReceipt({ ...missing, original: incomplete })).toThrow("original lifecycle evidence is invalid");
    expect(() => assertRetainedNonqualifiedReceipt({ ...missing, backupFiles: { "tracked.diff": sha256("") } })).toThrow("backupFiles is invalid");
  });
});
