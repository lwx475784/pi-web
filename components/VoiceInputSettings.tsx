"use client";

import { useEffect, useState } from "react";

import { detectVoiceSupport, type VoiceSupport } from "@/hooks/useVoiceInput";
import { useI18n } from "@/hooks/useI18n";
import {
  DEFAULT_GATE_SENSITIVITY,
  DEFAULT_REALTIME_URLS,
  getGateSensitivity,
  getRealtimeUrl,
  getVoiceEnabled,
  getWakeWord,
  setGateSensitivity,
  setRealtimeUrl,
  setVoiceEnabled,
  setWakeWord,
} from "@/lib/voice/settings";

/**
 * Settings → General → Voice input: the feature switch, the address of the
 * self-hosted OpenAI Realtime (speech-to-speech) server, and the two gates that
 * keep other people's voices out of a call. Kept in localStorage, like the sound
 * toggle, so there is no server-side configuration to hold.
 */
export function VoiceInputSettings() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(true);
  const [url, setUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [sensitivity, setSensitivity] = useState(DEFAULT_GATE_SENSITIVITY);
  const [wake, setWake] = useState("");
  const [support, setSupport] = useState<VoiceSupport>("checking");

  useEffect(() => {
    setEnabled(getVoiceEnabled());
    const current = getRealtimeUrl();
    setUrl(current);
    setSavedUrl(current);
    setSensitivity(getGateSensitivity());
    setWake(getWakeWord());
    setSupport(detectVoiceSupport());
  }, []);

  const saveUrl = () => {
    setRealtimeUrl(url);
    setSavedUrl(url.trim());
  };

  const saveWake = () => {
    setWakeWord(wake);
    setWake(getWakeWord());
  };

  const changeSensitivity = (value: number) => {
    setSensitivity(value);
    setGateSensitivity(value);
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

      <label className="settings-voice-row">
        <span className="settings-voice-label">{t("settings.voiceUrl")}</span>
        <input
          className="settings-voice-input"
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
      </label>
      {enabled && savedUrl === "" && (
        <p className="settings-general-description">{t("settings.voiceDefaultUrls", { urls: DEFAULT_REALTIME_URLS.join(" · ") })}</p>
      )}

      <label className="settings-voice-row">
        <span className="settings-voice-label">{t("settings.voiceGate")}</span>
        <input
          className="settings-voice-slider"
          type="range"
          min={0}
          max={100}
          step={5}
          value={sensitivity}
          aria-label={t("settings.voiceGate")}
          aria-describedby="settings-voice-gate-hint"
          onChange={(event) => changeSensitivity(Number(event.target.value))}
        />
        <span className="settings-voice-value" aria-hidden="true">{sensitivity}</span>
      </label>
      <p id="settings-voice-gate-hint" className="settings-general-description">{t("settings.voiceGateHint")}</p>

      <label className="settings-voice-row">
        <span className="settings-voice-label">{t("settings.voiceWake")}</span>
        <input
          className="settings-voice-input"
          type="text"
          spellCheck={false}
          value={wake}
          placeholder={t("settings.voiceWakePlaceholder")}
          aria-label={t("settings.voiceWake")}
          aria-describedby="settings-voice-wake-hint"
          onChange={(event) => setWake(event.target.value)}
          onBlur={saveWake}
          onKeyDown={(event) => { if (event.key === "Enter") saveWake(); }}
        />
      </label>
      <p id="settings-voice-wake-hint" className="settings-general-description">{t("settings.voiceWakeHint")}</p>

      {(support === "insecure" || support === "no-mic") && (
        <p role="alert" className="settings-general-error">{t("settings.voiceUnavailable")}</p>
      )}
    </section>
  );
}
