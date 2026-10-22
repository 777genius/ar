import { assertUnboundProjectDependencyReadScope } from "../../hosted-dependency-legacy-writer-boundary";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DependencyAdmissionError, DependencyAdmissionFailure } from "@vioxen/subscription-runtime/core";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { LocalProjectControlEvidenceCustody } from "@vioxen/subscription-runtime/worker-local";
import { requiresCurrentHostedDependencyRootPurpose } from "../../hosted-current-dependency-origin";
import { hostedDependencyBindingName, hostedDependencyBindingRoot, readHostedDependencyBinding }
  from "../../hosted-dependency-workspace";
import { assertProjectControlWorkspaceLeaseCurrent, type ProjectControlWorkspaceLease }
  from "../../codex-goal-project-workspace-lock";
import { requiresStandaloneProjectWorkspace } from "../../project-standalone-workspace";
import { inspectDependencyBootstrapMetadata } from "../../dependency-bootstrap-inspection";
import { inspectNodeDependencyMetadata } from "../../dependency-environment-inspection";
import type { DependencyInspectionFiles } from "../../dependency-inspection-files";
import type { DependencyBootstrapMode, DependencyPreflightResult } from "../../dependency-bootstrap";
import type { CodexGoalJobManifestInput } from "../../codex-goal-jobs";
import type { CodexGoalProjectCreateWorktreeInput } from "./codex-goal-project-control-contracts";

type Input = Readonly<{
  manifest: CodexGoalJobManifestInput; target: CodexGoalProjectCreateWorktreeInput;
  scope: ProjectAccessScope; registryRootDir: string; workspace: ProjectControlWorkspaceLease;
  mode: DependencyBootstrapMode;
}>;
const denied = (): never => { throw new DependencyAdmissionError(DependencyAdmissionFailure.Unsupported); };
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;

/** No-start metadata observation, not a writer/birth/adoption/launch permit.
 * Existing legacy V1 keeps its original bootstrap/diagnostic path. Every other
 * enrollment, malformed state and actual managed origin remains fail-closed. */
