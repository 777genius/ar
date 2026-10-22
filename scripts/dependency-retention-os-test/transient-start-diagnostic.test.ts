import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyOwnedProxyStderr, classifyTransientStartFailure, ownedProxyOptionNames, ownedProxyPropertyNames } from "./transient-start-diagnostic.ts";
import { sameSyntheticDiagnosticFile, syntheticCliStderrDiagnostic, syntheticProviderSha256, verifiedSyntheticCliInputs } from "./synthetic-cli-diagnostic.ts";
import { cleanEnv } from "./common.ts";
import { observeSyntheticResultFile, syntheticStructuredFailure, type SyntheticResultSource } from "./synthetic-result-diagnostic.ts";
import { buildRuntimeResultEnvelope } from "../../dist/worker-core/runtime-result.js";
import { SafeExecutionRunner } from "../../dist/worker-core/safe-execution/application/safe-execution-runner.js";
import { SafeExecutionError } from "../../dist/worker-core/safe-execution/domain/safe-execution-policy.js";
import { InMemoryAttemptJournal } from "../../dist/worker-core/safe-execution/adapters/in-memory-attempt-journal.js";
import { InMemoryWorkspaceLockStore } from "../../dist/worker-core/safe-execution/adapters/in-memory-workspace-lock-store.js";
import { SubscriptionWorkerError } from "../../dist/worker-core/errors.js";
const sample = (text: string) => {
  const bytes = Buffer.from(text);
  return classifyTransientStartFailure(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length });
};
const syntheticIdentity = { jobId: "TEST-os-11111111-2222-4333-8444-555555555555",
  workspace: "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-os-11111111-2222-4333-8444-555555555555/workspace" };
function resultSample(value: unknown, source: SyntheticResultSource = "safe_execution_stdout", trusted = true, change = {}) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  return syntheticStructuredFailure(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length, ...change },
    trusted, "a".repeat(40), syntheticIdentity, source);
}
const failedRun = () => ({ status: "failed", reason: "unknown_error", safeMessage: "Bearer PRIVATE_CANARY", error: {code:"safe_execution_workspace_not_git",path:"/PRIVATE_CANARY"},
  task: { taskId: syntheticIdentity.jobId, workspacePath: syntheticIdentity.workspace, status:"failed", lastFailureReason:"unknown_error", attempts:[] }, attempts:[] });
const failedResult = () => buildRuntimeResultEnvelope({ status:"failed",provider:"codex",runId:syntheticIdentity.jobId,taskId:syntheticIdentity.jobId,
  reason:"runner_exception",changedFiles:[],evidence:["PRIVATE_CANARY"],blockers:["Bearer PRIVATE_CANARY"] });
