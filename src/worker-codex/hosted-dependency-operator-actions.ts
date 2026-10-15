import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { HostedInstallationActivationStore } from "./hosted-installation-activation";
export enum HostedDependencyOperatorAction { Report="dependency-report", Evict="dependency-evict", RecoverEviction="dependency-recover-eviction",
  RemoveCommittedTrash="dependency-remove-committed-trash", RecoverTrashRemoval="dependency-recover-trash-removal" }
export type HostedDependencyOperatorRequest=Readonly<{action:HostedDependencyOperatorAction.Report;jobId?:string}> |
  Readonly<{action:HostedDependencyOperatorAction.Evict;jobId:string;revision:number;generation:string;installKey:string}> |
  Readonly<{action:HostedDependencyOperatorAction.RecoverEviction;jobId:string}> |
  Readonly<{action:HostedDependencyOperatorAction.RemoveCommittedTrash|HostedDependencyOperatorAction.RecoverTrashRemoval;jobId:string;revision:number}>;
function invalid():never{throw new Error("hosted_dependency_operator_request_invalid");}
function job(value:string|undefined):string{if(!value || value.length>256 || /[\u0000-\u0020\u007f]/.test(value))invalid();return value;}
function revision(value:string|undefined):number {if(!value || /^[1-9][0-9]{0,15}$/.exec(value)?.[0]!==value || !Number.isSafeInteger(Number(value)))invalid();return Number(value);}
/** Closed request syntax only. Comparison IDs never supply path, unit, grant,
 * actor, descriptor list or authorization; the actual use cases rejoin facts. */
export function parseHostedDependencyOperatorRequest(action:string,args:readonly string[]):HostedDependencyOperatorRequest {
  switch(action) {
    case HostedDependencyOperatorAction.Report:
      if(args.length>1)invalid();return args.length ? {action,jobId:job(args[0])} : {action};
    case HostedDependencyOperatorAction.Evict: {
      if(args.length!==4)invalid();const generation=args[2],installKey=args[3];
      if(!generation || generation.length>256 || /[\u0000-\u0020\u007f]/.test(generation) || !installKey || /^[a-f0-9]{64}$/.exec(installKey)?.[0]!==installKey)invalid();
      return {action,jobId:job(args[0]),revision:revision(args[1]),generation,installKey};
    }
    case HostedDependencyOperatorAction.RecoverEviction:
      if(args.length!==1)invalid();return {action,jobId:job(args[0])};
    case HostedDependencyOperatorAction.RemoveCommittedTrash:
    case HostedDependencyOperatorAction.RecoverTrashRemoval:
      if(args.length!==2)invalid();return {action,jobId:job(args[0]),revision:revision(args[1])};
    default:invalid();
  }
}
/** The single existing ROOT CLI calls this thin fixed adapter. Bare request
 * parsing is not admission; existing inspected operator/use-case fences remain. */
export async function dispatchHostedDependencyOperatorAction(action:string,args:readonly string[]) {
  assertReadonlyHostOperator();const request=parseHostedDependencyOperatorRequest(action,args),store=new HostedInstallationActivationStore();
  switch(request.action) {
    case HostedDependencyOperatorAction.Report:return store.reportDependencyRetention(request.jobId);
    case HostedDependencyOperatorAction.Evict:return store.evictDependencyCandidate({jobId:request.jobId,revision:request.revision,generation:request.generation,installKey:request.installKey});
    case HostedDependencyOperatorAction.RecoverEviction:return store.recoverDependencyEviction(request.jobId);
    case HostedDependencyOperatorAction.RemoveCommittedTrash:return store.removeDependencyCommittedTrash(request.jobId,request.revision);
    case HostedDependencyOperatorAction.RecoverTrashRemoval:return store.recoverDependencyCommittedTrash(request.jobId,request.revision);
  }
}
