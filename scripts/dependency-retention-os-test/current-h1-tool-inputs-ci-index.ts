/** Data-only Ubuntu signature/index protocol. Callers cannot acquire a host capability. */
import { createHash } from "node:crypto";
import { joinAcquiredSignedPackage, type AcquiredSignedPackage } from "./current-h1-tool-inputs-package.ts";
export enum CiUbuntuPocket { Noble="noble", Updates="noble-updates", Security="noble-security" }
export enum CiUbuntuComponent { Main="main", Universe="universe" }
// Independent fixed trust anchor from Ubuntu security documentation, not a fetched key hash:
// https://documentation.ubuntu.com/security/software-integrity/image-verification/
export const ubuntuArchive2018Fingerprint="F6ECB3762474EDA9D21B7022871920D1991BC93C";
export const ciUbuntuSources=Object.freeze([
 Object.freeze({base:"https://archive.ubuntu.com/ubuntu",pocket:CiUbuntuPocket.Noble}),
 Object.freeze({base:"https://archive.ubuntu.com/ubuntu",pocket:CiUbuntuPocket.Updates}),
 Object.freeze({base:"https://security.ubuntu.com/ubuntu",pocket:CiUbuntuPocket.Security}),
]);
export const ciIndexOperationalBytes=128*1024*1024; // CI data-operation ceiling, not a native catalog limit.
const requireFact=(value:unknown,why:string):void=>{if(!value)throw new Error("TEST CI signed data refused: "+why);};
/** Curated public records and original Debian archives share one basename rule. */
export function assertCiPublicEvidenceBasename(name:string):void {
 requireFact(name.length>0&&name.length<=255&&name!=="."&&name!==".."&&/^[A-Za-z0-9_.+%:~-]+$/.test(name),"single public evidence basename");
}
export function assertUbuntuArchiveSignature(status:string):void {
 requireFact(Buffer.byteLength(status)<=1024*1024&&!status.includes("\0"),"signature status bound");
 const rows=status.trim().split("\n").map(line=>line.split(" "));
 requireFact(!rows.some(row=>row[0]==="[GNUPG:]"&&["BADSIG","ERRSIG","EXPSIG","EXPKEYSIG","REVKEYSIG","NO_PUBKEY","NODATA","FAILURE"].includes(row[1]??"")),"signature veto");
 const valid=rows.filter(row=>row[0]==="[GNUPG:]"&&row[1]==="VALIDSIG");
 requireFact(valid.length===1,"single valid archive signature");const row=valid[0]!;
 requireFact(row.length===12&&row[11]===ubuntuArchive2018Fingerprint&&row[2]===ubuntuArchive2018Fingerprint&&row[8]==="1"&&["8","9","10"].includes(row[9]??""),"fixed archive primary fingerprint/algorithm");
}
export interface CiSignedIndexRow {readonly path:string;readonly sha256:string;readonly size:number}
/** Only consumes plaintext output AFTER genuine gpgv exit0 and fixed-primary check. */
export function parseUbuntuRelease(release:string,pocket:CiUbuntuPocket,nowMs:number):ReadonlyMap<string,CiSignedIndexRow> {
 requireFact(Buffer.byteLength(release)<=1024*1024&&!release.includes("\0"),"release bound");
 const fields=new Map<string,string>(),hashes=new Map<string,CiSignedIndexRow>();let shaSection=false;
 for(const line of release.trimEnd().split("\n")) {
  if(line.startsWith(" ")){if(!shaSection)continue;const match=/^ ([a-f0-9]{64}) +([0-9]+) ([A-Za-z0-9_+@./-]+)$/.exec(line);requireFact(match,"release SHA256 row");
   const path=match![3]!,size=Number(match![2]);requireFact(Number.isSafeInteger(size)&&size>=0&&!path.startsWith("/")&&!path.split("/").some(part=>part==="."||part==="..")&&!hashes.has(path),"canonical unique release row");hashes.set(path,Object.freeze({path,sha256:match![1]!,size}));continue;}
  const split=line.indexOf(":");requireFact(split>0,"release field");const key=line.slice(0,split),value=line.slice(split+1).trim();requireFact(!fields.has(key),"duplicate release field");fields.set(key,value);shaSection=key==="SHA256";
 }
 requireFact(fields.get("Origin")==="Ubuntu"&&fields.get("Label")==="Ubuntu"&&fields.get("Suite")===pocket&&fields.get("Codename")==="noble","original Ubuntu pocket");
 const date=Date.parse(fields.get("Date")??"");requireFact(Number.isFinite(date)&&date<=nowMs+600000,"release date");
 if(fields.has("Valid-Until")){const until=Date.parse(fields.get("Valid-Until")!);requireFact(Number.isFinite(until)&&until>=nowMs&&until>=date,"release expiry");}
 for(const component of [CiUbuntuComponent.Main,CiUbuntuComponent.Universe]){const path=component+"/binary-amd64/Packages",row=hashes.get(path);requireFact(row&&row.size>0&&row.size<=ciIndexOperationalBytes,"complete index operation bound");}
 return hashes;
}
export function assertCompleteUbuntuIndex(bytes:Buffer,row:CiSignedIndexRow):void {
 requireFact(row.size>0&&row.size<=ciIndexOperationalBytes&&bytes.length===row.size,"complete index EOF/size");
 requireFact(createHash("sha256").update(bytes).digest("hex")===row.sha256,"complete index signed SHA256");
}
/** Scans complete authenticated bytes; existing pure package verifier owns the
 * five-cell stanza join. No apt-cache text or caller strings supply authenticity. */
export function joinCompleteUbuntuIndex(debFields:string,index:Buffer,archive:Readonly<{sha256:string;size:number}>):AcquiredSignedPackage|undefined {
 requireFact(index.length<=ciIndexOperationalBytes&&!index.includes(0),"index operation bound");let at=0,joined:AcquiredSignedPackage|undefined;
 const expectedPackage=/^Package: ([a-z0-9][a-z0-9+.-]*)$/m.exec(debFields)?.[1];requireFact(expectedPackage,"deb package field");
 const marker=Buffer.from("Package: "+expectedPackage+"\n");
 while(at<index.length){const end=index.indexOf("\n\n",at),stop=end<0?index.length:end;requireFact(stop-at<=4*1024*1024,"index stanza bound");const stanza=index.subarray(at,stop);
  if(stanza.subarray(0,marker.length).equals(marker)||stanza.indexOf(Buffer.from("\n"+marker.toString()))>=0){
   // A package may have several signed versions. Match exact control identity first.
   const text=stanza.toString("utf8");const version=/^Version: (\S+)$/m.exec(debFields)?.[1],arch=/^Architecture: (\S+)$/m.exec(debFields)?.[1];
   if(text.split("\n").includes("Version: "+version)&&text.split("\n").includes("Architecture: "+arch)){
    const current=joinAcquiredSignedPackage(debFields,text,archive);requireFact(!joined||JSON.stringify(joined)===JSON.stringify(current),"conflicting complete index stanza");joined=current;
   }
  }at=end<0?index.length:end+2;
 }
 return joined;
}
