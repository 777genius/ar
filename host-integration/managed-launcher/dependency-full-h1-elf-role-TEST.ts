/** Pure bounded ELF DATA validation. This supplies no custody, source proof or execution authority.
 * Existing envelope/closure validation remains mandatory at the original admission boundary. */
export enum H1ElfRole { Loader="loader", Program="program", SharedObject="shared-object", Extension="extension", Libc="libc" }
export interface H1ElfRoleData {
 readonly role:H1ElfRole; readonly elfType:2|3; readonly entry:bigint;
 readonly soname:string|null; readonly needed:readonly string[]; readonly interpreter:string|null;
}
interface Segment { readonly type:number; readonly flags:number; readonly offset:number; readonly va:bigint; readonly fileSize:number; readonly memorySize:bigint }
function requireThat(value:unknown,reason:string):asserts value { if(!value)throw new Error("TEST H1 ELF role Held: "+reason); }
const max64=0xffffffffffffffffn;
// Linux finite basename limit; 256 dependencies and 32 KiB decoded names comfortably
// exceed normal original tools/DSOs while bounding malicious repeated suffix references.
const nameBytes=255,dependencyCount=256,aggregateNameBytes=32768;
const safeName=(name:string)=>name.length<=nameBytes&&/^[A-Za-z0-9_+.-]+$/.test(name)&&name!=="."&&name!=="..";
/** expectedSoname is the exact finite dependency alias basename, never a path or glob.
 * Unique binding of this name to retained closure identity remains the caller's responsibility. */