test("structured observer consumes the actual failStartedTask producer before any provider attempt", async () => {
  let providerCalls=0;
  const runner=new SafeExecutionRunner({ journal:new InMemoryAttemptJournal(),lockStore:new InMemoryWorkspaceLockStore(),
    runtime:{createOwnerId:()=>"TEST-only-owner",currentPid:()=>undefined},
    workspaceAccess:{canonicalizePath:async({path})=>path,assertGitWorkspace:async()=>{throw new SafeExecutionError("safe_execution_workspace_not_git","Bearer PRIVATE_CANARY");}} });
  const produced=await runner.run({taskId:syntheticIdentity.jobId,workspace:{mode:"existing_locked",path:syntheticIdentity.workspace,requireGitWorkspace:true},
    provider:"codex",effectMode:"read_only",job:{},originalPrompt:"TEST-only",pool:{run:async()=>{providerCalls++;return{};}}});
  assert.equal(providerCalls,0);assert.equal(produced.status,"failed");assert.equal(produced.attempts.length,0);
  const captured=resultSample(produced);assert.equal(captured.state,"captured");
  if(captured.state!=="captured")throw new Error("TEST real producer rejected");
  assert.equal(captured.attemptCount,0);assert(captured.root.codes.includes("safe_execution_workspace_not_git"));
  assert(captured.task?.codes.includes("safe_execution_workspace_not_git"));assert(!JSON.stringify(captured).includes("PRIVATE_CANARY"));
});
test("actual one-attempt wrapper keeps generic text refused and exposes only its exact closed origin fact", async () => {
  let poolCalls=0;
  const runner=new SafeExecutionRunner({journal:new InMemoryAttemptJournal(),lockStore:new InMemoryWorkspaceLockStore(),
    runtime:{createOwnerId:()=>"TEST-only-owner",currentPid:()=>undefined},
    workspaceAccess:{canonicalizePath:async({path})=>path,assertGitWorkspace:async()=>{}},
    snapshotter:{capture:async({workspacePath})=>({mode:"git",workspacePath,capturedAt:new Date(),dirty:false,changedFiles:[],fingerprint:"TEST-only",summary:"TEST clean"})}});
  const produced=await runner.run({taskId:syntheticIdentity.jobId,workspace:{mode:"existing_locked",path:syntheticIdentity.workspace,requireGitWorkspace:true},
    provider:"codex",effectMode:"read_only",job:{},originalPrompt:"TEST-only",continuationMode:"disabled",policy:{maxAttempts:1},
    pool:{run:async()=>{poolCalls++;throw new SubscriptionWorkerError("subscription_worker_start_failed","Worker pool failed to start.",
      {cause:new Error("hosted_dependency_current_origin_unresolved")});}}});
  assert.equal(poolCalls,1);assert.equal(produced.attempts.length,1);
  const captured=resultSample(produced);assert.equal(captured.state,"captured");if(captured.state!=="captured")throw new Error("TEST producer rejected");
  assert.equal(captured.attemptCount,1);assert(captured.root.codes.includes("subscription_worker_start_failed"));
  assert.deepEqual(captured.originDiagnostic,{reason:"hosted_dependency_current_origin_unresolved",locations:[]});
  assert.equal(captured.messageObservations[0]?.field,"root.failureDetails.rawCause");
  assert.equal(captured.messageObservations[0]?.diagnostic.state,"unavailable");
});
test("structured synthetic failures select closed codes from genuine zero/one-attempt result shapes only", () => {
  const output = resultSample(failedRun());
  assert.deepEqual(output, { purpose:"TEST_synthetic_structured_failure_only",state:"captured",source:"safe_execution_stdout",
    root:{status:"failed",reason:"unknown_error",codes:["safe_execution_workspace_not_git"]},
    task:{status:"failed",reason:"unknown_error",codes:[]},attemptCount:0,attempts:[],messageFieldPresenceBits:16,
    messageObservations:[{field:"root.safeMessage",diagnostic:{purpose:"TEST_synthetic_cli_redacted_text_only",state:"unavailable"}}] });
  const attempt = {taskId:syntheticIdentity.jobId,attemptNumber:1,status:"failed",failureReason:"account_unavailable",
    failureDetails:{subscriptionWorkerCode:"subscription_worker_account_unavailable",rawCause:"Bearer PRIVATE_CANARY"},accountId:"PRIVATE_CANARY"};
  const one = {...failedRun(),attempts:[attempt],task:{...failedRun().task,attempts:[attempt]}};
  const observed = resultSample(one); assert.equal(observed.state,"captured");
  if(observed.state!=="captured")throw new Error("TEST structured capture unavailable");
  assert.equal(observed.attemptCount,1);assert.deepEqual(observed.attempts,[{status:"failed",reason:"account_unavailable",codes:["subscription_worker_account_unavailable"]}]);
  const diagnostic={reason:"hosted_dependency_current_origin_unresolved",locations:[{module:"hosted-current-dependency-origin",format:"js",line:95,column:28}]};
  const envelope=resultSample({...failedResult(),details:{errorCode:"subscription_worker_start_failed",rawCause:JSON.stringify(diagnostic)}},"runtime_result_file");
  assert.equal(envelope.state,"captured");if(envelope.state!=="captured")throw new Error("TEST envelope capture unavailable");
  assert.deepEqual(envelope.originDiagnostic,diagnostic);
  for(const value of [output,observed,envelope])for(const secret of ["PRIVATE_CANARY","Bearer",syntheticIdentity.jobId,"/var/lib"])
    assert(!JSON.stringify(value).includes(secret));
});
test("selected failure messages prefer rawCause, deduplicate, cap at three and retain unchanged redaction", () => {
  const benign="Fixture startup failed at /private/TEST-probe.", attempt={taskId:syntheticIdentity.jobId,attemptNumber:1,status:"failed",
    failureDetails:{rawCause:"Bearer PRIVATE_CANARY"},failureMessage:"UNSELECTED fifth message"};
  const value={...failedRun(),failureDetails:{rawCause:benign},details:{rawCause:"UNSELECTED runtime-only field"},safeMessage:"Fixture fallback summary.",
    task:{...failedRun().task,lastFailureDetails:{rawCause:benign},lastFailureMessage:"UNSELECTED fourth message",attempts:[attempt]},attempts:[attempt]};
  const output=resultSample(value);assert.equal(output.state,"captured");if(output.state!=="captured")throw new Error("TEST capture rejected");
  assert.equal(output.messageFieldPresenceBits,125);
  assert.deepEqual(output.messageObservations.map(item=>item.field),["root.failureDetails.rawCause","attempt.failureDetails.rawCause","root.safeMessage"]);
  assert.equal(output.messageObservations[0]?.diagnostic.state,"captured");assert.equal(output.messageObservations[1]?.diagnostic.state,"unavailable");
  const text=JSON.stringify(output);assert(text.includes("<path>"));for(const forbidden of ["/private/TEST-probe","PRIVATE_CANARY","Bearer","UNSELECTED"])assert(!text.includes(forbidden));
  const absent=resultSample(failedResult(),"runtime_result_file");assert.equal(absent.state,"captured");
  if(absent.state!=="captured")throw new Error("TEST envelope rejected");assert.equal(absent.messageFieldPresenceBits,0);assert.deepEqual(absent.messageObservations,[]);
  for(const message of ["api_key=PRIVATE_CANARY","x".repeat(5000),"multiline\nPRIVATE_CANARY","A".repeat(43)]){
    const result=resultSample({...failedRun(),safeMessage:message});assert.equal(result.state,"captured");
    if(result.state!=="captured")throw new Error("TEST shape rejected");assert.equal(result.messageObservations[0]?.diagnostic.state,"unavailable");
  }
});
test("closed wrapper extraction accepts only exact bounded source joins and canonical final diagnostics", () => {
  const origin="hosted_dependency_current_origin_unresolved", wrapper="Worker pool failed to start. <- ";
  const diagnostic={reason:origin,locations:[{module:"hosted-current-dependency-origin",format:"js",line:95,column:28}]};
  const observe=(rawCause:string)=>resultSample({...failedResult(),details:{rawCause}},"runtime_result_file");
  for(const value of [origin,JSON.stringify(diagnostic)]){
    const result=observe(wrapper+value);assert.equal(result.state,"captured");if(result.state!=="captured")throw new Error("TEST capture rejected");
    assert.equal(result.originDiagnostic?.reason,origin);assert.equal(result.messageObservations[0]?.diagnostic.state,"unavailable");
  }
  for(const value of ["Worker pool failed to start! <- "+origin,wrapper+origin+"suffix",wrapper+"unknown_origin_code",
    "prefix "+wrapper+origin,wrapper+"Bearer PRIVATE_CANARY <- "+origin,wrapper.repeat(4)+origin,
    wrapper+JSON.stringify({...diagnostic,private:"PRIVATE_CANARY"}),wrapper+JSON.stringify(diagnostic,null,2)]){
    const result=observe(value);assert.equal(result.state,"captured");if(result.state!=="captured")throw new Error("TEST capture rejected");
    assert.equal(result.originDiagnostic,undefined);
  }
});
test("structured synthetic failures refuse changed, partial, malformed, foreign and excessive input", () => {
  const base=failedRun();
  for(const value of [{...base,status:"PRIVATE_CANARY"},{...base,status:"running"},{...base,task:undefined},{...base,task:{...base.task,taskId:"PRIVATE_CANARY"}},
    {...base,task:{...base.task,workspacePath:"/PRIVATE_CANARY"}},{...base,attempts:[{},{}]},
    {...base,attempts:[{}],task:{...base.task,attempts:[{}]}},{...base,attempts:[{}]},
    {...base,taskId:"PRIVATE_CANARY"}])assert.equal(resultSample(value).state,"unavailable");
  for(const change of [{offset:1},{currentBytes:1},{initialBytes:1},{fullBytes:1}])assert.equal(resultSample(base,"safe_execution_stdout",true,change).state,"unavailable");
  assert.equal(resultSample(base,"safe_execution_stdout",false).state,"unavailable");
  for(const patch of [{runId:"PRIVATE_CANARY"},{taskId:"PRIVATE_CANARY"},{provider:"PRIVATE_CANARY"},{schemaVersion:2}])
    assert.equal(resultSample({...failedResult(),...patch},"runtime_result_file").state,"unavailable");
  const unknown=resultSample({...base,reason:"PRIVATE_CANARY",error:{code:"PRIVATE_CANARY"}});
  assert.equal(unknown.state,"captured");assert(!JSON.stringify(unknown).includes("PRIVATE_CANARY"));
  for(const bytes of [Buffer.from("{"),Buffer.alloc(32769,32),Buffer.from([0xff])])
    assert.equal(syntheticStructuredFailure(bytes,{fullBytes:bytes.length,offset:0,initialBytes:bytes.length,currentBytes:bytes.length},true,"a".repeat(40),syntheticIdentity,"safe_execution_stdout").state,"unavailable");
});
test("exact synthetic result file uses a held real FD and refuses replacements, rewrites and nonprivate leaves", t => {
  const real={...fs}, temporary=real.mkdtempSync(join(tmpdir(),"TEST-synthetic-result-")), logical=syntheticIdentity.workspace.slice(0,-"/workspace".length);
  const local=(path:unknown)=>typeof path==="string"&&path.startsWith(logical)?temporary+path.slice(logical.length):path;
  const root=temporary+"/state",file=root+"/TEST-result.json", bytes=Buffer.from(JSON.stringify({...failedResult(),private:"PRIVATE_CANARY_A"}));
  real.mkdirSync(root,{mode:0o700});let fault="",changed=false;const held=new Set<number>();
  t.mock.method(fs,"lstatSync",((path:fs.PathLike,options?:unknown)=>{
    const stat=Reflect.apply(real.lstatSync,real,[local(path),options]) as fs.Stats|fs.BigIntStats;
    return Object.assign(stat,{uid:typeof stat.uid==="bigint"?0n:0,gid:typeof stat.gid==="bigint"?0n:0});
  }) as typeof fs.lstatSync);
  t.mock.method(fs,"fstatSync",((fd:number)=>Object.assign(real.fstatSync(fd),{uid:0,gid:0})) as typeof fs.fstatSync);
  t.mock.method(fs,"openSync",((path:fs.PathLike,flags:number)=>{const fd=real.openSync(local(path) as fs.PathLike,flags);held.add(fd);return fd;}) as typeof fs.openSync);
  t.mock.method(fs,"closeSync",((fd:number)=>{held.delete(fd);return real.closeSync(fd);}) as typeof fs.closeSync);
  t.mock.method(fs,"readSync",((...args:Parameters<typeof fs.readSync>)=>{
    const count=Reflect.apply(real.readSync,real,args) as number;
    if(count>0&&!changed&&fault){changed=true;
      if(fault==="replace"){real.writeFileSync(file+".next",bytes,{mode:0o600});real.renameSync(file+".next",file);}
      if(fault==="rewrite"){real.writeFileSync(file,Buffer.from(bytes.toString().replace("CANARY_A","CANARY_B")));const s=real.statSync(file);real.utimesSync(file,s.atime,new Date(s.mtimeMs+1000));}
    }return count;
  }) as typeof fs.readSync);syncBuiltinESMExports();
  try {for(const selected of ["", "replace", "rewrite", "mode"]){
    real.writeFileSync(file,bytes,{mode:0o600});real.chmodSync(file,selected==="mode"?0o644:0o600);fault=selected;changed=false;
    const result=observeSyntheticResultFile(syntheticIdentity,true,"a".repeat(40));
    assert.equal(result.state,selected?"unavailable":"captured");assert.equal(held.size,0);assert(!JSON.stringify(result).includes("PRIVATE_CANARY"));
  }}finally{t.mock.restoreAll();syncBuiltinESMExports();real.rmSync(temporary,{recursive:true,force:true});}
});
test("complete fixed messages produce closed factual classes only", () => {
  const cases = [
    ["Client not member of any unit.", "client_outside_unit"], ["Invalid unit name or type.", "invalid_unit"],
    ["Invalid UnsetEnvironment= list.", "invalid_unset_environment"], ["Invalid environment assignments", "invalid_environment"],
    ["Invalid environment variable names or assignments", "invalid_environment_names"], ["Access denied", "access_denied"],
    ["Invalid argument", "invalid_argument"], ["Operation not permitted", "operation_not_permitted"],
    ["Permission denied", "permission_denied"], ["Timed out", "timed_out"], ["Not supported", "not_supported"],
    ["Connection refused", "connection_refused"], ["No such file or directory", "missing_file"],
  ];
  for (const [body, expected] of cases) {
    const facts = sample(`Failed to start transient service unit: ${body}\n`);
    assert.equal(facts.message, expected); assert.equal(facts.state, "complete");
    assert.equal(facts.ascii, true); assert.equal(facts.lineCount, 1);
  }
});
test("equal length secret body cannot identify the 71-byte cause or leak text", () => {
  const secret = "SECRET/auth/token/path/1234567";
  const text = `Failed to start transient service unit: ${secret}\n`;
  assert.equal(Buffer.byteLength(text), 71);
  const facts = sample(text); assert.equal(facts.message, "unknown");
  assert.equal(facts.state, "complete"); assert.equal(facts.suffixBytes, 30);
  assert.deepEqual(Object.keys(facts).sort(), ["ascii", "control", "fullBytes", "lineCount", "message", "nonAscii", "numericTokenCount", "offset", "sampleBytes", "state", "suffixBytes", "tokenCount"].sort());
  const serialized = JSON.stringify(facts);
  for (const forbidden of [secret, "SECRET", "/auth", "/token", "123456"]) assert(!serialized.includes(forbidden));
});
test("malformed, expanded and incomplete input never becomes a known message", () => {
  const line = "Failed to start transient service unit: Access denied\n";
  for (const text of [line.slice(0, -1), line + "extra\n", line.replace("Access", "\u001bAccess"),
    line.replace("Access", "\u0000Access"), line.replace("Access", "Áccess"), line.replace("\n", "\r\n"),
    line.replace("Access denied", "prefix Access denied"), line + line]) assert.equal(sample(text).message, "unknown");
  const bytes = Buffer.from(line);
  for (const context of [{ fullBytes: bytes.length + 1, offset: 1, initialBytes: bytes.length + 1, currentBytes: bytes.length + 1 },
    { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length + 1 },
    { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length + 1, currentBytes: bytes.length },
    { fullBytes: Infinity, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length },
    { fullBytes: bytes.length - 1, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length - 1 },
    { fullBytes: NaN, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length }, { fullBytes: bytes.length, offset: -1, initialBytes: bytes.length, currentBytes: bytes.length }]) {
    assert.equal(classifyTransientStartFailure(bytes, context).message, "unknown");
  }
  assert.equal(sample("x".repeat(4097)).state, "oversize");
  assert.equal(sample("Failed to start transient service unit: Access denied 123\n").numericTokenCount, 1);
});

