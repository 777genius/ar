import { sameDependencyTree, sameDependencyWorkspace, type DependencyTreeIdentity, type DependencyWorkspaceIdentity } from "./dependency-workspace";

export enum DependencyToolReadyReadStatus { Unknown = "unknown", Ready = "ready" }
export enum DependencyToolReadyProvenanceKind { RegistryCompleted = "registry_completed", LocalCompleted = "local_completed" }
export type DependencyToolSourceRoot = Readonly<{ canonicalPath: string; identity: DependencyTreeIdentity }>;
export type DependencyToolReadyIdentity = Readonly<{
  workspace: DependencyWorkspaceIdentity; coverageRevision: string; revision: number;
  installKey: string; tree: DependencyTreeIdentity; manifestDigest: string;
}>;
export type DependencyToolReadyFacts = DependencyToolReadyIdentity & Readonly<{
  provenance:
    | Readonly<{ kind: DependencyToolReadyProvenanceKind.RegistryCompleted }>
    | Readonly<{ kind: DependencyToolReadyProvenanceKind.LocalCompleted;
        sourceBinding: Readonly<{ path: string; identity: DependencyTreeIdentity; sha256: string }>;
        readonlySources: readonly DependencyToolSourceRoot[] }>;
}>;
export type DependencyToolReadyRead =
  | Readonly<{ status: DependencyToolReadyReadStatus.Unknown }>
  | Readonly<{ status: DependencyToolReadyReadStatus.Ready; facts: DependencyToolReadyFacts }>;

/** Fresh facts from the trusted composition's established history reader.
 * Neither a serialized result nor this interface is an admission permit. */
export interface DependencyToolReadyReader { readCurrent(): DependencyToolReadyRead }

/** Closed registry join. Local provenance needs its own authenticated consumer
 * profile; declaring it above does not enable it for this profile. */
export function matchesRegistryDependencyToolReady(expected: DependencyToolReadyIdentity, facts: DependencyToolReadyFacts): boolean {
  return facts.provenance.kind === DependencyToolReadyProvenanceKind.RegistryCompleted &&
    sameDependencyWorkspace(expected.workspace, facts.workspace) && expected.coverageRevision === facts.coverageRevision &&
    expected.revision === facts.revision && expected.installKey === facts.installKey &&
    sameDependencyTree(expected.tree, facts.tree) && expected.manifestDigest === facts.manifestDigest;
}
