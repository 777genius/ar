/**
 * Retained nonqualified original attempt: an archival retention disposition for
 * a stopped original attempt whose terminal result is absent or genuinely
 * FAILED. It records custody of the exact bytes and nothing else. It is not a
 * source approval, DONE result, no-output claim, past worker stop or replay
 * authority; those facts are never manufactured here.
 *
 * The ledger record carries only the small `retention` discriminator below. The
 * full evidence lives in an immutable receipt whose SHA-256 the discriminator
 * binds. Readers verify the receipt bytes; execution policy never names jobs.
 */
export const RETAINED_NONQUALIFIED_STATUS = "retained_nonqualified";

export enum RetainedNonqualifiedOriginalKind {
  ResultMissing = "original_result_missing",
  FailedCheckpoint = "original_failed_checkpoint",
}

export const RETAINED_NONQUALIFIED_RECEIPT_FILE = "retained-nonqualified-attempt.json";
export const RETAINED_NONQUALIFIED_MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
export const RETAINED_NONQUALIFIED_MAX_INVENTORY_ENTRIES = 20_000;

/**
 * Finite reviewed resource policies. A permit names one (the permit hash binds it), the
 * receipt records it with the actual payload lengths (the plan hash binds it), and every
 * sink (collection, recheck, publication, replay, admission) derives its limits from the
 * same validated policy. There is no unbounded policy, environment override or
 * caller-selected multiplier; an unknown policy is unsupported and refuses.
 *
 * `default_v1` preserves the ordinary limits. `expanded_v1` is the reviewed larger
 * envelope for a large useful-input corpus. It is a nominal schema only: the Host owns
 * the resource IO that proves a given machine can honour it.
 */
export enum RetainedNonqualifiedResourcePolicyId {
  Default = "default_v1",
  ExpandedV1 = "expanded_v1",
}

export type RetainedNonqualifiedResourceLimits = {
  readonly entries: number;
  /** Combined worktree + independently staged bytes. */
  readonly inventoryBytes: number;
  /** Any one worktree or index file. */
  readonly fileBytes: number;
  readonly lifecycleBytes: number;
  /** Tracked-only binary patch. */
  readonly patchBytes: number;
  /** Any one of the seven archival payloads. */
  readonly payloadBytes: number;
  /** All seven payloads plus the receipt. */
  readonly backupBytes: number;
  readonly receiptBytes: number;
  /** Git listings and metadata buffers. */
  readonly gitMetadataBytes: number;
};

const MIB = 1024 * 1024;
const RESOURCE_LIMITS: Readonly<Record<RetainedNonqualifiedResourcePolicyId, RetainedNonqualifiedResourceLimits>> = {
  [RetainedNonqualifiedResourcePolicyId.Default]: Object.freeze({
    entries: 20_000, inventoryBytes: 64 * MIB, fileBytes: 64 * MIB, lifecycleBytes: 64 * MIB, patchBytes: 32 * MIB,
    payloadBytes: 128 * MIB, backupBytes: 256 * MIB, receiptBytes: 8 * MIB, gitMetadataBytes: 16 * MIB,
  }),
  [RetainedNonqualifiedResourcePolicyId.ExpandedV1]: Object.freeze({
    entries: 20_000, inventoryBytes: 384 * MIB, fileBytes: 128 * MIB, lifecycleBytes: 64 * MIB, patchBytes: 32 * MIB,
    payloadBytes: 512 * MIB, backupBytes: 512 * MIB, receiptBytes: 8 * MIB, gitMetadataBytes: 16 * MIB,
  }),
};

/** Strict version dispatch: undefined for anything that is not a supported policy id. */
export function retainedNonqualifiedResourceLimits(policy: unknown): RetainedNonqualifiedResourceLimits | undefined {
  const id = [RetainedNonqualifiedResourcePolicyId.Default, RetainedNonqualifiedResourcePolicyId.ExpandedV1]
    .find((candidate) => candidate === policy);
  return id === undefined ? undefined : RESOURCE_LIMITS[id];
}

/** Limits for a validated receipt: v1 receipts keep the default semantics, v2 names its policy. */
export function retainedNonqualifiedReceiptLimits(
  receipt: { readonly schemaVersion: 1 | 2; readonly resourcePolicy?: RetainedNonqualifiedResourcePolicyId | undefined },
): RetainedNonqualifiedResourceLimits {
  const limits = receipt.schemaVersion === 2
    ? retainedNonqualifiedResourceLimits(receipt.resourcePolicy)
    : RESOURCE_LIMITS[RetainedNonqualifiedResourcePolicyId.Default];
  if (limits === undefined) throw new Error("retained_nonqualified_resource_policy_unsupported");
  return limits;
}

