import { codexAppServerProcessArgs } from "../provider-codex/app-server/application/app-server-process-args";
import { buildCodexRefreshBootstrapPlan } from "../provider-codex/codex-cli-domain";
type Paths = Readonly<{home:string;codexHome:string;emptyWorkdir:string}>;
/** Pure fixed-command projection. No origin, home/use state, spawn or grant.
 * The original producer independently authenticates every input before FDA. */
export function formManagedSessionModelProbeCommand(paths:Paths,searchPath:string) {
  return Object.freeze({command:"codex",args:codexAppServerProcessArgs({bypassHookTrust:true}),cwd:paths.emptyWorkdir,
    env:Object.freeze({PATH:searchPath,HOME:paths.home,CODEX_HOME:paths.codexHome,CI:"1",SUBSCRIPTION_RUNTIME_SANDBOX_KIND:"hosted-codex-job"})});
}
export function formManagedSessionRefreshCommand(paths:Paths,model:string,searchPath:string) {
  const plan=buildCodexRefreshBootstrapPlan({codexBinaryPath:"codex",tempHome:paths.home,tempCodexHome:paths.codexHome,
    emptyWorkingDirectory:paths.emptyWorkdir,authJsonPath:paths.codexHome+"/auth.json",model});
  return Object.freeze({...plan,env:Object.freeze({PATH:searchPath,HOME:plan.env.HOME!,CODEX_HOME:plan.env.CODEX_HOME!,
    REVIEWROUTER_CODEX_AUTH_PATH:plan.env.REVIEWROUTER_CODEX_AUTH_PATH!,CI:"1",SUBSCRIPTION_RUNTIME_SANDBOX_KIND:"hosted-codex-job"})});
}
