import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import { basename, join } from "node:path";
import type { DependencyInspectionFiles } from "./dependency-inspection-files";
import type { DependencyBootstrapMode, DependencyPreflightResult, DependencyPackageManager,
  DependencyPackageManagerName, DependencyBinaryCheck } from "./dependency-bootstrap";
type NodeDependencyPackageManagerName = Exclude<DependencyPackageManagerName, "uv">;

/** Shared metadata calculation. The owning adapter must validate its read scope. */
export async function inspectDependencyBootstrapMetadata(workspacePath: string,
  mode: DependencyBootstrapMode, files: DependencyInspectionFiles,
  dependencySafety: { readonly unsafeDependencyRoots: readonly string[] }): Promise<DependencyPreflightResult> {
  if (mode === "off") {
    return withDependencySafety(
      baseResult(workspacePath, mode, "off"),
      dependencySafety.unsafeDependencyRoots,
    );
  }
  const packageJsonPath = join(workspacePath, "package.json");
  if (!(await pathExists(files, packageJsonPath))) {
    return withDependencySafety(
      await inspectPythonDependencyBootstrap(files, workspacePath, mode),
      dependencySafety.unsafeDependencyRoots,
    );
  }

  const packageJson = await readPackageJson(files, packageJsonPath);
  const packageManager = await detectPackageManager(files, workspacePath, packageJson);
  const fingerprintInputs = await dependencyFingerprintInputs(files, {
    workspacePath,
    packageJsonPath,
    packageManager,
  });
  const fingerprint = hashStrings(fingerprintInputs);
  const nodeModulesPath = join(workspacePath, "node_modules");
  const nodeModulesExists = await pathExists(files, nodeModulesPath);
  const binaryChecks = await dependencyBinaryChecks(files, workspacePath, packageJson);

  return withDependencySafety(
    {
      mode,
      workspacePath,
      ecosystem: "node",
      manifestPath: packageJsonPath,
      environmentPath: nodeModulesPath,
      environmentExists: nodeModulesExists,
      packageJsonPath,
      packageManager,
      nodeModulesPath,
      nodeModulesExists,
      binaryChecks,
      fingerprint,
      fingerprintInputs,
      status: nodeModulesExists ? "ready" : "deps_missing",
      warnings: nodeModulesExists ? [] : ["node_modules_missing"],
    },
    dependencySafety.unsafeDependencyRoots,
  );
}
async function detectPackageManager(files: DependencyInspectionFiles,
  workspacePath: string,
  packageJson: Record<string, unknown>,
): Promise<DependencyPackageManager> {
  const packageManagerSpec =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager
      : undefined;
  const packageManagerName = packageManagerSpec?.split("@")[0];
  if (isNodePackageManagerName(packageManagerName)) {
    return {
      name: packageManagerName,
      source: "packageManager",
      ...(packageManagerSpec ? { versionSpec: packageManagerSpec } : {}),
      ...(await lockfileForPackageManager(files, workspacePath, packageManagerName)),
    };
  }

  for (const candidate of [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ] as const) {
    const lockfilePath = join(workspacePath, candidate[0]);
    if (await pathExists(files, lockfilePath)) {
      return {
        name: candidate[1],
        source: "lockfile",
        lockfilePath,
      };
    }
  }
  return { name: "npm", source: "fallback" };
}

async function lockfileForPackageManager(files: DependencyInspectionFiles,
  workspacePath: string,
  name: NodeDependencyPackageManagerName,
): Promise<Pick<DependencyPackageManager, "lockfilePath">> {
  const lockfiles: Record<NodeDependencyPackageManagerName, readonly string[]> =
    {
      pnpm: ["pnpm-lock.yaml"],
      npm: ["package-lock.json", "npm-shrinkwrap.json"],
      yarn: ["yarn.lock"],
      bun: ["bun.lockb", "bun.lock"],
    };
  for (const lockfile of lockfiles[name]) {
    const lockfilePath = join(workspacePath, lockfile);
    if (await pathExists(files, lockfilePath)) return { lockfilePath };
  }
  return {};
}

async function dependencyFingerprintInputs(files: DependencyInspectionFiles, input: {
  readonly workspacePath: string;
  readonly packageJsonPath: string;
  readonly packageManager: DependencyPackageManager;
}): Promise<readonly string[]> {
  const inputs = [
    `node=${process.versions.node}`,
    `platform=${platform()}`,
    `arch=${arch()}`,
    `packageManager=${input.packageManager.name}`,
    `packageManagerSource=${input.packageManager.source}`,
    input.packageManager.versionSpec
      ? `packageManagerSpec=${input.packageManager.versionSpec}`
      : undefined,
    `package.json=${await fileHash(files, input.packageJsonPath)}`,
  ].filter((value): value is string => Boolean(value));
  if (input.packageManager.lockfilePath) {
    return [
      ...inputs,
      `${basename(input.packageManager.lockfilePath)}=${await fileHash(files,
        input.packageManager.lockfilePath,
      )}`,
    ];
  }
  return inputs;
}

