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
