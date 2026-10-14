import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';

export const managedScratchToolEnvironmentKeys = [
  'GOTMPDIR', 'XDG_CACHE_HOME', 'npm_config_cache', 'COREPACK_HOME', 'YARN_CACHE_FOLDER',
  'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'GOCACHE', 'GOMODCACHE',
] as const;

/** Bootstrap-only config overlay: Codex 0.160 resolves :tmpdir from its actual
 * environment. Grant that verified leaf only in the named writer profile;
 * the reader, root denial and existing secret/code rules stay intact. */
export function managedProviderScratchLaunch(
  frameEnvironment: Readonly<Record<string, string>>,
  frameArguments: readonly string[],
): Readonly<{ environment: Readonly<Record<string, string>>; args: readonly string[] }> {
  const environment = managedProviderScratchEnvironment(frameEnvironment);
  // The verifier returns the original object only for non-managed providers.
  return { environment, args: environment === frameEnvironment ? frameArguments : [
    ...frameArguments, '--config', 'permissions.hosted-project-write.filesystem.:tmpdir="write"',
  ] };
}

/** Runs inside the installed managed provider bootstrap, after its descriptor
 * and final storage guards. The launch frame never selects this boundary. */
export function managedProviderScratchEnvironment(
  frameEnvironment: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const launch = process.env;
  if (launch.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH === undefined) return frameEnvironment;
  const denied = (): never => { throw new Error('hosted_provider_scratch_boundary_invalid'); };
  const jobId = launch.SUBSCRIPTION_RUNTIME_JOB_ID ?? denied();
  const root = launch.SUBSCRIPTION_RUNTIME_JOB_ROOT ?? denied();
  if (launch.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH !== '1' ||
      launch.SUBSCRIPTION_RUNTIME_HOST_JOB_ID !== undefined ||
      !jobId || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(jobId) ||
      !root || !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(root) ||
      root.split('/').some(part => part === '.' || part === '..') ||
      !root.endsWith(`/jobs/${jobId}`)) denied();
  const tmp = `${root}/tmp`;
  if (launch.TMPDIR !== tmp || launch.TMP !== tmp || launch.TEMP !== tmp ||
      !/\/subscription-runtime-hosted-[a-f0-9-]{36}\.service(?:\n|$)/.test(readFileSync('/proc/self/cgroup', 'utf8'))) denied();
  const descriptors: number[] = [];
  try {
    for (const path of [root, tmp]) {
      const named = lstatSync(path);
      if (!named.isDirectory() || named.isSymbolicLink() || realpathSync(path) !== path ||
          named.dev === lstatSync('/').dev) denied();
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(fd);
      const opened = fstatSync(fd);
      if (opened.dev !== named.dev || opened.ino !== named.ino) denied();
    }
    const rootInfo = fstatSync(descriptors[0]!);
    const tmpInfo = fstatSync(descriptors[1]!);
    if (rootInfo.dev !== tmpInfo.dev) denied();
    const bulk = `${tmp}/tool-caches`;
    // Override only finite non-secret bulk defaults. Session HOME/CODEX_HOME,
    // Cargo/Rustup lookup and the rest of the pruned frame remain unchanged.
    const environment = { ...frameEnvironment,
      TMPDIR: tmp, TMP: tmp, TEMP: tmp, GOTMPDIR: tmp,
      XDG_CACHE_HOME: bulk, npm_config_cache: `${bulk}/npm`,
      COREPACK_HOME: `${bulk}/corepack`, YARN_CACHE_FOLDER: `${bulk}/yarn`,
      PIP_CACHE_DIR: `${bulk}/pip`, UV_CACHE_DIR: `${bulk}/uv`,
      GOCACHE: `${bulk}/go-build`, GOMODCACHE: `${bulk}/go-mod`,
    };
    for (const [index, path] of [root, tmp].entries()) {
      const opened = fstatSync(descriptors[index]!); const current = lstatSync(path);
      if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) denied();
    }
    return environment;
  } finally { for (const fd of descriptors) closeSync(fd); }
}
