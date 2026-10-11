import type { RuntimeAgentTaskWorker, RuntimeAgentTaskWorkerFactory, RuntimeAgentTaskWorkerFactoryInput,
  RuntimeAgentTaskWorkerJob, SubscriptionAgentTaskCliIo } from "../agent-task-runner-cli";

export function fakeFactory(calls: {
  factory?: RuntimeAgentTaskWorkerFactoryInput;
  seed?: string;
  job?: RuntimeAgentTaskWorkerJob;
}): RuntimeAgentTaskWorkerFactory {
  return (input) => {
    calls.factory = input;
    const worker: RuntimeAgentTaskWorker = {
      async start() {},
      async seedClaudeOAuth(seed) {
        calls.seed = seed.oauthToken;
      },
      async seedCodexAuthJsonFile(path) {
        calls.seed = path;
      },
      async run(job) {
        calls.job = job;
        return {
          outputText: `worker:${job.prompt}`,
          structuredOutput: { ok: true },
          telemetry: { finishReason: "completed" },
          warnings: [],
        };
      },
      async dispose() {},
    };
    return worker;
  };
}

export function fakeIo(input: {
  readonly stdin: string;
  readonly stdout?: string[];
  readonly stderr?: string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}): SubscriptionAgentTaskCliIo {
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
