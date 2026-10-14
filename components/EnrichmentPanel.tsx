"use client";

import { useEffect, useState } from "react";
import {
  Database,
  Github,
  Mail,
  Users,
  Banknote,
  Code2,
  ArrowUpRight,
  CircleCheck,
  CircleX,
  CircleDashed,
  CircleAlert,
} from "lucide-react";
import type { EnrichmentProfile, ProviderId } from "@/lib/enrich/types";
import { fmtUSD, fmtNum } from "@/lib/format";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  apollo: "Apollo",
  hunter: "Hunter",
  github: "GitHub",
  proxycurl: "Proxycurl",
  crunchbase: "Crunchbase",
};

function ProviderChip({
  id,
  configured,
  ok,
  error,
}: {
  id: ProviderId;
  configured: boolean;
  ok: boolean;
  error?: string;
}) {
  // Four states: ok, ok-with-warnings (partial failure, e.g. Apollo org data
  // loaded but people search was plan-gated), failed, not configured.
  const partial = ok && Boolean(error);
  const Icon = partial ? CircleAlert : ok ? CircleCheck : configured ? CircleX : CircleDashed;
  const cls = partial
    ? "border-amber-500/40 text-amber-400"
    : ok
      ? "border-neon-600/40 text-neon-300"
      : configured
        ? "border-red-500/40 text-red-400"
        : "border-ink-700 text-ink-500";
  return (
    <span
      title={partial ? `Partial: ${error}` : ok ? "Connected" : error || "Not configured"}
      className={`inline-flex items-center gap-1.5 rounded border bg-ink-950 px-2 py-1 font-mono text-[11px] ${cls}`}
    >
      <Icon className="h-3 w-3" />
      {PROVIDER_LABEL[id]}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-400">{label}</p>
      <p className="mt-1 truncate font-mono text-lg font-bold text-ink-100">{value}</p>
    </div>
  );
}

export function EnrichmentPanel({
  company,
  domain,
}: {
  company: string;
  domain?: string;
}) {
  const [profile, setProfile] = useState<EnrichmentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setProfile(null);

    const params = new URLSearchParams({ company });
    if (domain) params.set("domain", domain);

    fetch(`/api/enrich?${params.toString()}`)
      .then(async (res) => {
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          data = { error: `HTTP ${res.status} — ${res.statusText || "non-JSON response"}` };
        }
        if (cancelled) return;
        if (!res.ok) {
          const msg = (data as { error?: string })?.error;
          setError(msg || `Enrichment failed (${res.status})`);
        } else {
          setProfile(data as EnrichmentProfile);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [company, domain]);

  return (
    <section className="animate-fade-in rounded-lg border border-ink-700 bg-ink-900 p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
          <Database className="h-4 w-4 text-sky-400" />
          live enrichment
        </h3>
        {profile && (
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => {
              const r = profile.providers[id];
              return (
                <ProviderChip
                  key={id}
                  id={id}
                  configured={r.configured}
                  ok={r.ok}
                  error={r.error}
                />
              );
            })}
          </div>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          <p className="font-mono text-xs text-sky-400">
            ▸ querying Apollo, Hunter, GitHub, Proxycurl, Crunchbase…
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-lg" />
            ))}
          </div>
        </div>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : profile ? (
        <EnrichmentBody profile={profile} />
      ) : null}
    </section>
  );
}

