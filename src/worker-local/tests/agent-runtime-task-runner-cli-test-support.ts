import { chmod, writeFile } from "node:fs/promises";
import type {
  SubscriptionAgentRuntimeTaskCliIo,
} from "../agent-runtime-task-runner-cli";

export function fakeAgentRuntimeTaskCliIo(input: {
  readonly stdin: string;
  readonly stdout?: string[];
  readonly stderr?: string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}): SubscriptionAgentRuntimeTaskCliIo {
  return {
    async readStdin() {
      return input.stdin;
    },
    writeStdout(chunk) {
      input.stdout?.push(chunk);
    },
    writeStderr(chunk) {
      input.stderr?.push(chunk);
    },
    cwd() {
      return input.cwd ?? process.cwd();
    },
    env() {
      return input.env;
    },
  };
}

export function validCodexAuthJson(): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "refresh-token",
      access_token: "access-token",
      expiry: "2027-05-31T23:00:00.000Z",
    },
    last_refresh: "2026-05-31T00:00:00.000Z",
  });
}

export async function writeFakeCodexBinary(
  path: string,
  input: {
    readonly appServerTurnFails?: boolean;
    readonly fallbackExecFails?: boolean;
  } = {},
): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
import readline from "node:readline";

const appServerTurnFails = ${JSON.stringify(Boolean(input.appServerTurnFails))};
const fallbackExecFails = ${JSON.stringify(Boolean(input.fallbackExecFails))};

if (process.argv[2] === "exec") {
  const isJsonExec = process.argv.includes("--json");
  if (isJsonExec && fallbackExecFails) {
    process.stderr.write("forced fallback failure");
    process.exit(7);
  }
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdin += chunk;
  });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({
      message: "fake-codex-exec-ok:" + process.cwd() + ":" + stdin.trim(),
    }) + "\\n");
  });
  process.stdin.resume();
} else if (process.argv[2] !== "app-server") {
  process.stderr.write("unexpected fake codex args: " + process.argv.slice(2).join(" "));
  process.exit(2);
} else {
  runAppServer();
}

function runAppServer() {
  let nextThreadId = 1;
  let nextTurnId = 1;
  const threadCwds = new Map();
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  function write(message) {
    process.stdout.write(JSON.stringify(message) + "\\n");
  }

  function promptFromParams(params) {
    const input = params?.input;
    if (!Array.isArray(input)) return "";
    const first = input[0];
    return typeof first?.text === "string" ? first.text : "";
  }

  rl.on("line", (line) => {
    if (!line.trim()) return;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      write({ id: request.id, result: { userAgent: "fake-codex-e2e" } });
      return;
    }
    if (request.method === "thread/start") {
      const threadId = "thread-" + nextThreadId;
      nextThreadId += 1;
      if (typeof request.params?.cwd === "string") {
        threadCwds.set(threadId, request.params.cwd);
      }
      write({ id: request.id, result: { thread: { id: threadId } } });
      return;
    }
    if (request.method === "turn/start") {
      if (appServerTurnFails) {
        write({
          id: request.id,
          error: { message: "forced app-server turn failure" },
        });
        return;
      }
      const turnId = "turn-" + nextTurnId;
      nextTurnId += 1;
      const prompt = promptFromParams(request.params);
      const cwd = threadCwds.get(request.params?.threadId) ?? "cwd-missing";
      write({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        write({
          method: "item/agentMessage/delta",
          params: {
            turnId,
            delta: "fake-codex-ok:" + cwd + ":" + prompt,
          },
        });
        write({
          method: "turn/completed",
          params: { turn: { id: turnId, status: { type: "completed" } } },
        });
      }, 1);
      return;
    }
    write({ id: request.id, result: {} });
  });
}
`,
    "utf8",
  );
  await chmod(path, 0o700);
}
