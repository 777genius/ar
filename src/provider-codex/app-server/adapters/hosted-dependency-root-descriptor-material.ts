import type { BigIntStats } from "node:fs";

/** Closed recipe/data types only. Actual open/recheck operations are PRIVATE
 * inside the sole current-origin issuer; no raw scope-DTO IO API is exported. */
export enum HostedDependencyRootDescriptorRecipe {
  DirectoryV1 = "directory_v1",
  AuthoredFileV1 = "authored_file_v1",
  GitIndexV1 = "git_index_v1",
  DurableFileV1 = "durable_file_v1",
  TaskEventsV1 = "task_events_v1",
}
export type HostedDependencyRootDescriptorAnchor = Readonly<{ fd: number; path: string; stat: BigIntStats; flags: number; mountId: string }>;
export type HostedDependencyRootDescriptorMaterial = {
  readonly fd: number; readonly path: string; readonly directory: boolean;
  readonly stat: BigIntStats; readonly flags: number; readonly mountId: string;
  readonly ancestors: readonly HostedDependencyRootDescriptorAnchor[]; readonly dependencies: readonly HostedDependencyRootDescriptorAnchor[]; closed: boolean;
};
