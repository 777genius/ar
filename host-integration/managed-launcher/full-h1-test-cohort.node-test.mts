import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {ManagedLauncherProfile,fullPositiveTestJob,fullPositiveTestEntry,fullH1TestJob,fullH1TestEntry,assertManagedLauncherProfile,managedLauncherInvocation} from "./launch.mjs";
const request={operation:"job",unit:"subscription-job-"+createHash("sha256").update(fullH1TestJob).digest("hex")+".service",payload:["/usr/bin/true"],jobId:fullH1TestJob,fingerprint:"a".repeat(64),limits:{runtimeSeconds:90,stopSeconds:30,memoryMiB:256,tasksMax:64,cpuPercent:100}};
test("fixed original H1 profile selects only its source-defined entry and job",()=>{
 assertManagedLauncherProfile(ManagedLauncherProfile.FixedFullH1Test,fullH1TestJob);
 assert.deepEqual(managedLauncherInvocation(request,ManagedLauncherProfile.FixedFullH1Test).args,[fullH1TestEntry,"job",JSON.stringify(request)]);
 assert.throws(()=>managedLauncherInvocation(request));
 assert.throws(()=>managedLauncherInvocation(request,ManagedLauncherProfile.FixedFullPositiveTest));
 for(const jobId of [fullPositiveTestJob,"TEST-dependency-full-native-20261007-r1","TEST-unregistered"])
  assert.throws(()=>assertManagedLauncherProfile(ManagedLauncherProfile.FixedFullH1Test,jobId));
 assert.throws(()=>managedLauncherInvocation({...request,operation:"start"},ManagedLauncherProfile.FixedFullH1Test));
});
test("Positive original entry stays fixed and cannot select H1 through request fields",()=>{
 const positive={...request,jobId:fullPositiveTestJob};
 assert.deepEqual(managedLauncherInvocation(positive,ManagedLauncherProfile.FixedFullPositiveTest).args,[fullPositiveTestEntry,"job",JSON.stringify(positive)]);
 assert.throws(()=>assertManagedLauncherProfile("invented_profile",fullH1TestJob));
});

test("copied H1 parent or path DATA never establishes the original captured scope",async()=>{
 const {readOriginalFullParentPaths,originalFullParentGuestRoot,readRetainedOriginalFullParent}=await import("./dependency-full-native-TEST.js");let reads=0;const fake=Object.freeze({jobId:fullH1TestJob}),proxy=new Proxy(fake,{get(){reads++;throw Error("untrusted getter");}});
 for(const value of [fake,{...fake},proxy]){assert.throws(()=>readOriginalFullParentPaths(value));assert.throws(()=>originalFullParentGuestRoot(value,"11111111-1111-1111-1111-111111111111","/srv/workers/jobs/"+fullH1TestJob+"/os-TEST/11111111-1111-1111-1111-111111111111/root"));}assert.throws(readRetainedOriginalFullParent);assert.equal(reads,0);
});

