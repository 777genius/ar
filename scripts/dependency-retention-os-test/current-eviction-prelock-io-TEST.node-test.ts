/** These local I/O checks do not qualify an original native C actor. */
import { test } from "node:test";
import { selfCheckEvictionPrelockBuiltinIO, selfCheckEvictionPrelockAnchoredIO } from "./current-eviction-prelock-io-TEST.js";
// Regression: named ESM imports keep a stale shim, unrelated opens change, or
// a foreign interceptor gets accepted as this finite adapter's private EIO.
test("finite eviction prelock adapter restores actual default and named builtin views",selfCheckEvictionPrelockBuiltinIO);
// Regression: denial reaches the underlying mutex open, targets another anchor,
// repeats after the first trigger, leaks descriptors, or masks a factual refusal.
test("finite eviction prelock adapter authenticates real proc anchor and restores before private EIO",{
  skip:process.platform!=="linux" || process.getuid?.()!==0 ? "requires Linux proc-FD and root-owned private adapter fixture":false,
},selfCheckEvictionPrelockAnchoredIO);
