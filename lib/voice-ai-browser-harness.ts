type Env = Record<string, unknown>;
type AiBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
};
type WorkerSocket = WebSocket & {
  accept(options?: { allowHalfOpen?: boolean }): void;
};
type WorkerWebSocketPair = { 0: WorkerSocket; 1: WorkerSocket };
type WorkerWebSocketPairCtor = new () => WorkerWebSocketPair;
type ChatMessage = { role: "user" | "assistant"; content: string };

const DIRECT_PATH = "/voice/ai-self-test";
const DIRECT_SAMPLE_RATE = 16000;
const DIRECT_TICKET_TTL_MS = 2 * 60_000;
const DIRECT_SESSION_LIMIT_MS = 5 * 60_000;
const MAX_TURNS = 12;
const encoder = new TextEncoder();

const text = (value: unknown) => String(value ?? "").trim();
const truthy = (value: unknown) => text(value).toLowerCase() === "true";

function aiBinding(env: Env): AiBinding | null {
  const ai = env.AI as AiBinding | undefined;
  return ai && typeof ai.run === "function" ? ai : null;
}

function signingSecret(env: Env) {
  return text(env.PAWSPACE_UAT_SIGNING_KEY);
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function createWebSocketPair() {
  const Ctor = (globalThis as unknown as { WebSocketPair?: WorkerWebSocketPairCtor })
    .WebSocketPair;
  if (!Ctor) {
    throw new Error("Cloudflare WebSocketPair is unavailable in this runtime");
  }
  return new Ctor();
}

export type DirectBrowserVoiceReadiness = {
  enabled: boolean;
  mode: string;
  deployment: string;
  approved: boolean;
  aiBindingConfigured: boolean;
  signingKeyConfigured: boolean;
  sampleRate: number;
  reason: string | null;
};

export function directBrowserVoiceReadiness(env: Env): DirectBrowserVoiceReadiness {
  const mode = text(env.PAWSPACE_VOICE_ENV).toLowerCase();
  const deployment = text(env.PAWSPACE_DEPLOYMENT_ENV || env.PAWSPACE_ENV).toLowerCase();
  const approved = truthy(env.PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED);
  const aiReady = Boolean(aiBinding(env));
  const signerReady = signingSecret(env).length >= 32;
  const nonProduction = ["staging", "uat", "development", "dev", "test"].includes(
    deployment,
  );
  let reason: string | null = null;

  if (mode !== "uat") {
    reason = "Browser voice harness requires PAWSPACE_VOICE_ENV=uat";
  } else if (!nonProduction) {
    reason = "Browser voice harness is disabled outside staging/dev/test deployments";
  } else if (!approved) {
    reason = "PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED is not true";
  } else if (!aiReady) {
    reason = "Cloudflare Workers AI binding (AI) is not configured";
  } else if (!signerReady) {
    reason = "PAWSPACE_UAT_SIGNING_KEY is unavailable for browser harness tickets";
  }

  return {
    enabled: !reason,
    mode,
    deployment,
    approved,
    aiBindingConfigured: aiReady,
    signingKeyConfigured: signerReady,
    sampleRate: DIRECT_SAMPLE_RATE,
    reason,
  };
}

export async function issueDirectBrowserVoiceTicket(env: Env, publicOrigin: string) {
  const readiness = directBrowserVoiceReadiness(env);
  if (!readiness.enabled) {
    return { ok: false as const, status: 409, reason: readiness.reason, readiness };
  }

  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    return {
      ok: false as const,
      status: 400,
      reason: "Browser voice harness origin is invalid",
      readiness,
    };
  }
  if (origin.protocol !== "https:") {
    return {
      ok: false as const,
      status: 409,
      reason: "Browser voice harness requires an HTTPS UAT origin",
      readiness,
    };
  }

  const ticketId = `AIVB-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const expiresAt = Date.now() + DIRECT_TICKET_TTL_MS;
  const signature = await hmac(
    signingSecret(env),
    `ai-browser:${ticketId}:${expiresAt}:${DIRECT_SAMPLE_RATE}`,
  );
  const wsUrl = new URL(DIRECT_PATH, origin);
  wsUrl.protocol = "wss:";
  wsUrl.searchParams.set("mode", "direct");
  wsUrl.searchParams.set("ticket", ticketId);
  wsUrl.searchParams.set("exp", String(expiresAt));
  wsUrl.searchParams.set("sig", signature);
  wsUrl.searchParams.set("sample-rate", String(DIRECT_SAMPLE_RATE));

  return {
    ok: true as const,
    status: 201,
    ticketId,
    wsUrl: wsUrl.toString(),
    sampleRate: DIRECT_SAMPLE_RATE,
    expiresAt,
    sessionLimitSeconds: Math.round(DIRECT_SESSION_LIMIT_MS / 1000),
    readiness,
  };
}

async function verifyDirectTicket(request: Request, env: Env) {
  const url = new URL(request.url);
  const ticketId = text(url.searchParams.get("ticket"));
  const expiresAt = Number(url.searchParams.get("exp"));
  const signature = text(url.searchParams.get("sig")).toLowerCase();
  const sampleRate = Number(url.searchParams.get("sample-rate"));
  if (
    url.searchParams.get("mode") !== "direct" ||
    !ticketId.startsWith("AIVB-") ||
    !Number.isFinite(expiresAt) ||
    !signature ||
    sampleRate !== DIRECT_SAMPLE_RATE
  ) {
    return { ok: false as const };
  }
  if (Date.now() > expiresAt || expiresAt - Date.now() > DIRECT_TICKET_TTL_MS) {
    return { ok: false as const };
  }
  const expected = await hmac(
    signingSecret(env),
    `ai-browser:${ticketId}:${expiresAt}:${DIRECT_SAMPLE_RATE}`,
  );
  return safeEqual(expected, signature)
    ? { ok: true as const, ticketId }
    : { ok: false as const };
}

function llmText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const row = result as Record<string, unknown>;
  return typeof row.response === "string"
    ? row.response.trim()
    : typeof row.result === "string"
      ? row.result.trim()
      : "";
}

async function answer(ai: AiBinding, history: ChatMessage[], question: string) {
  const messages = [
    {
      role: "system",
      content:
        "You are PawSpace's internal browser voice UAT assistant. Answer naturally and concisely in one or two spoken sentences. You may answer general questions and explain PawSpace services, but do not execute bookings, payments, refunds, price changes, discounts, account changes, or other high-impact actions. Never claim an action was completed. Avoid markdown.",
    },
    ...history.slice(-8),
    { role: "user", content: question },
  ];
  return llmText(
    await ai.run("@cf/openai/gpt-oss-20b", {
      messages,
      max_tokens: 220,
      temperature: 0.4,
    }),
  ).slice(0, 800);
}

async function ttsPcm(ai: AiBinding, message: string) {
  const result = await ai.run(
    "@cf/deepgram/aura-1",
    {
      text: message,
      speaker: "asteria",
      encoding: "linear16",
      container: "none",
      sample_rate: DIRECT_SAMPLE_RATE,
    },
    { returnRawResponse: true },
  );
  if (result instanceof Response) {
    return new Uint8Array(await result.arrayBuffer());
  }
  if (result && typeof (result as { getReader?: unknown }).getReader === "function") {
    return new Uint8Array(
      await new Response(result as ReadableStream<Uint8Array>).arrayBuffer(),
    );
  }
  throw new Error("Workers AI TTS returned no raw audio response");
}

export async function handleDirectBrowserVoiceHarnessStream(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== DIRECT_PATH || url.searchParams.get("mode") !== "direct") {
    return new Response("Not found", { status: 404 });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected websocket upgrade", { status: 426 });
  }

  const readiness = directBrowserVoiceReadiness(env);
  if (!readiness.enabled) {
    return new Response("Browser voice harness is disabled", { status: 503 });
  }
  const ticket = await verifyDirectTicket(request, env);
  if (!ticket.ok) {
    return new Response("Unauthorized browser voice harness ticket", { status: 401 });
  }
  const ai = aiBinding(env);
  if (!ai) {
    return new Response("Workers AI binding is unavailable", { status: 503 });
  }

  const pair = createWebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept({ allowHalfOpen: true });

  let flux: WorkerSocket | null = null;
  let started = false;
  let closed = false;
  let turnCount = 0;
  let queue = Promise.resolve();
  const history: ChatMessage[] = [];

  const sendJson = (payload: Record<string, unknown>) => {
    if (!closed && server.readyState === WebSocket.OPEN) {
      server.send(JSON.stringify(payload));
    }
  };

  const sendSpeech = async (message: string, purpose: string, turnStartedAt?: number) => {
    const ttsStartedAt = Date.now();
    sendJson({ type: "status", stage: "tts_start", purpose, at: ttsStartedAt });
    const audio = await ttsPcm(ai, message);
    const ttsLatencyMs = Date.now() - ttsStartedAt;
    sendJson({
      type: "audio",
      purpose,
      format: "linear16",
      sampleRate: DIRECT_SAMPLE_RATE,
      bytes: audio.byteLength,
      ttsLatencyMs,
      totalLatencyMs: turnStartedAt ? Date.now() - turnStartedAt : ttsLatencyMs,
    });
    const payload = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
    server.send(payload);
    sendJson({ type: "status", stage: "tts_sent", purpose, bytes: audio.byteLength });
  };

  const processQuestion = (question: string) => {
    const clean = question.trim();
    if (!clean || turnCount >= MAX_TURNS) return;
    queue = queue
      .then(async () => {
        turnCount += 1;
        const turnStartedAt = Date.now();
        sendJson({ type: "transcript", text: clean, turn: turnCount, at: turnStartedAt });
        sendJson({ type: "status", stage: "llm_start", turn: turnCount });
        let reply = "";
        try {
          reply = await answer(ai, history, clean);
        } catch {
          reply = "I could not reach the AI answer service. Please try that question again.";
        }
        if (!reply) reply = "I do not have a reliable answer for that. Please ask another question.";
        history.push({ role: "user", content: clean }, { role: "assistant", content: reply });
        sendJson({
          type: "reply",
          text: reply,
          turn: turnCount,
          llmLatencyMs: Date.now() - turnStartedAt,
        });
        await sendSpeech(reply, `turn-${turnCount}`, turnStartedAt);
      })
      .catch((error) => {
        sendJson({
          type: "error",
          stage: "turn",
          message: error instanceof Error ? error.message : "Browser voice turn failed",
        });
      });
  };

  const attachFlux = (socket: WorkerSocket) => {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const kind = text(payload.event || payload.type);
      if (kind === "StartOfTurn") {
        sendJson({ type: "status", stage: "speech_detected" });
      }
      if (kind === "EndOfTurn") {
        const transcript = text(payload.transcript);
        if (transcript) processQuestion(transcript);
      }
    });
    socket.addEventListener("error", () => {
      sendJson({ type: "error", stage: "stt", message: "Workers AI Flux failed" });
    });
    socket.addEventListener("close", () => {
      flux = null;
      sendJson({ type: "status", stage: "stt_closed" });
    });
  };

  const initializeFlux = async () => {
    if (flux && flux.readyState === WebSocket.OPEN) return;
    sendJson({ type: "status", stage: "stt_connecting", sampleRate: DIRECT_SAMPLE_RATE });
    const fluxResponse = (await ai.run(
      "@cf/deepgram/flux",
      {
        encoding: "linear16",
        sample_rate: String(DIRECT_SAMPLE_RATE),
        eot_threshold: "0.65",
        eot_timeout_ms: "1200",
        mip_opt_out: "true",
        tag: "pawspace-uat-browser-voice-harness",
      },
      { websocket: true },
    )) as Response & { webSocket?: WorkerSocket };
    const socket = fluxResponse.webSocket;
    if (!socket) {
      throw new Error("Workers AI Flux did not open a WebSocket");
    }
    socket.accept({ allowHalfOpen: true });
    flux = socket;
    attachFlux(socket);
    sendJson({ type: "status", stage: "stt_ready", sampleRate: DIRECT_SAMPLE_RATE });
  };

  const sessionTimer = setTimeout(() => {
    sendJson({ type: "status", stage: "session_limit" });
    try {
      server.close(1000, "browser voice UAT session limit");
    } catch {
      // ignore close races
    }
  }, DIRECT_SESSION_LIMIT_MS);

  sendJson({
    type: "status",
    stage: "connected",
    ticketId: ticket.ticketId,
    sampleRate: DIRECT_SAMPLE_RATE,
  });

  server.addEventListener("message", (event) => {
    void (async () => {
      if (typeof event.data === "string") {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = text(payload.type);
        if (type === "start" && !started) {
          started = true;
          sendJson({ type: "status", stage: "started", sampleRate: DIRECT_SAMPLE_RATE });
          void initializeFlux().catch((error) => {
            sendJson({
              type: "error",
              stage: "stt_init",
              message: error instanceof Error ? error.message : "Unable to initialize Flux",
            });
          });
          await sendSpeech("Hello, this is the PawSpace voice UAT test.", "opening");
          return;
        }
        if (type === "stop") {
          server.close(1000, "browser voice test stopped");
        }
        return;
      }

      if (!started || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 2) return;
      const audio = event.data;
      if (!flux || flux.readyState !== WebSocket.OPEN) {
        try {
          await initializeFlux();
        } catch {
          return;
        }
      }
      if (flux?.readyState === WebSocket.OPEN) {
        flux.send(audio);
      }
    })().catch((error) => {
      sendJson({
        type: "error",
        stage: "socket_message",
        message: error instanceof Error ? error.message : "Browser voice socket message failed",
      });
    });
  });

  server.addEventListener("close", () => {
    closed = true;
    clearTimeout(sessionTimer);
    try {
      flux?.close(1000, "browser harness closed");
    } catch {
      // ignore close races
    }
  });
  server.addEventListener("error", () => {
    sendJson({ type: "error", stage: "socket", message: "Browser voice socket failed" });
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}
