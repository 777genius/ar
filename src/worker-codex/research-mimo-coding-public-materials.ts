import { codexMimoDefaultModel } from "../provider-codex/codex-model-backend";

// Fixed guest public policy only. No path, bytes or model catalog comes from
// the request, project, account cache, provider frame or Host /etc/codex.
export const researchMimoCodingRequirementsPath = "/etc/codex/requirements.toml";
export const researchMimoCodingModelCatalogPath = "/etc/codex/mimo-coding-models.json";

/** Codex ff6 ModelInfo serde fixture shape (openai_models.rs), limited to the
 * admitted exact MiMo model. ModelsResponse additionally requires a literal
 * instructions_template (or legacy base_instructions). Tool metadata is preparation, not activation or
 * evidence that the provider's custom-tool roundtrip has been qualified. */
const catalog = JSON.stringify({ models: [{
  slug: codexMimoDefaultModel, display_name: "MiMo", description: null,
  supported_reasoning_levels: [], shell_type: "unified_exec", visibility: "list",
  supported_in_api: true, priority: 1, upgrade: null,
  model_messages: { instructions_template: "You are a coding assistant. Use exec_command to inspect, edit, and test the workspace. For patches, run /opt/subscription-runtime/codex/0.159.2/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --codex-run-as-apply-patch through exec_command with the complete patch as one argument." },
  include_apps_usage_instructions: false, input_modalities: ["text"],
  default_reasoning_summary: "auto", support_verbosity: false, default_verbosity: null,
  apply_patch_tool_type: null, truncation_policy: { mode: "bytes", limit: 10000 },
  supports_image_detail_original: false, context_window: null,
  auto_compact_token_limit: null, effective_context_window_percent: 95,
  experimental_supported_tools: [],
}] }) + "\n";

/** System requirements apply the exact catalog path after local config and
 * retain Some(empty) as a hard MCP allowlist, including project/plugin MCP. */
export const researchMimoCodingPublicMaterials = Object.freeze([
  Object.freeze({ target: researchMimoCodingRequirementsPath, name: "coding-requirements.snapshot",
    bytes: `mcp_servers = {}\nmodel_catalog_json = "${researchMimoCodingModelCatalogPath}"\n` }),
  Object.freeze({ target: researchMimoCodingModelCatalogPath, name: "coding-model-catalog.snapshot", bytes: catalog }),
]);