test("exact socket-operation text yields a category without errno or raw body", () => {
  const text = "Failed to start transient service unit: Socket operation on non-socket\n";
  assert.equal(Buffer.byteLength(text), 71);
  const facts = sample(text); assert.equal(facts.message, "socket_operation_on_non_socket");
  assert.equal(facts.state, "complete"); assert.equal(facts.suffixBytes, 30);
  for (const key of ["errno", "errnoName", "errorName", "code", "cause", "property", "syscall", "fd"]) assert(!(key in facts));
  assert(!JSON.stringify(facts).includes("Socket operation on non-socket"));
  for (const near of [text.replace("non-socket", "non-socket."), text.replace("Socket", "socket"),
    text.replace("non-socket", "non-socket 88"), text.slice(0, -1)]) assert.equal(sample(near).message, "unknown");
});

test("owned proxy diagnostics distinguish argv and connection prefixes without publishing values", () => {
  const cases = [
    ["Failed to parse service property: PRIVATE_CANARY", "failed_to_parse"],
    ["Unknown assignment: PRIVATE_CANARY", "unknown_assignment"],
    ["Failed to set unit properties: PRIVATE_CANARY", "failed_to_set_unit_properties"],
    ["Failed to create bus connection: PRIVATE_CANARY", "failed_to_create_bus_connection"],
    ["Failed to connect to system scope bus via local transport: PRIVATE_CANARY", "failed_to_connect"],
    ["Failed to find executable /PRIVATE_CANARY", "failed_to_find_executable"],
    ["Failed to execute /PRIVATE_CANARY", "failed_to_execute"],
    ["Failed to start transient service unit: PRIVATE_CANARY", "failed_to_start_transient_service_unit"],
    ["/usr/bin/systemd-run: unrecognized option '--PRIVATE_CANARY'", "unrecognized_option"],
    ["systemd-run: invalid option -- PRIVATE_CANARY", "invalid_option"],
  ];
  for (const [text, prefix] of cases) {
    const bytes = Buffer.from(text + "\n");
    const facts = classifyOwnedProxyStderr(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length });
    assert.equal(facts.state, "complete"); assert.equal(facts.prefix, prefix);
    assert.equal(facts.optionPresenceBits, 0); assert.equal(facts.propertyPresenceBits, 0);
    assert(!JSON.stringify(facts).includes("PRIVATE_CANARY"));
  }
});

