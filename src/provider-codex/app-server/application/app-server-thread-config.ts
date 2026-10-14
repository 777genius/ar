import type { CodexReasoningEffort, CodexSandboxMode, CodexServiceTier } from "../../codex-json-execution-engine";
import type { CodexAppServerCommandApprovalPolicy } from "../domain/app-server-types";
import { codexAppServerRolloutBudgetConfig, type CodexAppServerRolloutBudget } from "../domain/app-server-rollout-budget";
import { codexAppServerToolConfig } from "../domain/app-server-tool-config";
import { readRecord } from "../protocol/app-server-content-parser";
import type { HostedCodexPermissionProfileId } from "../../hosted-codex-permissions";
import { codexProviderWebSearchMode, CodexWebSearchMode, type CodexProviderEgressPolicy } from "../../codex-provider-egress-policy";
import type { CodexModelBackend } from "../../codex-model-backend";

export function appServerThreadConfig(input: {
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly hostedPermissions: HostedCodexPermissionProfileId | null;
  readonly sandboxMode: CodexSandboxMode;
  readonly toolConfig: ReturnType<typeof codexAppServerToolConfig>;
  readonly rolloutBudget?: CodexAppServerRolloutBudget | undefined;
  readonly providerEgressPolicy?: CodexProviderEgressPolicy | undefined;
  readonly modelBackend?: CodexModelBackend | undefined;
  readonly webToolsEnabled?: boolean;
}) {
  return {
    model_reasoning_effort: input.reasoningEffort,
    model_verbosity: "low",
    ...(input.serviceTier === undefined ? {} : { service_tier: input.serviceTier }),
    approval_policy: input.commandApprovalPolicy === undefined ? "never" : "on-request",
    ...(input.hostedPermissions ? {} : { sandbox_mode: input.sandboxMode }),
    web_search: input.webToolsEnabled === true
      ? codexProviderWebSearchMode(input.providerEgressPolicy, input.modelBackend)
      : CodexWebSearchMode.Disabled,
    ...input.toolConfig,
    features: {
      ...(readRecord(input.toolConfig.features) ?? {}),
      ...codexAppServerRolloutBudgetConfig(input.rolloutBudget),
    },
    apps: {
      _default: {
        enabled: false,
        destructive_enabled: false,
        open_world_enabled: false,
      },
    },
  };
}
