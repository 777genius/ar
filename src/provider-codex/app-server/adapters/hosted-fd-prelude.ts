// Finite wire labels for fixed protected bootstraps. Neither marker carries
// authority; the host reobserves real kernel/owner facts before sending input.
export const hostedFdReadyMarker = "subscription-runtime-fd-ready-v1\n";
export const hostedInstallerReleaseMarker = "subscription-runtime-installer-fd-release-v1\n";
export const hostedFdPreludeMaximumMs = 60_000;
export const hostedFdUnsetEnvironment = "NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_EXTRA_CA_CERTS NODE_REDIRECT_WARNINGS OPENSSL_CONF OPENSSL_MODULES LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GCONV_PATH LOCPATH GLIBC_TUNABLES";
export const hostedFdSystemdProperties = Object.freeze(["FileDescriptorStoreMax=0", "PassEnvironment=", `UnsetEnvironment=${hostedFdUnsetEnvironment}`]);

/** Request environment cannot inject code into a root bootstrap or redirect
 * its protected registry reads. This is data validation, never admission. */
export function assertHostedFdFrameEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(?:LD_|DYLD_|NODE_|GIT_)/.test(key) ||
        ["OPENSSL_CONF", "OPENSSL_MODULES", "GCONV_PATH", "LOCPATH", "GLIBC_TUNABLES",
          "SUBSCRIPTION_RUNTIME_CODEX_GOAL_REGISTRY_ROOT", "CODEX_GOAL_REGISTRY_ROOT"].includes(key)) {
      throw new Error("hosted_fd_frame_environment_denied");
    }
  }
}

export function announceHostedFdPrelude(): () => void {
  const deadline = setTimeout(() => process.exit(70), hostedFdPreludeMaximumMs);
  process.stdout.on("error", () => process.exit(70));
  process.stdout.write(hostedFdReadyMarker);
  return () => clearTimeout(deadline);
}