test("owned proxy exports only exact fixed recipe option and property bits", () => {
  const text = "Failed to parse --property=UnsetEnvironment=PRIVATE_CANARY --collect --collect-extra PrivateUnsetEnvironment=PRIVATE_CANARY\n";
  const bytes = Buffer.from(text), context = { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length };
  const facts = classifyOwnedProxyStderr(bytes, context);
  assert.equal(facts.optionPresenceBits, 2 ** ownedProxyOptionNames.indexOf("--property") + 2 ** ownedProxyOptionNames.indexOf("--collect"));
  assert.equal(facts.propertyPresenceBits, 2 ** ownedProxyPropertyNames.indexOf("UnsetEnvironment"));
  assert.deepEqual(Object.keys(facts).sort(), ["state", "prefix", "optionPresenceBits", "propertyPresenceBits"].sort());
  assert(!JSON.stringify(facts).includes("PRIVATE_CANARY"));
  for (const input of ["Unknown assignmentSecret\n", "Failed to parser PRIVATE_CANARY\n", "private/--collect-extra UnsetEnvironmentSuffix\n"]) {
    const value = Buffer.from(input);
    assert.deepEqual(classifyOwnedProxyStderr(value, { fullBytes: value.length, offset: 0, initialBytes: value.length, currentBytes: value.length }),
      { state: "complete", prefix: "unknown", optionPresenceBits: 0, propertyPresenceBits: 0 });
  }
  for (const input of [text.slice(0, -1), text + "PRIVATE_CANARY\n", text.replace("PRIVATE_CANARY", "\u0000PRIVATE_CANARY"),
    text.replace("PRIVATE_CANARY", "ÁPRIVATE_CANARY"), "x".repeat(4097)]) {
    const value = Buffer.from(input);
    const rejected = classifyOwnedProxyStderr(value, { fullBytes: value.length, offset: 0, initialBytes: value.length, currentBytes: value.length });
    assert.equal(rejected.prefix, "unknown");
    assert.equal(rejected.optionPresenceBits, 0); assert.equal(rejected.propertyPresenceBits, 0);
    assert.notEqual(rejected.state, "complete");
  }
  const changing = classifyOwnedProxyStderr(bytes, { ...context, currentBytes: bytes.length + 1 });
  assert.deepEqual(changing, { state: "partial", prefix: "unknown", optionPresenceBits: 0, propertyPresenceBits: 0 });
});

