import type { RunEventProviderKind } from "../run-provider-kind";
import {
  ProviderRuntimeUnsupportedError,
  type ProviderRuntimeAdapter,
  type ProviderRuntimeRegistry,
} from "./ports";

/**
 * Builds a Map-backed registry over the given adapters. `supported()` preserves
 * adapter order, so callers control the order surfaced to clients (for example
 * the `supportedProviderKinds` hint in run-watch responses).
 */
export function createProviderRuntimeRegistry(
  adapters: readonly ProviderRuntimeAdapter[],
): ProviderRuntimeRegistry {
  const byKind = new Map<RunEventProviderKind, ProviderRuntimeAdapter>();
  for (const adapter of adapters) {
    if (byKind.has(adapter.kind)) {
      throw new Error(`provider_runtime_adapter_duplicate:${adapter.kind}`);
    }
    byKind.set(adapter.kind, adapter);
  }
  const supported = [...byKind.keys()];
  return {
    get(kind) {
      const adapter = byKind.get(kind);
      if (!adapter) {
        throw new ProviderRuntimeUnsupportedError(kind, supported);
      }
      return adapter;
    },
    supported() {
      return supported;
    },
  };
}
