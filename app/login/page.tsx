"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Lock, UserPlus } from "lucide-react";

// Sign in / create account. Accounts live in SingleStore (gtm_users), and
// creation is allowlist-gated server-side (ALLOWED_SIGNUP_EMAILS), enforced in
// /api/auth/signup — there is no public self-registration.

function LoginForm() {
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only allow a relative in-app path as the post-login destination — never an
  // absolute URL, so a crafted ?next= can't turn this into an open redirect.
  const rawNext = params.get("next") || "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(mode === "signin" ? "/api/auth/login" : "/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "signin" ? { email, password } : { email, password, displayName },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        signedIn?: boolean;
        error?: string;
      };
      if (res.ok && data.ok) {
        if (mode === "signup" && data.signedIn === false) {
          setMode("signin");
          setError("Account created — sign in.");
          return;
        }
        // Full navigation so middleware re-runs with the new cookies.
        // New accounts ALWAYS route through the HubSpot connect step; sign-ins
        // route through it only when no connection exists yet, so an already-
        // connected user never sees it.
        if (mode === "signup") {
          window.location.assign(`/connect?next=${encodeURIComponent(next)}`);
          return;
        }
        try {
          const st = (await (await fetch("/api/hubspot/oauth/status")).json()) as {
            configured?: boolean;
            connected?: boolean;
          };
          if (st.configured && !st.connected) {
            window.location.assign(`/connect?next=${encodeURIComponent(next)}`);
            return;
          }
        } catch {
          /* status unavailable — go straight in */
        }
        window.location.assign(next);
        return;
      }
      setError(data.error || (mode === "signin" ? "Sign-in failed" : "Sign-up failed"));
    } catch {
      setError("Network error — try again");
    } finally {
      setBusy(false);
    }
  };

  const input =
    "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-neon-600/50 focus:outline-none";

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-900 p-6 shadow-xl sm:p-8"
      >
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-neon-600/40 bg-neon-500/10 text-neon-400">
            {mode === "signin" ? <Lock className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-ink-50">S2 Signal</h1>
            <p className="font-mono text-[11px] text-ink-500">
              {mode === "signin" ? "sign in to continue" : "create your account"}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder={mode === "signup" ? "you@company.com" : "email"}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={input}
          />
          <input
            type="password"
            required
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            placeholder={mode === "signup" ? "password (10+ characters)" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
          {mode === "signup" && (
            <input
              type="text"
              required
              placeholder="display name (teammates see this)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={input}
            />
          )}
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-600/40 bg-neon-500/10 py-2.5 font-mono text-sm font-semibold text-neon-300 transition-colors hover:bg-neon-500/20 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
          className="mt-4 w-full text-center font-mono text-[11px] text-ink-500 transition-colors hover:text-ink-300"
        >
          {mode === "signin" ? (
            <>
              first time?{" "}
              <span className="text-sky-500 underline underline-offset-2 hover:text-sky-400">
                create your account
              </span>{" "}
              (invited email)
            </>
          ) : (
            <>
              already have an account?{" "}
              <span className="text-sky-500 underline underline-offset-2 hover:text-sky-400">
                sign in
              </span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
