// Frozen verbatim from 28a8e88d3004bb90336da7468e405ac637378286.
// Compatibility fixture: exercise the actual old reader/writer, not a schema mock.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  WorkerAccountTaskRecoveryBackend, WorkerAccountTaskRecoveryPhase,
  type WorkerAccountAcceptedResponse, type WorkerAccountCapacityStore,
  type WorkerAccountRecoveryAuthority, type WorkerAccountRecoveryKey,
  type WorkerAccountRecoveryPreparation, type WorkerAccountRecoveryTask,
  type WorkerRuntimeDemand,
} from "@vioxen/subscription-runtime/worker-core";

const fail = (): never => { throw new Error("worker_account_task_recovery_closed"); };
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const digest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

type RecoveryRecord = Readonly<{
  schemaVersion: 1; backend: WorkerAccountTaskRecoveryBackend.XiaomiMimoTokenPlan; phase: WorkerAccountTaskRecoveryPhase;
  preparation: WorkerAccountRecoveryPreparation; task: WorkerAccountRecoveryTask;
  credentialFingerprint?: string; model?: string;
  rejectedTask?: WorkerAccountRecoveryTask;
  requestSha256?: string; responseIdSha256?: string; completedResponses?: number;
}>;

/** A scoped capacity-store extension. A consumed task has no TTL or takeover. */
export class LocalWorkerAccountTaskRecovery {
  constructor(private readonly input: Readonly<{
    rootDir: string;
    prepare(demand: WorkerRuntimeDemand, now: Date): WorkerAccountRecoveryPreparation | undefined;
    assertPreparation(preparation: WorkerAccountRecoveryPreparation): void;
    withMutation<T>(effect: () => T): T;
    scopedStore(assertLegacy: () => void): WorkerAccountCapacityStore;
  }>) {}

  prepare(demand: WorkerRuntimeDemand, now = new Date()): WorkerAccountRecoveryPreparation | undefined {
    return this.input.prepare(demand, now);
  }

  /** Create may prepare a birth, but an unresolved consumed task cannot birth a peer. */
  prepareAdmission(demand: WorkerRuntimeDemand, now = new Date()): WorkerAccountRecoveryPreparation | undefined {
    const preparation = this.prepare(demand, now);
    if (preparation) {
      const record = this.read(preparation);
      if (record && record.phase !== WorkerAccountTaskRecoveryPhase.Exempted) fail();
    }
    return preparation;
  }

  /** Must be entered from the original native owner before any task/provider work. */
  consume(preparation: WorkerAccountRecoveryPreparation, task: WorkerAccountRecoveryTask, assertOwner: () => void) {
    if (!task.jobId || !task.startId || !task.workerId ||
        ![task.specSha256, task.requestSha256, task.runtimeArtifactSha256].every(digest)) fail();
    let previousExemption = false, key: WorkerAccountRecoveryKey | undefined;
    this.input.withMutation(() => {
      assertOwner(); this.input.assertPreparation(preparation);
      const previous = this.read(preparation);
      if (previous?.phase === WorkerAccountTaskRecoveryPhase.Exempted) previousExemption = true;
      else {
        if (previous) fail();
        this.write({ schemaVersion: 1, backend: WorkerAccountTaskRecoveryBackend.XiaomiMimoTokenPlan, phase: WorkerAccountTaskRecoveryPhase.Consumed, preparation, task }, true);
      }
    });
    const current = (): RecoveryRecord => {
      assertOwner(); this.input.assertPreparation(preparation);
      const record = this.read(preparation);
      if (!record || (previousExemption ? record.phase !== WorkerAccountTaskRecoveryPhase.Exempted :
        record.phase !== WorkerAccountTaskRecoveryPhase.Consumed || !equal(record.task, task))) return fail();
      if (key && (record.credentialFingerprint !== key.credentialFingerprint || record.model !== key.model)) return fail();
      key?.assertCurrent(); return record;
    };
    const failed = (): void => {
      this.input.withMutation(() => {
        const record = this.read(preparation);
        if (record && (previousExemption ? record.phase === WorkerAccountTaskRecoveryPhase.Exempted :
          record.phase === WorkerAccountTaskRecoveryPhase.Consumed && equal(record.task, task)))
          this.write({ ...record, phase: WorkerAccountTaskRecoveryPhase.Failed, rejectedTask: task });
      });
    };
    return Object.freeze({
      store: this.input.scopedStore(() => { if (!key) fail(); current(); }),
      bindCredential: async (credential: Readonly<{ credentialFingerprint: string; requestedModel: string; assertCurrent(): void }>): Promise<() => void> => {
        if (key || !digest(credential.credentialFingerprint) || credential.requestedModel !== preparation.demand.model) fail();
        this.input.withMutation(() => {
          credential.assertCurrent(); const record = current();
          if (previousExemption && (record.credentialFingerprint !== credential.credentialFingerprint || record.model !== credential.requestedModel)) fail();
          if (!previousExemption) this.write({ ...record, credentialFingerprint: credential.credentialFingerprint, model: credential.requestedModel });
          key = { backend: WorkerAccountTaskRecoveryBackend.XiaomiMimoTokenPlan, credentialFingerprint: credential.credentialFingerprint,
            model: credential.requestedModel, demand: preparation.demand, assertCurrent: () => credential.assertCurrent() };
          current();
        });
        return () => { current(); };
      },
      accepted: (response: WorkerAccountAcceptedResponse | undefined): void => {
        if (previousExemption) {
          try {
            current();
            if (!response || !key || response.credentialFingerprint !== key.credentialFingerprint || response.requestedModel !== key.model) fail();
            response!.assertCurrent(); response!.assertDisposed(); current();
          } catch (error) { failed(); throw error; }
          return;
        }
        this.input.withMutation(() => {
          const record = current();
          if (!response) return fail();
          if (!key || response.credentialFingerprint !== key.credentialFingerprint || response.requestedModel !== key.model ||
              !digest(response.requestSha256) || !digest(response.responseIdSha256) || !Number.isSafeInteger(response.completedResponses) || response.completedResponses < 1) fail();
          response.assertCurrent(); response.assertDisposed(); current();
          this.write({ ...record, phase: WorkerAccountTaskRecoveryPhase.Accepted, requestSha256: response.requestSha256,
            responseIdSha256: response.responseIdSha256, completedResponses: response.completedResponses });
        });
      },
      failed,
    });
  }

