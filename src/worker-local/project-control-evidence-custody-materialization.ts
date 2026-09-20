import { materializeRecoverableCustodyDirectory } from "./project-control-custody-directory-publication";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectControlCustodyBootstrapCertification, ProjectControlCustodyMaterializationRecovery } from
  "@vioxen/subscription-runtime/worker-core";

export function projectControlCustodyMaterializationPaths(input: {
  readonly ledgerRoots: readonly string[];
  readonly evidenceRoots: readonly string[];
  readonly anchor: string;
}): readonly string[] {
  const roots = [...input.ledgerRoots, ...input.evidenceRoots];
  const paths = new Set<string>();
  const anchor = input.anchor;
  const addWithAncestors = (path: string) => {
    const chain: string[] = [];
    let current = path;
    while (current !== anchor && current !== "/") { chain.push(current); current = dirname(current); }
    if (current === anchor) chain.push(current);
    for (const value of chain.reverse()) paths.add(value);
  };
  for (const root of roots) {
    addWithAncestors(root);
    addWithAncestors(join(root, "items"));
  }
  for (const root of input.ledgerRoots) {
    addWithAncestors(join(root, ".mutation-locks"));
    addWithAncestors(join(dirname(root), ".consumed-output-ledger-mutation-locks",
      createHash("sha256").update(root).digest("hex")));
  }
  return [...paths];
}

export type CustodyMaterializationCrashHook = (
  point:
    | "after_custody_staging_creation_before_checkpoint"
    | "after_custody_staging_checkpoint_before_publication"
    | "before_custody_directory_publication"
    | "after_custody_directory_creation_before_parent_fsync"
    | "before_custody_manifest_publication_revalidation",
  path: string,
) => Promise<void> | void;

type CustodyDirectoryIdentity = {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly reason: string;
};

export async function materializeApprovedProjectControlCustody(input: {
  readonly approvedAnchor: string;
  readonly ledgerRoots: readonly string[];
  readonly evidenceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly recovery?: ProjectControlCustodyMaterializationRecovery;
}, crashHook?: CustodyMaterializationCrashHook):
Promise<ProjectControlCustodyBootstrapCertification> {
  const anchor = normalizedAbsoluteDirectory(input.approvedAnchor,
    "evidence_custody_bootstrap_anchor_unsafe");
  const ledgerRoots = uniqueNormalizedRoots(input.ledgerRoots);
  const evidenceRoots = uniqueNormalizedRoots(input.evidenceRoots);
  if (evidenceRoots.some((root) => basename(root) !== "archives")) {
    throw new Error("evidence_custody_bootstrap_evidence_basename_invalid");
  }
  const deniedRoots = input.deniedRoots.map((root) =>
    normalizedAbsoluteDirectory(root, "evidence_custody_bootstrap_root_unsafe"));
  const configuredRoots = [...ledgerRoots, ...evidenceRoots];
  for (const root of configuredRoots) {
    assertCustodyBoundary(anchor, root);
    if (deniedRoots.some((denied) => pathsOverlap(root, denied))) {
      throw new Error("evidence_custody_bootstrap_root_denied");
    }
  }

  let anchorHandle: FileHandle;
  try {
    anchorHandle = await openAbsoluteDirectoryNoSymlinks(anchor);
  } catch (error) {
    throw new Error("evidence_custody_bootstrap_anchor_unsafe", { cause: error });
  }
  const anchorStat = await anchorHandle.stat();
  const identities: CustodyDirectoryIdentity[] = [];
  try {
    // This single enumeration is authoritative for both materialization and
    // certification. It includes every intermediate ancestor, including lock
    // container directories, so no identity can be omitted.
    const paths = projectControlCustodyMaterializationPaths({ ledgerRoots, evidenceRoots, anchor });
    for (const path of paths) {
      if (path !== anchor) assertCustodyBoundary(anchor, path);
      if (deniedRoots.some((denied) => pathsOverlap(path, denied))) {
        throw new Error("evidence_custody_bootstrap_root_denied");
      }
      const finalReason = path.endsWith("/.mutation-locks")
        ? "evidence_custody_bootstrap_legacy_lock_unsafe"
        : (path.includes("/.consumed-output-ledger-mutation-locks/") ||
          path.endsWith("/.consumed-output-ledger-mutation-locks"))
          ? "evidence_custody_bootstrap_derived_lock_unsafe"
          : basename(path) === "items"
            ? "evidence_custody_bootstrap_items_unsafe"
            : configuredRoots.includes(path) || path === anchor
              ? "evidence_custody_bootstrap_root_unsafe"
              : "evidence_custody_bootstrap_ancestry_unsafe";
      if (input.recovery) {
        await materializeRecoverableCustodyDirectory({
          path, recovery: input.recovery,
          ...(crashHook ? { crashHook } : {}),
        });
      }
      identities.push(await materializeDirectoryFromAnchor({
        anchor, anchorHandle, path, finalReason,
        ancestryReason: finalReason,
        existingOnly: input.recovery !== undefined,
        ...(crashHook ? { crashHook } : {}),
      }));
    }
    assertNoDirectoryAliases(identities);

    let closed = false;
    const revalidate = async () => {
      if (closed) throw new Error("evidence_custody_bootstrap_certification_closed");
      await crashHook?.("before_custody_manifest_publication_revalidation", anchor);
      try {
        const currentAnchor = await anchorHandle.stat();
        if (currentAnchor.dev !== anchorStat.dev || currentAnchor.ino !== anchorStat.ino ||
          await realpath(`/proc/self/fd/${anchorHandle.fd}`) !== anchor) {
          throw new Error("evidence_custody_bootstrap_identity_drift");
        }
        const current: CustodyDirectoryIdentity[] = [];
        for (const identity of identities) {
          current.push(await reopenDirectoryIdentity(identity));
        }
        assertNoDirectoryAliases(current);
      } catch (error) {
        if (error instanceof Error &&
          (error.message === "evidence_custody_bootstrap_identity_drift" ||
            error.message === "evidence_custody_bootstrap_alias_denied")) throw error;
        throw new Error("evidence_custody_bootstrap_identity_drift", { cause: error });
      }
    };
    await revalidate();
    return {
      approvedAnchor: anchor,
      ledgerRoots,
      evidenceRoots,
      revalidate,
      close: async () => {
        if (closed) return;
        closed = true;
        await anchorHandle.close();
      },
    };
  } catch (error) {
    await anchorHandle.close().catch(() => undefined);
    throw error;
  }
}

