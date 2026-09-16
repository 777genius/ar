import { describe, expect, it } from "vitest";
import {
  AppServerJsonRpcLineDecoder,
  appServerJsonRpcFrameLimit,
} from "../app-server/protocol/app-server-json-rpc-line-decoder";

describe("AppServerJsonRpcLineDecoder", () => {
  it("keeps UTF-8 frames intact across chunks", () => {
    const decoder = new AppServerJsonRpcLineDecoder(32);
    const frames: string[] = [];
    decoder.write('{"message":"😀', (frame) => { frames.push(frame); });
    decoder.write('"}\n', (frame) => { frames.push(frame); });
    expect(frames).toEqual(['{"message":"😀"}']);
  });

  it("accepts a large batch of individually bounded frames", () => {
    const decoder = new AppServerJsonRpcLineDecoder(16);
    const frames: string[] = [];
    decoder.write("small\n".repeat(20), (frame) => { frames.push(frame); });
    expect(frames).toEqual(Array.from({ length: 20 }, () => "small"));
  });

  it("rejects an unterminated frame before retaining it", () => {
    const decoder = new AppServerJsonRpcLineDecoder(4);
    expect(() => decoder.write("abcde", () => undefined)).toThrow(
      "codex_app_server_json_rpc_frame_limit_exceeded",
    );
  });

  it("uses enough JSON escaping headroom for the output contract", () => {
    expect(appServerJsonRpcFrameLimit(512 * 1024)).toBe(4 * 1024 * 1024);
    expect(() => appServerJsonRpcFrameLimit(0)).toThrow(
      "codex_app_server_max_output_bytes_invalid",
    );
  });
});
