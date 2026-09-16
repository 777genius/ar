process.env.CODEX_LEDGER_EPOCH_HANDLER_SHARD = "mutation-edge";
export {};
try {
  await import("./codex-goal-ledger-epoch-handler.test");
} finally {
  delete process.env.CODEX_LEDGER_EPOCH_HANDLER_SHARD;
}
