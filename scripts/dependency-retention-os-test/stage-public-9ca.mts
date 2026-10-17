// SOURCE proposal only. No CLI entry point, installation, grant, retry or cleanup.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

export const HEAD = '9ca302fabd07b5cbccd103b7d0cbe16d86f0a8c6';
const TREE = '0afa5dd67c6294f86ec374b4b0396eb257a2f4fa';
const JOB_NAME = 'TEST-dependency-full-native-20261007-r1';
const JOB = `/srv/workers/jobs/${JOB_NAME}`;
export const PUBLIC_INTAKE = `/srv/workers/public-intake/${JOB_NAME}/${HEAD}`;
const UNIT = 'subscription-job-23c9a46219542abcbf6025cdbf5c4b1f400e653c9d7da5c0aee721ef7148b2a3.service';
const LEDGER = `/root/.local/state/subscription-runtime/host-jobs/${UNIT}.json`;
const C = fs.constants;
type Identity = Readonly<{ dev: string; ino: string; mntId: string; mode: number; uid: number; gid: number }>;
export interface RootPrerequisites {
  // Supplied by the separately accepted owned ROOT boundary. This is not an approval issuer.
  readonly ownerBoundaryReviewSha256: string;
  readonly intakeOwnerReceiptSha256: string;
  readonly intakeIdentity: Identity;
  readonly originalProtectedInputsUnchanged: true;
  readonly noActiveOrPersistedReferences: true;
}
type Held = { fd: number; name: string; path: string; identity: Identity; directory: boolean };
type Pin = readonly [name: string, bytes: number, sha256: string];
type Row = { path: string; bytes: number; mode: number; sha256: string; role?: string; gitBlob?: string };
export interface PublicStageReceipt {
  readonly kind: 'PUBLIC_DATA_ONLY_NON_AUTHORITATIVE'; readonly head: typeof HEAD;
  readonly tree: string; readonly created: readonly { name: string; identity: Identity }[];
  readonly inputs: readonly Pin[]; readonly fullEightAcceptance: 'UNPROVEN';
}
const ARCHIVES: readonly Pin[] = [
  ['source-9ca302.bundle',9515981,'751d6a7ea31d117372931a3e85753f9c8094d6c8541f931b43e75743f288fe50'],
  ['profile-artifact.zip',462454,'4c13ddadf5a2034c3a5fc5e0790f9ddeb24bb605efce8df9fd7dc16a635f3af3'],
  ['runtime-artifact.zip',109932227,'cafd730f3df83a2dca92e77108d22fb7e23d5bc43a39d1949db73090f97f9c6d'],
  ['runtime-validated-public.tgz',110282985,'9bb742c25a01a5ddbf4d016c120eefcf4578f8437bd198d906011e7052c41199'],
  ['node-v22.23.3-linux-x64.tar.xz',31001304,'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'],
];
const DATA: readonly Pin[] = [
  ['current-git-role-manifest.json',691624,'38ea482effc0cb868d034238623086817a9749556040566d403117295ff7caf8'],
  ['current-generated-role-manifest.json',48516,'5226833c66b69e5b2665fb21f9c7cc68151b17692f61c2896f5ba6e716635283'],
  ['runtime-role-manifest.json',2389594,'78d58e4c45908944a198c593d922590d7f258d8289d9d3ccbd7d56cb3afab7f8'],
  ['actual-current-runtime-inventory.json',2410688,'bb1e9b7fa0acdc16b5854b365d080f37f6039ee68e4a213c9b4243a8054a943a'],
  ['node-full-member-manifest.json',1101418,'f2eab34d34f0cda8f4a9d71398cc21d6bec14749e49f351cdf974a80f9586fac'],
  ['DATA-FREEZE.json',2016,'3b886270007b0cc7a0366f5e732a07ef96ac8b8f2c81b4109379b3013f2d3c1c'],
  ['DATA-review.json',9942,'9af07989e7476c5b8b31c97b459e8af1e801a8a53722c895d95f30142a1dfe1e'],
];
const LINKS = new Map([
  ['bin/corepack','../lib/node_modules/corepack/dist/corepack.js'],
  ['bin/npx','../lib/node_modules/npm/bin/npx-cli.js'],
  ['bin/npm','../lib/node_modules/npm/bin/npm-cli.js'],
]);
function hold(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(`HOLD: ${why}`);
}
function digest(bytes: Uint8Array, algorithm = 'sha256'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}
function safe(path: string): void {
  hold(path.length > 0 && !path.startsWith('/') && !/[\x00-\x1f\x7f\\]/u.test(path)
    && path.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'unsafe relative member');
}
function absent(path: string): void {
  try { fs.lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw new Error('HOLD: destination or protected absence collision');
}
function mnt(fd: number): string {
  const value = /^mnt_id:\s+(\d+)$/mu.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1];
  hold(value, 'missing retained mount ID'); return value;
}
function identity(fd: number): Identity {
  const s = fs.fstatSync(fd, { bigint: true });
  return {dev:String(s.dev),ino:String(s.ino),mntId:mnt(fd),mode:Number(s.mode & 0o7777n),uid:Number(s.uid),gid:Number(s.gid)};
}
function equal(a: Identity, b: Identity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function fdPath(h: Held): string { return `/proc/self/fd/${h.fd}`; }
function join(h: Held, rel: string): string {
  safe(rel);
  return `${fdPath(h)}/${rel}`;
}
function check(h: Held): void {
  hold(equal(h.identity, identity(h.fd)) && fs.realpathSync(fdPath(h)) === h.path, 'held identity/name changed');
  const named = fs.lstatSync(h.name, {bigint:true});
  hold(!named.isSymbolicLink() && String(named.dev) === h.identity.dev && String(named.ino) === h.identity.ino
    && Number(named.mode & 0o7777n) === h.identity.mode && named.uid === 0n && named.gid === 0n
    && (h.directory ? named.isDirectory() : named.isFile() && named.nlink === 1n), 'named/held identity changed');
  const reopened = fs.openSync(h.name,C.O_RDONLY|C.O_NOFOLLOW|(h.directory?C.O_DIRECTORY:0));
  try {
    hold(equal(h.identity,identity(reopened)), 'fresh named/held mount identity changed');
  } finally {
    fs.closeSync(reopened);
  }
}
function openHeld(name: string, directory: boolean, handles: Held[], expectedMode?: number): Held {
  const fd = fs.openSync(name,C.O_RDONLY|C.O_NOFOLLOW|(directory ? C.O_DIRECTORY : 0));
  const h: Held = {fd,name,path:fs.realpathSync(`/proc/self/fd/${fd}`),directory,identity:identity(fd)};
  handles.push(h);
  check(h);
  hold(h.identity.uid === 0 && h.identity.gid === 0 && (h.identity.mode & 0o022) === 0
    && (expectedMode === undefined || h.identity.mode === expectedMode), 'unprotected owner/mode');
  return h;
}
function hashFile(h: Held, pin: Pin): void {
  check(h);
  const before = fs.fstatSync(h.fd,{bigint:true});
  hold(before.size === BigInt(pin[1]),'size mismatch');
  const hash = createHash('sha256'), b = Buffer.alloc(1024*1024); let position = 0;
  for (;;) {
    const n = fs.readSync(h.fd,b,0,b.length,position);
    if (n === 0) break;
    hash.update(b.subarray(0,n));
    position += n;
  }
  const after = fs.fstatSync(h.fd,{bigint:true});
  hold(position === pin[1] && hash.digest('hex') === pin[2] && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs, 'changed archive/leaf bytes');
  check(h);
}
function writeWhole(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const n = fs.writeSync(fd,data,offset,data.length-offset);
    hold(n > 0,'short write');
    offset += n;
  }
}
function rows(h: Held, count: number): Row[] {
  const data: unknown = JSON.parse(fs.readFileSync(h.fd,'utf8')); hold(Array.isArray(data) && data.length === count,'manifest count');
  const seen = new Set<string>(); return data.map((item: unknown) => {
    hold(item !== null && typeof item === 'object','manifest row'); const x = item as Record<string,unknown>;
    hold(typeof x.path === 'string' && Number.isSafeInteger(x.bytes) && Number(x.bytes) >= 0
      && typeof x.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(x.sha256),'manifest fields'); safe(x.path);
    hold(!seen.has(x.path),'duplicate role member'); seen.add(x.path);
    const mode = x.mode === '100644' ? 0o644 : x.mode === '100755' ? 0o755 : x.mode;
    hold(mode === 0o644 || mode === 0o755,'unreviewed member mode');
    return {path:x.path,bytes:Number(x.bytes),sha256:x.sha256,mode,
      ...(typeof x.role === 'string' ? {role:x.role} : {}),...(typeof x.gitBlob === 'string' ? {gitBlob:x.gitBlob} : {})};
  });
}
// No shell. Archive FD -> child 3 and destination FD -> child 4; no arbitrary executable or args API is exported.
function child(executable: '/usr/bin/git'|'/usr/bin/tar'|'/usr/bin/systemctl',args: string[], archive?: Held, dest?: Held, input?: Buffer): string {
  const result = spawnSync(executable,args,{shell:false,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024,
    env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:JOB,TMPDIR:`${JOB}/tmp`,
      GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},
    stdio:['pipe','pipe','pipe',archive?.fd ?? 'ignore',dest?.fd ?? 'ignore'],...(input ? {input} : {})});
  hold(!result.error && result.signal === null && result.status === 0,'owned child failure/uncertain result; preserve partial');
  return result.stdout;
}
export function stagePublic9ca(prerequisites: RootPrerequisites): PublicStageReceipt {
  hold(process.platform === 'linux' && process.getuid?.() === 0 && process.getgid?.() === 0,'requires reviewed Linux ROOT owner');
  hold(/^[a-f0-9]{64}$/u.test(prerequisites.ownerBoundaryReviewSha256)
    && /^[a-f0-9]{64}$/u.test(prerequisites.intakeOwnerReceiptSha256)
    && prerequisites.originalProtectedInputsUnchanged && prerequisites.noActiveOrPersistedReferences,'missing external ROOT/intake/reference prerequisites');
  const handles: Held[] = [], created: Held[] = [], originals: [Held,Pin][] = [];
  const nsfd = fs.openSync('/proc/self/ns/mnt',C.O_RDONLY), ns = fs.fstatSync(nsfd,{bigint:true});
  const nsIdentity = identity(nsfd), nsName = fs.readlinkSync('/proc/self/ns/mnt');
  const oldMask = process.umask(0o022); let job: Held | undefined;
  function guard(): void {
    const now = fs.statSync('/proc/self/ns/mnt',{bigint:true}); hold(ns.dev === now.dev && ns.ino === now.ino
      && equal(nsIdentity,identity(nsfd)) && nsName===fs.readlinkSync('/proc/self/ns/mnt'),'mount namespace changed');
    hold(fs.readFileSync('/etc/machine-id','utf8').trim() === 'd856d40da5ad4e23b4f67773e5942842'
      && fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() === 'f12bc43a-9252-42d4-919d-85b846a176a8','machine/boot changed');
    for (const h of handles) check(h);
    const mountText=fs.readFileSync('/proc/self/mountinfo','utf8');
    hold(Buffer.byteLength(mountText)<=8*1024*1024,'mount view exceeds proposal bound');
    const mounts=mountText.trim().split('\n').map(l=>({line:l,fields:l.split(' ')}));
    const scratch=mounts.filter(m=>m.fields[4]==='/srv/workers');
    hold(scratch.length===1 && scratch[0]!.fields[0]===workers.identity.mntId && scratch[0]!.fields[3]==='/'
      && scratch[0]!.line.includes(' - ext4 '),'unsupported/stacked/redirected scratch mount');
    for(const mount of mounts) {
      const point=mount.fields[4];
      hold(point,'malformed mount point');
      if(point.startsWith('/srv/workers/')) {
        hold(![JOB,PUBLIC_INTAKE].some(target=>point===target
          || target.startsWith(`${point}/`) || point.startsWith(`${target}/`)),
          'nested/ancestor input or destination mount');
      }
    }
    hold(String(fs.statSync('/dev/disk/by-uuid/d0f2cac1-2009-4e9d-a710-e156f417938f',{bigint:true}).rdev) === workers.identity.dev,'scratch UUID/device changed');
    absent(LEDGER);
    if(!job) absent(JOB);
    else for (const p of ['public-codex-download','public-codex-input']) absent(join(job,p));
  }
  function fresh(parent: Held, name: string, mode = 0o700): Held {
    guard();
    const p = join(parent,name);
    absent(p);
    fs.mkdirSync(p,{mode});
    const h = openHeld(p,true,handles,mode);
    created.push(h);
    hold(h.identity.dev === '66305' && h.identity.mntId === workers.identity.mntId,'new dir mount redirection');
    fs.fsyncSync(parent.fd);
    return h;
  }
  function parent(root: Held, rel: string): {dir: Held; leaf: string} {
    safe(rel); const parts = rel.split('/'), leaf = parts.pop(); hold(leaf,'missing basename'); let dir = root;
    for (const part of parts) {
      const p = join(dir,part); let next = handles.find(h => h.directory && h.name === p);
      if (!next) { try { fs.lstatSync(p); next = openHeld(p,true,handles); } catch(e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; next = fresh(dir,part,0o755);
      } } hold(next.identity.dev === root.identity.dev && next.identity.mntId === root.identity.mntId,'nested mount'); dir = next;
    } return {dir,leaf};
  }
  function verify(root: Held, row: Row, blob = false): void {
    const p = parent(root,row.path), h = openHeld(join(p.dir,p.leaf),false,handles,row.mode);
    try { hold(h.identity.dev === root.identity.dev && h.identity.mntId === root.identity.mntId,'leaf mount redirection');
      hashFile(h,[row.path,row.bytes,row.sha256]);
      if (blob) hold(row.gitBlob === digest(Buffer.concat([Buffer.from(`blob ${row.bytes}\0`),fs.readFileSync(h.fd)]),'sha1'),'Git blob mismatch');
      fs.fsyncSync(h.fd);
    } finally { handles.splice(handles.indexOf(h),1); fs.closeSync(h.fd); }
  }
  function census(root: Held, expected: readonly Row[], links = new Map<string,string>(), skipGit = false, directoryCount?: number): void {
    let directories = 1;
    const leaves = new Set(expected.map(r => r.path)), got = new Set<string>(), allowedDirs = new Set<string>();
    for (const p of [...leaves,...links.keys()]) { const parts = p.split('/'); parts.pop(); while(parts.length) {allowedDirs.add(parts.join('/')); parts.pop();} }
    function walk(dir: Held, prefix: string): void {
      for (const entry of fs.readdirSync(fdPath(dir))) {
        const rel = prefix ? `${prefix}/${entry}` : entry; safe(rel); const p = join(dir,entry), s = fs.lstatSync(p);
        if (skipGit && rel === '.git') { hold(s.isDirectory() && !s.isSymbolicLink(), 'foreign git directory'); continue; }
        if (s.isDirectory()) {
          // Node full archive may include reviewed empty directories, all under its hash-pinned role.
          hold(allowedDirs.has(rel) || root === toolchain,'unexpected source directory');
          directories++; const sub = handles.find(h=>h.directory&&h.name===p) ?? openHeld(p,true,handles);
          hold(sub.identity.dev === root.identity.dev && sub.identity.mntId === root.identity.mntId,'census nested mount'); walk(sub,rel); fs.fsyncSync(sub.fd);
        } else if (s.isSymbolicLink()) {
          hold(links.get(rel) === fs.readlinkSync(p) && s.uid === 0 && s.gid === 0 && s.nlink === 1,'unknown link'); got.add(rel);
        } else { hold(s.isFile() && leaves.has(rel),'unexpected leaf/type'); got.add(rel); }
      }
    } walk(root,''); hold(got.size === leaves.size+links.size && [...leaves,...links.keys()].every(p => got.has(p)),'incomplete role census');
    hold(directoryCount===undefined || directories===directoryCount,'complete toolchain directory count');
    for (const row of expected) verify(root,row); fs.fsyncSync(root.fd);
  }
  let workers: Held, toolchain: Held;
  try {
    const root = openHeld('/',true,handles), srv = openHeld(join(root,'srv'),true,handles,0o755);
    hold(srv.identity.dev === '2306' && srv.identity.ino === '13631489','srv snapshot changed');
    workers = openHeld(join(srv,'workers'),true,handles,0o755);
    hold(workers.identity.dev === '66305' && workers.identity.ino === '2','workers snapshot changed');
    const jobs = openHeld(join(workers,'jobs'),true,handles,0o755);
    hold(jobs.identity.dev === '66305' && jobs.identity.ino === '144310273','jobs snapshot changed'); guard();
    const space = fs.statfsSync(fdPath(workers),{bigint:true}); hold(space.bavail*space.bsize >= 14n*1024n**3n && space.ffree >= 100000n,'scratch fit gate');
    const memory = /^MemAvailable:\s+(\d+) kB$/mu.exec(fs.readFileSync('/proc/meminfo','utf8'))?.[1];
    hold(memory && BigInt(memory)*1024n >= 9n*1024n**3n,'memory fit gate');
    const unit = child('/usr/bin/systemctl',['show',UNIT,'--property=LoadState,ActiveState,FragmentPath,UnitFileState']);
    hold(unit.includes('LoadState=not-found\n') && unit.includes('ActiveState=inactive\n')
      && unit.includes('FragmentPath=\n') && unit.includes('UnitFileState=\n'),'unit exists/uncertain');
    absent(join(jobs,JOB_NAME));
    let intake = workers;
    for (const part of ['public-intake',JOB_NAME,HEAD]) intake = openHeld(join(intake,part),true,handles,0o700);
    hold(equal(intake.identity,prerequisites.intakeIdentity) && intake.identity.dev === workers.identity.dev
      && intake.identity.mntId === workers.identity.mntId,'unverified foreign intake');
    const roster=fs.readdirSync(fdPath(intake)).sort(), fixedRoster=[...ARCHIVES,...DATA].map(pin=>pin[0]).sort();
    hold(JSON.stringify(roster)===JSON.stringify(fixedRoster),'intake must contain exactly the12 fixed names');
    const inputs = new Map<string,Held>();
    for (const pin of [...ARCHIVES,...DATA]) {
      const h = openHeld(join(intake,pin[0]),false,handles,0o400);
      hashFile(h,pin);
      inputs.set(pin[0],h);
      originals.push([h,pin]);
    }
    const required = (name: string): Held => {
      const h=inputs.get(name);
      hold(h,'missing fixed input');
      return h;
    };
    const gitRows=rows(required(DATA[0]![0]),2240), generated=rows(required(DATA[1]![0]),182);
    const runtime=rows(required(DATA[2]![0]),10856), allRuntime=rows(required(DATA[3]![0]),10959);
    const node=rows(required(DATA[4]![0]),4750).map(r => {hold(r.path.startsWith('node-v22.23.3-linux-x64/'),'Node prefix'); return {...r,path:r.path.slice(24)};});
    const tracked = new Map(gitRows.map(r => [r.path,r])), overlay=generated.filter(r => r.role === 'generated_overlay_only_untracked');
    hold(overlay.length === 116 && generated.filter(r => r.role === 'tracked_identity_join_no_overlay').length === 66
      && gitRows.filter(r=>r.mode===0o644).length===2228 && gitRows.filter(r=>r.mode===0o755).length===12,'generated/Git roles');
    hold(node.every(r=>!LINKS.has(r.path)&&![...LINKS.keys()].some(p=>r.path.startsWith(`${p}/`)))
      && runtime.every(r => r.path.startsWith('dist/') || r.path.startsWith('node_modules/'))
      && runtime.reduce((n,r)=>n+r.bytes,0) === 384657322 && node.reduce((n,r)=>n+r.bytes,0) === 196362450,'complete role envelope');
    const known = new Set([...tracked.keys(),...overlay.map(r=>r.path)]); hold(known.size === 2356 && runtime.every(r=>!known.has(r.path)),'role collision');
    for(const r of generated.filter(r=>r.role === 'tracked_identity_join_no_overlay')) hold(tracked.get(r.path)?.sha256 === r.sha256,'generated tracked join');
    for(const r of allRuntime.filter(r=>!r.path.startsWith('dist/')&&!r.path.startsWith('node_modules/'))) {
      const t=tracked.get(r.path); hold(t && t.sha256===r.sha256 && t.mode===r.mode && t.bytes===r.bytes,'runtime provenance join');
    }
    hold(tracked.get('package.json')?.sha256 === '68a91f14118d7b4dc06b02dad1835bc1db19760e5329faff1f4805cbd1508b29','root source metadata');
    guard();
    job=fresh(jobs,JOB_NAME);
    fresh(job,'tmp');
    const artifacts=fresh(job,'artifacts'), input=fresh(job,'input'), sha=fresh(input,HEAD);
    for (const pin of [...ARCHIVES,...DATA]) {
      const h=required(pin[0]), p=join(artifacts,pin[0]), fd=fs.openSync(p,C.O_CREAT|C.O_EXCL|C.O_WRONLY|C.O_NOFOLLOW,0o400);
      try {
        const b=Buffer.alloc(1024*1024);
        let off=0;
        for (;;) {
          const n=fs.readSync(h.fd,b,0,b.length,off);
          if(!n) break;
          writeWhole(fd,b.subarray(0,n));
          off+=n;
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const copy=openHeld(p,false,handles,0o400);
      hashFile(copy,pin);
      inputs.set(pin[0],copy);
      hashFile(h,pin);
    }
    const source=fresh(sha,'source'); toolchain=fresh(sha,'toolchain');
    const git=(args:string[]):string=>child('/usr/bin/git',['-c','core.hooksPath=/dev/null',...args],required(ARCHIVES[0]![0]),source);
    git(['clone','--template=','--no-checkout','--no-hardlinks','--','/proc/self/fd/3','/proc/self/fd/4']);
    git(['-C','/proc/self/fd/4','bundle','verify','/proc/self/fd/3']);
    git(['-C','/proc/self/fd/4','checkout','--detach',HEAD]);
    function gitCheck():void {
      git(['-C','/proc/self/fd/4','fsck','--full','--strict']);
      hold(git(['-C','/proc/self/fd/4','rev-parse','--verify','HEAD']).trim()===HEAD
        && git(['-C','/proc/self/fd/4','rev-parse','--verify','HEAD^{tree}']).trim()===TREE
        && git(['-C','/proc/self/fd/4','status','--porcelain','--untracked-files=no'])==='','Git identity/clean');
      hold(fs.readFileSync(join(source,'.git/HEAD'),'utf8')===`${HEAD}\n`,'not detached');
      for(const p of ['.git/objects/info/alternates','.git/objects/info/http-alternates','.git/shallow','.git/info/grafts']) absent(join(source,p));
      hold(git(['-C','/proc/self/fd/4','for-each-ref','refs/replace'])==='','replace refs');
      for(const r of gitRows)verify(source,r,true);
    }
    gitCheck();
    guard();
    // Fixed reviewed ZIP182: central/local identity, CRC, exact joins, then exclusive overlay116.
    const zip=fs.readFileSync(required(ARCHIVES[1]![0]).fd), eocd=zip.length-22;
    hold(zip.readUInt32LE(eocd)===0x06054b50 && zip.readUInt16LE(eocd+4)===0 && zip.readUInt16LE(eocd+6)===0
      && zip.readUInt16LE(eocd+8)===182 && zip.readUInt16LE(eocd+10)===182 && zip.readUInt16LE(eocd+20)===0,'unsupported ZIP container');
    let cursor=zip.readUInt32LE(eocd+16); const expected=new Map(generated.map(r=>[r.path,r])), seen=new Set<string>();
    function crc(bytes:Buffer):number {
      let c=0xffffffff;
      for(const b of bytes) {
        c^=b;
        for(let j=0;j<8;j++) c=(c>>>1)^((c&1)?0xedb88320:0);
      }
      return(c^0xffffffff)>>>0;
    }
    for(let i=0;i<182;i++) {
      hold(zip.readUInt32LE(cursor)===0x02014b50,'ZIP central header');
      const flags=zip.readUInt16LE(cursor+8), method=zip.readUInt16LE(cursor+10);
      const packed=zip.readUInt32LE(cursor+20), size=zip.readUInt32LE(cursor+24);
      const nameLength=zip.readUInt16LE(cursor+28), extra=zip.readUInt16LE(cursor+30);
      const comment=zip.readUInt16LE(cursor+32), local=zip.readUInt32LE(cursor+42);
      const name=zip.subarray(cursor+46,cursor+46+nameLength).toString('utf8'), row=expected.get(name);
      safe(name);
      hold(row && !seen.has(name) && (flags&~0x808)===0 && (method===0||method===8) && size===row.bytes
        && zip.readUInt16LE(cursor+34)===0 && zip.readUInt32LE(local)===0x04034b50,'ZIP member');
      seen.add(name);
      const ln=zip.readUInt16LE(local+26),le=zip.readUInt16LE(local+28),start=local+30+ln+le;
      hold(zip.readUInt16LE(local+6)===flags && zip.readUInt16LE(local+8)===method
        && zip.subarray(local+30,local+30+ln).toString('utf8')===name && start+packed<=zip.readUInt32LE(eocd+16),'ZIP local join');
      const packedBytes=zip.subarray(start,start+packed), bytes=method===0?packedBytes:inflateRawSync(packedBytes,{maxOutputLength:row.bytes+1});
      hold(bytes.length===row.bytes && digest(bytes)===row.sha256 && crc(bytes)===zip.readUInt32LE(cursor+16),'ZIP hash/CRC');
      if(row.role==='generated_overlay_only_untracked') {
        const p=parent(source,name);
        guard();
        const fd=fs.openSync(join(p.dir,p.leaf),C.O_CREAT|C.O_EXCL|C.O_WRONLY|C.O_NOFOLLOW,row.mode);
        try {
          writeWhole(fd,bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      verify(source,row);
      cursor+=46+nameLength+extra+comment;
    }
    hold(cursor===eocd && seen.size===182,'ZIP complete boundary');
    guard();
    const tarOptions=['--extract','--directory=/proc/self/fd/4','--file=/proc/self/fd/3','--strip-components=1',
      '--keep-old-files','--no-overwrite-dir','--no-same-owner','--same-permissions'];
    child('/usr/bin/tar',[...tarOptions,'--gzip','--null','--verbatim-files-from','--no-recursion','--files-from=-'],
      required(ARCHIVES[3]![0]),source,Buffer.from(runtime.map(r=>`package/${r.path}\0`).join('')));
    guard();
    census(source,[...gitRows,...overlay,...runtime],new Map(),true);
    gitCheck();
    // Whole fixed official archive preserves the reviewed1113 directories and exactly3 internal links.
    child('/usr/bin/tar',[...tarOptions,'--xz'],required(ARCHIVES[4]![0]),toolchain);
    guard();
    census(toolchain,node,LINKS,false,1113);
    for(const text of LINKS.values()) {
      const target=`lib/${text.slice('../lib/'.length)}`;
      hold(node.some(r=>r.path===target),'same-archive link target');
    }
    hold(JSON.parse(fs.readFileSync(join(toolchain,'lib/node_modules/npm/package.json'),'utf8')).version==='10.9.9','offline npm version');
    census(source,[...gitRows,...overlay,...runtime],new Map(),true);
    gitCheck();
    for(const pin of [...ARCHIVES,...DATA]) hashFile(required(pin[0]),pin);
    for(const [h,pin]of originals) hashFile(h,pin);
    for(const dir of created) fs.fsyncSync(dir.fd);
    guard();
    const receipt:PublicStageReceipt={kind:'PUBLIC_DATA_ONLY_NON_AUTHORITATIVE',head:HEAD,tree:TREE,
      created:created.map(h=>({name:h.path,identity:h.identity})),inputs:[...ARCHIVES,...DATA],fullEightAcceptance:'UNPROVEN'};
    const fd=fs.openSync(join(job,'public-stage-receipt.json'),C.O_CREAT|C.O_EXCL|C.O_WRONLY|C.O_NOFOLLOW,0o400);
    try {
      writeWhole(fd,Buffer.from(`${JSON.stringify(receipt,null,2)}\n`));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.fsyncSync(job.fd);
    return receipt;
  } catch(error) {
    // No deletion, adoption, privilege issuance or blind retry. Preserve every partial/original byte.
    if(job) {
      try {
        guard();
        const fd=fs.openSync(join(job,'PUBLIC-STAGE-PARTIAL.json'),C.O_CREAT|C.O_EXCL|C.O_WRONLY|C.O_NOFOLLOW,0o400);
        try {
          writeWhole(fd,Buffer.from(JSON.stringify({kind:'PARTIAL_NON_AUTHORITATIVE',
            created:created.map(h=>({name:h.path,identity:h.identity})),retry:'HOLD_NO_ADOPTION'})));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // Preserve preexisting evidence; no overwrite or unsafe recovery.
      }
    }
    throw error;
  } finally {
    for(const h of handles.reverse()) fs.closeSync(h.fd);
    fs.closeSync(nsfd);
    process.umask(oldMask);
  }
}
