import { parseChildLifetime, type ChildLifetime } from "./child-lifetime";

/** Source checkout identity and built artifact identity are distinct claims. */
export type ImmutableChildSlot = {
  readonly schemaVersion: 1;
  readonly slotId: string;
  readonly creatorId: string;
  readonly jobId: string;
  readonly jobRootDir: string;
  readonly workspacePath: string;
  readonly promptPath: string;
  readonly sourceSha: string;
  readonly artifactSha: string;
  readonly grantSha256: string;
  readonly launch: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
  readonly lifetime: ChildLifetime;
};
export function parseImmutableChildSlot(value: unknown): ImmutableChildSlot {
  const v = object(value, "artifactSha,creatorId,grantSha256,jobId,jobRootDir,launch,lifetime,promptPath,schemaVersion,slotId,sourceSha,workspacePath");
  if (v.schemaVersion !== 1 || !id(v.slotId) || !id(v.creatorId) || !id(v.jobId) ||
      !path(v.jobRootDir) || !path(v.workspacePath) || !path(v.promptPath) ||
      v.workspacePath !== `${v.jobRootDir}/workspace` || !v.jobRootDir.endsWith(`/jobs/${v.jobId}`) ||
      !sha(v.sourceSha, 40) || !sha(v.artifactSha, 40) || !sha(v.grantSha256, 64)) invalid();
  // Prompt authority cannot be inside an ancestor writable by the child.
  if (v.promptPath === v.jobRootDir || v.promptPath.startsWith(v.jobRootDir + "/") || v.promptPath === v.workspacePath || v.promptPath.startsWith(v.workspacePath + "/")) invalid();
  const launch = object(v.launch, "args,command,cwd");
  if (!path(launch.command) || !path(launch.cwd) || !Array.isArray(launch.args) || launch.args.length > 256 ||
      launch.args.some(arg => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) ||
      launch.args.reduce((n: number, arg: string) => n + arg.length, 0) > 32768) invalid();
  return Object.freeze({ ...v, lifetime: parseChildLifetime(v.lifetime),
    launch: Object.freeze({ ...launch, args: Object.freeze([...launch.args]) }) }) as ImmutableChildSlot;
}
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,255}$/.test(value); }
function sha(value: unknown, length: number): boolean { return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value); }
function path(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(value) &&
    !value.split("/").some(part => part === "." || part === "..");
}
function invalid(): never { throw new Error("immutable_child_slot_invalid"); }
