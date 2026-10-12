import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {callToolJson as callAllocatedToolJson,describe,tmpdir} from "./codex-goal-mcp-project-admission-test-fixture";
import {AccessBoundary} from "@vioxen/subscription-runtime/worker-core";
import {createFixture} from "./codex-goal-project-refill-fixture";
import {callToolJson,writeFakeAuth} from "./codex-goal-mcp-test-support";
import {createCodexGoalMcpServer} from "../codex-goal-mcp";
import {readCodexGoalJob} from "../codex-goal-jobs";
import {planStoredProjectStart} from "../stored-start-planning";
import {buildCodexGoalForegroundArgv} from "../application/codex-goal-foreground-command";
import {assertHostedDependencyParentRecipe} from "../hosted-dependency-parent-recipe";

// Original public MCP create/refill and real private TEST Git/manifests. The
// existing synthetic account fixture is local data; no provider is started.
beforeEach(()=>{vi.stubEnv("GIT_CONFIG_NOSYSTEM","1");vi.stubEnv("GIT_CONFIG_GLOBAL","/dev/null");});
afterEach(()=>vi.unstubAllEnvs());
describe("original public SDK durable handoff propagation",()=>{
 it.each(["canonical","omitted","foreign","registry","auth","worktree","job","prefix","controller","registry-alias","normalized"] as const)("preserves %s selection through public refill, stored manifest and launch config",async mode=>{
  const fixture=await createFixture(tmpdir()),root=fixture.root,jobId="TEST-sdk-handoff",controllerId="TEST-sdk-control";
  const job=join(root,"jobs",jobId),workspace=join(job,"workspace"),registry=join(job,"state/registry"),auth=join(job,"auth");
  const controllerRoot=join(root,"jobs",controllerId),handoff=mode==="foreign"?join(workspace,"node_modules/handoff"):join(job,"durable-handoffs");
  const server=createCodexGoalMcpServer(),client=new Client({name:"Source-handoff-test",version:"1"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try{
   await mkdir(auth,{recursive:true});await writeFakeAuth(auth,"account-a",{lastRefresh:new Date().toISOString()});
   await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
   const scope={projectId:"Source-sdk-handoff",workspaceRoots:[fixture.sourceWorkspacePath],worktreeRoots:[workspace],
    registryRoot:registry,authRoot:auth,jobIdPrefixes:["TEST-sdk-"],tmuxSessionPrefixes:["TEST-sdk-"],
    allowedBranches:["main","origin/main",fixture.phaseStartSha,"test/sdk-handoff"],allowedGitRemotes:["origin"],allowedAccountIds:["account-a"]};
   if(mode==="registry")scope.registryRoot=join(job,"state/foreign-registry");
   if(mode==="auth")scope.authRoot=auth+"-foreign";
   if(mode==="worktree")scope.worktreeRoots.push(join(job,"other-workspace"));
   if(mode==="prefix")scope.jobIdPrefixes=[controllerId,"OTHER-"];
   const controller=await callAllocatedToolJson(client,"codex_goal_create_job",{jobId:controllerId,taskId:controllerId,registryRootDir:registry,
    jobRootDir:controllerRoot,workspacePath:fixture.sourceWorkspacePath,promptPath:join(controllerRoot,"prompt.md"),authRootDir:auth,accounts:["account-a"],
    accessBoundary:AccessBoundary.ProjectScopedControl,projectAccessScope:scope});
   if(mode==="registry"){
    expect(controller.ok).toBe(false);expect(String(controller.error??controller.reason)).toMatch(/codex_goal_job_create_denied:path_outside_scope/);return;
   }
   if(controller.ok!==true)throw new Error(JSON.stringify(controller));
   const alias=join(job,"state/registry-alias");if(mode==="registry-alias")await symlink(registry,alias,"dir");
   const result=await callToolJson(client,"codex_goal_project_refill_worker",{controllerJobId:mode==="controller"?"TEST-unknown":controllerId,jobId,taskId:jobId,
    registryRootDir:mode==="registry-alias"?alias:registry,jobRootDir:mode==="job"?join(root,"outside",jobId):mode==="normalized"?job+"/./":job,workspacePath:workspace,cwd:workspace,sourceWorkspacePath:fixture.sourceWorkspacePath,
    baseBranch:"origin/main",sourceRef:fixture.phaseStartSha,newBranch:"test/sdk-handoff",promptBody:"Public Source-only handoff regression.\n",
    authRootDir:auth,accounts:["account-a"],stateRootDir:join(job,"state"),progressPath:join(job,jobId+".progress.json"),
    logPath:join(job,jobId+".log"),outputPath:join(job,jobId+".latest-result.json"),executionEngine:"app-server-goal",
    ...(mode==="omitted"?{}:{durableHandoffRootDir:handoff}),prewarmOnStart:false,startWorker:false,confirmRefill:true});
   if(["registry","auth","worktree","job","prefix","controller","registry-alias","normalized"].includes(mode)){
    expect(result.ok).toBe(false);expect(String(result.error)).toMatch(/project_control_|codex_goal_job_not_found|ENOENT/);
    await expect(readCodexGoalJob({registryRootDir:registry,jobId})).rejects.toThrow();return;
   }
   if(result.ok!==true)throw new Error(JSON.stringify(result));
   const worker=await readCodexGoalJob({registryRootDir:registry,jobId}),control=await readCodexGoalJob({registryRootDir:registry,jobId:controllerId});
   const expected=mode==="omitted"?join(registry,"durable-handoffs"):handoff;
   expect(worker.durableHandoffRootDir).toBe(expected);expect(worker.projectAccessScope?.workspaceRoots).toEqual([workspace]);
   const args={controllerJobId:controllerId,jobId,registryRootDir:registry,confirmStart:true,forceStart:false,skipDoctor:false,dependencyBootstrap:"off"};
   const plan=planStoredProjectStart(JSON.stringify(args),workspace,{controller:Buffer.from(JSON.stringify(control)),worker:Buffer.from(JSON.stringify(worker)),
    prompt:await readFile(worker.promptPath),preStart:null});
   expect(plan.launch.config.durableHandoffRootDir).toBe(expected);
   const run=()=>assertHostedDependencyParentRecipe(buildCodexGoalForegroundArgv(plan.launch).slice(1),job,workspace);
   if(mode==="canonical")expect(run).not.toThrow();else expect(run).toThrow("hosted_dependency_parent_recipe_unsupported");
   // No provider start, doctor, binding rewrite, or controller-owned scope override.
  }finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});}
 },30000);
});

