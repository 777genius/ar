import { inspectRetainedTerminalArchive } from "@vioxen/subscription-runtime/worker-local";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  CONSUMED_OUTPUT_LEDGER_RETIRED_MARKER,
  type ConsumedOutputLedgerEpochEvidenceBinding,
  type ConsumedOutputLedgerEpochFilePlan,
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
  const hardenedFile = async (path: string): Promise<Awaited<ReturnType<typeof inspectRetainedTerminalArchive>> | undefined> => {
    if (!lexicallyAllowed(path)) return undefined;
    try {
      const canonical = await realpath(path);
      if (!canonicallyAllowed(canonical)) return undefined;
      return await inspectRetainedTerminalArchive(path, { expectedCanonicalPath: canonical });
    } catch (error) {
      if (isExpectedEvidencePathError(error)) return undefined;
      throw error;
    }
  };
  return {
    async pathExists(path: string): Promise<boolean> {
      return lexicallyAllowed(path) && (await hardenedFile(path)) !== undefined;
    },
    async pathSize(path: string): Promise<number | undefined> {
      return lexicallyAllowed(path) ? (await hardenedFile(path))?.size : undefined;
    },
    async pathSha256(path: string): Promise<string | undefined> {
      if (!lexicallyAllowed(path)) return undefined;
      const bytes = await hardenedFile(path);
      return bytes
        ? bytes.sha256
        : undefined;
    },
    async resolveWorkspacePath(path: string): Promise<string | undefined> {
      if (!lexicallyAllowed(path)) return undefined;
      try {
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
        const canonical = await realpath(path);
        return canonicallyAllowed(canonical) ? canonical : undefined;
      } catch (error) {
        if (isExpectedEvidencePathError(error)) return undefined;
        throw error;
      }
    },
  };
}

export function terminalLedgerEpochEvidencePaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const paths: string[] = [];
  for (const candidate of terminalLedgerEpochEvidenceCandidates(value)) {
    if (typeof candidate === "string" && candidate.trim()) paths.push(candidate);
  }
  return paths;
}

/** Declared payload paths that must resolve to regular files when migrating. */
export function terminalLedgerEpochFileEvidencePaths(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  const paths: string[] = [];
  const backup = isRecord(value.backup) ? value.backup : undefined;
  for (const candidate of [
    backup?.statusPath,
    backup?.patchPath,
    backup?.numstatPath,
    backup?.untrackedArchivePath,
    isRecord(value.preexistingWorkspacePatch)
      ? value.preexistingWorkspacePatch.path
      : undefined,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) paths.push(candidate);
  }
  return paths;
}

/** Declared custody paths that must resolve to directories when migrating. */
export function terminalLedgerEpochDirectoryEvidencePaths(
  value: unknown,
): readonly string[] {
  if (!isRecord(value)) return [];
  const backup = isRecord(value.backup) ? value.backup : undefined;
  return [backup?.workspace, value.archivePath].filter(
    (path): path is string => typeof path === "string" && Boolean(path.trim()),
  );
}

export function collectTerminalLedgerEpochEvidence(
  value: unknown,
  roots: readonly string[],
  deniedRoots: readonly string[],
): { readonly paths: readonly string[]; readonly valid: boolean } {
  if (terminalLedgerEpochEvidenceCandidates(value).some(
    (candidate) => candidate !== undefined &&
      (typeof candidate !== "string" || !candidate.trim() || candidate.includes("\0")),
  )) return { paths: [], valid: false };
  const paths = terminalLedgerEpochEvidencePaths(value);
  try {
    const valid = paths.every((path) =>
      roots.some((root) => pathInsideOrEqual(path, root)) ||
      deniedRoots.some((root) => pathInsideOrEqual(path, root))
    );
    return {
      paths: paths.filter((path) =>
        roots.some((root) => pathInsideOrEqual(path, root)) ||
        deniedRoots.some((root) => pathInsideOrEqual(path, root))
      ),
      valid,
    };
  } catch (error) {
    if (isExpectedEvidencePathError(error)) return { paths: [], valid: false };
    throw error;
  }
}

