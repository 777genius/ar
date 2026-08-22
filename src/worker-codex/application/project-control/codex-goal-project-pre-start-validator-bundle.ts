import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ProjectAccessScope } from "@vioxen/subscription-runtime/worker-core";
import { withLiteralGitPathspecs } from "../../git-literal-pathspecs";
import {
  defaultProjectControlGitPort,
  defaultProjectControlValidatorRunnerPort,
  type ProjectControlGitPort,
  type ProjectControlValidatorRunnerPort,
} from "./adapters/host-command-adapters";

const ADMISSION_DIRECTORY = "pre-start-admission";
const VALIDATOR_TIMEOUT_MS = 60_000;
const MAX_VALIDATOR_BYTES = 2 * 1024 * 1024;

export function configuredValidator(
  path: string,
  scope: ProjectAccessScope,
): { readonly path: string; readonly sha256: string } {
  assertNormalizedRelativePath(path);
  if (scope.preStartAdmission?.mode !== "serial") {
    throw new Error("project_control_pre_start_serial_mode_required");
  }
  const configured = scope.preStartAdmission.validatorBundle.find(
    (candidate) => candidate.path === path,
  );
  if (!configured) {
    throw new Error(`project_control_pre_start_validator_not_allowed:${path}`);
  }
  return configured;
}

export async function snapshotValidatorBundle(
  input: {
    readonly workspacePath: string;
    readonly jobRootDir: string;
    readonly scope: ProjectAccessScope;
    readonly expectedHead: string;
  },
  git: ProjectControlGitPort = defaultProjectControlGitPort,
): Promise<string> {
  const workspace = await realpath(input.workspacePath);
  const bundle = input.scope.preStartAdmission?.mode === "serial"
    ? input.scope.preStartAdmission.validatorBundle
    : [];
  if (bundle.length < 2) {
    throw new Error("project_control_pre_start_validator_bundle_required");
  }
  const paths = bundle.map(({ path }) => path);
  await assertWorkspaceBinding(workspace, input.expectedHead, paths, git);
  const snapshotRoot = join(input.jobRootDir, ADMISSION_DIRECTORY, "validator-bundle");
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(snapshotRoot)).isSymbolicLink()) {
    throw new Error("project_control_pre_start_validator_snapshot_symlink_denied");
  }
  const canonicalSnapshotRoot = await realpath(snapshotRoot);
  for (const configured of bundle) {
    assertNormalizedRelativePath(configured.path);
    const source = await realpath(resolve(workspace, configured.path));
    const relationToWorkspace = relative(workspace, source);
    if (relationToWorkspace.startsWith(`..${sep}`) || isAbsolute(relationToWorkspace)) {
      throw new Error("project_control_pre_start_validator_outside_workspace");
    }
    const bytes = await readFile(source);
    if (bytes.byteLength > MAX_VALIDATOR_BYTES || sha256(bytes) !== configured.sha256) {
      throw new Error("project_control_pre_start_validator_digest_mismatch");
    }
    const destination = join(snapshotRoot, configured.path);
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    const canonicalParent = await realpath(resolve(destination, ".."));
    const parentRelation = relative(canonicalSnapshotRoot, canonicalParent);
    if (parentRelation.startsWith(`..${sep}`) || isAbsolute(parentRelation)) {
      throw new Error("project_control_pre_start_validator_snapshot_escape");
    }
    try {
      await writeFile(destination, bytes, { mode: 0o500, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await lstat(destination)).isSymbolicLink()) {
        throw new Error("project_control_pre_start_validator_snapshot_symlink_denied");
      }
      if (sha256(await readFile(destination)) !== configured.sha256) {
        throw new Error("project_control_pre_start_validator_snapshot_mismatch");
      }
    }
  }
  await assertWorkspaceBinding(workspace, input.expectedHead, paths, git);
  return snapshotRoot;
}

export async function runValidator(
  kind: "contract" | "admission",
  validatorPath: string,
  args: readonly string[],
  cwd: string,
  validatorRunner: ProjectControlValidatorRunnerPort =
    defaultProjectControlValidatorRunnerPort,
): Promise<void> {
  try {
    await validatorRunner.run({
      validatorPath,
      args,
      cwd,
      timeoutMs: VALIDATOR_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
  } catch {
    throw new Error(`project_control_pre_start_${kind}_validation_failed`);
  }
}

function assertNormalizedRelativePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    normalize(path) !== path ||
    path === "." ||
    path === ".." ||
    path.startsWith(`..${sep}`)
  ) {
    throw new Error("project_control_pre_start_validator_path_invalid");
  }
}

async function assertWorkspaceBinding(
  workspace: string,
  expectedHead: string,
  paths: readonly string[],
  git: ProjectControlGitPort = defaultProjectControlGitPort,
): Promise<void> {
  const head = (await git.run({
    args: ["-C", workspace, "rev-parse", "HEAD"],
    timeoutMs: VALIDATOR_TIMEOUT_MS,
  })).stdout.trim();
  if (head !== expectedHead) throw new Error("project_control_pre_start_workspace_head_mismatch");
  const status = (await git.run({
    args: withLiteralGitPathspecs([
      "-C",
      workspace,
      "status",
      "--porcelain",
      "--",
      ...paths,
    ]),
    timeoutMs: VALIDATOR_TIMEOUT_MS,
  })).stdout.trim();
  if (status) throw new Error("project_control_pre_start_validator_bundle_dirty");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
