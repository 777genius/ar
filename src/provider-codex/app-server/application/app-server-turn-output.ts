import { CodexAppServerOutputLimitError } from "../domain/app-server-errors";
import type { TurnState } from "./app-server-turn-state";

export function appendTurnOutput(input: {
  readonly turn: TurnState;
  readonly text: string;
  readonly maxOutputBytes: number;
  readonly reject: () => void;
}): boolean {
  if (!input.text || input.turn.error) return false;
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (
    input.turn.outputBytes + textBytes > input.maxOutputBytes ||
    input.turn.deliveredOutputBytes + textBytes > input.maxOutputBytes
  ) {
    input.turn.error = new CodexAppServerOutputLimitError();
    input.reject();
    return false;
  }
  input.turn.outputText += input.text;
  input.turn.outputBytes += textBytes;
  input.turn.deliveredOutputBytes += textBytes;
  return true;
}

export function replaceTurnOutput(input: {
  readonly turn: TurnState;
  readonly text: string;
  readonly maxOutputBytes: number;
  readonly reject: () => void;
}): void {
  if (input.turn.error) return;
  const textBytes = Buffer.byteLength(input.text, "utf8");
  if (textBytes > input.maxOutputBytes) {
    input.turn.error = new CodexAppServerOutputLimitError();
    input.reject();
    return;
  }
  input.turn.outputText = input.text;
  input.turn.outputBytes = textBytes;
}

export function mergeTurnOutput(input: {
  readonly expected: TurnState;
  readonly actual: TurnState;
  readonly maxOutputBytes: number;
  readonly reject: () => void;
}): boolean {
  if (input.expected.error) return false;
  const actualDeliveredBytes = Math.max(
    input.actual.deliveredOutputBytes,
    input.actual.outputBytes,
  );
  if (
    input.expected.outputBytes + input.actual.outputBytes > input.maxOutputBytes ||
    input.expected.deliveredOutputBytes + actualDeliveredBytes > input.maxOutputBytes
  ) {
    input.expected.error = new CodexAppServerOutputLimitError();
    input.reject();
    return false;
  }
  input.expected.outputText += input.actual.outputText;
  input.expected.outputBytes += input.actual.outputBytes;
  input.expected.deliveredOutputBytes += actualDeliveredBytes;
  return Boolean(input.actual.outputText);
}
