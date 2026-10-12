import { AccessBoundary } from "@vioxen/subscription-runtime/worker-core";
import { planStoredProjectStart } from "../stored-start-planning";
export function sdkRecipe(snapshots: Map<string, Buffer>, job: string) {
  const workspace = job + "/workspace";
  snapshots.clear();
  const registry=job+"/state/registry", controllerJobId="TEST-control", jobId="TEST-parent";
  const base={schemaVersion:1,createdAt:"2026-10-08T00:00:00.000Z",updatedAt:"2026-10-08T00:00:00.000Z",
    taskId:"TEST-parent",accounts:["account-test"],model:"gpt-6.1-sol",reasoningEffort:"high",serviceTier:"default",cwd:workspace};
  const worker={...base,jobId,jobRootDir:job,workspacePath:workspace,promptPath:job+"/prompt",authRootDir:job+"/auth",
    stateRootDir:job+"/state",durableHandoffRootDir:job+"/durable-handoffs",outputPath:job+"/TEST-parent.latest-result.json",
    executionEngine:"app-server-goal",accessBoundary:AccessBoundary.IsolatedWorkspaceWrite,
    projectAccessScope:{projectId:"TEST-sdk",workspaceRoots:[workspace],registryRoot:registry,
      jobIdPrefixes:["TEST-"],tmuxSessionPrefixes:["TEST-"],allowedAccountIds:["account-test"]}};
  const controller={...base,jobId:controllerJobId,jobRootDir:job+"-control",workspacePath:job+"-control/workspace",promptPath:job+"-control/prompt",
    accessBoundary:AccessBoundary.ProjectScopedControl,projectAccessScope:{projectId:"TEST-sdk",workspaceRoots:[workspace],registryRoot:registry,
      jobIdPrefixes:["TEST-"],tmuxSessionPrefixes:["TEST-"],allowedAccountIds:["account-test"]}};
  const json=(x:unknown)=>Buffer.from(JSON.stringify(x));const captured={controller:json(controller),worker:json(worker),prompt:Buffer.from("Public test."),preStart:null};
  const args={controllerJobId,jobId,registryRootDir:registry,confirmStart:true,forceStart:false,skipDoctor:false,dependencyBootstrap:"off"};
  const plan=planStoredProjectStart(JSON.stringify(args),workspace,captured),bound={...args,storedStartBinding:plan.binding};
  snapshots.set(registry+"/"+controllerJobId+"/job.json",captured.controller);snapshots.set(registry+"/"+jobId+"/job.json",captured.worker);snapshots.set(worker.promptPath,captured.prompt);
  return {command:process.execPath,args:[plan.launch.cliCommand[1]!,"tool","codex_goal_project_start","--args-json",JSON.stringify(bound),"--json"],cwd:workspace};
}
