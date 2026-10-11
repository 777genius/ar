import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { OriginalProviderStorageContext } from "../application/app-server-process-port";

type Anchor = { readonly path: string; readonly dev: string; readonly ino: string; readonly mode: number };
export type OriginalProviderStorageWitness = {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly context: OriginalProviderStorageContext;
  readonly anchors: readonly Anchor[];
};
const invalid = (): never => { throw new Error("original_provider_storage_context_invalid"); };
const inside = (path: string, root: string) => path.startsWith(root + "/");
const canonical = (path: unknown): path is string => typeof path === "string" && path !== "/" && path === path.trim() && path.length <= 4096 &&
  /^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(path) &&
  !path.split("/").some(part => part === "." || part === "..");

export function decodeOriginalProviderStorageContext(value: unknown): OriginalProviderStorageContext {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "codexHome,home,workspace") invalid();
  const context = value as OriginalProviderStorageContext;
  if (![context.workspace, context.home, context.codexHome].every(canonical)) invalid();
  if (context.home === context.codexHome || context.workspace === context.home ||
      context.workspace === context.codexHome || inside(context.home, context.workspace) ||
      inside(context.codexHome, context.workspace) || inside(context.workspace, context.home) ||
      inside(context.workspace, context.codexHome)) invalid();
  // Original materializers retain private sibling home/codex-home leaves;
  // nested CODEX_HOME is also supported without changing either retained path.
  if (!inside(context.codexHome, context.home) && dirname(context.home) !== dirname(context.codexHome)) invalid();
  return { workspace: context.workspace, home: context.home, codexHome: context.codexHome };
}

function pathsFor(root: string, context: OriginalProviderStorageContext): string[] {
  if (!canonical(root) || !Object.values(context).every(path => inside(path, root))) invalid();
  const paths = new Set<string>();
  for (const leaf of [root, ...Object.values(context)]) {
    for (let path = leaf;; path = dirname(path)) { paths.add(path); if (path === "/") break; }
  }
  if (paths.size > 128) invalid();
  return [...paths].sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
}

function assertOriginalMounts(root: string, context: OriginalProviderStorageContext): void {
  const text = readFileSync("/proc/self/mountinfo", "utf8");
  if (!text || Buffer.byteLength(text) > 4 * 1024 * 1024) invalid();
  for (const line of text.trimEnd().split("\n")) {
    const fields = line.split(" "), separator = fields.indexOf("-");
    if (separator < 6) invalid();
    const path = fields[4]!.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (path === root && fields[3] !== "/") invalid();
    if (!inside(path, root)) continue;
    // A pathname alias or nested mount must never select a writable role.
    if (Object.values(context).some(leaf => leaf === path || inside(leaf, path))) invalid();
  }
}

function openAnchors(root: string, context: OriginalProviderStorageContext, privileged: boolean): {
  anchors: Anchor[]; descriptors: number[];
} {
  const descriptors: number[] = [], anchors: Anchor[] = [];
  const rootDevice = lstatSync(root, { bigint: true }).dev;
  if (rootDevice === lstatSync("/", { bigint: true }).dev) invalid();
  try {
    for (const path of pathsFor(root, context)) {
      const named = lstatSync(path, { bigint: true });
      if (!named.isDirectory() || named.isSymbolicLink() || realpathSync(path) !== path ||
          named.uid !== (privileged ? 0n : 65532n) || (named.mode & 0o022n) ||
          ((path === root || inside(path, root)) && named.dev !== rootDevice)) invalid();
      if ((path === context.home || path === context.codexHome ||
          (path === dirname(context.home) && !inside(context.codexHome, context.home))) &&
          (named.mode & 0o777n) !== 0o700n) invalid();
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptors.push(fd);
      const opened = fstatSync(fd, { bigint: true });
      if (opened.dev !== named.dev || opened.ino !== named.ino || opened.mode !== named.mode) invalid();
      anchors.push({ path, dev: named.dev.toString(), ino: named.ino.toString(), mode: Number(named.mode) });
    }
    return { anchors, descriptors };
  } catch (error) { for (const fd of descriptors) closeSync(fd); throw error; }
}

/** Root launcher owns these descriptors until the exact service is submitted. */
export function captureOriginalProviderStorage(root: string, value: unknown): {
  witness: OriginalProviderStorageWitness; revalidate(): void; close(): void;
} {
  if (process.getuid?.() !== 0) invalid();
  const context = decodeOriginalProviderStorageContext(value);
  assertOriginalMounts(root, context);
  const { anchors, descriptors } = openAnchors(root, context, true);
  const witness: OriginalProviderStorageWitness = { schemaVersion: 1, root, context, anchors };
  let closed = false;
  const revalidate = () => {
    if (closed) invalid();
    assertOriginalMounts(root, context);
    for (const [index, anchor] of anchors.entries()) {
      const opened = fstatSync(descriptors[index]!, { bigint: true }), named = lstatSync(anchor.path, { bigint: true });
      if (named.isSymbolicLink() || named.dev.toString() !== anchor.dev || named.ino.toString() !== anchor.ino ||
          opened.dev !== named.dev || opened.ino !== named.ino || Number(named.mode) !== anchor.mode || named.uid !== 0n) invalid();
    }
  };
  const close = () => { if (!closed) { closed = true; for (const fd of descriptors) closeSync(fd); } };
  try { revalidate(); return { witness, revalidate, close }; } catch (error) { close(); throw error; }
}

export function assertOriginalProviderStorageFrame(raw: string, frame: {
  readonly cwd: string; readonly env: Readonly<Record<string, string>>;
}): void {
  if (raw.length > 131072) invalid();
  const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as OriginalProviderStorageWitness;
  if (!value || Object.keys(value).sort().join(",") !== "anchors,context,root,schemaVersion" || value.schemaVersion !== 1) invalid();
  const context = decodeOriginalProviderStorageContext(value.context), paths = pathsFor(value.root, context);
  if (!Array.isArray(value.anchors) || value.anchors.length !== paths.length ||
      value.anchors.some((anchor, index) => !anchor || Object.keys(anchor).sort().join(",") !== "dev,ino,mode,path" ||
        anchor.path !== paths[index] || !/^[0-9]+$/.test(anchor.dev) || !/^[1-9][0-9]*$/.test(anchor.ino) || !Number.isSafeInteger(anchor.mode))) invalid();
  if (frame.env.HOME !== context.home || frame.env.CODEX_HOME !== context.codexHome ||
      (frame.cwd !== context.home && frame.cwd !== context.workspace) ||
      process.env.SUBSCRIPTION_RUNTIME_MANAGED_LAUNCH !== "1" ||
      !process.env.SUBSCRIPTION_RUNTIME_JOB_ROOT?.startsWith(value.root + "/jobs/")) invalid();
  if (process.getuid?.() !== 65532 ||
      ["uid_map", "gid_map"].some(name => readFileSync(`/proc/self/${name}`, "utf8").trim().split(/\s+/).join(" ") !== "65532 0 1")) invalid();
  const opened = openAnchors(value.root, context, false);
  try { if (JSON.stringify(opened.anchors) !== JSON.stringify(value.anchors)) invalid(); }
  finally { for (const fd of opened.descriptors) closeSync(fd); }
}
