import { inspectDependencyBootstrapMetadata } from "./dependency-bootstrap-inspection";
import { legacyDependencyInspectionFiles } from "./dependency-inspection-files";
import { captureLegacyDependencyWriterInput, assertLegacyDependencyWriterWorkspace } from "./hosted-dependency-legacy-writer-boundary";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  mkdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withDependencyBootstrapLock } from "./dependency-bootstrap-lock";
import { resolveDependencyCacheRoot } from "./dependency-cache-placement";
import {
  inspectNodeDependencyEnvironment,
  sanitizeNodeDependencyEnvironment,
} from "./dependency-environment-safety";
import {
  withDependencyBootstrapWorkspaceTransaction,
} from "./dependency-bootstrap-workspace-transaction";
import { researchDirectoryIdentity, researchPromptBytes, type ResearchDirectoryIdentity } from "./research-launch-files";

export {
  defaultDependencyCacheRoot,
  dependencyCacheNamespace,
} from "./dependency-cache-placement";

const execFileAsync = promisify(execFile);

export type DependencyBootstrapMode = "off" | "preflight" | "install";

export type DependencyEcosystem = "node" | "python";

export type DependencyPackageManagerName =
  "pnpm" | "npm" | "yarn" | "bun" | "uv";

export type DependencyPackageManager = {
  readonly name: DependencyPackageManagerName;
  readonly source: "lockfile" | "packageManager" | "fallback";
  readonly versionSpec?: string;
  readonly lockfilePath?: string;
};

export type DependencyBinaryCheck = {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
};

export type DependencyPreflightResult = {
  readonly mode: DependencyBootstrapMode;
  readonly workspacePath: string;
  readonly ecosystem?: DependencyEcosystem;
  readonly manifestPath?: string;
  readonly environmentPath?: string;
  readonly environmentExists?: boolean;
  readonly packageJsonPath?: string;
  readonly packageManager?: DependencyPackageManager;
  readonly nodeModulesPath: string;
  readonly nodeModulesExists: boolean;
  readonly binaryChecks: readonly DependencyBinaryCheck[];
  readonly fingerprint?: string;
  readonly fingerprintInputs: readonly string[];
  readonly installCommand?: string;
  readonly cacheRoot?: string;
  readonly diagnosticPath?: string;
  readonly cacheLockPath?: string;
  readonly cacheLockWaitMs?: number;
  readonly staleCacheLockRecovered?: boolean;
  readonly unsafeDependencyPaths?: readonly string[];
  readonly sanitizedDependencyPaths?: readonly string[];
  readonly status:
    | "off"
    | "unsupported_project"
    | "ready"
    | "deps_missing"
    | "installed"
    | "unsafe"
    | "install_failed";
  readonly warnings: readonly string[];
};

export type DependencyBootstrapInput = {
  readonly workspacePath: string;
  readonly jobRootDir?: string;
  readonly cacheRoot?: string;
  readonly cacheNamespace?: string;
  readonly mode?: DependencyBootstrapMode;
  readonly confirmInstall?: boolean;
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number },
  ) => Promise<void>;
};

export type DependencyPreflightDiagnosticBinding = Readonly<{
  path: string; workspacePath: string; sha256: string; jobRoot: ResearchDirectoryIdentity;
}>;

/** Snapshot only the diagnostic emitted by successful internal preparation.
 * Unsupported custody leaves it unbound; it cannot qualify a fresh self. */
export function bindDependencyPreflightDiagnostic(result: DependencyPreflightResult, jobRootDir: string): DependencyPreflightDiagnosticBinding | undefined {
  if (!result.diagnosticPath) return undefined;
  try {
    if (result.diagnosticPath !== join(jobRootDir, "dependency-preflight.json")) return undefined;
    const jobRoot = researchDirectoryIdentity(jobRootDir);
    const bytes = researchPromptBytes(jobRoot, result.diagnosticPath);
    if (bytes.length > 256 * 1024 || bytes.toString("utf8") !== `${JSON.stringify(result, null, 2)}\n`) return undefined;
    const binding = Object.freeze({ path: result.diagnosticPath, workspacePath: result.workspacePath,
      sha256: createHash("sha256").update(bytes).digest("hex"), jobRoot });
    return dependencyPreflightDiagnosticCurrent(binding, jobRootDir, result.workspacePath) ? binding : undefined;
  } catch { return undefined; }
}

export function dependencyPreflightDiagnosticCurrent(binding: DependencyPreflightDiagnosticBinding, jobRootDir: string, workspacePath: string): boolean {
  try {
    if (binding.path !== join(jobRootDir, "dependency-preflight.json") || binding.jobRoot.path !== jobRootDir ||
      binding.workspacePath !== workspacePath) return false;
    const status = lstatSync(binding.path);
    if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o7777) !== 0o600 || status.size > 256 * 1024) return false;
    const digest = createHash("sha256").update(researchPromptBytes(binding.jobRoot, binding.path)).digest("hex");
    const after = lstatSync(binding.path);
    return (["dev", "ino", "mode", "uid", "gid", "nlink", "size", "ctimeMs", "mtimeMs"] as const).every(key =>
      status[key] === after[key]) && digest === binding.sha256;
  } catch { return false; }
}

