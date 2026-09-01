import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { ProjectPreStartArtifactSnapshot } from "./codex-goal-project-pre-start-binding";

type JsonObject = Readonly<Record<string, unknown>>;

export async function readJsonObject(
  path: string,
  label: string,
  maxBytes: number,
): Promise<JsonObject> {
  try {
    const value: unknown = JSON.parse(
      await readBoundedFile(path, maxBytes, label),
    );
    if (!isObject(value)) throw new Error("not_object");
    return value;
  } catch {
    throw new Error(`project_control_pre_start_${label}_invalid`);
  }
}

export type JsonObjectSnapshot = {
  readonly value: JsonObject;
  readonly bytes: Uint8Array;
};

export async function readJsonObjectSnapshot(
  path: string,
  label: string,
  maxBytes: number,
): Promise<JsonObjectSnapshot> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) throw new Error("size_limit_exceeded");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value)) throw new Error("not_object");
    return { value, bytes };
  } catch {
    throw new Error(`project_control_pre_start_${label}_invalid`);
  }
}

export function artifactSnapshot(
  contract: JsonObjectSnapshot,
  state: JsonObjectSnapshot,
): ProjectPreStartArtifactSnapshot {
  return { contractBytes: contract.bytes, stateBytes: state.bytes };
}

export async function writeJsonArtifact(
  path: string,
  value: JsonObject,
  maxBytes: number,
): Promise<boolean> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readBoundedFile(path, maxBytes, "artifact");
    if (existing !== body) {
      throw new Error("project_control_pre_start_existing_artifact_mismatch");
    }
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "project_control_pre_start_existing_artifact_mismatch"
    ) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  }
}

export async function writeJsonAtomically(
  path: string,
  value: JsonObject,
): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertSerializedSize(
  label: string,
  value: JsonObject,
  maxBytes: number,
): void {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
  } catch {
    throw new Error(`project_control_pre_start_${label}_not_serializable`);
  }
  if (bytes > maxBytes) {
    throw new Error(`project_control_pre_start_${label}_size_limit_exceeded`);
  }
}

export async function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`project_control_pre_start_${label}_size_limit_exceeded`);
  }
  return bytes.toString("utf8");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
