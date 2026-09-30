import { CodexModelBackend } from "./codex-model-backend";
import type { CodexAppServerExecutionEngineOptions } from "./codex-app-server-execution-engine-options";

export function assertHostedAppServerEngineOptions(options: CodexAppServerExecutionEngineOptions): void {
  if ((options.sourceEnv ?? process.env).SUBSCRIPTION_RUNTIME_SANDBOX_KIND !== "hosted-codex-job") return;
  if (options.hostedPermissionProfiles !== true && options.nativeToolSurface !== "disabled") {
    throw new Error("hosted_permission_profiles_required_for_native_tools");
  }
  if (options.modelBackend === CodexModelBackend.XiaomiMimoTokenPlan &&
      (options.nativeToolSurface !== "disabled" || options.hostedPermissionProfiles !== true)) {
    throw new Error("hosted_mimo_effective_confinement_required");
  }
}
