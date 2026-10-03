// Executed only by the isolated MCP stop fixtures; never reads host processes.
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

type State = {
  mode: string;
  stopped: boolean;
  terminated?: boolean;
  psReads: number;
};
const statePath = process.env.PR135_SYNTHETIC_STATE!;
const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
const [kind, command] = process.argv.slice(2);
appendFileSync(`${statePath}.calls`, `${kind} ${process.argv.slice(3).join(" ")}\n`);
if (kind === "tmux") {
  if (command === "kill-session") {
    if (state.mode === "race" || state.mode === "race-live") {
      state.stopped = true;
      writeFileSync(statePath, JSON.stringify(state));
      process.stderr.write("can't find session\n");
      process.exit(1);
    }
    state.stopped = true;
    writeFileSync(statePath, JSON.stringify(state));
  } else if (command === "has-session" &&
      (state.mode === "absent" || state.mode === "dead" || state.mode === "live" || state.mode === "foreign" || state.stopped)) {
    process.exit(1);
  }
} else if (kind === "ps") {
  if (process.argv.at(-1) === "lstart=" && process.argv[4] !== "987654") {
    process.stdout.write("Thu Aug 21 02:00:00 2026\n");
    process.exit(0);
  }
  state.psReads++;
  writeFileSync(statePath, JSON.stringify(state));
  if (state.mode === "absent" || state.mode === "race") process.exit(2);
  if (state.terminated) process.exit(0);
  if (state.mode === "race-live" && !state.stopped) process.exit(0);
  if (state.mode === "dead" || state.stopped && state.mode !== "race-live") process.exit(0);
  const cmd = state.mode === "foreign" ? "bash foreign.sh" : `node subscription-runtime-codex-goal run --no-tmux --task-id proof-child --progress ${join(dirname(statePath), "jobs", "proof-child", "proof-child.progress.json")}`;
  process.stdout.write(`987654 1 S 0.0 Thu Aug 21 02:00:00 2026 ${cmd}\n`);
}
