import { lstatSync, readdirSync } from "node:fs";
import { DependencyContentObservationReadStatus, readDependencyContentObservationFacts,
  dependencyContentObservationLimit,
  type DependencyContentObservationReport } from "../core/dependency-environment/dependency-content-observation";
import { assertHostedActivationFence, assertHostedActivationOperator, type HostedActivationFence } from "../provider-codex/app-server/adapters/hosted-process-activation";
import { pinReferenceFile } from "./hosted-dependency-legacy-reference-records";
const root="/var/lib/subscription-runtime-host-policy/dependency-content-observations";
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unknown=():DependencyContentObservationReport=>({status:DependencyContentObservationReadStatus.Unknown,attempted:null,completed:null,finalRoot:null});
function privateDirectory(path:string) {
  const s=lstatSync(path,{bigint:true});if(!s.isDirectory() || s.isSymbolicLink() || s.uid!==0n || (s.mode&0o7777n)!==0o700n)throw new Error("observation_directory_invalid");
  return `${s.dev}:${s.ino}:${s.ctimeNs}:${s.mtimeNs}`;
}
/** Read-only historical facts, never a current purpose/admission permit.
 * IDs select only fixed protected names; absent or partial records are Unknown. */
export function readHostedDependencyContentObservationReport(fence:HostedActivationFence,startId:string,attemptId:string):DependencyContentObservationReport {
  if(typeof startId!=="string" || typeof attemptId!=="string" || startId.length!==36 || attemptId.length!==36 || !uuid.test(startId) || !uuid.test(attemptId))return unknown();
  assertHostedActivationFence(fence);assertHostedActivationOperator();
  try {
    const directory=`${root}/${startId}/${attemptId}`,roots=[root,`${root}/${startId}`,directory],before=roots.map(privateDirectory);
    const names=readdirSync(directory).sort();if(names.length>2*dependencyContentObservationLimit+2 ||
      names.some(name=>! /^(?:opened|closed|(?:[1-9]|1[0-6])\.(?:started|returned))\.json$/.test(name)))return unknown();
    const pins=names.map(name=>pinReferenceFile(`${directory}/${name}`,16384)),rows=pins.map(pin=>JSON.parse(pin.bytes.toString("utf8")) as unknown);
    for(let index=0;index<rows.length;index++) {
      const row=rows[index];if(typeof row!=="object" || row===null || !("kind" in row))return unknown();
      const expected=row.kind==="opened" || row.kind==="closed" ? `${row.kind}.json` :
        (row.kind==="started" || row.kind==="returned") && "ordinal" in row ? `${row.ordinal}.${row.kind}.json` : undefined;
      if(expected!==names[index])return unknown();
    }
    const opened=rows.find(row=>typeof row==="object" && row!==null && "kind" in row && row.kind==="opened");
    if(!opened || typeof opened!=="object" || !("identity" in opened) || typeof opened.identity!=="object" || opened.identity===null ||
       !("startId" in opened.identity) || opened.identity.startId!==startId || !("attemptId" in opened.identity) || opened.identity.attemptId!==attemptId)return unknown();
    const result=readDependencyContentObservationFacts(opened.identity,rows,pins.map(pin=>pin.reference));
    if(result.status!==DependencyContentObservationReadStatus.Complete)return result;
    if(JSON.stringify(readdirSync(directory).sort())!==JSON.stringify(names) || roots.some((path,index)=>privateDirectory(path)!==before[index]))return unknown();
    for(let index=0;index<pins.length;index++) {
      const again=pinReferenceFile(`${directory}/${names[index]}`,16384),pin=pins[index]!;
      if(!again.bytes.equals(pin.bytes) || JSON.stringify(again.reference)!==JSON.stringify(pin.reference))return unknown();
    }
    assertHostedActivationFence(fence);return result;
  }catch{return unknown();}
}
