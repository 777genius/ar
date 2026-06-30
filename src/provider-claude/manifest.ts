import type { RuntimeAdapterManifest } from "@777genius/subscription-runtime/core";
import {
  claudeBgTaskAgentCapabilities,
  claudeSessionCapabilities,
} from "./capabilities";

export const claudeProviderManifest = {
  adapterId: "provider.claude-bg",
  adapterKind: "combined-provider",
  packageName: "@777genius/subscription-runtime/provider-claude",
  packageVersion: "0.0.0",
  protocolVersion: 1,
  capabilities: {
    session: claudeSessionCapabilities,
    agent: claudeBgTaskAgentCapabilities,
  },
  experimental: true,
  minimumCoreVersion: "0.0.0",
} satisfies RuntimeAdapterManifest<{
  readonly session: typeof claudeSessionCapabilities;
  readonly agent: typeof claudeBgTaskAgentCapabilities;
}>;
