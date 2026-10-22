import { isProxy, isUint8Array } from "node:util/types";
const ByteArray = Uint8Array, apply = Reflect.apply;
const typed = Object.getPrototypeOf(ByteArray.prototype);
const length = Object.getOwnPropertyDescriptor(typed,"byteLength")!.get!;
const offset = Object.getOwnPropertyDescriptor(typed,"byteOffset")!.get!;
const storage = Object.getOwnPropertyDescriptor(typed,"buffer")!.get!;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"resizable")?.get;
const detached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"detached")?.get;
const copy = ByteArray.prototype.set;
function invalid():never { throw new Error("hosted_bounded_byte_input_denied"); }
/** Data only. Real view/storage intrinsics, no iterator, species, caller getter or IO. */
export function copyBoundedHostedByteInput(input:unknown,maximum:number,minimum=0):Uint8Array {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || !Number.isSafeInteger(minimum) || minimum < 0 || minimum > maximum || isProxy(input) || !isUint8Array(input)) invalid();
  try {
    const size:number = apply(length,input,[]), start:number = apply(offset,input,[]), buffer:unknown = apply(storage,input,[]);
    // ArrayBuffer intrinsic rejects shared/proxy storage. Resizable/detached storage never enters the copy.
    const available:number = apply(bufferLength,buffer,[]);
    if (resizable && apply(resizable,buffer,[]) || detached && apply(detached,buffer,[]) || size < minimum || size > maximum || start < 0 || start+size > available) invalid();
    const bytes = new ByteArray(size); apply(copy,bytes,[input]);
    if (apply(length,input,[]) !== size || apply(offset,input,[]) !== start || apply(storage,input,[]) !== buffer || apply(bufferLength,buffer,[]) !== available) invalid();
    return bytes;
  } catch { invalid(); }
}
