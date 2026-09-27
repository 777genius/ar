import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ManagedRunInputRequest,
  ManagedRunRecord,
  ManagedRunRecoveryPacket,
  ManagedRunResumeHandle,
  ManagedRunStorePort,
  ProviderFailure,
  RedactorPort,
} from "@vioxen/subscription-runtime/core";
import { assertManagedRunIdentifiersSafe, redactManagedRunValue } from "./file-backend-codex-managed-run-redaction";

export class LocalFileManagedRunStore implements ManagedRunStorePort {
  constructor(private readonly rootDir: string, private readonly redactor: RedactorPort) {}

  async get(input: { readonly runId: string }): Promise<ManagedRunRecord | null> {
    const raw = await readFile(this.recordPath(input.runId), "utf8").catch(
      (error: unknown) => {
        if (isNodeErrorCode(error, "ENOENT")) return null;
        throw error;
      },
    );
    if (raw === null) return null;
    const record = parseManagedRunRecord(JSON.parse(raw));
    assertManagedRunIdentifiersSafe(record, this.redactor);
    return redactManagedRunValue(record, this.redactor);
  }

  async saveWaitingInput(input: {
    readonly runId: string;
    readonly request: ManagedRunInputRequest;
    readonly resumeHandle: ManagedRunResumeHandle;
    readonly recoveryPacket?: ManagedRunRecoveryPacket;
    readonly taskId?: string;
    readonly assignedWorkerId?: string;
    readonly providerInstanceId?: string;
    readonly workspacePath?: string;
    readonly outputText?: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    const recoveryPacket = input.recoveryPacket ?? current?.recoveryPacket;
    const taskId = input.taskId ?? current?.taskId;
    const assignedWorkerId = input.assignedWorkerId ?? current?.assignedWorkerId;
    const providerInstanceId =
      input.providerInstanceId ?? current?.providerInstanceId;
    const workspacePath = input.workspacePath ?? current?.workspacePath;
    const outputText = input.outputText ?? current?.outputText;
    const record: ManagedRunRecord = {
      runId: input.runId,
      status: "waiting_for_input",
      request: input.request,
      resumeHandle: input.resumeHandle,
      ...(recoveryPacket === undefined ? {} : { recoveryPacket }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(assignedWorkerId === undefined ? {} : { assignedWorkerId }),
      ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(outputText === undefined ? {} : { outputText }),
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  async resume(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly answer: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    if (
      !current ||
      current.status !== "waiting_for_input" ||
      current.request?.id !== input.requestId
    ) {
      throw new Error("managed_run_request_mismatch");
    }
    const {
      request: _request,
      ...currentWithoutRequest
    } = current;
    const record: ManagedRunRecord = {
      ...currentWithoutRequest,
      status: "active",
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  async complete(input: {
    readonly runId: string;
    readonly outputText: string;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "completed",
      outputText: input.outputText,
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  async fail(input: {
    readonly runId: string;
    readonly failure: ProviderFailure;
    readonly now: Date;
  }): Promise<ManagedRunRecord> {
    const current = await this.get({ runId: input.runId });
    const record: ManagedRunRecord = {
      ...(current ?? { runId: input.runId }),
      runId: input.runId,
      status: "failed",
      failure: input.failure,
      updatedAt: input.now,
    };
    await this.writeRecord(record);
    return record;
  }

  private recordPath(runId: string): string {
    return join(this.rootDir, `${hashText(runId)}.json`);
  }

  private async writeRecord(record: ManagedRunRecord): Promise<void> {
    assertManagedRunIdentifiersSafe(record, this.redactor);
    const safeRecord = redactManagedRunValue(record, this.redactor);
    const path = this.recordPath(record.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(safeRecord, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tempPath, path);
  }
}


function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function parseManagedRunRecord(value: unknown): ManagedRunRecord {
  if (!value || typeof value !== "object") {
    throw new Error("managed_run_record_invalid");
  }
  const record = value as ManagedRunRecord & { readonly updatedAt: unknown };
  if (typeof record.runId !== "string") {
    throw new Error("managed_run_record_run_id_invalid");
  }
  if (typeof record.status !== "string") {
    throw new Error("managed_run_record_status_invalid");
  }
  return {
    ...record,
    updatedAt: new Date(String(record.updatedAt)),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
