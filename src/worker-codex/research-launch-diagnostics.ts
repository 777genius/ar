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
function ownString(error: unknown, key: string): string | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch { return undefined; }
}
export function normalizeResearchLaunchFailure(error: unknown): Readonly<{
  legacyCode: number | "unclassified"; cause: ResearchLaunchCause; diagnostic: ResearchLaunchDiagnostic;
}> {
  const message = ownString(error, "message"), code = ownString(error, "code"), cause = ownString(error, "cause");
  const index = legacy.findIndex(known => known === message);
  return {
    legacyCode: index < 0 ? "unclassified" : index,
    cause: Object.values(ResearchLaunchCause).find(known => known === cause) ?? ResearchLaunchCause.None,
    diagnostic: exact.get(message ?? "") ?? prefixes.find(([prefix]) => message?.startsWith(prefix))?.[1]
      ?? errno.find(known => known === code) ?? D.Unknown,
  };
}
