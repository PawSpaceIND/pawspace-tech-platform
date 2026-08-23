/**
 * The only way voice code is allowed to dereference a URL it did not construct itself.
 *
 * Audio references and transcript references arrive from outside: a caller posting to
 * /api/voice-speech, an STT/TTS vendor response, a telephony provider's recording callback. Fetching
 * one of those with a bare fetch() turns this Worker into a request forwarder positioned inside the
 * network perimeter - the classic SSRF shape, and on a cloud runtime the highest-value target is the
 * instance metadata service, which answers unauthenticated HTTP with credentials.
 *
 * The guard that existed covered the first-party Workers AI path only, matched private ranges as
 * string prefixes, and then called plain fetch() - which follows redirects. A permitted host
 * answering 302 -> http://169.254.169.254/ defeated it entirely. It also had no timeout, no size
 * bound and no media-type check, so a hostile or broken endpoint could hang the request or hand back
 * an arbitrary payload to be treated as audio.
 *
 * This module fixes the class: one validator, applied to the initial URL and independently to EVERY
 * redirect hop, with a bounded body, a bounded wall-clock and a checked media type.
 */

/** Deny-listed hostnames, exact match after lowercasing and stripping any trailing dot. */
const DENIED_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  // Cloud instance metadata services. Reaching any of these yields credentials.
  "metadata", "metadata.google.internal", "metadata.goog",
  "instance-data", "instance-data.ec2.internal",
  "metadata.azure.com", "metadata.azure.net",
  "100.100.100.200",            // Alibaba Cloud metadata
  "169.254.169.254", "169.254.170.2", // AWS/GCP/Azure IMDS, ECS task metadata
  "fd00:ec2::254",              // AWS IMDS over IPv6
]);

/** Deny-listed suffixes: internal service discovery and split-horizon names. */
const DENIED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".ec2.internal", ".svc", ".svc.cluster.local", ".cluster.local"];

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * Every IPv4 range that must never be reachable. Ranges, not string prefixes: a prefix test on "10."
 * also rejects the public 100.x and misses 172.16-31 entirely, which is how prefix-matching guards
 * end up both over- and under-blocking.
 */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true;                                   // 0.0.0.0/8 "this host"
  if (a === 10) return true;                                  // RFC1918
  if (a === 127) return true;                                 // loopback
  if (a === 169 && b === 254) return true;                    // link-local, includes IMDS 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;           // RFC1918
  if (a === 192 && b === 168) return true;                    // RFC1918
  if (a === 192 && b === 0) return true;                       // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;          // RFC6598 carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a === 192 && b === 88) return true;                      // 6to4 relay anycast
  if (a >= 224) return true;                                   // multicast + reserved 240/4 + broadcast
  return false;
}

/**
 * Expand an IPv6 literal to its 8 hextets, or null if it is not one.
 *
 * This has to be real parsing rather than prefix matching, because the WHATWG URL parser rewrites the
 * address before we ever see it: `[::ffff:127.0.0.1]` normalises to `[::ffff:7f00:1]`, so a guard that
 * looks for a trailing dotted quad finds nothing and lets IPv4-mapped loopback straight through.
 */
function ipv6Hextets(host: string): number[] | null {
  let raw = host.replace(/^\[|\]$/g, "").toLowerCase().split("%")[0];
  if (!raw.includes(":")) return null;
  // A trailing dotted quad (the un-normalised form) becomes two hextets.
  const dotted = raw.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const octets = ipv4Parts(dotted[2]);
    if (!octets) return null;
    raw = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => part ? part.split(":").map(group => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN)) : [];
  const head = parse(halves[0]), tail = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...tail].some(value => !Number.isInteger(value))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

