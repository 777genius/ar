import { createConnection } from "node:net";

const mode = process.argv[2];
async function progress(shard: number, complete: boolean) {
  await new Promise<void>((done, reject) => {
    const socket = createConnection(process.env.CODEX_LEDGER_EPOCH_CRASH_LANE_SOCKET!);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ shard, complete })}\n`));
    socket.once("data", () => { socket.end(); done(); });
  });
}
if (mode === "startup-stall") {
  while (true) {} // Independently bounded, even when the child's loop is blocked.
} else {
  const lane = Number(process.env.SHARD_LANE);
  for (let shard = lane; shard < 54; shard += 8) {
    await progress(shard, false);
    if (mode === "shard-stall") {
      process.on("SIGTERM", () => {});
      while (true) {}
    }
    if (mode === "duplicate-start") await progress(shard, false);
    await progress(shard, true);
    if (mode === "incomplete") break;
    if (mode === "gap-stall") while (true) {}
  }
}
