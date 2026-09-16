import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  type ConsumedOutputLedgerEpochEvidenceBinding,
} from "@vioxen/subscription-runtime/worker-core";

const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;

export async function canonicalLedgerEpochRoots(
  roots: readonly string[],
): Promise<readonly string[]> {
  return await Promise.all(roots.map(async (root) => {
    try {
      return await realpath(root);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return resolve(root);
      throw error;
    }
  }));
}

export async function scanLedgerEpochRoot(root: string): Promise<readonly {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}[]> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("ledger_epoch_old_root_invalid");
  }
  const files: { path: string; size: number; sha256: string }[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (directory === root &&
        entry.name === CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER) continue;
      if (directory === root && entry.name === ".mutation-locks") {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error("ledger_epoch_protected_namespace_invalid");
        }
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("ledger_epoch_symlink_denied");
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) throw new Error("ledger_epoch_non_regular_file_denied");
      const bytes = await readHardenedEvidenceFile(path);
      files.push({
        path,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function restrictedLedgerEpochEvidenceSource(input: {
  readonly roots: readonly string[];
  readonly canonicalRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly canonicalDeniedRoots: readonly string[];
}) {
  const lexicallyAllowed = (path: string) =>
    input.roots.some((root) => pathInsideOrEqual(path, root)) &&
    !input.deniedRoots.some((root) => pathInsideOrEqual(path, root));
  const canonicallyAllowed = (path: string) =>
    input.canonicalRoots.some((root) => pathInsideOrEqual(path, root)) &&
    !input.canonicalDeniedRoots.some((root) => pathInsideOrEqual(path, root));
  const hardenedFile = async (path: string): Promise<Buffer | undefined> => {
    if (!lexicallyAllowed(path)) return undefined;
    try {
      const canonical = await realpath(path);
      if (!canonicallyAllowed(canonical)) return undefined;
      return await readHardenedEvidenceFile(path);
    } catch {
      return undefined;
    }
  };
  return {
    async pathExists(path: string): Promise<boolean> {
      return lexicallyAllowed(path) && (await hardenedFile(path)) !== undefined;
    },
    async pathSize(path: string): Promise<number | undefined> {
      return lexicallyAllowed(path) ? (await hardenedFile(path))?.length : undefined;
    },
    async pathSha256(path: string): Promise<string | undefined> {
      if (!lexicallyAllowed(path)) return undefined;
      const bytes = await hardenedFile(path);
      return bytes
        ? createHash("sha256").update(bytes).digest("hex")
        : undefined;
    },
    async resolveWorkspacePath(path: string): Promise<string | undefined> {
      if (!lexicallyAllowed(path)) return undefined;
      try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
        const canonical = await realpath(path);
        return canonicallyAllowed(canonical) ? canonical : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export function terminalLedgerEpochEvidencePaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const paths: string[] = [];
  const backup = isRecord(value.backup) ? value.backup : undefined;
  for (const candidate of [
    backup?.workspace,
    backup?.statusPath,
    backup?.patchPath,
    backup?.numstatPath,
    backup?.untrackedArchivePath,
    value.archivePath,
    isRecord(value.preexistingWorkspacePatch)
      ? value.preexistingWorkspacePatch.path
      : undefined,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) paths.push(candidate);
  }
  return paths;
}

export async function bindLedgerEpochEvidencePath(input: {
  readonly declaredPath: string;
  readonly roots: readonly string[];
  readonly canonicalRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly canonicalDeniedRoots: readonly string[];
}): Promise<ConsumedOutputLedgerEpochEvidenceBinding> {
  const resolved = resolve(input.declaredPath);
  if (input.deniedRoots.some((root) => pathInsideOrEqual(resolved, root))) {
    return { declaredPath: input.declaredPath, state: "denied" };
  }
  if (!input.roots.some((root) => pathInsideOrEqual(resolved, root))) {
    try {
      return {
        declaredPath: input.declaredPath,
        state: "denied",
        canonicalPath: await realpath(resolved),
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { declaredPath: input.declaredPath, state: "denied" };
      }
      throw error;
    }
  }
  try {
    const metadata = await lstat(resolved);
    if (metadata.isSymbolicLink()) {
      return { declaredPath: input.declaredPath, state: "symlink" };
    }
    const canonicalPath = await realpath(resolved);
    if (input.canonicalDeniedRoots.some((root) =>
      pathInsideOrEqual(canonicalPath, root)
    ) || !input.canonicalRoots.some((root) =>
      pathInsideOrEqual(canonicalPath, root)
    )) return { declaredPath: input.declaredPath, state: "denied", canonicalPath };
    if (metadata.isDirectory()) {
      return { declaredPath: input.declaredPath, state: "directory", canonicalPath };
    }
    if (!metadata.isFile()) return { declaredPath: input.declaredPath, state: "denied" };
    const bytes = await readHardenedEvidenceFile(resolved);
    return {
      declaredPath: input.declaredPath,
      state: "file",
      canonicalPath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { declaredPath: input.declaredPath, state: "missing" };
    }
    throw error;
  }
}

export async function assertLedgerEpochEvidenceBindingsUnchanged(
  expected: readonly ConsumedOutputLedgerEpochEvidenceBinding[],
): Promise<void> {
  for (const binding of expected) {
    if (binding.state === "denied") {
      if (binding.canonicalPath === undefined) continue;
      let canonicalPath: string | undefined;
      try {
        canonicalPath = await realpath(binding.declaredPath);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      if (canonicalPath !== binding.canonicalPath) {
        throw new Error("ledger_epoch_evidence_binding_drift");
      }
      continue;
    }
    let current: ConsumedOutputLedgerEpochEvidenceBinding;
    try {
      const metadata = await lstat(binding.declaredPath);
      if (metadata.isSymbolicLink()) {
        current = { declaredPath: binding.declaredPath, state: "symlink" };
      } else if (metadata.isDirectory()) {
        current = {
          declaredPath: binding.declaredPath,
          state: "directory",
          canonicalPath: await realpath(binding.declaredPath),
        };
      } else if (metadata.isFile()) {
        const bytes = await readHardenedEvidenceFile(binding.declaredPath);
        current = {
          declaredPath: binding.declaredPath,
          state: "file",
          canonicalPath: await realpath(binding.declaredPath),
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } else {
        current = { declaredPath: binding.declaredPath, state: "denied" };
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      current = { declaredPath: binding.declaredPath, state: "missing" };
    }
    if (JSON.stringify(current) !== JSON.stringify(binding)) {
      throw new Error("ledger_epoch_evidence_binding_drift");
    }
  }
}

async function readHardenedEvidenceFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("ledger_epoch_non_regular_file_denied");
    if (metadata.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error("ledger_epoch_file_too_large");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function pathInsideOrEqual(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
