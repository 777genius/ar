import { types } from "node:util";
import { copyBoundedHostedByteInput } from "./hosted-bounded-byte-input";
import { DependencyLocalClosureKind } from "../worker-core/dependency-environment/domain/dependency-local-closure";
import { NpmLocalPinKind } from "../worker-local/dependency-environment/capture-npm-local-closure";
import type { HostedDependencyLocalKeyInputs } from "./hosted-dependency-materialization-context";
function refused():never {throw new Error("hosted_dependency_warm_leaf_unsupported");}
/** Data capture only. No origin, owner, FD, callback or permission is accepted. */
export function captureHostedDependencyWarmLeafRequest(input:unknown):Readonly<{relativePath:string;bytes:Uint8Array}> {
  if(typeof input!=="object" || input===null || types.isProxy(input))refused();
  const descriptors=Object.getOwnPropertyDescriptors<object>(input),keys=Reflect.ownKeys(descriptors);
  if(keys.length!==2 || !keys.includes("relativePath") || !keys.includes("bytes"))refused();
  const path=descriptors.relativePath,bytes=descriptors.bytes;
  if(!path || !("value" in path) || typeof path.value!=="string" || !bytes || !("value" in bytes))refused();
  const relativePath=path.value;
  if(relativePath.length>4096 || !relativePath || relativePath.split("/").some(part=>
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(part) || part==="." || part===".."))refused();
  return Object.freeze({relativePath,bytes:copyBoundedHostedByteInput(bytes.value,1024*1024)});
}
/** Actual captured local inputs determine membership. This classifier is not
 * authority; the fixed original-map producer alone consumes its result. */
export function selectHostedDependencyWarmLeaf(inputs:HostedDependencyLocalKeyInputs,path:string):void {
  const parts=path.toLowerCase().split("/"),name=parts.at(-1)!;
  if(parts.some(part=>["node_modules","cache","caches","dist","build","coverage","vendor","bin","scripts","hooks"].includes(part)) ||
      /(?:^|[_.-])(?:config|lock|manifest|lifecycle|ignore|auth|credential|secret)(?:[_.-]|$)/i.test(name) ||
      ["package.json","npm-shrinkwrap.json","yarn.lock","pnpm-lock.yaml","binding.gyp","makefile","readme","license","licence","copying"].includes(name) ||
      !/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(name))refused();
  const local=inputs.capture.closure.packages.filter(pkg=>pkg.kind===DependencyLocalClosureKind.PureWorkspaceLink &&
    pkg.path!=="" && path.startsWith(pkg.path+"/"));
  if(local.length!==1 || inputs.capture.pins.some(pin=>pin.kind===NpmLocalPinKind.File && pin.path===path) ||
      inputs.capture.absentPaths.includes(path) || inputs.capture.closure.packages.some(pkg=>
        pkg.kind===DependencyLocalClosureKind.PackedDirectory && (path===pkg.path || path.startsWith(pkg.path+"/"))))refused();
}