/**
 * Immutable archival payloads published beside the receipt. All are required: the
 * ledger reader, replay and admission each refuse a retained record when any is
 * missing. `lifecycle.tar` holds the exact original lifecycle bytes, `staged.tar`
 * the independently staged index blobs, `untracked.tar` the raw untracked and
 * explicitly retained ignored inputs.
 */
export const RETAINED_NONQUALIFIED_BACKUP_PAYLOADS = [
  "owner-intent.json", "git-status.txt", "tracked.diff", "tracked.numstat",
  "untracked.tar", "staged.tar", "lifecycle.tar",
] as const;

/** Ledger-record discriminator. Everything else is in the hash-bound receipt. */
export type RetainedNonqualifiedRetention = {
  readonly schemaVersion: 1;
  readonly kind: RetainedNonqualifiedOriginalKind;
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly sourceQualification: "not_assessed";
  readonly replayAuthorized: false;
};

export type RetainedNonqualifiedFileState =
  | { readonly state: "absent"; readonly path: string }
  | { readonly state: "present"; readonly path: string; readonly sha256: string; readonly size: number; readonly mode: number };

/** Original lifecycle and job-metadata files whose exact bytes are archived in lifecycle.tar. */
export const RETAINED_NONQUALIFIED_LIFECYCLE_ROLES = [
  "result", "progress", "events", "stopEvent", "accountReservation", "manifest", "log", "prompt",
] as const;
export type RetainedNonqualifiedLifecycleRole = typeof RETAINED_NONQUALIFIED_LIFECYCLE_ROLES[number];

export type RetainedNonqualifiedInventoryEntry = {
  readonly path: string;
  /** Two-character `git status --porcelain=v1` code, so index-only changes are bound too. */
  readonly status: string;
  readonly layer: "tracked" | "untracked" | "ignored";
  /** Stage-zero index entry (git mode string and object id); absent when the path is not in the index. */
  readonly index?: { readonly mode: string; readonly oid: string };
  readonly kind: "file" | "symlink" | "deleted";
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
};

export type RetainedNonqualifiedReceipt = {
  /**
   * 1: ordinary default limits, no recorded policy or payload lengths (preserved semantics).
   * 2: names its resource policy and records every archival payload's actual length.
   */
  readonly schemaVersion: 1 | 2;
  readonly resourcePolicy?: RetainedNonqualifiedResourcePolicyId;
  readonly payloadLengths?: Readonly<Record<typeof RETAINED_NONQUALIFIED_BACKUP_PAYLOADS[number], number>>;
  readonly operation: "retain_nonqualified_attempt";
  readonly kind: RetainedNonqualifiedOriginalKind;
  readonly sourceQualification: "not_assessed";
  readonly replayAuthorized: false;
  readonly permitSha256: string;
  readonly projectId: string;
  readonly controllerJobId: string;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspace: string;
  readonly headCommit: string;
  readonly controllerManifestSha256: string;
  readonly workerManifestSha256: string;
  readonly original: {
    /** `failed` only for original_failed_checkpoint; absent for missing result. */
    readonly resultStatus?: "failed";
  } & { readonly [Role in RetainedNonqualifiedLifecycleRole]: RetainedNonqualifiedFileState };
  /** Ignored files: exact retained inputs and the dependency/cache entries classified disposable. */
  readonly ignored: { readonly retain: readonly string[]; readonly disposableListing: readonly string[] };
  readonly inventory: {
    readonly digest: string;
    readonly totalBytes: number;
    readonly entries: readonly RetainedNonqualifiedInventoryEntry[];
  };
  /** File name inside the receipt's directory to SHA-256 of the backup bytes. */
  readonly backupFiles: Readonly<Record<string, string>>;
  readonly retainedAt: string;
};

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}

function isKind(value: unknown): value is RetainedNonqualifiedOriginalKind {
  return value === RetainedNonqualifiedOriginalKind.ResultMissing ||
    value === RetainedNonqualifiedOriginalKind.FailedCheckpoint;
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0") &&
    !value.split("/").includes("..") && !value.split("/").includes(".");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}

