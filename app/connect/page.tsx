"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CircleCheck, Loader2, Plug } from "lucide-react";

// Post-signup onboarding step: connect YOUR HubSpot portal before you start
// working the feed. Reached right after account creation (always) and after
// sign-in when no connection exists yet. Skippable — browsing works without
// it — but pushes fail with a "connect first" error until it's done, so the
// page says exactly that.

function ConnectInner() {
  const params = useSearchParams();
  const rawNext = params.get("next") || "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
  const hs = params.get("hs"); // error states bounced back from the OAuth callback

  const [state, setState] = useState<{ loaded: boolean; connected?: boolean; hubDomain?: string }>({
    loaded: false,
  });

  useEffect(() => {
    fetch("/api/hubspot/oauth/status")
      .then((r) => r.json())
      .then((d: { connected?: boolean; hubDomain?: string }) =>
        setState({ loaded: true, connected: d.connected, hubDomain: d.hubDomain }),
      )
      .catch(() => setState({ loaded: true }));
  }, []);

  // Already connected (e.g. landed here out of habit) — nothing to do.
  useEffect(() => {
    if (state.loaded && state.connected) {
      const t = setTimeout(() => window.location.assign(next), 1200);
      return () => clearTimeout(t);
    }
  }, [state.loaded, state.connected, next]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4">
      <div className="w-full max-w-md rounded-2xl border border-ink-800 bg-ink-900 p-6 shadow-xl sm:p-8">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-orange-500/40 bg-orange-500/10 text-orange-400">
            <Plug className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-ink-50">Connect your HubSpot</h1>
            <p className="font-mono text-[11px] text-ink-500">one click, your own portal</p>
          </div>
        </div>

        {!state.loaded ? (
          <p className="flex items-center gap-2 text-sm text-ink-400">
            <Loader2 className="h-4 w-4 animate-spin" /> checking your connection…
          </p>
        ) : state.connected ? (
          <p className="flex items-center gap-2 text-sm text-neon-300">
            <CircleCheck className="h-4 w-4 shrink-0" />
            Connected to {state.hubDomain ?? "your portal"} — taking you in…
          </p>
        ) : (
          <>
            {hs && (
              <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {hs === "denied"
                  ? "The connection was cancelled on the HubSpot side. Try again when ready."
                  : "The connection didn't complete — try again. If it keeps failing, tell Max."}
              </p>
            )}
            <p className="text-sm leading-relaxed text-ink-300">
              Everything you push from S2 Signal — tasks, contacts, notes — lands in{" "}
              <span className="font-semibold text-ink-100">your own HubSpot portal</span>, owned by
              you. Connecting takes one click and one approval on HubSpot&apos;s side.
            </p>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-ink-500">
              You can browse signals and briefs without it, but pushing to HubSpot won&apos;t work
              until you connect. Reconnect any time from the sidebar.
            </p>
            <a
              href="/api/hubspot/oauth/install"
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 py-2.5 font-mono text-sm font-semibold text-orange-300 transition-colors hover:bg-orange-500/20"
            >
              Connect HubSpot <ArrowRight className="h-4 w-4" />
            </a>
            <button
              onClick={() => window.location.assign(next)}
              className="mt-3 w-full text-center font-mono text-[11px] text-ink-500 transition-colors hover:text-ink-300"
            >
              skip for now
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense>
      <ConnectInner />
    </Suspense>
  );
}
