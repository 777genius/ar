/** Pure USTAR encoding of already captured and validated untracked bytes.
 * No filesystem, environment, origin, descriptor or callback access. */
export function buildTar(files: readonly { path: string; bytes: Buffer; mode: number }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const fields = tarPathFields(file.path);
    if (!fields) throw new Error("handoff_archive_path_unrepresentable");
    const header = Buffer.alloc(512);
    fields.name.copy(header, 0);
    fields.prefix?.copy(header, 345);
    tarOctal(header, 100, 8, file.mode & 0o777);
    tarOctal(header, 108, 8, 0);
    tarOctal(header, 116, 8, 0);
    tarOctal(header, 124, 12, file.bytes.length);
    tarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    tarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    blocks.push(header, file.bytes, Buffer.alloc((512 - file.bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function tarPathFields(path: string): {
  readonly name: Buffer;
  readonly prefix?: Buffer;
} | undefined {
  const name = Buffer.from(path);
  if (name.byteLength <= 100) return { name };
  for (let separator = path.lastIndexOf("/"); separator > 0;
    separator = path.lastIndexOf("/", separator - 1)) {
    const prefix = Buffer.from(path.slice(0, separator));
    const suffix = Buffer.from(path.slice(separator + 1));
    if (prefix.byteLength <= 155 && suffix.byteLength <= 100) {
      return { name: suffix, prefix };
    }
  }
  return undefined;
}

function tarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}
