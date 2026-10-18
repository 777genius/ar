import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHostedActivationOperator } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { admitQualificationSourceFiles, qualificationRead } from "./hosted-ordinary-installation-qualification";
import { assertSourceScopeMatchesDerivation, deriveQualificationSourceScope, runtimeManifestSha256Of, type SourceScopeReader } from "./hosted-ordinary-installation-source-scope";
import { createReadonlyPrivateRecordOnce, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

/**
 * Runtime Host stage curator. It is the ONLY writer of the stage record `codex-readonly-stages/<sha256(runtimeDirectory)>.json` and is
 * independent of the ordinary issuer. It verifies the installed immutable release, derives the closed manifest with the one canonical
 * derivation, publishes the record create-once and a closed receipt of what it did. The record is authority only because an admitted
 * operator (root, initial namespaces: `assertHostedActivationOperator`) produced it through this module; nothing else may write it.
 */
export const stageRecordRoot = "/run/user/0/subscription-runtime-host-policy/codex-readonly-stages";
export const issuerReceiptRoot = join(readonlySupervisorRoot, "issuer-receipts");
const digest = /^[a-f0-9]{64}$/, sha1 = /^[a-f0-9]{40}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const canonicalPath = /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function invalid(): never { throw new Error("hosted_runtime_issuer_invalid"); }
function closed(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
function jsonOf(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return invalid(); }
}

// ---- stage record: closed form, ONE canonical encoder (its bytes are hashed into custody chains, so no second spelling may exist) ----
export type StageRecord = Readonly<{ schemaVersion: 1; runtimeDirectory: string; runtimeSha: string; runtimeManifestSha256: string }>;
export function encodeStageRecord(record: StageRecord): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, runtimeDirectory: record.runtimeDirectory, runtimeSha: record.runtimeSha, runtimeManifestSha256: record.runtimeManifestSha256 }) + "\n");
}
export const stageRecordPathFor = (runtimeDirectory: string): string => join(stageRecordRoot, sha(Buffer.from(runtimeDirectory)) + ".json");
/** Reader side of the same contract (used by the issuer after publishing and by `issuers candidate`): closed, canonical, and manifest == scope digest. */
export function verifyStageRecord(bytes: Buffer, expected: Readonly<{ runtimeDirectory: string; runtimeSha: string; sourceScopeSha256: string }>): StageRecord {
  const row = closed(jsonOf(bytes), "schemaVersion,runtimeDirectory,runtimeSha,runtimeManifestSha256");
  if (row["schemaVersion"] !== 1 || typeof row["runtimeDirectory"] !== "string" || typeof row["runtimeSha"] !== "string" || typeof row["runtimeManifestSha256"] !== "string" ||
      !canonicalPath.test(row["runtimeDirectory"]) || !sha1.test(row["runtimeSha"]) || !digest.test(row["runtimeManifestSha256"])) invalid();
  const record: StageRecord = Object.freeze({ schemaVersion: 1, runtimeDirectory: row["runtimeDirectory"], runtimeSha: row["runtimeSha"], runtimeManifestSha256: row["runtimeManifestSha256"] });
  if (!encodeStageRecord(record).equals(bytes) || record.runtimeDirectory !== expected.runtimeDirectory || record.runtimeSha !== expected.runtimeSha ||
      record.runtimeManifestSha256 !== expected.sourceScopeSha256) invalid();
  return record;
}

// ---- issuer receipt: closed schema, canonical bytes. `issuers candidate` and any reviewer parse THIS, never a bare hash ----
export enum IssuerReceiptKind { RuntimeStage = "runtime_stage", FdCollectorProfile = "fd_collector_profile" }
export type IssuerReceipt = Readonly<{ schemaVersion: 1; kind: IssuerReceiptKind; issuerModuleSha256: string; bootId: string; runtimeDirectory: string; runtimeSha: string;
  sourceScopeSha256: string; operationId: string | null; outputPath: string; outputSha256: string }>;
