import { parseJsonRpcLine } from "../protocol/app-server-json-rpc";
import type { AppServerJsonRpcLineDecoder } from "../protocol/app-server-json-rpc-line-decoder";

export function handleAppServerStdout(input: {
  readonly decoder: AppServerJsonRpcLineDecoder;
  readonly chunk: string;
  readonly isTerminal: () => boolean;
  readonly message: (message: unknown) => void;
  readonly fail: (error: unknown) => void;
}): void {
  if (input.isTerminal()) return;
  try {
    input.decoder.write(input.chunk, (line) => {
      const message = parseJsonRpcLine(line);
      if (message !== null) input.message(message);
      return !input.isTerminal();
    });
  } catch (error) {
    input.fail(error);
  }
}
