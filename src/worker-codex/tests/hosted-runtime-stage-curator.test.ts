import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qualificationRequiredArtifacts } from "../hosted-ordinary-installation-qualification";
import { deriveQualificationSourceScope } from "../hosted-ordinary-installation-source-scope";
import { curateRuntimeStage, encodeIssuerReceipt, encodeStageRecord, ensurePrivateDirectory, IssuerReceiptKind, issuerReceiptPathFor, parseIssuerReceipt, stageRecordPathFor,
  verifyIssuerReceipt, verifyStageRecord, type StagePorts, type StageRequest } from "../hosted-runtime-stage-curator";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const runtimeDirectory = "/opt/subscription-runtime/releases/" + "1".repeat(40), runtimeSha = "1".repeat(40), archiveSha256 = "2".repeat(64);
const request: StageRequest = { runtimeDirectory, runtimeSha, archiveSha256 };
const bootId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", moduleSha = "3".repeat(64);
const entry = "dist/worker-codex/hosted-ordinary-installation-qualification.js";

function release(extra: Record<string, string> = {}) {
  const files = new Map<string, Buffer>([["package.json", Buffer.from(JSON.stringify({ name: "@vioxen/subscription-runtime", exports: {} }))]]);
  for (const path of qualificationRequiredArtifacts) files.set(path, Buffer.from(`export const id = ${JSON.stringify(path)};\n`));
  files.set(entry, Buffer.from('import "./extra.js";\n')); files.set("dist/worker-codex/extra.js", Buffer.from("export {};\n"));
  for (const [path, text] of Object.entries(extra)) files.set(path, Buffer.from(text));
  files.set("ordinary-qualification-source.json", deriveQualificationSourceScope(path => files.get(path) ?? Buffer.alloc(0)).bytes);
  return files;
}
function harness(files = release(), markers: Record<string, string> = {}) {
  const store = new Map<string, Buffer>(), publish = vi.fn((path: string, bytes: Buffer) => { if (store.has(path)) throw new Error("EEXIST"); store.set(path, Buffer.from(bytes)); });
  const meta: Record<string, string> = { ".source-commit": runtimeSha + "\n", ".source-archive-sha256": archiveSha256 + "\n",
    ".build-verified": `source_sha=${runtimeSha}\nsource_archive_sha256=${archiveSha256}\nnode_version=v24.21.0\n`, ...markers };
  const ports: StagePorts = { read: path => { const bytes = files.get(path); if (!bytes) throw new Error("missing"); return bytes; }, marker: name => meta[name] ?? "",
    bootId: () => bootId, moduleSha256: () => moduleSha, ensureDirectory: vi.fn(), publish, readPrivate: path => store.get(path) ?? null };
  return { files, store, publish, ports };
}

describe("stage curator: what it publishes", () => {
  // Regression: the stage record is a second spelling of the manifest digest, or is not bound to the admitted manifest bytes.
  it("publishes the canonical record whose manifest digest is the admitted manifest's SHA-256, plus a closed receipt", () => {
    const h = harness(), out = curateRuntimeStage(request, h.ports);
    const scope = h.files.get("ordinary-qualification-source.json") as Buffer;
    expect(out.runtimeManifestSha256).toBe(sha(scope));
    const record = h.store.get(stageRecordPathFor(runtimeDirectory)) as Buffer;
    expect(record.equals(encodeStageRecord({ schemaVersion: 1, runtimeDirectory, runtimeSha, runtimeManifestSha256: sha(scope) }))).toBe(true);
    expect(stageRecordPathFor(runtimeDirectory)).toBe(`/run/user/0/subscription-runtime-host-policy/codex-readonly-stages/${sha(Buffer.from(runtimeDirectory))}.json`);
    const receipt = verifyIssuerReceipt(h.store.get(out.receiptPath) as Buffer, { kind: IssuerReceiptKind.RuntimeStage, bootId, issuerModuleSha256: moduleSha, outputPath: stageRecordPathFor(runtimeDirectory),
      outputSha256: sha(record), sourceScopeSha256: sha(scope), runtimeDirectory, runtimeSha, operationId: null });
    expect(receipt.issuerModuleSha256).toBe(moduleSha);
    expect(receipt.operationId).toBeNull();
  });
  // Regression: a replay appends a second record, or acknowledges different bytes as "the same".
  it("is idempotent for identical bytes and refuses a forged or stale record without publishing", () => {
    const h = harness();
    const first = curateRuntimeStage(request, h.ports), calls = h.publish.mock.calls.length;
    expect(curateRuntimeStage(request, h.ports)).toEqual(first);
    expect(h.publish.mock.calls.length).toBe(calls);
    for (const forged of [{ runtimeManifestSha256: "4".repeat(64) }, { runtimeSha: "5".repeat(40) }]) {
      const other = harness(), path = stageRecordPathFor(runtimeDirectory);
      other.store.set(path, encodeStageRecord({ schemaVersion: 1, runtimeDirectory, runtimeSha, runtimeManifestSha256: sha(other.files.get("ordinary-qualification-source.json") as Buffer), ...forged }));
      expect(() => curateRuntimeStage(request, other.ports)).toThrow("hosted_runtime_issuer_conflicting_record");
      expect(other.publish).not.toHaveBeenCalled();
    }
  });
});