/** Validate the ledger discriminator. Returns structural problems, empty if valid. */
export function retainedNonqualifiedRetentionProblems(value: unknown): readonly string[] {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "kind", "receiptPath", "receiptSha256",
    "sourceQualification", "replayAuthorized"])) return ["retention discriminator has an invalid shape"];
  const problems: string[] = [];
  if (value.schemaVersion !== 1) problems.push("retention requires schemaVersion=1");
  if (!isKind(value.kind)) problems.push("retention kind is invalid");
  if (!absolute(value.receiptPath)) problems.push("retention receiptPath must be a normalized absolute path");
  if (typeof value.receiptSha256 !== "string" || !HASH.test(value.receiptSha256)) {
    problems.push("retention receiptSha256 is invalid");
  }
  if (value.sourceQualification !== "not_assessed") problems.push("retention requires sourceQualification=not_assessed");
  if (value.replayAuthorized !== false) problems.push("retention requires replayAuthorized=false");
  return problems;
}

function fileStateProblem(value: unknown, label: string): string | undefined {
  if (!isRecord(value) || !absolute(value.path)) return `${label} state is invalid`;
  if (value.state === "absent") return exactKeys(value, ["state", "path"]) ? undefined : `${label} state is invalid`;
  if (value.state === "present" && exactKeys(value, ["state", "path", "sha256", "size", "mode"]) &&
    typeof value.sha256 === "string" && HASH.test(value.sha256) &&
    Number.isSafeInteger(value.size) && (value.size as number) >= 0 &&
    Number.isSafeInteger(value.mode) && (value.mode as number) >= 0 && (value.mode as number) <= 0o777) return undefined;
  return `${label} state is invalid`;
}