export async function inspectStandaloneProjectDependencies(input: Input):
  Promise<DependencyPreflightResult | undefined> {
  // Actual process classification precedes caller property evaluation.
  if (requiresCurrentHostedDependencyRootPurpose()) denied();
  if (input.mode === "install" || !requiresStandaloneProjectWorkspace(input)) return undefined;
  // Classification is not reader admission. Preserve explicit V1 delegation
  // before applying any new reader-only lease/custody prerequisites.
  const binding = readHostedDependencyBinding(input.manifest.jobId);
  if (binding?.version === 1) return undefined;
  if (binding) denied();
  if (process.platform !== "linux" || process.getuid?.() !== 0) denied();
  await assertProjectControlWorkspaceLeaseCurrent(input.workspace, input.registryRootDir);
  const root = input.manifest.workspacePath;
  if (input.workspace.canonicalWorkspacePath !== root || input.workspace.requestedWorkspacePath !== root ||
      resolve(root) !== root || realpathSync(root) !== root) denied();
  assertUnboundProjectDependencyReadScope(root, input.manifest.jobId);
  const directories = new Map<string, Stats>();
  for (const path of [root, join(root, ".git"), input.manifest.jobRootDir, input.registryRootDir]) {
    for (let current = path;; current = dirname(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) ||
          realpathSync(current) !== current) denied();
      directories.set(current, info);
      if (current === "/") break;
    }
  }
  // A null decoder result alone is not absence. Check the fixed protected
  // namespace and exact entry without following links; only ENOENT is absent.
  const bindingPath = join(dirname(hostedDependencyBindingRoot), hostedDependencyBindingName(input.manifest.jobId));
  const bindingAbsent = (): boolean => {
    for (let path = dirname(hostedDependencyBindingRoot);; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) ||
          realpathSync(path) !== path) denied();
      if (path === "/") break;
    }
    try {
      const stat = lstatSync(hostedDependencyBindingRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) ||
          realpathSync(hostedDependencyBindingRoot) !== hostedDependencyBindingRoot) denied();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    try { lstatSync(bindingPath); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  };
  if (!bindingAbsent()) denied();
  let failed = false;
  const invalid = (): never => { failed = true; return denied(); };
  const assertCurrent = async (): Promise<void> => {
    if (failed || requiresCurrentHostedDependencyRootPurpose()) denied();
    await assertProjectControlWorkspaceLeaseCurrent(input.workspace, input.registryRootDir);
    assertUnboundProjectDependencyReadScope(root, input.manifest.jobId);
    if (!requiresStandaloneProjectWorkspace(input) || !bindingAbsent() ||
        input.workspace.canonicalWorkspacePath !== root || input.workspace.lease.workspacePath !== root) invalid();
    for (const [path, before] of directories) {
      const now = lstatSync(path);
      if (!same(before, now) || !now.isDirectory() || now.isSymbolicLink() || realpathSync(path) !== path) invalid();
    }
  };
  const confined = (path: string): void => {
    if (path.length > 4096 || path.includes("\0") || resolve(path) !== path || !(path === root || path.startsWith(root + sep))) invalid();
  };
  const custody = new LocalProjectControlEvidenceCustody();
  const admitted = directories.get(root)!;
  const expected = { canonicalPath: root, dev: admitted.dev, ino: admitted.ino };
  const read = async <T>(path: string, effect: () => Promise<T>): Promise<T> => {
    confined(path); await assertCurrent();
    try { const result = await effect(); await assertCurrent(); return result; }
    catch (error) {
      // Shared legacy parsers intentionally swallow some read errors. Retain a
      // sticky boundary failure so they cannot convert unsafe scope into absence.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true;
      throw error;
    }
  };
  // Resolve each link from a retained parent, confining the next lexical
  // target BEFORE any IO. Native realpath must not traverse an outside target.
  const containedPath = async (path: string): Promise<string> => {
    confined(path);
    for (let links = 0; links <= 40; links++) {
      const segments = path.slice(root.length).split(sep).filter(Boolean);
      if (segments.length > 256) invalid();
      let candidate = root, restarted = false;
      for (const [index, segment] of segments.entries()) {
        candidate = join(candidate, segment);
        const kind = await custody.pathKind(candidate, expected);
        if (kind === "absent") throw Object.assign(new Error("dependency_metadata_absent"), { code: "ENOENT" });
        if (kind === "other") invalid();
        if (kind === "symlink") {
          const target = await custody.readSymbolicLink(candidate, expected);
          path = resolve(dirname(candidate), target, ...segments.slice(index + 1));
          confined(path); restarted = true; break;
        }
      }
      if (!restarted) return path;
    }
    return invalid();
  };
  const files: DependencyInspectionFiles = {
    access: path => read(path, async () => { await containedPath(path); }),
    readFile: path => read(path, async () => Buffer.from((await custody.readImmutableFile(await containedPath(path), 16 * 1024 * 1024, expected)).bytes)),
    readdir: path => read(path, async () => (await custody.listDirectory(await containedPath(path), expected)).map(entry => ({
      name: entry.name, isDirectory: () => entry.kind === "directory", isSymbolicLink: () => entry.kind === "symlink",
    }))),
    lstat: path => read(path, async () => {
      const kind = await custody.pathKind(path, expected);
      if (kind === "absent") throw Object.assign(new Error("dependency_metadata_absent"), { code: "ENOENT" });
      return { isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "symlink" };
    }),
    readlink: path => read(path, async () => await custody.readSymbolicLink(path, expected)),
    realpath: path => read(path, async () => await containedPath(path)),
  };
  await assertCurrent();
  for (const path of ["commondir", "shallow", "objects/info/alternates", "objects/info/http-alternates"]) {
    if (await custody.pathKind(join(root, ".git", path), expected) !== "absent") invalid();
  }
  const safety = await inspectNodeDependencyMetadata(root, files);
  const result = await inspectDependencyBootstrapMetadata(root, input.mode, files, safety);
  await assertCurrent();
  return result;
}
