import type { TerminalCheckpointClaimIdentity } from "./terminal-checkpoint-identity";

export enum TerminalCheckpointPayloadKind {
  File = "file",
  Sqlite = "sqlite",
}

export enum TerminalCheckpointDurablePhase {
  Reserved = "reserved",
  Payloads = "payloads",
  Manifest = "manifest",
  Committed = "committed",
}

export type TerminalCheckpointPayload = {
  readonly role: string;
  readonly kind: TerminalCheckpointPayloadKind;
  readonly sourceRelativePath: string;
  readonly storedPath: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type TerminalCheckpointSealManifest = {
  readonly schemaVersion: 1;
  readonly authority: "test_fixture_fenced";
  readonly checkpointId: string;
  readonly identity: TerminalCheckpointClaimIdentity;
  readonly fence: number;
  readonly capturedAt: string;
  readonly terminalAt: string;
  readonly retentionUntil: string;
  readonly registryRevisionSha256: string;
  readonly ownershipEvidence: {
    readonly kind: "fake_executor_complete";
    readonly executionGeneration: string;
    readonly providerLaunches: 0;
  };
  readonly previousCheckpointId?: string;
  readonly files: readonly TerminalCheckpointPayload[];
};
