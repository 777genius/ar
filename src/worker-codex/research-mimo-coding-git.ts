import { dirname, join } from "node:path";

/** Only the admitted worktree's index/HEAD and its project's object database.
 * Never expose the common worktrees directory, hooks, configuration or siblings. */
export function researchMimoCodingGitReadPaths(workspace: string, host: {
  read(path: string): string;
  exists(path: string): boolean;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
}): readonly string[] {
  const dotGit = join(workspace, ".git");
  if (!host.exists(dotGit)) return Object.freeze([]);
  if (!host.isFile(dotGit)) throw new Error("mimo_coding_git_binding_invalid");
  const common = join(dirname(dirname(workspace)), "source/.git");
  const own = join(common, "worktrees", workspace.slice(workspace.lastIndexOf("/") + 1));
  if (host.read(dotGit) !== `gitdir: ${own}\n` || !host.isDirectory(own) ||
      host.read(join(own, "commondir")) !== "../..\n" ||
      host.read(join(own, "gitdir")) !== `${dotGit}\n`) throw new Error("mimo_coding_git_binding_invalid");
  const paths = ["HEAD", "index", "commondir", "gitdir"].map(leaf => join(own, leaf));
  if (paths.some(path => !host.isFile(path))) throw new Error("mimo_coding_git_binding_invalid");
  for (const leaf of ["objects", "refs"]) {
    const path = join(common, leaf);
    if (!host.isDirectory(path)) throw new Error("mimo_coding_git_binding_invalid");
    paths.push(path);
  }
  const objectInfo = join(common, "objects/info");
  if (host.exists(objectInfo) && !host.isDirectory(objectInfo)) throw new Error("mimo_coding_git_external_objects");
  for (const leaf of ["objects/info/alternates", "objects/info/http-alternates"]) {
    if (host.exists(join(common, leaf))) throw new Error("mimo_coding_git_external_objects");
  }
  if (host.isFile(join(common, "packed-refs"))) paths.push(join(common, "packed-refs"));
  return Object.freeze(paths);
}
