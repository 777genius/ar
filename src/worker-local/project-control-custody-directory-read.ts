import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

/** A negative read binding, never a writer/admission capability. */
export type EvidenceReadDirectoryIdentity = Readonly<{ canonicalPath: string; dev: number; ino: number }>;
export function assertExpectedReadPath(path: string, expected?: EvidenceReadDirectoryIdentity): void {
  if (expected && (resolve(expected.canonicalPath) !== expected.canonicalPath || !expected.canonicalPath.startsWith("/") ||
      !Number.isSafeInteger(expected.dev) || expected.dev < 0 || !Number.isSafeInteger(expected.ino) || expected.ino < 1 ||
      path !== expected.canonicalPath && !(expected.canonicalPath === "/" || path.startsWith(expected.canonicalPath + "/"))))
    throw new Error("evidence_custody_read_outside_directory");
}
export function assertExpectedReadDirectory(path: string, stat: Awaited<ReturnType<FileHandle["stat"]>>,
  expected?: EvidenceReadDirectoryIdentity): void {
  if (expected && path === expected.canonicalPath && (stat.dev !== expected.dev || stat.ino !== expected.ino))
    throw new Error("evidence_custody_read_directory_identity_changed");
}


export async function openAbsoluteDirectoryNoSymlinks(path: string, expected?: EvidenceReadDirectoryIdentity) {
  const lexical = resolve(path);
  assertExpectedReadPath(lexical, expected);
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    assertExpectedReadDirectory("/", await handle.stat(), expected);
    const segments = lexical.split("/").filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      safeSegment(segment);
      let next;
      try {
        next = await open(`/proc/self/fd/${handle.fd}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (index === segments.length - 1) {
          throw custodyError("evidence_custody_root_noncanonical", error);
        }
        throw error;
      }
      await handle.close();
      handle = next;
      assertExpectedReadDirectory("/" + segments.slice(0, index + 1).join("/"), await handle.stat(), expected);
    }
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_root_noncanonical");
    }
    return handle;
  } catch (error) {
    await handle.close();
    if (error instanceof Error &&
      error.message === "evidence_custody_root_noncanonical") throw error;
    throw custodyError("evidence_custody_ancestor_unsafe", error);
  }
}


export async function assertHeldRootLexicalBinding(
  lexical: string,
  handle: FileHandle,
  identity: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<void> {
  let reopened: FileHandle | undefined;
  try {
    const current = await handle.stat();
    if (current.dev !== identity.dev || current.ino !== identity.ino ||
      await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_publication_root_drift");
    }
    reopened = await openAbsoluteDirectoryNoSymlinks(lexical);
    const lexicalCurrent = await reopened.stat();
    if (lexicalCurrent.dev !== identity.dev || lexicalCurrent.ino !== identity.ino) {
      throw new Error("evidence_custody_publication_root_drift");
    }
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_publication_root_drift");
    }
  } catch (error) {
    if (error instanceof Error &&
      error.message === "evidence_custody_publication_root_drift") throw error;
    throw new Error("evidence_custody_publication_root_drift", { cause: error });
  } finally {
    await reopened?.close();
  }
}


export function safeSegment(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") ||
    value.includes("\\")) throw new Error("evidence_custody_path_invalid");
}
export function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}
export function deepCode(error: unknown): string | undefined {
  const direct = code(error);
  if (direct) return direct;
  return error instanceof Error && error.cause !== undefined
    ? deepCode(error.cause)
    : undefined;
}
export function custodyError(message: string, cause: unknown): Error & { code?: string } {
  const error: Error & { code?: string } = new Error(message, { cause });
  const causeCode = deepCode(cause);
  if (causeCode !== undefined) error.code = causeCode;
  return error;
}
