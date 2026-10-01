import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { codexProviderEgressPolicy, CodexProviderEgressProfileId,
  type CodexProviderEgressPolicy } from "../../codex-provider-egress-policy";
import { PublicSourceAuthentication, PublicSourceBodyEncoding,
  publicResearchSourceLimits, type PublicResearchSourceReader, type PublicResearchSource } from "../application/public-research-source-port";

const maxBytes = publicResearchSourceLimits.bodyBytes;
const timeoutMs = publicResearchSourceLimits.timeoutMs;
const privateV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) privateV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
specialV6.addSubnet("2001::", 23, "ipv6");
specialV6.addSubnet("2001:db8::", 32, "ipv6");
specialV6.addSubnet("2002::", 16, "ipv6");
specialV6.addSubnet("3fff::", 20, "ipv6");

export function isPublicResearchAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4: return !privateV4.check(address, "ipv4");
    case 6: return globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
    default: return false;
  }
}

/** Uses the finite policy owner, never caller domain arrays or ambient proxy/auth env.
 * This single reader belongs to the job executor and is shared by its accounts. */
export function createPublicResearchSourceReader(admitted: CodexProviderEgressPolicy): PublicResearchSourceReader {
  if (admitted.profileId !== CodexProviderEgressProfileId.PublicResearchV1) {
    throw new Error("public_research_profile_required");
  }
  const hosts = codexProviderEgressPolicy(admitted.profileId).publicSourceDomains!;
  let outstanding = 0, reservedBytes = 0, deliveredBytes = 0;
  return Object.freeze({ read: async (value: string, signal?: AbortSignal) => {
    let url: URL;
    try {
      if (value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error();
      url = new URL(value);
      if (url.protocol !== "https:" || url.port || url.username || url.password ||
          url.search || url.hash || !hosts.includes(url.hostname)) throw new Error();
    } catch { throw new Error("public_research_url_denied"); }
    if (signal?.aborted) throw new Error("public_research_aborted");
    // Reserve before DNS or sockets, with no waiter queue and no burst allocation.
    if (outstanding >= publicResearchSourceLimits.concurrentRequests) throw new Error("public_research_capacity");
    const reservation = publicResearchSourceLimits.resultBytesPerCall;
    if (deliveredBytes + reservedBytes + reservation > publicResearchSourceLimits.totalResultBytes) {
      throw new Error("public_research_result_budget");
    }
    outstanding++; reservedBytes += reservation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(new Error("public_research_deadline")), timeoutMs);
    try {
      const addresses = await resolvePublicAddresses(url.hostname, controller.signal);
      if (controller.signal.aborted) throw new Error("public_research_aborted");
      const source = await retrieve(url, addresses, controller.signal);
      if (controller.signal.aborted) throw new Error("public_research_aborted");
      // The source JSON is itself the tool's inputText string. Account for its
      // second JSON escaping plus conservative framing, not just body bytes.
      const resultBytes = Buffer.byteLength(JSON.stringify(JSON.stringify(source)), "utf8") + 128;
      if (resultBytes > reservation) throw new Error("public_research_result_too_large");
      deliveredBytes += resultBytes;
      return source;
    } finally {
      clearTimeout(deadline); signal?.removeEventListener("abort", abort);
      outstanding--; reservedBytes -= reservation;
    }
  } });
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal) {
  // A private resolver per admitted read supports genuine DNS cancellation;
  // cancel() never disrupts another job or account's DNS work.
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const abort = () => resolver.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("public_research_aborted");
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) throw new Error(signal.reason instanceof Error && signal.reason.message === "public_research_deadline" ? "public_research_deadline" : "public_research_aborted");
    const addresses: { address: string; family: number }[] = [];
    for (const [index, answer] of answers.entries()) {
      if (answer.status === "fulfilled") addresses.push(...answer.value.map(address => ({ address, family: index === 0 ? 4 : 6 })));
      else if (!["ENODATA", "ENOTFOUND"].includes((answer.reason as NodeJS.ErrnoException).code ?? "")) {
        throw new Error("public_research_dns_failed");
      }
    }
    if (!addresses.length) throw new Error("public_research_dns_failed");
    if (addresses.length > 64 || addresses.some(row => !isPublicResearchAddress(row.address))) throw new Error("public_research_address_denied");
    return addresses;
  } finally { signal.removeEventListener("abort", abort); }
}

function retrieve(url: URL, addresses: readonly { address: string; family: number }[], signal: AbortSignal): Promise<PublicResearchSource> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = []; let size = 0;
    const fail = (code: string) => {
      if (settled) return;
      settled = true; chunks.length = 0;
      reject(new Error(code));
    };
    const req = request(url, {
      method: "GET", agent: false, signal, maxHeaderSize: 16 * 1024, rejectUnauthorized: true,
      headers: { "User-Agent": "subscription-runtime-public-research-v1", Accept: "*/*", "Accept-Encoding": "identity" },
      // DNS completed under cancellation before request creation. Only the
      // checked addresses reach the socket; hostname still verifies TLS/SNI.
      lookup: (_hostname, options, callback) => {
        if (signal.aborted) { callback(new Error("public_research_aborted"), "", 4); return; }
        if (options.all) callback(null, [...addresses]);
        else {
          const selected = addresses.find(row => !options.family || row.family === options.family);
          if (!selected) { callback(new Error("public_research_dns_failed"), "", 4); return; }
          callback(null, selected.address, selected.family);
        }
      },
    }, response => {
      const status = response.statusCode ?? 0;
      const refuse = (code: string) => { fail(code); response.destroy(); req.destroy(); };
      if (status >= 300 && status < 400) { refuse("public_research_redirect_denied"); return; }
      if (status !== 200) { refuse("public_research_http_failed"); return; }
      if (Number(response.headers["content-length"] ?? 0) > maxBytes) { refuse("public_research_source_too_large"); return; }
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) refuse("public_research_source_too_large");
        else chunks.push(chunk);
      });
      response.on("error", () => fail(signal.aborted ? "public_research_aborted" : "public_research_transport_failed"));
      response.on("aborted", () => fail(signal.aborted ? "public_research_aborted" : "public_research_transport_failed"));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const contentType = response.headers["content-type"] ?? "application/octet-stream";
        const textual = /^(?:text\/|application\/(?:json|[^;]+\+json|xml|javascript))/i.test(contentType);
        const body = Buffer.concat(chunks).toString(textual ? "utf8" : "base64"); chunks.length = 0;
        resolve({ url: url.href, retrievedAt: new Date().toISOString(), authentication: PublicSourceAuthentication.Anonymous,
          status, contentType, bodyEncoding: textual ? PublicSourceBodyEncoding.Utf8 : PublicSourceBodyEncoding.Base64, body });
      });
    });
    req.on("error", () => fail(signal.aborted
      ? signal.reason instanceof Error && signal.reason.message === "public_research_deadline" ? "public_research_deadline" : "public_research_aborted"
      : "public_research_transport_failed"));
    req.end();
  });
}
