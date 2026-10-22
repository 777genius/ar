/** Proposed signed-extraction emitter, before runtime/config copies. No apt/tool launch.
 * Caller is existing assembler after signed-index SHA/size authentication + extraction.
 * This emits candidate input; independent review must authenticate it before H1 use. */
import { createHash } from "node:crypto";
import { chmodSync, constants, closeSync, fsyncSync, lstatSync, openSync, writeSync } from "node:fs";
import { capturePythonEnvelope, type EnvelopeLimits, type SignedPackage } from "../../host-integration/managed-launcher/dependency-full-python-envelope-TEST.ts";
const runtime="/opt/subscription-runtime-dependency-os-TEST";
export function emitSignedPythonEnvelopeCatalog(root:string,packages:readonly SignedPackage[],measuredLimits:EnvelopeLimits,remainingMs:()=>number) {
 const remaining=remainingMs();if(!Number.isSafeInteger(remaining)||remaining<=0||measuredLimits.elapsedMs>remaining)throw new Error("TEST signed envelope unmeasured deadline");
 const original=lstatSync(root+runtime,{bigint:true});if(!original.isDirectory()||original.uid!==0n||original.gid!==0n||(original.mode&0o022n))throw new Error("TEST signed envelope output custody");
 const sorted=[...packages].sort((a,b)=>a.package<b.package?-1:a.package>b.package?1:0);
 const captured=capturePythonEnvelope(root,sorted,measuredLimits),bytes=Buffer.from(JSON.stringify(captured.catalog)+"\n");
 if(bytes.length>measuredLimits.catalogBytes)throw new Error("TEST signed envelope measured catalog bound");
 if(remainingMs()<=0)throw new Error("TEST signed envelope assembly deadline");
 const path=root+runtime+"/os-signed-python-envelope.json",fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)throw new Error("TEST signed envelope write incomplete");offset+=n;}fsyncSync(fd);}finally{closeSync(fd);}
 chmodSync(path,0o444);const after=lstatSync(root+runtime,{bigint:true});
 if(after.dev!==original.dev||after.ino!==original.ino||after.uid!==original.uid||after.gid!==original.gid||after.mode!==original.mode)throw new Error("TEST signed envelope output replaced");
 if(remainingMs()<=0)throw new Error("TEST signed envelope assembly deadline");
 const candidate=Object.freeze({path:"os-signed-python-envelope.json",sha256:createHash("sha256").update(bytes).digest("hex"),
  packagesSha256:createHash("sha256").update(JSON.stringify(captured.catalog.packages)).digest("hex"),measurement:captured.measurement,
  authority:"signed-extraction-candidate-not-installed-qualification" as const});
 if(remainingMs()<=0)throw new Error("TEST signed envelope final assembly deadline");return candidate;
}
