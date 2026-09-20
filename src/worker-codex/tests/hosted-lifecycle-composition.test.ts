// Independent composition: actual use cases, CLI parser, route, foreground and shared ops.
// Substituted boundaries: host authority/OS process, status/doctor, manifest, goal execution.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const h=vi.hoisted(()=>({role:'supervisor',events:[] as string[], argv:[] as string[], doctorOk:false, status:{} as any, runStatus:'completed', outcome:0, fail:'', clientOk:true,inner:undefined as any}));
vi.mock('../hosted-readonly-supervisor-host',()=>({HostedReadonlySupervisorHost:class{
 runtimeRole(){if(h.fail==='role')throw Error('TEST foreign cgroup');return h.role}
 readEpoch(){return {identity:{jobId:'TEST',jobRootDir:'/TEST/job',workspacePath:'/TEST/W'}}}
 runRuntimeLaunch(command:string,args:string[],cwd:string,submit:any){h.events.push('reserve');if(h.fail==='admission')throw Error('TEST missing grant');h.argv=args;return submit({command:'/TEST/systemd-run',args:[]})}
 recordRuntimeWaitCompletion(){h.events.push('receipt');if(h.fail==='receipt')throw Error('TEST queue held')}
 closeRuntimeLaunch(){h.events.push('close')}
 stopRuntime(){h.events.push('stop')}
}}));
vi.mock('node:child_process',async original=>({...await original<any>(),execFile:vi.fn(()=>{throw Error('TEST external exec forbidden')}),spawn:vi.fn(()=>{
 const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),kill:()=>{h.events.push('kill');return true}});
 queueMicrotask(async()=>{h.role='runtime';const argv=h.argv.slice(1);if(h.fail==='inner-status')h.status.recommendedAction='review';h.inner=await runCodexGoalCli(argv,io);child.emit('exit',h.inner,null)});return child;
})}));
vi.mock('node:fs/promises',async original=>({...await original<any>(),mkdir:vi.fn(async()=>{h.events.push('mkdir')})}));
vi.mock('../hosted-readonly-controller-admission',()=>({admitHostedControllerLaunch:async()=>{h.events.push('admit');if(h.fail==='inner')throw Error('TEST revoked')}}));
vi.mock('../application/codex-goal-job-launch-loader',()=>({loadJobLaunch:async(args:any)=>{h.events.push('reload:'+args.registryRootDir);return {launch,registryRootDir:args.registryRootDir,manifest:{jobId:'TEST'}}}}));
vi.mock('../codex-goal-launch-manifest',()=>({upsertCodexGoalLaunchManifest:async()=>{h.events.push('manifest');return {jobId:'TEST'}}}));
vi.mock('../project-control-scope-guard',async original=>({...await original<any>(),projectControlGenericScopeDenial:async()=>undefined,projectControlGenericToolDenial:()=>undefined}));
vi.mock('../codex-goal-runner',async original=>({...await original<any>(),runCodexGoal:async()=>{h.events.push('goal-effect');return {status:h.runStatus}}}));
vi.mock('../codex-goal-doctor',async original=>({...await original<any>(),doctorCodexGoal:async(input:any)=>{expect(input.tmuxSession).toBeUndefined();expect(input.config).toMatchObject({promptPath:'/TEST/job/prompt',authRootDir:'/TEST/auth',workspacePath:'/TEST/W',accounts:[{name:'synthetic'}]});h.events.push('doctor');return {ok:h.doctorOk,errors:['TEST missing prerequisite']}}}));
vi.mock('../application/codex-goal-process-liveness',async original=>({...await original<any>(),resolveCodexGoalWorkerLiveness:()=>({alive:h.status.tmuxAlive === true})}));
import * as ops from '../codex-goal-ops';
vi.mock('../codex-goal-mcp-client',async original=>({...await original<any>(),superviseCodexGoalProjectController:async()=>{h.events.push('supervise-dispatch');return {ok:h.clientOk,start:{ok:h.clientOk}}},callCodexGoalMcpTool:async()=>{h.events.push('broker-dispatch');return {ok:h.clientOk,reason:h.clientOk?'completed':'TEST denied'}}}));
import { startCodexGoalLaunch } from '../application/codex-goal-operation-use-cases';
import { continueStoredJobLifecycle } from '../application/codex-goal-job-lifecycle-use-cases';
import { runCodexGoalCli } from '../codex-goal-cli';
import { startCodexGoalTmux } from '../codex-goal-ops';
const launch:any={config:{jobId:'TEST',taskId:'TEST',jobRootDir:'/TEST/job',workspacePath:'/TEST/W',authRootDir:'/TEST/auth',promptPath:'/TEST/job/prompt',accounts:[{name:'synthetic'}],sourceEnv:{SUBSCRIPTION_RUNTIME_SANDBOX_KIND:'hosted-codex-job'}},cliCommand:['/TEST/node','/TEST/cli'],cwd:'/TEST/W',tmuxSession:'foreign',logPath:'/TEST/job/log'};
const io={cwd:()=>'/TEST/W',env:()=>launch.config.sourceEnv,writeStdout:()=>{},writeStderr:(s:string)=>{h.events.push("stderr:"+s)}};
const start=()=>startCodexGoalLaunch({launch,registryRootDir:'/TEST/registry',jobId:'TEST',confirmStart:true,skipDoctor:false,forceStart:true});
const resume=(skipDoctor=false)=>continueStoredJobLifecycle({confirmContinue:true,forceStart:true,skipDoctor},{mode:'continue',confirmKey:'confirmContinue'},{loadJobLaunch:async()=>({launch,registryRootDir:'/TEST/registry',manifest:{jobId:'TEST'} as any})});
beforeEach(()=>{h.role='supervisor';h.events=[];h.argv=[];h.doctorOk=false;h.runStatus='completed';h.fail='';h.status={tmuxAlive:false,recommendedAction:'start_worker',resultExists:true,workspaceDirty:true};h.inner=undefined;h.clientOk=true;vi.spyOn(ops,'collectCodexGoalStatus').mockImplementation(async()=>h.status);vi.spyOn(ops,'reconcileCodexGoalRuntimeResult').mockImplementation(async(input)=>{expect(input.preservePatch).toBe(true);h.events.push('reconcile-preserve-patch');if(h.fail==='reconcile')throw Error('TEST patch preservation failed');return {} as any});});
afterEach(()=>vi.unstubAllEnvs());
for (const role of ['supervisor', 'runtime']) {
  for (const operation of ['start', 'continue', 'recover'] as const) {
    for (const doctorOk of [false, true]) {
      it(`${role} ${operation}: doctor=${doctorOk} gates effects inside admission`, async () => {
        h.role = role; h.doctorOk = doctorOk;
        const result = operation === 'start' ? await start() : await continueStoredJobLifecycle(
          { confirmContinue: true, confirmRecover: true, forceStart: true, staleAfterMs: 12345 },
          { mode: operation, confirmKey: operation === 'continue' ? 'confirmContinue' : 'confirmRecover' },
          { loadJobLaunch: async () => ({ launch, registryRootDir: '/TEST/registry', manifest: { jobId: 'TEST' } as any }) });
        expect(result.ok).toBe(doctorOk);
        expect(h.events.indexOf('admit')).toBeLessThan(h.events.indexOf('doctor'));
        expect(h.events.includes('goal-effect')).toBe(doctorOk);
        expect(h.events.includes('reconcile-preserve-patch')).toBe(doctorOk && operation !== 'start');
        if (doctorOk && operation !== 'start') {
          expect(h.events.indexOf('doctor')).toBeLessThan(h.events.indexOf('reconcile-preserve-patch'));
          expect(h.events.indexOf('reconcile-preserve-patch')).toBeLessThan(h.events.indexOf('goal-effect'));
        }
        if (role === 'supervisor') {
          expect(h.argv).toContain('--registry-root');
          expect(h.argv[h.argv.indexOf('--hosted-lifecycle') + 1]).toBe(operation);
          if (operation !== 'start') {
            expect(h.argv).toContain('12345');
            expect(h.events).toContain('reload:/TEST/registry');
            expect(h.events.indexOf('admit')).toBeLessThan(h.events.indexOf('reload:/TEST/registry'));
          }
        }
      });
    }
    it(`${role} ${operation}: explicit skipDoctor still preserves patches`, async () => {
      h.role = role;
      const result = operation === 'start'
        ? await startCodexGoalLaunch({launch, registryRootDir:'/TEST/registry', jobId:'TEST', confirmStart:true, skipDoctor:true, forceStart:true})
        : await continueStoredJobLifecycle({ confirmContinue:true, confirmRecover:true, forceStart:true, skipDoctor:true },
          {mode:operation, confirmKey:operation === 'continue' ? 'confirmContinue' : 'confirmRecover'},
          {loadJobLaunch:async()=>({launch,registryRootDir:'/TEST/registry',manifest:{jobId:'TEST'} as any})});
      expect(result.ok).toBe(true);expect(h.events).not.toContain('doctor');expect(h.events).toContain('goal-effect');
      if(operation !== 'start')expect(h.events.indexOf('reconcile-preserve-patch')).toBeLessThan(h.events.indexOf('goal-effect'));
    });
  }
}
for(const flags of [['--no-tmux'],['--tmux-session','foreign']])it('positive complete CLI roundtrip '+flags.join(' '),async()=>{
 const result=await runCodexGoalCli(['run','--job-root','/TEST/job','--job-id','TEST','--task-id','TEST','--workspace','/TEST/W','--auth-root','/TEST/auth','--prompt','/TEST/job/prompt','--accounts','synthetic','--registry-root','/TEST/registry',...flags],io);
 expect(result).toBe(0);expect(h.events).toEqual(['reserve','admit','manifest','goal-effect','receipt','close']);
});
for(const failure of ['admission','role','inner','receipt'])it('negative CLI roundtrip '+failure,async()=>{
 h.fail=failure;const result=await runCodexGoalCli(['run','--job-root','/TEST/job','--job-id','TEST','--task-id','TEST','--workspace','/TEST/W','--auth-root','/TEST/auth','--prompt','/TEST/job/prompt','--accounts','synthetic','--no-tmux'],io);
 expect(result).not.toBe(0);if(failure!=='receipt')expect(h.events).not.toContain('goal-effect');
});
it('shared admitted runtime reports provider failure as failed, not scheduled/completed',async()=>{h.role='runtime';h.runStatus='failed';expect(await startCodexGoalTmux(launch)).toMatchObject({launchState:'failed'});expect(h.events).not.toContain('reserve')});

