// Adaptation of the independent controller harness. Green uses the actual
// scoped controller seed reader; baseline mirrors its verified raw-source
// read contract because that private baseline reader has no standalone entry.
// Hosted launch admission is not invoked or substituted by this contract E2E.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Peer, fresh, seed, rotated, newer, digest, child } from './codex-seed-publication.e2e.mts';
import type { CodexAppServerProcessFactory } from '../../provider-codex/index.js';
import type { CodexGoalLaunchInput } from '../codex-goal-ops.js';
import type { ProjectAccessScope } from '../../worker-core/index.js';

const repository = process.env.SR_SYNTHETIC_RUNTIME_COPY!;
async function runtime<T>(path: string): Promise<T> { return await import(pathToFileURL(join(repository, 'dist', path + '.js')).href) as T; }
const { LocalControlledAgentStateStore } = await runtime<typeof import('../../store-local-file/index.js')>('store-local-file/index');
const { buildCodexControlledAgentProfile, CodexControlledAgentProvider } = await runtime<typeof import('../controlled-agent/index.js')>('worker-codex/controlled-agent/index');
const { sessionArtifactFromCodexAuthJson } = await runtime<typeof import('../../provider-codex/index.js')>('provider-codex/index');
const { AccessBoundary, NetworkAccessMode, ControlledAgentRunStatus, startControlledAgentRun, reconcileControlledAgentRun } = await runtime<typeof import('../../worker-core/index.js')>('worker-core/index');
const { codexSessionCapacityAccountId } = await runtime<typeof import('../codex-session-capacity-identity.js')>('worker-codex/codex-session-capacity-identity');
const { codexAccountCapacityStore } = await runtime<typeof import('../application/codex-account-capacity-store.js')>('worker-codex/application/codex-account-capacity-store');
const { recordProjectControllerCapacitySignal } = await runtime<typeof import('../project-controller-capacity.js')>('worker-codex/project-controller-capacity');
const { listCodexGoalAccountStatuses } = await runtime<typeof import('../codex-goal-account-status.js')>('worker-codex/codex-goal-account-status');
const { selectProjectControllerCodexAccountSlot } = await runtime<typeof import('../application/project-control/codex-goal-project-controller-account-selection.js')>('worker-codex/application/project-control/codex-goal-project-controller-account-selection');
const adapter = await runtime<typeof import('../codex-provider-runtime-adapter.js')>('worker-codex/codex-provider-runtime-adapter');
function invariant(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
type Case = { id: string; passed: boolean; facts: Record<string, unknown>; error?: string };
const cases: Case[] = [];
async function scenario(id: string, run: (facts: Record<string, unknown>) => Promise<void>) {
  const facts: Record<string, unknown> = {};
  try { await run(facts); cases.push({ id, passed: true, facts }); }
  catch (error) { cases.push({ id, passed: false, facts, error: error instanceof Error ? error.message : 'unknown' }); }
  console.log(JSON.stringify(cases.at(-1)));
}
async function controller(root: string, invalid: boolean, replaceSource = false) {
  const workspace = join(root, 'projects/controller'); const stateDir = join(root, 'controller');
  await mkdir(workspace, { recursive: true });
  const scope: ProjectAccessScope = { projectId: 'synthetic', registryRoot: join(root, 'registry'), workspaceRoots: [join(root, 'projects')],
    worktreeRoots: [join(root, 'worktrees')], jobIdPrefixes: ['synthetic-'], tmuxSessionPrefixes: ['synthetic-'], allowedBranches: ['main'],
    allowedGitRemotes: ['origin'], allowedAccountIds: ['auth'], authRoot: root };
  const launch: CodexGoalLaunchInput = { cwd: workspace, logPath: join(root, 'synthetic.log'), cliCommand: ['/SYNTHETIC-NONEXISTENT'],
    config: { jobRootDir: stateDir, authRootDir: root, workspacePath: workspace, taskId: 'synthetic-controller',
      promptPath: join(root, 'synthetic-prompt.md'), accounts: [{ name: 'auth' }], model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default',
      sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1' }, requireGitWorkspace: false } };
  const slots = await listCodexGoalAccountStatuses({ authRootDir: root, accounts: ['auth'], liveCheck: false });
  const selected = selectProjectControllerCodexAccountSlot({ slots, allowedAccountIds: ['auth'] }); invariant(selected, 'synthetic_source_selected');
  const captured = typeof adapter.controlledAgentCodexAccount === 'function'
    ? await adapter.controlledAgentCodexAccount({ scope, launch })
    : await (async () => { const bytes = await readFile(selected.authJsonPath, 'utf8'); return {
      name: selected.name, sessionArtifact: sessionArtifactFromCodexAuthJson(bytes), capacitySessionId: codexSessionCapacityAccountId(JSON.parse(bytes))!,
      seedSource: undefined, onSessionInvalid: undefined,
    }; })();
  const imports: string[] = []; const peers: Peer[] = [];
  const factory: CodexAppServerProcessFactory = input => {
    const home = input.env.CODEX_HOME!; invariant(home.startsWith(root), 'synthetic_controller_home');
    const peer = new Peer(home, async (peer, path) => {
      const bytes = await readFile(join(path, 'auth.json'), 'utf8'); imports.push(digest(bytes));
      if (replaceSource) await writeFile(join(root, 'auth/auth.json'), newer, { mode: 0o600 });
      if (invalid || bytes !== rotated) peer.invalid(); else peer.complete();
    });
    peers.push(peer); return peer;
  };
  const profile = buildCodexControlledAgentProfile({ stateDir, rawShellMode: 'disabled-by-provider' });
  const provider = new CodexControlledAgentProvider({ profile, sessionArtifact: captured.sessionArtifact,
    ...(captured.seedSource ? { seedSource: captured.seedSource } : {}),
    ...(captured.onSessionInvalid ? { onSessionInvalid: captured.onSessionInvalid } : {}),
    workspacePath: workspace, codexBinaryPath: '/SYNTHETIC-NONEXISTENT', processFactory: factory,
    model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default', sourceEnv: { SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH: '1' } });
  const stateStore = new LocalControlledAgentStateStore({ rootDir: stateDir });
  const started = await startControlledAgentRun({ controllerJobId: 'synthetic-controller', sessionId: 'synthetic-controller', stateDir,
    boundary: AccessBoundary.ProjectScopedControl, networkAccess: NetworkAccessMode.Restricted, projectAccessScope: scope, provider: profile.enforcement,
  }, { provider, stateStore, events: stateStore, capacity: { accountId: 'auth', sessionId: captured.capacitySessionId!,
    demand: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } } });
  invariant(started.ok, 'actual_controller_launch_plan_ready');
  const deadline = performance.now() + 10_000;
  let status = provider.status({ session: started.session, run: started.run });
  while (status.status === ControlledAgentRunStatus.Running && performance.now() < deadline) {
    await setImmediate(); status = provider.status({ session: started.session, run: started.run });
  }
  invariant(status.status !== ControlledAgentRunStatus.Running, 'actual_controller_terminal_observed');
  const reconciled = await reconcileControlledAgentRun(started.session.sessionId, { stateStore, provider, events: stateStore });
  invariant(reconciled.ok, 'controller_lifecycle_persisted');
  recordProjectControllerCapacitySignal({ authRootDir: root, controllerJobId: 'synthetic-controller', config: { model: 'gpt-6.1-sol' }, run: reconciled.run });
  const out = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--read', root, started.run.runId], { env: { ...process.env }, timeout: 10_000 });
  return { status: status.status, imports, turnContracts: peers.flatMap(peer => peer.turnContracts), persisted: JSON.parse(out.stdout) as { status: string; capacitySessionId: string }, actualReader: Boolean(captured.seedSource) };
}
async function main() {
  await scenario('R3-controller-supported-seed-and-lifecycle-use-current-refresh', async facts => {
    const root = await fresh('controller'); await child(root, 'rotated'); const result = await controller(root, false);
    Object.assign(facts, { root, result, expectedHash: digest(rotated) });
    invariant(result.status === ControlledAgentRunStatus.Completed && result.persisted.status === ControlledAgentRunStatus.Completed && result.imports[0] === digest(rotated), 'controller_imported_obsolete_source_refresh');
    invariant(result.actualReader && result.persisted.capacitySessionId === codexSessionCapacityAccountId(JSON.parse(rotated)), 'actual_supported_reader_capture_persisted');
  });
  await scenario('controller-invalid-refresh-fences-source-lineage', async facts => {
    const root = await fresh('controller-invalid'); await child(root, 'rotated'); const result = await controller(root, true);
    const store = codexAccountCapacityStore(root); const now = new Date('2030-01-01');
    const actual = store.read({ accountId: codexSessionCapacityAccountId(JSON.parse(rotated))!, now });
    const source = store.read({ accountId: 'auth', now });
    Object.assign(facts, { root, result, actualDisabled: actual?.reason, sourceDisabled: source?.reason });
    invariant(result.status === ControlledAgentRunStatus.Failed && actual?.reason === 'provider_session_invalid' && source?.reason === 'provider_session_invalid', 'controller_failed_refresh_lineage_not_fenced');
  });
  await scenario('controller-stale-invalid-does-not-disable-new-authorization', async facts => {
    const root = await fresh('controller-relogin'); await child(root, 'rotated'); const result = await controller(root, true, true);
    const source = codexAccountCapacityStore(root).read({ accountId: 'auth', now: new Date('2030-01-01') });
    const next = await child(root, 'only-newest'); Object.assign(facts, { root, result, newSourceDisabled: source?.reason ?? null, next });
    invariant(result.status === ControlledAgentRunStatus.Failed && source?.reason !== 'provider_session_invalid' && next.completed, 'stale_controller_invalid_disabled_new_authorization');
  });
  await writeFile(join(dirname(repository), `${process.env.SR_SYNTHETIC_PHASE ?? 'unknown'}-controller.json`), JSON.stringify(cases, null, 2) + '\n');
  process.exitCode = cases.some(item => !item.passed) ? 1 : 0;
}
if (process.argv[2] === '--read') {
  const root = process.argv[3]!; invariant(root.includes('/artifacts/fixtures/synthetic-publication-'), 'synthetic_controller_fixture_only');
  const value = await new LocalControlledAgentStateStore({ rootDir: join(root, 'controller') }).readRun(process.argv[4]!);
  console.log(JSON.stringify({ status: value?.status, capacitySessionId: value?.capacitySessionId }));
} else await main();
