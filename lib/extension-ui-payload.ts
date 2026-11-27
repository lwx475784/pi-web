/**
 * What a page inside the custom panel means when it clicks a choice (ADR 0009).
 *
 * The frame posts `{ pick, label }`; the answer goes back over the channel that
 * already carries typed input, as one JSON line. Anything that is not a pick —
 * typed text, terminal key codes — keeps travelling as it does today, which is
 * what lets one extension serve a patched and an unpatched host at once.
 */
export function toCustomPanelPickPayload(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const { pick, label } = data as { pick?: unknown; label?: unknown };
  if (typeof pick !== "string" || pick.length === 0) return null;
  return JSON.stringify({
    pick,
    ...(typeof label === "string" && label ? { label } : {}),
  });
}
