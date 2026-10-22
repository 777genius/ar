import { createHash } from "node:crypto";
import { types } from "node:util";

export type DecimalUint64 = string;
export type HexSha256 = string;

export type CapturedBody = Readonly<{
  base64: string;
  sha256: HexSha256;
  extent: DecimalUint64;
}>;

export type Body = Readonly<{ bytes: Uint8Array; sha256: HexSha256 }>;

export type SourcePosition = Readonly<{
  sourceSha256: HexSha256;
  coordinate: string;
}>;

export type SourceManifestRow = Readonly<{
  path: string;
  body: CapturedBody;
  beforeSha256: HexSha256;
  afterSha256: HexSha256;
}>;

export type Ownership = "owned" | "borrowed" | "alias";
export type LifetimeState = "closed" | "state-dependent";

export type ActivationRule = Readonly<{
  id: string;
  constructorName: string;
  objectId: string;
  location: string;
  source: SourcePosition;
  ownership: Ownership;
  aliasOf?: string;
  lifetime: Readonly<{
    begin: SourcePosition;
    end: SourcePosition;
    state: LifetimeState;
  }>;
  maximumLive: DecimalUint64;
  proofDependencies: readonly string[];
  scope: "root" | "phase";
  phase?: 0 | 1 | 2 | 3 | 4;
}>;

export type SourceLedger = Readonly<{
  schemaVersion: 1;
  sourceProjectionSha256: HexSha256;
  manifest: readonly SourceManifestRow[];
  rules: readonly ActivationRule[];
}>;

export type CapturedBodyDecodeResult =
  | Readonly<{ ok: true; value: Body }>
  | Readonly<{ ok: false; reason: "missing" | "malformed"; error: string }>;

export type LedgerDecodeResult =
  | Readonly<{ ok: true; value: SourceLedger }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_UINT64 = /^(0|[1-9][0-9]*)$/;
const PATH = /^[A-Za-z0-9_.\/-]+$/;
const COORDINATE = /^[A-Za-z0-9_./-]+:[1-9][0-9]*:[A-Za-z0-9_]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const MAX_DECIMAL_UINT64_CHARS = 20;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BASE64_CHARS = 4 * Math.ceil(MAX_BODY_BYTES / 3);
const MAX_RULES = 8192;
const MAX_MANIFEST_ROWS = 8192;
const MAX_MANIFEST_BODY_BYTES = 64 * 1024 * 1024;
const MAX_PROOF_DEPENDENCIES_PER_RULE = 256;
const MAX_TOTAL_PROOF_DEPENDENCIES = 65536;
/* Room for current Source paths, symbols and compiler coordinates, with a
 * finite aggregate before regex/split/maps or identifier diagnostics. */
const MAX_PATH_CHARS = 4096;
const MAX_COORDINATE_CHARS = 8192;
const MAX_RULE_IDENTIFIER_CHARS = 1024;
const MAX_LOCATION_CHARS = 8192;
const MAX_LEDGER_TEXT_CHARS = 64 * 1024 * 1024;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/* Only known data fields are captured; no caller getter, array iterator or
 * proxy trap is used. Unknown extra fields are never traversed or copied. */
const RECORD_FIELDS = [
  "schemaVersion", "sourceProjectionSha256", "manifest", "rules",
  "base64", "sha256", "extent", "path", "body", "beforeSha256", "afterSha256",
  "id", "constructorName", "objectId", "location", "source", "ownership", "aliasOf",
  "lifetime", "maximumLive", "proofDependencies", "scope", "phase",
  "sourceSha256", "coordinate", "begin", "end", "state",
] as const;
const isProxy = types.isProxy;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "length")!.get!;
const typedArraySet = Uint8Array.prototype.set;

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || isProxy(value) || Array.isArray(value))
    return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of RECORD_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor) {
      if (!("value" in descriptor)) return undefined;
      snapshot[field] = descriptor.value;
    }
  }
  return snapshot;
};
const dataArray = (value: unknown, maximum: number): readonly unknown[] | undefined => {
  if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value))
    return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum)
    return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item || !("value" in item)) return undefined;
    snapshot.push(item.value);
  }
  return Object.freeze(snapshot);
};

const validHash = (value: unknown): value is HexSha256 =>
  typeof value === "string" && value.length === 64 && HEX_SHA256.test(value);

