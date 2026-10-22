import {describe,it,expect} from "vitest";
import {HostedConfiguredAuthAttachmentKind,parseHostedConfiguredAuthAttachment} from "../hosted-configured-auth-attachment";
const job="/var/lib/subscription-runtime-host-policy/dependency-test-jobs/jobs/TEST-os-00000000-0000-4000-8000-000000000001";
const account="account-r",source=`/run/TEST-configured-codex-auth/${account}/auth.json`,target=`${job}/auth/${account}/auth.json`;
const args=["--accounts",account,"--auth-root",job+"/auth"];
function data(){
 const paths=new Set<string>();for(const leaf of [source,target]){let p=leaf.slice(0,leaf.lastIndexOf("/"));for(;;){paths.add(p);if(p==="/")break;p=p.slice(0,p.lastIndexOf("/"))||"/";}}
 const file={dev:"1",ino:"2",mode:String(0o100600),uid:"0",gid:"0",nlink:"1",size:"123",mtimeNs:"4",ctimeNs:"5"};
 return {kind:HostedConfiguredAuthAttachmentKind.ReadonlyLeafV1,account,source,target,bootId:"00000000-0000-4000-8000-000000000001",mountNamespace:"mnt:[123]",issuerBirth:"4:55",issuerGroup:"0::/system.slice/TEST-retention-supervisor.service",sourceMount:`10 1 1:1 /seed ${source} ro - ext4 /dev/test rw`,targetMount:`11 1 1:1 /seed ${target} ro,nosuid,nodev,noexec - ext4 /dev/test rw`,file,underlying:{...file,ino:"3",size:"0"},ancestors:[...paths].map(path=>({path,dev:"1",ino:"2",mode:String(0o40700),uid:"0",gid:"0",mountId:"1"}))};
}
describe("configured auth profile grammar only, never native authority",()=>{
 it("preserves exact one-account metadata and freezes the parsed role",()=>{const p=parseHostedConfiguredAuthAttachment(data(),job,args);expect(p.account).toBe(account);expect(Object.isFrozen(p)).toBe(true);expect(Object.isFrozen(p.ancestors)).toBe(true);});
 it("rejects extra fields, alternate kind, external path and multiple-account recipes",()=>{
  for(const value of [{...data(),permit:true},{...data(),kind:"other"},{...data(),target:job+"/workspace/auth.json"},{...data(),source:"/tmp/auth.json"}])expect(()=>parseHostedConfiguredAuthAttachment(value,job,args)).toThrow();
  expect(()=>parseHostedConfiguredAuthAttachment(data(),job,["--accounts","account-r,other","--auth-root",job+"/auth"])).toThrow();
 });
 it("rejects writable/shared source or missing physical ancestry and nonempty original target",()=>{
  const a=data();for(const value of [{...a,file:{...a.file,nlink:"2"}},{...a,file:{...a.file,mode:String(0o100666)}},{...a,underlying:{...a.underlying,size:"1"}},{...a,ancestors:a.ancestors.slice(1)}])expect(()=>parseHostedConfiguredAuthAttachment(value,job,args)).toThrow();
 });
});