export async function runDependencyBootstrap(
  input: DependencyBootstrapInput,
): Promise<DependencyPreflightResult> {
  input = captureLegacyDependencyWriterInput(input);
  const canonicalWorkspacePath = await realpath(input.workspacePath);
  assertLegacyDependencyWriterWorkspace(input.workspacePath);
  return runDependencyBootstrapUnlocked({
    ...input,
    workspacePath: canonicalWorkspacePath,
  });
}

async function runDependencyBootstrapUnlocked(
  input: DependencyBootstrapInput,
): Promise<DependencyPreflightResult> {
  assertLegacyDependencyWriterWorkspace(input.workspacePath);
  const mode = input.mode ?? "preflight";
  const preflight = await inspectDependencyBootstrap(input.workspacePath, mode);
  if (mode === "off") {
    if (!input.jobRootDir) return preflight;
    const diagnosticPath = await writeDependencyPreflightDiagnostic(
      input.jobRootDir,
      preflight,
    );
    return { ...preflight, diagnosticPath };
  }
  const cacheRoot = await resolveDependencyCacheRoot(input);
  let withCommand = attachInstallCommand(preflight, cacheRoot);

  if (input.jobRootDir) {
    const diagnosticPath = await writeDependencyPreflightDiagnostic(
      input.jobRootDir,
      withCommand,
    );
    withCommand = { ...withCommand, diagnosticPath };
  }
  if (mode !== "install" || !withCommand.packageManager) return withCommand;
  if (!input.confirmInstall) {
    return {
      ...withCommand,
      status: "install_failed",
      warnings: [
        ...withCommand.warnings,
        "dependency_install_requires_confirmDependencyBootstrap",
      ],
    };
  }

  try {
    assertLegacyDependencyWriterWorkspace(input.workspacePath);
    const install = await runPackageManagerInstall({
      workspacePath: input.workspacePath,
      packageManager: withCommand.packageManager,
      ...(withCommand.fingerprint
        ? { fingerprint: withCommand.fingerprint }
        : {}),
      ...(cacheRoot ? { cacheRoot } : {}),
      ...(input.runCommand ? { runCommand: input.runCommand } : {}),
    });
    const installed = await inspectDependencyBootstrap(
      input.workspacePath,
      mode,
    );
    const placementWarnings = cacheRoot
      ? await dependencyCachePlacementWarnings(
          input.workspacePath,
          cacheRoot,
          withCommand.packageManager.name,
        )
      : [];
    let result = attachInstallCommand(
      {
        ...installed,
        status: installed.status === "unsafe" ? "unsafe" : "installed",
        warnings: [...installed.warnings, ...placementWarnings],
        ...(install.sanitizedDependencyPaths.length > 0
          ? { sanitizedDependencyPaths: install.sanitizedDependencyPaths }
          : {}),
        ...(install.lockPath ? { cacheLockPath: install.lockPath } : {}),
        ...(install.waitMs !== undefined
          ? { cacheLockWaitMs: install.waitMs }
          : {}),
        ...(install.staleLockRecovered
          ? { staleCacheLockRecovered: true }
          : {}),
      },
      cacheRoot,
    );
    if (input.jobRootDir) {
      const diagnosticPath = await writeDependencyPreflightDiagnostic(
        input.jobRootDir,
        result,
      );
      result = { ...result, diagnosticPath };
    }
    return result;
  } catch (error) {
    let result: DependencyPreflightResult = {
      ...withCommand,
      status: "install_failed",
      warnings: [
        ...withCommand.warnings,
        `dependency_install_failed:${safeErrorMessage(error)}`,
      ],
    };
    if (input.jobRootDir) {
      const diagnosticPath = await writeDependencyPreflightDiagnostic(
        input.jobRootDir,
        result,
      );
      result = { ...result, diagnosticPath };
    }
    return result;
  }
}

export async function inspectDependencyBootstrap(
  workspacePath: string,
  mode: DependencyBootstrapMode = "preflight",
): Promise<DependencyPreflightResult> {
  assertLegacyDependencyWriterWorkspace(workspacePath);
  const dependencySafety = await inspectNodeDependencyEnvironment({ workspacePath });
  return inspectDependencyBootstrapMetadata(workspacePath, mode, legacyDependencyInspectionFiles, dependencySafety);
}

