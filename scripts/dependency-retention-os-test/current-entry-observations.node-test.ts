/** A transported/counterfeit result must fail before caller access or host IO. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCurrentEntryContentObservation, EntryObservationState } from "./current-entry-observations.js";
test("a structurally valid counterfeit cannot select protected telemetry or run getters", () => {
  let calls = 0;
  const counterfeit = { exitCode: 0, artifacts: [], unit: "subscription-runtime-ordinary-12345678-1234-1234-1234-123456789abc.service",
    get startId() { calls++; return "12345678-1234-1234-1234-123456789abc"; } };
  const expected = {state:EntryObservationState.Unknown,attempted:null,completed:null,finalRoot:null};
  assert.deepEqual(readCurrentEntryContentObservation("TEST-owned",counterfeit),expected);
  const proxy = new Proxy(counterfeit,{get(){calls++;throw new Error("TEST-private");}});
  assert.deepEqual(readCurrentEntryContentObservation("TEST-owned",proxy),expected);
  const revoked = Proxy.revocable(counterfeit,{}); revoked.revoke();
  assert.deepEqual(readCurrentEntryContentObservation("TEST-owned",revoked.proxy),expected);
  assert.equal(calls,0);
});
