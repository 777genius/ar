import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  detectSecretLikeContent,
  type RuntimeResultArtifact,
} from "@vioxen/subscription-runtime/worker-core";

import {
  assertSafeHandoffId,
  assertSafeHandoffRelativePath,
  handoffPathInside,
  sha256HandoffContent,
  stableHandoffJson,
  uniqueSortedHandoffPaths,
} from "./codex-goal-handoff-artifact-guards";
import { withLiteralGitPathspecs } from "./git-literal-pathspecs";

const execFileAsync = promisify(execFile);
const maxGitBytes = 32 * 1024 * 1024;
const maxFileBytes = 4 * 1024 * 1024;
const maxTotalBytes = 16 * 1024 * 1024;
const captureAttempts = 2;

export const CODEX_GOAL_DURABLE_HANDOFF_PACKET_SCHEMA =
  "subscription-runtime-durable-terminal-handoff-v1" as const;

type PacketFile = {
  readonly path: string;
  readonly bytes: Buffer;
};

type QuarantineEntry = {
  readonly path: string;
  readonly reason:
    | "symlink"
    | "special"
    | "nested_repository"
    | "archive_path_unrepresentable";
  readonly symlinkTargetSha256?: string;
  readonly contentSha256?: string;
  readonly byteLength?: number;
};

export type DurableCodexGoalHandoffPacketManifest = {
  readonly schema: typeof CODEX_GOAL_DURABLE_HANDOFF_PACKET_SCHEMA;
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly git: {
    readonly base: string;
    readonly head: string;
    readonly headTree: string;
    readonly branch?: string;
    readonly mergeBase?: string;
  };
  readonly changedPaths: readonly string[];
  readonly status: {
    readonly path: "status.porcelain-v2.z";
    readonly byteLength: number;
    readonly sha256: string;
  };
  readonly layers: {
    readonly index: PacketDescriptor;
    readonly worktree: PacketDescriptor;
    readonly headRelative?: PacketDescriptor;
  };
  readonly untracked: {
    readonly archive: PacketDescriptor;
    readonly paths: PacketDescriptor;
    readonly entries: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly byteLength: number;
    }[];
  };
  readonly quarantine: {
    readonly manifest: PacketDescriptor;
    readonly entries: readonly QuarantineEntry[];
  };
};

export type PacketDescriptor = {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
};

export type MaterializedDurableCodexGoalHandoffPacket = {
  readonly packetPath: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: DurableCodexGoalHandoffPacketManifest;
  readonly changedPaths: readonly string[];
  readonly artifacts: readonly RuntimeResultArtifact[];
};

/**
 * Capture all Git workspace layers with read-only repository operations and
 * atomically transfer custody to an external durable root.
 */
