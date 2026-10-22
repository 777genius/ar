import { mkdtempSync, mkdirSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedProviderScratchEnvironment, managedProviderScratchLaunch } from '../app-server/adapters/managed-provider-scratch-environment';

// Actual disposable directory and FD operations; only the fixed host root
// device and cgroup selector are substituted in this focused boundary test.
// This supplies no launch proof and never replaces the physical TEST E2E.
const facts = vi.hoisted(() => ({ cgroup: '0::/subscription-runtime-hosted.slice/subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service\n', rootDevice: -1 }));
vi.mock('node:fs', async original => {
  const real = await original<typeof import('node:fs')>();
  return { ...real,
    lstatSync: (path: string) => path === '/' ? Object.assign(real.lstatSync(path), { dev: facts.rootDevice }) : real.lstatSync(path),
    readFileSync: (path: string, encoding: 'utf8') => path === '/proc/self/cgroup' ? facts.cgroup : real.readFileSync(path, encoding),
  };
});
const owned: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); facts.rootDevice = -1; facts.cgroup = '0::/subscription-runtime-hosted.slice/subscription-runtime-hosted-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.service\n'; for (const root of owned.splice(0)) rmSync(root, { recursive: true }); });
function fixture(): string {
  // macOS TMPDIR is a /var -> /private/var alias; the boundary verifier
  // demands canonical paths, so allocate under the resolved temp base.
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'managed-provider-env-')); owned.push(parent);
  const root = join(parent, 'jobs', 'TEST'); mkdirSync(join(root, 'tmp'), { recursive: true, mode: 0o700 });
  for (const [key, value] of Object.entries({ SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1',
    SUBSCRIPTION_RUNTIME_JOB_ID: 'TEST', SUBSCRIPTION_RUNTIME_JOB_ROOT: root,
    TMPDIR: root + '/tmp', TMP: root + '/tmp', TEMP: root + '/tmp' })) vi.stubEnv(key, value);
  vi.stubEnv('SUBSCRIPTION_RUNTIME_HOST_JOB_ID', undefined);
  return root;
}
describe('provider bootstrap admitted scratch defaults', () => {
  it('binds native writer tmp permission to the physically verified launch, leaving named reader unchanged', () => {
    const root = fixture();
    const args = ['app-server', '--listen', 'stdio://', '--config', 'features.network_proxy.enabled=true'];
    const result = managedProviderScratchLaunch({ TMPDIR: '/outside', HOME: root + '/home/session/home' }, args);
    expect(result.environment.TMPDIR).toBe(root + '/tmp');
    expect(result.args.slice(0, args.length)).toEqual(args);
    // No permission profile, filesystem table or broad absolute rule is replaced.
    expect(result.args.slice(args.length)).toEqual(['--config', 'permissions.hosted-project-write.filesystem.:tmpdir="write"']);
    expect(result.args.join('\n')).not.toContain('permissions.hosted-project-read');
    expect(result.args.join('\n')).not.toContain(':root=');
    expect(result.args.join('\n')).not.toContain(':slash_tmp');
    facts.cgroup = '0::/user.slice\n';
    expect(() => managedProviderScratchLaunch({ TMPDIR: root + '/tmp' }, args)).toThrow('hosted_provider_scratch_boundary_invalid');
  });
  it('adds no tmp permission through an unverified caller environment', () => {
    vi.stubEnv('SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH', undefined);
    const args = ['app-server'];
    const frame = { TMPDIR: '/outside', SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1' };
    const result = managedProviderScratchLaunch(frame, args);
    expect(result.environment).toBe(frame);
    expect(result.args).toBe(args);
  });
  it('restores actual tool defaults after private launch-frame env replacement', () => {
    const root = fixture(); const home = root + '/home/session/home';
    vi.stubEnv('OPENAI_API_KEY', 'host-secret-must-not-pass');
    const result = managedProviderScratchEnvironment({ HOME: home, CODEX_HOME: root + '/home/session/codex-home',
      npm_config_cache: '/root/.npm', TMPDIR: '/tmp', PATH: '/usr/bin' });
    expect(result).toMatchObject({ HOME: home, CODEX_HOME: root + '/home/session/codex-home',
      TMPDIR: root + '/tmp', TMP: root + '/tmp', TEMP: root + '/tmp', GOTMPDIR: root + '/tmp',
      npm_config_cache: root + '/tmp/tool-caches/npm', XDG_CACHE_HOME: root + '/tmp/tool-caches',
      COREPACK_HOME: root + '/tmp/tool-caches/corepack', YARN_CACHE_FOLDER: root + '/tmp/tool-caches/yarn',
      PIP_CACHE_DIR: root + '/tmp/tool-caches/pip', UV_CACHE_DIR: root + '/tmp/tool-caches/uv',
      GOCACHE: root + '/tmp/tool-caches/go-build', GOMODCACHE: root + '/tmp/tool-caches/go-mod' });
    for (const key of ['OPENAI_API_KEY', 'RUSTUP_HOME', 'CARGO_HOME', 'SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH']) expect(result).not.toHaveProperty(key);
  });
  it('leaves non-managed provider environment unchanged', () => {
    vi.stubEnv('SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH', undefined);
    const original = { HOME: '/legacy/home', TMPDIR: '/legacy/tmp' };
    expect(managedProviderScratchEnvironment(original)).toBe(original);
  });
  it.each(['tmp', 'cgroup', 'root-device', 'outer-job', 'job-id'])('rejects %s before deriving writable defaults', fault => {
    fixture();
    if (fault === 'tmp') vi.stubEnv('TMPDIR', '/tmp');
    if (fault === 'cgroup') facts.cgroup = '0::/user.slice\n';
    if (fault === 'root-device') {
      // Read the fixture's actual device through a retained directory FD.
      const root = process.env.SUBSCRIPTION_RUNTIME_JOB_ROOT!;
      facts.rootDevice = lstatSync(root).dev;
    }
    if (fault === 'outer-job') vi.stubEnv('SUBSCRIPTION_RUNTIME_HOST_JOB_ID', 'TEST');
    if (fault === 'job-id') vi.stubEnv('SUBSCRIPTION_RUNTIME_JOB_ID', '../escape');
    expect(() => managedProviderScratchEnvironment({ HOME: '/unchanged' })).toThrow('hosted_provider_scratch_boundary_invalid');
  });
});
