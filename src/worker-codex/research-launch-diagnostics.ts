import { types } from "node:util";

/** Closed startup observations; error payloads never become output. */
export enum ResearchLaunchDiagnostic {
  Unknown = "unknown", ResearchAdmission = "research-admission", CheckpointAdmission = "checkpoint-admission",
  EgressAdmission = "egress-admission", ScratchConfigCustody = "scratch-config-custody",
  ScratchConfigInvalid = "scratch-config-invalid", ScratchSchemaInvalid = "scratch-schema-invalid",
  ScratchMountInspection = "scratch-mount-inspection", ScratchMountMismatch = "scratch-mount-mismatch",
  ScratchSpace = "scratch-space", ScratchDirectoryUnsafe = "scratch-directory-unsafe",
  ScratchSourceUnsafe = "scratch-source-unsafe", ScratchCanonical = "scratch-canonical",
  ScratchTmpdir = "scratch-tmpdir", ScratchPrivilege = "scratch-privilege",
  ScratchLegacyInvalid = "scratch-legacy-invalid", ScratchLegacyChanged = "scratch-legacy-changed",
  ScratchUnprepared = "scratch-unprepared", ScratchBindVerification = "scratch-bind-verification",
  ScratchNonempty = "scratch-nonempty", ScratchBusy = "scratch-busy",
  ScratchUnknownMount = "scratch-unknown-mount", ScratchSourceChanged = "scratch-source-changed",
  ENOENT = "ENOENT", EACCES = "EACCES", EPERM = "EPERM", EAGAIN = "EAGAIN",
  ENOSPC = "ENOSPC", EMFILE = "EMFILE", ETIMEDOUT = "ETIMEDOUT",
}
export enum ResearchLaunchCause {
  None = "none", ArtifactDeadline = "artifact-deadline", FileDeadline = "file-deadline",
  HostCommandTimeout = "host-command-timeout", HostCommandFailed = "host-command-failed",
  ScratchRoot = "scratch-root", ScratchTmp = "scratch-tmp", ScratchCache = "scratch-cache",
}
export enum ResearchLaunchStage {
  Unknown = "unknown", PinPreparation = "pin-preparation", InputPreparation = "input-preparation",
  LaunchPlan = "launch-plan", HostSubmission = "host-submission", StartReadback = "start-readback",
}
/** Private material scope only; never a member path, cache state or authority. */
export enum ResearchMaterialRole {
  Unknown = "unknown", RuntimeArtifact = "runtime-artifact", NodeExecutable = "node-executable", CodexExecutable = "codex-executable",
}
type KnownMaterialRole = Exclude<ResearchMaterialRole, ResearchMaterialRole.Unknown>;
const materialRoles = new WeakMap<object, KnownMaterialRole>();
export enum ScratchCapacityVolumeRole { RootControl = "RootControl", ScratchPayload = "ScratchPayload" }
type ScratchCapacityObservation = Readonly<{
  volumeRole: ScratchCapacityVolumeRole; availableBytes: number; requiredBytes: number;
}>;
const scratchCapacityObservations = new WeakMap<object, ScratchCapacityObservation>();
/** Actual failed admission only; caller error properties never supply these facts. */
export function annotateScratchCapacityFailure(error: unknown, volumeRole: ScratchCapacityVolumeRole,
  availableBytes: number, requiredBytes: number): unknown {
  if (error && typeof error === "object" && !scratchCapacityObservations.has(error)
    && Object.values(ScratchCapacityVolumeRole).includes(volumeRole)
    && Number.isSafeInteger(availableBytes) && availableBytes >= 0
    && Number.isSafeInteger(requiredBytes) && requiredBytes > availableBytes) {
    scratchCapacityObservations.set(error, Object.freeze({ volumeRole, availableBytes, requiredBytes }));
  }
  return error;
}
export function annotateResearchMaterialFailure(error: unknown, role: KnownMaterialRole): unknown {
  try { if (error && typeof error === "object" && !materialRoles.has(error)) materialRoles.set(error, role); }
  catch { /* Observation only; retain the original thrown identity. */ }
  return error;
}
const operatorStartStages = new WeakMap<object, ResearchLaunchStage>();
/** Observe the same failed attempt without changing its error or recovery ownership. */
export function annotateResearchLaunchStage(error: unknown, stage: ResearchLaunchStage): unknown {
  if (error && typeof error === "object") operatorStartStages.set(error, stage);
  return error;
}
export function normalizeResearchOperatorFailure(error: unknown) {
  return { stage: error && typeof error === "object"
    ? operatorStartStages.get(error) ?? ResearchLaunchStage.Unknown : ResearchLaunchStage.Unknown,
  ...normalizeResearchLaunchFailure(error) };
}
type ScratchMountInspectionCause = ResearchLaunchCause.ScratchRoot | ResearchLaunchCause.ScratchTmp | ResearchLaunchCause.ScratchCache;
const scratchInspectionCauses = new WeakMap<object, ScratchMountInspectionCause>();
/** Internal observation only; preserve the thrown value and all existing recovery facts. */
export function annotateScratchMountInspectionFailure(error: unknown, cause: ScratchMountInspectionCause): unknown {
  if (error && typeof error === "object") scratchInspectionCauses.set(error, cause);
  return error;
}
const D = ResearchLaunchDiagnostic;
// Order is the deployed numeric contract; append diagnostics without renumbering it.
const legacy = ["hosted_research_launch_denied", "checkpoint_publisher_required",
  "terminal_checkpoint_mutex_busy_owner_unproven", "terminal_checkpoint_job_fenced",
  "Refusing to hide nonempty legacy scratch directory", "Scratch bind target busy",
  "Unknown mount at scratch target", "Prepared scratch source identity changed"] as const;