export function encodeIssuerReceipt(r: IssuerReceipt): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, kind: r.kind, issuerModuleSha256: r.issuerModuleSha256, bootId: r.bootId, runtimeDirectory: r.runtimeDirectory, runtimeSha: r.runtimeSha,
    sourceScopeSha256: r.sourceScopeSha256, operationId: r.operationId, outputPath: r.outputPath, outputSha256: r.outputSha256 }) + "\n");
}
export function parseIssuerReceipt(bytes: Buffer): IssuerReceipt {
  const row = closed(jsonOf(bytes), "schemaVersion,kind,issuerModuleSha256,bootId,runtimeDirectory,runtimeSha,sourceScopeSha256,operationId,outputPath,outputSha256");
  const text = (key: string, pattern: RegExp): string => { const v = row[key]; return typeof v === "string" && pattern.test(v) ? v : invalid(); };
  const kind = row["kind"];
  if (row["schemaVersion"] !== 1 || (kind !== IssuerReceiptKind.RuntimeStage && kind !== IssuerReceiptKind.FdCollectorProfile)) invalid();
  const operation = row["operationId"];
  if (operation !== null && !(typeof operation === "string" && uuid.test(operation))) invalid();
  if ((kind === IssuerReceiptKind.FdCollectorProfile) !== (operation !== null)) invalid();
  const receipt: IssuerReceipt = Object.freeze({ schemaVersion: 1, kind, issuerModuleSha256: text("issuerModuleSha256", digest), bootId: text("bootId", uuid),
    runtimeDirectory: text("runtimeDirectory", canonicalPath), runtimeSha: text("runtimeSha", sha1), sourceScopeSha256: text("sourceScopeSha256", digest),
    operationId: operation, outputPath: text("outputPath", canonicalPath), outputSha256: text("outputSha256", digest) });
  if (!encodeIssuerReceipt(receipt).equals(bytes)) invalid();
  return receipt;
}
/**
 * ONE receipt path spelling for writers and readers. The boot id is part of the NAME as well as of the content: the stage record lives under /run and is recreated after a reboot with the
 * same bytes, so the second boot's receipt must not collide with the first boot's (create-once would refuse it), and a reader that derives the current boot's name can never be handed an old-boot file.
 */
export const issuerReceiptPathFor = (kind: IssuerReceiptKind, bootId: string, outputSha256: string): string => {
  if (!uuid.test(bootId) || !digest.test(outputSha256)) invalid();
  return join(issuerReceiptRoot, `${kind}-${bootId}-${outputSha256}.json`);
};
/** The release file whose bytes ARE the issuer: a receipt names an issuer only by the digest of the exact module the immutable release ships. */
export const issuerModuleRelativePath: Readonly<Record<IssuerReceiptKind, string>> = Object.freeze({
  [IssuerReceiptKind.RuntimeStage]: "dist/worker-codex/hosted-runtime-stage-curator.js",
  [IssuerReceiptKind.FdCollectorProfile]: "dist/worker-codex/hosted-fd-collector-profile-issuer.js",
});
/**
 * Reader-side acceptance of a receipt. EVERY field is compared with an expectation the reader derives itself, never with the receipt's own words:
 * kind; same boot (volatile stage records die with the boot); the exact release; the scope digest; the digest of the issuer module read from the
 * immutable release (`issuerModuleRelativePath`); the exact output path and digest; and the operation (null for the stage, the funded operation for the profile).
 */
export type IssuerReceiptExpectation = Readonly<{ kind: IssuerReceiptKind; bootId: string; issuerModuleSha256: string; outputPath: string; outputSha256: string; sourceScopeSha256: string;
  runtimeDirectory: string; runtimeSha: string; operationId: string | null }>;
export function verifyIssuerReceipt(bytes: Buffer, expected: IssuerReceiptExpectation): IssuerReceipt {
  const receipt = parseIssuerReceipt(bytes);
  if (receipt.kind !== expected.kind || receipt.bootId !== expected.bootId || receipt.issuerModuleSha256 !== expected.issuerModuleSha256 || receipt.outputPath !== expected.outputPath ||
      receipt.outputSha256 !== expected.outputSha256 || receipt.sourceScopeSha256 !== expected.sourceScopeSha256 || receipt.runtimeDirectory !== expected.runtimeDirectory ||
      receipt.runtimeSha !== expected.runtimeSha || receipt.operationId !== expected.operationId) invalid();
  return receipt;
}

