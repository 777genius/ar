import { HostedMimoProfile } from "./hosted-mimo-profile";
import { assertHostedMimoCodingEngineAuthority } from "./hosted-mimo-coding-engine-authority";
import { CodexModelBackend } from "./codex-model-backend";
import type { CodexAppServerExecutionEngineOptions } from "./codex-app-server-execution-engine-options";

export function assertHostedAppServerEngineOptions(options: CodexAppServerExecutionEngineOptions): void {
  const coding = options.nativeToolSurface === HostedMimoProfile.CodingV1;
  if (coding || options.hostedCodingAuthority !== undefined) {
    assertHostedMimoCodingEngineAuthority(options.hostedCodingAuthority, { processFactory: options.processFactory,
      executionLifetime: options.executionLifetime, codexBinaryPath: options.codexBinaryPath });
    if (!coding || options.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan || options.executionLifetime === undefined ||
        options.maxGoalTurns !== 64 || options.goalMode !== false || options.cleanThreadPrewarm !== false || options.fallback !== undefined ||
        options.childBudget !== undefined || options.hostedControllerTools !== undefined || options.hostedPermissionProfiles !== true ||
        options.bypassHookTrust === true || options.publicSourceReader !== undefined) throw new Error("hosted_mimo_coding_engine_profile_invalid");
  }
  if (options.hostedControllerTools &&
      (options.modelBackend !== CodexModelBackend.XiaomiMimoTokenPlan ||
       options.goalMode !== true ||
       options.nativeToolSurface !== "disabled" ||
       options.fallback !== undefined ||
       options.cleanThreadPrewarm !== false)) {
    throw new Error("hosted_controller_engine_profile_invalid");
  }
  if ((options.sourceEnv ?? process.env).SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") return;
  if (options.hostedPermissionProfiles !== true && options.nativeToolSurface !== "disabled") {
    throw new Error("hosted_permission_profiles_required_for_native_tools");
  }
  if (options.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      (!coding && options.nativeToolSurface !== "disabled" || options.hostedPermissionProfiles !== true)) {
    throw new Error("hosted_mimo_effective_confinement_required");
  }
}
