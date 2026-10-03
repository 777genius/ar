import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createCodexGoalMcpServer } from "../codex-goal-mcp";
import {
  subscriptionRuntimePackageJsonUrl,
  subscriptionRuntimePackageVersion,
} from "../subscription-runtime-package-version";

describe("subscription runtime package version", () => {
  it("resolves root package metadata from source and packaged dist layouts", () => {
    expect(fileURLToPath(subscriptionRuntimePackageJsonUrl())).toBe(
      fileURLToPath(new URL("../../../package.json", import.meta.url)),
    );
    expect(subscriptionRuntimePackageJsonUrl(
      "file:///packed/dist/worker-codex/subscription-runtime-package-version.js",
    ).href).toBe("file:///packed/package.json");
    const packageMetadata = JSON.parse(
      readFileSync(subscriptionRuntimePackageJsonUrl(), "utf8"),
    ) as { readonly version: string };
    expect(subscriptionRuntimePackageVersion).toBe(packageMetadata.version);
  });

  it("reports the packaged version in the MCP initialize response", async () => {
    const server = createCodexGoalMcpServer();
    const client = new Client({ name: "version-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      expect(client.getServerVersion()?.version).toBe(
        subscriptionRuntimePackageVersion,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
