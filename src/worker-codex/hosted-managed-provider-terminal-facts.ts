/** Manager facts only. This parser issues no origin, process or terminal grant. */
export enum HostedManagedProviderWaitKind { Exited = 1, Killed = 2 }
export enum HostedManagedProviderResult { Success = "success", ExitCode = "exit-code", Signal = "signal" }
export type HostedManagedProviderTerminalFacts = Readonly<{ unit:string;invocationId:string;
  kind:HostedManagedProviderWaitKind;status:number;result:HostedManagedProviderResult }>;
export function parseHostedManagedProviderTerminalFacts(unit: string, text: string): HostedManagedProviderTerminalFacts {
  const fail = (): never => { throw new Error("hosted_dependency_provider_terminal_unresolved"); };
  if (typeof text !== "string" || text.length > 4096 || text.includes("\0") || text.includes("\r") ||
      /^subscription-runtime-hosted-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service$/.exec(unit)?.[0] !== unit) fail();
  const rows = text.endsWith("\n") ? text.slice(0,-1).split("\n") : text.split("\n"), values = new Map<string,string>();
  for (const row of rows) { const at = row.indexOf("="); if (at < 1 || values.has(row.slice(0,at))) fail(); values.set(row.slice(0,at),row.slice(at+1)); }
  const keys = ["Id","InvocationID","ActiveState","SubState","MainPID","ControlPID","Job","ExecMainCode","ExecMainStatus","Result"];
  if (values.size !== keys.length || keys.some(key => !values.has(key)) || values.get("Id") !== unit ||
      !/^[a-f0-9]{32}$/.test(values.get("InvocationID") ?? "") || values.get("MainPID") !== "0" || values.get("ControlPID") !== "0" ||
      values.get("Job") !== "" || !["inactive","failed"].includes(values.get("ActiveState")!) ||
      !["dead","failed"].includes(values.get("SubState")!)) fail();
  const code = values.get("ExecMainCode"), rawStatus = values.get("ExecMainStatus")!;
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(rawStatus)) fail();
  const status = Number(rawStatus), result = values.get("Result");
  if (code === "1" && status <= 255 && (result === HostedManagedProviderResult.Success && status === 0 ||
      result === HostedManagedProviderResult.ExitCode && status > 0))
    return Object.freeze({unit,invocationId:values.get("InvocationID")!,kind:HostedManagedProviderWaitKind.Exited,status,
      result:result === HostedManagedProviderResult.Success ? HostedManagedProviderResult.Success : HostedManagedProviderResult.ExitCode});
  if (code === "2" && status > 0 && status <= 64 && result === HostedManagedProviderResult.Signal)
    return Object.freeze({unit,invocationId:values.get("InvocationID")!,kind:HostedManagedProviderWaitKind.Killed,status,result:HostedManagedProviderResult.Signal});
  return fail();
}

/** Exact systemd v255 systemd-run --wait mapping. These comparisons are facts,
 * never discharge: original B joins its private native wait and remaining OS. */
export function matchesManagedProviderProxyWait(terminal: HostedManagedProviderTerminalFacts | undefined, invocationId: string, code: number): boolean {
  if (!Number.isInteger(code) || code < 0 || code > 255) return false;
  if (!terminal) return code === 0;
  if (terminal.invocationId !== invocationId) return false;
  return terminal.kind === HostedManagedProviderWaitKind.Exited ? terminal.status === code :
    terminal.kind === HostedManagedProviderWaitKind.Killed && code === 255;
}