async function dependencyBinaryChecks(files: DependencyInspectionFiles,
  workspacePath: string,
  packageJson: Record<string, unknown>,
): Promise<readonly DependencyBinaryCheck[]> {
  const scripts =
    typeof packageJson.scripts === "object" && packageJson.scripts !== null
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  const names = new Set<string>(["tsc"]);
  if (typeof scripts.test === "string") names.add("vitest");
  if (typeof scripts.lint === "string") names.add("eslint");
  const binDir = join(workspacePath, "node_modules", ".bin");
  return Promise.all(
    [...names].sort().map(async (name) => {
      const path = join(binDir, name);
      return {
        name,
        path,
        exists: await pathExists(files, path),
      };
    }),
  );
}

async function readPackageJson(files: DependencyInspectionFiles, path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse((await files.readFile(path)).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function fileHash(files: DependencyInspectionFiles, path: string): Promise<string> {
  return createHash("sha256")
    .update(await files.readFile(path))
    .digest("hex");
}

function hashStrings(values: readonly string[]): string {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

function isNodePackageManagerName(
  value: string | undefined,
): value is NodeDependencyPackageManagerName {
  return (
    value === "pnpm" || value === "npm" || value === "yarn" || value === "bun"
  );
}

async function inspectPythonDependencyBootstrap(files: DependencyInspectionFiles,
  workspacePath: string,
  mode: DependencyBootstrapMode,
): Promise<DependencyPreflightResult> {
  const pyprojectPath = join(workspacePath, "pyproject.toml");
  const uvLockPath = join(workspacePath, "uv.lock");
  if (!(await pathExists(files, pyprojectPath)) || !(await pathExists(files, uvLockPath))) {
    return baseResult(workspacePath, mode, "unsupported_project");
  }
  const pythonVersionPath = join(workspacePath, ".python-version");
  const environmentPath = join(workspacePath, ".venv");
  const pythonPath = join(environmentPath, "bin", "python");
  const environmentExists = await pathExists(files, pythonPath);
  const fingerprintInputs = [
    `platform=${platform()}`,
    `arch=${arch()}`,
    "packageManager=uv",
    `pyproject.toml=${await fileHash(files, pyprojectPath)}`,
    `uv.lock=${await fileHash(files, uvLockPath)}`,
    ...((await pathExists(files, pythonVersionPath))
      ? [`.python-version=${await fileHash(files, pythonVersionPath)}`]
      : []),
  ];
  const binaryChecks = await Promise.all(
    ["python", "pytest", "ruff"].map(async (name) => {
      const path = join(environmentPath, "bin", name);
      return { name, path, exists: await pathExists(files, path) };
    }),
  );
  return {
    mode,
    workspacePath,
    ecosystem: "python",
    manifestPath: pyprojectPath,
    environmentPath,
    environmentExists,
    packageManager: {
      name: "uv",
      source: "lockfile",
      lockfilePath: uvLockPath,
    },
    nodeModulesPath: join(workspacePath, "node_modules"),
    nodeModulesExists: false,
    binaryChecks,
    fingerprint: hashStrings(fingerprintInputs),
    fingerprintInputs,
    status: environmentExists ? "ready" : "deps_missing",
    warnings: environmentExists ? [] : ["python_environment_missing"],
  };
}

async function pathExists(files: DependencyInspectionFiles, path: string): Promise<boolean> {
  try {
    await files.access(path);
    return true;
  } catch {
    return false;
  }
}

function baseResult(
  workspacePath: string,
  mode: DependencyBootstrapMode,
  status: DependencyPreflightResult["status"],
): DependencyPreflightResult {
  return {
    mode,
    workspacePath,
    nodeModulesPath: join(workspacePath, "node_modules"),
    nodeModulesExists: false,
    binaryChecks: [],
    fingerprintInputs: [],
    status,
    warnings: [],
  };
}

function withDependencySafety(
  result: DependencyPreflightResult,
  unsafeDependencyPaths: readonly string[],
): DependencyPreflightResult {
  if (unsafeDependencyPaths.length === 0) return result;
  return {
    ...result,
    status: "unsafe",
    unsafeDependencyPaths,
    warnings: [
      ...result.warnings,
      `dependency_environment_unsafe:${unsafeDependencyPaths.join(",")}`,
    ],
  };
}