// ---- directory custody ----
export type DirectoryFacts = Readonly<{ isDirectory: boolean; isSymbolicLink: boolean; uid: number; mode: number }>;
export type DirectoryIo = Readonly<{ lstat(path: string): DirectoryFacts | undefined; mkdir(path: string): void; syncDirectory(path: string): void }>;
export const nodeDirectoryIo: DirectoryIo = Object.freeze({
  lstat(path: string): DirectoryFacts | undefined {
    try { const s = lstatSync(path); return { isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(), uid: s.uid, mode: s.mode }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  },
  mkdir(path: string): void { mkdirSync(path, { mode: 0o700 }); },
  syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } },
});
/**
 * Ensures `path` is a private directory. `anchor` (an ancestor-or-equal) must already exist and is never created; everything strictly below it may be created with mode 0700 and is
 * fsynced with its parent. Every directory from `checkFrom` down must be a real directory (no symlink) owned by `uid` that group/other cannot write; the final directory must be
 * inaccessible to group/other. Production passes `checkFrom = "/"` and `uid = 0`.
 */
export function ensurePrivateDirectory(path: string, anchor: string, uid: number, checkFrom = "/", io: DirectoryIo = nodeDirectoryIo): void {
  const inside = (outer: string, inner: string): boolean => inner === outer || outer === "/" || inner.startsWith(outer + "/");
  if (!canonicalPath.test(path) || !canonicalPath.test(anchor) || !inside(anchor, path) || (checkFrom !== "/" && !canonicalPath.test(checkFrom)) || !inside(checkFrom, anchor)) invalid();
  const chain: string[] = [];
  for (let current = path;; current = dirname(current)) { chain.unshift(current); if (current === "/") break; }
  const accept = (facts: DirectoryFacts | undefined, directory: string): void => {
    if (!facts || !facts.isDirectory || facts.isSymbolicLink || facts.uid !== uid || (facts.mode & 0o022) !== 0 ||
        (directory === path && (facts.mode & 0o077) !== 0)) invalid();
  };
  for (const directory of chain) {
    if (!inside(checkFrom, directory)) continue;
    const facts = io.lstat(directory);
    if (!facts) {
      if (!inside(anchor, directory) || directory === anchor) invalid();       // the anchor and everything above it must already exist
      io.mkdir(directory); io.syncDirectory(dirname(directory));
      const made = io.lstat(directory);
      if (!made || (made.mode & 0o077) !== 0) invalid();
      accept(made, directory);
    } else accept(facts, directory);
  }
}

// ---- create-once publication with idempotent reconciliation: identical bytes are "same", anything else is a conflict (never overwritten) ----
export type PrivateRecordPorts = Readonly<{ ensureDirectory(directory: string): void; publish(path: string, bytes: Buffer): void; readPrivate(path: string): Buffer | null }>;
export function publishIdempotent(path: string, bytes: Buffer, ports: PrivateRecordPorts): "created" | "same" {
  ports.ensureDirectory(dirname(path));
  const existing = ports.readPrivate(path);
  if (existing) { if (!existing.equals(bytes)) throw new Error("hosted_runtime_issuer_conflicting_record"); return "same"; }
  ports.publish(path, bytes);
  return "created";
}

// ---- the curation ----
export type StageRequest = Readonly<{ runtimeDirectory: string; runtimeSha: string; archiveSha256: string }>;
export type StagePorts = PrivateRecordPorts & Readonly<{ read: SourceScopeReader; marker(name: string): string; bootId(): string; moduleSha256(): string }>;
export type StageOutcome = Readonly<{ stagePath: string; stageSha256: string; receiptPath: string; receiptSha256: string; runtimeManifestSha256: string }>;

