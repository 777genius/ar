import { formatNamespaceFailure } from "./app-server-namespace-failure";
import { validatedObserverFailure, type AppServerObserverFailure } from "./app-server-observer-failure";
/** Closed observations of a failed setup, never release or retry authority. */
export enum AppServerProviderSetupStage { WaitingReady = "waiting_ready", Observing = "observing", FinalRelease = "final_release" }
export enum AppServerProviderSetupCheckpoint {
  None = "none", Profile = "profile", Unit = "unit", UnitProxy = "unit_proxy", Candidate = "candidate", Namespace = "namespace",
  Bootstrap = "bootstrap", Confinement = "confinement", PeerJoin = "peer_join", Postcheck = "postcheck",
  FullSetup = "full_setup", Owner = "owner", ToolRelease = "tool_release", NamespaceRelease = "namespace_release",
  Frame = "frame", Budget = "budget", Enqueue = "enqueue", PreRelease = "pre_release",
}
export enum AppServerProviderSetupCode {
  Unknown = "unknown", Boundary = "fd_boundary", Namespace = "fd_namespace", Policy = "fd_policy",
  Activation = "activation", Descriptors = "descriptors", Budget = "setup_budget", Unsupported = "dependency_unsupported",
}
export interface AppServerProviderSetupRejection {
  readonly checkpoint: AppServerProviderSetupCheckpoint; readonly code: AppServerProviderSetupCode;
  readonly elapsedMsCapped: number; readonly checkpointEntryElapsedMsCapped: number;
  readonly observer: AppServerObserverFailure; readonly count: number;
}
export interface AppServerProviderSetupFact {
  readonly stage: AppServerProviderSetupStage; readonly checkpoint: AppServerProviderSetupCheckpoint;
  readonly code: AppServerProviderSetupCode; readonly ready: boolean; readonly released: boolean;
  readonly elapsedMsCapped: number; readonly limitMs: number;
  readonly collectAttempts?: number; readonly firstCollectElapsedMsCapped?: number;
  readonly checkpointEntryElapsedMsCapped?: number; readonly budgetExpired?: boolean;
  readonly observer?: AppServerObserverFailure;
  readonly rejections?: readonly AppServerProviderSetupRejection[]; readonly omittedRejections?: number;
}
const failures = new WeakMap<object, Readonly<AppServerProviderSetupFact>>();
const causes = new WeakMap<object, string>();
const codes: ReadonlyMap<string, AppServerProviderSetupCode> = new Map([
  ["hosted_fd_boundary_unresolved", AppServerProviderSetupCode.Boundary],
  ["hosted_fd_namespace_stage_unresolved", AppServerProviderSetupCode.Namespace],
  ["hosted_fd_original_unit_policy_unresolved", AppServerProviderSetupCode.Policy],
  ["hosted_activation_evidence_invalid", AppServerProviderSetupCode.Activation],
  ["hosted_custody_inherited_handle_denied", AppServerProviderSetupCode.Descriptors],
  ["hosted_fd_setup_expired", AppServerProviderSetupCode.Budget],
  ["dependency_admission:unsupported", AppServerProviderSetupCode.Unsupported],
]);
export function appServerProviderSetupCode(error: unknown): AppServerProviderSetupCode {
  try {
    const message = typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
    return typeof message === "string" && message.length <= 80 ? codes.get(message) ?? AppServerProviderSetupCode.Unknown : AppServerProviderSetupCode.Unknown;
  } catch { return AppServerProviderSetupCode.Unknown; }
}
function validatedRejections(value: unknown): readonly AppServerProviderSetupRejection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 3) return undefined;
  const selected: AppServerProviderSetupRejection[] = [];
  for (let index = 0; index < length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))?.value as unknown;
    if (typeof item !== "object" || item === null) return undefined;
    const row = Object.getOwnPropertyDescriptors(item);
    const checkpoint = row.checkpoint?.value, code = row.code?.value;
    const elapsedMsCapped = row.elapsedMsCapped?.value, checkpointEntryElapsedMsCapped = row.checkpointEntryElapsedMsCapped?.value;
    const count = row.count?.value, observer = validatedObserverFailure(row.observer?.value);
    if (!Object.values(AppServerProviderSetupCheckpoint).includes(checkpoint) || !Object.values(AppServerProviderSetupCode).includes(code) ||
        ![elapsedMsCapped, checkpointEntryElapsedMsCapped].every(number => typeof number === "number" && Number.isSafeInteger(number) && number >= 0 && number <= 60000) ||
        typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 65535 || !observer) return undefined;
    selected.push(Object.freeze({ checkpoint, code, elapsedMsCapped, checkpointEntryElapsedMsCapped, observer, count }));
  }
  return Object.freeze(selected);
}
/** Best effort only. A diagnostic failure must never obstruct existing cleanup. */
export function retainAppServerProviderSetupFailure(child: object, fact: AppServerProviderSetupFact | undefined): void {
  try {
    if (!fact || failures.has(child)) return;
    const fields = Object.getOwnPropertyDescriptors(fact);
    const stage = fields.stage?.value, checkpoint = fields.checkpoint?.value, code = fields.code?.value;
    const ready = fields.ready?.value, released = fields.released?.value;
    const elapsedMsCapped = fields.elapsedMsCapped?.value, limitMs = fields.limitMs?.value;
    if (stage === undefined || checkpoint === undefined || code === undefined || typeof elapsedMsCapped !== "number" || typeof limitMs !== "number" ||
        !Object.values(AppServerProviderSetupStage).includes(stage) || !Object.values(AppServerProviderSetupCheckpoint).includes(checkpoint) ||
        !Object.values(AppServerProviderSetupCode).includes(code) || typeof ready !== "boolean" || typeof released !== "boolean" ||
        !Number.isSafeInteger(elapsedMsCapped) || elapsedMsCapped < 0 || elapsedMsCapped > 60000 ||
        !Number.isSafeInteger(limitMs) || limitMs < 1 || limitMs > 60000) return;
    const collectAttempts = fields.collectAttempts?.value, firstCollectElapsedMsCapped = fields.firstCollectElapsedMsCapped?.value;
    const checkpointEntryElapsedMsCapped = fields.checkpointEntryElapsedMsCapped?.value, budgetExpired = fields.budgetExpired?.value;
    const timed = [collectAttempts, firstCollectElapsedMsCapped, checkpointEntryElapsedMsCapped, budgetExpired].some(value => value !== undefined);
    if (timed && (typeof collectAttempts !== "number" || !Number.isSafeInteger(collectAttempts) || collectAttempts < 0 || collectAttempts > 65535 ||
        typeof firstCollectElapsedMsCapped !== "number" || !Number.isSafeInteger(firstCollectElapsedMsCapped) || firstCollectElapsedMsCapped < 0 || firstCollectElapsedMsCapped > 60000 ||
        typeof checkpointEntryElapsedMsCapped !== "number" || !Number.isSafeInteger(checkpointEntryElapsedMsCapped) || checkpointEntryElapsedMsCapped < 0 || checkpointEntryElapsedMsCapped > 60000 ||
        typeof budgetExpired !== "boolean")) return;
    const observer = validatedObserverFailure(fields.observer?.value);
    if (fields.observer?.value !== undefined && !observer) return;
    const rejections = fields.rejections?.value === undefined ? undefined : validatedRejections(fields.rejections.value);
    const omittedRejections = fields.omittedRejections?.value;
    if (fields.rejections?.value !== undefined && (!rejections || typeof omittedRejections !== "number" ||
        !Number.isSafeInteger(omittedRejections) || omittedRejections < 0 || omittedRejections > 65535)) return;
    if (rejections === undefined && omittedRejections !== undefined) return;
    failures.set(child, Object.freeze({ stage, checkpoint, code, ready, released, elapsedMsCapped, limitMs,
      ...(timed ? { collectAttempts: collectAttempts!, firstCollectElapsedMsCapped: firstCollectElapsedMsCapped!,
        checkpointEntryElapsedMsCapped: checkpointEntryElapsedMsCapped!, budgetExpired: budgetExpired! } : {}), ...(observer ? { observer } : {}), ...(rejections ? { rejections, omittedRejections: omittedRejections! } : {}) }));
  } catch { /* No raw error, caller object or collector text is retained. */ }
}
export function appServerProviderSetupFailureCause(child: object): Error | undefined {
  const fact = failures.get(child);
  if (!fact) return undefined;
  const message = `app_server_setup stage=${fact.stage} checkpoint=${fact.checkpoint} code=${fact.code} ready=${Number(fact.ready)} released=${Number(fact.released)} elapsed_ms_capped=${fact.elapsedMsCapped} limit_ms=${fact.limitMs}` +
    (fact.collectAttempts === undefined ? "" : ` attempts=${fact.collectAttempts} first_collect_ms=${fact.firstCollectElapsedMsCapped} checkpoint_entry_ms=${fact.checkpointEntryElapsedMsCapped} budget_expired=${Number(fact.budgetExpired)}`) +
    (fact.observer ? ` observer=${fact.observer.point} observer_code=${fact.observer.code} errno=${fact.observer.errno} observer_ms_capped=${fact.observer.elapsedMsCapped}${fact.observer.namespace ? ` ns=${formatNamespaceFailure(fact.observer.namespace)}` : ""}` : "") +
    // Positional closed samples: checkpoint, code, first rejection/entry ms, observer point/code/errno/ms, count.
    (fact.rejections ? fact.rejections.map((row, index) => ` rejection${index + 1}=${row.checkpoint},${row.code},${row.elapsedMsCapped},${row.checkpointEntryElapsedMsCapped},${row.observer.point},${row.observer.code},${row.observer.errno},${row.observer.elapsedMsCapped},${row.count}${row.observer.namespace ? `~${formatNamespaceFailure(row.observer.namespace)}` : ""}`).join("") + ` omitted_rejections=${fact.omittedRejections}` : "");
  const cause = new Error(message); causes.set(cause, message); return cause;
}
/** Only a genuine snapshot, via one own data cause. No message/getter parsing. */
export function appServerProviderSetupCauseFact(error: unknown): string | undefined {
  try {
    const cause = typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "cause")?.value as unknown : undefined;
    return typeof cause === "object" && cause !== null ? causes.get(cause) : undefined;
  } catch { return undefined; }
}
