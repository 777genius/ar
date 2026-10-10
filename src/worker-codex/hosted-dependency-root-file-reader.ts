import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { withHostedActivationFence } from "@vioxen/subscription-runtime/provider-codex";
import { HostedDependencyRootPurpose, assertCurrentHostedDependencyRootPurpose,
  HostedDependencyRootDescriptorRecipe, openCurrentHostedDependencyRootDescriptor,
  type HostedDependencyRootDirectoryPin, type HostedDependencyRootPurposeContext } from "./hosted-dependency-root-purpose";
import { assertManagedDependencyGitAuthoredPath, isManagedDependencySignedTaskId } from "./managed-dependency-git";

export enum HostedDependencyRootFileRecipe {
  AuthoredSourceV1 = "authored_source_v1",
  DurablePatchV1 = "durable_patch_v1",
  TaskEventsV1 = "task_events_v1",
}
type RootFileInput = Readonly<{ recipe: HostedDependencyRootFileRecipe.AuthoredSourceV1;
  path: string; maxFileBytes: number; remainingTotalBytes: number }> |
  Readonly<{ recipe: HostedDependencyRootFileRecipe.DurablePatchV1; path: string }> |
  Readonly<{ recipe: HostedDependencyRootFileRecipe.TaskEventsV1 }>;
function fail(): never { throw new Error("handoff_protected_file_unsafe"); }
function mountId(fd: number): string {
  const info = openSync(`/proc/self/fdinfo/${fd}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(4097); let offset = 0;
    while (offset < bytes.length) { const count = readSync(info, bytes, offset, bytes.length - offset, null);
      if (count === 0) break; offset += count; }
    if (offset > 4096) return fail();
    const ids = [...bytes.subarray(0, offset).toString("utf8").matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
    if (ids.length !== 1) return fail(); return ids[0]![1]!;
  } finally { closeSync(info); }
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.mode === right.mode && left.nlink === right.nlink;
}
/** Closed source/patch/events reader.
 * B retains the physical ancestry; bounded IO uses the genuine current fence. */
export function readHostedDependencyRootFile(context: HostedDependencyRootPurposeContext, input: RootFileInput): Buffer {
  const authoredRelative = input.recipe === HostedDependencyRootFileRecipe.AuthoredSourceV1
    ? assertManagedDependencyGitAuthoredPath(context, input.path) : undefined;
  return withHostedActivationFence(fence => {
    const scope = assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
    let root: string, path: string, pin: HostedDependencyRootDirectoryPin, maximum: number, expectedDigest: string | undefined;
    if (input.recipe === HostedDependencyRootFileRecipe.AuthoredSourceV1) {
      root = scope.workspace.canonicalPath; path = join(root, authoredRelative!);
      const actual = scope.authoredRoots.find(candidate => candidate.canonicalPath === root);
      if (!actual || actual.dev !== scope.workspace.dev || actual.ino !== scope.workspace.ino) return fail();
      pin = actual; maximum = input.maxFileBytes;
      if (!Number.isSafeInteger(input.remainingTotalBytes) || input.remainingTotalBytes < 0) return fail();
    } else if (input.recipe === HostedDependencyRootFileRecipe.DurablePatchV1) {
      root = scope.durableHandoffRoot.canonicalPath; path = input.path; pin = scope.durableHandoffRoot;
      const prefix = scope.logicalTaskId + ".", suffix = ".handoff.patch", name = basename(path);
      if (dirname(path) !== root || !name.startsWith(prefix) || !name.endsWith(suffix) ||
          !/^[a-f0-9]{64}$/.test(name.slice(prefix.length, -suffix.length))) return fail();
      expectedDigest = name.slice(prefix.length, -suffix.length);
      maximum = 16 * 1024 * 1024;
    } else if (input.recipe === HostedDependencyRootFileRecipe.TaskEventsV1) {
      root = scope.jobRootDir; path = join(root, scope.logicalTaskId + ".events.jsonl"); pin = scope.durableHandoffRoot;
      if (pin.canonicalPath !== join(root, "durable-handoffs")) return fail();
      maximum = 16 * 1024 * 1024;
    } else return fail();
    if (!isManagedDependencySignedTaskId(scope.logicalTaskId) || !Number.isSafeInteger(maximum) || maximum < 1 ||
        maximum > 64 * 1024 * 1024 || !path.startsWith(root + "/") || path.includes("\0")) return fail();
    const namedLeaf = lstatSync(path, { bigint: true });
    if (!namedLeaf.isFile() || namedLeaf.isSymbolicLink()) return fail();
    const recipe = input.recipe === HostedDependencyRootFileRecipe.AuthoredSourceV1 ? HostedDependencyRootDescriptorRecipe.AuthoredFileV1 :
      input.recipe === HostedDependencyRootFileRecipe.DurablePatchV1 ? HostedDependencyRootDescriptorRecipe.DurableFileV1 : HostedDependencyRootDescriptorRecipe.TaskEventsV1;
    // B privately retains and rechecks the entire nofollow ancestry. The
    // helper receives only this selected leaf, never a host ancestor FD.
    const resource = openCurrentHostedDependencyRootDescriptor(context, fence, recipe, path);
    try {
      const fd = resource.fd, before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== 0n || before.gid !== 0n || (before.mode & 0o022n) !== 0n ||
          before.dev.toString() !== pin.dev || mountId(fd) !== pin.mountId || !sameFile(before, namedLeaf) ||
          !sameFile(before, lstatSync(path, { bigint: true })) || realpathSync(path) !== path) return fail();
      if (before.size < 0n || before.size > BigInt(maximum)) throw new Error("handoff_file_byte_limit_exceeded");
      if (input.recipe === HostedDependencyRootFileRecipe.AuthoredSourceV1 && before.size > BigInt(input.remainingTotalBytes))
        throw new Error("handoff_total_byte_limit_exceeded");
      assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw new Error("handoff_changed_file_unstable"); offset += count; }
      if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || !sameFile(before, fstatSync(fd, { bigint: true })) ||
          !sameFile(before, lstatSync(path, { bigint: true }))) throw new Error("handoff_changed_file_unstable");
      assertCurrentHostedDependencyRootPurpose(context, HostedDependencyRootPurpose.ManagedGitReadV1, fence);
      if (expectedDigest !== undefined && createHash("sha256").update(bytes).digest("hex") !== expectedDigest) return fail();
      return bytes;
    } finally { resource.close(); }
  });
}
