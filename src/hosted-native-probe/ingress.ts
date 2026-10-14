import { readNativeProbeRequest } from "./protocol.js";
import type { NativeProbeRequest } from "../worker-core/hosted-custody/domain/native-probe.js";
export type ProbeIngress = { readonly native: true; readonly request: NativeProbeRequest } | { readonly native: false; readonly request: Record<string, unknown> };
// Valid JSON has already been established. Inspect every original top-level key,
// including duplicates which JSON.parse would erase and escaped spellings.
function reserved(bytes: string): boolean {
  let depth = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === '"') {
      const start = i++;
      for (; i < bytes.length; i++) { if (bytes[i] === "\\") i++; else if (bytes[i] === '"') break; }
      let next = i + 1; while (/\s/.test(bytes[next] ?? "") && next < bytes.length) next++;
      if (depth === 1 && bytes[next] === ":") {
        const key: unknown = JSON.parse(bytes.slice(start, i + 1));
        if (key === "allocationDigest" || key === "kind") return true;
      }
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return false;
}
export function routeProbeIngress(original: Buffer): ProbeIngress {
  if (original.length > 65536) throw new Error("request too large");
  const bytes = original.toString("utf8");
  let nativeFailure: unknown;
  try { return { native: true, request: readNativeProbeRequest(bytes) }; }
  catch (error) { nativeFailure = error; }
  const value: unknown = JSON.parse(bytes);
  if (reserved(bytes)) throw nativeFailure;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid request");
  return { native: false, request: value as Record<string, unknown> };
}
