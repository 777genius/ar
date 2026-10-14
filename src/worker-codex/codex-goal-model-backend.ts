import { CodexModelBackend } from "@vioxen/subscription-runtime/provider-codex";

/**
 * Defaults to {@link CodexModelBackend.OpenAiChatGpt} everywhere it is
 * consumed — an existing manifest/launch input/CLI invocation with no
 * `modelBackend` at all keeps running the unchanged ChatGPT path with no
 * migration required. Used identically at every layer of the launch chain
 * (CLI flags, MCP tool input, manifest create/patch/parse) so there is one
 * place that decides what counts as a valid backend value.
 */
export function optionalCodexGoalModelBackend(
  value: unknown,
  fieldName = "modelBackend",
): { readonly modelBackend?: CodexModelBackend } {
  if (value === undefined) return {};
  if (
    value === CodexModelBackend.OpenAiChatGpt ||
    value === CodexModelBackend.XiaomiMimoTokenPlan
  ) {
    return { modelBackend: value };
  }
  throw new Error(
    `${fieldName} must be ${CodexModelBackend.OpenAiChatGpt} or ${CodexModelBackend.XiaomiMimoTokenPlan}`,
  );
}