describe("stage curator: reissue after a reboot (receipt names carry the boot)", () => {
  const secondBoot = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  // Regression (F1): the receipt was named by the output digest only, so the second boot's receipt (new bootId inside, same digest) collided with the first boot's and the legitimate reissue was refused after the stage was published.
  it("reissues on a second boot without a collision and the reader accepts only the current boot's receipt", () => {
    const h = harness(), first = curateRuntimeStage(request, h.ports);
    h.store.delete(stageRecordPathFor(runtimeDirectory));                       // /run is volatile: the stage record is gone after the reboot, the receipts (under /var/lib) survive
    const second = curateRuntimeStage(request, { ...h.ports, bootId: () => secondBoot });
    expect(second.stageSha256).toBe(first.stageSha256);
    expect(second.receiptPath).not.toBe(first.receiptPath);
    expect(first.receiptPath).toBe(issuerReceiptPathFor(IssuerReceiptKind.RuntimeStage, bootId, first.stageSha256));
    expect(second.receiptPath).toBe(issuerReceiptPathFor(IssuerReceiptKind.RuntimeStage, secondBoot, second.stageSha256));
    const scope = sha(h.files.get("ordinary-qualification-source.json") as Buffer);
    const expectedAt = (boot: string) => ({ kind: IssuerReceiptKind.RuntimeStage, bootId: boot, issuerModuleSha256: moduleSha, outputPath: stageRecordPathFor(runtimeDirectory), outputSha256: first.stageSha256,
      sourceScopeSha256: scope, runtimeDirectory, runtimeSha, operationId: null });
    expect(verifyIssuerReceipt(h.store.get(second.receiptPath) as Buffer, expectedAt(secondBoot)).bootId).toBe(secondBoot);
    expect(() => verifyIssuerReceipt(h.store.get(first.receiptPath) as Buffer, expectedAt(secondBoot))).toThrow("hosted_runtime_issuer_invalid");     // the old boot's receipt is rejected by content
    // the first boot's receipt is still valid for the first boot (nothing was overwritten or reinterpreted); the name is not the only binding, the bytes carry the boot too
    expect(() => verifyIssuerReceipt(h.store.get(first.receiptPath) as Buffer, expectedAt(bootId))).not.toThrow();
  });
  it("refuses a malformed boot id or digest when naming a receipt", () => {
    expect(() => issuerReceiptPathFor(IssuerReceiptKind.RuntimeStage, "not-a-boot", "a".repeat(64))).toThrow("hosted_runtime_issuer_invalid");
    expect(() => issuerReceiptPathFor(IssuerReceiptKind.RuntimeStage, secondBoot, "zz")).toThrow("hosted_runtime_issuer_invalid");
  });
});

