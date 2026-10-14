import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "vitest";
import * as api from "../../../host-integration/native-probe/qualification-main-operational-demand-ledger.mjs";
import type {
  CapturedBody,
  SourcePosition as Position,
  ActivationRule as Rule,
  SourceManifestRow as ManifestRow,
  SourceLedger as Ledger,
} from "../../../host-integration/native-probe/qualification-main-operational-demand-ledger.mjs";

// Synthetic comparison-DATA fixtures exercise public decoding contracts only.
// They establish no captured native inventory, numeric funding or authority.
const bodyLimit = 8 * 1024 * 1024;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const capture = (bytes: Uint8Array): CapturedBody => ({
  base64: Buffer.from(bytes).toString("base64"), sha256: sha(bytes), extent: String(bytes.byteLength),
});
const projection = sha(Buffer.from("synthetic-ledger-regression-projection"));
const position = (coordinate = "src/fixture.mts:1:body"): Position => ({ sourceSha256: projection, coordinate });
const empty = capture(new Uint8Array());
function manifestRow(path = "src/fixture.mts", body = empty): ManifestRow {
  return { path, body: { ...body }, beforeSha256: body.sha256, afterSha256: body.sha256 };
}
function owned(id = "owner", scope: "root" | "phase" = "root", phase?: 0 | 1 | 2 | 3 | 4): Rule {
  return {
    id, constructorName: "fixture_constructor", objectId: "fixture_object", location: "fixture_site",
    source: position(), ownership: "owned",
    lifetime: { begin: position("src/fixture.mts:1:begin"), end: position("src/fixture.mts:2:end"), state: "closed" },
    maximumLive: "1", proofDependencies: ["src/fixture.mts"], scope,
    ...(phase === undefined ? {} : { phase }),
  };
}
function ledger(rules: readonly Rule[] = [owned()], manifest: readonly ManifestRow[] = [manifestRow()]): Ledger {
  return { schemaVersion: 1, sourceProjectionSha256: projection, manifest, rules };
}
function requireLedger(value: unknown): Ledger {
  const result = api.decodeSourceLedger(value);
  assert.equal(result.ok, true, "honest fixture was refused");
  assert(result.ok);
  return result.value;
}
function requireRefused(value: unknown): void {
  const result = api.decodeSourceLedger(value);
  assert.equal(result.ok, false, "invalid ledger was admitted");
  assert(!result.ok);
  assert(result.errors.length > 0, "refusal must explain at least one invalid input");
}
describe("main operational demand Source ledger comparison-DATA", () => {
  it("decode-mutate-encode-never-stale-sha", () => {
    const original = capture(Uint8Array.of(7, 8, 9));
    const decoded = api.decodeCapturedBody(original);
    assert(decoded.ok, "honest nonempty captured body was refused");
    const escaped = decoded.value.bytes;
    escaped[0] = 99;
    let encoded: CapturedBody | undefined;
    try { encoded = api.encodeBody(decoded.value); }
    catch (error) { assert(error instanceof Error, "mutated Body refusal must be an Error"); }
    if (encoded !== undefined) {
      assert.deepEqual(encoded, original, "decoded Body emitted drifted bytes or silently repinned them");
      assert.equal(sha(Buffer.from(encoded.base64, "base64")), encoded.sha256, "serialized SHA is stale");
    }
    assert.throws(() => api.encodeBody({ bytes: escaped, sha256: original.sha256 }),
      "caller-held mutated bytes with the old hash must be refused");
  });
  it("encode-rejects-over-8mib-body", () => {
    const bytes = new Uint8Array(bodyLimit + 1);
    assert.throws(() => api.encodeBody({ bytes, sha256: sha(bytes) }),
      "encoder must refuse an otherwise honestly pinned oversized Uint8Array");
  });
  it("shadowed-byte-length-cannot-pad-input-evidence", () => {
    const bytes = Uint8Array.of(0);
    Object.defineProperty(bytes, "byteLength", { value: 2 });
    assert.throws(() => api.encodeBody({ bytes, sha256: sha(Uint8Array.of(0, 0)) }),
      "encoder must refuse a SHA for padded bytes absent from the one-byte input");
    const honest = capture(Uint8Array.of(0));
    let encoded: CapturedBody | undefined;
    try { encoded = api.encodeBody({ bytes, sha256: honest.sha256 }); }
    catch (error) { assert(error instanceof Error, "shadowed input refusal must be an Error"); }
    if (encoded !== undefined) assert.deepEqual(encoded, honest,
      "accepted shadowed input must describe only its actual byte");
  });
  it("rejects-otherwise-valid-oversized-source-path", () => {
    const path = "a/".repeat(2048) + "a"; // 4097 chars, all canonical segments.
    const rule = { ...owned(), proofDependencies: [path] };
    requireRefused(ledger([rule], [manifestRow(path)]));
  });
  const textVariants: readonly Readonly<{ id: string; change(rule: Rule): Rule }>[] = [
    { id: "id", change: rule => ({ ...rule, id: "x".repeat(1025) }) },
    { id: "constructor", change: rule => ({ ...rule, constructorName: "x".repeat(1025) }) },
    { id: "object", change: rule => ({ ...rule, objectId: "x".repeat(1025) }) },
    { id: "location", change: rule => ({ ...rule, location: "x".repeat(8193) }) },
    { id: "source-coordinate", change: rule => ({ ...rule, source: position("x".repeat(8189) + ":1:x") }) },
    { id: "lifetime-begin", change: rule => ({ ...rule, lifetime: { ...rule.lifetime, begin: position("x".repeat(8189) + ":1:x") } }) },
    { id: "lifetime-end", change: rule => ({ ...rule, lifetime: { ...rule.lifetime, end: position("x".repeat(8189) + ":1:x") } }) },
  ];
  for (const variant of textVariants)
    it("rejects-otherwise-valid-oversized-rule-" + variant.id,
      () => requireRefused(ledger([variant.change(owned())])));

  it("honest-empty-and-binary-body-roundtrips", () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(0), Uint8Array.of(0, 255),
      Uint8Array.of(0, 128, 255), Uint8Array.of(0, 255, 128, 1)]) {
      const input = capture(bytes);
      const result = api.decodeCapturedBody(input);
      assert(result.ok, "honest captured bytes were refused");
      assert.deepEqual(result.value.bytes, bytes);
      assert.equal(result.value.sha256, input.sha256);
      assert.deepEqual(api.encodeBody(result.value), input);
    }
    const buffer = Buffer.from([0, 128, 255]);
    assert.deepEqual(api.encodeBody({ bytes: buffer, sha256: sha(buffer) }), capture(buffer),
      "ordinary Buffer compatibility must be preserved");
  });
  it("known-ledger-api-remains-detached", () => {
    const input = ledger([owned(), owned("phase-owner", "phase", 2)]);
    const decoded = requireLedger(input);
    assert.deepEqual(decoded, input);
    assert.deepEqual(api.activationRulesFor(decoded, "root").map(rule => rule.id), ["owner"]);
    assert.deepEqual(api.activationRulesFor(decoded, "phase", 2).map(rule => rule.id), ["phase-owner"]);
    assert.equal(api.activationRulesFor(decoded, "phase", 1).length, 0);
    const firstInput = input.manifest[0], firstOutput = decoded.manifest[0];
    assert(firstInput && firstOutput);
    Reflect.set(firstInput.body, "base64", "AQ==");
    assert.deepEqual(firstOutput.body, empty, "caller mutation changed captured manifest strings");
    assert(Object.isFrozen(decoded) && Object.isFrozen(firstOutput) && Object.isFrozen(firstOutput.body));
  });
  it("alias-chain-stays-in-real-phase-scope", () => {
    const anchor = owned("anchor", "phase", 0);
    const alias: Rule = { ...owned("alias", "phase", 0), ownership: "alias", aliasOf: "anchor" };
    const chain: Rule = { ...owned("chain", "phase", 0), ownership: "alias", aliasOf: "alias" };
    requireLedger(ledger([anchor, alias, chain]));
    requireRefused(ledger([{ ...anchor, phase: 1 }, alias, chain]));
  });
  it("malformed-extent-and-noncanonical-pad-bits-refuse", () => {
    const wrongExtent = { ...capture(Uint8Array.of(0)), extent: "0" };
    const direct = api.decodeCapturedBody(wrongExtent);
    assert(!direct.ok && direct.reason === "malformed", "direct malformed extent was admitted");
    requireRefused(ledger([], [manifestRow("src/fixture.mts", wrongExtent)]));
    const padBits = { ...capture(Uint8Array.of(102)), base64: "Zh==" };
    assert.equal(api.decodeCapturedBody(padBits).ok, false, "noncanonical pad bits were admitted");
  });
  it("aggregate-actual-body-bound-and-forged-extents-refuse", () => {
    const body = capture(new Uint8Array(bodyLimit));
    const rows = Array.from({ length: 9 }, (_, index) => manifestRow("src/body-" + index + ".mts", body));
    requireRefused(ledger([], rows)); // 72MiB of honest actual/declared bytes.
    requireRefused(ledger([], rows.map(row => ({ ...row, body: { ...body, extent: "0" } }))));
    // Refusal is observable. Allocation order is deliberately NOT inferred from this test.
  });

  it("accessors and proxies cannot bypass admitted dependency caps", () => {
    const paths = Array.from({ length: 257 }, (_, index) => "src/dependency-" + index + ".mts");
    const firstPath = paths[0];
    assert(firstPath);
    const rule = owned();
    let reads = 0;
    Object.defineProperty(rule, "proofDependencies", {
      enumerable: true,
      get: (): readonly string[] => ++reads === 1 ? [firstPath] : [...paths],
    });
    requireRefused(ledger([rule], paths.map(path => manifestRow(path))));
    assert.equal(reads, 0, "the decoder must refuse an accessor without invoking it");

    let traps = 0;
    const proxy = new Proxy(owned(), {
      getOwnPropertyDescriptor(target, key) { traps++; return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key, receiver) { traps++; return Reflect.get(target, key, receiver); },
      getPrototypeOf(target) { traps++; return Reflect.getPrototypeOf(target); },
    });
    requireRefused(ledger([proxy]));
    assert.equal(traps, 0, "the decoder must refuse a proxy before reading its metadata");
  });
});
