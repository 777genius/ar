/** Pure installed wire data; actual authority is authenticated by adapters. */
export type HostedInstallation = {
  readonly schemaVersion: 1; readonly installationId: string; readonly hostId: string;
  readonly runtimeDirectory: string; readonly runtimeSha: string;
  readonly runtimeManifestSha256: string; readonly inventorySha256: string;
};

function invalid(): never { throw new Error("hosted_activation_invalid"); }
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(value);
}
function path(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 &&
    /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) &&
    !value.split("/").some(part => part === "." || part === "..");
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function base(input: Record<string, unknown>): void {
  if (input.schemaVersion !== 1 || !id(input.installationId)) invalid();
}

export function parseHostedInstallation(value: unknown): HostedInstallation {
  const input = record(value, "schemaVersion,installationId,hostId,runtimeDirectory,runtimeSha,runtimeManifestSha256,inventorySha256");
  base(input);
  if (!id(input.hostId) || !path(input.runtimeDirectory) || typeof input.runtimeSha !== "string" ||
      !/^[a-f0-9]{40}$/.test(input.runtimeSha) || !digest(input.runtimeManifestSha256) || !digest(input.inventorySha256)) invalid();
  return Object.freeze({ ...input }) as HostedInstallation;
}
