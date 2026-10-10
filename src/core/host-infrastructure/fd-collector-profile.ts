export const fdCollectorProfilePath = "/var/lib/subscription-runtime-host-policy/fd-collector-profile.v1.json" as const;
export enum FdCollectorRenderer { SsV61Signed = "ss-v6.1-int32" }
export enum FdCollectorPeerStatus { Known = "known", Unresolved = "unresolved" }
export type FdCollectorPeer =
  | Readonly<{ status: FdCollectorPeerStatus.Known; inode: string }>
  | Readonly<{ status: FdCollectorPeerStatus.Unresolved }>;
export type FdCollectorProfilePin = Readonly<{ path: typeof fdCollectorProfilePath; sha256: string }>;
export type FdFilePin = Readonly<{ path: string; sha256: string }>;
export type FdExecutablePin = FdFilePin & Readonly<{ elfFiles: readonly FdFilePin[] }>;
export type FdCollectorProfile = Readonly<{
  schemaVersion: 1; renderer: FdCollectorRenderer;
  ss: FdExecutablePin; node: FdExecutablePin;
  wrappers: readonly FdExecutablePin[]; bootstraps: readonly FdFilePin[];
  limits: Readonly<{ setupTimeoutMs: number; collectorTimeoutMs: number; maxOutputBytes: number; maxRows: number;
    maxBufferedInputBytes: number; maxEventPoll: number; maxEventFd: number; maxPipeEndpoints: number; maxDevNullReserves: number }>;
}>;

function invalid(): never { throw new Error("hosted_fd_profile_invalid"); }
function object(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(",").sort().join(",")) invalid();
  return value as Record<string, unknown>;
}
function file(value: unknown): FdFilePin {
  const row = object(value, "path,sha256");
  if (typeof row.path !== "string" || row.path.length > 4096 ||
      !/^\/(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+$/.test(row.path) ||
      row.path.split("/").some(part => part === "." || part === "..") ||
      typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) invalid();
  return Object.freeze({ path: row.path, sha256: row.sha256 });
}
function executable(value: unknown): FdExecutablePin {
  const row = object(value, "path,sha256,elfFiles"), pin = file({ path: row.path, sha256: row.sha256 });
  if (!Array.isArray(row.elfFiles) || row.elfFiles.length < 2 || row.elfFiles.length > 64) invalid();
  const elfFiles = row.elfFiles.map(file);
  if (new Set(elfFiles.map(pin => pin.path)).size !== elfFiles.length ||
      !elfFiles.some(entry => entry.path === pin.path && entry.sha256 === pin.sha256)) invalid();
  return Object.freeze({ ...pin, elfFiles: Object.freeze(elfFiles) });
}

/** Revision4 binds this fixed input through the independently authenticated
 * inventory digest. Old revisions reject the field rather than accepting a
 * mutable sidecar as a new source of authority. */
export function readFdCollectorProfileField(value: Record<string, unknown>): FdCollectorProfilePin | undefined {
  if (value.schemaVersion !== 4 && value.schemaVersion !== 5) {
    if (![1, 2, 3].includes(value.schemaVersion as number) || "collectorProfile" in value) invalid();
    return undefined;
  }
  const pin = file(value.collectorProfile);
  if (pin.path !== fdCollectorProfilePath) invalid();
  return Object.freeze({ path: fdCollectorProfilePath, sha256: pin.sha256 });
}

/** Closed profile data. Only the trusted native issuer qualifies the selected
 * binary/renderer and bounds; this parser does not issue that qualification. */
export function parseFdCollectorProfile(value: unknown): FdCollectorProfile {
  const row = object(value, "schemaVersion,renderer,ss,node,wrappers,bootstraps,limits");
  if (row.schemaVersion !== 1 || row.renderer !== FdCollectorRenderer.SsV61Signed) invalid();
  const ss = executable(row.ss), node = executable(row.node);
  if (ss.path !== "/usr/bin/ss") invalid();
  if (!Array.isArray(row.wrappers) || row.wrappers.length !== 4) invalid();
  const wrappers = row.wrappers.map(executable);
  if (wrappers.map(pin => pin.path).sort().join(",") !==
      "/usr/bin/setpriv,/usr/bin/systemd-run,/usr/bin/tini,/usr/bin/unshare") invalid();
  if (!Array.isArray(row.bootstraps) || row.bootstraps.length < 4 || row.bootstraps.length > 12) invalid();
  const bootstraps = row.bootstraps.map(file);
  const names = bootstraps.map(pin => pin.path.slice(pin.path.lastIndexOf("/") + 1));
  const required = ["hosted-app-server-launcher.js", "hosted-dependency-installer-bootstrap.js",
    "hosted-readonly-host-launch-cli.js", "hosted-readonly-runtime-bootstrap.js"];
  if (new Set(bootstraps.map(pin => pin.path)).size !== bootstraps.length ||
      required.some(name => names.filter(candidate => candidate === name).length !== 1)) invalid();
  const limits = { ...object(row.limits, "setupTimeoutMs,collectorTimeoutMs,maxOutputBytes,maxRows,maxBufferedInputBytes,maxEventPoll,maxEventFd,maxPipeEndpoints,maxDevNullReserves") };
  const maxima = { setupTimeoutMs: 60_000, collectorTimeoutMs: 5_000, maxOutputBytes: 4 * 1024 * 1024,
    maxRows: 65_536, maxBufferedInputBytes: 4 * 1024 * 1024, maxEventPoll: 8, maxEventFd: 8,
    maxPipeEndpoints: 32, maxDevNullReserves: 8 };
  for (const [key, max] of Object.entries(maxima)) {
    const n = limits[key];
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > max) invalid();
  }
  if ((limits.collectorTimeoutMs as number) > (limits.setupTimeoutMs as number)) invalid();
  return Object.freeze({ schemaVersion: 1, renderer: FdCollectorRenderer.SsV61Signed, ss, node,
    wrappers: Object.freeze(wrappers), bootstraps: Object.freeze(bootstraps),
    limits: Object.freeze(limits) as FdCollectorProfile["limits"] });
}