function EnrichmentBody({ profile }: { profile: EnrichmentProfile }) {
  const r = profile.rollup;
  const github = profile.providers.github.ok ? profile.providers.github.data : undefined;
  const unconfigured = (Object.keys(PROVIDER_LABEL) as ProviderId[]).filter(
    (id) => !profile.providers[id].configured,
  );
  const hasAnyData = Object.values(profile.providers).some((p) => p.ok);

  if (!hasAnyData) {
    return (
      <div className="text-sm text-ink-400">
        <p>
          No enrichment data returned.{" "}
          {unconfigured.length > 0 &&
            `Configure ${unconfigured
              .map((id) => PROVIDER_LABEL[id])
              .join(", ")} API keys to unlock firmographic, contact and engineering data.`}
        </p>
        <ul className="mt-2 space-y-1 font-mono text-xs text-ink-500">
          {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((id) => {
            const p = profile.providers[id];
            return !p.ok && p.error ? (
              <li key={id}>
                {PROVIDER_LABEL[id]}: {p.error}
              </li>
            ) : null;
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Headline stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {r.totalHeadcount ? (
          <Stat label="headcount" value={fmtNum(r.totalHeadcount)} />
        ) : null}
        {r.sweHeadcount ? <Stat label="eng headcount" value={fmtNum(r.sweHeadcount)} /> : null}
        {r.repoCount !== undefined ? (
          <Stat label="public repos" value={fmtNum(r.repoCount)} />
        ) : null}
        {r.totalStars !== undefined ? (
          <Stat label="github stars" value={fmtNum(r.totalStars)} />
        ) : null}
        {r.commitsLast90d !== undefined ? (
          <Stat label="commits / 90d" value={`${fmtNum(r.commitsLast90d)}+`} />
        ) : null}
        {r.contributorEstimate !== undefined ? (
          <Stat label="contributors (est)" value={`${fmtNum(r.contributorEstimate)}+`} />
        ) : null}
        {r.totalRaisedUsd ? (
          <Stat label="total raised" value={fmtUSD(r.totalRaisedUsd)} />
        ) : null}
        {r.lastRound ? <Stat label="last round" value={r.lastRound} /> : null}
      </div>

      {/* Languages + tech stack */}
      {(r.topLanguages.length > 0 || r.techStack.length > 0) && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-ink-400">
            <Code2 className="h-3.5 w-3.5" /> stack
          </p>
          <div className="flex flex-wrap gap-1.5">
            {r.topLanguages.map((l) => (
              <span
                key={`lang-${l}`}
                className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 font-mono text-[11px] text-violet-300"
              >
                {l}
              </span>
            ))}
            {r.aiDevTools.map((t) => (
              <span
                key={`ai-${t}`}
                className="rounded border border-neon-600/40 bg-neon-500/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-neon-300"
                title="SingleStore-relevant data technology detected — a reason to ask, not evidence of pain"
              >
                ⚡ {t}
              </span>
            ))}
            {r.techStack
              .filter((t) => !r.aiDevTools.includes(t))
              .slice(0, 14)
              .map((t) => (
                <span
                  key={`tech-${t}`}
                  className="rounded border border-ink-700 bg-ink-950 px-2 py-0.5 font-mono text-[11px] text-ink-400"
                >
                  {t}
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Top repos */}
      {github && github.topRepos.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-ink-400">
            <Github className="h-3.5 w-3.5" /> top repos · {github.org}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {github.topRepos.slice(0, 6).map((repo) => (
              <a
                key={repo.fullName}
                href={repo.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group rounded-lg border border-ink-700 bg-ink-950/60 p-3 transition-colors hover:border-ink-600"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-sm text-ink-100 group-hover:text-neon-300">
                    {repo.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-amber-400">
                    ★ {fmtNum(repo.stars)}
                  </span>
                </div>
                <p className="mt-1 truncate text-[11px] text-ink-500">
                  {repo.language ? `${repo.language} · ` : ""}
                  {repo.description || "no description"}
                </p>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Contacts */}
      {r.contacts.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-ink-400">
            <Users className="h-3.5 w-3.5" /> contacts
            {r.emailPattern ? (
              <span className="ml-2 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] normal-case text-ink-400">
                pattern: {r.emailPattern}@{r.domain}
              </span>
            ) : null}
          </p>
          <div className="overflow-hidden rounded-lg border border-ink-700">
            <table className="w-full border-collapse text-sm">
              <tbody>
                {r.contacts.slice(0, 8).map((c, i) => (
                  <tr key={i} className="border-b border-ink-700 bg-ink-950/40 last:border-0">
                    <td className="p-2.5 text-ink-100">{c.name || "—"}</td>
                    <td className="p-2.5 text-xs text-ink-400">{c.title || "—"}</td>
                    <td className="p-2.5 font-mono text-xs text-ink-300">
                      {c.email ? (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3 text-ink-500" />
                          {c.email}
                          {c.emailStatus && (
                            <span className="text-[10px] text-ink-500">({c.emailStatus})</span>
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2.5 text-right">
                      {c.linkedinUrl && (
                        <a
                          href={c.linkedinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-xs text-neon-400 hover:text-neon-300"
                        >
                          in <ArrowUpRight className="h-3 w-3" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Funding detail */}
      {profile.providers.crunchbase.ok &&
        profile.providers.crunchbase.data?.lastRound?.amountUsd && (
          <p className="flex items-center gap-1.5 font-mono text-xs text-ink-400">
            <Banknote className="h-3.5 w-3.5 text-amber-400" />
            last round: {profile.providers.crunchbase.data.lastRound.type} ·{" "}
            {fmtUSD(profile.providers.crunchbase.data.lastRound.amountUsd)}
            {profile.providers.crunchbase.data.lastRound.announcedOn
              ? ` · ${profile.providers.crunchbase.data.lastRound.announcedOn}`
              : ""}
          </p>
        )}

      {unconfigured.length > 0 && (
        <p className="border-t border-ink-700 pt-3 text-[11px] text-ink-600">
          Unlock more: set{" "}
          {unconfigured.map((id) => PROVIDER_LABEL[id]).join(", ")} API key
          {unconfigured.length > 1 ? "s" : ""} in env to add firmographics, verified
          emails and LinkedIn headcount. See README for variable names.
        </p>
      )}
    </div>
  );
}