test("synthetic text requires exact fixture inputs and refuses live or changed provenance", () => {
  const runtime = "/opt/subscription-runtime-dependency-os-TEST", jobId = "TEST-os-11111111-2222-3333-4444-555555555555";
  const root = "/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/" + jobId, workspace = root + "/workspace";
  const args = [runtime + "/dist/worker-codex/codex-goal-cli.js", "run", "--task-id", jobId, "--job-id", jobId,
    "--job-root", root, "--workspace", workspace, "--prompt", root + "/prompt", "--accounts", "TEST-account", "--auth-root", root + "/auth",
    "--codex-binary", runtime + "/codex/bin/provider.ts", "--model", "TEST-synthetic-model", "--effort", "low", "--timeout", "5m",
    "--max-goal-turns", "1", "--max-attempts", "1", "--continuation-mode", "disabled", "--registry-root", root + "/state/registry",
    "--output", root + "/state/TEST-result.json", "--worker-report-mode", "structured-output"];
  const valid = { scenario: "dependency", phase: "fresh_real_cli", entry: runtime + "/scripts/dependency-retention-os-test/guest.ts",
    command: runtime + "/toolchain/bin/node", jobId, root, workspace, args,
    env: { ...cleanEnv, SUBSCRIPTION_RUNTIME_SANDBOX_KIND: "hosted-codex-job" },
    providerSha256: createHash("sha256").update(readFileSync(new URL("./provider.ts", import.meta.url))).digest("hex"),
    prompt: Buffer.from("Execute the fixed dependency-reading TEST probe. This is a synthetic provider protocol fixture.\n"),
    auth: Buffer.from(JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "TEST-NOT-A-CREDENTIAL" }, last_refresh: "2026-10-18T00:00:00.000Z" }) + "\n") };
  assert(verifiedSyntheticCliInputs(valid));
  assert.equal(valid.providerSha256, syntheticProviderSha256);
  const sample = Buffer.from("Unclassified fixture failure\n"), context = { fullBytes: sample.length, offset: 0, initialBytes: sample.length, currentBytes: sample.length };
  assert.equal(syntheticCliStderrDiagnostic(sample, context, verifiedSyntheticCliInputs(valid), "a".repeat(40)).state, "captured");
  // The hot phase is the same exact fixture invocation shape, so its bounded
  // redacted stderr text stays inside this closed channel.
  const hot = { ...valid, phase: "hot_real_cli" };
  assert(verifiedSyntheticCliInputs(hot));
  assert.equal(syntheticCliStderrDiagnostic(sample, context, verifiedSyntheticCliInputs(hot), "a".repeat(40)).state, "captured");
  for (const patch of [{ scenario: "current-dependency" }, { phase: "cold_real_cli" }, { entry: "/private/other.ts" },
    { providerSha256: "0".repeat(64) }, { root: "/real/job" }, { command: "/usr/bin/node" }, { prompt: Buffer.from("user data") },
    { env: { ...valid.env, OPENAI_API_KEY: "PRIVATE_CANARY" } }, { args: args.map(value => value === "TEST-account" ? "real-account" : value) },
    { args: args.map(value => value === "TEST-synthetic-model" ? "gpt-6.1-sol" : value) },
    { auth: Buffer.from(valid.auth.toString().replace("TEST-NOT-A-CREDENTIAL", "PRIVATE_CANARY")) },
    { auth: Buffer.from(valid.auth.toString().replace('"auth_mode":', '"private":"PRIVATE_CANARY","auth_mode":')) },
    { auth: Buffer.from(valid.auth.toString().replace('"auth_mode":', '"auth_mode":"PRIVATE_CANARY","auth_mode":')) }]) {
    const verified = verifiedSyntheticCliInputs({ ...valid, ...patch }); assert.equal(verified, false);
    assert.equal(syntheticCliStderrDiagnostic(sample, context, verified, "a".repeat(40)).state, "unavailable");
  }
});

