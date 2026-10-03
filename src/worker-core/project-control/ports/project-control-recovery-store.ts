import type { ProjectControlRecoveryRecord, ProjectControlRecoveryAuditPhase, ProjectControlRecoveryDirectoryIdentity } from "../domain/project-control-recovery";

export interface ProjectControlRecoveryStore {
  records(): Promise<readonly ProjectControlRecoveryRecord[]>;
  save(record: ProjectControlRecoveryRecord): Promise<void>;
  audit(record: ProjectControlRecoveryRecord, phase: ProjectControlRecoveryAuditPhase): Promise<void>;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

/** Composition supplies the durable store; application policy never opens files. */
export type ProjectControlRecoveryStoreFactory = (input: {
  readonly parent: string;
  readonly taskId: string;
}) => Promise<ProjectControlRecoveryStore>;

export interface ProjectControlRecoveryDirectories {
  paths(input: {
    readonly ledgerRoots: readonly string[];
    readonly evidenceRoots: readonly string[];
    readonly anchor: string;
  }): readonly string[];
  identities(paths: readonly string[]): Promise<readonly ProjectControlRecoveryDirectoryIdentity[]>;
  revalidate(identities: readonly ProjectControlRecoveryDirectoryIdentity[]): Promise<void>;
}
