"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RealtimeDictationClient } from "@/lib/voice/realtime-client";
import { startMicCapture, type MicHandle } from "@/lib/voice/mic";
import { createAudioOut, type AudioOutHandle } from "@/lib/voice/audio-out";
import { getGateSensitivity, getRealtimeUrls, getWakeWord } from "@/lib/voice/settings";
import { classifyTurn, createNearSpeechGate, type NearGateHandle } from "@/lib/voice/turn-gate";
import { askPiReply, isPiRequestCancelled, stopPiRun } from "@/lib/voice/pi-bridge";
import { appendCallTurn, buildReplayMessage, loadCallHistory, migrateCallHistory, type CallTurn } from "@/lib/voice/call-history";
import { useI18n } from "@/hooks/useI18n";

interface Caption {
  id: number;
  who: "me" | "ai" | "pi";
  text: string;
  live?: boolean;
  /** Background speech the gates swallowed: shown, never answered, never remembered. */
  ignored?: boolean;
}

/** A question handed to pi; its answer arrives later, if the user lets it. */
interface PiJob {
  question: string;
  captionId: number;
  controller: AbortController;
  cancelled: boolean;
}

const ASK_PI_TOOL = {
  type: "function",
  name: "ask_pi",
  description: "Hand work to the pi coding agent in this folder: their files, memory, projects, tools, history, or any task that takes real work. It answers seconds or minutes later, never inside this call: the result arrives as a message marked [background event].",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The request rephrased as fluent text in the language the user spoke, with speech-to-text errors fixed. Never translate it into another language." } },
    required: ["question"],
  },
};

const STOP_PI_TOOL = {
  type: "function",
  name: "stop_pi",
  description: "Stop the work pi is doing for the user because they cancelled it — they said to forget it, stop, or that the answer is no longer wanted. Takes no argument and returns at once; the answer will not arrive.",
  parameters: { type: "object", properties: {}, required: [] },
};

// Model-facing copy (not UI): stable across locales, the voice layer always
// speaks Chinese to match the household's use.
const VOICE_LAYER_INSTRUCTIONS = [
  "You are the user's realtime voice assistant inside Pi Web.",
  "For anything about their files, memory, projects, tools, or longer work, call ask_pi.",
  "ask_pi only starts the job and returns at once: after the call say one short line in Chinese that you asked pi, then keep listening — never wait for the answer.",
  "A message marked [background event] comes from pi, not the user: tell the user briefly in your own words what it found.",
  "If the user says to stop or forget what pi is looking up, call stop_pi.",
  "Answer greetings and small talk yourself.",
  "Always reply in Chinese, at most two short sentences.",
  "The user's speech is auto-transcribed and may contain wrong words; silently fix them when calling ask_pi and keep the user's own language.",
].join(" ");

interface Props {
  /** What the call's transcript is stored under: the session, or the fresh composer's draft key. */
  callKey: string;
  /** The session pi runs in, when this page has one yet. */
  sessionId: string | null;
  /** Create (and promote) the page's session, for the first question that needs pi. */
  onEnsureSession: () => Promise<string | null>;
  onClose: () => void;
}

/**
 * Two-layer realtime voice call. The voice layer answers small talk itself and
 * hands real work to pi: `ask_pi` starts the job and is answered at once, so a
 * long pi run never blocks the conversation, and its result is announced as a
 * background event when the user next stops talking. `stop_pi` drops a job the
 * user no longer wants — that is what a spoken "算了" interrupts.
 *
 * Collapsing hides the panel but keeps the call live (socket, audio out and
 * transcript run on, so pi's answer is still announced); it **frees the
 * microphone**, which the user needs for their own voice input — two captures
 * on one device compete for it. The pill sits in the bottom-right corner, and
 * the open panel is anchored to the same corner instead of covering the page as
 * a modal, so a call never hides the session the user is reading. The pill
 * restores the scene at once. The transcript and a bounded context digest
 * persist per session, so re-opening later — even after a reload — resumes
 * where the last call was.
 */