describe("stage curator: what it refuses before publishing anything", () => {
  // Regression: an altered source file, a manifest that lacks a loaded module, or one with an unknown entry becomes the qualification scope.
  it.each([
    ["altered listed file", (h: ReturnType<typeof harness>) => h.files.set("dist/worker-codex/extra.js", Buffer.from("export const tampered = 1;\n"))],
    ["manifest omits a loaded module", (h: ReturnType<typeof harness>) => {
      const scope = JSON.parse((h.files.get("ordinary-qualification-source.json") as Buffer).toString("utf8")) as { files: { path: string }[] };
      h.files.set("ordinary-qualification-source.json", Buffer.from(JSON.stringify({ ...scope, files: scope.files.filter(file => file.path !== "dist/worker-codex/extra.js") }) + "\n"));
    }],
    ["manifest bytes without the trailing newline", (h: ReturnType<typeof harness>) => h.files.set("ordinary-qualification-source.json", Buffer.from((h.files.get("ordinary-qualification-source.json") as Buffer).toString("utf8").trimEnd()))],
    ["new unmeasured import after the manifest was written", (h: ReturnType<typeof harness>) => h.files.set("dist/worker-codex/extra.js", Buffer.from('import "left-pad";\n'))],
  ])("%s", (_name, mutate) => {
    const h = harness(); mutate(h);
    expect(() => curateRuntimeStage(request, h.ports)).toThrow();
    expect(h.publish).not.toHaveBeenCalled();
  });
  // Regression: a release marker from another commit/archive is accepted because the manifest itself is internally consistent.
  it.each([
    ["commit", { ".source-commit": "6".repeat(40) + "\n" }],
    ["archive digest", { ".source-archive-sha256": "7".repeat(64) + "\n" }],
    ["build marker", { ".build-verified": `source_sha=${runtimeSha}\n` }],
  ])("refuses a wrong %s marker", (_name, markers) => {
    const h = harness(release(), markers);
    expect(() => curateRuntimeStage(request, h.ports)).toThrow("hosted_runtime_issuer_invalid");
    expect(h.publish).not.toHaveBeenCalled();
  });
});

