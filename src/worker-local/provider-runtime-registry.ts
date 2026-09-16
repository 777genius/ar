import {
  createProviderRuntimeRegistry,
  type ProviderRuntimeRegistry,
} from "@vioxen/subscription-runtime/worker-core";
import { createCodexProviderRuntimeAdapter } from "../worker-codex/codex-provider-runtime-adapter";
import { createClaudeProviderRuntimeAdapter } from "./claude-provider-runtime-adapter";

/**
 * Local composition of the provider runtime registry. Codex is registered
 * first so `supported()` keeps Codex ahead of Claude in client-facing hints.
 */
export function createLocalProviderRuntimeRegistry(): ProviderRuntimeRegistry {
  return createProviderRuntimeRegistry([
    createCodexProviderRuntimeAdapter(),
    createClaudeProviderRuntimeAdapter(),
  ]);
}