const exact = new Map<string, ResearchLaunchDiagnostic>([
  [legacy[0], D.ResearchAdmission], ...legacy.slice(1, 4).map(message => [message, D.CheckpointAdmission] as const),
  [legacy[4], D.ScratchNonempty], [legacy[5], D.ScratchBusy], [legacy[6], D.ScratchUnknownMount], [legacy[7], D.ScratchSourceChanged],
  ["Scratch config must be a root-owned regular file without group/other writes", D.ScratchConfigCustody],
  ["Invalid scratch config", D.ScratchConfigInvalid], ["Invalid scratch schema, root, UUID or legacy map", D.ScratchSchemaInvalid],
  ["Ambiguous scratch mount inspection", D.ScratchMountInspection], ["Scratch mount target, UUID or filesystem root mismatch", D.ScratchMountMismatch],
  ["Scratch requires canonical absolute paths", D.ScratchCanonical], ["Host scratch requires logical jobRoot/tmp; explicit TMPDIR spill rejected", D.ScratchTmpdir],
  ["Root privilege required to prepare scratch bind mount", D.ScratchPrivilege], ["Root privilege required to prepare scratch cache parents", D.ScratchPrivilege],
  ["Invalid selected legacy temp identity", D.ScratchLegacyInvalid], ["Legacy scratch target device/inode changed", D.ScratchLegacyChanged],
  ["Selected scratch target is not prepared", D.ScratchUnprepared], ["Scratch bind mount verification failed", D.ScratchBindVerification],
  ...["checkpoint_initial_base_required", "checkpoint_requires_git_app_server_goal", "terminal_checkpoint_state_invalid",
    "terminal_checkpoint_path_untrusted"].map(message => [message, D.CheckpointAdmission] as const),
  ...["codex_goal_provider_egress_admission_mismatch", "hosted_test_egress_engine_unsupported",
    "hosted_test_egress_admission_invalid", "hosted_research_ordinary_admission_required",
    "hosted_permission_profiles_engine_unsupported"].map(message => [message, D.EgressAdmission] as const),
]);
const prefixes = [["Scratch launch requires at least 5 GiB available on ", D.ScratchSpace],
  ["Unsafe scratch directory: ", D.ScratchDirectoryUnsafe], ["Unsafe scratch source permissions: ", D.ScratchSourceUnsafe]] as const;
