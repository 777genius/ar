// Local re-export of the provider runtime registry type. The MCP facade files
// (`codex-goal-mcp-*-tools.ts`, `codex-goal-mcp.ts`) may not import worker-core
// directly, so they take the registry type from this worker-codex-owned module.
export type { ProviderRuntimeRegistry } from "@vioxen/subscription-runtime/worker-core";