describe("stage record and receipt readers", () => {
  const scopeSha = "8".repeat(64), expected = { runtimeDirectory, runtimeSha, sourceScopeSha256: scopeSha };
  const record = encodeStageRecord({ schemaVersion: 1, runtimeDirectory, runtimeSha, runtimeManifestSha256: scopeSha });
  // Regression: a curator with another manifest definition (tree digest, other file) is accepted because only 64 hex characters are compared.
  it("requires manifest == scope digest, closed keys, canonical bytes and the exact directory", () => {
    expect(verifyStageRecord(record, expected).runtimeManifestSha256).toBe(scopeSha);
    expect(() => verifyStageRecord(record, { ...expected, sourceScopeSha256: "9".repeat(64) })).toThrow();
    expect(() => verifyStageRecord(record, { ...expected, runtimeDirectory: "/opt/other" })).toThrow();
    expect(() => verifyStageRecord(Buffer.from(JSON.stringify({ ...JSON.parse(record.toString("utf8")), extra: 1 }) + "\n"), expected)).toThrow();
    expect(() => verifyStageRecord(Buffer.from(record.toString("utf8").trimEnd()), expected)).toThrow();
    expect(() => verifyStageRecord(Buffer.from(JSON.stringify({ runtimeSha, schemaVersion: 1, runtimeDirectory, runtimeManifestSha256: scopeSha }) + "\n"), expected)).toThrow();
  });
  const base = { schemaVersion: 1 as const, kind: IssuerReceiptKind.RuntimeStage, issuerModuleSha256: moduleSha, bootId, runtimeDirectory, runtimeSha, sourceScopeSha256: scopeSha,
    operationId: null, outputPath: "/run/user/0/x.json", outputSha256: "a".repeat(64) };
  // Regression: a receipt is only a hash to its reader, so a forged, stale-boot or re-ordered receipt is believed.
  it("parses a closed canonical receipt and rejects forged, stale and non-canonical ones", () => {
    const good = encodeIssuerReceipt(base);
    expect(parseIssuerReceipt(good)).toEqual(base);
    const context = { kind: IssuerReceiptKind.RuntimeStage, bootId, issuerModuleSha256: moduleSha, outputPath: base.outputPath, outputSha256: base.outputSha256, sourceScopeSha256: scopeSha,
      runtimeDirectory, runtimeSha, operationId: null };
    expect(verifyIssuerReceipt(good, context)).toEqual(base);
    // every bound field, one at a time: stale boot, forged/other issuer module, redirected output path, altered output, other scope/release, other operation
    for (const forged of [{ bootId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, { issuerModuleSha256: "c".repeat(64) }, { outputPath: "/run/user/0/other.json" }, { outputSha256: "b".repeat(64) },
      { sourceScopeSha256: "d".repeat(64) }, { runtimeDirectory: "/opt/other" }, { runtimeSha: "e".repeat(40) }, { operationId: "11111111-1111-4111-8111-111111111111" },
      { kind: IssuerReceiptKind.FdCollectorProfile }]) {
      expect(() => verifyIssuerReceipt(good, { ...context, ...forged })).toThrow("hosted_runtime_issuer_invalid");
    }
    expect(() => parseIssuerReceipt(Buffer.from(JSON.stringify({ ...base, extra: true }) + "\n"))).toThrow();
    const { kind: reorderedKind, schemaVersion: reorderedVersion, ...remaining } = base;      // same values, deliberately NON-canonical key order: kind before schemaVersion
    expect(() => parseIssuerReceipt(Buffer.from(JSON.stringify({ kind: reorderedKind, schemaVersion: reorderedVersion, ...remaining }) + "\n"))).toThrow();
    expect(() => parseIssuerReceipt(Buffer.from(JSON.stringify({ ...base, issuerModuleSha256: "zz" }) + "\n"))).toThrow();
    expect(() => parseIssuerReceipt(encodeIssuerReceipt({ ...base, kind: IssuerReceiptKind.FdCollectorProfile }))).toThrow();            // profile receipts must carry an operation id
    expect(() => parseIssuerReceipt(encodeIssuerReceipt({ ...base, operationId: "11111111-1111-4111-8111-111111111111" }))).toThrow();   // stage receipts must not
  });
});

describe("private directory custody (real directories, current uid)", () => {
  const uid = process.getuid?.() ?? 0;
  let base = "";
  afterEach(() => { if (base) { try { chmodSync(base, 0o700); rmSync(base, { recursive: true, force: true }); } catch { /* temp only */ } base = ""; } });
  const fresh = () => { base = mkdtempSync(join(tmpdir(), "TEST-stage-custody-")); chmodSync(base, 0o700); const anchor = join(base, "anchor"); mkdirSync(anchor, { mode: 0o700 }); chmodSync(anchor, 0o700); return anchor; };
  // Regression: the stage directory is created with a wider mode, or a created chain is not private.
  it("creates missing directories strictly below the anchor with mode 0700", () => {
    const anchor = fresh(), target = join(anchor, "a", "b");
    ensurePrivateDirectory(target, anchor, uid, base);
    expect(lstatSync(target).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(anchor, "a")).mode & 0o777).toBe(0o700);
    ensurePrivateDirectory(target, anchor, uid, base);          // idempotent
  });
  // Regression: a symlinked component redirects the stage record, or the issuer invents a missing trust anchor.
  it("refuses symlinked components, a missing anchor and targets outside the anchor", () => {
    const anchor = fresh(); mkdirSync(join(base, "elsewhere"), { mode: 0o700 }); symlinkSync(join(base, "elsewhere"), join(anchor, "link"));
    expect(() => ensurePrivateDirectory(join(anchor, "link", "x"), anchor, uid, base)).toThrow();
    expect(() => ensurePrivateDirectory(join(base, "missing-anchor", "x"), join(base, "missing-anchor"), uid, base)).toThrow();
    expect(() => ensurePrivateDirectory(join(base, "elsewhere"), anchor, uid, base)).toThrow();
  });
  // Regression: a group-writable ancestor, a foreign owner or a group-readable final directory is accepted as private custody.
  it("refuses group/other-writable ancestors, another owner and a final directory open to group/other", () => {
    const anchor = fresh(); mkdirSync(join(anchor, "open"), { mode: 0o700 });
    chmodSync(anchor, 0o770);
    expect(() => ensurePrivateDirectory(join(anchor, "open"), anchor, uid, base)).toThrow();
    chmodSync(anchor, 0o700); chmodSync(join(anchor, "open"), 0o750);
    expect(() => ensurePrivateDirectory(join(anchor, "open"), anchor, uid, base)).toThrow();
    chmodSync(join(anchor, "open"), 0o700);
    expect(() => ensurePrivateDirectory(join(anchor, "open"), anchor, uid + 1, base)).toThrow();
    expect(() => ensurePrivateDirectory(join(anchor, "open"), anchor, uid, base)).not.toThrow();
  });
});
