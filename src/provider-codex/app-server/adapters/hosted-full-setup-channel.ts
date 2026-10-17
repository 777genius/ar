import type {ChildProcess} from "node:child_process";
import {readHostedFdProcessBirth,type HostedFdLaunchKind} from "./hosted-fd-child";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readOriginalHostedDependencyBackingStage, originalPair, protectedJson, live } from "./hosted-full-backing-stage";
import { assertFullParentProcFiles } from "./hosted-full-backing-proc";
import type { HostedFdProcess, HostedFdUnit } from "./hosted-fd-observation";
import { hostedFdNamespacePrefix } from "./hosted-fd-namespace-stages";
import { assertOriginalFullBackingPreparation } from "./hosted-full-backing-stage";
import { readHostedPrivateBytes } from "./hosted-private-physical-inputs";
enum FullSetupPhase { Closed="CLOSED" }

const directory = "/run/TEST-full-flow-outbox/current-full-provider-setups";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
function held(): never { throw new Error("hosted_original_full_setup_held"); }
function check(value: unknown): asserts value { if (!value) held(); }
export type OriginalFullSetup = Readonly<{ nonce: string; intentSha256: string; challenge: string;
  born(child:ChildProcess,proof: Readonly<{unit:HostedFdUnit;proxy:HostedFdProcess;bootstrap:HostedFdProcess;endpoints:readonly string[]}>, remaining:()=>number):void;
  revalidate(remaining:()=>number):void }>;
/** Called only by the fixed FDA constructor BEFORE its physical spawn. This
 * file protocol conveys facts. The original HOST parent independently rejoins
 * its pre-submission source closure, actual producer, child, unit and FDs. */
export function retainOriginalFullSetupIntent(unit: string, command: string, args: readonly string[], serviceArgv: readonly string[],
  producer: HostedFdProcess, kind:HostedFdLaunchKind, remaining:()=>number): OriginalFullSetup | undefined {
  const stage = readOriginalHostedDependencyBackingStage();
  if (stage.schemaVersion === 1) return undefined;
  // CLOSED installation qualification precedes the once-only backing seal.
  // No provider operation in the FULL flow precedes this seal.
  if (!existsSync(live + "/seals/current-full-backing.json")) {
    assertOriginalFullBackingPreparation();
    const activationBytes=readHostedPrivateBytes("/var/lib/subscription-runtime-host-policy/host-activation.json",4*1024*1024);check(activationBytes);
    const activation:unknown=JSON.parse(activationBytes.toString("utf8"));check(activation && typeof activation==="object" && "phase" in activation && activation.phase===FullSetupPhase.Closed);
    return undefined;
  }
  const runtime="/opt/subscription-runtime-dependency-os-TEST";
  check(hostedFdNamespacePrefix.every((value,index) => serviceArgv[index] === value) || serviceArgv[0]===runtime+"/toolchain/bin/node" &&
    (serviceArgv.length===3 && serviceArgv[1]===runtime+"/dist/worker-codex/hosted-readonly-host-launch-cli.js" && serviceArgv[2]==="ordinary-bootstrap" || serviceArgv.length===2 && serviceArgv[1]===runtime+"/dist/worker-codex/hosted-readonly-runtime-bootstrap.js"));
  const current = originalPair(), nonce = randomUUID();
  const intent = bytes({schemaVersion:1,nonce,pairSha256:hash(current.pairFile.bytes),invocationSealSha256:hash(current.invocationFile.bytes),
    producerPid:producer.pid,producerBirth:producer.birth,unit,command,args:[...args],serviceArgv:[...serviceArgv]});
  check(intent.length <= 65536);
  const dir = lstatSync(directory);check(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid===0 && dir.gid===0 && (dir.mode&0o7777)===0o700);
  const revalidateParent=()=>{remaining();assertFullParentProcFiles(live+"/stat",live+"/status",current.expected);
    check(protectedJson(live+"/seals/current-full-pair.json").bytes.equals(current.pairFile.bytes) && protectedJson(live+"/seals/current-full-pair-invocation.json").bytes.equals(current.invocationFile.bytes));};
  const publish=(suffix:string,data:Buffer)=>{
    revalidateParent();const pending=directory+"/.pending-"+nonce+suffix,path=directory+"/"+nonce+suffix;
    const fd=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}linkSync(pending,path);unlinkSync(pending);revalidateParent();
  };
  const response=(suffix:string)=>{
    const path=live+"/seals/current-full-provider-"+nonce+suffix;
    while(!existsSync(path) || lstatSync(path).nlink!==1){revalidateParent();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}
    revalidateParent();const row=protectedJson(path).value;
    check(row && typeof row==="object" && Object.keys(row).sort().join(",")==="challenge,intentSha256,nonce,schemaVersion" &&
      "schemaVersion" in row && row.schemaVersion===1 && "nonce" in row && row.nonce===nonce && "intentSha256" in row && row.intentSha256===hash(intent) &&
      "challenge" in row && typeof row.challenge==="string" && /^[a-f0-9]{64}$/.test(row.challenge));
    return row.challenge;
  };
  publish(".intent.json",intent);const challenge=response(".intent.json");let enrolled=false,submitted=false;let originalChild:ChildProcess|undefined,originalBirth:string|undefined;
  const childJoin=()=>{check(originalChild && originalBirth && readHostedFdProcessBirth(originalChild,unit,kind,command,args)===originalBirth);};
  return Object.freeze({nonce,intentSha256:hash(intent),challenge,
    born(child,proof,remainingBorn){check(!submitted);remainingBorn();
      const birth=readHostedFdProcessBirth(child,unit,kind,command,args);check(proof.proxy.pid===child.pid && proof.proxy.birth===birth);submitted=true;originalChild=child;originalBirth=birth;
      // This proof comes from the FDA's privately retained physical child.
      // The HOST still measures every reported process/FD independently.
      const birthBytes=bytes({schemaVersion:1,nonce,intentSha256:hash(intent),challenge,
        unit:proof.unit,proxyPid:proof.proxy.pid,proxyBirth:proof.proxy.birth,bootstrapPid:proof.bootstrap.pid,bootstrapBirth:proof.bootstrap.birth,
        stdio:proof.bootstrap.descriptors.filter(fd=>fd.fd<3),endpoints:[...proof.endpoints]});
      check(birthBytes.length<=16384);childJoin();publish(".birth.json",birthBytes);check(response(".birth.json")===challenge);childJoin();remainingBorn();enrolled=true;
    },
    revalidate(remainingNow){check(enrolled);childJoin();remainingNow();revalidateParent();check(response(".birth.json")===challenge);remainingNow();}
  });
}
