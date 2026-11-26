/**
 * A session row as one Markdown line that references it from another session's
 * composer (the sidebar row menu's "Reference in this chat").
 *
 * The link text is the row's own title, so what the model reads matches what
 * the list shows; the address is the session's `.jsonl`, which pi's `read` and
 * `grep` tools reach directly. pi-web renders such a link in the sent message
 * (components/MarkdownBody.tsx → lib/file-links.ts), so the path hides behind
 * the title there and stays in the prompt text for the model.
 */

import { quoteSeparator } from "./quoted-selection";
import { sessionDisplayTitle } from "./session-fork-name";
import { toSlashPath } from "./paths";

export interface SessionReferenceInput {
  id: string;
  name?: string;
  firstMessage: string;
  path: string;
}

/** A composer's draft, as the draft store holds it (or would, unmounted). */
export interface ReferenceDraft {
  value: string;
  /** Attached images, if any: they make a leading `!` ordinary text. */
  images?: readonly unknown[];
}

/**
 * Link text as it must be written: brackets and the escape character itself
 * are literal there, so a title like `改 [bug] 修好了` cannot close the link.
 */
export function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

/**
 * The session file as a Markdown link destination (the `href` it renders to).
 *
 * A Windows path goes to slashes: a backslash destination keeps no href in
 * pi-web's Markdown (docs/agents/sessions.md, "Windows Markdown file links"),
 * and pi itself gives the model forward slashes. A destination that a bare one
 * cannot hold — whitespace, parentheses or angle brackets (CommonMark) — goes
 * between `<` and `>`, which is the same file to the reader either way.
 */
export function sessionFileHref(path: string): string {
  const filePath = /^[A-Za-z]:[\\/]/.test(path) ? toSlashPath(path) : path;
  return /[\s()<>]/.test(filePath)
    ? `<${filePath.replace(/[<>\\]/g, "\\$&")}>`
    : filePath;
}

/**
 * Whether a draft is a `!` shell command rather than a prompt: ChatInput's own
 * rule (`bashMode`) — a leading `!` counts only while no image is attached.
 * A command takes the reference at the caret as typed (`! grep … <path>` is
 * what someone is reaching for); a paragraph break inside it would be text
 * handed to the shell.
 */
export function isBashDraft(draft: ReferenceDraft | null | undefined): boolean {
  if (!draft || (draft.images?.length ?? 0) > 0) return false;
  return draft.value.trimStart().startsWith("!");
}

/**
 * The draft text to store when the composer is not mounted (the loading screen
 * a session switch shows unmounts it): the line goes in as a paragraph of its
 * own, exactly as `insertQuote` would place it, so it reads the same whenever
 * the composer comes back.
 */
export function referenceDraftValue(draft: ReferenceDraft | null | undefined, line: string): string {
  const value = draft?.value ?? "";
  return value + quoteSeparator(value) + line;
}

/**
 * `label` turns the title into the link text, in the interface language
 * (the caller's `t("sidebar.referenceSessionLabel", { title })`): the model is
 * told what the link is, and no words are hardcoded in one language here.
 */
export function sessionReferenceMarkdown(
  session: SessionReferenceInput,
  label: (title: string) => string,
): string {
  return `[${escapeMarkdownLinkText(label(sessionDisplayTitle(session)))}](${sessionFileHref(session.path)})`;
}
