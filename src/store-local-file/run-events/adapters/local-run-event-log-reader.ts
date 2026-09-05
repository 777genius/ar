import { open } from "node:fs/promises";

export async function visitEventLogLines(input: {
  readonly path: string;
  readonly startLine: number;
  readonly visit: (line: string, index: number) => boolean;
}): Promise<boolean> {
  let handle;
  try {
    handle = await open(input.path, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const snapshotSize = (await handle.stat()).size;
    const soleByte = snapshotSize === 1 ? Buffer.allocUnsafe(1) : undefined;
    const isEmptyTerminatedLine = soleByte !== undefined &&
      (await handle.read(soleByte, 0, 1, 0)).bytesRead === 1 &&
      soleByte[0] === 0x0a;
    if (snapshotSize === 0 || isEmptyTerminatedLine) return true;
    const stream = handle.createReadStream({
      autoClose: false,
      encoding: "utf8",
      end: snapshotSize - 1,
    });
    let fragments: string[] = [];
    let index = 0;
    try {
      chunks: for await (const chunk of stream) {
        const decoded = String(chunk);
        let start = 0;
        for (
          let newline = decoded.indexOf("\n", start);
          newline >= 0;
          newline = decoded.indexOf("\n", start)
        ) {
          const tail = decoded.slice(start, newline);
          if (fragments.length > 0) fragments.push(tail);
          const line = fragments.length === 0 ? tail : fragments.join("");
          fragments = [];
          if (index >= input.startLine && input.visit(line, index)) break chunks;
          index += 1;
          start = newline + 1;
        }
        if (start < decoded.length) fragments.push(decoded.slice(start));
      }
      if (fragments.length > 0 && index >= input.startLine) {
        input.visit(fragments.join(""), index);
      }
    } finally {
      stream.destroy();
    }
    return true;
  } finally {
    await handle.close();
  }
}
export async function eventLogNeedsSeparatorNewline(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return false;
    const finalByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(finalByte, 0, 1, size - 1);
    return bytesRead === 1 && finalByte[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