/** Validate full receipt bytes' parsed value. Returns structural problems. */
export function retainedNonqualifiedReceiptProblems(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["receipt must be an object"];
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return ["receipt schemaVersion is unsupported"];
  const keys = ["schemaVersion", "operation", "kind", "sourceQualification", "replayAuthorized", "permitSha256",
    "projectId", "controllerJobId", "workerJobId", "taskId", "workspace", "headCommit", "controllerManifestSha256",
    "workerManifestSha256", "original", "ignored", "inventory", "backupFiles", "retainedAt",
    ...(value.schemaVersion === 2 ? ["resourcePolicy", "payloadLengths"] : [])];
  if (!exactKeys(value, keys)) return ["receipt has an invalid shape"];
  const problems: string[] = [];
  // One validated policy bounds every list, size and length below; an unsupported policy refuses outright.
  const limits = value.schemaVersion === 2
    ? retainedNonqualifiedResourceLimits(value.resourcePolicy)
    : retainedNonqualifiedResourceLimits(RetainedNonqualifiedResourcePolicyId.Default);
  if (limits === undefined) return ["receipt resourcePolicy is unsupported"];
  if (value.operation !== "retain_nonqualified_attempt") problems.push("receipt identity is invalid");
  if (!isKind(value.kind)) problems.push("receipt kind is invalid");
  if (value.sourceQualification !== "not_assessed") problems.push("receipt requires sourceQualification=not_assessed");
  if (value.replayAuthorized !== false) problems.push("receipt requires replayAuthorized=false");
  for (const key of ["permitSha256", "controllerManifestSha256", "workerManifestSha256"]) {
    if (typeof value[key] !== "string" || !HASH.test(value[key])) problems.push(`receipt ${key} is invalid`);
  }
  for (const key of ["projectId", "controllerJobId", "workerJobId", "taskId"]) {
    if (!nonEmpty(value[key])) problems.push(`receipt ${key} is invalid`);
  }
  if (!absolute(value.workspace)) problems.push("receipt workspace is invalid");
  if (typeof value.headCommit !== "string" || !COMMIT.test(value.headCommit)) problems.push("receipt headCommit is invalid");
  if (typeof value.retainedAt !== "string" || Number.isNaN(Date.parse(value.retainedAt))) problems.push("receipt retainedAt is invalid");
  const original = value.original;
  const originalKeys: readonly string[] = [...RETAINED_NONQUALIFIED_LIFECYCLE_ROLES, "resultStatus"];
  if (!isRecord(original) || !RETAINED_NONQUALIFIED_LIFECYCLE_ROLES.every(key => key in original) ||
    !Object.keys(original).every(key => originalKeys.includes(key))) {
    problems.push("receipt original lifecycle evidence is invalid");
  } else {
    for (const key of RETAINED_NONQUALIFIED_LIFECYCLE_ROLES) {
      const problem = fileStateProblem(original[key], `receipt ${key}`);
      if (problem) problems.push(problem);
    }
    const result = original.result;
    const absentResult = isRecord(result) && result.state === "absent";
    // The discriminator must match the preserved facts, never be free-form.
    if (value.kind === RetainedNonqualifiedOriginalKind.ResultMissing && (!absentResult || original.resultStatus !== undefined)) {
      problems.push("original_result_missing requires an absent result and no resultStatus");
    }
    if (value.kind === RetainedNonqualifiedOriginalKind.FailedCheckpoint && (absentResult || original.resultStatus !== "failed")) {
      problems.push("original_failed_checkpoint requires a present failed result");
    }
  }
  const ignored = value.ignored;
  const relativeList = (list: unknown) => Array.isArray(list) && list.length <= limits.entries &&
    list.every(item => typeof item === "string" && item.length > 0 && !item.startsWith("/") &&
      !item.split("/").some((part, index, all) => part === ".." || part === "." || part === ".git" || (part === "" && index !== all.length - 1)));
  if (!isRecord(ignored) || !exactKeys(ignored, ["retain", "disposableListing"]) ||
    !relativeList(ignored.retain) || !relativeList(ignored.disposableListing)) problems.push("receipt ignored classification is invalid");
  const inventory = value.inventory;
  if (!isRecord(inventory) || !exactKeys(inventory, ["digest", "totalBytes", "entries"]) ||
    typeof inventory.digest !== "string" || !HASH.test(inventory.digest) ||
    !Number.isSafeInteger(inventory.totalBytes) || (inventory.totalBytes as number) < 0 ||
    (inventory.totalBytes as number) > limits.inventoryBytes ||
    !Array.isArray(inventory.entries) || inventory.entries.length > limits.entries) {
    problems.push("receipt inventory is invalid");
  } else {
    for (const entry of inventory.entries) {
      if (!isRecord(entry) || !exactKeys(entry, entry.index === undefined ? ["path", "status", "layer", "kind", "mode", "size", "sha256"]
          : ["path", "status", "layer", "kind", "mode", "size", "sha256", "index"]) ||
        typeof entry.status !== "string" || !/^[ MTADU?!]{2}$/.test(entry.status) ||
        (entry.index !== undefined && (!isRecord(entry.index) || !exactKeys(entry.index, ["mode", "oid"]) ||
          typeof entry.index.mode !== "string" || !/^(100644|100755|120000)$/.test(entry.index.mode) ||
          typeof entry.index.oid !== "string" || !COMMIT.test(entry.index.oid))) ||
        typeof entry.path !== "string" || entry.path.length === 0 || entry.path.startsWith("/") ||
        entry.path.split("/").some(part => part === ".." || part === "." || part === "" || part === ".git") ||
        (entry.layer !== "tracked" && entry.layer !== "untracked" && entry.layer !== "ignored") ||
        (entry.kind !== "file" && entry.kind !== "symlink" && entry.kind !== "deleted") ||
        !Number.isSafeInteger(entry.mode) || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0 ||
        (entry.size as number) > limits.fileBytes ||
        typeof entry.sha256 !== "string" || !HASH.test(entry.sha256)) {
        problems.push("receipt inventory entry is invalid");
        break;
      }
    }
  }
  const backup = value.backupFiles;
  if (!isRecord(backup) || !exactKeys(backup, RETAINED_NONQUALIFIED_BACKUP_PAYLOADS) ||
    !Object.entries(backup).every(([name, hash]) => name.length > 0 && !name.includes("/") && typeof hash === "string" && HASH.test(hash))) {
    problems.push("receipt backupFiles is invalid");
  }
  if (value.schemaVersion === 2) {
    // Actual payload lengths: each within the single-payload cap and, with the maximum receipt, within the backup budget.
    const lengths = value.payloadLengths;
    if (!isRecord(lengths) || !exactKeys(lengths, RETAINED_NONQUALIFIED_BACKUP_PAYLOADS) ||
      !Object.values(lengths).every(length => Number.isSafeInteger(length) && (length as number) >= 0 && (length as number) <= limits.payloadBytes) ||
      Object.values(lengths).reduce<number>((sum, length) => sum + (length as number), 0) > limits.backupBytes - limits.receiptBytes) {
      problems.push("receipt payloadLengths is invalid");
    }
  }
  return problems;
}

export function assertRetainedNonqualifiedReceipt(value: unknown): RetainedNonqualifiedReceipt {
  const problems = retainedNonqualifiedReceiptProblems(value);
  if (problems.length > 0) throw new Error(`retained_nonqualified_receipt_invalid:${problems[0]}`);
  return value as RetainedNonqualifiedReceipt;
}