function normalizedAbsoluteDirectory(path: string, reason: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path === "/") {
    throw new Error(reason);
  }
  return path;
}

function uniqueNormalizedRoots(roots: readonly string[]): readonly string[] {
  const normalized = roots.map((root) =>
    normalizedAbsoluteDirectory(root, "evidence_custody_bootstrap_root_unsafe"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("evidence_custody_bootstrap_alias_denied");
  }
  return normalized;
}

function assertCustodyBoundary(anchor: string, path: string): void {
  const rest = relative(anchor, path);
  if (!rest || rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new Error("evidence_custody_bootstrap_boundary_escape");
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || rightToLeft === "" ||
    (!leftToRight.startsWith(`..${sep}`) && leftToRight !== ".." && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith(`..${sep}`) && rightToLeft !== ".." && !isAbsolute(rightToLeft));
}

async function materializeDirectoryFromAnchor(input: {
  readonly anchor: string;
  readonly anchorHandle: FileHandle;
  readonly path: string;
  readonly finalReason: string;
  readonly ancestryReason?: string;
  readonly existingOnly?: boolean;
  readonly crashHook?: CustodyMaterializationCrashHook;
}): Promise<CustodyDirectoryIdentity> {
  const parts = relative(input.anchor, input.path).split(sep).filter(Boolean);
  let parent = input.anchorHandle;
  try {
    for (const [index, segment] of parts.entries()) {
      safeSegment(segment);
      const child = `/proc/self/fd/${parent.fd}/${segment}`;
      const reason = index === parts.length - 1
        ? input.finalReason
        : input.ancestryReason ?? "evidence_custody_bootstrap_ancestry_unsafe";
      let created = false;
      try {
        if (!input.existingOnly) {
          await mkdir(child, { mode: 0o700 });
          created = true;
        }
      } catch (error) {
        if (code(error) !== "EEXIST") throw new Error(reason, { cause: error });
      }
      let next: FileHandle;
      try {
        next = await open(child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        throw new Error(reason, { cause: error });
      }
      try {
      if (created) {
        await input.crashHook?.("after_custody_directory_creation_before_parent_fsync",
          join(input.anchor, ...parts.slice(0, index + 1)));
      }
      // Re-sync even when mkdir observed EEXIST: the prior attempt may have
      // been interrupted before its parent directory entry reached disk.
      await parent.sync();
      } catch (error) {
        await next.close();
        throw error;
      }
      if (parent !== input.anchorHandle) await parent.close();
      parent = next;
    }
    const metadata = await parent.stat();
    if (!metadata.isDirectory() || await realpath(`/proc/self/fd/${parent.fd}`) !== input.path) {
      throw new Error(input.finalReason);
    }
    return {
      path: input.path,
      device: metadata.dev,
      inode: metadata.ino,
      reason: input.finalReason,
    };
  } finally {
    if (parent !== input.anchorHandle) await parent.close().catch(() => undefined);
  }
}

async function reopenDirectoryIdentity(
  expected: CustodyDirectoryIdentity,
): Promise<CustodyDirectoryIdentity> {
  let handle: FileHandle | undefined;
  try {
    handle = await openAbsoluteDirectoryNoSymlinks(expected.path);
    const metadata = await handle.stat();
    if (metadata.dev !== expected.device || metadata.ino !== expected.inode) {
      throw new Error("evidence_custody_bootstrap_identity_drift");
    }
    return expected;
  } catch (error) {
    if (error instanceof Error &&
      error.message === "evidence_custody_bootstrap_identity_drift") throw error;
    throw new Error(expected.reason, { cause: error });
  } finally { await handle?.close(); }
}

function assertNoDirectoryAliases(identities: readonly CustodyDirectoryIdentity[]): void {
  const pathsByIdentity = new Map<string, string>();
  for (const identity of identities) {
    const key = `${identity.device}:${identity.inode}`;
    const existing = pathsByIdentity.get(key);
    if (existing !== undefined && existing !== identity.path) {
      throw new Error("evidence_custody_bootstrap_alias_denied");
    }
    pathsByIdentity.set(key, identity.path);
  }
}

export async function openAbsoluteDirectoryNoSymlinks(path: string): Promise<FileHandle> {
  const lexical = resolve(path);
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const segments = lexical.split("/").filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      safeSegment(segment);
      let next: FileHandle;
      try {
        next = await open(`/proc/self/fd/${handle.fd}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (index === segments.length - 1) {
          throw new Error("evidence_custody_root_noncanonical", { cause: error });
        }
        throw error;
      }
      await handle.close();
      handle = next;
    }
    if (await realpath(`/proc/self/fd/${handle.fd}`) !== lexical) {
      throw new Error("evidence_custody_root_noncanonical");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function safeSegment(value: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") ||
    value.includes("\\")) throw new Error("evidence_custody_path_invalid");
}

function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}
