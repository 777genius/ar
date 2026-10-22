/** Closed signed member path/role DATA. No host lookup, writer or authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { FixedGnuMemberKind, FixedGnuMemberProfile, serializeFixedGnuMembers, type FixedGnuArchiveMembers, type FixedGnuMemberRow } from "./current-h1-archive-members-TEST.ts";
import { ciIndexOperationalBytes } from "./current-h1-tool-inputs-ci-index.ts";
import { ToolInputArchitecture } from "./current-h1-tool-inputs-package.ts";
export enum FixedH1Normalization {
    Root = "root-sentinel",
    Identity = "identity",
    DotPrefix = "strip-leading-dot",
    DirectorySlash = "strip-directory-slash",
    Both = "strip-leading-dot-and-directory-slash"
}
export enum FixedH1Role {
    PythonNsenter = "H1PythonNsenterToolrootDataV1"
}
export enum FixedH1AliasState {
    Resolved = "resolved-data",
    Missing = "held-missing-data"
}
export enum FixedH1Disposition {
    AwaitingPhysicalRecipe = "AwaitingPhysicalRecipe"
}
export enum FixedH1Hold {
    Shape = "shape",
    Origin = "origin",
    Path = "path",
    Conflict = "conflict",
    Parent = "parent",
    Alias = "alias",
    Selected = "selected",
    Budget = "budget",
    Deadline = "deadline"
}
export interface FixedH1Origin {
    readonly archiveSha256: string;
    readonly streamSha256: string;
    readonly row: Readonly<FixedGnuMemberRow>;
    readonly normalization: FixedH1Normalization;
}
export interface FixedH1GraphNode {
    readonly path: string;
    readonly kind: FixedGnuMemberKind;
    readonly origins: readonly FixedH1Origin[];
}
export interface FixedH1Alias {
    readonly path: string;
    readonly literalBytesBase64: string;
    readonly state: FixedH1AliasState;
    readonly chain: readonly string[];
    readonly target: string;
}
export interface FixedH1ArchiveRoleData {
    readonly schemaVersion: 1;
    readonly role: FixedH1Role;
    readonly packageVectorSha256: string;
    readonly archives: readonly Readonly<{
        package: FixedGnuArchiveMembers["package"];
        stream: FixedGnuArchiveMembers["stream"];
        rows: number;
        memberSha256: string;
        memberBytes: number;
    }>[];
    readonly roots: readonly FixedH1Origin[];
    readonly nodes: readonly FixedH1GraphNode[];
    readonly aliases: readonly FixedH1Alias[];
    readonly selected: readonly string[];
    readonly unselected: readonly string[];
    readonly disposition: FixedH1Disposition;
    readonly nativeQualified: false;
    readonly physicalRootCreated: false;
    readonly selectedPlanExecutable: false;
}
const fixedVector = "fd9c77fcc36f9862b268684d9aa28c9c8be8764439e3f8d4095cd9c5c557459e", sha = /^[a-f0-9]{64}$/, component = /^[A-Za-z0-9._+%:@=~-]+$/;
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest("hex"), emptySha = hash("");
function fact(value: unknown, why: FixedH1Hold): asserts value {
    assert(value, "fixed H1 graph DATA HOLD: " + why);
}
const tick = (deadline: number) => fact(Number.isFinite(deadline) && performance.now() < deadline, FixedH1Hold.Deadline);
const integer = (n: number, max: number) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function nonProxy(value: unknown): asserts value is object {
    fact(typeof value === "object" && value !== null && !isProxy(value), FixedH1Hold.Shape);
}
function plain(value: unknown, keys: string): void {
    nonProxy(value);
    fact(Object.getPrototypeOf(value) === Object.prototype && Object.isFrozen(value), FixedH1Hold.Shape);
    const expected = new Set(keys.split(","));
    const actual = Reflect.ownKeys(value);
    fact(actual.length === expected.size, FixedH1Hold.Shape);
    for (const key of actual) {
        fact(typeof key === "string" && expected.has(key), FixedH1Hold.Shape);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        fact(descriptor && "value" in descriptor && descriptor.enumerable === true, FixedH1Hold.Shape);
    }
}
function closedArray(value: unknown, maximum: number): void {
    nonProxy(value);
    fact(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Object.isFrozen(value), FixedH1Hold.Shape);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    fact(lengthDescriptor && "value" in lengthDescriptor && lengthDescriptor.enumerable === false, FixedH1Hold.Shape);
    const length: unknown = lengthDescriptor.value;
    fact(typeof length === "number" && integer(length, maximum), FixedH1Hold.Budget);
    const keys = Reflect.ownKeys(value);
    fact(keys.length === length + 1, FixedH1Hold.Shape);
    for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        fact(descriptor && "value" in descriptor && descriptor.enumerable === true, FixedH1Hold.Shape);
    }
}
function primitives(value: object, strings: string, numbers: string): void {
    for (const key of strings.split(",").filter(Boolean)) {
        fact(typeof Object.getOwnPropertyDescriptor(value, key)?.value === "string", FixedH1Hold.Shape);
    }
    for (const key of numbers.split(",").filter(Boolean)) {
        fact(typeof Object.getOwnPropertyDescriptor(value, key)?.value === "number", FixedH1Hold.Shape);
    }
}
/** No property reads, mapping, iteration or serialization before closed shapes. */
function validateArchiveShapes(archives: readonly FixedGnuArchiveMembers[], deadline: number): void {
    closedArray(archives, 41);
    fact(archives.length === 41, FixedH1Hold.Origin);
    let aggregate = 0;
    for (const archive of archives) {
        tick(deadline);
        plain(archive, "schemaVersion,profile,package,stream,rows,nativeQualified");
        plain(archive.package, "package,version,arch,sha256,size,filename");
        primitives(archive.package, "package,version,arch,sha256,filename", "size");
        plain(archive.stream, "sha256,bytes,archiveSha256,archiveBytes");
        primitives(archive.stream, "sha256,archiveSha256", "bytes,archiveBytes");
        primitives(archive, "profile", "schemaVersion");
        fact(typeof archive.nativeQualified === "boolean", FixedH1Hold.Shape);
        closedArray(archive.rows, 20000);
        aggregate += archive.rows.length;
        fact(aggregate <= 20000, FixedH1Hold.Budget);
        for (const row of archive.rows) {
            tick(deadline);
            plain(row, "ordinal,headerOffset,headerSha256,kind,nameBytesBase64,linkBytesBase64,mode,uid,gid,mtime,size,payloadOffset,payloadBytes,payloadSha256");
            primitives(row, "headerSha256,kind,nameBytesBase64,linkBytesBase64,payloadSha256", "ordinal,headerOffset,mode,uid,gid,mtime,size,payloadOffset,payloadBytes");
        }
    }
    tick(deadline);
}
function literal(base64: string): string {
    fact(typeof base64 === "string" && base64.length <= 5464, FixedH1Hold.Path);
    const b = Buffer.from(base64, "base64");
    fact(b.toString("base64") === base64 && b.length <= 4096 && b.every(x => x >= 32 && x < 127), FixedH1Hold.Path);
    return b.toString("ascii");
}
function normalize(row: FixedGnuMemberRow): Readonly<{
    path: string;
    operation: FixedH1Normalization;
}> {
    let name = literal(row.nameBytesBase64);
    const original = name;
    if (name.startsWith("./"))
        name = name.slice(2);
    if (name === "") {
        fact(original === "./" && row.kind === FixedGnuMemberKind.Directory, FixedH1Hold.Path);
        return { path: "", operation: FixedH1Normalization.Root };
    }
    if (name.endsWith("/")) {
        fact(row.kind === FixedGnuMemberKind.Directory, FixedH1Hold.Path);
        name = name.slice(0, -1);
    }
    const parts = name.split("/");
    fact(parts.length <= 2047 && parts.every(p => component.test(p) && p !== "." && p !== ".."), FixedH1Hold.Path);
    return { path: name, operation: original === name ? FixedH1Normalization.Identity : original.startsWith("./") ? original.endsWith("/") ? FixedH1Normalization.Both : FixedH1Normalization.DotPrefix : FixedH1Normalization.DirectorySlash };
}
function directory(row: FixedGnuMemberRow): void {
    fact(row.kind === FixedGnuMemberKind.Directory
        && row.mode === 0o755
        && row.uid === 0
        && row.gid === 0
        && row.size === 0
        && row.payloadBytes === 0
        && row.linkBytesBase64 === ""
        && row.payloadSha256 === emptySha, FixedH1Hold.Conflict);
}
const selectedPath = (p: string) => p === "usr/lib" || p.startsWith("usr/lib/") || p === "usr/lib64" || p.startsWith("usr/lib64/") || ["usr", "usr/bin", "usr/bin/python3.12", "usr/bin/nsenter", "etc", "etc/python3.12", "etc/python3.12/sitecustomize.py"].includes(p);
export function preflightFixedH1ArchiveRole(archives: readonly FixedGnuArchiveMembers[], packageVectorSha256: string, deadline: number): FixedH1ArchiveRoleData {
    tick(deadline);
    validateArchiveShapes(archives, deadline);
    fact(packageVectorSha256 === fixedVector, FixedH1Hold.Origin);
    const packages = archives.map(a => a.package).sort((a, b) => order(a.package, b.package));
    fact(hash(JSON.stringify(packages.map(({ package: name, version, arch, sha256, size }) => ({ package: name, version, arch, sha256, size })))) === fixedVector, FixedH1Hold.Origin);
    const index = new Map<string, {
        kind: FixedGnuMemberKind;
        origins: FixedH1Origin[];
    }>(), roots: FixedH1Origin[] = [], seen = new Set<string>();
    let headers = 0, streams = 0, payloads = 0;
    for (const archive of archives) {
        tick(deadline);
        plain(archive, "schemaVersion,profile,package,stream,rows,nativeQualified");
        plain(archive.package, "package,version,arch,sha256,size,filename");
        plain(archive.stream, "sha256,bytes,archiveSha256,archiveBytes");
        const p = archive.package, s = archive.stream;
        fact(archive.schemaVersion === 1
            && archive.profile === FixedGnuMemberProfile.Basic
            && archive.nativeQualified === false
            && Object.isFrozen(archive.rows)
            && archive.rows.length > 0, FixedH1Hold.Shape);
        fact(sha.test(p.sha256)
            && sha.test(s.sha256)
            && s.archiveSha256 === p.sha256
            && s.archiveBytes === p.size
            && integer(p.size, 32 * 1024 * 1024)
            && p.size > 0
            && integer(s.bytes, 128 * 1024 * 1024)
            && s.bytes >= 1024
            && s.bytes % 512 === 0
            && !seen.has(p.sha256), FixedH1Hold.Origin);
        seen.add(p.sha256);
        fact(/^[a-z0-9][a-z0-9+.-]*$/.test(p.package)
            && /^[A-Za-z0-9+.:~_-]+$/.test(p.version)
            && (p.arch === ToolInputArchitecture.Amd64 || p.arch === ToolInputArchitecture.All)
            && /^pool\/(?:[A-Za-z0-9_+.-]+\/)+[A-Za-z0-9_+.%~-]+\.deb$/.test(p.filename)
            && !p.filename.split("/").includes(".."), FixedH1Hold.Origin);
        streams += s.bytes;
        fact(streams <= 512 * 1024 * 1024, FixedH1Hold.Budget);
        let offset = 0;
        for (const [i, row] of archive.rows.entries()) {
            tick(deadline);
            plain(row, "ordinal,headerOffset,headerSha256,kind,nameBytesBase64,linkBytesBase64,mode,uid,gid,mtime,size,payloadOffset,payloadBytes,payloadSha256");
            fact(++headers <= 20000
                && row.ordinal === i + 1
                && row.headerOffset === offset
                && row.payloadOffset === offset + 512
                && sha.test(row.headerSha256)
                && sha.test(row.payloadSha256), FixedH1Hold.Origin);
            fact(Object.values(FixedGnuMemberKind).includes(row.kind)
                && integer(row.mtime, Number.MAX_SAFE_INTEGER)
                && integer(row.size, 32 * 1024 * 1024)
                && row.payloadBytes === row.size
                && row.uid === 0
                && row.gid === 0, FixedH1Hold.Shape);
            const link = literal(row.linkBytesBase64);
            fact(row.kind === FixedGnuMemberKind.Symlink ? link.length > 0 : link.length === 0, FixedH1Hold.Shape);
            fact(row.kind === FixedGnuMemberKind.Regular || (row.size === 0 && row.payloadSha256 === emptySha), FixedH1Hold.Shape);
            payloads += row.size;
            fact(payloads <= 512 * 1024 * 1024, FixedH1Hold.Budget);
            if (row.kind === FixedGnuMemberKind.Directory)
                directory(row);
            else if (row.kind === FixedGnuMemberKind.Symlink)
                fact(row.mode === 0o777, FixedH1Hold.Shape);
            else
                fact(row.mode === 0o644 || row.mode === 0o755 || (row.mode === 0o4755
                    && p.package === "util-linux"
                    && p.sha256 === "08eb17ba3b83378ed1e73d8335d0ce03b429c0bbeb07e374f536234edab02465"
                    && literal(row.nameBytesBase64) === "./usr/bin/su"), FixedH1Hold.Shape);
            offset += 512 + Math.ceil(row.size / 512) * 512;
            fact(offset + 1024 <= s.bytes, FixedH1Hold.Origin);
            const normalized = normalize(row), origin = Object.freeze({ archiveSha256: p.sha256, streamSha256: s.sha256, row, normalization: normalized.operation });
            if (normalized.path === "") {
                roots.push(origin);
                continue;
            }
            const previous = index.get(normalized.path);
            if (previous) {
                fact(previous.kind === FixedGnuMemberKind.Directory && row.kind === FixedGnuMemberKind.Directory, FixedH1Hold.Conflict);
                for (const o of previous.origins)
                    directory(o.row);
                previous.origins.push(origin);
            }
            else
                index.set(normalized.path, { kind: row.kind, origins: [origin] });
            fact(index.size <= 20000, FixedH1Hold.Budget);
        }
    }
    fact(seen.size === 41, FixedH1Hold.Origin);
    for (const path of index.keys()) {
        tick(deadline);
        const parts = path.split("/");
        parts.pop();
        while (parts.length) {
            fact(index.get(parts.join("/"))?.kind === FixedGnuMemberKind.Directory, FixedH1Hold.Parent);
            parts.pop();
        }
    }
    const aliases: FixedH1Alias[] = [];
    let aliasSteps = 0;
    for (const [path, node] of index) {
        if (node.kind !== FixedGnuMemberKind.Symlink)
            continue;
        tick(deadline);
        const first = node.origins[0];
        fact(first, FixedH1Hold.Origin);
        const chain: string[] = [], visited = new Set<string>();
        let current = path, target = "", missing = false;
        for (;;) {
            tick(deadline);
            fact(!visited.has(current) && chain.length < index.size, FixedH1Hold.Alias);
            fact(++aliasSteps <= 20000, FixedH1Hold.Budget);
            visited.add(current);
            chain.push(current);
            const origin = index.get(current)?.origins[0];
            fact(origin, FixedH1Hold.Alias);
            const link = literal(origin.row.linkBytesBase64), parts = link.startsWith("/") ? [] : current.split("/").slice(0, -1), tokens = (link.startsWith("/") ? link.slice(1) : link).split("/");
            fact(tokens.length <= 2047 && tokens.every(p => p.length > 0 && (p === "." || p === ".." || component.test(p))), FixedH1Hold.Alias);
            for (const [i, token] of tokens.entries()) {
                tick(deadline);
                if (token === ".")
                    continue;
                if (token === "..") {
                    fact(parts.length > 0, FixedH1Hold.Alias);
                    parts.pop();
                }
                else
                    parts.push(token);
                fact(parts.length <= 2047, FixedH1Hold.Budget);
                if (i < tokens.length - 1 && parts.length)
                    fact(index.get(parts.join("/"))?.kind === FixedGnuMemberKind.Directory, FixedH1Hold.Alias);
            }
            target = parts.join("/");
            fact(target.length > 0, FixedH1Hold.Alias);
            const end = index.get(target);
            if (!end) {
                missing = true;
                break;
            }
            if (end.kind !== FixedGnuMemberKind.Symlink)
                break;
            current = target;
        }
        aliases.push(Object.freeze({ path, literalBytesBase64: first.row.linkBytesBase64, state: missing ? FixedH1AliasState.Missing : FixedH1AliasState.Resolved, chain: Object.freeze(chain), target }));
    }
    const selected = [...index.keys()].filter(selectedPath).sort(order), unselected = [...index.keys()].filter(p => !selectedPath(p)).sort(order);
    const selectedSet = new Set(selected);
    for (const p of ["usr/bin/python3.12", "usr/bin/nsenter", "etc/python3.12/sitecustomize.py", "usr/lib/python3.12/sitecustomize.py", "usr/lib64/ld-linux-x86-64.so.2"]) {
        fact(selectedSet.has(p), FixedH1Hold.Selected);
    }
    const single = (path: string) => {
        const origin = index.get(path)?.origins[0];
        fact(origin, FixedH1Hold.Selected);
        return origin;
    };
    const packageName = (o: FixedH1Origin) => archives.find(a => a.package.sha256 === o.archiveSha256)?.package.package;
    fact(single("usr/bin/python3.12").row.kind === FixedGnuMemberKind.Regular
        && packageName(single("usr/bin/python3.12")) === "python3.12-minimal"
        && single("usr/bin/nsenter").row.kind === FixedGnuMemberKind.Regular
        && packageName(single("usr/bin/nsenter")) === "util-linux", FixedH1Hold.Selected);
    const site = single("usr/lib/python3.12/sitecustomize.py"), source = single("etc/python3.12/sitecustomize.py");
    fact(site.row.kind === FixedGnuMemberKind.Symlink
        && site.archiveSha256 === "d646ad7112b5adec21ba0e1af015f04ae8ca7f5efdc619622547dd6673c4c14b"
        && literal(site.row.linkBytesBase64) === "/etc/python3.12/sitecustomize.py"
        && source.archiveSha256 === site.archiveSha256
        && source.row.kind === FixedGnuMemberKind.Regular
        && source.row.mode === 0o644
        && source.row.size === 155
        && source.row.payloadSha256 === "43d81125d92376b1a69d53a71126a041cc9a18d8080e92dea0a2ae23be138b1e", FixedH1Hold.Selected);
    const loader = single("usr/lib64/ld-linux-x86-64.so.2"), loaderTarget = single("usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");
    fact(loader.row.kind === FixedGnuMemberKind.Symlink
        && literal(loader.row.linkBytesBase64) === "../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"
        && packageName(loader) === "libc6"
        && loaderTarget.archiveSha256 === loader.archiveSha256
        && loaderTarget.row.kind === FixedGnuMemberKind.Regular, FixedH1Hold.Selected);
    for (const alias of aliases) {
        if (!selectedSet.has(alias.path))
            continue;
        tick(deadline);
        fact(alias.state === FixedH1AliasState.Resolved && selectedSet.has(alias.target) && alias.chain.every(p => selectedSet.has(p)), FixedH1Hold.Selected);
        if (literal(alias.literalBytesBase64).startsWith("/"))
            fact(alias.path === "usr/lib/python3.12/sitecustomize.py", FixedH1Hold.Selected);
    }
    const nodes = [...index].sort(([a], [b]) => order(a, b)).map(([path, node]) => Object.freeze({ path, kind: node.kind, origins: Object.freeze(node.origins) }));
    tick(deadline);
    const result: FixedH1ArchiveRoleData = Object.freeze({
        schemaVersion: 1,
        role: FixedH1Role.PythonNsenter,
        packageVectorSha256,
        archives: Object.freeze(archives.map(a => {
            const body = serializeFixedGnuMembers(a, deadline);
            return Object.freeze({ package: a.package, stream: a.stream, rows: a.rows.length, memberSha256: body.sha256, memberBytes: body.bytes.length });
        })),
        roots: Object.freeze(roots),
        nodes: Object.freeze(nodes),
        aliases: Object.freeze(aliases.sort((a, b) => order(a.path, b.path))),
        selected: Object.freeze(selected),
        unselected: Object.freeze(unselected),
        disposition: FixedH1Disposition.AwaitingPhysicalRecipe,
        nativeQualified: false,
        physicalRootCreated: false,
        selectedPlanExecutable: false
    });
    tick(deadline);
    return result;
}
export function assertFixedH1GraphRecordBytes(bytes: number): void {
    fact(integer(bytes, ciIndexOperationalBytes), FixedH1Hold.Budget);
}
export function serializeFixedH1ArchiveRole(data: FixedH1ArchiveRoleData, archives: readonly FixedGnuArchiveMembers[], sourceSha: string, deadline: number): Readonly<{
    graph: Buffer;
    graphSha256: string;
    selection: Buffer;
    memberRecords: readonly Readonly<{
        archiveSha256: string;
        streamSha256: string;
        bytes: number;
        sha256: string;
        rows: number;
    }>[];
}> {
    tick(deadline);
    validateArchiveShapes(archives, deadline);
    fact(typeof sourceSha === "string" && /^[a-f0-9]{40}$/.test(sourceSha), FixedH1Hold.Origin);
    const commitments = archives.map((archive, i) => {
        const original = data.archives[i];
        fact(original
            && JSON.stringify(original.package) === JSON.stringify(archive.package)
            && JSON.stringify(original.stream) === JSON.stringify(archive.stream)
            && original.rows === archive.rows.length, FixedH1Hold.Origin);
        const serialized = serializeFixedGnuMembers(archive, deadline);
        fact(serialized.sha256 === original.memberSha256 && serialized.bytes.length === original.memberBytes, FixedH1Hold.Origin);
        return Object.freeze({ archiveSha256: archive.package.sha256, streamSha256: archive.stream.sha256, bytes: serialized.bytes.length, sha256: serialized.sha256, rows: archive.rows.length });
    });
    fact(commitments.length === 41, FixedH1Hold.Origin);
    const graphText = JSON.stringify({ sourceSha, memberRecords: commitments, ...data }) + "\n";
    tick(deadline);
    assertFixedH1GraphRecordBytes(Buffer.byteLength(graphText));
    const graph = Buffer.from(graphText), graphSha256 = hash(graph);
    tick(deadline);
    const selectionText = JSON.stringify({
        schemaVersion: 1,
        sourceSha,
        memberRecords: commitments,
        packageVectorSha256: data.packageVectorSha256,
        role: data.role,
        graph: { sha256: graphSha256, bytes: graph.length, nodes: data.nodes.length },
        selected: data.nodes.filter(n => data.selected.includes(n.path)),
        aliases: data.aliases.filter(a => data.selected.includes(a.path)),
        unselected: data.unselected,
        disposition: data.disposition,
        nativeQualified: false,
        physicalRootCreated: false,
        selectedPlanExecutable: false
    }) + "\n";
    tick(deadline);
    assertFixedH1GraphRecordBytes(Buffer.byteLength(selectionText));
    const selection = Buffer.from(selectionText);
    tick(deadline);
    return Object.freeze({ graph, graphSha256, selection, memberRecords: Object.freeze(commitments) });
}
