import { describe, expect, it } from "vitest";
import { RunEventProviderKind } from "../../run-provider-kind";
import {
  createProviderRuntimeRegistry,
  ProviderRuntimeUnsupportedError,
  type ProviderControlledAgentResult,
  type ProviderControllerProfile,
  type ProviderRunObservation,
  type ProviderRuntimeAdapter,
} from "../index";

function stubAdapter(
  kind: RunEventProviderKind.Codex | RunEventProviderKind.Claude,
): ProviderRuntimeAdapter {
  return {
    kind,
    observation(): ProviderRunObservation {
      return {
        responseLocator: { kind },
        observeRun: async () => {
          throw new Error("not_used_in_registry_test");
        },
      };
    },
    controllerProfile(): ProviderControllerProfile {
      return {
        kind,
        enforcement: {
          providerKind: kind,
          canRestrictToolSurface: true,
          canDisableRawShell: true,
          canEnforceFilesystemSandbox: true,
          canIsolateHome: true,
          canIsolateTemp: true,
          canRestrictNetwork: true,
        },
        allowedTools: () => [`${kind}-tool`],
        sessionId: (controllerJobId) => `${controllerJobId}:${kind}`,
        readyJson: () => ({ kind }),
        rawProfile: { kind },
      };
    },
    controlledAgentProvider(): Promise<ProviderControlledAgentResult> {
      throw new Error("not_used_in_registry_test");
    },
  };
}

describe("createProviderRuntimeRegistry", () => {
  it("resolves registered adapters by kind", () => {
    const codex = stubAdapter(RunEventProviderKind.Codex);
    const claude = stubAdapter(RunEventProviderKind.Claude);
    const registry = createProviderRuntimeRegistry([codex, claude]);

    expect(registry.get(RunEventProviderKind.Codex)).toBe(codex);
    expect(registry.get(RunEventProviderKind.Claude)).toBe(claude);
  });

  it("reports supported kinds in registration order", () => {
    const registry = createProviderRuntimeRegistry([
      stubAdapter(RunEventProviderKind.Codex),
      stubAdapter(RunEventProviderKind.Claude),
    ]);

    expect(registry.supported()).toEqual([
      RunEventProviderKind.Codex,
      RunEventProviderKind.Claude,
    ]);
  });

  it("throws ProviderRuntimeUnsupportedError for unknown kinds", () => {
    const registry = createProviderRuntimeRegistry([
      stubAdapter(RunEventProviderKind.Codex),
    ]);

    let thrown: unknown;
    try {
      registry.get(RunEventProviderKind.Claude);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderRuntimeUnsupportedError);
    expect((thrown as ProviderRuntimeUnsupportedError).kind).toBe(
      RunEventProviderKind.Claude,
    );
    expect((thrown as ProviderRuntimeUnsupportedError).supported).toEqual([
      RunEventProviderKind.Codex,
    ]);
  });

  it("rejects duplicate adapters for the same kind", () => {
    expect(() =>
      createProviderRuntimeRegistry([
        stubAdapter(RunEventProviderKind.Codex),
        stubAdapter(RunEventProviderKind.Codex),
      ])
    ).toThrow(/provider_runtime_adapter_duplicate/);
  });
});
