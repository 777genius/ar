import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { isPersistableWorkerAccountAvailability, normalizeWorkerAccountCapacitySignal, normalizeWorkerAccountId, shouldKeepExistingWorkerAccountCapacity, } from "@777genius/subscription-runtime/worker-core";
const storageVersion = "local-file-worker-account-capacity-v1";
export class LocalFileWorkerAccountCapacityStore {
    options;
    constructor(options) {
        this.options = options;
    }
    read(input) {
        const accountId = normalizeWorkerAccountId(input.accountId);
        if (!accountId)
            return null;
        const record = this.readRecord(accountId);
        if (!record)
            return null;
        if (record.accountId !== accountId) {
            this.clear({ accountId });
            return null;
        }
        const capacity = parsePersistedCapacity(record.capacity);
        if (!capacity) {
            this.clear({ accountId });
            return null;
        }
        const now = input.now ?? new Date();
        if (capacity.cooldownUntil &&
            capacity.cooldownUntil.getTime() <= now.getTime()) {
            this.clear({ accountId });
            return null;
        }
        return capacity;
    }
    observe(input) {
        const accountId = normalizeWorkerAccountId(input.accountId);
        if (!accountId)
            return;
        const capacity = normalizeWorkerAccountCapacitySignal(input);
        if (!capacity)
            return;
        const existing = this.read({
            accountId,
            now: input.observedAt,
        });
        if (existing &&
            shouldKeepExistingWorkerAccountCapacity(existing, capacity)) {
            return;
        }
        this.writeRecord({
            storageVersion,
            accountId,
            capacity: persistCapacity(capacity),
            updatedAt: input.observedAt.toISOString(),
        });
    }
    clear(input) {
        const accountId = normalizeWorkerAccountId(input.accountId);
        if (!accountId)
            return;
        rmSync(this.recordPath(accountId), { force: true });
    }
    readRecord(accountId) {
        const path = this.recordPath(accountId);
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(path, "utf8"));
        }
        catch (error) {
            if (isNodeError(error) && error.code === "ENOENT")
                return null;
            if (error instanceof SyntaxError) {
                rmSync(path, { force: true });
                return null;
            }
            throw error;
        }
        if (!isRecord(parsed) ||
            parsed.storageVersion !== storageVersion ||
            typeof parsed.accountId !== "string" ||
            !isRecord(parsed.capacity) ||
            typeof parsed.updatedAt !== "string") {
            rmSync(path, { force: true });
            return null;
        }
        return parsed;
    }
    writeRecord(record) {
        const path = this.recordPath(record.accountId);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const tempPath = join(dirname(path), `${randomUUID()}.tmp`);
        try {
            writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
                mode: 0o600,
            });
            renameSync(tempPath, path);
        }
        catch (error) {
            rmSync(tempPath, { force: true });
            throw error;
        }
    }
    recordPath(accountId) {
        return join(this.options.rootDir, "account-capacity", hashText(accountId));
    }
}
function persistCapacity(capacity) {
    return {
        availability: capacity.availability,
        ...(capacity.reason ? { reason: capacity.reason } : {}),
        ...(capacity.cooldownUntil
            ? { cooldownUntil: capacity.cooldownUntil.toISOString() }
            : {}),
        ...(capacity.lastLimitSignalAt
            ? { lastLimitSignalAt: capacity.lastLimitSignalAt.toISOString() }
            : {}),
        ...(capacity.details ? { details: capacity.details } : {}),
    };
}
function parsePersistedCapacity(value) {
    if (!isPersistableWorkerAccountAvailability(value.availability))
        return null;
    if (value.reason !== undefined && typeof value.reason !== "string") {
        return null;
    }
    const cooldownUntil = optionalDate(value.cooldownUntil);
    const lastLimitSignalAt = optionalDate(value.lastLimitSignalAt);
    const details = optionalStringRecord(value.details);
    if (cooldownUntil === false ||
        lastLimitSignalAt === false ||
        details === false) {
        return null;
    }
    return {
        availability: value.availability,
        ...(value.reason ? { reason: value.reason } : {}),
        ...(cooldownUntil ? { cooldownUntil } : {}),
        ...(lastLimitSignalAt ? { lastLimitSignalAt } : {}),
        ...(details ? { details } : {}),
    };
}
function optionalDate(value) {
    if (value === undefined)
        return null;
    if (typeof value !== "string")
        return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : false;
}
function optionalStringRecord(value) {
    if (value === undefined)
        return null;
    if (!isRecord(value))
        return false;
    for (const entry of Object.values(value)) {
        if (typeof entry !== "string")
            return false;
    }
    return value;
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function hashText(value) {
    return createHash("sha256").update(value).digest("hex");
}
//# sourceMappingURL=local-worker-account-capacity-store.js.map