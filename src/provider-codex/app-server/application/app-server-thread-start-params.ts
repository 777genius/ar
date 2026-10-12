import { HostedMimoProfile } from "../../hosted-mimo-profile";
import { assertHostedMimoCodingEngineAuthority, type HostedMimoCodingEngineAuthority } from "../../hosted-mimo-coding-engine-authority";
import { hostedControllerDynamicToolSpecs, type HostedControllerDynamicToolAdapter } from "../domain/hosted-controller-dynamic-tools";
import type { ChildExecutionBudget } from "@vioxen/subscription-runtime/core";
import { codexProviderHasPublicSources } from "../../codex-provider-egress-policy";
import type { ResolvedCodexExecutionProfile } from "../../codex-execution-profile";
import type { CodexReasoningEffort, CodexSandboxMode, CodexServiceTier } from "../../codex-json-execution-engine";
import { CodexModelBackend, codexModelBackendModelProviderName } from "../../codex-model-backend";
import { CodexProviderEgressProfileId, type CodexProviderEgressPolicy } from "../../codex-provider-egress-policy";
import { hostedCodexPermissionProfileId } from "../../hosted-codex-permissions";
import { codexAppServerThreadRuntimePolicy, type CodexAppServerCommandApprovalPolicy, type CodexAppServerNativeToolSurface } from "../domain/app-server-types";
import { codexAppServerToolConfig } from "../domain/app-server-tool-config";
import type { CodexAppServerRolloutBudget } from "../domain/app-server-rollout-budget";
import { appServerThreadToolPolicy } from "./app-server-thread-tool-policy";
import { appServerThreadConfig } from "./app-server-thread-config";
import { excludeCodexModelBackendConfigKeys } from "./app-server-thread-config-backend-filter";
import { appServerApprovalPolicy } from "./app-server-approval-policy";
import { publicResearchSourceTool } from "./public-research-source-tool";
import type { PublicResearchSourceReader } from "./public-research-source-port";