export function quarantineUnboundMigratedLedgerEpochFiles(
  files: readonly ConsumedOutputLedgerEpochFilePlan[],
  oldRoot: string,
  filePathsByFile: ReadonlyMap<string, readonly string[]>,
  directoryPathsByFile: ReadonlyMap<string, readonly string[]>,
  bindings: readonly ConsumedOutputLedgerEpochEvidenceBinding[],
): readonly ConsumedOutputLedgerEpochFilePlan[] {
  const byPath = new Map(bindings.map((binding) => [binding.declaredPath, binding]));
  return files.map((file) => {
    if (file.disposition !== "migrate") return file;
    const sourcePath = join(oldRoot, file.relativePath);
    const invalid = (filePathsByFile.get(sourcePath) ?? [])
      .some((path) => byPath.get(path)?.state !== "file") ||
      (directoryPathsByFile.get(sourcePath) ?? [])
        .some((path) => byPath.get(path)?.state !== "directory");
    return invalid
      ? { ...file, disposition: "quarantine", quarantineReason: "invalid_or_missing_evidence" as const }
      : file;
  });
}

export async function bindLedgerEpochEvidencePath(input: {
  readonly declaredPath: string;
  readonly roots: readonly string[];
  readonly canonicalRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly canonicalDeniedRoots: readonly string[];
}): Promise<ConsumedOutputLedgerEpochEvidenceBinding> {
  let resolved: string;
  try {
    resolved = resolve(input.declaredPath);
  } catch (error) {
    if (isExpectedEvidencePathError(error)) {
      return { declaredPath: input.declaredPath, state: "denied" };
    }
    throw error;
  }
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
    const evidence = await inspectRetainedTerminalArchive(resolved, { expectedCanonicalPath: canonicalPath });
    return {
      declaredPath: input.declaredPath,
      state: "file",
      canonicalPath,
      size: evidence.size,
      sha256: evidence.sha256,
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { declaredPath: input.declaredPath, state: "missing" };
    }
    if (isExpectedEvidencePathError(error)) {
      return { declaredPath: input.declaredPath, state: "denied" };
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
        const evidence = await inspectRetainedTerminalArchive(binding.declaredPath, {
          ...(binding.canonicalPath === undefined ? {} : { expectedCanonicalPath: binding.canonicalPath }),
        });
        current = {
          declaredPath: binding.declaredPath,
          state: "file",
          canonicalPath: await realpath(binding.declaredPath),
          size: evidence.size,
          sha256: evidence.sha256,
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

/** Errors indicating malformed/unavailable evidence paths, safe to quarantine. */
export function isExpectedEvidencePathError(error: unknown): boolean {
  if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR") ||
      isNodeError(error, "ELOOP") || isNodeError(error, "EINVAL") ||
      isNodeError(error, "ENAMETOOLONG")) return true;
  return isNodeError(error, "ERR_INVALID_ARG_VALUE") ||
    isNodeError(error, "ERR_INVALID_ARG_TYPE") ||
    (isRecord(error) &&
      (error.message === "ledger_epoch_non_regular_file_denied" ||
        error.message === "ledger_epoch_file_too_large" ||
        error.message === "retained_terminal_archive_patch_too_large" ||
        error.message === "consumed_output_evidence_file_invalid" ||
        error.message === "consumed_output_evidence_path_outside_root" ||
        error.message === "evidence_custody_root_noncanonical"));
}

function terminalLedgerEpochEvidenceCandidates(value: unknown): readonly unknown[] {
  if (!isRecord(value)) return [];
  const backup = isRecord(value.backup) ? value.backup : undefined;
  return [
    backup?.workspace,
    backup?.statusPath,
    backup?.patchPath,
    backup?.numstatPath,
    backup?.untrackedArchivePath,
    value.archivePath,
    isRecord(value.preexistingWorkspacePatch)
      ? value.preexistingWorkspacePatch.path
      : undefined,
  ];
}