for(const command of ['controller-supervise','mcp-tool'])for(const ok of [true,false])it('fixed CLI outer transport '+command+' result='+ok,async()=>{
 vi.stubEnv('SUBSCRIPTION_RUNTIME_SANDBOX_KIND','hosted-codex-job');h.clientOk=ok;
 const argv=command==='controller-supervise'?['controller-supervise','--controller-job-id','TEST','--format','json']:['tool','codex_goal_project_start','--args-json','{"jobId":"TEST"}','--format','json'];
 const result=await runCodexGoalCli(argv,io);expect(h.events[0]).toBe('reserve');expect(h.events).toContain(command==='controller-supervise'?'supervise-dispatch':'broker-dispatch');
 if(command==='controller-supervise'){expect(result).toBe(ok?0:1);expect(h.events.includes('receipt')).toBe(ok)}else {expect(result).toBe(0);expect(h.events).toContain('receipt')}
});
it('ordinary nonmanaged controller command keeps direct dispatch',async()=>{vi.stubEnv('SUBSCRIPTION_RUNTIME_SANDBOX_KIND','');expect(await runCodexGoalCli(['controller-supervise','--controller-job-id','TEST'],io)).toBe(0);expect(h.events).toEqual(['supervise-dispatch'])});

for (const role of ['supervisor', 'runtime']) for (const operation of ['start', 'continue', 'recover'] as const) {
  const invoke = (confirmed = true, forceStart = false) => operation === 'start'
    ? startCodexGoalLaunch({launch,registryRootDir:'/TEST/registry',jobId:'TEST',confirmStart:confirmed,skipDoctor:false,forceStart})
    : continueStoredJobLifecycle({confirmContinue:confirmed,confirmRecover:confirmed,forceStart},
      {mode:operation,confirmKey:operation === 'continue' ? 'confirmContinue' : 'confirmRecover'},
      {loadJobLaunch:async()=>({launch,registryRootDir:'/TEST/registry',manifest:{jobId:'TEST'} as any})});
  it(`${role} ${operation}: confirmation, live worker and status denial precede effects`, async () => {
    h.role=role;
    expect((await invoke(false)).ok).toBe(false);
    h.status.tmuxAlive=true;expect(await invoke()).toMatchObject({ok:false,reason:'worker_already_running'});
    h.status.tmuxAlive=false;h.status.recommendedAction='review';expect(await invoke()).toMatchObject({ok:false,reason:'status_requires_review'});
    expect(h.events).not.toContain('reserve');expect(h.events).not.toContain('doctor');expect(h.events).not.toContain('goal-effect');
  });
  it(`${role} ${operation}: doctor rejection permits corrected retry`, async () => {
    h.role=role;expect((await invoke()).ok).toBe(false);expect(h.events).not.toContain('goal-effect');
    h.role=role;h.doctorOk=true;expect((await invoke()).ok).toBe(true);expect(h.events).toContain('goal-effect');
  });
  it(`${role} ${operation}: final goal failure is not successful completion`, async () => {
    h.role=role;h.doctorOk=true;h.runStatus='failed';expect((await invoke()).ok).toBe(false);
    expect(h.events).toContain('goal-effect');expect(h.events).not.toContain('receipt');
  });
  if(operation !== 'start') it(`${role} ${operation}: failed patch preservation blocks goal effects`, async () => {
    h.role=role;h.doctorOk=true;h.fail='reconcile';
    if(role==='runtime') await expect(invoke()).rejects.toThrow('TEST patch preservation failed');
    else expect((await invoke()).ok).toBe(false);
    expect(h.events).not.toContain('goal-effect');expect(h.events).not.toContain('receipt');
  });
}