/** The pinned v6.1 renderer prints uint32 kernel inodes through signed int.
 * Names cannot enter these rows: the fixed collector filters before rendering.
 * Peer0 loses absent/orphan/fallback provenance; retain it without peer authority. */
export function parseFdCollectorRows(text: string, maxRows: number): ReadonlyMap<string, FdCollectorPeer> {
  if (!/^[\x09\x0a\x20-\x7e]*$/.test(text)) invalid();
  const lines = text.trim() ? text.trim().split("\n") : [];
  if (lines.length > maxRows) invalid();
  const inode = (s: string): string => {
    if (!/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(s)) invalid();
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) invalid();
    return String(n < 0 ? n + 4294967296 : n);
  };
  const rows = new Map<string, FdCollectorPeer>();
  for (const line of lines) {
    const columns = line.trim().split(/[\t ]+/);
    if (columns.length !== 6 || columns[2] !== "*" || columns[4] !== "*" ||
        !columns.slice(0, 2).every(s => /^(?:0|[1-9][0-9]{0,9})$/.test(s) && Number(s) <= 4294967295)) invalid();
    const local = inode(columns[3]!), peer = inode(columns[5]!);
    if (local === "0" || rows.has(local)) invalid();
    const fact: FdCollectorPeer = peer === "0" ?
      { status: FdCollectorPeerStatus.Unresolved } : { status: FdCollectorPeerStatus.Known, inode: peer };
    rows.set(local, Object.freeze(fact));
  }
  return rows;
}

/** A positive rendered inode is a fact, not ownership or a release permit. */
export function knownFdCollectorPeer(rows: ReadonlyMap<string, FdCollectorPeer>, local: string): string | undefined {
  const peer = rows.get(local);
  return peer?.status === FdCollectorPeerStatus.Known ? peer.inode : undefined;
}
