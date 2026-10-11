export const hostedMimoCodingGuestHome = "/home/coding";
export const hostedMimoCodingGuestCodexHome = "/home/coding/.codex";
export type HostedMimoCodingBootstrap = Readonly<{
  schemaVersion: 1;
  startId: string;
  specSha256: string;
  workspacePath: string;
  configToml: string;
}>;
export const hostedResearchSetupTimeoutMs = 300_000;
export type HostedMimoCodingExpectedBinding = Omit<HostedMimoCodingBootstrap, "configToml">;
export function decodeHostedMimoCodingExpectedBinding(encoded: string): HostedMimoCodingExpectedBinding {
  if (!/^[A-Za-z0-9_-]{1,8192}$/.test(encoded)) throw new Error("hosted_coding_expected_binding_invalid");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new Error("hosted_coding_expected_binding_invalid");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as HostedMimoCodingExpectedBinding;
  if (!value || Object.keys(value).sort().join(",") !== "schemaVersion,specSha256,startId,workspacePath" ||
      value.schemaVersion !== 1 || typeof value.startId !== "string" || typeof value.specSha256 !== "string" || !/^[a-f0-9-]{36}$/.test(value.startId) || !/^[a-f0-9]{64}$/.test(value.specSha256) ||
      typeof value.workspacePath !== "string" || !value.workspacePath.startsWith("/") || value.workspacePath.includes("\0")) throw new Error("hosted_coding_expected_binding_invalid");
  return Object.freeze(value);
}
export function assertHostedMimoCodingExpectedBinding(actual: HostedMimoCodingBootstrap, expected: HostedMimoCodingExpectedBinding): void {
  if (actual.schemaVersion !== expected.schemaVersion || actual.startId !== expected.startId || actual.specSha256 !== expected.specSha256 || actual.workspacePath !== expected.workspacePath) throw new Error("hosted_coding_expected_binding_mismatch");
}
