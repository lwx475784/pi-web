"use client";

import type { VoiceStatus, VoiceSupport } from "@/hooks/useVoiceInput";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  status: VoiceStatus;
  support: VoiceSupport;
  isMobile: boolean;
  controlSize: number;
  onStart: () => void;
  onStop: () => void;
}

/**
 * Composer mic button: one tap starts dictation, the next stops it. Sits in
 * the composer's left control group beside the attach button, on both desktop
 * and phone layouts. Rendered only where the browser can capture audio.
 */
export function VoiceInputButton({ status, support, isMobile, controlSize, onStart, onStop }: Props) {
  const { t } = useI18n();
  if (support !== "ok") return null;

  const active = status === "listening";
  const busy = status === "connecting" || status === "finishing";
  const failed = status === "error";
  const label = active
    ? t("chat.voiceStop")
    : status === "connecting"
      ? t("chat.voiceConnecting")
      : status === "finishing"
        ? t("chat.voiceFinishing")
        : t("chat.voiceStart");

  return (
    <button
      onClick={active || busy ? onStop : onStart}
      title={label}
      aria-label={label}
      aria-pressed={active}
      style={{
        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        width: controlSize, height: controlSize, padding: 0,
        background: "none", border: "none",
        borderRadius: 9,
        color: active ? "var(--accent)" : failed ? "#ef4444" : "var(--text-muted)",
        cursor: "pointer",
        opacity: busy ? 0.6 : 1,
        animation: active || busy ? "pulse 1.4s ease-in-out infinite" : undefined,
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
    >
      <svg width={isMobile ? 18 : 15} height={isMobile ? 18 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    </button>
  );
}
