"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RealtimeDictationClient } from "@/lib/voice/realtime-client";
import { startMicCapture, type MicHandle } from "@/lib/voice/mic";
import { createAudioOut, type AudioOutHandle } from "@/lib/voice/audio-out";
import { getRealtimeUrls } from "@/lib/voice/settings";
import { askPiReply } from "@/lib/voice/pi-bridge";
import { appendCallTurn, buildReplayMessage, loadCallHistory, type CallTurn } from "@/lib/voice/call-history";
import { useI18n } from "@/hooks/useI18n";

interface Caption {
  id: number;
  who: "me" | "ai" | "pi";
  text: string;
  live?: boolean;
}

const ASK_PI_TOOL = {
  type: "function",
  name: "ask_pi",
  description: "Ask the pi coding agent working in this folder: their files, memory, projects, tools, history, or any task that takes real work. Returns pi's answer. Say one short acknowledgement first, in the user's own language.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The request rephrased as fluent text in the language the user spoke, with speech-to-text errors fixed. Never translate it into another language." } },
    required: ["question"],
  },
};

// Model-facing copy (not UI): stable across locales, the voice layer always
// speaks Chinese to match the household's use.
const VOICE_LAYER_INSTRUCTIONS = [
  "You are the user's realtime voice assistant inside Pi Web.",
  "For anything about their files, memory, projects, tools, or longer work, call ask_pi; before the call say one brief acknowledgement in Chinese.",
  "Answer greetings and small talk yourself.",
  "Always reply in Chinese, at most two short sentences; the answer of ask_pi is spoken back to the user in your own words.",
  "The user's speech is auto-transcribed and may contain wrong words; silently fix them when calling ask_pi and keep the user's own language.",
].join(" ");

/**
 * Two-layer realtime voice call. Collapsing hides the panel but keeps the
 * call live (mic, barge-in, audio out run on); the pill restores the scene at
 * once. The transcript and a bounded context digest persist per session, so
 * re-opening later — even after a reload — resumes where the last call was.
 */
