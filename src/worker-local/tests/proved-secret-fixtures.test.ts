import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectSecretLikeContent, matchesSecretLikeContentPatterns } from "@vioxen/subscription-runtime/worker-core";

// Verified retained source lines, stored as data only; never import fixture code.
const redactionFixturePath = "src/worker-local/tests/project-integration-local-adapters.test.ts";
const redactionFixtureLines = readFileSync(redactionFixturePath, "utf8")
  .split("\n").filter((line) => /\bsk-[A-Za-z0-9_-]{20,}\b/.test(line));
if (redactionFixtureLines.length !== 1) throw new Error("expected one retained signature line");

const cases: readonly (readonly [string, number, string])[] = [
  [redactionFixturePath, 1005, redactionFixtureLines[0]!],
  [
    "packages/apps/embedded-runtime/tests/contained-turn-provider-access-integration.test.ts",
    492,
    "  const secret = \"provider-owner-output-secret\";"
  ],
  [
    "packages/apps/embedded-runtime/tests/contained-turn-provider-selection-construction.test.ts",
    156,
    "  const secret = \"credential-secret-7fc2\";"
  ],
  [
    "packages/apps/embedded-runtime/tests/contained-turn-provider-selection-construction.test.ts",
    331,
    "  const secret = \"provider-access-getter-secret\";"
  ],
  [
    "packages/apps/embedded-runtime/tests/live/linux-codex-live-admin.test.ts",
    117,
    "  const secret = \"malicious-password-/private/path\";"
  ],
  [
    "packages/apps/embedded-runtime/tests/live/run-linux-codex-live-canary.test.mjs",
    404,
    ("  const secret = '" + "malicious-error-password-/private/path';")
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    360,
    ("  const secret = \"" + "sk-" + "ant-abcdefghijklmnopqrstuvwxyz0123456789\";")
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    388,
    ("  const credential = \"" + "sk-" + "ant-synthetic-private-credential-0123456789\";")
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    444,
    ("  const intentionalAssistantText = \"assistant-visible " + "sk-" + "ant-intentional-output-0123456789\";")
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    445,
    ("  const rawDiagnostic = \"SDK failure for " + "sk-" + "ant-private-diagnostic-9876543210 at /private/provider/config\";")
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    491,
    ("          delta: { text: { diagnostic: \"" + "sk-" + "ant-malformed-private-diagnostic\" }, type: \"text_delta\" },")
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/docker-native-start-diagnostic.test.ts",
    11,
    "    const secret = \"SECRET-config-env-credential-error-payload\";"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/support/docker-native-finalizer-fixture.ts",
    42,
    ("      {name: \"authorization\", valueBytes: Buffer.from(\"" + "Bearer " + "synthetic-upstream-only\")},")
  ]
];

describe("finite proved synthetic locations", () => {
  for (const [index, [filePath, , line]] of cases.entries()) {
    it(`classifies exact location ${index} and continues every policy`, () => {
      const safe = (text: string | Buffer, path?: string) =>
        detectSecretLikeContent(text, path === undefined ? {} : { filePath: path }) === undefined;
      expect(safe(line, filePath)).toBe(true);
      expect(safe(Buffer.from(line), filePath)).toBe(true);
      expect(safe("prefix\n" + line + "\n", filePath)).toBe(true);
      for (const alias of [undefined, "tests/other.test.ts", filePath.toUpperCase(),
        "./" + filePath, "/" + filePath, "x/../" + filePath,
        filePath.replaceAll("/", "\\"), filePath.split("/").at(-1)]) {
        expect(safe(line, alias)).toBe(false);
      }
      const signature = /\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i.exec(line);
      const assignment = /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret)\b\s*[:=]\s*["']([A-Za-z0-9_./+=-]{16,})["']/i.exec(line);
      const literal = assignment?.[1] ?? signature?.[0];
      if (literal === undefined) throw new Error("missing fixture rule");
      const tokenStart = literal.startsWith("Bearer ") ? 7 : literal.startsWith("sk-") ? 3 : 0;
      for (let i = tokenStart; i < literal.length; i += 1) {
        const character = literal[i]!;
        for (const replacement of [character === "Q" ? "R" : "Q", character.toUpperCase(), character.toLowerCase()]) {
          if (replacement === character) continue;
          const changed = literal.slice(0, i) + replacement + literal.slice(i + 1);
          expect(safe(line.replace(literal, changed), filePath)).toBe(false);
        }
      }
      for (const changed of [literal + "Q", literal.slice(0, tokenStart) + "Q" + literal.slice(tokenStart), literal + ".suffix"]) {
        expect(safe(line.replace(literal, changed), filePath)).toBe(false);
      }
      const unsafe = [
        'secret = "' + "generated-negative-".repeat(3) + '";',
        "sk-" + "q".repeat(32), "Bearer " + "z".repeat(32),
        "ghp_" + "q".repeat(32), "AKIA" + "Q".repeat(16),
        "-----BEGIN " + "PRIVATE KEY-----",
        "SUBSCRIPTION_RUNTIME_OPENAI_BRIDGE_API_KEY=" + "q".repeat(32),
        Buffer.from('{"alg":"HS256"}').toString("base64url") + "." +
          Buffer.from('{"sub":"synthetic"}').toString("base64url") + ".c2ln",
      ];
      for (const other of unsafe) {
        expect(safe(line + "\n" + other, filePath)).toBe(false);
        expect(safe(other + "\n" + line, filePath)).toBe(false);
        expect(safe(line + "\n" + line + "\n" + other, filePath)).toBe(false);
      }
      expect(safe(Buffer.concat([Buffer.from(line), Buffer.from([0])]), filePath)).toBe(false);
      expect(matchesSecretLikeContentPatterns(line, [/./g])).toBe(true);
      expect(matchesSecretLikeContentPatterns(line, [/./g])).toBe(true);
      if (/sk-|Bearer/.test(line)) {
        expect(safe(" " + line, filePath)).toBe(false);
        expect(safe(line + " ", filePath)).toBe(false);
        expect(safe(line + "\r", filePath)).toBe(false);
      }
    });
  }
});
