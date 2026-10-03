/** Trusted adapter input, never a job/launch option or proof of admission. */
export type HostedReadonlyMounts = {
  readonly jobId: string;
  readonly workspacePath: string;
  readonly readonlyPaths: readonly string[];
};

export function hostedReadonlyMountProperties(input: HostedReadonlyMounts): readonly string[] {
  const { workspacePath, readonlyPaths } = input;
  const validPath = (path: unknown): path is string => typeof path === "string" &&
    path.length <= 4096 && /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) &&
    !path.split("/").some(part => part === "." || part === "..");
  if (!validPath(workspacePath) || !Array.isArray(readonlyPaths) ||
      readonlyPaths.length === 0 || readonlyPaths.length > 64) invalid();
  const anchors = new Set<string>();
  for (const root of readonlyPaths) {
    if (!validPath(root) || !root.startsWith(workspacePath + "/") ||
        readonlyPaths.some(other => other !== root && root.startsWith(other + "/"))) invalid();
    for (let parent = root.slice(0, root.lastIndexOf("/"));;
      parent = parent.slice(0, parent.lastIndexOf("/"))) {
      anchors.add(parent);
      if (parent === workspacePath) break;
    }
  }
  if (new Set(readonlyPaths).size !== readonlyPaths.length) invalid();
  return Object.freeze([
    "PrivateMounts=yes",
    // Explicit nonrecursive anchors retain writable contents without importing
    // writable submounts over separately sealed children. Admission rejects them.
    `BindPaths=${[...anchors].sort().map(path => `${path}:${path}:norbind`).join(" ")}`,
    `BindReadOnlyPaths=${readonlyPaths.map(path => `${path}:${path}:norbind`).join(" ")}`,
  ]);
}

function invalid(): never { throw new Error("hosted_readonly_mounts_invalid"); }
