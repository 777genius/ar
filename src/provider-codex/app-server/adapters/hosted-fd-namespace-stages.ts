export type HostedFdNamespaceProcess=Readonly<{pid:number;parentPid:number;exe:string;argv:readonly string[]}>;

/** Recipe checks only. These facts cannot enroll a child, owner or unit. */
const prefix = Object.freeze(["/usr/bin/unshare", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--",
  "/usr/bin/unshare", "--user", "--map-user=65532", "--map-group=65532", "--keep-caps", "--",
  "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--"]);
export const hostedFdNamespacePrefix: readonly string[] = prefix;
function held(): never { throw new Error("hosted_fd_namespace_stage_unresolved"); }
export function hostedFdNamespaceStage(argv: readonly string[], process: Pick<HostedFdNamespaceProcess,"exe"|"argv">): number {
  if (argv.length <= prefix.length || !prefix.every((value,index) => argv[index] === value)) held();
  const stages = [0,7,13,18].filter(index => argv[index] === process.exe &&
    JSON.stringify(argv.slice(index)) === JSON.stringify(process.argv));
  if (stages.length !== 1) held();
  return stages[0]!;
}
/** The privileged setup process is the actual unit MainPID. Only the inner
 * stages may become descendants; repeated executable names cannot choose a
 * suffix or establish ancestry. Kernel confinement still checks the leaf. */
export function assertHostedFdNamespaceAncestry(argv: readonly string[], processes: readonly HostedFdNamespaceProcess[], mainPid: number): void {
  if (argv[0] !== "/usr/bin/unshare") return;
  if (!prefix.every((value,index) => argv[index] === value)) held();
  const main = processes.find(process => process.pid === mainPid);
  if (!main || hostedFdNamespaceStage(argv,main) !== 0) held();
  const used = new Set<number>();
  for (const process of processes) {
    if (!["/usr/bin/unshare","/usr/bin/setpriv","/usr/bin/tini"].includes(process.exe)) continue;
    const stage = hostedFdNamespaceStage(argv,process);
    if (used.has(stage) || (stage === 0) !== (process.pid === mainPid)) held();
    used.add(stage);
    let current = process, previous = stage, depth = 0;
    while (current.pid !== mainPid) {
      const parent = processes.find(candidate => candidate.pid === current.parentPid);
      if (!parent || ++depth > 8) held();
      const parentStage = hostedFdNamespaceStage(argv,parent);
      if (parentStage >= previous) held();
      previous = parentStage; current = parent;
    }
  }
}
