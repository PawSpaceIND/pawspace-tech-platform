"use client";

import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  StatCard,
  TeamAlert,
  TeamSection,
  TeamShell,
  TeamStatGrid,
  TeamTable,
} from "../../../components/ui";

type Readiness = {
  enabled: boolean;
  mode: string;
  approved: boolean;
  allowlistSize: number;
  singleRecipient: boolean;
  telephonyConfigured: boolean;
  aiBindingConfigured: boolean;
  reason: string | null;
  recording: false;
  maxCallSeconds: number;
};

type BrowserReadiness = {
  enabled: boolean;
  mode: string;
  deployment: string;
  approved: boolean;
  aiBindingConfigured: boolean;
  signingKeyConfigured: boolean;
  sampleRate: number;
  reason: string | null;
};

type StartResult = {
  callId: string;
  providerCallId: string;
  providerStatus: string;
  phoneLast4: string;
  quietHoursBypassed: boolean;
  recording: false;
  maxCallSeconds: number;
};

type BrowserTicket = {
  ticketId: string;
  wsUrl: string;
  sampleRate: number;
  expiresAt: number;
  sessionLimitSeconds: number;
};

type HarnessMessage = {
  type?: string;
  stage?: string;
  purpose?: string;
  text?: string;
  sampleRate?: number;
  bytes?: number;
  ttsLatencyMs?: number;
  llmLatencyMs?: number;
  totalLatencyMs?: number;
  message?: string;
};

type Diagnostic = {
  at: number;
  stage: string;
  detail: string;
};

async function readiness() {
  const response = await fetch("/api/voice-outbound?scope=ai_self_test", {
    cache: "no-store",
  });
  const body = (await response.json()) as { data?: Readiness; error?: string };
  if (!response.ok || !body.data) {
    throw new Error(body.error || `Unable to load AI voice self-test (${response.status})`);
  }
  return body.data;
}

async function browserReadiness() {
  const response = await fetch("/api/voice-outbound?scope=ai_browser_test", {
    cache: "no-store",
  });
  const body = (await response.json()) as { data?: BrowserReadiness; error?: string };
  if (!response.ok || !body.data) {
    throw new Error(body.error || `Unable to load browser voice test (${response.status})`);
  }
  return body.data;
}

async function start() {
  const response = await fetch("/api/voice-outbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "uat_ai_self_test" }),
  });
  const body = (await response.json()) as { data?: StartResult; error?: string };
  if (!response.ok || !body.data) {
    throw new Error(body.error || `AI voice self-test was refused (${response.status})`);
  }
  return body.data;
}

async function browserTicket() {
  const response = await fetch("/api/voice-outbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "uat_ai_browser_ticket" }),
  });
  const body = (await response.json()) as { data?: BrowserTicket; error?: string };
  if (!response.ok || !body.data) {
    throw new Error(body.error || `Browser voice test was refused (${response.status})`);
  }
  return body.data;
}