export function VoiceConversationPanel({ callKey, sessionId, onEnsureSession, onClose }: Props) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  const [error, setError] = useState("");
  // One reply the voice layer could not generate: it costs a turn, not the call.
  const [warning, setWarning] = useState("");
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [piBusy, setPiBusy] = useState(false);
  const clientRef = useRef<RealtimeDictationClient | null>(null);
  const micRef = useRef<MicHandle | null>(null);
  /** Capture follows the panel, so the collapse effect needs the current value. */
  const collapsedRef = useRef(collapsed);
  /** The room floor is measured once per call and survives a mic restart. */
  const gateRef = useRef<NearGateHandle | null>(null);
  /** A restart while an earlier start is still opening must not take a second stream. */
  const openingMicRef = useRef(false);
  const audioRef = useRef<AudioOutHandle | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(1);
  const meIdRef = useRef(0);
  const aiIdRef = useRef(0);
  const aiTextRef = useRef("");
  const jobsRef = useRef(new Map<string, PiJob>());
  /** Where pi runs and where the transcript lives, once a session exists. */
  const sessionRef = useRef<string | null>(sessionId);
  const historyKeyRef = useRef(sessionId ?? callKey);
  const tRef = useRef(t);
  tRef.current = t;

  const persist = useCallback((who: CallTurn["who"], text: string) => {
    appendCallTurn(historyKeyRef.current, { who, text });
  }, []);

  /** Materialise the page's session on the first question that needs pi. */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionRef.current) return sessionRef.current;
    const id = await onEnsureSession();
    if (id && sessionRef.current === null) {
      sessionRef.current = id;
      if (historyKeyRef.current !== id) {
        migrateCallHistory(historyKeyRef.current, id);
        historyKeyRef.current = id;
      }
    }
    return id;
  }, [onEnsureSession]);
  const ensureSessionRef = useRef(ensureSession);
  ensureSessionRef.current = ensureSession;

  /** Drop every job the voice layer started: no answer, no announcement. */
  const stopPiJobs = useCallback(() => {
    const jobs = [...jobsRef.current.values()];
    jobsRef.current.clear();
    setPiBusy(false);
    clientRef.current?.dropNotifications();
    const sid = sessionRef.current;
    if (sid && jobs.length) void stopPiRun(sid);
    for (const job of jobs) {
      job.cancelled = true;
      job.controller.abort();
      setCaptions((prev) => prev.map((c) => (c.id === job.captionId
        ? { ...c, text: `${c.text.replace(/^… /, "")}（${tRef.current("voiceCall.cancelled")}）` }
        : c)));
    }
  }, []);
  const stopPiJobsRef = useRef(stopPiJobs);
  stopPiJobsRef.current = stopPiJobs;

  /**
   * Take the microphone: the call starts with it, and opening the panel takes it
   * back after a collapse freed the device. Throws for the caller to report. A
   * capture that finishes opening after the panel collapsed — or after the call
   * hung up — frees the device again instead of holding it.
   */
  const startCapture = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client || micRef.current || openingMicRef.current) return;
    openingMicRef.current = true;
    try {
      const mic = await startMicCapture((chunk) => client.sendAudio(chunk), { gate: gateRef.current ?? undefined });
      if (collapsedRef.current || clientRef.current !== client) {
        void mic.stop().catch(() => undefined);
        return;
      }
      micRef.current = mic;
    } finally {
      openingMicRef.current = false;
    }
  }, []);

  /** Free the microphone. The socket, audio out and transcript stay live. */
  const stopCapture = useCallback(async (): Promise<void> => {
    const mic = micRef.current;
    micRef.current = null;
    if (mic) await mic.stop().catch(() => undefined);
  }, []);

  /** Hand one question to pi, and announce its answer whenever it lands. */
  const startPiJob = useCallback((callId: string, question: string) => {
    const controller = new AbortController();
    const captionId = seqRef.current++;
    jobsRef.current.set(callId, { question, captionId, controller, cancelled: false });
    setPiBusy(true);
    setCaptions((prev) => [...prev, { id: captionId, who: "pi", text: `… ${question}` }]);
    void (async () => {
      // The call is answered before pi starts: while a function call is open the
      // voice layer cannot generate anything, so waiting on pi is what silence
      // the user hears as "it cannot be interrupted".
      clientRef.current?.sendFunctionOutput(callId, JSON.stringify({ state: "started", question }), true);
      let answer: string;
      let failed = false;
      try {
        const sid = await ensureSessionRef.current();
        if (!sid) throw new Error("no session to ask pi in");
        answer = await askPiReply(sid, `[语音通话] ${question}`, { signal: controller.signal });
      } catch (e) {
        if (isPiRequestCancelled(e)) return; // the user stopped it: nothing to say
        failed = true;
        answer = `pi: ${(e as Error)?.message ?? "failed"}`;
      }
      const job = jobsRef.current.get(callId);
      if (!job || job.cancelled) return;
      jobsRef.current.delete(callId);
      if (jobsRef.current.size === 0) setPiBusy(false);
      setCaptions((prev) => prev.map((c) => (c.id === captionId ? { ...c, text: answer } : c)));
      if (failed) setWarning(answer);
      else persistRef.current("pi", answer);
      // Model-facing: the voice layer says it in its own words.
      clientRef.current?.notify(failed
        ? `pi 没能回答「${question}」：${answer.replace(/^pi: /, "")}`
        : `pi 对「${question}」的回答：${answer}`);
    })();
  }, []);
  const startPiJobRef = useRef(startPiJob);
  startPiJobRef.current = startPiJob;

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

  // Effects below run before these callbacks exist on first render; refs keep
  // the once-only call closure pointed at the latest versions.
  const upsertLiveRef = useRef(upsertLive);
  upsertLiveRef.current = upsertLive;
  const finalizeLiveRef = useRef(finalizeLive);
  finalizeLiveRef.current = finalizeLive;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // One run per mount: the session id appears in the middle of a call (the first
  // question that needs pi), and depending on it would hang up. Dev mode mounts,
  // unmounts and mounts again, so the socket closes with its mount — the server
  // keeps one client per pipeline slot, and the retry needs it free.
  useEffect(() => {
    historyKeyRef.current = sessionRef.current ?? callKey;
    const jobs = jobsRef.current;

    // Restore the previous scene first: the transcript shows while connecting.
    const history = loadCallHistory(historyKeyRef.current);
    setCaptions(history.map((h) => ({ id: seqRef.current++, who: h.who, text: h.text })));

    const audioOut = createAudioOut();
    audioRef.current = audioOut;
    let disposed = false;
    // Both gates read their settings when the call starts, so a change lands on
    // the next call rather than half-way through this one. The room floor lives
    // in a ref: restarting the capture when the panel re-opens keeps it.
    gateRef.current = createNearSpeechGate({ sensitivity: getGateSensitivity() });
    const wakeWord = getWakeWord();
    const client = new RealtimeDictationClient(getRealtimeUrls(), {
      onPartial: (text) => { if (text) upsertLiveRef.current("me", text); },
      onSegment: (text, info) => {
        const live = meIdRef.current;
        finalizeLiveRef.current("me", text);
        if (info.accepted) {
          persistRef.current("me", text);
          return;
        }
        // Show what was swallowed: it is how the sensitivity slider gets tuned.
        const id = live || seqRef.current++;
        if (!live) setCaptions((prev) => [...prev, { id, who: "me", text }]);
        setCaptions((prev) => prev.map((c) => (c.id === id ? { ...c, ignored: true } : c)));
      },
      acceptTurn: (text, seconds) => classifyTurn(text, seconds, { wakeWord }).accept,
      onSpeechStarted: () => audioOut.flush(),
      onResponseStarted: () => setWarning(""),
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
        if (name === "stop_pi") {
          stopPiJobsRef.current();
          client.sendFunctionOutput(callId, "ok: pi stopped, nothing more is coming", true);
          return;
        }
        if (name !== "ask_pi" || !question) {
          client.sendFunctionOutput(callId, `unknown tool call ${name}`, false);
          return;
        }
        startPiJobRef.current(callId, question);
      },
      onError: (e) => {
        if (disposed) return;
        const fatal = e.code === "connection_error" || e.code === "session_limit_reached";
        if (fatal) {
          setError(e.message);
          setStatus("error");
          return;
        }
        // One refused or failed reply: the client re-asks when the way clears.
        setWarning(e.message);
      },
    }, {
      cancelResponses: false,
      gateResponses: true,
      tools: [ASK_PI_TOOL, STOP_PI_TOOL],
      instructions: VOICE_LAYER_INSTRUCTIONS,
    });
    clientRef.current = client;
    void (async () => {
      try {
        await client.connect();
        if (disposed) return;
        const replay = buildReplayMessage(history);
        if (replay) client.sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: replay }] } });
        await startCapture();
        if (disposed) return;
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
      for (const job of jobs.values()) {
        job.cancelled = true;
        job.controller.abort();
      }
      jobs.clear();
      const mic = micRef.current;
      micRef.current = null;
      if (mic) void mic.stop().catch(() => undefined);
      const clientToClose = client;
      clientToClose.close(); // a hang-up keeps its transcript locally, not in the server's conversation
      audioOut.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions, piBusy, collapsed]);

  // A collapsed call gives the microphone up: the user dictates with their own
  // voice input, and two captures on one device compete for it. Opening the pill
  // takes it back. The call itself keeps running either way — pi's answer is
  // still announced — so only capture moves with the panel.
  useEffect(() => {
    collapsedRef.current = collapsed;
    // While the socket is still opening, the call's own start owns the device.
    if (!clientRef.current?.connected) return;
    if (collapsed) void stopCapture();
    else void startCapture().catch((e: unknown) => setWarning(e instanceof Error ? e.message : String(e)));
  }, [collapsed, startCapture, stopCapture]);

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

  const statusLine = status === "connecting"
    ? t("voiceCall.connecting")
    : status === "error"
      ? t("voiceCall.error", { message: error })
      : warning
        ? t("voiceCall.warning", { message: warning })
        : piBusy
          // The call keeps answering while pi works, so say both: speak on, and
          // the question is in flight.
          ? `${t("voiceCall.hint")} · ${t("voiceCall.askingPi")}`
          : t("voiceCall.hint");

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
      aria-label={t("voiceCall.title")}
      style={{
        // The same corner the pill holds: the panel opens beside the session
        // instead of over it, so a call never hides the answer being read.
        position: "fixed", right: 16, bottom: "calc(16px + env(safe-area-inset-bottom))", zIndex: 70,
        width: "min(420px, calc(100vw - 32px))",
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
        color: "var(--text)", boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
        display: "flex", flexDirection: "column", gap: 8, padding: 14,
      }}
    >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {statusDot}
          <strong style={{ fontSize: 14 }}>{t("voiceCall.title")}</strong>
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto", marginRight: 4 }}>
            {statusLine}
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
                opacity: c.ignored ? 0.45 : undefined,
                fontStyle: c.live ? "italic" : undefined,
                whiteSpace: "pre-wrap",
              }}
            >
              {c.who === "pi" && <span style={{ fontSize: 11, marginRight: 6, color: "var(--text-dim)" }}>pi</span>}
              {c.text}
              {c.ignored && (
                <span style={{ fontSize: 11, marginLeft: 6, color: "var(--text-dim)" }}>（{t("voiceCall.ignored")}）</span>
              )}
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
  );
}