test("synthetic capture exports only exact source-defined origin failures past the text entropy filter", () => {
  const purpose = "TEST_synthetic_cli_redacted_text_only", sha = "a".repeat(40);
  const observe = (text: string, trusted = true, change = {}, sourceSha = sha) => {
    const bytes = Buffer.from(text);
    return syntheticCliStderrDiagnostic(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length, ...change }, trusted, sourceSha);
  };
  for (const reason of ["hosted_current_dependency_origin_unresolved", "hosted_dependency_current_origin_unresolved"]) {
    const text = reason + "\n";
    assert.equal(Buffer.byteLength(text), 44);
    assert.deepEqual(observe(text), { purpose, state: "captured", closedReason: reason });
    for (const changed of ["prefix " + text, text.slice(0, -1) + " suffix\n", text.slice(0, -1), text + "\n",
      "Bearer PRIVATE_CANARY " + text, reason + "=PRIVATE_CANARY\n"]) {
      assert.deepEqual(observe(changed), { purpose, state: "unavailable" });
    }
    assert.deepEqual(observe(text, false), { purpose, state: "unavailable" });
    assert.deepEqual(observe(text, true, { offset: 1 }), { purpose, state: "unavailable" });
    assert.deepEqual(observe(text, true, { currentBytes: 45 }), { purpose, state: "unavailable" });
    assert.deepEqual(observe(text, true, {}, "invalid"), { purpose, state: "unavailable" });
  }
  for (const text of ["unknown_private_failure_".padEnd(43, "x") + "\n", "b".repeat(43) + "\n",
    "token=PRIVATE_CANARY\n", "aB9_".repeat(16) + "\n"]) {
    assert.deepEqual(observe(text), { purpose, state: "unavailable" });
  }
});