export function curateRuntimeStage(request: StageRequest, ports: StagePorts): StageOutcome {
  if (!canonicalPath.test(request.runtimeDirectory) || !sha1.test(request.runtimeSha) || !digest.test(request.archiveSha256)) invalid();
  // 1 release identity: markers written by the normal installer must name exactly this commit and archive
  const buildMarker = ports.marker(".build-verified");
  if (ports.marker(".source-commit").trim() !== request.runtimeSha || ports.marker(".source-archive-sha256").trim() !== request.archiveSha256 ||
      !buildMarker.includes(`source_sha=${request.runtimeSha}\nsource_archive_sha256=${request.archiveSha256}\n`)) invalid();
  // 2 the admitted manifest: every listed file matches (product validator) AND nothing loaded is missing (canonical derivation)
  const scopeBytes = ports.read("ordinary-qualification-source.json");
  admitQualificationSourceFiles(jsonOf(scopeBytes), ports.read);
  const derived = deriveQualificationSourceScope(ports.read);
  assertSourceScopeMatchesDerivation(scopeBytes, derived);
  // 3 runtimeManifestSha256 == sha256(admitted manifest bytes) == sourceScopeSha256
  const runtimeManifestSha256 = runtimeManifestSha256Of(scopeBytes);
  if (runtimeManifestSha256 !== derived.sha256) invalid();
  const record = encodeStageRecord({ schemaVersion: 1, runtimeDirectory: request.runtimeDirectory, runtimeSha: request.runtimeSha, runtimeManifestSha256 });
  const stagePath = stageRecordPathFor(request.runtimeDirectory);
  publishIdempotent(stagePath, record, ports);
  verifyStageRecord(record, { runtimeDirectory: request.runtimeDirectory, runtimeSha: request.runtimeSha, sourceScopeSha256: derived.sha256 });
  const stageSha256 = sha(record);
  const bootId = ports.bootId();
  const receipt = encodeIssuerReceipt({ schemaVersion: 1, kind: IssuerReceiptKind.RuntimeStage, issuerModuleSha256: ports.moduleSha256(), bootId,
    runtimeDirectory: request.runtimeDirectory, runtimeSha: request.runtimeSha, sourceScopeSha256: derived.sha256, operationId: null, outputPath: stagePath, outputSha256: stageSha256 });
  const receiptPath = issuerReceiptPathFor(IssuerReceiptKind.RuntimeStage, bootId, stageSha256);
  publishIdempotent(receiptPath, receipt, ports);
  return Object.freeze({ stagePath, stageSha256, receiptPath, receiptSha256: sha(receipt), runtimeManifestSha256 });
}

// ---- composition with the existing RuntimeHost authority APIs ----
export function nodePrivateRecordPorts(uid = 0): PrivateRecordPorts {
  return Object.freeze({
    ensureDirectory(directory: string): void {
      ensurePrivateDirectory(directory, directory.startsWith("/run/user/0/") ? "/run/user/0" : readonlySupervisorRoot, uid);
    },
    publish: (path: string, bytes: Buffer): void => createReadonlyPrivateRecordOnce(path, bytes),
    readPrivate: (path: string): Buffer | null => readHostedPrivateBytes(path, 64 * 1024),
  });
}
export const currentBootId = (): string => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
/** Digest of the running issuer module, which MUST be byte-identical to the module the immutable release ships at `issuerModuleRelativePath`: a copy run from elsewhere is refused. */
export function ownModuleSha256(moduleUrl: string, kind: IssuerReceiptKind, runtimeDirectory: string): string {
  const own = sha(readFileSync(fileURLToPath(moduleUrl))), shipped = sha(qualificationRead(join(runtimeDirectory, issuerModuleRelativePath[kind]), 4 * 1024 * 1024));
  if (own !== shipped) invalid();
  return own;
}
export function runStageCuratorOperation(request: StageRequest): StageOutcome {
  assertHostedActivationOperator();
  const root = request.runtimeDirectory;
  const ports: StagePorts = Object.freeze({
    ...nodePrivateRecordPorts(),
    read: (relative: string): Buffer => qualificationRead(join(root, relative), 32 * 1024 * 1024),
    marker: (name: string): string => qualificationRead(join(root, name), 4096).toString("utf8"),
    bootId: currentBootId,
    moduleSha256: (): string => ownModuleSha256(import.meta.url, IssuerReceiptKind.RuntimeStage, root),
  });
  return curateRuntimeStage(request, ports);
}
