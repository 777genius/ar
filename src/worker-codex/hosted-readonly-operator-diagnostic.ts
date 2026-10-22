/** Fixed public diagnostics only. Caller messages and paths never become output. */
export enum HostedReadonlyOperatorReason {
  Unknown = "unknown",
  ActivationEvidenceInvalid = "hosted_activation_evidence_invalid",
  ActivationAuthorityRequired = "hosted_activation_authority_required",
  ActivationPublicationRecoveryRequired = "hosted_activation_publication_recovery_required",
  ReadonlyHostOperatorRequired = "hosted_readonly_host_operator_required",
  ReadonlyAuthorityInvalid = "hosted_readonly_authority_invalid",
  ReadonlyManagedGrantRequired = "hosted_readonly_managed_grant_required",
  ReadonlyIndependentReviewRequired = "hosted_readonly_independent_review_required",
  ReadonlyVerifiedStageRequired = "hosted_readonly_verified_stage_required",
  ReadonlyRevoked = "hosted_readonly_revoked",
  CustodyEnrollmentMismatch = "hosted_custody_enrollment_mismatch",
  CustodyDurableAuthorityRequired = "hosted_custody_durable_authority_required",
  CustodyKernelEvidenceInvalid = "hosted_custody_kernel_evidence_invalid",
  CustodyCreatorNotFenced = "hosted_custody_creator_not_fenced",
  FdBoundaryUnresolved = "hosted_fd_boundary_unresolved",
  FdProfileInvalid = "hosted_fd_profile_invalid",
  TestEgressCustodyInvalid = "hosted_test_egress_custody_invalid",
}

export enum HostedReadonlyOperatorSource {
  InputsCli = "hosted-readonly-inputs-cli.js",
  Inputs = "hosted-readonly-inputs.js",
  Authority = "hosted-readonly-authority.js",
  Custody = "hosted-readonly-custody.js",
  EpochStore = "hosted-readonly-epoch-store.js",
  SupervisorHost = "hosted-readonly-supervisor-host.js",
  HostKernel = "hosted-readonly-host-kernel.js",
  LinuxCollector = "hosted-readonly-linux-collector.js",
  Observations = "hosted-readonly-observations.js",
  InstallationActivation = "hosted-installation-activation.js",
  TestEgressFiles = "hosted-test-egress-files.js",
  SystemBusInfrastructure = "system-bus-infrastructure.js",
  FdCollectorProfile = "fd-collector-profile.js",
  FdObservation = "hosted-fd-observation.js",
  FdLaunch = "hosted-fd-launch.js",
  FdFence = "hosted-fd-fence.js",
}

export function hostedReadonlyOperatorDiagnostic(error: unknown): {
  reason: HostedReadonlyOperatorReason;
  locations: { file: HostedReadonlyOperatorSource; line: number; column: number }[];
} {
  const reason = error instanceof Error && Object.values(HostedReadonlyOperatorReason).includes(error.message as HostedReadonlyOperatorReason)
    ? error.message as HostedReadonlyOperatorReason : HostedReadonlyOperatorReason.Unknown;
  const locations: { file: HostedReadonlyOperatorSource; line: number; column: number }[] = [];
  if (error instanceof Error && typeof error.stack === "string") {
    for (const row of error.stack.slice(0, 8192).split("\n").slice(1, 17)) {
      const match = /\/([a-z-]+\.js):(\d{1,6}):(\d{1,6})\)?$/.exec(row.trim());
      if (!match || !Object.values(HostedReadonlyOperatorSource).includes(match[1] as HostedReadonlyOperatorSource)) continue;
      const line = Number(match[2]), column = Number(match[3]);
      if (line < 1 || column < 1) continue;
      locations.push({ file: match[1] as HostedReadonlyOperatorSource, line, column });
      if (locations.length === 8) break;
    }
  }
  return { reason, locations };
}
