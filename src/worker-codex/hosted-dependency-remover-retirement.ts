import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statfsSync } from "node:fs";
import { assertReadonlyHostOperator } from "./hosted-readonly-authority";
import { collectJobs, collectScopedRecursiveEmpty, collectUnitShow, withScopedCollectionBudget } from "./hosted-readonly-linux-collector";
import { parseScopedManagerJobs } from "./hosted-readonly-observations";
import { parseHostedDependencyRemoverTerminalFacts, type HostedManagedProviderTerminalFacts } from "./hosted-managed-provider-terminal-facts";

export enum HostedRemoverCgroupObservation { Empty = "empty", Absent = "absent" }
export type HostedRemoverRetirementFacts = Readonly<{ terminal: HostedManagedProviderTerminalFacts;
  cgroup: HostedRemoverCgroupObservation; cgroupSha256: string }>;
const parent = "/sys/fs/cgroup/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice";
const properties = "Id,InvocationID,ActiveState,SubState,MainPID,ControlPID,Job,ExecMainCode,ExecMainStatus,Result";
function held(): never { throw new Error("hosted_dependency_remover_retirement_unresolved"); }

/** Native facts only. A terminal service or absent cgroup never discharges its
 * submitter: the original parent must separately join genuine close or pidfd
 * evidence, immutable consumed/revoked records and the current owner attempt. */
export function observeHostedDependencyRemoverRetirement(unit: string, invocationId: string, remainingMs: number): HostedRemoverRetirementFacts {
  assertReadonlyHostOperator();
  if (/^subscription-runtime-dependency-remove-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service$/.exec(unit)?.[0] !== unit ||
      /^[a-f0-9]{32}$/.exec(invocationId)?.[0] !== invocationId || statfsSync(parent, { bigint: true }).type !== 0x63677270n) held();
  return withScopedCollectionBudget(remainingMs, () => {
    const end = performance.now() + remainingMs;
    const read = () => {
      const left = Math.min(5000, Math.floor(end - performance.now())); if (left < 1) held();
      const reply = spawnSync("/usr/bin/systemctl", ["show", `--property=${properties}`, "--", unit], {
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: left, maxBuffer: 8192,
      });
      if (reply.error || reply.signal || reply.status !== 0 || reply.stderr) held();
      const terminal = parseHostedDependencyRemoverTerminalFacts(unit, reply.stdout);
      if (terminal.invocationId !== invocationId) held();
      return { bytes: reply.stdout, terminal };
    };
    const first = read(), group = parent.slice("/sys/fs/cgroup".length) + "/" + unit, before = collectUnitShow(unit), jobs = collectJobs();
    if (before.Id !== unit || before.DropInPaths !== "" || before.ControlGroup && before.ControlGroup !== group ||
        before.MainPID !== "0" || parseScopedManagerJobs(jobs).some(job => job.unit === unit)) held();
    let cgroup: HostedRemoverCgroupObservation, cgroupSha256: string;
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const identity = fstatSync(fd, { bigint: true }), named = lstatSync(parent, { bigint: true }), mount = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
      if (!identity.isDirectory() || identity.uid !== 0n || identity.dev !== named.dev || identity.ino !== named.ino || (identity.mode & 0o022n)) held();
      let missing = false;
      try { lstatSync(`/proc/self/fd/${fd}/${unit}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing = true; }
      if (missing) {
        // Only the exact initial name-negative observation is absence. A lost
        // descendant during an existing-tree traversal remains uncertainty.
        try { lstatSync(`/proc/self/fd/${fd}/${unit}`); held(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        cgroup = HostedRemoverCgroupObservation.Absent;
        cgroupSha256 = createHash("sha256").update(JSON.stringify({ parent: { dev: String(identity.dev), ino: String(identity.ino) }, unit, absent: true })).digest("hex");
      } else {
        const observed = collectScopedRecursiveEmpty(group, Math.floor(end - performance.now())); if (!observed.empty) held();
        cgroup = HostedRemoverCgroupObservation.Empty; cgroupSha256 = observed.digest;
      }
      const after = lstatSync(parent, { bigint: true });
      if (after.dev !== identity.dev || after.ino !== identity.ino || after.mode !== identity.mode) held();
      if (parseScopedManagerJobs(collectJobs()).some(job => job.unit === unit) || JSON.stringify(collectUnitShow(unit)) !== JSON.stringify(before) || read().bytes !== first.bytes) held();
      if (cgroup === HostedRemoverCgroupObservation.Absent) {
        try { lstatSync(`/proc/self/fd/${fd}/${unit}`); held(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else {
        const repeated = collectScopedRecursiveEmpty(group, Math.floor(end - performance.now()));
        if (!repeated.empty || repeated.digest !== cgroupSha256) held();
      }
      const final = lstatSync(parent, { bigint: true }), retained = fstatSync(fd, { bigint: true });
      if (final.dev !== identity.dev || final.ino !== identity.ino || final.mode !== identity.mode || retained.dev !== identity.dev ||
          retained.ino !== identity.ino || readFileSync(`/proc/self/fdinfo/${fd}`, "utf8") !== mount) held();
      return Object.freeze({ terminal: first.terminal, cgroup, cgroupSha256 });
    } finally { closeSync(fd); }
  });
}
/** Separate cgroup-only fact for an already authenticated durable retirement.
 * No terminal or creator discharge is inferred from this anchored absence. */
export function observeHostedDependencyRemoverCgroup(unit:string,remainingMs:number):Omit<HostedRemoverRetirementFacts,"terminal"> {
  assertReadonlyHostOperator();
  if(/^subscription-runtime-dependency-remove-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.service$/.exec(unit)?.[0]!==unit ||
    statfsSync(parent,{bigint:true}).type!==0x63677270n || !Number.isSafeInteger(remainingMs) || remainingMs<1)held();
  const end=performance.now()+remainingMs,fd=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const identity=fstatSync(fd,{bigint:true}),named=lstatSync(parent,{bigint:true}),mount=readFileSync(`/proc/self/fdinfo/${fd}`,"utf8");
    if(!identity.isDirectory() || identity.uid!==0n || identity.mode&0o022n || identity.dev!==named.dev || identity.ino!==named.ino)held();
    let absent=false;try{lstatSync(`/proc/self/fd/${fd}/${unit}`);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;absent=true;}
    const group=parent.slice("/sys/fs/cgroup".length)+"/"+unit;
    let cgroupSha256:string;
    if(absent)cgroupSha256=createHash("sha256").update(JSON.stringify({parent:{dev:String(identity.dev),ino:String(identity.ino)},unit,absent:true})).digest("hex");
    else {const first=collectScopedRecursiveEmpty(group,Math.floor(end-performance.now()));if(!first.empty)held();
      const second=collectScopedRecursiveEmpty(group,Math.floor(end-performance.now()));if(!second.empty || first.digest!==second.digest)held();cgroupSha256=first.digest;}
    if(absent){try{lstatSync(`/proc/self/fd/${fd}/${unit}`);held();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
    const final=lstatSync(parent,{bigint:true}),retained=fstatSync(fd,{bigint:true});
    if(final.dev!==identity.dev || final.ino!==identity.ino || final.mode!==identity.mode || retained.dev!==identity.dev || retained.ino!==identity.ino ||
      readFileSync(`/proc/self/fdinfo/${fd}`,"utf8")!==mount || performance.now()>=end)held();
    return {cgroup:absent?HostedRemoverCgroupObservation.Absent:HostedRemoverCgroupObservation.Empty,cgroupSha256};
  }finally{closeSync(fd);}
}
