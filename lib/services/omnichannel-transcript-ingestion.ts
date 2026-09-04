export type TranscriptChannel = "whatsapp" | "email" | "call";
export type TranscriptDirection = "inbound" | "outbound" | "summary";

export interface OmnichannelWebhookRequest {
  channel: TranscriptChannel;
  deliveryId: string;
  signature: string;
  signatureTimestamp: number;
  receivedAt: number;
  rawBody: string;
  contentType?: string | null;
}

export interface DecodedTranscriptMessage {
  messageId: string;
  customerExternalId: string;
  direction: TranscriptDirection;
  sender: string;
  recipient: string;
  text: string;
  subject?: string | null;
  occurredAt: number;
  threadId?: string | null;
}

export interface TranscriptMessage extends DecodedTranscriptMessage {
  channel: TranscriptChannel;
  deliveryId: string;
}

export interface OmnichannelTranscriptEvent {
  deliveryId: string;
  channel: TranscriptChannel;
  receivedAt: number;
  bodySha256: string;
  contentType: string | null;
  messages: TranscriptMessage[];
}

export interface OmnichannelWebhookVerifier {
  verify(input: {
    channel: TranscriptChannel;
    rawBody: string;
    signature: string;
    signatureTimestamp: number;
  }): boolean | Promise<boolean>;
}

export interface OmnichannelTranscriptDecoder {
  decode(input: {
    channel: TranscriptChannel;
    rawBody: string;
    contentType: string | null;
  }): DecodedTranscriptMessage[] | Promise<DecodedTranscriptMessage[]>;
}

export interface OmnichannelTranscriptSink {
  hasDelivery(deliveryId: string): boolean | Promise<boolean>;
  store(event: OmnichannelTranscriptEvent): void | Promise<void>;
}

export interface OmnichannelIngestionDependencies {
  verifier: OmnichannelWebhookVerifier;
  decoder: OmnichannelTranscriptDecoder;
  sink: OmnichannelTranscriptSink;
}

export type OmnichannelIngestionResult =
  | { status: "accepted"; deliveryId: string; messageCount: number; bodySha256: string }
  | { status: "duplicate"; deliveryId: string; messageCount: 0; bodySha256: null }
  | { status: "rejected"; deliveryId: string; messageCount: 0; bodySha256: null; reason: string };

const MAX_BODY_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARACTERS = 20_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function cleanRequired(value: string, field: string, maxLength = 512): string {
  const normalized = value.replace(/\0/g, "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function cleanOptional(value: string | null | undefined, maxLength = 512): string | null {
  if (value == null) return null;
  const normalized = value.replace(/\0/g, "").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function validateTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive timestamp`);
  return value;
}

function normalizeMessage(
  request: OmnichannelWebhookRequest,
  decoded: DecodedTranscriptMessage,
): TranscriptMessage {
  const occurredAt = validateTimestamp(decoded.occurredAt, "message.occurredAt");
  const text = cleanRequired(decoded.text, "message.text", MAX_MESSAGE_CHARACTERS);
  return {
    messageId: cleanRequired(decoded.messageId, "message.messageId"),
    customerExternalId: cleanRequired(decoded.customerExternalId, "message.customerExternalId"),
    direction: decoded.direction,
    sender: cleanRequired(decoded.sender, "message.sender"),
    recipient: cleanRequired(decoded.recipient, "message.recipient"),
    text,
    subject: cleanOptional(decoded.subject, 500),
    occurredAt,
    threadId: cleanOptional(decoded.threadId),
    channel: request.channel,
    deliveryId: request.deliveryId,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function replaySafe(request: OmnichannelWebhookRequest): boolean {
  return Math.abs(request.receivedAt - request.signatureTimestamp) <= MAX_CLOCK_SKEW_MS;
}

export async function ingestOmnichannelWebhook(
  request: OmnichannelWebhookRequest,
  dependencies: OmnichannelIngestionDependencies,
): Promise<OmnichannelIngestionResult> {
  const deliveryId = cleanRequired(request.deliveryId, "deliveryId");
  validateTimestamp(request.receivedAt, "receivedAt");
  validateTimestamp(request.signatureTimestamp, "signatureTimestamp");

  if (!request.signature.trim()) {
    return { status: "rejected", deliveryId, messageCount: 0, bodySha256: null, reason: "missing_signature" };
  }
  if (new TextEncoder().encode(request.rawBody).byteLength > MAX_BODY_BYTES) {
    return { status: "rejected", deliveryId, messageCount: 0, bodySha256: null, reason: "payload_too_large" };
  }
  if (!replaySafe(request)) {
    return { status: "rejected", deliveryId, messageCount: 0, bodySha256: null, reason: "replay_window_exceeded" };
  }
  if (await dependencies.sink.hasDelivery(deliveryId)) {
    return { status: "duplicate", deliveryId, messageCount: 0, bodySha256: null };
  }

  const verified = await dependencies.verifier.verify({
    channel: request.channel,
    rawBody: request.rawBody,
    signature: request.signature,
    signatureTimestamp: request.signatureTimestamp,
  });
  if (!verified) {
    return { status: "rejected", deliveryId, messageCount: 0, bodySha256: null, reason: "signature_verification_failed" };
  }

  const decoded = await dependencies.decoder.decode({
    channel: request.channel,
    rawBody: request.rawBody,
    contentType: cleanOptional(request.contentType, 128),
  });
  if (!Array.isArray(decoded) || decoded.length === 0) {
    return { status: "rejected", deliveryId, messageCount: 0, bodySha256: null, reason: "no_transcript_messages" };
  }

  const messages = decoded.map((message) => normalizeMessage(request, message));
  const bodySha256 = await sha256Hex(request.rawBody);
  await dependencies.sink.store({
    deliveryId,
    channel: request.channel,
    receivedAt: request.receivedAt,
    bodySha256,
    contentType: cleanOptional(request.contentType, 128),
    messages,
  });

  return { status: "accepted", deliveryId, messageCount: messages.length, bodySha256 };
}

export function createOmnichannelTranscriptWebhookHandler(dependencies: OmnichannelIngestionDependencies) {
  return (request: OmnichannelWebhookRequest) => ingestOmnichannelWebhook(request, dependencies);
}