const errno = [D.ENOENT, D.EACCES, D.EPERM, D.EAGAIN, D.ENOSPC, D.EMFILE, D.ETIMEDOUT] as const;
function ownData(error: unknown, key: string): unknown {
  try {
    if (!error || typeof error !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function ownString(error: unknown, key: string): string | undefined {
  const value = ownData(error, key);
  return typeof value === "string" ? value : undefined;
}
function normalizeOwnFailure(error: unknown): Readonly<{
  legacyCode: number | "unclassified"; cause: ResearchLaunchCause; diagnostic: ResearchLaunchDiagnostic;
}> {
  const inspectionCause = error && typeof error === "object" ? scratchInspectionCauses.get(error) : undefined;
  const message = ownString(error, "message"), code = ownString(error, "code");
  const cause = inspectionCause ?? ownString(error, "cause");
  const index = legacy.findIndex(known => known === message);
  return {
    legacyCode: index < 0 ? "unclassified" : index,
    cause: Object.values(ResearchLaunchCause).find(known => known === cause) ?? ResearchLaunchCause.None,
    diagnostic: exact.get(message ?? "") ?? prefixes.find(([prefix]) => message?.startsWith(prefix))?.[1]
      ?? errno.find(known => known === code) ?? D.Unknown,
  };
}
/** Fill only unknown observations from bounded own-data causes. The deployed
 * numeric code always describes the outer error, never a nested provider error. */
export function normalizeResearchLaunchFailure(error: unknown): ReturnType<typeof normalizeOwnFailure> {
  const outer = normalizeOwnFailure(error);
  let { cause, diagnostic } = outer;
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const observation = depth === 0 ? outer : normalizeOwnFailure(current);
    if (cause === ResearchLaunchCause.None) cause = observation.cause;
    if (diagnostic === D.Unknown) diagnostic = observation.diagnostic;
    if (cause !== ResearchLaunchCause.None && diagnostic !== D.Unknown) break;
    current = ownData(current, "cause");
  }
  return { ...outer, cause, diagnostic };
}

/** Keep the deployed failure contract unchanged; add only an identity-bound private role. */
export function normalizeResearchMaterialFailure(error: unknown) {
  let materialRole = ResearchMaterialRole.Unknown, current = error;
  let scratchCapacity: ScratchCapacityObservation | undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const role = materialRoles.get(current);
    if (role && materialRole === ResearchMaterialRole.Unknown) materialRole = role;
    scratchCapacity ??= scratchCapacityObservations.get(current);
    if (materialRole !== ResearchMaterialRole.Unknown && scratchCapacity) break;
    if (types.isProxy(current)) break;
    current = ownData(current, "cause");
  }
  return { ...normalizeResearchLaunchFailure(error), materialRole, ...(scratchCapacity ? { scratchCapacity } : {}) };
}

const nativeErrorStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;

/** Numeric source location only; never serialize an error message, path or stack. */
export function normalizeResearchAssemblyFailure(error: unknown) {
  let stack = ownString(error, "stack") ?? "";
  // Node 24 exposes a native lazy stack accessor. Never invoke a caller getter.
  if (!stack && error && typeof error === "object" && !types.isProxy(error) && types.isNativeError(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
    if (nativeErrorStackGetter && descriptor?.get === nativeErrorStackGetter) {
      try { const value: unknown = nativeErrorStackGetter.call(error); if (typeof value === "string") stack = value; } catch { /* Diagnostic only. */ }
    }
  }
  stack = stack.slice(0, 8192);
  const frame = /\/dist\/worker-codex\/research-provider-root-assembler\.js:([1-9]\d{0,5}):([1-9]\d{0,5})/.exec(stack);
  return { ...normalizeResearchLaunchFailure(error), ...(frame ? { assemblyLine: Number(frame[1]), assemblyColumn: Number(frame[2]) } : {}) };
}
