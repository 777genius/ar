import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  ProjectControlRecoveryOperation,
  ProjectControlRecoveryPhase,
  type ProjectControlRecoveryRecord,
  type ProjectControlRecoveryStore,
} from "@vioxen/subscription-runtime/worker-core";
import { openAbsoluteDirectoryNoSymlinks } from "./project-control-evidence-custody-materialization";

export enum RecoveryFileFaultPoint {
  BeforeAppend = "before_append",
  AfterAppend = "after_append",
  AfterSync = "after_sync",
}
export type RecoveryFileFault = (point: RecoveryFileFaultPoint, name: string) => Promise<void>;

/** Caller holds the controller's exclusive operation lock for this entire session. */
export async function openProjectControlRecoveryStore(input: {
  readonly parent: string;
  readonly taskId: string;
  readonly fault?: RecoveryFileFault;
}): Promise<ProjectControlRecoveryStore> {
  if (resolve(input.parent) !== input.parent || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.taskId)) {
    throw new Error("project_control_recovery_audit_unsafe");
  }
  // No mkdir here: neither a missing directory nor an ancestor alias is authority.
  const parent = await openAbsoluteDirectoryNoSymlinks(input.parent);
  const identity = await parent.stat();
  const files: AnchoredFile[] = [];
  const revalidateParent = async () => {
    const current = await openAbsoluteDirectoryNoSymlinks(input.parent);
    try {
      const stat = await current.stat();
      if (stat.dev !== identity.dev || stat.ino !== identity.ino ||
          await realpath(`/proc/self/fd/${parent.fd}`) !== input.parent) {
        throw new Error("project_control_recovery_audit_identity_drift");
      }
    } finally { await current.close(); }
  };
  const revalidate = async () => {
    await revalidateParent();
    for (const file of files) await file.revalidate();
    await revalidateParent();
  };
  try {
    // Validate the audit destination first; an unsafe audit must not start a journal.
    const audit = await anchoredFile(`${input.taskId}.project-control-events.jsonl`);
    const journal = await anchoredFile(`${input.taskId}.project-control-recovery.jsonl`);
    await revalidate();
    const auditStat = await audit.handle.stat();
    const journalStat = await journal.handle.stat();
    const binding = `${identity.dev}:${identity.ino}/${auditStat.dev}:${auditStat.ino}/${journalStat.dev}:${journalStat.ino}`;
    return {
      records: async () => (await journal.read()).map(value => {
        if (value.binding !== binding) throw new Error("project_control_recovery_audit_identity_drift");
        return parseRecord(value.record as Record<string, unknown>);
      }),
      save: async record => { await journal.append({ binding, record }); },
      audit: async (record, phase) => {
        const events = await audit.read();
        if (events.some(event => event.operationId === record.operationId &&
            event.type === "project_control_recovery" && event.phase === phase &&
            event.proposedScopeSha256 === record.proposedScopeSha256)) return;
        await audit.append({
          type: "project_control_recovery", operation: record.operation,
          operationId: record.operationId, phase, controllerJobId: record.controllerJobId,
          manifestSha256: record.beforeManifestSha256,
          proposedScopeSha256: record.proposedScopeSha256, at: record.at,
        });
      },
      revalidate,
      close: async () => {
        try { for (const file of files) await file.handle.close(); }
        finally { await parent.close(); }
      },
    };

    async function anchoredFile(name: string): Promise<AnchoredFile> {
      await revalidateParent();
      const path = `/proc/self/fd/${parent.fd}/${name}`;
      const handle = await open(path, constants.O_RDWR | constants.O_APPEND |
        constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const stat = await handle.stat();
      const validate = async () => {
        const linked = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const [now, entry] = await Promise.all([handle.stat(), linked.stat()]);
          if (!now.isFile() || now.nlink !== 1 || entry.nlink !== 1 ||
              now.dev !== stat.dev || now.ino !== stat.ino ||
              entry.dev !== stat.dev || entry.ino !== stat.ino ||
              await realpath(`/proc/self/fd/${handle.fd}`) !== join(input.parent, name)) {
            throw new Error("project_control_recovery_audit_unsafe");
          }
        } finally { await linked.close(); }
      };
      try { await validate(); } catch (error) { await handle.close(); throw error; }
      const read = async (): Promise<Record<string, unknown>[]> => {
        await revalidate();
        const size = (await handle.stat()).size;
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
          if (!bytesRead) throw new Error("project_control_recovery_journal_short_read");
          offset += bytesRead;
        }
        const end = bytes.lastIndexOf(10) + 1;
        // Only a torn final frame can be discarded. Complete malformed records fail closed.
        const values = bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean)
          .map(line => JSON.parse(line) as Record<string, unknown>);
        if (end !== size) {
          await revalidate();
          await handle.truncate(end);
          await handle.sync();
        }
        // A retry may see a full frame whose original fsync failed. Make it
        // durable before treating either journal intent or audit as reconciled.
        await handle.sync();
        await parent.sync();
        await revalidate();
        return values;
      };
      const file: AnchoredFile = {
        handle, revalidate: validate, read,
        append: async value => {
          await read();
          await input.fault?.(RecoveryFileFaultPoint.BeforeAppend, name);
          await revalidate();
          await handle.writeFile(`${JSON.stringify(value)}\n`);
          await input.fault?.(RecoveryFileFaultPoint.AfterAppend, name);
          await revalidate();
          await handle.sync();
          await parent.sync();
          await input.fault?.(RecoveryFileFaultPoint.AfterSync, name);
          await revalidate();
        },
      };
      files.push(file);
      await parent.sync();
      await revalidate();
      return file;
    }
  } catch (error) {
    for (const file of files) await file.handle.close().catch(() => undefined);
    await parent.close();
    throw error;
  }
}

