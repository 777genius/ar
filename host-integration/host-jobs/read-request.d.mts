import type { Readable } from "node:stream";
export function readRequestBytes(input: Readable, options?: { readonly timeoutMs?: number }): Promise<Buffer>;
export function readRequest(input: Readable, options?: { readonly timeoutMs?: number }): Promise<unknown>;
