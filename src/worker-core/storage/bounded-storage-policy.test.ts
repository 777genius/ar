import { describe, expect, it } from "vitest";
import { BoundedStorageBackend, BoundedStoragePhase, type BoundedStorageRequest, type BoundedStorageReservation } from "./bounded-storage-contract";
import { assertBoundedCapacity, boundedImageEnvelope, parseBoundedLedger, parseBoundedRequest } from "./bounded-storage-policy";

const gib = 1073741824n;
const filesystem = { machineId: "d856d40da5ad4e23b4f67773e5942842", uuid: "d0f2cac1-2009-4e9d-a710-e156f417938f", device: "66305" };
function request(baseline = 0n, growth = 2n * gib): BoundedStorageRequest {
  const cap = { bytes: String(baseline + growth), inodes: "50000" };
  return { backend: BoundedStorageBackend.Ext4ProjectImage,
    binding: { filesystem, bootId: "11111111-1111-4111-8111-111111111111", policySha256: "a".repeat(64), admissionReceiptSha256: "b".repeat(64), admissionRevision: 1 },
    generation: { jobId: "test-storage-b1-policy", generationId: "22222222-2222-4222-8222-222222222222", projectId: 501 },
    operationId: "33333333-3333-4333-8333-333333333333", baseline: { bytes: String(baseline), inodes: "0" },
    growth: { bytes: String(growth), inodes: "50000" }, cap, ...boundedImageEnvelope(cap) };
}
function reservation(r: BoundedStorageRequest, phase = BoundedStoragePhase.Pending): BoundedStorageReservation {
  return { request: parseBoundedRequest(r), requestSha256: "c".repeat(64), revision: 1, phase, facts: null };
}
describe("bounded image policy", () => {
  // Red if physical envelope is accidentally substituted for writer commitment.
  it("keeps empty G2 at Q2 and refuses an estimate-selected Q10", () => {
    const r = request();
    expect(parseBoundedRequest(r).cap.bytes).toBe("2147483648");
    expect(BigInt(r.physicalBytes)).toBeGreaterThan(2n * gib);
    expect(() => parseBoundedRequest({ ...r, cap: { ...r.cap, bytes: "10737418240" } })).toThrow();
  });
  it("resumes U06 plus G2 as Q8 with independent inode commitments", () => {
    const r = request(6n * gib);
    const parsed = parseBoundedRequest({ ...r, baseline: { bytes: "6442450944", inodes: "30000" }, growth: { bytes: "2147483648", inodes: "20000" } });
    expect(parsed.cap).toStrictEqual({ bytes: "8589934592", inodes: "50000" });
    expect(parsed.growth).toStrictEqual({ bytes: "2147483648", inodes: "20000" });
    expect(() => parseBoundedRequest({ ...parsed, growth: { ...parsed.growth, inodes: "20001" } })).toThrow();
  });
  it.each([
    { bytes: "0", inodes: "100" }, { bytes: "1025", inodes: "100" }, { bytes: "1024", inodes: "0" },
    { bytes: "1024", inodes: "8" }, { bytes: "1024", inodes: "4294967295" },
    { bytes: "18446744073709551615", inodes: "100" }, { bytes: "9223372036854775808", inodes: "100" },
  ])("refuses unlimited, unrepresentable or overflowing geometry %j", cap => {
    expect(() => boundedImageEnvelope(cap)).toThrow();
  });
  // No observation of usage or deletion participates in either admission sum.
  it.each([BoundedStoragePhase.Pending, BoundedStoragePhase.Unknown, BoundedStoragePhase.Blocked])("retains full E for %s", phase => {
    const row = reservation(request(), phase), e = BigInt(row.request.exposure.bytes);
    const snapshot = { available: { bytes: String(5n * gib + e), inodes: "100016" }, rootAvailableBytes: "5402263552" };
    expect(() => assertBoundedCapacity(snapshot, [row])).not.toThrow();
    expect(() => assertBoundedCapacity({ ...snapshot, available: { ...snapshot.available, bytes: String(5n * gib + e - 1n) } }, [row])).toThrow();
    expect(() => assertBoundedCapacity({ ...snapshot, available: { ...snapshot.available, inodes: "100015" } }, [row])).toThrow();
    expect(() => assertBoundedCapacity({ ...snapshot, rootAvailableBytes: "5368709119" }, [row])).toThrow();
    expect(() => assertBoundedCapacity({ ...snapshot, rootAvailableBytes: "5402263551" }, [row])).toThrow();
  });
  // Red on R1: exact root floor passed despite the next control publication.
  it("preserves the real root floor through a separately charged publication buffer", () => {
    const snapshot = { available: { bytes: "5368709120", inodes: "50000" }, rootAvailableBytes: "5368709120" };
    expect(() => assertBoundedCapacity(snapshot, [])).toThrow();
    expect(() => assertBoundedCapacity({ ...snapshot, rootAvailableBytes: "5402263552" }, [])).not.toThrow();
  });
  it("rejects available7 minus old2 minus new1 before the standing floor", () => {
    const old = reservation(request(0n, 2n * gib)), next = reservation(request(0n, gib));
    expect(() => assertBoundedCapacity({ available: { bytes: "7516192768", inodes: "200000" }, rootAvailableBytes: "5402263552" }, [old, next])).toThrow();
  });
  it("captures closed input data without evaluating accessors or accepting hidden authority", () => {
    const r = request(), captured = parseBoundedRequest(r);
    (r.growth as { bytes: string }).bytes = "0";
    expect(captured.growth.bytes).toBe("2147483648");
    let reads = 0;
    expect(() => parseBoundedRequest({ ...request(), get baseline() { reads++; return { bytes: "0", inodes: "0" }; } })).toThrow();
    expect(reads).toBe(0);
    expect(() => parseBoundedRequest({ ...request(), writerAuthority: true })).toThrow();
  });
  it("never reuses job, generation or project identity while any claim is retained", () => {
    const row = reservation(request());
    const other = { ...row, request: { ...row.request, generation: { ...row.request.generation, generationId: "44444444-4444-4444-8444-444444444444" } } };
    expect(() => parseBoundedLedger({ version: 1, filesystem, revision: 1, reservations: [row, other] }, filesystem)).toThrow();
  });
});
