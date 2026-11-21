"use client";

import { useEffect, useState } from "react";

import { detectVoiceSupport, type VoiceSupport } from "@/hooks/useVoiceInput";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_REALTIME_URLS, getRealtimeUrl, getVoiceEnabled, setRealtimeUrl, setVoiceEnabled } from "@/lib/voice/settings";

/**
 * Settings → General → Voice input: the feature switch and the address of the
 * self-hosted OpenAI Realtime (speech-to-speech) server. Kept in localStorage,
 * like the sound toggle, so there is no server-side configuration to hold.
 */
export function VoiceInputSettings() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [support, setSupport] = useState<VoiceSupport>("checking");

  useEffect(() => {
    setEnabled(getVoiceEnabled());
    const current = getRealtimeUrl();
    setUrl(current);
    setSavedUrl(current);
    setSupport(detectVoiceSupport());
  }, []);

  const saveUrl = () => {
    setRealtimeUrl(url);
    setSavedUrl(url.trim());
  };

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.voice")}</h3>
      <p id="settings-voice-description" className="settings-general-description">{t("settings.voiceHint")}</p>
      <div className="settings-send-mode-options" role="group" aria-label={t("settings.voice")} aria-describedby="settings-voice-description">
        <label className="settings-send-mode-option">
          <input
            type="checkbox"
            checked={enabled}
            className="sr-only"
            onChange={(event) => {
              setVoiceEnabled(event.target.checked);
              setEnabled(event.target.checked);
            }}
          />
          <span className="settings-send-mode-label">{t("settings.voiceEnabled")}</span>
        </label>
      </div>
      <input
        className="model-context-input"
        type="text"
        inputMode="url"
        spellCheck={false}
        value={url}
        placeholder={DEFAULT_REALTIME_URLS[0]}
        aria-label={t("settings.voiceUrl")}
        onChange={(event) => setUrl(event.target.value)}
        onBlur={saveUrl}
        onKeyDown={(event) => { if (event.key === "Enter") saveUrl(); }}
      />
      {enabled && savedUrl === "" && (
        <p className="settings-general-description">{t("settings.voiceDefaultUrls", { urls: DEFAULT_REALTIME_URLS.join(" · ") })}</p>
      )}
      {(support === "insecure" || support === "no-mic") && (
        <p role="alert" className="settings-general-error">{t("settings.voiceUnavailable")}</p>
      )}
    </section>
  );
}