const validPath = (value: unknown): value is string =>
  boundedText(value, MAX_PATH_CHARS) && PATH.test(value) && !value.startsWith("/") &&
  value.split("/").every(part => part !== "" && part !== "." && part !== "..");

const validCoordinate = (value: unknown): value is string =>
  boundedText(value, MAX_COORDINATE_CHARS) && COORDINATE.test(value);

const validDecimal = (value: unknown): value is DecimalUint64 =>
  typeof value === "string" && value.length <= MAX_DECIMAL_UINT64_CHARS &&
  DECIMAL_UINT64.test(value) && BigInt(value) <= UINT64_MAX;

const detachedPosition = (
  value: Record<string, unknown>,
  projection: HexSha256,
): SourcePosition | undefined => {
  if (!validHash(value.sourceSha256) || value.sourceSha256 !== projection ||
    !validCoordinate(value.coordinate))
    return undefined;
  return Object.freeze({
    sourceSha256: value.sourceSha256,
    coordinate: value.coordinate,
  });
};

type CapturedBodyPreflight =
  | Readonly<{ ok: true; value: CapturedBody; decodedBytes: number }>
  | Readonly<{ ok: false; reason: "missing" | "malformed"; error: string }>;

/* Canonical shape, pad bits and the actual length are checked without decoding
 * or allocating bytes. Both the public decoder and manifest prepass use this. */
function preflightCapturedBody(value: unknown): CapturedBodyPreflight {
  const row = record(value);
  if (!row) return { ok: false, reason: "missing", error: "captured body record is missing" };
  for (const field of ["base64", "sha256", "extent"] as const)
    if (!(field in row)) return { ok: false, reason: "missing", error: `captured body ${field} is missing` };
  const encoded = row.base64, expected = row.sha256, extent = row.extent;
  if (typeof encoded !== "string" || encoded.length > MAX_BODY_BASE64_CHARS)
    return { ok: false, reason: "malformed", error: "captured body base64 length exceeds the supported extent" };
  if (encoded.length % 4 !== 0)
    return { ok: false, reason: "malformed", error: "captured body encoding is invalid" };
  if (!validHash(expected))
    return { ok: false, reason: "malformed", error: "captured body hash is invalid" };
  if (!validDecimal(extent))
    return { ok: false, reason: "malformed", error: "captured body extent is invalid" };
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedBytes = encoded.length / 4 * 3 - padding;
  if (decodedBytes < 0 || decodedBytes > MAX_BODY_BYTES || BigInt(extent) > BigInt(MAX_BODY_BYTES))
    return { ok: false, reason: "malformed", error: "captured body extent exceeds the supported maximum" };
  if (BigInt(extent) !== BigInt(decodedBytes))
    return { ok: false, reason: "malformed", error: "captured body extent does not match encoded bytes" };
  if (!BASE64.test(encoded))
    return { ok: false, reason: "malformed", error: "captured body encoding is invalid" };
  if (padding) {
    const last = BASE64_ALPHABET.indexOf(encoded.charAt(encoded.length - padding - 1));
    if (last < 0 || (last & (padding === 2 ? 15 : 3)))
      return { ok: false, reason: "malformed", error: "captured body is not canonical base64" };
  }
  return { ok: true, value: Object.freeze({ base64: encoded, sha256: expected, extent }), decodedBytes };
}

export function decodeCapturedBody(value: unknown): CapturedBodyDecodeResult {
  const checked = preflightCapturedBody(value);
  if (!checked.ok) return checked;
  const bytes = Buffer.from(checked.value.base64, "base64");
  if (bytes.length !== checked.decodedBytes)
    return { ok: false, reason: "malformed", error: "captured body decoded extent is invalid" };
  const digest = sha256(bytes);
  if (digest !== checked.value.sha256)
    return { ok: false, reason: "malformed", error: "captured body SHA256 does not match decoded bytes" };
  /* Keep the verified storage private. Each caller gets a detached bounded
   * copy, including through .buffer; mutation cannot alter the checked pin. */
  return {
    ok: true,
    value: Object.freeze({ get bytes(): Uint8Array { return Uint8Array.from(bytes); }, sha256: digest }),
  };
}

