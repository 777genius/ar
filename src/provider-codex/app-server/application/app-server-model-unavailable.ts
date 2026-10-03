import { CodexModelUnavailableError, hasCodexModel, isCodexModelUnavailableMessage, type CodexModelCatalogEntry } from "../domain/model-catalog";
import { readCodexModelCatalogPage } from "../protocol/app-server-model-catalog";
import type { CodexAppServerJsonRpcResponse } from "../protocol/app-server-json-rpc";

export async function modelUnavailableError(input: {
  readonly requestedModel: string;
  readonly providerMessage?: string;
  readonly timeoutMs: number;
  readonly abortSignal: AbortSignal;
  readonly sendPage: (cursor: string | null) => Promise<CodexAppServerJsonRpcResponse>;
}): Promise<CodexModelUnavailableError | null> {
  if (!isCodexModelUnavailableMessage(input.providerMessage ?? "")) return null;
  const availableModels = await readAvailableModels(input.sendPage).catch(() => null);
  if (availableModels === null || hasCodexModel(availableModels, input.requestedModel)) return null;
  return new CodexModelUnavailableError({ requestedModel: input.requestedModel, availableModels });
}

async function readAvailableModels(sendPage: (cursor: string | null) => Promise<CodexAppServerJsonRpcResponse>): Promise<readonly CodexModelCatalogEntry[] | null> {
  const entries: CodexModelCatalogEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const response = await sendPage(cursor);
    if (response.error) return null;
    const page = readCodexModelCatalogPage(response.result);
    if (!page) return null;
    entries.push(...page.data);
    if (entries.length > 500) return null;
    if (page.nextCursor === null) return entries.length === 0 ? null : entries;
    if (seenCursors.has(page.nextCursor)) return null;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return null;
}
