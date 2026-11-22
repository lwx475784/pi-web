// The browser side of the voice line's lease (`lib/voice/device-lease.ts` keeps the record, ADR
// 0008 #7). A call asks for the line before it opens its WebSocket, renews while it lives, and hands
// the line over when a later device claims it.
//
// Degradation matters more than strictness here: if the lease route cannot be reached — an older
// server, a network blip — the call must still go through. The lease exists to turn today's silent
// failure (a second client refused by the speech-to-speech slot, a first client that stopped being
// heard with nothing on screen) into a stated reason, not to add a new way for the call to fail.

import {
  LEASE_RENEW_MS,
  LEASE_RETRY_MS,
  LEASE_TAKEOVER_BUDGET_MS,
  type ClaimOutcome,
} from "./device-lease-shared";

export interface LeaseClientOptions {
  ownerId: string;
  /** What the displaced device is told: "这台浏览器", "iPhone", anything the page can name. */
  label: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** The line was taken: hang up, free the microphone, and say so — naming whoever took it. */
  onReleaseRequested?: (takenOverBy: string) => void;
  renewMs?: number;
  retryMs?: number;
  budgetMs?: number;
}

export type LeaseAcquireResult =
  | { ok: true; degraded: boolean }
  | { ok: false; reason: "occupied"; holderLabel: string };

interface RenewResponse {
  held?: boolean;
  releaseRequested?: boolean;
  takenOverBy?: string | null;
}

function localPost(fetchImpl: NonNullable<LeaseClientOptions["fetchImpl"]>, body: unknown): Promise<unknown> {
  return fetchImpl("/api/voice-lease", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
}

/** Whether a renewal means this page no longer holds the line. */
export function shouldReleaseOnRenewal(body: RenewResponse | null): boolean {
  if (!body) return false;
  return body.releaseRequested === true || body.held === false;
}

export function createLeaseClient(opts: LeaseClientOptions): {
  acquire(): Promise<LeaseAcquireResult>;
  stop(): void;
} {
  const fetchImpl = opts.fetchImpl
    ?? ((input: string, init?: RequestInit) => globalThis.fetch(new URL(input, window.location.origin).href, init));
  const renewMs = opts.renewMs ?? LEASE_RENEW_MS;
  const retryMs = opts.retryMs ?? LEASE_RETRY_MS;
  const budgetMs = opts.budgetMs ?? LEASE_TAKEOVER_BUDGET_MS;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let ended = false;

  function stopRenewing(): void {
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }

  function startRenewing(): void {
    stopRenewing();
    renewTimer = setInterval(() => {
      void localPost(fetchImpl, { action: "renew", ownerId: opts.ownerId }).then((body) => {
        const renewal = body as RenewResponse | null;
        if (ended || !shouldReleaseOnRenewal(renewal)) return;
        // The new device is waiting on this one: give the slot back before it retries, then let the
        // page close the socket and free the microphone.
        stopRenewing();
        void localPost(fetchImpl, { action: "release", ownerId: opts.ownerId });
        opts.onReleaseRequested?.(typeof renewal?.takenOverBy === "string" ? renewal.takenOverBy : "另一台设备");
      });
    }, renewMs);
  }

  return {
    async acquire() {
      const deadline = Date.now() + budgetMs;
      for (;;) {
        if (ended) return { ok: false, reason: "occupied", holderLabel: "" };
        const claimed = await localPost(fetchImpl, { action: "claim", ownerId: opts.ownerId, label: opts.label });
        const outcome = claimed as ClaimOutcome | null;
        if (outcome === null) {
          // No lease referee: behave like today's build — connect and let the server decide.
          return { ok: true, degraded: true };
        }
        if (outcome.kind === "granted") {
          startRenewing();
          return { ok: true, degraded: false };
        }
        if (Date.now() + retryMs > deadline) {
          return { ok: false, reason: "occupied", holderLabel: outcome.holderLabel };
        }
        // The holder is being told to hang up; retry while it does.
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    },
    stop() {
      ended = true;
      stopRenewing();
      void localPost(fetchImpl, { action: "release", ownerId: opts.ownerId });
    },
  };
}
