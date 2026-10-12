import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSystemBusInfrastructure } from "@vioxen/subscription-runtime/core";
import { HostedActivationPhase, HostedCustodyReservationState } from "@vioxen/subscription-runtime/worker-core";
import { CodexProviderEgressProfileId } from "@vioxen/subscription-runtime/provider-codex";
import type { HostedInventoryCreator } from "../core/host-infrastructure/host-inventory";
import { parseDependencyToolRegistration } from "../core/dependency-environment/dependency-tool-profile";
import { parseDependencyToolAdmissionQualification, DependencyToolQualificationKind } from "../core/dependency-environment/dependency-tool-execution";
import { dependencyToolQualificationRecordName } from "../core/dependency-environment/dependency-tool-profile";
import { hostedDependencyJobRoot } from "../provider-codex/app-server/adapters/hosted-dependency-workspace";
import { assertHostedActivationOperator } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { assertHostedProcessDescriptors } from "../provider-codex/app-server/adapters/hosted-process-descriptors";
import { verifyPinnedFdCollectorProfile } from "../provider-codex/app-server/adapters/hosted-fd-observation";
import { verifySystemBusInfrastructure } from "../provider-codex/app-server/adapters/system-bus-infrastructure";
import { QualificationChild, QualificationClock, qualificationBootRecipe, qualificationBootUnit, qualificationBytes, qualificationCandidate,
  qualificationCopiedCohort, qualificationCreate, qualificationHeld, qualificationJson, qualificationObject, qualificationProfile,
  qualificationRead, qualificationRoot, qualificationSha, type OrdinaryLauncherCandidate } from "./hosted-ordinary-installation-qualification";
import { collectProcessBirth, collectProcessCgroup, collectUnitInvocation, collectUnitShow } from "./hosted-readonly-linux-collector";
import { collectOrdinaryInstallationDraft } from "./hosted-ordinary-installation-census";
import { publishReadonlyInventory } from "./hosted-readonly-custody";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
import { runHostedRuntimeForeground } from "./hosted-readonly-foreground";
import { hostedForegroundExitCode } from "./hosted-foreground-result";
import { assertOrdinaryInstallationOriginalClose } from "./hosted-ordinary-installation-owned";
import { writeHostedTestEgressGrant } from "./hosted-test-egress-files";
import { resolveStoredProjectStartPlan } from "./stored-start-planning";
import { trustedCustodySystemdRunExecutable, trustedOrdinaryUsableGuestWorkerLaunch } from "./trusted-custody-systemd-launch";

const entry = fileURLToPath(import.meta.url);
enum Role { Coordinator = "coordinator", Worker = "worker" }
type Input = Readonly<{ schemaVersion: 1; operation: { operationId: string; workEndEpochMs: number; cleanupEndEpochMs: number };
  candidate: OrdinaryLauncherCandidate; fixture: { testId: string; guestMachineId: string; guestHostname: string; guestEntrySha256: string };
  workerId: string; providerId: string; systemBusInfrastructure: ReturnType<typeof parseSystemBusInfrastructure>;
  creator: HostedInventoryCreator; tools: ReturnType<typeof parseDependencyToolRegistration> }>;