export function VoiceConversationPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState("");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [piBusy, setPiBusy] = useState(false);
  const startedRef = useRef(false);
  const clientRef = useRef<RealtimeDictationClient | null>(null);
  const micRef = useRef<MicHandle | null>(null);
  const audioRef = useRef<AudioOutHandle | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(1);
  const meIdRef = useRef(0);
  const aiIdRef = useRef(0);
  const aiTextRef = useRef("");

  const persist = useCallback((who: CallTurn["who"], text: string) => {
    appendCallTurn(sessionId, { who, text });
  }, [sessionId]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // Restore the previous scene first: the transcript shows while connecting.
    const history = loadCallHistory(sessionId);
    setCaptions(history.map((h) => ({ id: seqRef.current++, who: h.who, text: h.text })));

    const audioOut = createAudioOut();
    audioRef.current = audioOut;
    let disposed = false;
    const client = new RealtimeDictationClient(getRealtimeUrls(), {
      onPartial: (text) => { if (text) upsertLiveRef.current("me", text); },
      onSegment: (text) => { finalizeLiveRef.current("me", text); persistRef.current("me", text); },
      onSpeechStarted: () => audioOut.flush(),
      onAssistantDelta: (d) => {
        aiTextRef.current += d;
        setCaptions((prev) => {
          const id = aiIdRef.current || seqRef.current++;
          aiIdRef.current = id;
          const existing = prev.find((c) => c.id === id);
          return existing
            ? prev.map((c) => (c.id === id ? { ...c, text: c.text + d } : c))
            : [...prev, { id, who: "ai", text: d, live: true }];
        });
      },
      onResponseDone: (s) => {
        if (s !== "completed" && s !== "cancelled") return;
        finalizeLiveRef.current("ai");
        if (aiTextRef.current.trim()) persistRef.current("ai", aiTextRef.current.trim());
        aiTextRef.current = "";
      },
      onAudioChunk: (b64) => audioOut.enqueue(b64),
      onFunctionCall: ({ callId, name, argumentsJson }) => {
        let question = "";
        try { question = String((JSON.parse(argumentsJson) as { question?: string }).question ?? ""); } catch { /* fall through */ }
        if (name !== "ask_pi" || !question) {
          client.sendFunctionOutput(callId, `unknown tool call ${name}`, false);
          return;
        }
        setPiBusy(true);
        const id = seqRef.current++;
        setCaptions((prev) => [...prev, { id, who: "pi", text: `… ${question}` }]);
        void askPiReply(sessionId, `[语音通话] ${question}`)
          .then((answer) => {
            setCaptions((prev) => [...prev.map((c) => (c.id === id ? { ...c, text: answer } : c))]);
            persistRef.current("pi", answer);
            if (!disposed) client.sendFunctionOutput(callId, answer);
          })
          .catch((e: Error) => {
            setCaptions((prev) => [...prev.map((c) => (c.id === id ? { ...c, text: `pi: ${e.message}` } : c))]);
            if (!disposed) client.sendFunctionOutput(callId, `pi failed: ${e.message}`);
          })
          .finally(() => { if (!disposed) setPiBusy(false); });
      },
      onError: (e) => {
        if (disposed) return;
        setError(e.message);
        setStatus("error");
      },
    }, { cancelResponses: false, tools: [ASK_PI_TOOL], instructions: VOICE_LAYER_INSTRUCTIONS });
    clientRef.current = client;
    void (async () => {
      try {
        await client.connect();
        if (disposed) return;
        const replay = buildReplayMessage(history);
        if (replay) client.sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: replay }] } });
        const mic = await startMicCapture((chunk) => client.sendAudio(chunk));
        if (disposed) {
          await mic.stop();
          return;
        }
        micRef.current = mic;
        setStatus("live");
      } catch (e) {
        if (disposed) return;
        setError((e as Error)?.message ?? "unreachable");
        setStatus("error");
      }
    })();
    return () => {
      disposed = true;
      clientRef.current = null;
      const mic = micRef.current;
      micRef.current = null;
      if (mic) void mic.stop().catch(() => undefined);
      const clientToClose = client;
      setTimeout(() => clientToClose.close(), 300); // let any last tool output land
      audioOut.close();
    };
  }, [sessionId]);

  const upsertLive = useCallback((who: "me" | "ai", text: string) => {
    setCaptions((prev) => {
      const idRef = who === "me" ? meIdRef : aiIdRef;
      const existing = prev.find((c) => c.id === idRef.current);
      if (!existing) {
        const id = seqRef.current++;
        idRef.current = id;
        return [...prev, { id, who, text, live: true }];
      }
      return prev.map((c) => (c.id === idRef.current ? { ...c, text } : c));
    });
  }, []);

  const finalizeLive = useCallback((who: "me" | "ai", text?: string) => {
    setCaptions((prev) => prev.map((c) => (c.id === (who === "me" ? meIdRef : aiIdRef).current ? { ...c, live: false, text: text ?? c.text } : c)));
    (who === "me" ? meIdRef : aiIdRef).current = 0;
  }, []);

  // Effects above run before the callbacks below exist on first render; refs
  // keep the once-only session closure pointed at the latest versions.
  const upsertLiveRef = useRef(upsertLive);
  upsertLiveRef.current = upsertLive;
  const finalizeLiveRef = useRef(finalizeLive);
  finalizeLiveRef.current = finalizeLive;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions, piBusy, collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCollapsed(true); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusDot = (
    <span
      aria-hidden="true"
      style={{
        width: 8, height: 8, borderRadius: 4, flexShrink: 0,
        background: status === "live" ? "var(--accent)" : status === "error" ? "#ef4444" : "var(--text-dim)",
        animation: status === "connecting" || (status === "live" && !piBusy) ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        aria-label={t("voiceCall.expand")}
        title={t("voiceCall.expand")}
        style={{
          position: "fixed", right: 16, bottom: "calc(16px + env(safe-area-inset-bottom))", zIndex: 70,
          display: "flex", alignItems: "center", gap: 8,
          padding: "10px 14px", borderRadius: 999,
          background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)",
          boxShadow: "0 6px 20px rgba(0,0,0,0.25)", cursor: "pointer", fontSize: 13,
        }}
      >
        {statusDot}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        {piBusy ? t("voiceCall.askingPi") : t("voiceCall.title")}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("voiceCall.title")}
      onMouseDown={() => setCollapsed(true)}
      style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, calc(100vw - 24px))", marginBottom: "calc(16px + env(safe-area-inset-bottom))",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
          color: "var(--text)", boxShadow: "0 12px 40px rgba(0,0,0,0.35)", display: "flex", flexDirection: "column", gap: 8, padding: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {statusDot}
          <strong style={{ fontSize: 14 }}>{t("voiceCall.title")}</strong>
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto", marginRight: 4 }}>
            {status === "connecting" ? t("voiceCall.connecting") : status === "error" ? t("voiceCall.error", { message: error }) : piBusy ? t("voiceCall.askingPi") : t("voiceCall.hint")}
          </span>
          <button
            onClick={() => setCollapsed(true)}
            aria-label={t("voiceCall.collapse")}
            title={t("voiceCall.collapse")}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, borderRadius: 6, display: "flex" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
        <div ref={listRef} style={{ maxHeight: "42vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {captions.map((c) => (
            <div
              key={c.id}
              style={{
                alignSelf: c.who === "me" ? "flex-end" : "flex-start",
                maxWidth: "85%",
                padding: "6px 10px",
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.5,
                background: c.who === "me" ? "color-mix(in srgb, var(--accent) 14%, transparent)" : c.who === "pi" ? "var(--bg-hover)" : "var(--bg-panel)",
                border: "1px solid var(--border)",
                color: c.who === "pi" ? "var(--text-muted)" : c.live ? "var(--text-muted)" : "var(--text)",
                fontStyle: c.live ? "italic" : undefined,
                whiteSpace: "pre-wrap",
              }}
            >
              {c.who === "pi" && <span style={{ fontSize: 11, marginRight: 6, color: "var(--text-dim)" }}>pi</span>}
              {c.text}
            </div>
          ))}
          {captions.length === 0 && status === "live" && (
            <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "6px 2px" }}>{t("chat.voiceListening")}</div>
          )}
        </div>
        <button
          onClick={onClose}
          style={{
            alignSelf: "center", padding: "8px 22px", borderRadius: 999, border: "none",
            background: "rgba(239,68,68,0.12)", color: "#ef4444", fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}
        >
          {t("voiceCall.hangup")}
        </button>
      </div>
    </div>
  );
}