export function encodeBody(body: Body): CapturedBody {
  if (typeof body !== "object" || body === null)
    throw new Error("captured body encoding requires a checked Body");
  const expected = body.sha256, bytes = body.bytes;
  if (!validHash(expected) || isProxy(bytes) || !(bytes instanceof Uint8Array))
    throw new Error("captured body encoding requires bytes and a valid SHA256");
  let length: unknown, elements: unknown;
  try {
    length = Reflect.apply(typedArrayByteLength, bytes, []);
    elements = Reflect.apply(typedArrayLength, bytes, []);
  } catch {
    throw new Error("captured body encoding requires a genuine byte view");
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
    length > MAX_BODY_BYTES || elements !== length)
    throw new Error("captured body encoding exceeds the supported byte view extent");
  /* set copies typed-array elements without invoking a caller iterator. Hash
   * this one bounded snapshot and refuse drift instead of re-pinning it. */
  const snapshot = Buffer.alloc(length);
  Reflect.apply(typedArraySet, snapshot, [bytes]);
  const digest = sha256(snapshot);
  if (digest !== expected)
    throw new Error("captured body encoding SHA256 does not match copied bytes");
  return Object.freeze({
    base64: snapshot.toString("base64"),
    sha256: digest,
    extent: String(snapshot.length),
  });
}