for (const operation of ['start', 'continue', 'recover'] as const) it(`${operation}: inner status is rechecked after outer admission`, async () => {
  h.fail='inner-status';h.doctorOk=true;
  const result = operation === 'start'
    ? await startCodexGoalLaunch({launch,registryRootDir:'/TEST/registry',jobId:'TEST',confirmStart:true,skipDoctor:false,forceStart:false})
    : await continueStoredJobLifecycle({confirmContinue:true,confirmRecover:true},
      {mode:operation,confirmKey:operation === 'continue' ? 'confirmContinue' : 'confirmRecover'},
      {loadJobLaunch:async()=>({launch,registryRootDir:'/TEST/registry',manifest:{jobId:'TEST'} as any})});
  expect(result.ok).toBe(false);expect(h.events).toContain('reserve');expect(h.events).toContain('admit');
  expect(h.events).not.toContain('doctor');expect(h.events).not.toContain('goal-effect');
});

it('rejects unsupported lifecycle commands and a nonhosted lifecycle handoff', async () => {
  const base=['run','--job-root','/TEST/job','--job-id','TEST','--task-id','TEST','--workspace','/TEST/W','--auth-root','/TEST/auth','--prompt','/TEST/job/prompt','--accounts','synthetic','--registry-root','/TEST/registry','--lifecycle-job-id','TEST'];
  expect(await runCodexGoalCli([...base,'--hosted-lifecycle','stop'],io)).toBe(2);
  expect(await runCodexGoalCli([...base,'--hosted-lifecycle','start'],{...io,env:()=>({})})).toBe(2);
  expect(h.events).not.toContain('reserve');expect(h.events).not.toContain('goal-effect');
});

// Explicit noninstalled host facts for local-route controls. Hosted cases in
// this transport suite supply their separate synthetic supervisor boundary.
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real,
    lstatSync: (path: Parameters<typeof real.lstatSync>[0], options: Parameters<typeof real.lstatSync>[1]) => {
      if (path === "/var/lib/subscription-runtime-host-policy") throw Object.assign(new Error("synthetic absent installation"), { code: "ENOENT" });
      return real.lstatSync(path, options);
    },
    readFileSync: (path: Parameters<typeof real.readFileSync>[0], options: Parameters<typeof real.readFileSync>[1]) =>
      path === "/proc/self/cgroup" ? "0::/user.slice/offline-control.service\n" : real.readFileSync(path, options),
  };
});

// The managed transport fixture has a separately substituted EXCLUSIVE host.
// Actual installation/dispatch composition lives in hosted-ordinary-installation.
vi.mock("../hosted-installation-activation", async original => ({
  ...await original<typeof import("../hosted-installation-activation")>(),
  readHostedInstallationActivation: () => ({ activation: { phase: "EXCLUSIVE" } }),
}));
