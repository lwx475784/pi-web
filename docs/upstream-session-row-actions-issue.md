# Issue draft: two read-only entries on the session row menu

Not committed to upstream yet — this is the text to file against
[agegr/pi-web](https://github.com/agegr/pi-web) if these two entries are ever
offered there. Built on this fork first because CONTRIBUTING.md keeps the
sidebar's session management deliberately small ("list, pin, archive, rename,
fork, delete, and project order — discuss anything beyond that in an issue
first").

## Use case

I run several sessions side by side in one project — one per task, plus their
forks — and I move things between them by hand. Two steps are missing.

1. **I need a session's id without opening it.** The session-info panel can copy
   the id and file path of the session that is *open*, but to get another row's
   id I have to open that session first, which costs me the one I was in. I
   paste the id into the pi CLI (`pi --resume`), into an issue, or into a
   message asking the current session about that one.
2. **I want to point one session at another.** "What did we decide in X about
   the retry policy?" today means: open X, read it, come back, restate it. If
   the current session gets the *path* of X's transcript, its own `read` and
   `grep` tools go and look — the model reads exactly what it needs, no summary
   step, no context spent on a copy of the whole conversation.

## Proposal

Two entries on the row's ⋯ menu, both read-only — they write nothing and they
open nothing (a row still opens on a click):

- **Copy session ID** (`C`) — the row's id on the clipboard, and nothing else.
  Same payload the session-info panel already offers, so the label reuses
  `session.copyId`. Both outcomes toast: on a LAN `http://` page there is no
  `navigator.clipboard`, the fallback `execCommand` answers false once the
  click's activation is old, and a success toast there would lie.
- **Reference in this chat** (`Q`) — one line into the composer that is already
  open, naming that session's own transcript file as a Markdown link:
  `[引用会话「title」](/Users/me/.pi/agent/sessions/…/2026-…_<id>.jsonl)`. The
  link text is the row's own title, so what the model reads matches what the
  list shows; the address is the `path` the session list already carries, so the
  click costs no request. pi-web renders such a link in the sent message (its
  in-app file handler, `lib/file-links.ts`), so the path hides behind the title
  in the transcript and stays in the prompt for the model.

## Deliberately not in it

- No new endpoint, no new setting, no new subsystem, no dependency: the payload
  is text, and the reference is the same "quote into the composer" mechanism the
  selection popover already uses (`insertQuote`, `lib/quoted-selection.ts`).
- No message-level reference, no family-member (subagent/side-chat) ids, and no
  reference from the search results — each is a bigger surface and none is
  needed for the use case above.
- `~/.pi/agent/sessions` is **not** added to the allowed file roots. Clicking
  the reference link opens the file viewer only where the sessions dir already
  happens to be under an allowed root; widening that boundary for a convenience
  is a call for you to make, not for me to assume.
- Nothing that changes what pi itself does: the reference is ordinary prompt
  text, not a template or a new protocol field.

## Where it lives here

`lib/session-reference.ts` (the line, and the two placement rules), the two
entries in `lib/sidebar-actions.ts` (`sessionMenuEntries`), the dispatch and the
copy in `components/SessionSidebar.tsx`, and `handleReferenceSession` in
`components/AppShell.tsx`. Behaviour notes are in
`docs/agents/sessions.md` (session sidebar section).
