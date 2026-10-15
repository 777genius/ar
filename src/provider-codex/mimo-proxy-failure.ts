/** Closed observations only: never serialize fetch errors, headers or bodies. */
export enum MimoProxyFailureReason {
  Http = "upstream_http_error",
  Response = "upstream_response_invalid",
  Transport = "upstream_transport_error",
  EmptyBody = "upstream_body_missing",
  ContentType = "upstream_content_type_invalid",
  Stream = "upstream_stream_error",
  Timeout = "request_timeout",
  Revoked = "authority_revoked",
  Disconnected = "client_disconnected",
  Input = "request_read_error",
}
export enum MimoProxyFailurePhase {
  Input = "request_body",
  Transport = "upstream_request",
  Response = "upstream_response",
  Stream = "response_stream",
}
export enum MimoProxyTransportCode {
  Unknown = "unknown",
  Reset = "ECONNRESET",
  Refused = "ECONNREFUSED",
  Dns = "ENOTFOUND",
  DnsTemporary = "EAI_AGAIN",
  Timeout = "ETIMEDOUT",
  ConnectTimeout = "UND_ERR_CONNECT_TIMEOUT",
  HeadersTimeout = "UND_ERR_HEADERS_TIMEOUT",
  BodyTimeout = "UND_ERR_BODY_TIMEOUT",
  Socket = "UND_ERR_SOCKET",
  CertificateExpired = "CERT_HAS_EXPIRED",
  CertificateAuthority = "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
}
export enum MimoProxyValidationCode {
  Unknown = "unknown",
  Bytes = "response_limit",
  Frame = "response_frame_limit",
  Lookahead = "response_lookahead_limit",
  Depth = "response_depth",
  Event = "response_event_invalid",
  Identity = "response_text_identity_invalid",
  LateDelta = "response_delta_after_done",
  Json = "response_json_invalid",
  Utf8 = "response_utf8_invalid",
}
export type MimoProxyFailure = Readonly<{
  reason: MimoProxyFailureReason;
  phase: MimoProxyFailurePhase;
  elapsed_ms: number;
  request_number: number;
  upstream_status?: number;
  transport_code?: MimoProxyTransportCode;
  validation_code?: MimoProxyValidationCode;
}>;

/** Rebuild public diagnostics from closed fields, never forwarding result JSON. */
export function parseMimoProxyFailureDetails(input: unknown): MimoProxyFailure | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    const own = (key: string): unknown => {
      const d = Object.getOwnPropertyDescriptor(input, key);
      return d && "value" in d ? d.value : undefined;
    };
    const reason = Object.values(MimoProxyFailureReason).find(v => v === own("mimoProxyReason"));
    const phase = Object.values(MimoProxyFailurePhase).find(v => v === own("mimoProxyPhase"));
    const integer = (value: unknown, min: number, max: number): number | undefined => {
      if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
      const n = Number(value);
      return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
    };
    const elapsed = integer(own("mimoProxyElapsedMs"), 0, Number.MAX_SAFE_INTEGER);
    const request = integer(own("mimoProxyRequestNumber"), 1, 4096);
    if (!reason || !phase || elapsed === undefined || request === undefined) return undefined;
    const statusValue = own("mimoUpstreamStatus"), transportValue = own("mimoTransportCode"), validationValue = own("mimoValidationCode");
    const status = integer(statusValue, 100, 599);
    const transport = Object.values(MimoProxyTransportCode).find(v => v === transportValue);
    const validation = Object.values(MimoProxyValidationCode).find(v => v === validationValue);
    if (statusValue !== undefined && status === undefined || transportValue !== undefined && transport === undefined ||
        validationValue !== undefined && validation === undefined) return undefined;
    return Object.freeze({ reason, phase, elapsed_ms: elapsed, request_number: request,
      ...(status === undefined ? {} : { upstream_status: status }),
      ...(transport === undefined ? {} : { transport_code: transport }),
      ...(validation === undefined ? {} : { validation_code: validation }) });
  } catch { return undefined; }
}

export function mimoProxyValidationCode(error: unknown): MimoProxyValidationCode {
  try {
    if (error instanceof SyntaxError) return MimoProxyValidationCode.Json;
    if (error !== null && typeof error === "object") {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (code && "value" in code && code.value === "ERR_ENCODING_INVALID_ENCODED_DATA") return MimoProxyValidationCode.Utf8;
      const message = Object.getOwnPropertyDescriptor(error, "message");
      if (message && "value" in message) return Object.values(MimoProxyValidationCode).find(value => value === message.value) ?? MimoProxyValidationCode.Unknown;
    }
  } catch { /* Untrusted accessors and proxies never enter the observation. */ }
  return MimoProxyValidationCode.Unknown;
}

export function mimoProxyTransportCode(error: unknown): MimoProxyTransportCode {
  const seen = new Set<object>();
  for (let depth = 0; depth < 4 && error !== null && typeof error === "object"; depth++) {
    if (seen.has(error)) break;
    seen.add(error);
    try {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      if (code && "value" in code) {
        const known = Object.values(MimoProxyTransportCode).find(value => value === code.value);
        if (known) return known;
      }
      const cause = Object.getOwnPropertyDescriptor(error, "cause");
      error = cause && "value" in cause ? cause.value : undefined;
    } catch { break; }
  }
  return MimoProxyTransportCode.Unknown;
}