test("synthetic capture retains only a closed origin diagnostic behind unchanged stable provenance", () => {
  const diagnostic = { reason: "hosted_dependency_current_origin_unresolved", locations: [
    { module: "hosted-current-dependency-origin", format: "js", line: 160, column: 9 },
  ] };
  const observe = (value: unknown, trusted = true, change = {}) => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    return syntheticCliStderrDiagnostic(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length, ...change }, trusted, "a".repeat(40));
  };
  assert.deepEqual(observe(diagnostic), { purpose: "TEST_synthetic_cli_redacted_text_only", state: "captured",
    closedReason: diagnostic.reason, locations: diagnostic.locations });
  for (const value of [{ ...diagnostic, private: "PRIVATE_CANARY" }, { ...diagnostic, reason: "PRIVATE_CANARY" },
    { ...diagnostic, locations: [{ ...diagnostic.locations[0], module: "/PRIVATE_CANARY" }] },
    { ...diagnostic, locations: [{ ...diagnostic.locations[0], line: 1000000 }] }]) {
    assert.deepEqual(observe(value), { purpose: "TEST_synthetic_cli_redacted_text_only", state: "unavailable" });
  }
  assert.equal(observe(diagnostic, false).state, "unavailable");
  assert.equal(observe(diagnostic, true, { currentBytes: 1 }).state, "unavailable");
});