export const h1LibcCanonicalPath="/usr/lib/x86_64-linux-gnu/libc.so.6";
export function validateH1ElfRole(bytes:Buffer,role:H1ElfRole,expectedSoname?:string,canonicalPath?:string):H1ElfRoleData {
 requireThat(role===H1ElfRole.Loader||role===H1ElfRole.Program||role===H1ElfRole.SharedObject||role===H1ElfRole.Extension||role===H1ElfRole.Libc,"unknown role");
 requireThat(role===H1ElfRole.Libc?expectedSoname==="libc.so.6"&&canonicalPath===h1LibcCanonicalPath:canonicalPath===undefined&&(role===H1ElfRole.SharedObject?typeof expectedSoname==="string"&&safeName(expectedSoname):expectedSoname===undefined),"SONAME/canonical role expectation");
 // Explicit fixed caps bound iteration independently of any caller metadata.
 requireThat(Buffer.isBuffer(bytes)&&bytes.length>=64&&bytes.length<=128*1024*1024,"byte bound");
 requireThat(bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))&&bytes[4]===2&&bytes[5]===1&&bytes[6]===1&&bytes.readUInt16LE(18)===62&&bytes.readUInt32LE(20)===1&&bytes.readUInt16LE(52)===64,"ELF64 LE x86_64 header");
 const elfType=bytes.readUInt16LE(16);requireThat((elfType===2||elfType===3)&&((role!==H1ElfRole.SharedObject&&role!==H1ElfRole.Extension&&role!==H1ElfRole.Libc)||elfType===3),"ELF type for role");
 const number=(n:bigint)=>{requireThat(n<=BigInt(Number.MAX_SAFE_INTEGER),"unsafe integer");return Number(n);};
 const range=(offset:number,size:number)=>requireThat(Number.isSafeInteger(offset)&&Number.isSafeInteger(size)&&offset>=0&&size>=0&&offset<=bytes.length&&size<=bytes.length-offset,"file range");
 const entry=bytes.readBigUInt64LE(24),ph=number(bytes.readBigUInt64LE(32)),width=bytes.readUInt16LE(54),count=bytes.readUInt16LE(56);
 requireThat(ph>=64&&width===56&&count>0&&count<=4096,"program table");range(ph,count*width);
 const segments:Segment[]=[];let interpreter:string|null=null;
 const rawText=(offset:number,size:number)=>{range(offset,size);requireThat(size>0,"empty string range");const end=bytes.subarray(offset,offset+Math.min(size,nameBytes+1)).indexOf(0);requireThat(end>=0,"string terminator/name byte bound");const raw=bytes.subarray(offset,offset+end);requireThat(raw.every(b=>b>=32&&b<=126),"string encoding");return raw;};
 for(let i=0;i<count;i++){
  const p=ph+i*width,type=bytes.readUInt32LE(p),flags=bytes.readUInt32LE(p+4),offset=number(bytes.readBigUInt64LE(p+8)),va=bytes.readBigUInt64LE(p+16),fileSize=number(bytes.readBigUInt64LE(p+32)),memorySize=bytes.readBigUInt64LE(p+40),align=bytes.readBigUInt64LE(p+48);
  requireThat([0,1,2,3,4,6,7,0x6474e550,0x6474e551,0x6474e552,0x6474e553].includes(type)&&flags<=7,"unsupported segment");range(offset,fileSize);
  requireThat(va<=max64-memorySize&&BigInt(fileSize)<=memorySize,"segment virtual range");
  requireThat(align<=1n||((align&(align-1n))===0n&&va%align===BigInt(offset)%align),"segment alignment");
  const s=Object.freeze({type,flags,offset,va,fileSize,memorySize});segments.push(s);
  if(type===3){requireThat(interpreter===null&&(role===H1ElfRole.Program||role===H1ElfRole.Libc),"interpreter role/count");interpreter=rawText(offset,fileSize).toString("ascii");requireThat(interpreter==="/lib64/ld-linux-x86-64.so.2"&&Buffer.byteLength(interpreter)+1===fileSize,"interpreter escape/trailing data");}
 }
 const loads=segments.filter(s=>s.type===1);requireThat(loads.length>0,"missing load segment");
 for(let i=0;i<loads.length;i++)for(let j=0;j<i;j++){const a=loads[i]!,b=loads[j]!;requireThat(a.memorySize===0n||b.memorySize===0n||a.va+a.memorySize<=b.va||b.va+b.memorySize<=a.va,"ambiguous load overlap");}
 if(role===H1ElfRole.Loader||role===H1ElfRole.Program||role===H1ElfRole.Libc)requireThat(entry!==0n&&loads.filter(s=>(s.flags&1)!==0&&entry>=s.va&&entry-s.va<BigInt(s.fileSize)).length===1,"entry outside file-backed executable load");
 const dynamics=segments.filter(s=>s.type===2);requireThat(dynamics.length<=1,"multiple dynamic tables");
 let soname:string|null=null;const needed:string[]=[];
 if(dynamics.length){
  const d=dynamics[0]!;requireThat(d.fileSize>0&&d.fileSize%16===0&&d.fileSize<=1024*1024,"dynamic size");
  requireThat(loads.filter(s=>d.va>=s.va&&d.va+BigInt(d.fileSize)<=s.va+BigInt(s.fileSize)&&BigInt(d.offset-s.offset)===d.va-s.va).length===1,"dynamic mapping");
  let strVa:bigint|undefined,strSize:number|undefined,ended=false,neededCount=0,sonameCount=0;const names:{tag:bigint;value:bigint}[]=[];
  for(let at=d.offset;at<d.offset+d.fileSize;at+=16){
   const tag=bytes.readBigInt64LE(at),value=bytes.readBigUInt64LE(at+8);
   if(tag===0n){ended=true;break;}
   requireThat(![15n,29n,0x6ffffefan,0x6ffffefbn,0x6ffffefcn,0x7ffffffdn,0x7fffffffn].includes(tag),"search/audit/filter/auxiliary/config route");
   if(tag===5n){requireThat(strVa===undefined,"duplicate string table");strVa=value;}
   if(tag===10n){requireThat(strSize===undefined,"duplicate string size");strSize=number(value);}
   if(tag===1n){requireThat(++neededCount<=dependencyCount,"dependency count bound");names.push({tag,value});}
   if(tag===14n){requireThat(++sonameCount===1,"multiple SONAME");names.push({tag,value});}
  }
  requireThat(ended&&strVa!==undefined&&strSize!==undefined&&strSize>0&&strSize<=1024*1024,"dynamic completeness");
  requireThat(strVa<=max64-BigInt(strSize),"string virtual overflow");
  const mappings=loads.filter(s=>strVa!>=s.va&&strVa!+BigInt(strSize!)<=s.va+BigInt(s.fileSize));requireThat(mappings.length===1,"ambiguous string mapping");
  const s=mappings[0]!,base=s.offset+number(strVa-s.va);range(base,strSize);
  let total=0;const decodedNames=names.map(row=>{requireThat(row.value<BigInt(strSize),"string offset");const raw=rawText(base+number(row.value),strSize-number(row.value));total+=raw.length;requireThat(total<=aggregateNameBytes,"aggregate name byte bound");return {tag:row.tag,raw};});
  // No string allocation until every count, individual and aggregate byte bound passed.
  const seen=new Set<string>();
  for(const row of decodedNames){const value=row.raw.toString("ascii");requireThat(safeName(value),"dependency/SONAME escape");if(row.tag===14n)soname=value;else {requireThat(!seen.has(value),"duplicate dependency");seen.add(value);needed.push(value);}}
 }
 requireThat(role!==H1ElfRole.Loader||needed.length===0,"loader dependency");
 requireThat((role!==H1ElfRole.SharedObject&&role!==H1ElfRole.Libc)||soname===expectedSoname,"SONAME alias mismatch/absence");
 requireThat(role!==H1ElfRole.Libc||interpreter==="/lib64/ld-linux-x86-64.so.2","libc fixed interpreter");
 requireThat(new Set(needed).size===needed.length,"duplicate dependency");
 return Object.freeze({role,elfType,entry,soname,needed:Object.freeze(needed),interpreter});
}
