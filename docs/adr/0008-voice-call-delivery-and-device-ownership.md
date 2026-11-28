# 0008 — A voice answer is delivered by job identity: one ask in flight, a server-side unread ledger, and one device holds the mic

## Status

Accepted, not yet implemented. The eight work items are `docs/tickets/voice-delivery-01…08`.
Two stop-the-bleeding fixes already landed (`3e91e6a` waits past three minutes and queues a
mid-run ask; `737f03e` opens the panel in the corner and frees the mic on collapse) and are
re-scoped here: `3e91e6a` is treated as a bandage over the identity gap this ADR closes, not
as its solution.

## Context

The voice call hands real work to pi through one function tool. `ask_pi` answers the voice
layer immediately (`{state:"started"}`) because the deployed speech-to-speech server refuses
any response while a function call still owes it an output, and pi's real answer arrives
minutes later as an injected message tagged `[background event, not said by the user]`
(`components/VoiceConversationPanel.tsx`, `lib/voice/realtime-client.ts`, `lib/voice/pi-bridge.ts`).

That leaves exactly one hard question: **which answer belongs to which ask.** Today it is
inferred, not known — `askPiReply` waits for pi to go idle and then reads the newest
non-empty assistant text past the `leafId` it saw before sending (`lib/voice/pi-bridge.ts`).
The first real task measured 218.7 s end to end against a 180 s give-up: the voice layer
announced "pi did not answer in time", the answer landed 43 s later with no job left watching
it, and the next spoken question died on "pi is busy". The review
(`docs/voice-call-evaluation-2026-11-22.md`, 5.1/10) ranks mis-delivery above slowness: a
wrong answer spoken aloud is worse than a late one, because the user cannot tell them apart.

What the code and the deployment actually allow, verified while writing this ADR:

- pi's SDK resolves `prompt()` to `void`. The only identity a caller gets is
  `preflightResult("started" | "queued" | "handled")`. So a submission that **starts** a run
  is attributable, and one that **joins** a run's queue (`steer`, `followUp`) is not — which
  is precisely the path `3e91e6a` introduced.
- `POST /api/agent/[id]` answers `{success, data}` with no run id
  (`app/api/agent/[id]/route.ts`, `lib/rpc-manager.ts`), but the wrapper holds everything
  needed to mint one: it already resolves a prompt's entry id
  (`announceUserMessageEntry` → `user_message_entry`), `getBranch()` and the context route's
  `entryIds` are entry ids aligned with messages, and the SSE stream already forwards
  `agent_start` / `agent_end` / `agent_settled` / `prompt_done` / `user_message_entry`
  / `queue_update`. Identity is therefore a pi-web change, not an upstream one.
- The s2s server has **one** pipeline slot (`GET /v1/pool` → `{"size":1,"in_use":0}`;
  `num_pipelines` defaults to 1 upstream). A second client is rejected outright
  (`session_limit_reached`, close 1008), it does not queue. There is no read-idle timeout, so
  a live-but-silent socket stays open — but turn endpointing runs on the **audio clock** only,
  so releasing the mic mid-utterance never commits that utterance.
- Measured from the running pipeline (31 speech turns): server-side round-trip median 2.82 s,
  P90 5.37 s (LLM ≈ 0.74 s, TTS first audio ≈ 1.08 s). This is **not** spoken-to-heard latency;
  the two are not comparable and must not be quoted as one number.

The positioning question was asked and answered in interview: the call is a **production entry
point** for dispatching work, not ambient chit-chat. That is what makes delivery, not feature
breadth, the bar.

## Decision

1. **Delivery is the contract.** A finished answer is either spoken into a live call or
   recorded as unread. It is never silently dropped, and never spoken unless its owner is known.

2. **Identity, not inference.** The voice client mints a `requestId` per ask; the wrapper
   echoes it on `user_message_entry`, `prompt_done` and `prompt_error`, and the answer is
   resolved to the entry id that closed that run. The bridge goes event-driven over the
   existing SSE stream, keeping the current poll as a fallback behind a switch so a wire
   mismatch costs a delay, not an answer. (Ticket 01.)

3. **One ask in flight per call.** Because `queued` submissions cannot be attributed, a second
   spoken request while pi is working is a *conflict the user decides*, not a silent queue: the
   voice layer asks whether to hold it or stop the running one. This replaces `3e91e6a`'s
   automatic `followUp` queue for the voice path. (Ticket 03.)

4. **A ledger the device cannot lose.** Unread answers move out of `localStorage` into pi-web
   per session: bounded, 24 h expiry, explicit "clear this call". The collapsed pill carries
   the count, and the next call replays the most recent unread and states the rest as a number.
   Existing browser-only transcripts are not migrated; they expire. (Ticket 02.)

5. **Cancel means the thing you named.** `stop_pi` cancels the voice job it started. It does not
   abort the session and does not clear pi's whole queue — today `clearQueue()` also pulls out
   prompts typed in the composer and the voice path throws that result away, so keyboard work
   vanishes without a trace. "别念了" silences announcements only; "全部停止" aborts the session
   after the voice layer reads back how many jobs that would kill. (Ticket 04.)

