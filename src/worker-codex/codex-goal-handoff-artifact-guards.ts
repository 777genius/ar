import { createHash } from "node:crypto";
import { basename, isAbsolute, relative } from "node:path";

export function stableHandoffJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256HandoffContent(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function uniqueSortedHandoffPaths(
  values: readonly string[],
): readonly string[] {
  return [...new Set(values)].sort();
}

export function sameHandoffPaths(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function ensureHandoffTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function handoffPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertSafeHandoffId(value: string, label: string): void {
  if (
    basename(value) !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  ) {
    throw new Error(`${label}_invalid`);
  }
}

export function assertSafeHandoffRelativePath(path: string): string {
  if (
    !path ||
    Buffer.byteLength(path) > 4096 ||
    isAbsolute(path) ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("handoff_changed_path_invalid");
  }
  return path;
}

export function isHandoffNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function isHandoffExecErrorWithStdout(
  error: unknown,
): error is { readonly code: number; readonly stdout: string } {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === 1 && "stdout" in error &&
    typeof error.stdout === "string";
}