  /** Existing native terminal finalizer supplies physical closure under its fences. */
  async settle(authority: WorkerAccountRecoveryAuthority, demand: WorkerRuntimeDemand): Promise<void> {
    const preparation = this.prepare(demand);
    if (!preparation) return;
    const record = this.read(preparation);
    if (!record || !equal(record.task, authority.task) || record.phase !== WorkerAccountTaskRecoveryPhase.Accepted) return;
    await authority.withPublication(async () => {
      authority.assertCurrent(); authority.assertTerminal();
      this.input.withMutation(() => {
        authority.assertCurrent(); authority.assertTerminal(); this.input.assertPreparation(preparation);
        if (!equal(this.read(preparation), record) || !record.credentialFingerprint || !record.model || !record.responseIdSha256) fail();
        this.write({ ...record, phase: WorkerAccountTaskRecoveryPhase.Exempted });
        authority.assertTerminal();
      });
    });
  }

  private path(preparation: WorkerAccountRecoveryPreparation): string {
    return join(this.input.rootDir, "original-task-recovery", sha(`${preparation.recordId}\0${preparation.revision}\0${preparation.recordSha256}`) + ".json");
  }

  private read(preparation: WorkerAccountRecoveryPreparation): RecoveryRecord | undefined {
    const path = this.path(preparation);
    let parent: number;
    try { parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const identity = fstatSync(parent);
    if (identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0) { closeSync(parent); return fail(); }
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { closeSync(parent); if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > 16 * 1024 ||
          (before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()) fail();
      const bytes = Buffer.alloc(16 * 1024 + 1);
      let count = 0, read: number;
      while (count < bytes.length && (read = readSync(fd, bytes, count, bytes.length - count, count)) > 0) count += read;
      const after = fstatSync(fd), named = lstatSync(path);
      if (count !== before.size || count > 16 * 1024 ||
          !(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"] as const).every(k => before[k] === after[k] && before[k] === named[k])) fail();
      const value: RecoveryRecord = JSON.parse(bytes.subarray(0, count).toString("utf8"));
      if (value.schemaVersion !== 1 || value.backend !== WorkerAccountTaskRecoveryBackend.XiaomiMimoTokenPlan || !Object.values(WorkerAccountTaskRecoveryPhase).includes(value.phase) ||
          !equal(value.preparation, preparation) || !value.task?.jobId || !value.task.startId || !value.task.workerId ||
          ![value.task.specSha256, value.task.requestSha256, value.task.runtimeArtifactSha256].every(digest) ||
          (value.credentialFingerprint !== undefined && !digest(value.credentialFingerprint)) ||
          [WorkerAccountTaskRecoveryPhase.Accepted, WorkerAccountTaskRecoveryPhase.Exempted].includes(value.phase) &&
            (!value.credentialFingerprint || !value.model || !value.requestSha256 || !digest(value.requestSha256) ||
             !value.responseIdSha256 || !digest(value.responseIdSha256) || !Number.isSafeInteger(value.completedResponses) || value.completedResponses! < 1)) fail();
      const afterParent = fstatSync(parent), namedParent = lstatSync(dirname(path));
      if (!(["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"] as const)
        .every(k => identity[k] === afterParent[k] && identity[k] === namedParent[k])) fail();
      return value;
    } finally { closeSync(fd); closeSync(parent); }
  }

  private write(record: RecoveryRecord, exclusive = false): void {
    const path = this.path(record.preparation), directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identity = lstatSync(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0) fail();
    const temp = exclusive ? path : path + "." + randomUUID() + ".tmp";
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (!exclusive) renameSync(temp, path); }
    finally { if (!exclusive) { try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
