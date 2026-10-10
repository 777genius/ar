import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
/** Packaging only: the pinned compiler produced this exact standalone body. */
const bytes = readFileSync("dist/host-inventory-codec/host-inventory.js");
// A dependency is a changed installation closure, never an implicit lookup.
if (/\brequire\s*\(|\bimport\s*(?:\(|[^\n]*\bfrom\b)/.test(bytes.toString("utf8"))) {
  throw new Error("host_inventory_codec_runtime_import");
}
const directory = "dist/core/host-infrastructure";
mkdirSync(directory, { recursive: true });
for (const path of [`${directory}/host-inventory-codec.cjs`, "host-integration/managed-launcher/host-inventory-codec.cjs"]) writeFileSync(path, bytes);
const source = readFileSync("src/core/host-infrastructure/host-inventory.ts");
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
writeFileSync(`${directory}/host-inventory-codec.build.json`, JSON.stringify({ schemaVersion: 1,
  sourceSha256: hash(source), emittedSha256: hash(bytes), runtimeImports: [],
  compiler: JSON.parse(readFileSync("node_modules/typescript/package.json", "utf8")).version }) + "\n");
