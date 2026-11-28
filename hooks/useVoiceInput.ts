"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RealtimeDictationClient } from "@/lib/voice/realtime-client";
import { startMicCapture, type MicHandle } from "@/lib/voice/mic";
import { getGateSensitivity, getRealtimeUrls, getVoiceEnabled } from "@/lib/voice/settings";
import { createNearSpeechGate } from "@/lib/voice/turn-gate";

export type VoiceStatus = "idle" | "connecting" | "listening" | "finishing" | "error";
export type VoiceSupport = "checking" | "ok" | "insecure" | "no-mic";

/** Whether this browser context can capture microphone audio at all. */
export function detectVoiceSupport(): VoiceSupport {
  if (typeof navigator === "undefined" || typeof window === "undefined") return "no-mic";
  if (!window.isSecureContext) return "insecure";
  if (!navigator.mediaDevices?.getUserMedia) return "no-mic";
  return "ok";
}

// The trailing grace while the server's VAD commits the last utterance and the
// ASR pass runs; the session closes early as soon as the finals land.
const FINISH_GRACE_MS = 5000;
// Appended on stop: the server VAD ends turns on silence, and a stream that
// simply stops never gives it any.
const FLUSH_SILENCE_CHUNKS = 6;
const ERROR_AUTO_IDLE_MS = 2500;

export interface UseVoiceInputResult {
  status: VoiceStatus;
  support: VoiceSupport;
  /** In-progress hypothesis for the utterance being spoken (display only). */
  partial: string;
  error: string | null;
  start: () => void;
  /** Stop capture, flush, and stay open until the final transcripts land. */
  stop: () => void;
  /** Tear the session down right now, dropping anything unfinished. */
  cancel: () => void;
}

/**
 * Push-to-talk dictation against an OpenAI Realtime server: the button click
 * is the user gesture iOS needs, captured audio streams to the server's VAD,
 * and every finalized utterance arrives at `onSegment` for the caller to drop
 * into the draft. The server's auto-generated assistant replies are cancelled
 * by the client, so dictation costs the LLM nothing.
 */
export function useVoiceInput(onSegment: (transcript: string) => void): UseVoiceInputResult {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [support, setSupport] = useState<VoiceSupport>("checking");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);

  const statusRef = useRef<VoiceStatus>("idle");
  const clientRef = useRef<RealtimeDictationClient | null>(null);
  const micRef = useRef<MicHandle | null>(null);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSegmentRef = useRef(onSegment);
  onSegmentRef.current = onSegment;

  const setBusy = useCallback((next: VoiceStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const close = useCallback(() => {
    if (finishTimerRef.current) { clearTimeout(finishTimerRef.current); finishTimerRef.current = null; }
    if (errorTimerRef.current) { clearTimeout(errorTimerRef.current); errorTimerRef.current = null; }
    const mic = micRef.current;
    micRef.current = null;
    if (mic) void mic.stop().catch(() => undefined);
    const client = clientRef.current;
    clientRef.current = null;
    if (client) client.close();
    setPartial("");
  }, []);

  useEffect(() => {
    setSupport(detectVoiceSupport());
    return () => {
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      const mic = micRef.current;
      micRef.current = null;
      if (mic) void mic.stop().catch(() => undefined);
      const client = clientRef.current;
      clientRef.current = null;
      if (client) client.close();
    };
  }, []);

  const finishNow = useCallback(() => {
    if (statusRef.current !== "finishing") return;
    close();
    setBusy("idle");
  }, [close, setBusy]);

  const fail = useCallback((message: string) => {
    close();
    setError(message);
    statusRef.current = "error";
    setStatus("error");
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null;
      if (statusRef.current !== "error") return;
      setError(null);
      statusRef.current = "idle";
      setStatus("idle");
    }, ERROR_AUTO_IDLE_MS);
  }, [close]);

  const start = useCallback(() => {
    const current = statusRef.current;
    if (current === "connecting" || current === "listening" || current === "finishing") return;
    if (!getVoiceEnabled()) return;
    close();
    setError(null);
    setBusy("connecting");
    const client = new RealtimeDictationClient(getRealtimeUrls(), {
      onSegment: (transcript) => {
        onSegmentRef.current(transcript);
        // Every finals landed: a short settle, then drop the session.
        if (statusRef.current === "finishing") {
          if (finishTimerRef.current) clearTimeout(finishTimerRef.current);
          finishTimerRef.current = setTimeout(finishNow, 600);
        }
      },
      onPartial: setPartial,
      onError: (e) => fail(e.message),
    });
    clientRef.current = client;
    void (async () => {
      try {
        await client.connect();
        if (clientRef.current !== client) return; // cancelled meanwhile
        const mic = await startMicCapture((chunk) => {
          if (clientRef.current === client) client.sendAudio(chunk);
        }, { gate: createNearSpeechGate({ sensitivity: getGateSensitivity() }) });
        if (clientRef.current !== client) {
          await mic.stop();
          return;
        }
        micRef.current = mic;
        setBusy("listening");
      } catch (e) {
        if (clientRef.current !== client) return;
        const name = (e as { name?: string })?.name;
        const message = name === "NotAllowedError"
          ? "microphone permission denied"
          : (e as Error)?.message || "voice server unreachable";
        fail(message);
      }
    })();
  }, [close, fail, finishNow, setBusy]);

  const stop = useCallback(() => {
    const current = statusRef.current;
    if (current !== "listening" && current !== "connecting") return;
    const mic = micRef.current;
    micRef.current = null;
    if (mic) void mic.stop().catch(() => undefined);
    const client = clientRef.current;
    if (client) {
      try { client.sendSilenceChunks(FLUSH_SILENCE_CHUNKS); } catch { /* closing */ }
    }
    setBusy("finishing");
    finishTimerRef.current = setTimeout(finishNow, FINISH_GRACE_MS);
  }, [finishNow, setBusy]);

  const cancel = useCallback(() => {
    if (statusRef.current === "idle") return;
    close();
    setBusy("idle");
  }, [close, setBusy]);

  return { status, support, partial, error, start, stop, cancel };
}