6. **Side effects are confirmed by name, then forgiven per call.** Writes and state-changing
   commands (`write`/`edit`, `launchctl`, `git commit|push`, `rm`, `systemctl`, `ssh`, reboots)
   get one spoken read-back before they run; slow but harmless work (image and video
   generation, tests, memory notes) runs unconfirmed. A confirmed class stays confirmed for the
   rest of that call and resets on hang-up. A wake word is never authorization.

7. **One device, and say so.** The single pipeline slot stays. A later caller takes the slot
   from the earlier one, and the kicked side must state why it went quiet ("voice taken over by
   `<device>`") instead of the present silent `onclose`. Multi-device concurrency
   (`--num-pipelines 2`) waits for a measured cost in first-audio latency. (Ticket 05.)

8. **Releasing the mic closes the sentence.** Before capture stops, flush silence so the server
   ends and commits the in-flight utterance; if no `input_audio_buffer.committed` arrives within
   ~300 ms, discard that turn and clear the client's `speaking` flag, so a collapsed call cannot
   strand the announcement queue behind a half-spoken sentence. (Ticket 06.)

9. **What is spoken.** A finished answer is a two-sentence gist plus one offer to read the
   detail; long tables and reports stay on the page. A run past two minutes gets **one** coarse
   progress line (looking things up / changing code / running a command, plus elapsed), never a
   raw tool name. No dense progress chatter.

10. **Latency work is bounded.** The primary metric is spoken-to-heard: end of the user's
    utterance to the first audible frame at the device. TTS streaming first audio comes first;
    a faster small-talk model is second; the near-speech floor and the transcript gate are
    frozen — they are the noise defence, not a knob to trade against the metric.

11. **Acceptance is numeric.** Merged work needs fixtures that reproduce the failure modes this
    ADR is about — slow run, two asks at once, queued ask, dropped socket, stale audio,
    permission denial — including the existing gap where the bridge's fake world never returns
    `state`, so the idle gate has been untested since the first voice commit. "Production
    ready" additionally needs 20 synthesized utterances driven into the real WebSocket
    (`voice-gen` on the Windows box, no human in the loop) with a machine-built matrix of
    delivered / mis-paired / silent; **mis-pairing under five percent**. False-wake rate is the one thing
    synthesis cannot measure: it comes from a week of real use. (Tickets 07, 08.)

## Consequences

- The agent wire gains a correlation id on three event kinds. It is additive — an old client
  ignores it and falls back to polling — but it becomes part of the contract the voice call
  depends on, so renaming it later is a breaking change for a feature the user cannot see.
- Voice gets politer and slightly less automatic: a second question now costs an exchange
  ("hold it or stop the running one?") instead of quietly queueing. That is the price of
  attribution, and the interview bought it deliberately.
- Transcript retention moves from the browser to pi-web's own state, so the 24 h expiry and the
  clear button become user-visible promises rather than cache behaviour. The read-back ledger
  also means a finished answer that was never spoken is still findable after a reload.
- Event-driven delivery depends on the tab being alive; the ledger is what makes "page closed"
  an acceptable outcome instead of a lost answer.
- Delivery stops being a wall-clock budget. The 20-minute wait survives only as a wedged-run
  alarm ("stopped waiting; the job may still be running"), not as a definition of failure.
- Progress and takeover messages add speech, so announcements must stay serialized against one
  another: one thing at a time, newest-unread first, and a takeover notice outranks a gist.
- A number is now the merge bar. A `pi-bridge` change without fixtures that would have caught
  the 218.7 s case does not ship.

## Follow-ups

The experience group, all agreed as real work but out of this milestone: coarse progress copy,
the side-effect confirmation flow itself (this ADR fixes the rules, ticket 04 fixes only what
`stop_pi` touches), history clearing and 24 h expiry in the UI, TTS streaming first audio, a
faster small-talk route. Deferred until the call is shared with other people: authentication,
mandatory TLS, dropping the plain-LAN candidate URL, speaker identification.
Upstream path, settled on 2026-11-22: `agegr/pi-web` is somebody else's public repo and this
checkout has read-only rights there, so the work lives on a fork —
[`lwx475784/pi-web`](https://github.com/lwx475784/pi-web), branch `feature/voice-input`, pushed
after every gate item lands. No pull request yet: the delivery number (0 % mis-paired over 20
asks) is one sample, and a PR that changes the agent event wire (the `requestId` echo) should go
with the shape of that contract, not with a personal voice stack. When a PR is opened, this ADR
and the evaluation report ship with it as the rationale, and the branch is expected to rebase
onto upstream `main` first — it carries home topology (`lib/voice/settings.ts` defaults to this
household's tailnet host and LAN address, and the wake-word sample in
`lib/voice/turn-gate.test.mjs` is the assistant's real name), none of which belongs upstream
without a configuration story.