function resampleToLinear16(input: Float32Array, inputRate: number, outputRate: number) {
  if (!input.length) return new ArrayBuffer(0);
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

export default function AiVoiceSelfTestPage() {
  const [state, setState] = useState<Readiness | null>(null);
  const [browserState, setBrowserState] = useState<BrowserReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserActive, setBrowserActive] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stage, setStage] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [sampleRate, setSampleRate] = useState(16000);
  const [ttsLatency, setTtsLatency] = useState<number | null>(null);
  const [totalLatency, setTotalLatency] = useState<number | null>(null);
  const [audioBytes, setAudioBytes] = useState(0);
  const [clarity, setClarity] = useState<"unrated" | "clear" | "distorted">("unrated");
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const muteRef = useRef<GainNode | null>(null);
  const nextPlaybackRef = useRef(0);

  const addDiagnostic = (nextStage: string, detail: string) => {
    setDiagnostics((current) => [
      ...current.slice(-11),
      { at: Date.now(), stage: nextStage, detail },
    ]);
  };

  const shutdownBrowserHarness = () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    muteRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    muteRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) {
      try {
        socketRef.current.send(JSON.stringify({ type: "stop" }));
      } catch {
        // ignore close races
      }
      socketRef.current.close(1000, "browser test stopped");
    }
    socketRef.current = null;
    if (contextRef.current) void contextRef.current.close().catch(() => undefined);
    contextRef.current = null;
    nextPlaybackRef.current = 0;
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([readiness(), browserReadiness()]).then(
      ([voice, browser]) => {
        if (!cancelled) {
          setState(voice);
          setBrowserState(browser);
          setSampleRate(browser.sampleRate);
        }
      },
      (caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => {
      cancelled = true;
      shutdownBrowserHarness();
    };
  }, []);

  const refresh = async () => {
    try {
      const [voice, browser] = await Promise.all([readiness(), browserReadiness()]);
      setState(voice);
      setBrowserState(browser);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const callMe = async () => {
    if (!state?.enabled || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await start();
      setNotice(
        `AI self-test ${result.callId} started for the allow-listed number ending ${result.phoneLast4}. Answer the call and speak normally; you can interrupt the bot and ask follow-up questions.`,
      );
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const playLinear16 = async (buffer: ArrayBuffer) => {
    const context = contextRef.current;
    if (!context || buffer.byteLength < 2) return;
    const samples = new Int16Array(buffer);
    const audioBuffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      channel[index] = samples[index] < 0 ? samples[index] / 0x8000 : samples[index] / 0x7fff;
    }
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    const now = context.currentTime;
    const startAt = Math.max(now + 0.02, nextPlaybackRef.current);
    source.start(startAt);
    nextPlaybackRef.current = startAt + audioBuffer.duration;
    addDiagnostic("playback", `${buffer.byteLength} PCM bytes queued (${audioBuffer.duration.toFixed(2)}s)`);
  };

  const startBrowserHarness = async () => {
    if (browserBusy || browserActive || !browserState?.enabled) return;
    setBrowserBusy(true);
    setError("");
    setNotice("");
    setTranscript("");
    setReply("");
    setTtsLatency(null);
    setTotalLatency(null);
    setAudioBytes(0);
    setClarity("unrated");
    setDiagnostics([]);
    setStage("requesting microphone");

    try {
      const ticket = await browserTicket();
      setSampleRate(ticket.sampleRate);
      addDiagnostic("ticket", `${ticket.ticketId} · ${ticket.sampleRate} Hz · ${ticket.sessionLimitSeconds}s max`);

      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = media;

      const context = new AudioContext();
      contextRef.current = context;
      await context.resume();
      const source = context.createMediaStreamSource(media);
      sourceRef.current = source;
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      const mute = context.createGain();
      mute.gain.value = 0;
      muteRef.current = mute;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(context.destination);

      const socket = new WebSocket(ticket.wsUrl);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = resampleToLinear16(input, context.sampleRate, ticket.sampleRate);
        if (pcm.byteLength) socket.send(pcm);
      };

      socket.onopen = () => {
        setBrowserActive(true);
        setBrowserBusy(false);
        setStage("connected");
        addDiagnostic("websocket", "Direct UAT WebSocket connected; Exotel bypassed");
        socket.send(JSON.stringify({ type: "start" }));
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          let message: HarnessMessage;
          try {
            message = JSON.parse(event.data) as HarnessMessage;
          } catch {
            return;
          }
          if (message.type === "error") {
            const detail = message.message || "Browser AI pipeline failed";
            setError(detail);
            setStage(`error: ${message.stage || "unknown"}`);
            addDiagnostic(message.stage || "error", detail);
            return;
          }
          if (message.type === "status" && message.stage) {
            setStage(message.stage);
            addDiagnostic(message.stage, message.purpose || "pipeline status");
          }
          if (message.type === "transcript" && message.text) {
            setTranscript(message.text);
            addDiagnostic("transcript", message.text);
          }
          if (message.type === "reply" && message.text) {
            setReply(message.text);
            if (typeof message.llmLatencyMs === "number") {
              addDiagnostic("llm", `${message.llmLatencyMs} ms`);
            }
          }
          if (message.type === "audio") {
            if (typeof message.bytes === "number") setAudioBytes(message.bytes);
            if (typeof message.ttsLatencyMs === "number") setTtsLatency(message.ttsLatencyMs);
            if (typeof message.totalLatencyMs === "number") setTotalLatency(message.totalLatencyMs);
            addDiagnostic(
              "tts",
              `${message.purpose || "speech"}: ${message.bytes || 0} bytes · ${message.ttsLatencyMs || 0} ms`,
            );
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          void playLinear16(event.data);
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then(playLinear16);
        }
      };

      socket.onerror = () => {
        setError("Browser voice WebSocket failed");
        setStage("socket error");
        addDiagnostic("socket", "WebSocket error");
      };
      socket.onclose = (event) => {
        setBrowserActive(false);
        setBrowserBusy(false);
        setStage(`closed (${event.code})`);
        addDiagnostic("closed", event.reason || `code ${event.code}`);
        processorRef.current?.disconnect();
        sourceRef.current?.disconnect();
        muteRef.current?.disconnect();
        streamRef.current?.getTracks().forEach((track) => track.stop());
        processorRef.current = null;
        sourceRef.current = null;
        muteRef.current = null;
        streamRef.current = null;
        socketRef.current = null;
      };
    } catch (caught) {
      shutdownBrowserHarness();
      setBrowserBusy(false);
      setBrowserActive(false);
      setStage("failed to start");
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const stopBrowserHarness = () => {
    shutdownBrowserHarness();
    setBrowserActive(false);
    setBrowserBusy(false);
    setStage("stopped");
    addDiagnostic("stopped", "Browser microphone test stopped by operator");
  };

  const browserVerdict =
    clarity === "clear" && transcript && reply && audioBytes > 0
      ? "CERTIFIED"
      : clarity === "distorted"
        ? "AUDIO ISSUE"
        : browserActive
          ? "TESTING"
          : "NOT RUN";

  return (
    <TeamShell
      eyebrow="PAWSPACE TEAM · VOICE UAT"
      title="Call me with the AI bot"
      description="UAT-only voice testing. Use the browser mic harness to certify Workers AI independently from Exotel, then use the allow-listed carrier test only after the AI pipeline is proven."
      nav={[
        { href: "/team/voice", label: "Voice operations", primary: true },
        { href: "/team/ai", label: "AI governance" },
        { href: "/team", label: "Team home" },
      ]}
      status={
        <>
          <TeamAlert tone="error">{error}</TeamAlert>
          <TeamAlert tone="info">{notice}</TeamAlert>
        </>
      }
    >
      <TeamStatGrid>
        <StatCard
          label="Carrier self-test"
          value={state ? (state.enabled ? "READY" : "BLOCKED") : "…"}
          meta={state?.reason || "UAT-only Exotel lane"}
        />
        <StatCard
          label="Browser mic"
          value={browserState ? (browserState.enabled ? "READY" : "BLOCKED") : "…"}
          meta="carrier-free Workers AI test"
        />
        <StatCard
          label="Voice AI"
          value={browserState?.aiBindingConfigured ? "CONNECTED" : "MISSING"}
          meta="Flux + Q&A + Aura"
        />
        <StatCard label="Browser verdict" value={browserVerdict} meta={`${sampleRate} Hz Linear16 mono`} />
      </TeamStatGrid>

      <TeamSection
        title="Test via Browser Mic"
        note="No Exotel call is placed. Microphone PCM goes directly to the UAT Worker; raw Aura PCM returns directly to your speakers."
      >
        {!browserState?.enabled && (
          <TeamAlert tone="error">
            {browserState?.reason || "Browser AI voice harness is not ready."}
          </TeamAlert>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {!browserActive ? (
            <Button
              onClick={() => void startBrowserHarness()}
              disabled={!browserState?.enabled || browserBusy}
            >
              {browserBusy ? "Connecting mic…" : "Test via Browser Mic"}
            </Button>
          ) : (
            <Button onClick={stopBrowserHarness}>Stop Browser Test</Button>
          )}
          <Badge tone={browserActive ? "success" : "warning"}>{stage}</Badge>
          <span>Use headphones if available to prevent speaker-to-mic echo.</span>
        </div>
      </TeamSection>

      <TeamSection
        title="Browser pipeline diagnostics"
        note='On connect you should hear: "Hello, this is the PawSpace voice UAT test." Then speak a short question and wait for the reply.'
      >
        <TeamTable
          head={["Check", "Result", "Evidence"]}
          rows={[
            ["Opening TTS", <Badge key="open" tone={audioBytes > 0 ? "success" : "warning"}>{audioBytes > 0 ? "audio returned" : "waiting"}</Badge>, `${audioBytes} PCM bytes`],
            ["Microphone → Flux", <Badge key="stt" tone={transcript ? "success" : "warning"}>{transcript ? "transcribed" : "waiting"}</Badge>, transcript || "Speak after the greeting"],
            ["Transcript → LLM", <Badge key="llm" tone={reply ? "success" : "warning"}>{reply ? "answered" : "waiting"}</Badge>, reply || "No reply yet"],
            ["Aura latency", <Badge key="tts" tone={ttsLatency !== null ? "success" : "warning"}>{ttsLatency !== null ? `${ttsLatency} ms` : "waiting"}</Badge>, totalLatency !== null ? `${totalLatency} ms end-to-end after transcript` : "No completed conversational turn yet"],
            ["Audio clarity", <Badge key="clarity" tone={clarity === "clear" ? "success" : clarity === "distorted" ? "danger" : "warning"}>{clarity}</Badge>, <span key="clarity-actions"><button type="button" onClick={() => setClarity("clear")}>Clear</button>{" "}<button type="button" onClick={() => setClarity("distorted")}>Clipped / distorted</button></span>],
          ]}
          empty="Start the browser mic test to collect evidence."
        />
        <div style={{ marginTop: 16 }}>
          <strong>Live events</strong>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {diagnostics.length
              ? diagnostics
                  .map((item) => `${new Date(item.at).toLocaleTimeString()}  ${item.stage}  ${item.detail}`)
                  .join("\n")
              : "No browser voice events yet."}
          </pre>
        </div>
      </TeamSection>

      <TeamSection title="Safety boundary" note="Browser direct mode is UAT-only and requires an authenticated, short-lived ticket.">
        <TeamTable
          head={["Control", "State", "Meaning"]}
          rows={[
            ["Environment", <Badge key="env" tone={browserState?.mode === "uat" ? "success" : "danger"}>{browserState?.mode || "…"}</Badge>, "Direct browser mode refuses non-UAT voice mode."],
            ["Deployment", <Badge key="dep" tone={browserState?.enabled ? "success" : "warning"}>{browserState?.deployment || "…"}</Badge>, "Only staging/dev/test deployments are accepted."],
            ["Authentication", <Badge key="auth" tone="success">staff ticket</Badge>, "The browser must first obtain a short-lived ticket through the authenticated operator API."],
            ["Carrier", <Badge key="carrier" tone="success">bypassed</Badge>, "Browser test places no Exotel call and consumes no phone-test cap."],
            ["Recording", <Badge key="record" tone="success">off</Badge>, "The browser harness does not persist microphone audio or transcripts."],
          ]}
          empty="Loading browser harness readiness…"
        />
      </TeamSection>

      <TeamSection
        title="Carrier test"
        note="Run this only after the browser harness certifies the AI pipeline. Destination remains the single server-side allow-listed number."
      >
        {!state?.enabled && (
          <TeamAlert tone="error">{state?.reason || "AI voice carrier self-test is not ready."}</TeamAlert>
        )}
        <Button onClick={() => void callMe()} disabled={!state?.enabled || busy}>
          {busy ? "Calling…" : "Call my allow-listed number now"}
        </Button>
      </TeamSection>
    </TeamShell>
  );
}
