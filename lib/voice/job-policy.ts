// The voice call's busy-time rules, as pure functions (ADR 0008 #3 and #5). Client-safe.
//
// Two decisions used to be made by whoever happened to be writing the callback at the time: what
// to do with a second spoken request while pi is already working, and what a spoken "算了" is
// allowed to stop. Both have a right answer that is not a matter of taste:
//
//   • pi gives an identity only to the prompt that *starts* a run. A message that joined another
//     run's queue cannot be told apart from that run's other output, so an answer to it must never
//     be spoken aloud — only recorded where the user can read it.
//   • The session queue is shared with the keyboard. A voice cancel that aborts the session also
//     empties that queue, and the prompts in it belong to whatever the user typed while walking to
//     the microphone. Losing one of those silently is worse than refusing to stop anything.
//
// So the call serialises its own asks, asks before joining somebody else's run, and scopes a
// spoken stop to exactly what the voice layer started.

/** What to do with a spoken request that needs pi while pi may already be busy. */
export type AskAction =
  /** Start a run of its own: it gets an identity, so its answer can be spoken. */
  | "start"
  /** The user already agreed to wait: join the running turn, answer read on the page. */
  | "queue"
  /** Something is already in flight: ask the user which they meant instead of choosing for them. */
  | "conflict";

/**
 * One ask in flight per call. A second question is a decision the user makes — hold it, or stop
 * the running one — because joining a running turn costs the answer its identity.
 */
export function decideAsk(inFlight: number, whenBusy?: string): AskAction {
  if (inFlight <= 0) return "start";
  return whenBusy === "queue" ? "queue" : "conflict";
}

/** Whether an answer may be spoken into the call. An unattributable one is only recorded. */
export function maySpeak(attributable: boolean): boolean {
  return attributable;
}

/** What the voice layer may stop. Mirrors the `stop_pi` tool's argument. */
export type StopScope =
  /** The ask this call started, and the run it started. */
  | "ask"
  /** The announcements only; pi keeps working. */
  | "announcements"
  /** Everything in this session, with the user's explicit confirmation. */
  | "everything";

/** The action a spoken stop resolves to. */
export type StopAction =
  | "cancel-ask"
  /** The ask is inside somebody else's run: nothing can be pulled out, so say so plainly. */
  | "explain-queued"
  | "mute-announcements"
  /** "全部停止" was said once; read back what it costs and wait for a yes. */
  | "ask-confirmation"
  /** The keyboard has messages queued; aborting would empty that queue. */
  | "explain-queue"
  | "abort-session";

export interface StopContext {
  /** The user has already confirmed a session-wide stop in this call. */
  confirmed: boolean;
  /** Messages waiting in pi's queue that a session abort would pull out. */
  queuedCount: number;
  /** The voice ask started the run it is asking to stop. */
  ownsRun: boolean;
}

export function normalizeStopScope(raw: unknown): StopScope {
  return raw === "announcements" || raw === "everything" ? raw : "ask";
}

export function decideStop(scope: StopScope, ctx: StopContext): StopAction {
  if (scope === "announcements") return "mute-announcements";
  if (scope === "everything") {
    if (!ctx.confirmed) return "ask-confirmation";
    // A session-wide stop is allowed to empty a queue only when the queue holds nothing
    // somebody else put there. Otherwise the voice layer explains, and the keyboard's work
    // survives the sentence "全部停止".
    return ctx.queuedCount > 0 ? "explain-queue" : "abort-session";
  }
  return ctx.ownsRun ? "cancel-ask" : "explain-queued";
}
