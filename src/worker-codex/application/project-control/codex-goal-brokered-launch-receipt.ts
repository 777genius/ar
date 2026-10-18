import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AccessBoundary,
  ProjectAccessScope,
} from "@vioxen/subscription-runtime/worker-core";

/** Durable single-use proof that brokered project-control tooling admitted and issued this exact launch identity; the scope guard consumes it during admission. */
export type BrokeredLaunchReceipt = Readonly<{
  schemaVersion: 1;
  jobId: string;
  taskId: string;
  jobRootDir: string;
  promptPath: string;
  workspacePath: string;
  accessBoundary?: AccessBoundary;
  projectAccessScope: ProjectAccessScope;
  controllerJobId: string;
  issuedAt: string;
}>;

export const BROKERED_LAUNCH_RECEIPT_MAX_AGE_MS = 30 * 60_000;

const MAX_RECEIPT_BYTES = 64 * 1024;

export function brokeredLaunchReceiptPath(jobRootDir: string): string {
  return join(jobRootDir, ".brokered-launch-receipt.json");
}

export async function writeBrokeredLaunchReceipt(input: {
  readonly jobId: string;
  readonly taskId: string;
  readonly jobRootDir: string;
  readonly promptPath: string;
  readonly workspacePath: string;
  readonly accessBoundary?: AccessBoundary | undefined;
  readonly projectAccessScope: ProjectAccessScope;
  readonly controllerJobId: string;
}): Promise<void> {
  const receipt: BrokeredLaunchReceipt = {
    schemaVersion: 1,
    jobId: input.jobId,
    taskId: input.taskId,
    jobRootDir: input.jobRootDir,
    promptPath: input.promptPath,
    workspacePath: input.workspacePath,
    ...(input.accessBoundary === undefined
      ? {}
      : { accessBoundary: input.accessBoundary }),
    projectAccessScope: input.projectAccessScope,
    controllerJobId: input.controllerJobId,
    issuedAt: new Date().toISOString(),
  };
  // The broker issues the receipt before the launch paths are prepared.
  await mkdir(input.jobRootDir, { recursive: true, mode: 0o700 });
  const receiptPath = brokeredLaunchReceiptPath(input.jobRootDir);
  await writeFile(
    `${receiptPath}.tmp`,
    `${JSON.stringify(receipt)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await rename(`${receiptPath}.tmp`, receiptPath);
}

export async function consumeBrokeredLaunchReceipt(
  jobRootDir: string,
): Promise<boolean> {
  try {
    await rename(
      brokeredLaunchReceiptPath(jobRootDir),
      join(jobRootDir, ".brokered-launch-receipt.consumed.json"),
    );
    return true;
  } catch {
    return false;
  }
}

export async function readBrokeredLaunchReceipt(
  jobRootDir: string,
): Promise<BrokeredLaunchReceipt | undefined> {
  try {
    const body = await readFile(brokeredLaunchReceiptPath(jobRootDir), "utf8");
    if (Buffer.byteLength(body, "utf8") > MAX_RECEIPT_BYTES) return undefined;
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const receipt = value as Record<string, unknown>;
    if (
      receipt.schemaVersion !== 1 ||
      typeof receipt.jobId !== "string" ||
      typeof receipt.taskId !== "string" ||
      typeof receipt.jobRootDir !== "string" ||
      typeof receipt.promptPath !== "string" ||
      typeof receipt.workspacePath !== "string" ||
      typeof receipt.controllerJobId !== "string" ||
      typeof receipt.issuedAt !== "string" ||
      receipt.issuedAt.length === 0 ||
      (receipt.accessBoundary !== undefined &&
        typeof receipt.accessBoundary !== "string") ||
      typeof receipt.projectAccessScope !== "object" ||
      receipt.projectAccessScope === null
    ) {
      return undefined;
    }
    return receipt as unknown as BrokeredLaunchReceipt;
  } catch {
    return undefined;
  }
}