async function runPackageManagerInstall(input: {
  readonly workspacePath: string;
  readonly packageManager: DependencyPackageManager;
  readonly fingerprint?: string;
  readonly cacheRoot?: string;
  readonly runCommand?: DependencyBootstrapInput["runCommand"];
}): Promise<{
  readonly sanitizedDependencyPaths: readonly string[];
  readonly lockPath?: string;
  readonly waitMs?: number;
  readonly staleLockRecovered?: boolean;
}> {
  const commands = packageManagerInstallCommands(
    input.packageManager,
    input.cacheRoot,
  );
  const runCommand = input.runCommand ?? defaultRunCommand;
  if (input.cacheRoot) {
    await mkdir(input.cacheRoot, { recursive: true, mode: 0o700 });
  }
  const install = async (): Promise<readonly string[]> =>
    withDependencyBootstrapWorkspaceTransaction({
      workspacePath: input.workspacePath,
      action: async () => {
        const sanitized =
          input.packageManager.name === "uv"
            ? { removedPaths: [] as readonly string[] }
            : await sanitizeNodeDependencyEnvironment({
                workspacePath: input.workspacePath,
              });
        for (const command of commands) {
          assertLegacyDependencyWriterWorkspace(input.workspacePath);
          await runCommand(command[0] ?? "", command.slice(1), {
            cwd: input.workspacePath,
            timeoutMs: 120_000,
          });
        }
        return sanitized.removedPaths;
      },
    });
  if (!input.cacheRoot || !input.fingerprint) {
    return { sanitizedDependencyPaths: await install() };
  }
  const locked = await withDependencyBootstrapLock(
    {
      cacheRoot: input.cacheRoot,
      fingerprint: input.fingerprint,
    },
    install,
  );
  return {
    sanitizedDependencyPaths: locked.value,
    lockPath: locked.lockPath,
    waitMs: locked.waitMs,
    staleLockRecovered: locked.staleLockRecovered,
  };
}

function attachInstallCommand(
  result: DependencyPreflightResult,
  cacheRoot: string | undefined,
): DependencyPreflightResult {
  if (!result.packageManager) return result;
  return {
    ...result,
    ...(cacheRoot ? { cacheRoot } : {}),
    installCommand: packageManagerInstallCommands(
      result.packageManager,
      cacheRoot,
    )
      .map((command) => command.join(" "))
      .join(" && "),
  };
}

function packageManagerInstallCommands(
  packageManager: DependencyPackageManager,
  cacheRoot: string | undefined,
): readonly (readonly string[])[] {
  switch (packageManager.name) {
    case "pnpm": {
      const storeArgs = cacheRoot
        ? ["--store-dir", join(cacheRoot, "pnpm-store")]
        : [];
      return [
        [
          "pnpm",
          "fetch",
          "--frozen-lockfile",
          "--package-import-method=copy",
          "--config.side-effects-cache=false",
          ...storeArgs,
        ],
        [
          "pnpm",
          "install",
          "--offline",
          "--frozen-lockfile",
          "--package-import-method=copy",
          "--ignore-scripts",
          "--config.side-effects-cache=false",
          ...storeArgs,
        ],
        [
          "pnpm",
          "rebuild",
          "--config.side-effects-cache=false",
          ...storeArgs,
        ],
      ];
    }
    case "npm":
      return [
        [
          "npm",
          "ci",
          "--prefer-offline",
          ...(cacheRoot ? ["--cache", join(cacheRoot, "npm-cache")] : []),
        ],
      ];
    case "yarn":
      return [
        [
          "yarn",
          "install",
          "--frozen-lockfile",
          ...(cacheRoot
            ? ["--cache-folder", join(cacheRoot, "yarn-cache")]
            : []),
        ],
      ];
    case "bun":
      return [
        [
          "bun",
          "install",
          "--frozen-lockfile",
          ...(cacheRoot ? ["--cache-dir", join(cacheRoot, "bun-cache")] : []),
        ],
      ];
    case "uv":
      return [
        [
          "uv",
          "sync",
          "--locked",
          ...(cacheRoot ? ["--cache-dir", join(cacheRoot, "uv-cache")] : []),
        ],
      ];
  }
}

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<void> {
  assertLegacyDependencyWriterWorkspace(options.cwd);
  await execFileAsync(command, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
    },
  });
}

async function writeDependencyPreflightDiagnostic(
  jobRootDir: string,
  result: DependencyPreflightResult,
): Promise<string> {
  await mkdir(jobRootDir, { recursive: true, mode: 0o700 });
  const diagnosticPath = join(jobRootDir, "dependency-preflight.json");
  await writeFile(
    diagnosticPath,
    `${JSON.stringify(
      {
        ...result,
        diagnosticPath,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return diagnosticPath;
}

async function dependencyCachePlacementWarnings(
  workspacePath: string,
  cacheRoot: string,
  packageManager: DependencyPackageManagerName,
): Promise<readonly string[]> {
  if (packageManager !== "pnpm" && packageManager !== "uv") return [];
  try {
    const [workspaceStat, cacheStat] = await Promise.all([
      stat(workspacePath),
      stat(cacheRoot),
    ]);
    return workspaceStat.dev === cacheStat.dev
      ? []
      : ["dependency_cache_cross_filesystem_linking_disabled"];
  } catch {
    return ["dependency_cache_filesystem_check_failed"];
  }
}


function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
