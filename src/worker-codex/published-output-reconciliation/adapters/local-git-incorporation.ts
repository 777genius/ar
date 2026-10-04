import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectPublishedIntegrationCommit, publishedIntegrationRemoteRepository } from
  "../../../worker-local/project-integration-published-commit-inspection";
import type { IncorporationPermit, IncorporationReceipt } from "../domain/publication-incorporation";
const exec = promisify(execFile);

export async function verifyPublishedOutputIncorporation(input: {
  permit: IncorporationPermit; patch: string; changedFiles: readonly string[]; tempRoot: string;
}): Promise<Pick<IncorporationReceipt, "sourceTree" | "sourceParents" | "reconstructedTree" |
  "publishedTree" | "publishedParents" | "paths">> {
  const { permit } = input;
  const git = async (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    (await exec("git", ["--no-replace-objects", ...args], { cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", ...env },
      timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const read = async (args: readonly string[], cwd: string) => ({ stdout: await git(cwd, [...args]) });
  if (await publishedIntegrationRemoteRepository({ workspacePath: permit.targetWorkspace,
    remote: permit.remote, git: read }) !== permit.repository.toLowerCase()) {
    throw new Error("published_output_repository_mismatch");
  }
  const published = await inspectPublishedIntegrationCommit({
    workspacePath: permit.targetWorkspace, commitSha: permit.publishedSha, git: read });
  if (published.tree !== permit.review.reviewedTree) throw new Error("published_output_review_tree_mismatch");
  if (published.author.email !== permit.authorEmail ||
      !(published.committer.email === permit.authorEmail ||
        (published.committer.name === "GitHub" && published.committer.email === "noreply@github.com"))) {
    throw new Error("published_output_owner_mismatch");
  }
  await git(permit.targetWorkspace, ["merge-base", "--is-ancestor", permit.publishedSha, permit.canonicalHead]);
  await mkdir(input.tempRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(input.tempRoot, ".incorporation-"));
  try {
    const objects = join(temporary, "objects");
    await mkdir(objects);
    const common = resolve(permit.sourceWorkspace,
      (await git(permit.sourceWorkspace, ["rev-parse", "--git-common-dir"])).trim());
    const env = { GIT_INDEX_FILE: join(temporary, "index"), GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: await realpath(join(common, "objects")) };
    const patch = join(temporary, "output.patch");
    await writeFile(patch, input.patch, { mode: 0o600 });
    const sourceTree = (await git(permit.sourceWorkspace, ["rev-parse", `${permit.sourceBase}^{tree}`])).trim();
    const sourceParents = (await git(permit.sourceWorkspace, ["show", "-s", "--format=%P", permit.sourceBase])).trim().split(" ").filter(Boolean);
    await git(permit.sourceWorkspace, ["read-tree", permit.sourceBase], env);
    await git(permit.sourceWorkspace, ["apply", "--cached", "--whitespace=nowarn", patch], env);
    const reconstructedTree = (await git(permit.sourceWorkspace, ["write-tree"], env)).trim();
    const changed = (await git(permit.sourceWorkspace, ["diff", "--cached", "--no-renames", "--name-only",
      "-z", permit.sourceBase, "--"], env)).split("\0").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...input.changedFiles].sort())) {
      throw new Error("published_output_changed_paths_mismatch");
    }
    const treeEntries = async (cwd: string, tree: string, treeEnv?: NodeJS.ProcessEnv) => {
      const output = await git(cwd, ["--literal-pathspecs", "ls-tree", "-r", "-z", tree, "--", ...changed], treeEnv);
      const entries = new Map<string, { mode: "100644" | "100755" | "120000"; type: "blob"; oid: string }>();
      for (const line of output.split("\0").filter(Boolean)) {
        const match = /^(100644|100755|120000) (blob) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
        if (!match || !changed.includes(match[4]!)) throw new Error("published_output_tree_entry_invalid");
        entries.set(match[4]!, { mode: match[1] as "100644" | "100755" | "120000", type: "blob", oid: match[3]! });
      }
      return entries;
    };
    const before = await treeEntries(permit.sourceWorkspace, sourceTree, env);
    const after = await treeEntries(permit.sourceWorkspace, reconstructedTree, env);
    const actual = await treeEntries(permit.targetWorkspace, published.tree);
    const paths = changed.map((path) => ({ path, before: before.get(path) ?? null,
      after: after.get(path) ?? null, published: actual.get(path) ?? null }));
    if (paths.some((path) => JSON.stringify(path.after) !== JSON.stringify(path.published))) {
      throw new Error("published_output_path_not_incorporated");
    }
    return { sourceTree, sourceParents, reconstructedTree, publishedTree: published.tree,
      publishedParents: [...published.parentCommits], paths };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
