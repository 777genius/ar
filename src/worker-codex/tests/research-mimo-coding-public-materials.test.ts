import { expect, it } from "vitest";
import { codexMimoDefaultModel } from "../../provider-codex/codex-model-backend";
import { researchMimoCodingModelCatalogPath, researchMimoCodingPublicMaterials,
  researchMimoCodingRequirementsPath } from "../research-mimo-coding-public-materials";

it("pins an explicit empty system MCP allowlist and the only guest model catalog", () => {
  const requirements = researchMimoCodingPublicMaterials.find(file => file.target === researchMimoCodingRequirementsPath)!;
  expect(requirements.bytes).toBe('mcp_servers = {}\nmodel_catalog_json = "/etc/codex/mimo-coding-models.json"\n');
  expect(Object.isFrozen(researchMimoCodingPublicMaterials)).toBe(true);
  expect(researchMimoCodingPublicMaterials.every(Object.isFrozen)).toBe(true);
});

it("advertises only the exact MiMo model with native function exec and shell patch editing without custom tools", () => {
  const catalog = JSON.parse(researchMimoCodingPublicMaterials.find(file => file.target === researchMimoCodingModelCatalogPath)!.bytes);
  expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual([codexMimoDefaultModel]);
  expect(catalog.models[0]).toMatchObject({ slug: codexMimoDefaultModel, shell_type: "unified_exec",
    apply_patch_tool_type: null, input_modalities: ["text"], include_apps_usage_instructions: false,
    supported_reasoning_levels: [], experimental_supported_tools: [] });
  expect(JSON.stringify(catalog)).not.toContain('"freeform"');
  expect(catalog.models[0].model_messages.instructions_template).toContain("Use exec_command to inspect, edit, and test the workspace.");
  expect(catalog.models[0].model_messages.instructions_template).toContain(
    "/opt/subscription-runtime/codex/0.159.2/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex --codex-run-as-apply-patch through exec_command with the complete patch as one argument.");
  expect(catalog.models[0].base_instructions).toBeUndefined();
});
