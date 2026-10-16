import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { managedDependencyGitEnvironment, managedDependencyGitFlags } from "./managed-dependency-git";
import { researchCustody } from "./research-launch-files";
import { assertResearchInitialRoot } from "./research-launch-host";
import type { ProjectSealedSourcePort } from "./codex-goal-mcp-project-control-jobs-types";

/** Same inert environment/flags as managed/source handoff Git; no inherited mappings. */
export function preparationSafeGit(args: readonly string[], timeoutMs = 30000): string {
  researchCustody("/usr/bin/git");
  return execFileSync("/usr/bin/git", ["--no-replace-objects", ...managedDependencyGitFlags,
    "-c", "core.attributesFile=/dev/null", "-c", "fsck.skipList=/dev/null", ...args], {
    env: { ...managedDependencyGitEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function assertPreparationGitMetadata(workspace: string): void {
  if (existsSync(join(workspace, ".gitmodules")) || existsSync(join(workspace, ".lfsconfig"))) throw new Error("mimo_project_bridge_snapshot_linked_git");
  const root = join(workspace, ".git"); researchCustody(root);
  if (!lstatSync(root).isDirectory()) throw new Error("mimo_project_bridge_snapshot_linked_git");
  let count = 0;
  function visit(path: string): void {
    if (++count > 100000) throw new Error("mimo_project_bridge_snapshot_metadata_bounds");
    researchCustody(path); const stat = lstatSync(path);
    if (stat.isDirectory()) for (const child of readdirSync(path)) visit(join(path, child));
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error("mimo_project_bridge_snapshot_metadata_invalid");
  }
  visit(root);
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates", "shallow", "modules", "lfs"])
    if (existsSync(join(root, name))) throw new Error("mimo_project_bridge_snapshot_linked_git");
  if (lstatSync(join(root, "config")).size > 65536) throw new Error("mimo_project_bridge_snapshot_config_invalid");
  const config = readFileSync(join(root, "config"), "utf8");
  if (Buffer.byteLength(config) > 65536 || /\[\s*(?:include|includeIf|extensions|filter|fsck|uploadpack|receive|credential|protocol|url)\b/i.test(config) ||
      /^\s*(?:worktree|promisor|sshCommand|uploadpack|receivepack)\s*=/im.test(config)) throw new Error("mimo_project_bridge_snapshot_config_invalid");
}
/** Trusted Host dependency only. No remote DTO or MCP argument can select it. */
export function hostedMimoSealedSourcePort(binding: Readonly<{
  sourceWorkspacePath: string; sourceRef: string; sourceCommit: string;
}>): ProjectSealedSourcePort {
  return {
    async resolveRevision(input) {
      assertResearchInitialRoot(true);
      if (input.sourceWorkspacePath !== binding.sourceWorkspacePath || input.sourceRef !== binding.sourceRef ||
          input.expectedSourceCommit !== binding.sourceCommit)
        throw new Error("mimo_project_bridge_source_mismatch");
      researchCustody(binding.sourceWorkspacePath);
      if (realpathSync(binding.sourceWorkspacePath) !== binding.sourceWorkspacePath) throw new Error("mimo_project_bridge_source_mismatch");
      assertPreparationGitMetadata(binding.sourceWorkspacePath);
      const git = (args: string[]) => preparationSafeGit(["-C", binding.sourceWorkspacePath, ...args]);
      try {
        if (git(["rev-parse", "HEAD"]) !== binding.sourceCommit ||
            git(["rev-parse", "--verify", binding.sourceRef + "^{commit}"]) !== binding.sourceCommit ||
            git(["status", "--porcelain", "--untracked-files=all"]) !== "") throw new Error("mimo_project_bridge_source_mismatch");
        git(["fsck", "--strict", "--full", "--no-dangling", binding.sourceCommit]);
      } catch { throw new Error("mimo_project_bridge_source_mismatch"); }
      return { revision: binding.sourceCommit, sourceRealPath: binding.sourceWorkspacePath, pinned: true };
    },
  };
}
