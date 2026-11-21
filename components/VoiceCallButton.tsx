"use client";

import { useI18n } from "@/hooks/useI18n";

/**
 * Composer entry for the two-layer voice call (mic icon for dictation, this
 * handset icon for talking with the agent). Rendered only when the caller
 * offers a live session to attach the call to.
 */
export function VoiceCallButton({ isMobile, controlSize, onStart }: { isMobile: boolean; controlSize: number; onStart: () => void }) {
  const { t } = useI18n();
  return (
    <button
      onClick={onStart}
      title={t("chat.voiceCall")}
      aria-label={t("chat.voiceCall")}
      style={{
        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        width: controlSize, height: controlSize, padding: 0,
        background: "none", border: "none",
        borderRadius: 9,
        color: "var(--text-muted)",
        cursor: "pointer",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
    >
      <svg width={isMobile ? 18 : 15} height={isMobile ? 18 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
      </svg>
    </button>
  );
}