// Component DATA fixtures only. These never enter the native issuer or claim PID1 success.
function completedPublicationFixture(){
 const sum=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)+'\n').digest('hex'),sourceSha='a'.repeat(40),sourceTree='e'.repeat(40),manifestSha256='b'.repeat(64),bootId='11111111-1111-1111-1111-111111111111',reviewSha256='c'.repeat(64),catalogSha256='d'.repeat(64),invocationId='f'.repeat(32);
 const names=[['preparation-input.json','source.bundle','public-files.payload','stage-current-positive-public.mts','stage-current-h1-public.mts','run-current-h1-public.mts','h1-toolroot-plan-UNADMITTED.json','h1-toolroot.payload'],['review.json','outer-input.json','public-input.json','h1-staged-subject.json','h1-distro-facts.json','h1-verifier-bootstrap-review.json','h1-distro-assets.payload']];
 const prepared={version:1,phase:'prepare',sourceSha,manifestSha256,prepareDeliverySha256:'',bootId,files:names[0]!.map((name,i)=>({name,bytes:1,sha256:i===0?manifestSha256:i===3?'6e5b0c00c93fc4a7a6db82ea81654fd98a4aa2acce1a51184a08aea665fe234a':'1'.repeat(64)}))};
 const final={version:1,phase:'finalize',sourceSha,manifestSha256,prepareDeliverySha256:sum(prepared),bootId,files:names[1]!.map((name,i)=>({name,bytes:1,sha256:i===0?reviewSha256:'2'.repeat(64)}))};
 const key=createHash('sha256').update(sourceSha+':'+manifestSha256).digest('hex'),unit='subscription-runtime-h1-installation-finalize-'+key+'.service',group='/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/'+unit;
 const publication={version:1,status:'H1_PUBLICATION_UNQUALIFIED_DATA',jobId:fullH1TestJob,sourceSha,sourceTree,reviewSha256,catalogSha256,nativeQualified:'UNPROVEN'};
 const intent={version:1,unit,deliverySha256:sum(final),sourceSha,manifestSha256,bootId,cgroup:group,argv:['--unit='+unit,'--service-type=exec','--expand-environment=no',...['User=0','Group=0','Slice=subscription-runtime-hosted.slice','Restart=no','Delegate=no','KillMode=control-group','SendSIGKILL=yes','TimeoutStopSec=30s','RuntimeMaxSec=5min','RemainAfterExit=yes','LimitNOFILE=65536','NoNewPrivileges=yes','CapabilityBoundingSet=CAP_SYS_PTRACE','AmbientCapabilities=','WorkingDirectory=/','PrivateNetwork=no','PrivateTmp=no','PrivateDevices=no','ProtectSystem=no','RootDirectory=','RootImage=','StandardInput=null','StandardOutput=journal','StandardError=journal','UMask=0077','Environment=','PassEnvironment=','EnvironmentFile=','SetLoginEnvironment=no','UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH LOCPATH GLIBC_TUNABLES OPENSSL_CONF OPENSSL_MODULES NODE_V8_COVERAGE'].map(v=>'--property='+v),'/opt/nodejs/node-v24.21.0-linux-x64/bin/node','/srv/workers/public-intake/'+fullH1TestJob+'/full-h1-installation-signed-distro-v1/run-current-h1-public.mts','finalize',sum(final)],retry:'HOLD'};
 const bundle={prepared,final,prepareResult:{version:1,status:'PREPARED_UNADMITTED_DATA',unit:'subscription-runtime-h1-installation-prepare-'+key+'.service',invocationId:'3'.repeat(32),deliverySha256:sum(prepared),sourceSha,manifestSha256,catalogSha256,stageReceiptSha256:'4'.repeat(64),toolReceiptSha256:'5'.repeat(64),nativeQualified:'UNPROVEN',retry:'HOLD'},started:{version:1,unit,invocationId,pid:123,startTicks:'456',deliverySha256:sum(final)},intent,result:{version:1,status:'FINALIZED_NOT_STARTED',unit,invocationId,deliverySha256:sum(final),prepareDeliverySha256:sum(prepared),sourceSha,manifestSha256,publicationSha256:sum(publication),nativeQualified:'UNPROVEN',retry:'HOLD'},publication,unit:{Id:unit,LoadState:'loaded',ActiveState:'active',SubState:'exited',Result:'success',ExecMainStatus:'0',MainPID:'0',InvocationID:invocationId,Job:'',ControlGroup:group,Transient:'yes',RemainAfterExit:'yes',Restart:'no',KillMode:'control-group',SendSIGKILL:'yes',Delegate:'no',PrivateNetwork:'no',PrivateTmp:'no',PrivateDevices:'no',RootDirectory:'',RootImage:'',LimitNOFILE:'65536',NoNewPrivileges:'yes',RuntimeMaxUSec:'5min',TimeoutStopUSec:'30s',CapabilityBoundingSet:'cap_sys_ptrace',AmbientCapabilities:'',ProtectSystem:'no'}};
 return {bundle,expected:{sourceSha,sourceTree,bootId,reviewSha256,catalogSha256}};
}
test('complete original publication DATA joins result and terminal unit but emits no request or authority',async()=>{
 const {fullH1FinalizationData}=await import('./dependency-full-native-TEST.js'),{bundle,expected}=completedPublicationFixture();
 assert.deepEqual(fullH1FinalizationData(bundle,expected),{unit:bundle.unit.Id,group:bundle.unit.ControlGroup,invocationId:bundle.unit.InvocationID});
 assert.equal(Object.hasOwn(fullH1FinalizationData(bundle,expected),'operation'),false);
});
for(const variant of ['missing_result','failed_result','live_finalizer','failed_unit','wrong_invocation','different_review','different_source','different_boot','wrong_operation','different_publication','wrong_runner','expanded_capability'] as const)test('published review DATA still refuses '+variant,async()=>{
 const {fullH1FinalizationData}=await import('./dependency-full-native-TEST.js'),{bundle,expected}=completedPublicationFixture();
 const b=bundle as unknown as Record<string,unknown>;
 if(variant==='missing_result')delete b.result;
 if(variant==='failed_result')bundle.result.status='H1_PHASE_PARTIAL_OR_UNCERTAIN';
 if(variant==='live_finalizer'){bundle.unit.SubState='running';bundle.unit.MainPID='123';}
 if(variant==='failed_unit')bundle.unit.Result='exit-code';
 if(variant==='wrong_invocation')bundle.unit.InvocationID='0'.repeat(32);
 if(variant==='different_review')expected.reviewSha256='0'.repeat(64);
 if(variant==='different_source')expected.sourceSha='0'.repeat(40);
 if(variant==='different_boot')expected.bootId='22222222-2222-2222-2222-222222222222';
 if(variant==='wrong_operation')bundle.final.prepareDeliverySha256='0'.repeat(64);
 if(variant==='different_publication')bundle.publication.sourceTree='0'.repeat(40);
 if(variant==='wrong_runner')bundle.intent.argv[bundle.intent.argv.length-3]='other-runner.mts';
 if(variant==='expanded_capability')bundle.unit.CapabilityBoundingSet='cap_sys_ptrace cap_sys_admin';
 assert.throws(()=>fullH1FinalizationData(bundle,expected));
});
test('publication DATA cannot bypass the original no-argument H1 request issuer',async()=>{
 const {fullH1ManagedStartRequest}=await import('./dependency-full-native-TEST.js'),{bundle}=completedPublicationFixture();
 assert.throws(()=>Reflect.apply(fullH1ManagedStartRequest,undefined,[bundle]));
});
test('terminal released-cgroup DATA is distinct from arbitrary foreign or live unit DATA',async()=>{
 const {fullH1FinalizationData}=await import('./dependency-full-native-TEST.js'),{bundle,expected}=completedPublicationFixture();
 bundle.unit.ControlGroup='';assert.equal(fullH1FinalizationData(bundle,expected).unit,bundle.unit.Id);
 // The defining reader separately requires exact anchored ENOENT; this parser grants no absence proof.
 bundle.unit.ControlGroup='/unrelated';assert.throws(()=>fullH1FinalizationData(bundle,expected));
 bundle.unit.ControlGroup='';bundle.unit.SubState='running';assert.throws(()=>fullH1FinalizationData(bundle,expected));
});