function readInput(): { input: Input; bytes: Buffer; clock: QualificationClock } {
  assertHostedActivationOperator();
  const bytes = qualificationRead(qualificationRoot + "/usable-input.json", 65536, true);
  const data = qualificationObject(qualificationJson(bytes), "schemaVersion,operation,candidate,fixture,workerId,providerId,systemBusInfrastructure,creator,tools");
  qualificationObject(data.operation, "operationId,workEndEpochMs,cleanupEndEpochMs");
  qualificationObject(data.candidate, "candidateArtifactPath,runtimeSha,runtimeManifestSha256,launcherSha256,codecSha256,profileSha256,sourceScopeSha256");
  qualificationObject(data.fixture, "testId,guestMachineId,guestHostname,guestEntrySha256");
  const creator = qualificationObject(data.creator, "creatorId,jobId,jobRootDir,workspacePath,launch");
  qualificationObject(creator.launch, "command,args,cwd");
  const input = data as unknown as Input;
  if (input.schemaVersion !== 1 || ![input.operation.operationId,input.fixture.testId,input.workerId,input.providerId].every(id =>
      typeof id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) ||
      new Set([input.fixture.testId,input.workerId,input.providerId]).size !== 3 || !/^[a-f0-9]{32}$/.test(input.fixture.guestMachineId) ||
      input.fixture.guestHostname !== "ordinary-test-" + input.fixture.testId ||
      input.creator.creatorId !== "TEST-ordinary-usable-" + input.providerId || input.creator.jobId !== input.creator.creatorId ||
      input.creator.jobRootDir !== hostedDependencyJobRoot(input.creator.jobId) || input.creator.workspacePath !== input.creator.jobRootDir + "/workspace" ||
      input.creator.launch.cwd !== input.creator.workspacePath || input.creator.launch.command !== process.execPath ||
      !Array.isArray(input.creator.launch.args) || input.creator.launch.args.length !== 6 ||
      input.creator.launch.args[0] !== input.candidate.candidateArtifactPath + "/dist/worker-codex/codex-goal-cli.js" ||
      input.creator.launch.args[1] !== "tool" || input.creator.launch.args[2] !== "codex_goal_project_start" ||
      input.creator.launch.args[3] !== "--args-json" || typeof input.creator.launch.args[4] !== "string" || input.creator.launch.args[5] !== "--json") qualificationHeld();
  parseDependencyToolRegistration(input.tools); parseSystemBusInfrastructure(input.systemBusInfrastructure);
  const fundedBytes = qualificationRead(qualificationRoot + "/funded-operation.json",65536,true);
  const funded = qualificationJson(fundedBytes) as Record<string,unknown>;
  if (funded.schemaVersion !== 2 || Object.entries(input.operation).some(([key,value]) => funded[key] !== value)) qualificationHeld();
  const operation = Object.freeze({ ...input.operation, operationSha256: qualificationSha(fundedBytes) });
  const clock = new QualificationClock(operation,{issuedEpochMs:funded.issuedEpochMs as number,issuedMonotonicNs:funded.issuedMonotonicNs as string});
  rejoin(input,bytes,clock,false); return {input,bytes,clock};
}
function rejoin(input: Input, bytes: Buffer, clock: QualificationClock, ready = true): void {
  assertHostedActivationOperator();clock.remaining();
  if (!qualificationRead(qualificationRoot+"/usable-input.json",65536,true).equals(bytes) ||
      qualificationSha(qualificationRead(qualificationRoot+"/funded-operation.json",65536,true)) !== clock.operation.operationSha256 ||
      entry !== input.candidate.candidateArtifactPath+"/dist/worker-codex/hosted-ordinary-installation-usable-guest.js" ||
      qualificationSha(qualificationRead(entry)) !== input.fixture.guestEntrySha256 ||
      readFileSync("/etc/machine-id","utf8").trim() !== input.fixture.guestMachineId || readFileSync("/etc/hostname","utf8").trim() !== input.fixture.guestHostname ||
      readFileSync("/run/systemd/container","utf8").trim() !== "systemd-nspawn" || readlinkSync("/proc/1/exe") !== "/usr/lib/systemd/systemd") qualificationHeld();
  qualificationCandidate(input.candidate);qualificationCopiedCohort(input.candidate);
  if (ready) {
    const gate=qualificationObject(qualificationJson(qualificationRead(qualificationRoot+"/usable-ready.json",65536,true)),"schemaVersion,operationSha256,guestInputSha256,unit,invocationId,namespaces,bootId");
    if (gate.schemaVersion!==1 || gate.operationSha256!==clock.operation.operationSha256 || gate.guestInputSha256!==qualificationSha(bytes) ||
        gate.unit!=="subscription-runtime-ordinary-"+input.fixture.testId+".service" || gate.bootId!==readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim() || typeof gate.invocationId!=="string" || !/^[a-f0-9]{32}$/.test(gate.invocationId) ||
        !Array.isArray(gate.namespaces) || gate.namespaces.length!==4) qualificationHeld();
    for (const name of ["user","mnt","pid","net"]) {
      const rows=gate.namespaces.filter((row:Record<string,unknown>)=>row.name===name);if(rows.length!==1)qualificationHeld();
      const row=qualificationObject(rows[0],"name,dev,ino"),own=statSync(`/proc/self/ns/${name}`),initial=statSync(`/proc/1/ns/${name}`);
      if(own.dev!==initial.dev||own.ino!==initial.ino||own.dev!==row.dev||own.ino!==row.ino)qualificationHeld();
    }
  }
}
async function coordinator(): Promise<void> {
  const {input,bytes,clock}=readInput();
  const profile=verifyPinnedFdCollectorProfile({path:qualificationProfile,sha256:input.candidate.profileSha256},()=>clock.remaining());
  const boot=clock.collect(()=>collectUnitShow(qualificationBootUnit));
  if(boot.MainPID!==String(process.pid)||boot.ControlGroup!=="/system.slice/"+qualificationBootUnit||collectProcessCgroup(String(process.pid))!=="0::"+boot.ControlGroup||
      process.execPath!==profile.node.path||!readFileSync("/proc/self/cmdline").equals(Buffer.from([profile.node.path,entry,Role.Coordinator].join("\0")+"\0"))||
      !qualificationRead("/etc/systemd/system/"+qualificationBootUnit).equals(qualificationBootRecipe(profile.node.path,entry)))qualificationHeld();
  while(true){clock.remaining();try{lstatSync(qualificationRoot+"/usable-ready.json");break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
  rejoin(input,bytes,clock);let owned:QualificationChild|undefined;
  try{
    const launch=trustedOrdinaryUsableGuestWorkerLaunch(input.workerId,clock.remaining(),Math.min(30000,clock.operation.cleanupEndEpochMs-clock.operation.workEndEpochMs));
    const payload=launch.args.slice(launch.args.indexOf("--")+1);
    owned=new QualificationChild(spawn(launch.command,launch.args,{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"},stdio:["pipe","pipe","pipe"]}),
      "subscription-runtime-hosted-"+input.workerId+".service",clock,qualificationRoot+"/output/usable-worker");
    owned.admitProxy();owned.endInput();await owned.bind(profile.node.path,payload,trustedCustodySystemdRunExecutable);await owned.wait();owned.closeUnit();rejoin(input,bytes,clock);
    qualificationCreate(qualificationRoot+"/output/usable-worker-drained.json",qualificationBytes({schemaVersion:1,operationSha256:clock.operation.operationSha256,
      inputSha256:qualificationSha(bytes),providerSha256:qualificationSha(qualificationRead(qualificationRoot+"/output/usable-provider.json",65536,true)),workerDrained:true}));
    while(true){clock.remaining();try{lstatSync(qualificationRoot+"/usable-captured.json");break;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
    const captured=qualificationObject(qualificationJson(qualificationRead(qualificationRoot+"/usable-captured.json",65536,true)),"schemaVersion,operationSha256,inputSha256,providerSha256");
    if(captured.schemaVersion!==1||captured.operationSha256!==clock.operation.operationSha256||captured.inputSha256!==qualificationSha(bytes)||
       captured.providerSha256!==qualificationSha(qualificationRead(qualificationRoot+"/output/usable-provider.json",65536,true)))qualificationHeld();
    rejoin(input,bytes,clock);
    const result=spawnSync("/usr/bin/systemctl",["poweroff","--no-block"],{cwd:"/",env:{PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"},stdio:["ignore","ignore","ignore"],timeout:Math.min(5000,clock.remaining())});
    if(result.error||result.status!==0||result.signal!==null)qualificationHeld();
  }catch(error){try{await owned?.settleFailed();}catch{/* Same original guest remains held. */}throw error;}
}
async function worker():Promise<void>{
  const {input,bytes,clock}=readInput();rejoin(input,bytes,clock);assertHostedProcessDescriptors();
  const profile=verifyPinnedFdCollectorProfile({path:qualificationProfile,sha256:input.candidate.profileSha256},()=>clock.remaining());
  verifySystemBusInfrastructure(input.systemBusInfrastructure,()=>clock.remaining());
  const unit="subscription-runtime-hosted-"+input.workerId+".service",birth=collectProcessBirth(String(process.pid)),current=clock.collect(()=>collectUnitShow(unit));
  const invocation=clock.collect(()=>collectUnitInvocation(unit)),group="/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/"+unit;
  if(current.MainPID!==String(process.pid)||current.ControlGroup!==group||collectProcessCgroup(String(process.pid))!=="0::"+group||
      !readFileSync("/proc/self/cmdline").equals(Buffer.from([profile.node.path,entry,Role.Worker].join("\0")+"\0")))qualificationHeld();
  const plan=resolveStoredProjectStartPlan(input.creator.launch.args[4]!,input.creator.workspacePath);
  if(plan.jobId!==input.creator.jobId||plan.jobRoot!==input.creator.jobRootDir||plan.workspace!==input.creator.workspacePath||
      plan.launch.config.authRootDir!==qualificationRoot+"/broker"||plan.launch.config.accounts?.length!==1||plan.launch.config.accounts[0]?.name!=="account-test"||
      (plan.launch.config.accounts[0].authJsonPath??qualificationRoot+"/broker/account-test/auth.json")!==qualificationRoot+"/broker/account-test/auth.json"||plan.launch.config.accounts[0].envVarName!==undefined)qualificationHeld();
  const tree=lstatSync(input.creator.workspacePath+"/node_modules");if(!tree.isDirectory()||tree.isSymbolicLink()||tree.uid!==0||tree.mode&0o022)qualificationHeld();
  const inventory=collectOrdinaryInstallationDraft({supervisorUnit:unit,supervisor:{birth,executable:profile.node,
      bootstrap:{path:entry,sha256:input.fixture.guestEntrySha256},operationId:input.operation.operationId,
      workEndEpochMs:input.operation.workEndEpochMs,cleanupEndEpochMs:input.operation.cleanupEndEpochMs},ordinaryCreators:[input.creator],disabledCreators:[],
    runtimeLaunch:input.creator.launch,systemBusInfrastructure:input.systemBusInfrastructure,collectorProfile:{path:qualificationProfile,sha256:input.candidate.profileSha256}});
  rejoin(input,bytes,clock);publishReadonlyInventory(qualificationBytes(inventory));const store=new HostedInstallationActivationStore();
  const installed=store.install();if(installed.phase!==HostedActivationPhase.Closed)qualificationHeld();
  await writeHostedTestEgressGrant({schemaVersion:1,jobId:input.creator.jobId,jobRootDir:input.creator.jobRootDir,workspacePath:input.creator.workspacePath,profileId:CodexProviderEgressProfileId.TestNpmQualification},input.tools);
  rejoin(input,bytes,clock);if(collectUnitInvocation(unit)!==invocation||collectUnitShow(unit).MainPID!==String(process.pid)||collectProcessBirth(String(process.pid))!==birth)qualificationHeld();
  store.enrollOrdinary(input.creator.creatorId);store.resumeOrdinary();
  try{
    const code=hostedForegroundExitCode(await runHostedRuntimeForeground(input.creator.launch.command,input.creator.launch.args,input.creator.launch.cwd,{}));
    if(code!==0)qualificationHeld();assertOrdinaryInstallationOriginalClose();rejoin(input,bytes,clock);
    const activation=store.finishClosed();if(activation.phase!==HostedActivationPhase.Closed||activation.ordinaryStarts.length!==1||
      activation.ordinaryStarts[0]!.state!==HostedCustodyReservationState.Terminal)qualificationHeld();
    const start=activation.ordinaryStarts[0]!;
    const qualification=parseDependencyToolAdmissionQualification(qualificationJson(qualificationRead("/var/lib/subscription-runtime-host-policy/"+dependencyToolQualificationRecordName(start.startId),16384,true)));
    if(qualification.version!==2||qualification.kind!==DependencyToolQualificationKind.UsableUnverifiedV2||qualification.execution.startId!==start.startId||
       qualification.execution.workspace.canonicalPath!==input.creator.workspacePath)qualificationHeld();
    qualificationCreate(qualificationRoot+"/output/usable-provider.json",qualificationBytes({schemaVersion:1,operationSha256:clock.operation.operationSha256,
      inputSha256:qualificationSha(bytes),creatorId:input.creator.creatorId,sourceExitCode:code,activationGeneration:activation.generation,providerDrained:true}));
  }catch(error){try{store.closeOrdinaryRuntimeLaunch();}catch{/* Original reservation stays unknown. */}throw error;}
}
if(process.argv[1]===entry){
  if(process.argv.length!==3||![Role.Coordinator,Role.Worker].includes(process.argv[2] as Role))qualificationHeld();
  void(process.argv[2]===Role.Coordinator?coordinator():worker()).then(()=>{process.exitCode=0;},()=>{process.exitCode=70;});
}
