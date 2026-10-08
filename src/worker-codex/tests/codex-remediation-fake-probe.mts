#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
if(!root.includes('/artifacts/fixtures/synthetic-effective-reader-'))throw Error('owned_synthetic_probe_only');
const home=process.env.CODEX_HOME!;
if(!home?.includes('/artifacts/fixtures/'))throw Error('owned_home_only');
const bytes=await readFile(join(home,'auth.json'),'utf8');
const digest=createHash('sha256').update(bytes).digest('hex');
await appendFile(join(root,'imports.jsonl'),JSON.stringify({digest})+'\n');
const accepted=digest===(await readFile(join(root,'accepted.hash'),'utf8')).trim();
let objective='',status='active';
const goal=()=>({threadId:'thread',objective,status,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:0,updatedAt:0});
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line) as {id?:number;method:string};if(request.id===undefined)continue;
  if(!accepted&&request.method!=='initialize'){process.stdout.write(JSON.stringify({id:request.id,error:{code:-32000,message:'refresh_token_invalidated'}})+'\n');continue;}
  let result:unknown={};
  if(request.method==='account/read')result={account:{id:'NOT-AN-ACCOUNT-REMEDIATION',type:'chatgpt'}};
  if(request.method==='account/rateLimits/read'){
    await writeFile(join(home,'auth.json'),await readFile(join(root,'next.fixture'),'utf8'),{mode:0o600});
    if(await readFile(join(root,'publication-denial.fixture')).then(()=>true,()=>false)){
      await writeFile(join(root,'auth/a/.subscription-runtime-auth-writeback'),'synthetic ENOTDIR publication failure',{mode:0o600});
    }
    result={rateLimits:{primary:{usedPercent:0,windowDurationMins:300},secondary:{usedPercent:0,windowDurationMins:10080}}};
  }
  if(request.method==='thread/start')result={thread:{id:'thread'}};
  if(request.method==='thread/goal/set'){
    const parsed=JSON.parse(line) as {params?:{objective?:string}};objective=parsed.params?.objective??'';result={goal:goal()};
  }
  if(request.method==='thread/goal/get')result={goal:goal()};
  if(request.method==='turn/start'){
    const parsed=JSON.parse(line) as {params?:{model?:string;effort?:string;serviceTier?:string|null}};
    if(parsed.params?.model!=='gpt-6.1-sol'||parsed.params.effort!=='high'||!(parsed.params.serviceTier===null||parsed.params.serviceTier==='default'))throw Error('exact_synthetic_model_contract');
    result={turn:{id:'turn'}};
  }
  process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
  if(request.method==='turn/start'){
    status='complete';
    process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{turnId:'turn',delta:'SYNTHETIC OK'}})+'\n');
    process.stdout.write(JSON.stringify({method:'turn/completed',params:{turn:{id:'turn',status:{type:'completed'}}}})+'\n');
  }
}