export async function materializeDurableCodexGoalHandoffPacket(input: {
  readonly workerJobId: string;
  readonly taskId: string;
  readonly workspacePath: string;
  readonly durableRootDir: string;
  readonly expectedBaseCommit?: string;
  readonly expectedHeadCommit?: string;
  readonly testHooks?: {
    readonly afterCapture?: (attempt: number) => Promise<void>;
    readonly beforePublish?: (attempt: number) => Promise<void>;
    readonly afterExistingPacketRead?: (attempt: number) => Promise<void>;
  };
}): Promise<MaterializedDurableCodexGoalHandoffPacket | null> {
  assertSafeHandoffId(input.workerJobId, "worker_job_id");
  assertSafeHandoffId(input.taskId, "task_id");
  const workspacePath = await canonicalDirectory(input.workspacePath, "handoff_workspace");
  await mkdir(input.durableRootDir, { recursive: true, mode: 0o700 });
  const durableRootDir = await canonicalDirectory(
    input.durableRootDir,
    "handoff_durable_root",
  );
  await chmod(durableRootDir, 0o700);
  if (handoffPathInside(workspacePath, durableRootDir)) {
    throw new Error("handoff_durable_root_inside_workspace");
  }

  for (let attempt = 1; attempt <= captureAttempts; attempt += 1) {
    const before = await captureWorkspaceIdentity(workspacePath);
    if (input.expectedHeadCommit && input.expectedHeadCommit !== before.head) {
      throw new Error("handoff_head_commit_mismatch");
    }
    const captured = await capturePacketFiles({
      workspacePath,
      identity: before,
      workerJobId: input.workerJobId,
      taskId: input.taskId,
      base: input.expectedBaseCommit ?? before.head,
    });
    await input.testHooks?.afterCapture?.(attempt);
    const after = await captureWorkspaceIdentity(workspacePath);
    const afterContentSha256 = sameIdentity(before, after)
      ? (await capturePacketFiles({
          workspacePath,
          identity: after,
          workerJobId: input.workerJobId,
          taskId: input.taskId,
          base: input.expectedBaseCommit ?? after.head,
        })).contentSha256
      : undefined;
    if (!sameIdentity(before, after) ||
      captured.identitySha256 !== identitySha256(after) ||
      captured.contentSha256 !== afterContentSha256) {
      if (attempt < captureAttempts) continue;
      throw new Error("handoff_workspace_changed_during_materialization");
    }
    await input.testHooks?.beforePublish?.(attempt);
    const publishCheck = await captureWorkspaceIdentity(workspacePath);
    const publishContentSha256 = sameIdentity(after, publishCheck)
      ? (await capturePacketFiles({
          workspacePath,
          identity: publishCheck,
          workerJobId: input.workerJobId,
          taskId: input.taskId,
          base: input.expectedBaseCommit ?? publishCheck.head,
        })).contentSha256
      : undefined;
    if (!sameIdentity(after, publishCheck) ||
      captured.contentSha256 !== publishContentSha256) {
      if (attempt < captureAttempts) continue;
      throw new Error("handoff_workspace_changed_during_materialization");
    }
    const afterExistingPacketRead = input.testHooks?.afterExistingPacketRead;
    try {
      return await publishPacket({
        durableRootDir,
        taskId: input.taskId,
        captured,
        verifyWorkspaceStable: async () => {
          const finalIdentity = await captureWorkspaceIdentity(workspacePath);
          const finalContentSha256 = sameIdentity(publishCheck, finalIdentity)
            ? (await capturePacketFiles({
                workspacePath,
                identity: finalIdentity,
                workerJobId: input.workerJobId,
                taskId: input.taskId,
                base: input.expectedBaseCommit ?? finalIdentity.head,
              })).contentSha256
            : undefined;
          if (!sameIdentity(publishCheck, finalIdentity) ||
            captured.contentSha256 !== finalContentSha256) {
            throw new Error("handoff_workspace_changed_during_materialization");
          }
        },
        ...(afterExistingPacketRead
          ? {
              afterExistingPacketRead: async () => {
                await afterExistingPacketRead(attempt);
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof Error &&
        error.message === "handoff_workspace_changed_during_materialization" &&
        attempt < captureAttempts) continue;
      throw error;
    }
  }
  throw new Error("handoff_workspace_changed_during_materialization");
}

type WorkspaceIdentity = {
  readonly head: string;
  readonly headTree: string;
  readonly branch?: string;
  readonly mergeBase?: string;
  readonly status: Buffer;
  readonly indexPatch: Buffer;
  readonly worktreePatch: Buffer;
  readonly headPatch: Buffer;
  readonly trackedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly changedPaths: readonly string[];
};

async function captureWorkspaceIdentity(workspacePath: string): Promise<WorkspaceIdentity> {
  const [head, headTree, status, indexPatch, worktreePatch, headPatch,
    staged, unstaged, untracked, branch, mergeBase] = await Promise.all([
    gitBuffer(workspacePath, ["rev-parse", "--verify", "HEAD"]),
    gitBuffer(workspacePath, ["rev-parse", "--verify", "HEAD^{tree}"]),
    gitBuffer(workspacePath, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    gitBuffer(workspacePath, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"]),
    gitBuffer(workspacePath, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--"]),
    gitBuffer(workspacePath, ["diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--"]),
    gitBuffer(workspacePath, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"]),
    gitBuffer(workspacePath, ["diff", "--name-only", "-z", "--no-renames", "--"]),
    gitBuffer(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    gitOptionalText(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitOptionalText(workspacePath, ["merge-base", "HEAD", "origin/main"]),
  ]);
  // Opposing index/worktree changes can cancel in a HEAD-relative diff.
  const trackedPaths = [...nullPaths(staged), ...nullPaths(unstaged)]
    .map(assertSafeHandoffRelativePath);
  const untrackedPaths = nullPaths(untracked).map((path) =>
    assertSafeHandoffRelativePath(path.endsWith("/") ? path.slice(0, -1) : path)
  );
  assertHandoffMetadataSecretSafe([
    ...(branch ? [{ kind: "branch", value: branch }] : []),
    ...trackedPaths.map((value) => ({ kind: "tracked_path", value })),
    ...untrackedPaths.map((value) => ({ kind: "untracked_path", value })),
  ]);
  return {
    head: head.toString("utf8").trim(),
    headTree: headTree.toString("utf8").trim(),
    ...(branch ? { branch } : {}),
    ...(mergeBase ? { mergeBase } : {}),
    status,
    indexPatch,
    worktreePatch,
    headPatch,
    trackedPaths: uniqueSortedHandoffPaths(trackedPaths),
    untrackedPaths: uniqueSortedHandoffPaths(untrackedPaths),
    changedPaths: uniqueSortedHandoffPaths([...trackedPaths, ...untrackedPaths]),
  };
}

async function capturePacketFiles(input: {
  readonly workspacePath: string;
  readonly identity: WorkspaceIdentity;
  readonly workerJobId: string;
  readonly taskId: string;
  readonly base: string;
}): Promise<{
  readonly files: readonly PacketFile[];
  readonly manifest: DurableCodexGoalHandoffPacketManifest;
  readonly manifestBytes: Buffer;
  readonly generation: string;
  readonly identitySha256: string;
  readonly contentSha256: string;
}> {
  const quarantine: QuarantineEntry[] = [];
  const safeUntracked: { path: string; bytes: Buffer; mode: number }[] = [];
  let totalBytes = 0;
  for (const path of input.identity.untrackedPaths) {
    const classified = await readUntrackedPath(input.workspacePath, path);
    if (classified.quarantine) {
      quarantine.push(classified.quarantine);
      continue;
    }
    const file = classified.file;
    if (!file) continue;
    assertSecretSafe(path, file.bytes);
    totalBytes += file.bytes.byteLength;
    if (totalBytes > maxTotalBytes) throw new Error("handoff_total_byte_limit_exceeded");
    if (!tarPathFields(path)) {
      quarantine.push({
        path,
        reason: "archive_path_unrepresentable",
        byteLength: file.bytes.byteLength,
        contentSha256: sha256HandoffContent(file.bytes),
      });
      continue;
    }
    safeUntracked.push({ path, ...file });
  }
  for (const path of input.identity.trackedPaths) {
    const classified = await classifyTrackedPath(input.workspacePath, path);
    if (classified) quarantine.push(classified);
    await assertTrackedLayersSecretSafe(input.workspacePath, path);
  }

  safeUntracked.sort((left, right) => left.path.localeCompare(right.path));
  quarantine.sort((left, right) => left.path.localeCompare(right.path));
  const untrackedPaths = Buffer.from(
    safeUntracked.map((item) => item.path).join("\0") +
      (safeUntracked.length ? "\0" : ""),
  );
  const untrackedArchive = buildTar(safeUntracked);
  const quarantineBytes = Buffer.from(stableHandoffJson({
    schemaVersion: 1,
    entries: quarantine,
  }));
  const index = packetDescriptor("index.patch", input.identity.indexPatch);
  const worktree = packetDescriptor("worktree.patch", input.identity.worktreePatch);
  const headRelative = packetDescriptor("head-relative.patch", input.identity.headPatch);
  const archive = packetDescriptor("untracked.tar", untrackedArchive);
  const paths = packetDescriptor("untracked.paths.z", untrackedPaths);
  const quarantineManifest = packetDescriptor("quarantine.json", quarantineBytes);
  const manifest: DurableCodexGoalHandoffPacketManifest = {
    schema: CODEX_GOAL_DURABLE_HANDOFF_PACKET_SCHEMA,
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    workerJobId: input.workerJobId,
    taskId: input.taskId,
    git: {
      base: input.base,
      head: input.identity.head,
      headTree: input.identity.headTree,
      ...(input.identity.branch ? { branch: input.identity.branch } : {}),
      ...(input.identity.mergeBase ? { mergeBase: input.identity.mergeBase } : {}),
    },
    changedPaths: input.identity.changedPaths,
    status: {
      path: "status.porcelain-v2.z",
      byteLength: input.identity.status.byteLength,
      sha256: sha256HandoffContent(input.identity.status),
    },
    layers: {
      index,
      worktree,
      ...(input.identity.headPatch.length ? { headRelative } : {}),
    },
    untracked: {
      archive,
      paths,
      entries: safeUntracked.map((item) => ({
        path: item.path,
        sha256: sha256HandoffContent(item.bytes),
        byteLength: item.bytes.byteLength,
      })),
    },
    quarantine: { manifest: quarantineManifest, entries: quarantine },
  };
  const manifestBytes = Buffer.from(stableHandoffJson(manifest));
  const contentSha256 = packetContentSha256(manifest);
  return {
    generation: contentSha256,
    manifest,
    manifestBytes,
    identitySha256: identitySha256(input.identity),
    contentSha256,
    files: [
      { path: "status.porcelain-v2.z", bytes: input.identity.status },
      { path: index.path, bytes: input.identity.indexPatch },
      { path: worktree.path, bytes: input.identity.worktreePatch },
      ...(input.identity.headPatch.length
        ? [{ path: headRelative.path, bytes: input.identity.headPatch }]
        : []),
      { path: archive.path, bytes: untrackedArchive },
      { path: paths.path, bytes: untrackedPaths },
      { path: quarantineManifest.path, bytes: quarantineBytes },
      { path: "manifest.json", bytes: manifestBytes },
    ],
  };
}

async function readUntrackedPath(workspacePath: string, path: string): Promise<{
  readonly file?: { readonly bytes: Buffer; readonly mode: number };
  readonly quarantine?: QuarantineEntry;
}> {
  if (path.split("/").includes(".git")) {
    return { quarantine: { path, reason: "nested_repository" } };
  }
  if (await hasNestedRepositoryBoundary(workspacePath, path)) {
    return { quarantine: { path, reason: "nested_repository" } };
  }
  const absolute = resolve(workspacePath, path);
  if (!handoffPathInside(workspacePath, absolute)) {
    throw new Error("handoff_changed_path_escape");
  }
  const item = await lstat(absolute);
  if (item.isSymbolicLink()) {
    const target = Buffer.from(await readlink(absolute));
    return {
      quarantine: {
        path,
        reason: "symlink",
        symlinkTargetSha256: sha256HandoffContent(target),
      },
    };
  }
  if (!item.isFile()) return { quarantine: { path, reason: "special" } };
  if (item.size > maxFileBytes) throw new Error("handoff_file_byte_limit_exceeded");
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== item.size || opened.ino !== item.ino) {
      throw new Error("handoff_changed_file_unstable");
    }
    const bytes = await handle.readFile();
    const confirmed = await handle.stat();
    if (confirmed.size !== opened.size || confirmed.mtimeMs !== opened.mtimeMs) {
      throw new Error("handoff_changed_file_unstable");
    }
    return { file: { bytes, mode: item.mode & 0o777 } };
  } finally {
    await handle.close();
  }
}

async function hasNestedRepositoryBoundary(
  workspacePath: string,
  path: string,
): Promise<boolean> {
  const segments = path.split("/");
  for (let length = 1; length <= segments.length; length += 1) {
    const marker = join(workspacePath, ...segments.slice(0, length), ".git");
    try {
      await lstat(marker);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") return false;
      if (code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function classifyTrackedPath(
  workspacePath: string,
  path: string,
): Promise<QuarantineEntry | undefined> {
  const absolute = resolve(workspacePath, path);
  try {
    const item = await lstat(absolute);
    if (item.isSymbolicLink()) return { path, reason: "symlink" };
    if (!item.isFile()) return { path, reason: "special" };
    const bytes = await readFile(absolute);
    assertSecretSafe(path, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return undefined;
}

async function assertTrackedLayersSecretSafe(
  workspacePath: string,
  path: string,
): Promise<void> {
  const indexEntries = parseIndexEntries(await gitBuffer(workspacePath, [
    "ls-files", "--stage", "-z", "--", path,
  ]));
  for (const entry of indexEntries) {
    if (entry.mode === "160000") continue;
    assertSecretSafe(path, await gitBuffer(workspacePath, [
      "cat-file", "blob", entry.objectId,
    ]));
  }

  const headEntries = parseTreeEntries(await gitBuffer(workspacePath, [
    "ls-tree", "-z", "HEAD", "--", path,
  ]));
  for (const entry of headEntries) {
    if (entry.objectKind !== "blob") continue;
    assertSecretSafe(path, await gitBuffer(workspacePath, [
      "cat-file", "blob", entry.objectId,
    ]));
  }
}

function parseIndexEntries(bytes: Buffer): readonly {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
}[] {
  return nullPaths(bytes).map((record) => {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t/.exec(record);
    if (!match?.[1] || !match[2] || match[3] === undefined) {
      throw new Error("handoff_index_entry_invalid");
    }
    return { mode: match[1], objectId: match[2], stage: Number(match[3]) };
  });
}

function parseTreeEntries(bytes: Buffer): readonly {
  readonly objectId: string;
  readonly objectKind: "blob" | "commit" | "tree";
}[] {
  return nullPaths(bytes).map((record) => {
    const match = /^[0-7]{6} (blob|commit|tree) ([a-f0-9]{40,64})\t/.exec(record);
    if (!match?.[1] || !match[2]) {
      throw new Error("handoff_head_tree_entry_invalid");
    }
    return {
      objectKind: match[1] as "blob" | "commit" | "tree",
      objectId: match[2],
    };
  });
}

function assertSecretSafe(path: string, bytes: Buffer): void {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (name === "auth.json" || name === ".env" || name.startsWith(".env.") ||
    name === ".npmrc" || name === ".pypirc" || name === "credentials" ||
    name === "credentials.json" || lower.includes("/.ssh/") || lower.startsWith(".ssh/")) {
    throw new Error("handoff_sensitive_path_rejected");
  }
  if (detectSecretLikeContent(bytes, { filePath: path }) !== undefined) {
    throw new Error(`handoff_raw_secret_rejected:${path}`);
  }
}

function assertHandoffMetadataSecretSafe(
  values: readonly { readonly kind: string; readonly value: string }[],
): void {
  for (const { kind, value } of values) {
    if (detectSecretLikeContent(Buffer.from(value), {
      filePath: `handoff-${kind}-metadata`,
    }) !== undefined) {
      throw new Error(`handoff_raw_secret_metadata_rejected:${kind}`);
    }
  }
}

async function publishPacket(input: {
  readonly durableRootDir: string;
  readonly taskId: string;
  readonly captured: Awaited<ReturnType<typeof capturePacketFiles>>;
  readonly verifyWorkspaceStable: () => Promise<void>;
  readonly afterExistingPacketRead?: () => Promise<void>;
}): Promise<MaterializedDurableCodexGoalHandoffPacket> {
  const packetName = `${input.taskId}.${input.captured.generation}.packet`;
  const packetPath = join(input.durableRootDir, packetName);
  const existing = await readExistingPacket(
    packetPath,
    input.captured.contentSha256,
    input.captured.manifest.workerJobId,
    input.captured.manifest.taskId,
  );
  if (existing) {
    await input.afterExistingPacketRead?.();
    await input.verifyWorkspaceStable();
    return packetResult(packetPath, input.captured, existing);
  }
  const temporaryPath = join(
    input.durableRootDir,
    `.${packetName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await mkdir(temporaryPath, { mode: 0o700 });
  try {
    for (const file of input.captured.files) {
      const path = join(temporaryPath, file.path);
      await writeFile(path, file.bytes, { mode: 0o600, flag: "wx" });
      const handle = await open(path, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const directory = await open(temporaryPath, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    await input.verifyWorkspaceStable();
    await verifyPublishedPacket(temporaryPath, input.captured.files);
    await rename(temporaryPath, packetPath);
    const root = await open(input.durableRootDir, "r");
    try { await root.sync(); } finally { await root.close(); }
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = await readExistingPacket(
        packetPath,
        input.captured.contentSha256,
        input.captured.manifest.workerJobId,
        input.captured.manifest.taskId,
      );
      if (raced) {
        await input.afterExistingPacketRead?.();
        await input.verifyWorkspaceStable();
        return packetResult(packetPath, input.captured, raced);
      }
    }
    throw error;
  }
  await verifyPublishedPacket(packetPath, input.captured.files);
  return packetResult(packetPath, input.captured);
}

type ExistingPacket = {
  readonly manifest: DurableCodexGoalHandoffPacketManifest;
  readonly manifestBytes: Buffer;
};

async function readExistingPacket(
  path: string,
  expectedContentSha256: string,
  expectedWorkerJobId: string,
  expectedTaskId: string,
): Promise<ExistingPacket | null> {
  let item: Awaited<ReturnType<typeof lstat>>;
  try {
    item = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!item.isDirectory() || item.isSymbolicLink()) {
    throw new Error("handoff_packet_existing_path_unsafe");
  }
  try {
    const manifestPath = join(path, "manifest.json");
    const manifestItem = await lstat(manifestPath);
    if (!manifestItem.isFile() || manifestItem.isSymbolicLink()) {
      throw new Error("handoff_packet_verification_failed");
    }
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(
      manifestBytes.toString("utf8"),
    ) as DurableCodexGoalHandoffPacketManifest;
    if (manifest.schema !== CODEX_GOAL_DURABLE_HANDOFF_PACKET_SCHEMA ||
      manifest.schemaVersion !== 1 ||
      manifest.workerJobId !== expectedWorkerJobId ||
      manifest.taskId !== expectedTaskId ||
      packetContentSha256(manifest) !== expectedContentSha256) {
      throw new Error("handoff_packet_existing_manifest_mismatch");
    }
    await verifyManifestReferencedFiles(path, manifest);
    return { manifest, manifestBytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("handoff_packet_verification_failed");
    }
    throw error;
  }
}

async function verifyManifestReferencedFiles(
  packetPath: string,
  manifest: DurableCodexGoalHandoffPacketManifest,
): Promise<void> {
  const descriptors: readonly PacketDescriptor[] = [
    manifest.status,
    manifest.layers.index,
    manifest.layers.worktree,
    ...(manifest.layers.headRelative ? [manifest.layers.headRelative] : []),
    manifest.untracked.archive,
    manifest.untracked.paths,
    manifest.quarantine.manifest,
  ];
  for (const descriptor of descriptors) {
    const relative = assertSafeHandoffRelativePath(descriptor.path);
    const absolute = join(packetPath, relative);
    const item = await lstat(absolute);
    const bytes = await readFile(absolute);
    if (!item.isFile() || item.isSymbolicLink() ||
      bytes.byteLength !== descriptor.byteLength ||
      sha256HandoffContent(bytes) !== descriptor.sha256) {
      throw new Error("handoff_packet_verification_failed");
    }
  }
}

async function verifyPublishedPacket(path: string, files: readonly PacketFile[]): Promise<void> {
  for (const file of files) {
    const absolute = join(path, file.path);
    const item = await lstat(absolute);
    if (!item.isFile() || item.isSymbolicLink() ||
      sha256HandoffContent(await readFile(absolute)) !== sha256HandoffContent(file.bytes)) {
      throw new Error("handoff_packet_verification_failed");
    }
  }
}

function packetResult(
  packetPath: string,
  captured: Awaited<ReturnType<typeof capturePacketFiles>>,
  existing?: ExistingPacket,
): MaterializedDurableCodexGoalHandoffPacket {
  const manifest = existing?.manifest ?? captured.manifest;
  const manifestBytes = existing?.manifestBytes ?? captured.manifestBytes;
  const manifestSha256 = sha256HandoffContent(manifestBytes);
  const manifestPath = join(packetPath, "manifest.json");
  const artifacts: RuntimeResultArtifact[] = [
    { kind: "handoff_packet", path: packetPath, sha256: manifestSha256 },
    { kind: "handoff_manifest", path: manifestPath, byteLength: manifestBytes.length, sha256: manifestSha256 },
    ...Object.entries(manifest.layers).map(([kind, value]) => ({ kind: `handoff_${kind}`, path: join(packetPath, value.path), byteLength: value.byteLength, sha256: value.sha256 })),
    { kind: "handoff_untracked_archive", path: join(packetPath, manifest.untracked.archive.path), byteLength: manifest.untracked.archive.byteLength, sha256: manifest.untracked.archive.sha256 },
  ];
  return {
    packetPath,
    manifestPath,
    manifestSha256,
    manifest,
    changedPaths: manifest.changedPaths,
    artifacts,
  };
}

function packetDescriptor(path: string, bytes: Buffer): PacketDescriptor {
  return { path, byteLength: bytes.byteLength, sha256: sha256HandoffContent(bytes) };
}

function identitySha256(identity: WorkspaceIdentity): string {
  const hash = createHash("sha256");
  for (const value of [identity.head, identity.headTree]) hash.update(`${value}\0`);
  for (const bytes of [identity.status, identity.indexPatch, identity.worktreePatch,
    identity.headPatch]) hash.update(bytes).update("\0");
  for (const path of identity.changedPaths) hash.update(path).update("\0");
  return hash.digest("hex");
}

function packetContentSha256(
  manifest: DurableCodexGoalHandoffPacketManifest,
): string {
  return sha256HandoffContent(Buffer.from(stableHandoffJson({
    workerJobId: manifest.workerJobId,
    taskId: manifest.taskId,
    git: manifest.git,
    changedPaths: manifest.changedPaths,
    status: manifest.status,
    layers: manifest.layers,
    untracked: manifest.untracked,
    quarantine: manifest.quarantine,
  })));
}

function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
  return identitySha256(left) === identitySha256(right);
}

function nullPaths(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

async function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", withLiteralGitPathspecs([
    "--no-replace-objects", "-c", "core.quotepath=false", "-c", "core.fileMode=true", ...args,
  ]), {
    cwd,
    encoding: "buffer",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: maxGitBytes,
    timeout: 15_000,
  });
  return stdout;
}

async function gitOptionalBuffer(cwd: string, args: readonly string[]): Promise<Buffer | undefined> {
  try { return await gitBuffer(cwd, args); } catch { return undefined; }
}

async function gitOptionalText(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const value = await gitOptionalBuffer(cwd, args);
  const text = value?.toString("utf8").trim();
  return text || undefined;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`${label}_unsafe`);
  return await realpath(path);
}

function buildTar(files: readonly { path: string; bytes: Buffer; mode: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const fields = tarPathFields(file.path);
    if (!fields) throw new Error("handoff_archive_path_unrepresentable");
    const header = Buffer.alloc(512);
    fields.name.copy(header, 0);
    fields.prefix?.copy(header, 345);
    tarOctal(header, 100, 8, file.mode & 0o777);
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, file.bytes.length);
    tarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    tarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    blocks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarPathFields(path: string): {
  readonly name: Buffer;
  readonly prefix?: Buffer;
} | undefined {
  const name = Buffer.from(path);
  if (name.byteLength <= 100) return { name };
  for (let separator = path.lastIndexOf("/"); separator > 0;
    separator = path.lastIndexOf("/", separator - 1)) {
    const prefix = Buffer.from(path.slice(0, separator));
    const suffix = Buffer.from(path.slice(separator + 1));
    if (prefix.byteLength <= 155 && suffix.byteLength <= 100) {
      return { name: suffix, prefix };
    }
  }
  return undefined;
}

function tarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}
