/** Closed execution DATA only. This module grants no native entry, allocation,
 * role, writable workspace, executable closure or publication authority. */
export enum OriginalControlGitRole { Source = "source", CreatedChild = "created_child", PublishedChild = "published_child" }
export enum OriginalControlGitOperation {
  InitSource = "init_source", Author = "author", Committer = "committer", AddSource = "add_source", CommitSource = "commit_source",
  AddLinked = "add_linked", RemoveLinked = "remove_linked", InitChild = "init_child", FetchChild = "fetch_child", CheckoutChild = "checkout_child",
  PublishBranch = "publish_branch", Head = "head", Commit = "commit", Tree = "tree", Branch = "branch", Status = "status",
  TopLevel = "top_level", Metadata = "metadata", Remote = "remote", Filters = "filters",
}
export const originalControlGitProgram = "/opt/subscription-runtime-dependency-os-TEST/scripts/dependency-retention-os-test/current-full-control-git.js";
export const originalControlGitExecutable = "/usr/bin/git";
export const originalControlGitUploadPack = "/usr/lib/git-core/git-upload-pack";
export const originalControlGitReady = "TEST_control_git_ready_v1\n";
export const originalControlGitBranch = "test/standalone-sdk";
export type OriginalControlGitFrame = Readonly<{ id: string; role: OriginalControlGitRole; operation: OriginalControlGitOperation;
  revision: string | null; deadline: bigint }>;
const objectId = /^[a-f0-9]{40}$/;
function check(value: unknown): asserts value { if (!value) throw new Error("hosted_original_control_git_recipe_held"); }
function validate(frame: OriginalControlGitFrame): void {
  check(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(frame.id) &&
    Object.values(OriginalControlGitRole).includes(frame.role) && Object.values(OriginalControlGitOperation).includes(frame.operation) &&
    (frame.revision === null || objectId.test(frame.revision)) && typeof frame.deadline === "bigint" && frame.deadline > 0n && frame.deadline < 10n ** 24n);
}
export function encodeOriginalControlGitFrame(frame: OriginalControlGitFrame): string {
  validate(frame); const line = `TEST_control_git_v1:${frame.id}:${frame.role}:${frame.operation}:${frame.revision ?? "-"}:${frame.deadline}\n`;
  check(Buffer.byteLength(line) <= 192); return line;
}
export function decodeOriginalControlGitFrame(line: string): OriginalControlGitFrame {
  check(Buffer.byteLength(line) <= 192); const fields = /^TEST_control_git_v1:([^:\n]+):([^:\n]+):([^:\n]+):([^:\n]+):([1-9][0-9]{0,23})\n$/.exec(line); check(fields);
  const role = Object.values(OriginalControlGitRole).find(value => value === fields[2]), operation = Object.values(OriginalControlGitOperation).find(value => value === fields[3]);
  check(role && operation); const frame = Object.freeze({ id: fields[1]!, role, operation,
    revision: fields[4] === "-" ? null : fields[4]!, deadline: BigInt(fields[5]!) }); validate(frame); return frame;
}
/** Canonical paths come only from this fixed UUID recipe. Their spelling is
 * not proof of a root: the producer must join original held allocation custody. */
export function originalControlGitArguments(frame: OriginalControlGitFrame): readonly string[] {
  validate(frame); const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-sdk-" + frame.id,
    source = root + "/source", workspace = root + "/workspace", path = frame.role === OriginalControlGitRole.Source ? source : workspace;
  const sourceOnly = () => check(frame.role === OriginalControlGitRole.Source);
  const creatingOnly = () => check(frame.role === OriginalControlGitRole.CreatedChild);
  const revision = () => { check(frame.revision !== null && objectId.test(frame.revision)); return frame.revision; };
  let args: readonly string[];
  switch (frame.operation) {
    case OriginalControlGitOperation.InitSource: sourceOnly(); check(frame.revision === null); args = ["init", "--template=", "--initial-branch=main"]; break;
    case OriginalControlGitOperation.Author: sourceOnly(); args = ["var", "GIT_AUTHOR_IDENT"]; break;
    case OriginalControlGitOperation.Committer: sourceOnly(); args = ["var", "GIT_COMMITTER_IDENT"]; break;
    case OriginalControlGitOperation.AddSource: sourceOnly(); args = ["add", "--", "README.md"]; break;
    case OriginalControlGitOperation.CommitSource: sourceOnly(); args = ["commit", "-m", "test: original standalone SDK fixture"]; break;
    case OriginalControlGitOperation.AddLinked: sourceOnly(); args = ["worktree", "add", "-b", "test/linked-before-refill", workspace, revision()]; break;
    case OriginalControlGitOperation.RemoveLinked: sourceOnly(); args = ["worktree", "remove", "--force", workspace]; break;
    case OriginalControlGitOperation.InitChild: creatingOnly(); args = ["init", "--template="]; break;
    case OriginalControlGitOperation.FetchChild: creatingOnly(); args = ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "--upload-pack=" + originalControlGitUploadPack, "--", source, revision()]; break;
    case OriginalControlGitOperation.CheckoutChild: creatingOnly(); args = ["checkout", "-b", originalControlGitBranch, revision()]; break;
    case OriginalControlGitOperation.PublishBranch: sourceOnly(); args = ["update-ref", "refs/heads/" + originalControlGitBranch, revision(), "0".repeat(40)]; break;
    case OriginalControlGitOperation.Head: args = ["rev-parse", "--verify", "HEAD"]; break;
    case OriginalControlGitOperation.Commit: args = ["rev-parse", "--verify", (frame.revision ?? "HEAD") + "^{commit}"]; break;
    case OriginalControlGitOperation.Tree: args = ["rev-parse", "--verify", (frame.revision ?? "HEAD") + "^{tree}"]; break;
    case OriginalControlGitOperation.Branch: args = ["symbolic-ref", "--short", "HEAD"]; break;
    case OriginalControlGitOperation.Status: args = ["status", "--porcelain", "--untracked-files=all"]; break;
    case OriginalControlGitOperation.TopLevel: args = ["rev-parse", "--show-toplevel"]; break;
    case OriginalControlGitOperation.Metadata: args = ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]; break;
    case OriginalControlGitOperation.Remote: args = ["remote"]; break;
    case OriginalControlGitOperation.Filters: args = ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"]; break;
  }
  return Object.freeze(["--no-optional-locks", "--no-replace-objects", "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "gc.auto=0",
    "-c", "maintenance.auto=false", "-c", "submodule.recurse=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always",
    "-c", "uploadpack.packObjectsHook=", "-C", path, ...args]);
}
export function originalControlGitEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_DEFAULT_HASH: "sha1", GIT_EXEC_PATH: "/usr/lib/git-core",
    GIT_AUTHOR_NAME: "iliya", GIT_AUTHOR_EMAIL: "iliyazelenkog@gmail.com", GIT_COMMITTER_NAME: "iliya", GIT_COMMITTER_EMAIL: "iliyazelenkog@gmail.com" });
}
