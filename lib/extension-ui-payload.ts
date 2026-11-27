/**
 * What a page inside the custom panel means when it answers (ADR 0009).
 *
 * The host stays schema-agnostic: a frame posts a plain object, and the host forwards it
 * verbatim as one JSON line over the channel that already carries typed input. What the
 * payload *means* belongs to the extension — `{pick}` for a one-shot probe, `{answers:[…]}`
 * or `{cancelled:true}` for a stepper page — and the extension decides whether to settle.
 *
 * The first version only forwarded `{pick}`, which silently swallowed every other shape:
 * the panel looked frozen because the extension never received the answer. That is why the
 * guard here is "plain object with at least one key", not a field list.
 */
export function toCustomPanelInput(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = Object.keys(data as Record<string, unknown>);
  if (keys.length === 0) return null;
  return JSON.stringify(data);
}
