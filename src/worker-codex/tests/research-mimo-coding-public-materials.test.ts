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

it("advertises only the exact MiMo model with native exec and freeform patch metadata", () => {
  const catalog = JSON.parse(researchMimoCodingPublicMaterials.find(file => file.target === researchMimoCodingModelCatalogPath)!.bytes);
  expect(catalog.models.map((model: { slug: string }) => model.slug)).toEqual([codexMimoDefaultModel]);
  expect(catalog.models[0]).toMatchObject({ slug: "mimo-v2.6-pro", shell_type: "unified_exec",
    apply_patch_tool_type: "freeform", input_modalities: ["text"], include_apps_usage_instructions: false,
    supported_reasoning_levels: [], experimental_supported_tools: [] });
  expect(catalog.models[0].model_messages.instructions_template).toBe(
    "You are a coding assistant. Use the available tools to inspect, edit, and test the workspace.");
  expect(catalog.models[0].base_instructions).toBeUndefined();
});