export function appServerThreadStartParams(input: {
  readonly workspacePath: string;
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly serviceTier?: CodexServiceTier;
  readonly sandboxMode?: CodexSandboxMode;
  readonly systemPrompt?: string;
  readonly goalMode?: boolean;
}, options: {
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly executionProfile: ResolvedCodexExecutionProfile;
  readonly hostedCodingAuthority?: HostedMimoCodingEngineAuthority;
  readonly hostedPermissionProfiles?: boolean;
  readonly commandApprovalPolicy?: CodexAppServerCommandApprovalPolicy;
  readonly nativeToolSurface?: CodexAppServerNativeToolSurface;
  readonly nativeGoalControls?: true;
  readonly bypassHookTrust?: boolean;
  readonly rolloutBudget?: CodexAppServerRolloutBudget;
  readonly modelBackend?: CodexModelBackend;
  readonly providerEgressPolicy?: CodexProviderEgressPolicy;
  readonly publicSourceReader?: PublicResearchSourceReader;
  readonly hostedControllerTools?: HostedControllerDynamicToolAdapter;
  readonly childBudget?: ChildExecutionBudget;
}) {
  if (options.nativeGoalControls !== undefined && (options.nativeGoalControls !== true ||
      input.goalMode !== true || options.nativeToolSurface !== "disabled" || options.hostedControllerTools !== undefined)) {
    throw new Error("codex_app_server_native_goal_controls_profile_invalid");
  }
  if (options.hostedControllerTools && (!input.goalMode || options.nativeToolSurface !== "disabled")) {
    throw new Error("hosted_controller_tool_profile_invalid");
  }
  const { disableTools, disableNativeEnvironments } = appServerThreadToolPolicy({
    disableTools: options.executionProfile.disableTools,
    nativeToolSurface: options.nativeToolSurface,
    goalMode: input.goalMode,
  });
  const threadPolicy = codexAppServerThreadRuntimePolicy({
    workspacePath: input.workspacePath,
    allowExtraWritableRoots: options.hostedPermissionProfiles !== true,
    ...(input.sandboxMode === undefined
      ? {}
      : { sandboxMode: input.sandboxMode }),
    sourceEnv: options.sourceEnv,
    baseDeveloperInstructions:
      options.executionProfile.developerInstructions,
    ...(input.systemPrompt === undefined
      ? {}
      : { systemPrompt: input.systemPrompt }),
  });
  const hostedPermissions = options.hostedPermissionProfiles
    ? hostedCodexPermissionProfileId({ sandboxMode: threadPolicy.sandboxMode })
    : null;
  if (options.nativeToolSurface === HostedMimoProfile.CodingV1 || options.hostedCodingAuthority !== undefined) assertHostedMimoCodingEngineAuthority(options.hostedCodingAuthority,
    { workspacePath: input.workspacePath, model: input.model });
  const toolConfig = codexAppServerToolConfig({
    nativeToolSurface: options.nativeToolSurface,
    fastMode: input.serviceTier === "fast",
    goalMode: input.goalMode === true,
    trustedHooksEnabled: options.bypassHookTrust === true,
    ...(options.nativeGoalControls === undefined ? {} : { nativeGoalControls: options.nativeGoalControls }),
  });
  const modelBackend = options.modelBackend ?? CodexModelBackend.OpenAiChatGpt;
  const threadModelProvider = codexModelBackendModelProviderName(modelBackend) ?? null;
  const threadConfig = excludeCodexModelBackendConfigKeys(modelBackend, appServerThreadConfig({
    reasoningEffort: input.reasoningEffort,
    providerEgressPolicy: options.providerEgressPolicy,
    modelBackend,
    webToolsEnabled: options.nativeToolSurface !== HostedMimoProfile.CodingV1 && !disableTools && !disableNativeEnvironments,
    ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
    ...(options.commandApprovalPolicy === undefined
      ? {}
      : { commandApprovalPolicy: options.commandApprovalPolicy }),
    hostedPermissions,
    sandboxMode: threadPolicy.sandboxMode,
    toolConfig,
    rolloutBudget: options.rolloutBudget,
  }));
  const researchToolsEnabled = codexProviderHasPublicSources(options.providerEgressPolicy) &&
    modelBackend === CodexModelBackend.OpenAiChatGpt && !!options.publicSourceReader && !disableTools && !disableNativeEnvironments;
  return { researchToolsEnabled, params: {
      runtimeWorkspaceRoots: threadPolicy.runtimeWorkspaceRoots,
      model: input.model,
      modelProvider: threadModelProvider,
      ...(modelBackend === CodexModelBackend.XiaomiMimoTokenPlan
        ? {}
        : { serviceTier: input.serviceTier ?? null }),
      cwd: input.workspacePath,
      approvalPolicy: appServerApprovalPolicy(options.commandApprovalPolicy),
      approvalsReviewer: null,
      ...(hostedPermissions
        ? { permissions: hostedPermissions }
        : { sandbox: threadPolicy.sandboxMode }),
      config: threadConfig,
      serviceName: "subscription-runtime",
      baseInstructions: options.executionProfile.baseInstructions,
      developerInstructions: threadPolicy.developerInstructions,
      personality: null,
      ephemeral: input.goalMode ? false : true,
      ...(researchToolsEnabled ? { dynamicTools: [publicResearchSourceTool] } : {}),
      sessionStartSource: "startup",
      threadSource: "user",
      ...(options.hostedControllerTools
        ? { environments: [], dynamicTools: hostedControllerDynamicToolSpecs, experimentalRawEvents: false }
        : disableTools
        ? {
            environments: [],
            dynamicTools: [],
            experimentalRawEvents: false,
          }
        : disableNativeEnvironments
          ? {
              environments: [],
              ...(options.childBudget ? { dynamicTools: [], experimentalRawEvents: false } : {}),
            }
          : {}),
    } };
}
