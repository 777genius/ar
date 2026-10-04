export enum PublicSourceAuthentication {
  Anonymous = "anonymous",
}

export enum PublicSourceBodyEncoding {
  Utf8 = "utf8",
  Base64 = "base64",
}

export type PublicResearchSource = {
  readonly url: string;
  readonly retrievedAt: string;
  readonly authentication: PublicSourceAuthentication;
  readonly status: number;
  readonly contentType: string;
  readonly bodyEncoding: PublicSourceBodyEncoding;
  readonly body: string;
};

/** Host-side read-only capability. No headers, credentials, methods or redirect policy from callers. */
export type PublicResearchSourceReader = {
  read(url: string, signal?: AbortSignal): Promise<PublicResearchSource>;
};

/** Fixed per-job bounds shared by every account slot, never selected by tool input. */
export const publicResearchSourceLimits = Object.freeze({
  concurrentRequests: 2, bodyBytes: 512 * 1024, resultBytesPerCall: 1024 * 1024,
  totalResultBytes: 4 * 1024 * 1024, timeoutMs: 15_000, redirects: 3,
});
