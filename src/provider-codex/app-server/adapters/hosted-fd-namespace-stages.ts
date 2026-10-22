import { AppServerNamespaceReason as Reason, AppServerNamespaceRole as Role, AppServerNamespaceArgKind as ArgKind,
  type AppServerNamespaceShape } from "../domain/app-server-namespace-failure";
import { retainNamespaceObserverFailure } from "../domain/app-server-observer-failure";
export type HostedFdNamespaceProcess=Readonly<{pid:number;parentPid:number;exe:string;argv:readonly string[]}>;

/** Recipe checks only. These facts cannot enroll a child, owner or unit. */
const prefix = Object.freeze(["/usr/bin/unshare", "--mount", "--pid", "--fork", "--mount-proc", "--kill-child=SIGKILL", "--",
  "/usr/bin/unshare", "--user", "--map-user=65532", "--map-group=65532", "--keep-caps", "--",
  "/usr/bin/setpriv", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "/usr/bin/tini", "--"]);
export const hostedFdNamespacePrefix: readonly string[] = prefix;
const stages = [0, 7, 13, 18] as const;
const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1);
function matchMask(argv: readonly string[], process: Pick<HostedFdNamespaceProcess, "exe" | "argv"> | undefined): number {
  return process ? stages.reduce<number>((mask, at, index) => mask | (argv[at] === process.exe &&
    JSON.stringify(argv.slice(at)) === JSON.stringify(process.argv) ? 1 << index : 0), 0) : 0;
}
function shape(argv: readonly string[], process: Pick<HostedFdNamespaceProcess, "exe" | "argv"> | undefined): AppServerNamespaceShape {
  if (!process) return Object.freeze({ role: Role.Unknown, matches: 0, argcCapped: 0, expected: 0, mismatchIndexCapped: -1, argKind: ArgKind.None });
  const role = process.exe === prefix[0] ? Role.Unshare : process.exe === prefix[13] ? Role.Setpriv : process.exe === prefix[18] ? Role.Tini :
    basename(process.exe) === "unshare" ? Role.UnshareBasename : basename(process.exe) === "setpriv" ? Role.SetprivBasename : basename(process.exe) === "tini" ? Role.TiniBasename : Role.Other;
  let nearest = 0, common = -1;
  for (let index = 0; index < stages.length; index++) {
    const expected = argv.slice(stages[index]); let same = 0;
    while (same < expected.length && same < process.argv.length && expected[same] === process.argv[same]) same++;
    // Exact executable spelling disambiguates a zero-prefix tie without normalizing the guard input.
    if (same > common || same === common && argv[stages[index]!] === process.exe && argv[stages[nearest]!] !== process.exe) { common = same; nearest = index; }
  }
  const expected = argv.slice(stages[nearest]);
  const mismatch = common === expected.length && common === process.argv.length ? -1 : common;
  const observed = mismatch < 0 ? undefined : process.argv[mismatch], wanted = mismatch < 0 ? undefined : expected[mismatch];
  const argKind = mismatch < 0 ? ArgKind.Exact : observed === undefined ? ArgKind.Missing : prefix.includes(observed) ? ArgKind.KnownLiteral :
    wanted !== undefined && basename(observed) === basename(wanted) ? ArgKind.Basename : ArgKind.Other;
  return Object.freeze({ role, matches: matchMask(argv, process), argcCapped: Math.min(255, process.argv.length), expected: nearest + 1,
    mismatchIndexCapped: Math.min(255, mismatch), argKind });
}
function held(reason: Reason, argv: readonly string[], actor?: Pick<HostedFdNamespaceProcess, "exe" | "argv">,
  main?: HostedFdNamespaceProcess, parent?: HostedFdNamespaceProcess): never {
  const error = new Error("hosted_fd_namespace_stage_unresolved");
  try {
    const canonical = [...prefix, ...argv.slice(prefix.length)];
    retainNamespaceObserverFailure(error, { reason, actor: shape(canonical, actor ?? { exe: argv[0] ?? "", argv }),
      main: shape(canonical, main), parentMatches: matchMask(canonical, parent) });
  } catch { /* Closed diagnostic observations cannot change the original predicate or rejection. */ }
  throw error;
}
function namespaceStage(argv: readonly string[], process: Pick<HostedFdNamespaceProcess,"exe"|"argv">, main?: HostedFdNamespaceProcess): number {
  if (argv.length <= prefix.length || !prefix.every((value,index) => argv[index] === value)) held(Reason.Prefix, argv, process, main);
  const matches = [0,7,13,18].filter(index => argv[index] === process.exe &&
    JSON.stringify(argv.slice(index)) === JSON.stringify(process.argv));
  if (matches.length !== 1) held(Reason.Stage, argv, process, main);
  return matches[0]!;
}
export function hostedFdNamespaceStage(argv: readonly string[], process: Pick<HostedFdNamespaceProcess,"exe"|"argv">): number {
  return namespaceStage(argv, process);
}
/** The privileged setup process is the actual unit MainPID. Only the inner
 * stages may become descendants; repeated executable names cannot choose a
 * suffix or establish ancestry. Kernel confinement still checks the leaf. */
export function assertHostedFdNamespaceAncestry(argv: readonly string[], processes: readonly HostedFdNamespaceProcess[], mainPid: number): void {
  if (argv[0] !== "/usr/bin/unshare") return;
  if (!prefix.every((value,index) => argv[index] === value)) held(Reason.Prefix, argv);
  const main = processes.find(process => process.pid === mainPid);
  if (!main) held(Reason.Main, argv);
  if (namespaceStage(argv,main,main) !== 0) held(Reason.Main, argv, main, main);
  const used = new Set<number>();
  for (const process of processes) {
    if (!["/usr/bin/unshare","/usr/bin/setpriv","/usr/bin/tini"].includes(process.exe)) continue;
    const stage = namespaceStage(argv,process,main);
    if (used.has(stage) || (stage === 0) !== (process.pid === mainPid)) held(Reason.Duplicate, argv, process, main);
    used.add(stage);
    let current = process, previous = stage, depth = 0;
    while (current.pid !== mainPid) {
      const parent = processes.find(candidate => candidate.pid === current.parentPid);
      if (!parent || ++depth > 8) held(Reason.Parent, argv, current, main, parent);
      const parentStage = namespaceStage(argv,parent,main);
      if (parentStage >= previous) held(Reason.Order, argv, current, main, parent);
      previous = parentStage; current = parent;
    }
  }
}