type AnchoredFile = {
  readonly handle: FileHandle;
  readonly revalidate: () => Promise<void>;
  readonly read: () => Promise<Record<string, unknown>[]>;
  readonly append: (value: unknown) => Promise<void>;
};

function parseRecord(value: Record<string, unknown>): ProjectControlRecoveryRecord {
  if (!value || value.operation !== ProjectControlRecoveryOperation.ControllerScope ||
      !Object.values(ProjectControlRecoveryPhase).includes(value.phase as ProjectControlRecoveryPhase) ||
      typeof value.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(value.operationId) ||
      typeof value.controllerJobId !== "string" ||
      typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      ![value.beforeManifestSha256, value.afterManifestSha256, value.proposedScopeSha256]
        .every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) ||
      !Array.isArray(value.identities) || !value.identities.every(item =>
        item && typeof item.path === "string" && resolve(item.path) === item.path &&
        Number.isSafeInteger(item.device) && Number.isSafeInteger(item.inode))) {
    throw new Error("project_control_recovery_journal_invalid");
  }
  if (value.approvedAnchor !== undefined && (typeof value.approvedAnchor !== "string" ||
      resolve(value.approvedAnchor) !== value.approvedAnchor || value.approvedAnchor === "/")) {
    throw new Error("project_control_recovery_journal_invalid");
  }
  if (value.pendingDirectory !== undefined) {
    const pending = value.pendingDirectory as Record<string, unknown>;
    if (!pending || value.phase !== ProjectControlRecoveryPhase.Prepared ||
        typeof pending.path !== "string" || resolve(pending.path) !== pending.path ||
        typeof pending.stagingPath !== "string" || resolve(pending.stagingPath) !== pending.stagingPath ||
        dirname(pending.path) !== dirname(pending.stagingPath) ||
        !basename(pending.stagingPath).startsWith(`.custody-${value.operationId}-`) ||
        !Number.isSafeInteger(pending.device) || !Number.isSafeInteger(pending.inode) ||
        value.identities.some(identity => identity.path === pending.path)) {
      throw new Error("project_control_recovery_journal_invalid");
    }
  }
  return value as unknown as ProjectControlRecoveryRecord;
}