export function decodeSourceLedger(value: unknown): LedgerDecodeResult {
  const errors: string[] = [];
  const root = record(value);
  if (!root) return { ok: false, errors: Object.freeze(["ledger record is missing"]) };
  if (root.schemaVersion !== 1) errors.push("ledger schemaVersion must be 1");
  if (!validHash(root.sourceProjectionSha256)) errors.push("ledger sourceProjectionSha256 is invalid");
  const projection = validHash(root.sourceProjectionSha256) ? root.sourceProjectionSha256 : "";
  const manifest = dataArray(root.manifest, MAX_MANIFEST_ROWS);
  const rules = dataArray(root.rules, MAX_RULES);
  if (!manifest) errors.push("ledger manifest must be a bounded data array");
  if (!rules) errors.push("ledger rules must be a bounded data array");

  if (!manifest || !rules) {
    return { ok: false, errors: Object.freeze(errors) };
  }
  if (rules.length > MAX_RULES) {
    errors.push(`ledger rules exceed ${MAX_RULES} before traversal`);
    return { ok: false, errors: Object.freeze(errors) };
  }
  if (manifest.length > MAX_MANIFEST_ROWS) {
    errors.push(`ledger manifest exceeds ${MAX_MANIFEST_ROWS} rows`);
    return { ok: false, errors: Object.freeze(errors) };
  }

  let actualBodyBytes = 0;
  let declaredDependencyCount = 0;
  let textChars = 0;
  const capturedBodies: CapturedBody[] = [];
  const manifestSnapshots: Readonly<Record<string, unknown>>[] = [];
  const ruleSnapshots: Readonly<Record<string, unknown>>[] = [];
  const admitText = (value: unknown, maximum: number, path: string): boolean => {
    if (!boundedText(value, maximum)) {
      errors.push(`${path} is missing or exceeds its supported text extent`);
      return false;
    }
    if (value.length > MAX_LEDGER_TEXT_CHARS - textChars) {
      errors.push("ledger text total exceeds the supported extent");
      return false;
    }
    textChars += value.length;
    return true;
  };
  const admitPositionText = (value: unknown, path: string): boolean => {
    const position = record(value);
    if (!position || !validHash(position.sourceSha256)) {
      errors.push(`${path} has an invalid Source position`);
      return false;
    }
    return admitText(position.coordinate, MAX_COORDINATE_CHARS, `${path}.coordinate`);
  };
  for (let index = 0; index < manifest.length; index += 1) {
    const row = record(manifest[index]);
    if (!row || !admitText(row.path, MAX_PATH_CHARS, `manifest[${index}].path`)) {
      if (!row) errors.push(`manifest[${index}] is not an object`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    const body = preflightCapturedBody(row.body);
    if (!body.ok) {
      errors.push(`manifest[${index}].body ${body.error}`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    if (body.decodedBytes > MAX_MANIFEST_BODY_BYTES - actualBodyBytes) {
      errors.push(`ledger manifest body total exceeds ${MAX_MANIFEST_BODY_BYTES} bytes`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    actualBodyBytes += body.decodedBytes;
    capturedBodies.push(body.value); // immutable strings from this exact preflight
    row.body = body.value;
    manifestSnapshots.push(Object.freeze(row));
  }
  for (let index = 0; index < rules.length; index += 1) {
    const row = record(rules[index]);
    const path = `rules[${index}]`;
    if (!row) {
      errors.push(`${path} is not an object`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    for (const field of ["id", "constructorName", "objectId", "location"] as const)
      if (!admitText(row[field], field === "location" ? MAX_LOCATION_CHARS : MAX_RULE_IDENTIFIER_CHARS, `${path}.${field}`))
        return { ok: false, errors: Object.freeze(errors) };
    if (row.aliasOf !== undefined && !admitText(row.aliasOf, MAX_RULE_IDENTIFIER_CHARS, `${path}.aliasOf`))
      return { ok: false, errors: Object.freeze(errors) };
    const source = record(row.source);
    if (!admitText(row.ownership, 8, `${path}.ownership`) || !admitText(row.scope, 5, `${path}.scope`) ||
      !source || !admitPositionText(source, `${path}.source`)) {
      if (!source) errors.push(`${path}.source is not a data record`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    const lifetime = record(row.lifetime);
    const begin = lifetime && record(lifetime.begin), end = lifetime && record(lifetime.end);
    if (!lifetime || !admitText(lifetime.state, 15, `${path}.lifetime.state`) ||
      !begin || !end || !admitPositionText(begin, `${path}.lifetime.begin`) ||
      !admitPositionText(end, `${path}.lifetime.end`)) {
      if (!lifetime || !begin || !end) errors.push(`${path}.lifetime is not a data record`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    const dependencies = dataArray(row.proofDependencies, MAX_PROOF_DEPENDENCIES_PER_RULE);
    if (!dependencies) {
      errors.push(`${path}.proofDependencies is missing or exceeds ${MAX_PROOF_DEPENDENCIES_PER_RULE} entries`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    if (dependencies.length > MAX_TOTAL_PROOF_DEPENDENCIES - declaredDependencyCount) {
      errors.push(`ledger proofDependencies total exceeds ${MAX_TOTAL_PROOF_DEPENDENCIES} entries`);
      return { ok: false, errors: Object.freeze(errors) };
    }
    declaredDependencyCount += dependencies.length;
    for (let dependency = 0; dependency < dependencies.length; dependency += 1)
      if (!admitText(dependencies[dependency], MAX_PATH_CHARS, `${path}.proofDependencies[${dependency}]`))
        return { ok: false, errors: Object.freeze(errors) };
    row.source = Object.freeze(source);
    lifetime.begin = Object.freeze(begin);
    lifetime.end = Object.freeze(end);
    row.lifetime = Object.freeze(lifetime);
    row.proofDependencies = dependencies;
    ruleSnapshots.push(Object.freeze(row));
  }
  if (errors.length) return { ok: false, errors: Object.freeze(errors) };

  const manifestRows: SourceManifestRow[] = [];
  const manifestPaths = new Set<string>();
  manifestSnapshots.forEach((candidate, index) => {
    const path = `manifest[${index}]`;
    const row = record(candidate);
    if (!row) { errors.push(`${path} is not an object`); return; }
    const rowPath = row.path;
    if (!validPath(rowPath)) errors.push(`${path}.path is not a canonical Source path`);
    if (validPath(rowPath) && manifestPaths.has(rowPath)) errors.push(`${path}.path is duplicate`);
    if (validPath(rowPath)) manifestPaths.add(rowPath);
    if (!validHash(row.beforeSha256)) errors.push(`${path}.beforeSha256 is invalid`);
    if (!validHash(row.afterSha256)) errors.push(`${path}.afterSha256 is invalid`);
    const body = decodeCapturedBody(capturedBodies[index]);
    if (!body.ok) {
      errors.push(`${path}.body ${body.error}`);
      return;
    }
    if (body.value.sha256 !== row.beforeSha256)
      errors.push(`${path}.body SHA256 does not equal beforeSha256`);
    if (body.value.sha256 !== row.afterSha256)
      errors.push(`${path}.body SHA256 does not equal afterSha256`);
    if (validPath(rowPath) && validHash(row.beforeSha256) && validHash(row.afterSha256) &&
      body.value.sha256 === row.beforeSha256 && body.value.sha256 === row.afterSha256) {
      manifestRows.push(Object.freeze({
        path: rowPath,
        body: encodeBody(body.value),
        beforeSha256: row.beforeSha256,
        afterSha256: row.afterSha256,
      }));
    }
  });

  const ruleRows: ActivationRule[] = [];
  const ids = new Set<string>();
  ruleSnapshots.forEach((candidate, index) => {
    const path = `rules[${index}]`;
    const row = record(candidate);
    if (!row) { errors.push(`${path} is not an object`); return; }
    for (const field of ["id", "constructorName", "objectId", "location"] as const)
      if (!boundedText(row[field], field === "location" ? MAX_LOCATION_CHARS : MAX_RULE_IDENTIFIER_CHARS)) errors.push(`${path}.${field} is missing or oversized`);
    if (boundedText(row.id, MAX_RULE_IDENTIFIER_CHARS)) {
      if (ids.has(row.id)) errors.push(`${path}.id is duplicate`);
      ids.add(row.id);
    }
    const source = record(row.source);
    if (!source) errors.push(`${path}.source is missing`);
    else {
      if (!validHash(source.sourceSha256) || source.sourceSha256 !== projection)
        errors.push(`${path}.source.sourceSha256 is not current`);
      if (!validCoordinate(source.coordinate)) errors.push(`${path}.source.coordinate is invalid`);
    }
    const ownership = row.ownership;
    if (ownership !== "owned" && ownership !== "borrowed" && ownership !== "alias")
      errors.push(`${path}.ownership is invalid`);
    if (ownership === "alias" && !boundedText(row.aliasOf, MAX_RULE_IDENTIFIER_CHARS))
      errors.push(`${path}.aliasOf is required for alias ownership`);
    if (ownership !== "alias" && row.aliasOf !== undefined)
      errors.push(`${path}.aliasOf is only valid for alias ownership`);
    const lifetime = record(row.lifetime);
    if (!lifetime) errors.push(`${path}.lifetime is missing`);
    else {
      for (const field of ["begin", "end"] as const) {
        const position = record(lifetime[field]);
        if (!position || !detachedPosition(position, projection))
          errors.push(`${path}.lifetime.${field} is not bound to current Source`);
      }
      if (lifetime.state !== "closed" && lifetime.state !== "state-dependent")
        errors.push(`${path}.lifetime.state is invalid`);
    }
    if (!validDecimal(row.maximumLive) || BigInt(row.maximumLive) < 1n || BigInt(row.maximumLive) > 8192n)
      errors.push(`${path}.maximumLive is not a checked 1..8192 decimal`);
    const dependencies = Array.isArray(row.proofDependencies) ? row.proofDependencies : [];
    if (!Array.isArray(row.proofDependencies) || dependencies.length === 0)
      errors.push(`${path}.proofDependencies is empty`);
    const dependencyNames = new Set<string>();
    for (const dependency of dependencies) {
      if (!validPath(dependency)) errors.push(`${path}.proofDependencies contains an invalid path`);
      else if (dependencyNames.has(dependency)) errors.push(`${path}.proofDependencies contains a duplicate`);
      else {
        dependencyNames.add(dependency);
        if (!manifestPaths.has(dependency)) errors.push(`${path}.proofDependencies names ${dependency} without a current manifest pin`);
      }
    }
    if (row.scope !== "root" && row.scope !== "phase") errors.push(`${path}.scope is invalid`);
    if (row.scope === "phase" && (typeof row.phase !== "number" || !Number.isInteger(row.phase) || row.phase < 0 || row.phase > 4))
      errors.push(`${path}.phase is required for phase scope`);
    if (row.scope === "root" && row.phase !== undefined) errors.push(`${path}.phase is invalid for root scope`);

    const sourcePosition = source && detachedPosition(source, projection);
    const lifetimeBegin = lifetime && detachedPosition(record(lifetime.begin) || {}, projection);
    const lifetimeEnd = lifetime && detachedPosition(record(lifetime.end) || {}, projection);
    const maximumLive = validDecimal(row.maximumLive) &&
      BigInt(row.maximumLive) >= 1n && BigInt(row.maximumLive) <= 8192n
      ? row.maximumLive
      : undefined;
    const phase = row.scope === "phase" && typeof row.phase === "number" &&
      Number.isInteger(row.phase) && row.phase >= 0 && row.phase <= 4
      ? row.phase as 0 | 1 | 2 | 3 | 4
      : undefined;
    if (boundedText(row.id, MAX_RULE_IDENTIFIER_CHARS) && boundedText(row.constructorName, MAX_RULE_IDENTIFIER_CHARS) &&
      boundedText(row.objectId, MAX_RULE_IDENTIFIER_CHARS) && boundedText(row.location, MAX_LOCATION_CHARS) &&
      sourcePosition && (ownership === "owned" || ownership === "borrowed" || ownership === "alias") &&
      lifetime && (lifetime.state === "closed" || lifetime.state === "state-dependent") &&
      lifetimeBegin && lifetimeEnd && maximumLive !== undefined &&
      dependencies.length > 0 && (row.scope === "root" || row.scope === "phase" && phase !== undefined)) {
      const aliasOf = ownership === "alias" && boundedText(row.aliasOf, MAX_RULE_IDENTIFIER_CHARS)
        ? row.aliasOf
        : undefined;
      const rule = {
        id: row.id,
        constructorName: row.constructorName,
        objectId: row.objectId,
        location: row.location,
        source: sourcePosition,
        ownership,
        ...(aliasOf === undefined ? {} : { aliasOf }),
        lifetime: Object.freeze({
          begin: lifetimeBegin,
          end: lifetimeEnd,
          state: lifetime.state,
        }),
        maximumLive,
        proofDependencies: Object.freeze([...dependencies]),
        scope: row.scope,
        ...(phase === undefined ? {} : { phase }),
      } as ActivationRule;
      ruleRows.push(Object.freeze(rule));
    }
  });

  const rulesById = new Map<string, ActivationRule>();
  for (const rule of ruleRows) if (!rulesById.has(rule.id)) rulesById.set(rule.id, rule);
  const scopeKey = (rule: ActivationRule): string =>
    rule.scope === "root" ? "root" : `phase:${rule.phase}`;
  const aliasState = new Map<string, "visiting" | "resolved">();
  const aliasAnchor = new Map<string, string>();
  const resolveAliasAnchor = (rule: ActivationRule): string | undefined => {
    const path: ActivationRule[] = [];
    let current: ActivationRule | undefined = rule;
    while (current && current.ownership === "alias") {
      if (aliasState.get(current.id) === "resolved") {
        for (const item of path) {
          aliasState.set(item.id, "resolved");
          aliasAnchor.set(item.id, aliasAnchor.get(current.id) || "");
        }
        return aliasAnchor.get(current.id);
      }
      if (aliasState.get(current.id) === "visiting") {
        errors.push(`rules ${rule.id}.aliasOf contains a cyclic alias`);
        return undefined;
      }
      aliasState.set(current.id, "visiting");
      path.push(current);
      const target: ActivationRule | undefined = current.aliasOf === undefined ? undefined : rulesById.get(current.aliasOf);
      if (!target) {
        errors.push(`rules ${current.id}.aliasOf names ${current.aliasOf} without a current rule`);
        return undefined;
      }
      if (scopeKey(target) !== scopeKey(rule)) {
        errors.push(`rules ${current.id}.aliasOf leaves the ${scopeKey(rule)} scope`);
        return undefined;
      }
      current = target;
    }
    if (!current || current.ownership !== "owned") {
      errors.push(`rules ${rule.id}.aliasOf does not resolve to a valid owned anchor in scope`);
      return undefined;
    }
    for (const item of path) {
      aliasState.set(item.id, "resolved");
      aliasAnchor.set(item.id, current.id);
    }
    return current.id;
  };
  for (const rule of ruleRows) {
    if (rule.ownership !== "alias") continue;
    if (rule.aliasOf === rule.id) {
      errors.push(`rules ${rule.id}.aliasOf cannot target itself`);
      continue;
    }
    resolveAliasAnchor(rule);
  }

  if (errors.length) return { ok: false, errors: Object.freeze(errors) };
  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      sourceProjectionSha256: projection,
      manifest: Object.freeze(manifestRows),
      rules: Object.freeze(ruleRows),
    }),
  };
}

export function activationRulesFor(
  ledger: SourceLedger,
  scope: "root" | "phase",
  phase?: 0 | 1 | 2 | 3 | 4,
): readonly ActivationRule[] {
  return Object.freeze(ledger.rules.filter(rule =>
    rule.scope === scope && (scope === "root" || rule.phase === phase)));
}
