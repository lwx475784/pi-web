"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RealtimeDictationClient } from "@/lib/voice/realtime-client";
import { startMicCapture, type MicHandle } from "@/lib/voice/mic";
import { createAudioOut, type AudioOutHandle } from "@/lib/voice/audio-out";
import { getEventStreamEnabled, getGateSensitivity, getRealtimeUrls, getWakeWord } from "@/lib/voice/settings";
import { classifyTurn, createNearSpeechGate, type NearGateHandle } from "@/lib/voice/turn-gate";
import { askPiReply, createRequestId, isPiRequestCancelled, readPiQueueCount, stopPiRun } from "@/lib/voice/pi-bridge";
import { createRunEndWatcher, type RunEndWatcher } from "@/lib/voice/answer-watcher";
import { decideAsk, decideStop, maySpeak, normalizeStopScope, type StopScope } from "@/lib/voice/job-policy";
import { createLeaseClient } from "@/lib/voice/lease-client";
import { markAnnouncementsRead, readLedger, recordAnnouncement } from "@/lib/voice/ledger-api";
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

/**
 * A question handed to pi; its answer arrives later, if the user lets it.
 * `requestId` is the submission's identity: pi echoes it back on the event that ends the run this
 * ask started, so an answer is matched to its question instead of assumed (ADR 0008).
 */
interface PiJob {
  question: string;
  captionId: number;
  controller: AbortController;
  cancelled: boolean;
  requestId: string;
  /**
   * Whether this ask started the run pi is in. pi only names the run its own prompt started, so a
   * queued ask cannot be told apart from that turn's other output: its answer is recorded, never
   * spoken, and a spoken stop cannot pull it out (ADR 0008 #3, #5).
   */
  ownsRun: boolean;
}

/** How long a "全部停止" confirmation stays live: long enough to answer, short enough to lapse. */
const STOP_CONFIRM_WINDOW_MS = 45_000;

/**
 * What to call this device when another one takes the voice line. The server only says "a slot is
 * busy", so the page names itself: a user holding a phone needs to know which browser to walk over
 * to, or which stale tab to close.
 */
function thisDeviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const host = typeof window === "undefined" ? "" : window.location.host;
  const kinds: Array<[RegExp, string]> = [[/iPhone|iPad|iPod/, "iPhone"], [/Android/, "Android"], [/Mac/, "Mac"], [/Windows/, "Windows"]];
  const kind = kinds.find(([pattern]) => pattern.test(ua))?.[1] ?? "";
  return [kind, host].filter(Boolean).join(" · ") || "另一台设备";
}

const ASK_PI_TOOL = {
  type: "function",
  name: "ask_pi",
  description: "Hand work to the pi coding agent in this folder: their files, memory, projects, tools, history, or any task that takes real work. It answers seconds or minutes later, never inside this call: the result arrives as a message marked [background event]. One job at a time: while one runs the call answers {state:\"conflict\", running:[...]}, so ask the user whether to queue behind it (call again with when_busy=\"queue\") or stop it (stop_pi). A queued answer is written to the page as unread and is never spoken, because it cannot be matched back to your question.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The request rephrased as fluent text in the language the user spoke, with speech-to-text errors fixed. Never translate it into another language." },
      when_busy: { type: "string", enum: ["queue"], description: "Pass only after the user agreed to wait behind the job already running." },
    },
    required: ["question"],
  },
};

const STOP_PI_TOOL = {
  type: "function",
  name: "stop_pi",
  description: "Stop something the voice call is doing, and return at once. scope=\"ask\" (default) cancels the ask this call started and the run it owns; scope=\"announcements\" only silences further announcements while pi keeps working, and its answers stay unread on the page; scope=\"everything\" stops the whole session, which costs the messages the user typed into the queue too — the tool asks you to confirm, and you pass confirmed=true only after the user agreed.",
  parameters: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["ask", "announcements", "everything"] },
      confirmed: { type: "boolean", description: "true only when the user has just confirmed a session-wide stop." },
    },
    required: [],
  },
};