test("bounded synthetic text redacts identities, rejects unsafe samples and retains no secret canary", () => {
  const sha = "a".repeat(40), uuid = "11111111-2222-3333-4444-555555555555";
  const observe = (text: string, trusted = true, change = {}) => {
    const bytes = Buffer.from(text);
    return syntheticCliStderrDiagnostic(bytes, { fullBytes: bytes.length, offset: 0, initialBytes: bytes.length, currentBytes: bytes.length, ...change }, trusted, sha);
  };
  const result = observe(`Unclassified /var/lib/TEST-${uuid}/PRIVATE_CANARY failed for unit TEST-${uuid} at ${sha} TEST-NOT-A-CREDENTIAL\n`);
  assert.equal(result.state, "captured");
  assert('redactedText' in result && result.redactedText.includes("Unclassified <path> failed"));
  for (const value of [uuid, sha, "PRIVATE_CANARY", "TEST-NOT-A-CREDENTIAL", "/var/lib"]) assert(!JSON.stringify(result).includes(value));
  for (const text of ["Authorization: Bearer PRIVATE_CANARY\n", "refresh_token=PRIVATE_CANARY\n", "token=PRIVATE_CANARY\n",
    "password=PRIVATE_CANARY\n", "api_key=PRIVATE_CANARY\n", "sk-PRIVATE_CANARY\n", "ghs_PRIVATE_CANARY\n",
    "-----BEGIN PRIVATE KEY-----\n", "b".repeat(64) + "\n", "aB9_".repeat(16) + "\n", "eyJPRIVATE_CANARY.payload.signature\n",
    "text without newline", "one\ntwo\n", "nonascii Á\n", "control\u0000\n", "x".repeat(4096) + "\n"]) {
    const refused = observe(text); assert.equal(refused.state, "unavailable"); assert(!('redactedText' in refused));
    assert(!JSON.stringify(refused).includes("PRIVATE_CANARY"));
  }
  assert.equal(observe("plain error\n", false).state, "unavailable");
  assert.equal(observe("plain error\n", true, { currentBytes: 999 }).state, "unavailable");
  assert.equal(observe("plain error\n", true, { offset: 1 }).state, "unavailable");
  const before = { dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o100600, nlink: 1, size: 104, mtimeMs: 10, ctimeMs: 20 };
  assert(sameSyntheticDiagnosticFile(before, { ...before }));
  for (const change of [{ ino: 3 }, { mode: 0o100644 }, { nlink: 2 }, { size: 105 }, { mtimeMs: 11 }, { ctimeMs: 21 }, { uid: 1 }])
    assert.equal(sameSyntheticDiagnosticFile(before, { ...before, ...change }), false);
});