function isPrivateIpv6(host: string): boolean {
  const hextets = ipv6Hextets(host);
  if (!hextets) return false;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  if (hextets.every(value => value === 0)) return true;                       // ::
  if (hextets.slice(0, 7).every(value => value === 0) && h7 === 1) return true; // ::1
  // Any address that carries an IPv4 address inside it is only as safe as that IPv4 address:
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  const embedsIpv4 =
    (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0 || h5 === 0xffff)) ||
    (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0);
  if (embedsIpv4) {
    const octets = [h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff];
    if (isPrivateIpv4(octets)) return true;
  }
  if ((h0 & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((h0 & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  if ((h0 & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
  return false;
}

export function isBlockedVoiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  if (!bare) return true;
  if (DENIED_HOSTNAMES.has(host) || DENIED_HOSTNAMES.has(bare)) return true;
  if (DENIED_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  const octets = ipv4Parts(bare);
  if (octets) return isPrivateIpv4(octets);
  return isPrivateIpv6(host);
}

export type SafeFetchOptions = {
  /** Optional extra restriction: when non-empty, the host must also appear here. */
  allowedHosts?: string[];
  /** Base media types accepted, e.g. ["audio/mpeg","audio/wav"]. "audio/*" is honoured. */
  allowedMediaTypes?: string[];
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Injected in tests. Production passes nothing and gets the runtime fetch. */
  fetchImpl?: typeof fetch;
};

export const VOICE_AUDIO_MEDIA_TYPES = ["audio/*", "application/octet-stream"];
export const DEFAULT_VOICE_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_VOICE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

/** Refusals carry a stable `code` so callers can map them to a failure class without string matching. */
export class VoiceFetchRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "VoiceFetchRefused"; this.code = code; }
}

export function assertSafeVoiceUrl(reference: string, options: SafeFetchOptions = {}): URL {
  let url: URL;
  try { url = new URL(String(reference ?? "")); }
  catch { throw new VoiceFetchRefused("invalid_url", "Invalid media reference"); }
  // https only. http is not permitted even to a public host: a plaintext hop is trivially
  // redirected, and every provider we would legitimately talk to serves https.
  if (url.protocol !== "https:") throw new VoiceFetchRefused("unsupported_scheme", `Unsupported media URL scheme: ${url.protocol.replace(":", "")}`);
  if (url.username || url.password) throw new VoiceFetchRefused("credentials_in_url", "Media URL must not embed credentials");
  if (isBlockedVoiceHost(url.hostname)) throw new VoiceFetchRefused("private_host", "Media URL host is not routable from this service");
  const allowed = (options.allowedHosts || []).map(host => host.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(url.hostname.toLowerCase())) throw new VoiceFetchRefused("host_not_allowlisted", "Media URL host is not on the allow-list");
  return url;
}

function mediaTypeAllowed(contentType: string, allowed: string[]): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (!base) return false;
  return allowed.some(entry => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return base.startsWith(`${pattern.slice(0, -1)}`);
    return base === pattern;
  });
}

/**
 * Fetch a validated URL with a bounded body, a bounded wall-clock and a checked media type,
 * re-validating the destination at every redirect hop rather than letting the runtime follow them.
 */
export async function safeVoiceFetch(reference: string, options: SafeFetchOptions = {}) {
  const allowedMediaTypes = options.allowedMediaTypes || VOICE_AUDIO_MEDIA_TYPES;
  const maxBytes = options.maxBytes ?? DEFAULT_VOICE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const doFetch = options.fetchImpl || (globalThis.fetch as typeof fetch);
  if (typeof doFetch !== "function") throw new VoiceFetchRefused("no_transport", "No fetch transport is available");

  let target = assertSafeVoiceUrl(reference, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let response: Response;
      try { response = await doFetch(target.toString(), { redirect: "manual", signal: controller.signal, headers: { accept: allowedMediaTypes.join(", ") } }); }
      catch (error) {
        if (controller.signal.aborted) throw new VoiceFetchRefused("timeout", `Media fetch exceeded ${timeoutMs}ms`);
        throw new VoiceFetchRefused("transport_error", `Media fetch failed: ${String((error as Error)?.message || error).slice(0, 120)}`);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new VoiceFetchRefused("bad_redirect", "Redirect without a location");
        if (hop === maxRedirects) throw new VoiceFetchRefused("too_many_redirects", "Media URL redirected too many times");
        // The whole point: the hop is validated exactly as strictly as the original URL, so a
        // permitted host cannot bounce us onto loopback, RFC1918 or the metadata service.
        let next: URL;
        try { next = new URL(location, target); }
        catch { throw new VoiceFetchRefused("bad_redirect", "Redirect location is not a valid URL"); }
        target = assertSafeVoiceUrl(next.toString(), options);
        continue;
      }
      if (!response.ok) throw new VoiceFetchRefused("http_error", `Media fetch returned ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!mediaTypeAllowed(contentType, allowedMediaTypes)) throw new VoiceFetchRefused("invalid_media_type", `Unsupported media type: ${contentType || "unset"}`);
      const declared = Number(response.headers.get("content-length") || 0);
      if (Number.isFinite(declared) && declared > maxBytes) throw new VoiceFetchRefused("too_large", `Media payload declares ${declared} bytes, over the ${maxBytes} limit`);
      // content-length is a claim. Read with a running cap so a server that under-declares, or sends
      // a chunked stream with no length at all, still cannot exhaust this isolate.
      const bytes = await readCapped(response, maxBytes);
      return { url: target.toString(), mediaType: contentType.split(";")[0].trim().toLowerCase(), bytes };
    }
    throw new VoiceFetchRefused("too_many_redirects", "Media URL redirected too many times");
  } finally { clearTimeout(timer); }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new VoiceFetchRefused("too_large", `Media payload is over the ${maxBytes} byte limit`);
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new VoiceFetchRefused("too_large", `Media payload is over the ${maxBytes} byte limit`); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * Inline audio. A data: URL never leaves the isolate, so there is no SSRF surface - but it is still
 * attacker-controlled length and type, so both are checked the same way a fetched body is.
 */
export function decodeInlineAudio(reference: string, options: { allowedMediaTypes?: string[]; maxBytes?: number } = {}) {
  const allowedMediaTypes = options.allowedMediaTypes || VOICE_AUDIO_MEDIA_TYPES;
  const maxBytes = options.maxBytes ?? DEFAULT_VOICE_MAX_BYTES;
  // Written without the /s flag: the tsconfig target predates dotAll, and [\s\S] is exactly what it
  // means anyway - base64 payloads are long and may contain newlines.
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(String(reference ?? ""));
  if (!match) throw new VoiceFetchRefused("invalid_url", "Invalid inline audio reference");
  const mediaType = (match[1] || "").trim().toLowerCase();
  if (!mediaTypeAllowed(mediaType, allowedMediaTypes)) throw new VoiceFetchRefused("invalid_media_type", `Unsupported inline media type: ${mediaType || "unset"}`);
  if (!match[2]) throw new VoiceFetchRefused("invalid_media_type", "Inline audio must be base64 encoded");
  let binary: string;
  try { binary = atob(match[3]); }
  catch { throw new VoiceFetchRefused("invalid_payload", "Inline audio is not valid base64"); }
  if (binary.length > maxBytes) throw new VoiceFetchRefused("too_large", `Inline audio is over the ${maxBytes} byte limit`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return { mediaType, bytes };
}

/** True for a data: reference, so callers can route to decodeInlineAudio without re-parsing. */
export function isInlineAudioReference(reference: unknown): boolean {
  return /^data:/i.test(String(reference ?? "").trim());
}