// The shared schema also reaches the original ordinary stored-job update API.
// This separate unowned public TEST registry exercises that existing contract;
// it supplies no controller child scope and starts no worker/provider.
describe("original public SDK handoff update",()=>{
 it.each(["absolute","relative"] as const)("persists %s update through public create/update/get and dry-run",async mode=>{
  const root=await mkdtemp(join(tmpdir(),"sdk-handoff-update-")),jobId="TEST-sdk-update",job=join(root,"jobs",jobId),
   workspace=join(job,"workspace"),registry=join(job,"state/registry"),initial=join(job,"durable-handoffs"),next=join(job,"durable-handoffs-next");
  const server=createCodexGoalMcpServer(),client=new Client({name:"Source-update-test",version:"1"}),[ct,st]=InMemoryTransport.createLinkedPair();
  try{
   await mkdir(workspace,{recursive:true});await writeFile(join(job,"prompt.md"),"Source public update regression.\n");
   await Promise.all([server.connect(st),client.connect(ct)]);
   const create={jobId,taskId:jobId,registryRootDir:registry,jobRootDir:job,workspacePath:workspace,cwd:workspace,
    promptPath:join(job,"prompt.md"),authRootDir:join(job,"auth"),accounts:["account-a"],durableHandoffRootDir:initial,prewarmOnStart:false};
   expect((await callToolJson(client,"codex_goal_create_job",create)).ok).toBe(true);
   const updated=await callToolJson(client,"codex_goal_update_job",{jobId,registryRootDir:registry,cwd:workspace,
    durableHandoffRootDir:mode==="relative"?"../durable-handoffs-next":next});
   expect(updated.ok).toBe(true);
   const result=await callToolJson(client,"codex_goal_get_job",{jobId,registryRootDir:registry});
   expect(result.ok).toBe(true);expect(result.manifest).toMatchObject({durableHandoffRootDir:next});
   expect((await readCodexGoalJob({registryRootDir:registry,jobId})).durableHandoffRootDir).toBe(next);
   const dry=await callToolJson(client,"codex_goal_dry_run",{...create,durableHandoffRootDir:next});
   expect(dry.ok).toBe(true);expect(String(dry.noTmuxCommand)).toContain("--durable-handoff-root");expect(String(dry.noTmuxCommand)).toContain(next);
   expect((await callToolJson(client,"codex_goal_update_job",{jobId,registryRootDir:registry,description:"unchanged omitted root"})).ok).toBe(true);
   expect((await readCodexGoalJob({registryRootDir:registry,jobId})).durableHandoffRootDir).toBe(next);
  }finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});}
 },30000);
});
