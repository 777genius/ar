import { drainCurrentHostedDependencySessionProvider } from "./hosted-current-dependency-origin";
import { HostedReadonlySupervisorHost } from "./hosted-readonly-supervisor-host";
import { readCurrentHostedDependencySessionModelProbeView, type CurrentHostedDependencySessionHome } from "./hosted-current-dependency-origin";
import { readCodexModelCatalogPage } from "../provider-codex/app-server/protocol/app-server-model-catalog";
function denied():never { throw new Error("hosted_dependency_session_model_probe_unknown"); }
/** Fixed same-home observed CLI catalog only. Cached/bundled fallback provenance is unavailable; actual CLI inference proves request access. */
export async function collectOriginalHostedDependencySessionModels(home:CurrentHostedDependencySessionHome):Promise<readonly string[]> {
  const view = readCurrentHostedDependencySessionModelProbeView(home);
  let buffer = "", total = 0, frames = 0, next = 1;
  let pending:{id:number;resolve:(value:Record<string,unknown>)=>void;reject:(error:Error)=>void}|undefined;
  let failed = false;
  const stop = () => { failed = true; pending?.reject(new Error("hosted_dependency_session_model_probe_unknown")); };
  const deadline = setTimeout(stop,30_000);
  view.stdout.setEncoding("utf8"); view.stderr.on("data",() => {});
  view.stdout.on("data",chunk => {
    try {
      if (failed || typeof chunk !== "string") denied(); total += Buffer.byteLength(chunk);
      if (total > 1024*1024 || Buffer.byteLength(buffer)+Buffer.byteLength(chunk) > 131072) denied(); buffer += chunk;
      while (buffer.includes("\n")) {
        if (++frames > 2048) denied(); const end = buffer.indexOf("\n"), line = buffer.slice(0,end); buffer = buffer.slice(end+1);
        if (Buffer.byteLength(line) > 65536) denied(); if (!line.trim()) continue;
        const response:unknown = JSON.parse(line);
        if (!response || typeof response !== "object" || Array.isArray(response)) denied();
        const row = response as Record<string,unknown>;
        if (row.id === undefined && typeof row.method === "string") continue;
        if (!pending || row.id !== pending.id || row.error !== undefined || !row.result || typeof row.result !== "object" || Array.isArray(row.result)) denied();
        const own = pending; pending = undefined; own.resolve(row.result as Record<string,unknown>);
      }
      if (Buffer.byteLength(buffer) > 65536) denied();
    } catch { stop(); }
  });
  view.on("error",stop); view.on("exit",stop); view.stdin.on?.("error",stop);
  const request = (method:"initialize"|"account/read"|"model/list", params:Record<string,unknown>):Promise<Record<string,unknown>> => {
    if (failed || pending) denied(); const id = next++;
    return new Promise((resolve,reject) => { pending = {id,resolve,reject};
      try { view.stdin.write(JSON.stringify({id,method,params})+"\n"); } catch { stop(); } });
  };
  try {
    await request("initialize",{clientInfo:{name:"subscription-runtime",title:"Subscription runtime",version:"0.0.0"},capabilities:{experimentalApi:true,requestAttestation:false}});
    view.stdin.write(JSON.stringify({method:"initialized",params:{}})+"\n");
    // A missing/null account is not an authenticated configured-slot fallback.
    const account = (await request("account/read",{refreshToken:false})).account;
    if (!account || typeof account !== "object" || Array.isArray(account) || (account as Record<string,unknown>).type !== "chatgpt") denied();
    const models:string[] = [], seen = new Set<string>(); let cursor:string|null = null;
    for (let number = 0;number < 10;number++) {
      const raw = await request("model/list",{cursor,limit:100,includeHidden:true});
      const page = readBoundedObservedSessionModelPage(raw,models.length);
      models.push(...page.data.map(value => value.model)); if (page.nextCursor === null) { if (!models.length) denied(); return Object.freeze([...new Set(models)]); }
      if (seen.has(page.nextCursor)) denied(); seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    return denied();
  } finally { failed = true; clearTimeout(deadline); }
}

/** Bounded captured protocol data only. A parsed catalog page never grants account/root availability. */
export function readBoundedObservedSessionModelPage(raw:Record<string,unknown>,observedCount:number) {
  if (!Number.isSafeInteger(observedCount) || observedCount < 0 || observedCount > 500) denied();
  const data = raw.data;
  if (!Array.isArray(data) || data.length > 100 || observedCount+data.length > 500) denied();
  for (const value of data) {
    if (!value || typeof value !== "object" || Array.isArray(value)) denied();
    const efforts = (value as Record<string,unknown>).supportedReasoningEfforts;
    if (efforts !== undefined && (!Array.isArray(efforts) || efforts.length > 16)) denied();
  }
  const page = readCodexModelCatalogPage({data,nextCursor:raw.nextCursor}); if (!page || page.data.length !== data.length) denied();
  return page;
}

/** Fixed same-home catalog subphase. Stop/drain never releases home/use or
 * advances credential scheduling; original issuer independently rejoins its
 * captured use/auth/executable/profile before retaining these factual models. */
export async function collectOriginalHostedDependencySessionModelsAfterDrain(home:CurrentHostedDependencySessionHome):Promise<readonly string[]> {
  new HostedReadonlySupervisorHost().startDependencySessionModelProbe(home);
  try {
    const models=await collectOriginalHostedDependencySessionModels(home);
    await drainCurrentHostedDependencySessionProvider(home);return models;
  } catch(error) {await drainCurrentHostedDependencySessionProvider(home);throw error;}
}
