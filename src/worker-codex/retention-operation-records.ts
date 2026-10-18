import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostedRetentionOperationDirectory, hostedRetentionRecordName, type HostedRetentionRecord } from "../core/host-infrastructure/host-retention-operation";
import { createReadonlyPrivateRecordOnce, readonlySupervisorRoot } from "./hosted-readonly-custody";
import { readHostedPrivateBytes } from "./hosted-readonly-inputs";

/**
 * The only filesystem surface of the retention operator role: fixed names beneath the existing private Host-policy root
 * (`retention-operations/`, created by the operator like the installation operation directory). Reads use the existing
 * root-owned, mode-checked, ancestry-bound private reader; writes are create-once (a consumed name is never rewritten,
 * so a retry cannot overwrite or silently replay a partial effect).
 */
export const retentionOperationRoot = join(readonlySupervisorRoot, hostedRetentionOperationDirectory);
export const retentionRecordPath = (operationId: string, record: HostedRetentionRecord) =>
  join(retentionOperationRoot, hostedRetentionRecordName(operationId, record));
export const retentionSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function retentionHeld(reason: string): never { throw new Error(`hosted_retention_operation_held:${reason}`); }

export function readRetentionRecord(operationId: string, record: HostedRetentionRecord, maxBytes = 64 * 1024): Buffer | null {
  return readHostedPrivateBytes(retentionRecordPath(operationId, record), maxBytes);
}
export function decodeRetentionJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return retentionHeld("record_not_json"); }
}
/** Create-once: any existing name (even with identical bytes) refuses, so a record is never replayed or repaired in place. */
export function createRetentionRecord(operationId: string, record: HostedRetentionRecord, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > 64 * 1024) retentionHeld("record_too_large");
  createReadonlyPrivateRecordOnce(retentionRecordPath(operationId, record), bytes);
  return bytes;
}
/** The per-operation directory beneath the (operator-created) root; 0700, root-owned. */
export function ensureRetentionOperationDirectories(operationId: string): void {
  for (const directory of [retentionOperationRoot, join(retentionOperationRoot, operationId)]) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