// Model-facing copy (not UI): stable across locales, the voice layer always
// speaks Chinese to match the household's use.
const VOICE_LAYER_INSTRUCTIONS = [
  "You are the user's realtime voice assistant inside Pi Web.",
  "For anything about their files, memory, projects, tools, or longer work, call ask_pi.",
  "ask_pi only starts the job and returns at once: after the call say one short line in Chinese that you asked pi, then keep listening — never wait for the answer.",
  "A message marked [background event] comes from pi, not the user: tell the user briefly in your own words what it found.",
  "ask_pi answers {state:\"conflict\"} while a job runs. Ask the user in one line whether to queue behind it or stop it; never start a second job on your own.",
  "A stop of the whole session is offered once and takes confirmed=true on the next call: repeat in one line what it costs, and only confirm if the user agrees.",
  "If the user says they are done hearing results, call stop_pi with scope=\"announcements\": pi keeps working and the answers stay unread on the page.",
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
  /** Answers that exist but were never spoken: the ledger's unread count, shown on the pill. */
  const [unreadCount, setUnreadCount] = useState(0);
  const clientRef = useRef<RealtimeDictationClient | null>(null);
  const micRef = useRef<MicHandle | null>(null);
  /** Capture follows the panel, so the collapse effect needs the current value. */
  const collapsedRef = useRef(collapsed);
  /** The room floor is measured once per call and survives a mic restart. */
  const gateRef = useRef<NearGateHandle | null>(null);
  /** A restart while an earlier start is still opening must not take a second stream. */
  const openingMicRef = useRef(false);
  const audioRef = useRef<AudioOutHandle | null>(null);
  /** Watches pi's run-end events for every job this call started. */
  const watcherRef = useRef<RunEndWatcher | null>(null);
  /** "别念了": the call records answers but stops speaking them (ADR 0008 #5). */
  const announcementsMutedRef = useRef(false);
  /** When a session-wide stop was offered, so only the next few seconds count as a yes. */
  const stopArmedUntilRef = useRef(0);
  /** This call's identity in the one-line lease, and the lease client while the call lives. */
  const [leaseOwnerId] = useState(createRequestId);
  const leaseRef = useRef<ReturnType<typeof createLeaseClient> | null>(null);
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

  /**
   * The ledger keeps a missed announcement from being silent: every finished ask is recorded, and
   * an entry stops being unread only when its text actually reached the model. Read back from the
   * server after each change rather than counted here, so two pages watching one session agree.
   */
  const refreshUnread = useCallback(async (sid: string): Promise<void> => {
    const snapshot = await readLedger(sid);
    setUnreadCount(snapshot.unread.length);
  }, []);
  const refreshUnreadRef = useRef(refreshUnread);
  refreshUnreadRef.current = refreshUnread;

  /** Record one finished ask; speak it only when its answer can be attributed and the user still wants to hear it. */
  const announce = useCallback(async (sid: string, spoken: string, entry: {
    requestId: string;
    kind: "answer" | "failure";
    question: string;
    text: string;
  }, speak: boolean): Promise<void> => {
    const id = await recordAnnouncement(sid, entry);
    await refreshUnread(sid);
    if (speak) clientRef.current?.notify(spoken, id ?? "");
  }, [refreshUnread]);
  const announceRef = useRef(announce);
  announceRef.current = announce;

  /** Speak what an earlier call left unread: one answer, and a count for the rest. */
  const replayUnread = useCallback(async (sid: string): Promise<void> => {
    const snapshot = await readLedger(sid);
    setUnreadCount(snapshot.unread.length);
    const newest = snapshot.replay.newest;
    if (!newest) return;
    const more = snapshot.replay.more > 0
      ? `（还有 ${snapshot.replay.more} 条没念，可在页面上看）`
      : "";
    clientRef.current?.notify(`上次通话没念的${newest.kind === "failure" ? "失败" : "回答"}：${newest.text}${more}`, newest.id);
  }, []);

  /**
   * Cancel the asks named: no answer, no announcement, and a cancelled record in the ledger so the
   * stopped question is accounted for rather than lost.
   */
  const cancelJobs = useCallback((jobs: PiJob[]): void => {
    if (jobs.length === 0) return;
    const sid = sessionRef.current;
    clientRef.current?.dropNotifications();
    for (const [callId, job] of [...jobsRef.current]) {
      if (!jobs.includes(job)) continue;
      jobsRef.current.delete(callId);
      if (sid) void recordAnnouncement(sid, { requestId: job.requestId, kind: "cancelled", question: job.question, text: "" })
        .then(() => refreshUnreadRef.current(sid));
      job.cancelled = true;
      job.controller.abort();
      setCaptions((prev) => prev.map((c) => (c.id === job.captionId
        ? { ...c, text: `${c.text.replace(/^… /, "")}（${tRef.current("voiceCall.cancelled")}）` }
        : c)));
    }
    if (jobsRef.current.size === 0) setPiBusy(false);
  }, []);

  /**
   * What a spoken stop means, per ADR 0008 #5: only what this call started. A session-wide stop
   * needs a confirmation, and it is refused while the keyboard has messages queued — pi's abort
   * empties that queue, and today the voice path threw the pulled-out prompts away.
   * Returns the line the voice layer should say.
   */
  const stopFor = useCallback(async (scope: StopScope, confirmed: boolean): Promise<string> => {
    const sid = sessionRef.current;
    const jobs = [...jobsRef.current.values()];
    const queuedCount = sid ? await readPiQueueCount(sid) : 0;
    const armed = stopArmedUntilRef.current > Date.now();
    const action = decideStop(scope, {
      confirmed: confirmed && armed,
      queuedCount,
      ownsRun: jobs.some((job) => job.ownsRun),
    });
    switch (action) {
      case "mute-announcements":
        announcementsMutedRef.current = true;
        clientRef.current?.dropNotifications();
        return "好，不再念了。pi 的活儿继续跑，结果会作为待读留在页面上。";
      case "ask-confirmation":
        stopArmedUntilRef.current = Date.now() + STOP_CONFIRM_WINDOW_MS;
        return "「全部停止」会停掉这个会话正在跑的一切，包括你打字排队的消息。确认就说确认。";
      case "explain-queue":
        return `先不动：队列里还有 ${queuedCount} 条你打字的活儿，全停会把它们从队列里拿出来。要我只停语音这条吗？`;
      case "explain-queued":
        return "那条已经排进正在跑的回合里，撤不回来。我不会念它的结果，它会作为待读留在页面上。";
      case "abort-session": {
        stopArmedUntilRef.current = 0;
        cancelJobs(jobs);
        if (sid) void stopPiRun(sid);
        return "已全部停止。";
      }
      case "cancel-ask":
      default: {
        const mine = jobs.filter((job) => job.ownsRun);
        cancelJobs(mine);
        if (sid && mine.length) void stopPiRun(sid);
        return mine.length ? "已停掉 pi 正在为语音做的那件事。" : "语音这边没有在跑的活儿了。";
      }
    }
  }, [cancelJobs]);
  const stopForRef = useRef(stopFor);
  stopForRef.current = stopFor;

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

  /**
   * Free the microphone. The socket, audio out and transcript stay live — and the sentence the
   * user is mid-way through gets its chance to land first: the server ends turns on the audio clock
   * only, so stopping capture cold would strand both that utterance and every announcement queued
   * behind it (ADR 0008 #8).
   */
  const stopCapture = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (client) await client.flushSpeakingTurn().catch(() => undefined);
    const mic = micRef.current;
    micRef.current = null;
    if (mic) await mic.stop().catch(() => undefined);
  }, []);

  /**
   * One watcher for the whole call: it turns pi's `prompt_done` carrying a job's requestId into
   * "that answer is ready", which is what lets the bridge read the right answer rather than the
   * newest one. With the setting off it returns null and the bridge polls as it always did.
   */
  const getWatcher = useCallback((): RunEndWatcher | null => {
    if (!getEventStreamEnabled()) return null;
    if (!watcherRef.current) watcherRef.current = createRunEndWatcher();
    return watcherRef.current;
  }, []);

  /** Hand one question to pi, and announce its answer whenever it lands. */
  const startPiJob = useCallback((callId: string, question: string, queueBehind = false) => {
    const controller = new AbortController();
    const captionId = seqRef.current++;
    const requestId = createRequestId();
    const piJob: PiJob = { question, captionId, controller, cancelled: false, requestId, ownsRun: !queueBehind };
    jobsRef.current.set(callId, piJob);
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
        answer = await askPiReply(sid, `[语音通话] ${question}`, {
          signal: controller.signal,
          watcher: getWatcher() ?? undefined,
          requestIdFactory: () => requestId,
          queueBehind,
          onDisposition: (disposition) => { piJob.ownsRun = !disposition.joinedAnotherRun; },
        });
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
      // Model-facing: the voice layer says it in its own words. A queued ask is never spoken
      // (its answer cannot be matched to its question), and a call the user silenced keeps the
      // record unread instead — the count on the pill is what stays unmissable.
      const spoken = failed
        ? `pi 没能回答「${question}」：${answer.replace(/^pi: /, "")}`
        : `pi 对「${question}」的回答：${answer}`;
      const speak = maySpeak(job.ownsRun) && !announcementsMutedRef.current;
      const sid = sessionRef.current;
      if (sid) await announceRef.current(sid, spoken, { requestId, kind: failed ? "failure" : "answer", question, text: answer }, speak);
      else if (speak) clientRef.current?.notify(spoken);
    })();
  }, [getWatcher]);
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
      // The notice reached the model, so the call no longer owes it. A hang-up before this point
      // leaves the entry unread, which is exactly what the next call replays.
      onNoticeInjected: (tag) => {
        const sid = sessionRef.current;
        if (!sid || !tag) return;
        void markAnnouncementsRead(sid, [tag]).then(() => refreshUnreadRef.current(sid));
      },
      onAudioChunk: (b64) => audioOut.enqueue(b64),
      onFunctionCall: ({ callId, name, argumentsJson }) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(argumentsJson) as Record<string, unknown>; } catch { /* fall through */ }
        const question = String(args.question ?? "").trim();
        if (name === "stop_pi") {
          const scope = normalizeStopScope(args.scope);
          void stopForRef.current(scope, args.confirmed === true).then((line) => {
            client.sendFunctionOutput(callId, line, true);
          });
          return;
        }
        if (name !== "ask_pi" || !question) {
          client.sendFunctionOutput(callId, `unknown tool call ${name}`, false);
          return;
        }
        // One ask in flight (ADR 0008 #3): a second question is the user's decision, not this
        // layer's, because joining a running turn costs the answer its identity.
        const action = decideAsk(jobsRef.current.size, args.when_busy === "queue" ? "queue" : undefined);
        if (action === "conflict") {
          client.sendFunctionOutput(callId, JSON.stringify({
            state: "conflict",
            running: [...jobsRef.current.values()].map((job) => job.question),
            options: "ask the user: queue behind it (ask_pi again with when_busy=\"queue\"), or stop it (stop_pi)",
          }), true);
          return;
        }
        startPiJobRef.current(callId, question, action === "queue");
      },
      onError: (e) => {
        if (disposed) return;
        const fatal = e.code === "connection_error" || e.code === "session_limit_reached";
        if (fatal) {
          setError(e.code === "session_limit_reached"
            ? tRef.current("voiceCall.occupied", { holder: "另一台设备" })
            : e.message);
          setStatus("error");
          return;
        }
        // One refused or failed reply: the client re-asks when the way clears.
        setWarning(e.message);
      },
      // A call that went quiet without saying why is what the review scored 4/10 as 假在线: the
      // pill stayed green while nobody could be heard. End it out loud, and give the microphone back.
      onConnectionEnded: ({ everConnected }) => {
        if (disposed) return;
        leaseRef.current?.stop();
        leaseRef.current = null;
        setStatus("error");
        setError(tRef.current(everConnected ? "voiceCall.disconnected" : "voiceCall.occupied", { holder: "另一台设备" }));
        void stopCapture();
      },
    }, {
      cancelResponses: false,
      gateResponses: true,
      tools: [ASK_PI_TOOL, STOP_PI_TOOL],
      instructions: VOICE_LAYER_INSTRUCTIONS,
    });
    clientRef.current = client;
    // One speech-to-speech slot serves this deployment and the server refuses a second client
    // rather than preempting the first, so the line is asked for before the socket opens and given
    // up when a later device takes it (ADR 0008 #7).
    const lease = createLeaseClient({
      ownerId: leaseOwnerId,
      label: thisDeviceLabel(),
      onReleaseRequested: (takenOverBy) => {
        if (disposed) return;
        leaseRef.current = null;
        setStatus("error");
        setError(tRef.current("voiceCall.takeover", { holder: takenOverBy }));
        void stopCapture();
        client.close();
      },
    });
    leaseRef.current = lease;
    void (async () => {
      try {
        const held = await lease.acquire();
        if (disposed) {
          lease.stop();
          return;
        }
        if (!held.ok) {
          setError(tRef.current("voiceCall.occupied", { holder: held.holderLabel || "另一台设备" }));
          setStatus("error");
          return;
        }
        await client.connect();
        if (disposed) return;
        const replay = buildReplayMessage(history);
        if (replay) client.sendEvent({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: replay }] } });
        await startCapture();
        if (disposed) return;
        setStatus("live");
        // A call that opens onto an existing session owes whatever the last one never said.
        const sid = sessionRef.current;
        if (sid) await replayUnreadRef.current(sid);
      } catch (e) {
        if (disposed) return;
        setError((e as Error)?.message ?? "unreachable");
        setStatus("error");
      }
    })();
    return () => {
      disposed = true;
      clientRef.current = null;
      const heldLease = leaseRef.current;
      leaseRef.current = null;
      heldLease?.stop();
      for (const job of jobs.values()) {
        job.cancelled = true;
        job.controller.abort();
      }
      jobs.clear();
      const mic = micRef.current;
      micRef.current = null;
      if (mic) void mic.stop().catch(() => undefined);
      const watcher = watcherRef.current;
      watcherRef.current = null;
      watcher?.close();
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

  const replayUnreadRef = useRef(replayUnread);
  replayUnreadRef.current = replayUnread;

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

  const unreadLabel = unreadCount > 0 ? t("voiceCall.unread", { count: String(unreadCount) }) : "";

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
  // The unread count rides along wherever the call is: it is how a missed announcement
  // stays unmissable even when the answer itself was never spoken.
  const statusText = unreadLabel ? `${statusLine} · ${unreadLabel}` : statusLine;

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
        {piBusy ? t("voiceCall.askingPi") : unreadLabel || t("voiceCall.title")}
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
            {statusText}
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
