import { createHash } from "node:crypto";

// Finite retained synthetic inputs verified by the PR71 provenance review.
// SHA-256 binds exact UTF-8 values and complete signature lines without storing
// credential-shaped fixture literals here. Paths are exact; no normalization.
const genericFixtures: readonly (readonly [string, string])[] = [
  [
    "packages/apps/embedded-runtime/tests/contained-turn-provider-access-integration.test.ts",
    "c9dbda36893498f041bf32d66bae337efa26a3436681773986d75b214ab61844"
  ],
  [
    "packages/apps/embedded-runtime/tests/contained-turn-provider-selection-construction.test.ts",
    "a70711d5334b043fe5c4a4805fe684a044fcb572807b11b1e51419bc834799e8"
  ],
  [
    "packages/apps/embedded-runtime/tests/contained-turn-provider-selection-construction.test.ts",
    "7535aef4b4a99673aa5a3ec7738837d77918671ec1dfd971d71cc6d617f1d020"
  ],
  [
    "packages/apps/embedded-runtime/tests/live/linux-codex-live-admin.test.ts",
    "6ceaa0efcf7bfbecaaae78c884223fb096bbd71727c51bcd185aff8450b9b421"
  ],
  [
    "packages/apps/embedded-runtime/tests/live/run-linux-codex-live-canary.test.mjs",
    "7df1164376e1a0264d0aa1bfb4319f109ff3f25653fd5af4606772b78b4f5aa6"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    "afaaab9f65f36136a819dfcab138873ae3f7d02f4f9fbc6b0b69ddb50f20f0ef"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/docker-native-start-diagnostic.test.ts",
    "5954485c8e6787b67061721c6b0128b3bb51cb825860ff0cfb05857ec311e233"
  ]
];

const signatureFixtures: readonly (readonly [string, string, string])[] = [
  // Accepted merge-tree-review-r3 proof: unchanged exact-base redaction fixture.
  [
    "src/worker-local/tests/project-integration-local-adapters.test.ts",
    "693f5072f49dad8d5fac77242b0ef1cad8c3b74d7b93cd9f4a54b64937efe0a3",
    "ff17f4073997825aded3c7ceeb7f7458f1fe76f8e3f86e3510eff21877da1b10"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    "afaaab9f65f36136a819dfcab138873ae3f7d02f4f9fbc6b0b69ddb50f20f0ef",
    "e942bbea3b0302d76a7bc7109c0c8e5896f427b0ad8ecc7e67937614d5299d47"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    "c498350ea046cfc888a76f615b79ee1a34faa5bf96cfdbad75867ad97dc275ca",
    "4c9defc9a4b076d8b8f317f31cc6820a556b0964f5f10a2beaa1d999cf5638dc"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    "c4d5579414f5839fc8aba5298bdf292e457a1dd9c7757082eacd19e3fcc2f7ab",
    "4b394973922b44b94b528c5b5fc11180ec188fc1f104e512747d87716b106810"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    "063dfe4c2fea1486905feb9c55423d6963454e768bad918c6a1c03fa0b255034",
    "e4a612b42251661e9a4fe506b4d3db957d8d1a9d5eb3ee567dfdb42c5b85d93d"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/claude-agent-sdk-contained-turn-provider.test.ts",
    "4d90ed30ddc270fbbb4cef6161edd5e7dc56884550dafb6a162defca100cd5a9",
    "ba51f37451770658658beda31c4edbbe952f8b7e051ac190f19bc2fc397dbd4f"
  ],
  [
    "packages/contexts/agent-execution/tests/features/contained-agent-turn/support/docker-native-finalizer-fixture.ts",
    "96283edf7f1782b8229f8bf2544a62f276eea766112208157e2e94f3ff075cf7",
    "491e7df9680400f58dae42a7de56fef2acd9e4cf1e5833a8ad9530edac96f385"
  ]
];

export function isProvedGenericFixture(path: string | undefined, value: string): boolean {
  return genericFixtures.some(([expectedPath, expectedValue]) =>
    path === expectedPath && digest(value) === expectedValue
  );
}

export function isProvedSignatureFixture(
  path: string | undefined, value: string, text: string, offset: number,
): boolean {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  const line = text.slice(start, end === -1 ? text.length : end);
  return signatureFixtures.some(([expectedPath, expectedValue, expectedLine]) =>
    path === expectedPath && digest(value) === expectedValue && digest(line) === expectedLine
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
