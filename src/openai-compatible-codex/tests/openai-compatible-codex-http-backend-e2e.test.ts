import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexOpenAiBridgeBackend,
  OpenAiBridgeChatCompletionUseCase,
  OpenAiBridgeResponseFormatType,
  openAiBridgeRuntimeAttestationCanonicalBytes,
  startOpenAiBridgeHttpServer,
  verifyOpenAiBridgeRuntimeAttestationHmac,
  type OpenAiBridgeChatCompletionResponse,
} from "@vioxen/subscription-runtime/openai-compatible-codex";
import { FakeAppServerFactory } from "../../provider-codex/app-server/testing/fake-app-server.js";

const attestationSecret = "http-e2e-attestation-secret-that-is-at-least-32-bytes";
const outputText = '{"reasoning":"Evidence matches.","label":"CORRECT"}';
const judgeSchema = {
  type: "object",
  properties: {
    reasoning: { type: "string" },
    label: { type: "string", enum: ["CORRECT", "WRONG"] },
  },
  required: ["reasoning", "label"],
  additionalProperties: false,
} as const;

describe("OpenAI bridge real HTTP/backend boundary", () => {
  it("binds noncanonical raw JSON through real backend and public verifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "subscription-runtime-http-e2e-"));
    const authRoot = join(root, "auth");
    const accountHome = join(authRoot, "account-a");
    await mkdir(accountHome, { recursive: true });
    await writeFile(join(accountHome, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "test-token",
        account_id: "physical-account-a",
      },
    }));
    const factory = new FakeAppServerFactory({
      turnUsage: observedTurnUsage(),
      agentMessageText: outputText,
    });
    const backend = new CodexOpenAiBridgeBackend({
      codexBinaryPath: "/bin/codex-test",
      authRootDir: authRoot,
      stateDir: join(root, "state"),
      accountNames: ["account-a"],
      timeoutMs: 250,
      quotaCooldownMs: 1_000,
      maxAccountCycles: 1,
      maxConcurrentRequests: 1,
      reasoningEffort: "high",
      attestationSecret,
      processFactory: factory.create,
    });
    const server = await startOpenAiBridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      publicModel: "subscription-codex",
      requestBodyMaxBytes: 64 * 1024,
      chatCompletion: new OpenAiBridgeChatCompletionUseCase({
        backend,
        publicModel: "subscription-codex",
        codexModel: "gpt-5.5",
      }),
      health: () => backend.health(),
    });
    try {
      const systemPrompt = "Official LoCoMo judge system prompt.";
      const userPrompt = "Official LoCoMo judge user prompt.";
      const deliberatelyReorderedRequest = {
        temperature: 0,
        response_format: {
          json_schema: {
            strict: true,
            schema: {
              additionalProperties: false,
              required: ["reasoning", "label"],
              properties: {
                label: { enum: ["CORRECT", "WRONG"], type: "string" },
                reasoning: { type: "string" },
              },
              type: "object",
            },
            name: "locomo_judge",
          },
          type: OpenAiBridgeResponseFormatType.JsonSchema,
        },
        max_tokens: 4_096,
        messages: [
          { content: systemPrompt, role: "system" },
          { content: userPrompt, role: "user" },
        ],
        model: "subscription-codex",
      };
      const rawBody = `${JSON.stringify(deliberatelyReorderedRequest, null, 3)}\n`;
      expect(rawBody).not.toBe(JSON.stringify(JSON.parse(rawBody)));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test_server_address");
      const httpResponse = await fetch(
        `http://127.0.0.1:${address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        },
      );
      expect(httpResponse.status).toBe(200);
      const response = await httpResponse.json() as OpenAiBridgeChatCompletionResponse;
      const runtime = response.subscription_runtime;

      expect(factory.prompts).toEqual([userPrompt]);
      expect(factory.requests.find((item) => item.method === "thread/start")?.params)
        .toMatchObject({ developerInstructions: systemPrompt });
      expect(factory.requests.find((item) => item.method === "turn/start")?.params)
        .toMatchObject({ outputSchema: judgeSchema });
      expect(runtime.request_identity.request_body_sha256).toBe(
        createHash("sha256").update(rawBody, "utf8").digest("hex"),
      );
      expect(runtime.output_identity.output_text_sha256).toBe(
        createHash("sha256").update(outputText, "utf8").digest("hex"),
      );

      const attestation = {
        requestIdentity: runtime.request_identity,
        outputIdentity: runtime.output_identity,
        selection: runtime.runtime_selection,
        usage: response.usage,
        requestedOutputTokenLimit: 4_096,
      } as const;
      const recomputedHmac = createHmac("sha256", attestationSecret)
        .update(openAiBridgeRuntimeAttestationCanonicalBytes(attestation))
        .digest("hex");
      expect(recomputedHmac).toBe(runtime.receipt_hmac_sha256);
      expect(verifyOpenAiBridgeRuntimeAttestationHmac({
        attestationSecret,
        expectedHmacSha256: runtime.receipt_hmac_sha256,
        attestation,
      })).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function observedTurnUsage(): Record<string, number> {
  return {
    input_tokens: 20,
    cached_input_tokens: 4,
    cache_write_input_tokens: 0,
    output_tokens: 8,
    reasoning_output_tokens: 2,
    total_tokens: 28,
  };
}
