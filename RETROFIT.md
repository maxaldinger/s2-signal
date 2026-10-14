# Retrofit brief: Bito Signal → S2 Signal (SingleStore)

This repo is a clone of the user's Bito Signal sales-intelligence dashboard. It is being retrofitted, feature for feature, into **S2 Signal**: the same app, built for selling **SingleStore**. The user is a sales/solutions candidate demoing it to SingleStore's Solutions Engineering team on Fri 2026-10-16. **Mirror the Bito app's behaviour, UX, structure and level of rigor exactly; change only what is Bito-specific.**

## Already done (do not redo)
- **Database:** Supabase is gone. Every DB call goes to SingleStore through `lib/s2/*` (supabase-js-compatible builder: `adminClient().from("gtm_x")…`), `lib/store.ts` (signals/briefs/directory/state; was `lib/supabase.ts`, `supabaseConfigured` is now `dbConfigured`), and `lib/githubProspect/store.ts`. Tables are `gtm_*`. Auth is `lib/auth.ts` / `lib/session.ts`. Don't touch these files.
- **Client state keys** were renamed `bito-*` → `s2-*`.
- **Product context:** `lib/bito.ts` is replaced by `lib/singlestore.ts`. Use `SINGLESTORE_CONTEXT` / `singlestoreContextFor(focus)` with `type S2Focus = "realtime" | "ai"`. Read the whole file before writing any prompt. It is the ONLY source of SingleStore product facts, proof points, pricing and competitive positioning; never invent others. `realtime` (the default) leads with the core engine (HTAP, real-time analytics, consolidation); `ai` leads with vector + full-text + AI functions. Wherever Bito code used `"governor"` / `"ai_architect"`, map it to `"realtime"` / `"ai"`. The research behind it, including what could not be verified, is in `research/singlestore-sources.md`.
- **ICP sub-score keys** (`lib/types.ts` `ICPScore`) are renamed. Each is 0–20, and the sum plus the bonus is capped at 99:
  | key | was | meaning for SingleStore |
  |---|---|---|
  | `dataScale` | sweHeadcount | data volume / transaction volume / data + eng org scale |
  | `architectureComplexity` | codebaseComplexity | number of stitched data systems (OLTP + warehouse/lakehouse + search + cache + vector + streaming) and the pipelines between them |
  | `realtimeWorkload` | multiRepo | customer-facing real-time analytics, high-concurrency, low-latency query needs, HTAP |
  | `scalingActivity` | (same) | growth, migrations, re-platforming, data-platform initiatives |
  | `aiWorkload` | aiToolingSpend | gen-AI / RAG / semantic search / agents in production or being built |
  | `streaming` bonus | kubernetes | Kafka / Kinesis / Pulsar / Flink / Debezium-CDC evidence (0–10 bonus, with evidence) |
- **Segments** (`SegmentId`, `SEGMENTS` in `lib/data.ts`): saas, fintech, adtech, cybersecurity, marketplace, ai, media, industrial, telecom, health, logistics, retail, enterprise. Removed: devtools, auto, defense. Any hard-coded segment list or alias map (e.g. in the signals and intel routes) must be updated to these.

## Mapping rules for everything else
- **Brand:** "Bito Signal" → "S2 Signal" (wordmark `s2signal`). "Bito" the seller → "SingleStore". "built for bito.ai" → "built for SingleStore". Never leave the words Bito, Governor or AI Architect in user-visible text, prompts or generated documents. Comments too where practical.
- **`sweEstimate` / "SWE"** stays as the internal field name (to limit churn), but it now means **engineering headcount (software + data engineers)**. User-visible labels say "eng" or "engineers", not "SWEs". The SWE band filter is still an engineering-size filter.
- **Signal types** keep their ids. Re-aim each at SingleStore buying signals:
  - `hiring`: data-platform / data-infra / database / streaming / real-time analytics / ML-platform hiring.
  - `layoffs`: cost cutting, which drives infrastructure consolidation.
  - `oss`: activity on databases, streaming and vector OSS.
  - `github`: engineers at the account active on repos SingleStore buyers touch (the watchlist).
  - `ma`: M&A that creates data-estate consolidation.
  - `funding`: rounds earmarked for data/AI platform or scale.
  - `ai`: gen-AI / RAG / vector / agent product launches and AI-infrastructure spend.
  - `icp`: Apollo sweep on firmographics + technographics (Snowflake, Databricks, Kafka, Elasticsearch, ClickHouse, Postgres/MySQL at scale, Redis, Pinecone…).
- **Buyers & champions** (replace Bito's VP Eng / DevEx / Platform map):
  - **Economic buyers:** CTO, VP/SVP Engineering, Chief Data Officer, VP Data/Analytics.
  - **Champions:** Head/Director of Data Engineering, Data Platform, Platform/Infrastructure, Database Engineering/Architecture, Real-time Analytics, ML/AI Platform.
  - **Feel the pain:** staff/principal data engineers, database architects, SRE/DBAs on hot OLTP clusters, engineers building customer-facing analytics or RAG.
  - **Influencers:** data architects, FinOps / cloud-cost owners (warehouse and DB spend), security/compliance.
- **Economics:** Bito's "token cost exposure" (per-seat AI-coding spend) becomes **data-estate cost & consolidation exposure**: the modeled spend on the systems SingleStore could consolidate (warehouse compute, OLTP replicas, search clusters, vector DB, cache, ETL/CDC tooling, plus engineer time maintaining pipelines). Use public pricing anchors only from `lib/singlestore.ts` PRICING, and label every number MEASURED / MODELED / CUSTOMER ASSUMPTION exactly as the Bito code did. Never present a modeled figure as the prospect's known spend.
- **Onboarding friction** → **migration / adoption friction**: MySQL-wire compatibility, ingest via Pipelines, existing ORMs and BI tools, data-volume moves, team skills.
- **Motions:** keep PLG / Top-Down / Champion-Led / Land-and-Expand. PLG = free shared tier / $500 starter credits → one workload. Land = one real-time workload or one consolidated pipeline, then expand.
- **Competitors:** Snowflake, Databricks, ClickHouse, Postgres/Aurora, MySQL, Elasticsearch/OpenSearch, Pinecone/dedicated vector DBs, Redis, MongoDB, Rockset-class, Pinot/Druid. Follow the COMPETITIVE section of `lib/singlestore.ts`: be fair, and position SingleStore alongside existing tools where that's true.
- **Honesty rules (unchanged from Bito, keep them all):**
  - Every prospect fact must come from web_search evidence and be cited.
  - Proof points come only from PROOF in `lib/singlestore.ts`, each stated with what it measured.
  - A technology being present is not evidence of pain; frame pain as a hypothesis.
  - Never fabricate contact details.
  - Keep the "no A/B test / bake-off promise" style guardrails, adapted to how SingleStore evaluations actually run (POC section of `lib/singlestore.ts`).
- **Voice:** prompts written "in Max's voice" stay in Max's voice. Max is the user.

## Ownership (parallel agents: edit ONLY your files)
- **Agent A: Signals, directory, GitHub, contacts.**
  - Routes: `app/api/signals/**`, `app/api/directory/**`, `app/api/github-prospect/**`, `app/api/enrich/company-blurb`, `app/api/enrich/company-signal`, `app/api/people/search`.
  - Lib: `lib/data.ts` (SIGNAL_TYPES, bands; segments are set), `lib/icpClassifier.ts`, `lib/sources/*`, `lib/sweepEvents.ts`, `lib/githubIntent.ts`, `lib/githubProspect/{collect,enrich,types}.ts`, `lib/enrich/apollo.ts`, `lib/outreachRules.ts`.
  - Components: `SignalCard`, `SignalFeed`, `PullControls`, `DirectoryView`, `GitHubProspecting`, `TitleSearch`, `AccountPriority`, `FavoritesView`, `Sidebar`, `MetricCard`, `SegmentIcon`.
  - Also writes the SingleStore GitHub watchlist as `lib/githubProspect/watchlist.ts`.
- **Agent B: Intel briefs, proposals, CRM/outreach.**
  - Routes: `app/api/intel/**`, `app/api/proposal`, `app/p/[token]`, `app/api/hubspot/**`, `app/api/outreach/**`, `app/api/sequencer/**`, `app/api/enrich/route.ts`, `app/api/enrich/{apollo,hunter,github,crunchbase,proxycurl}/**`.
  - Lib: `lib/types.ts` (the intel-brief section: PainPoint, Competitor, CompanyIntel, TokenCostExposure, OnboardingFriction…), `lib/proposalGen.ts`, `lib/proposalDoc.ts`, `lib/hubspot.ts`, `lib/hubspotOAuth.ts`, `lib/sequencer/*`, `lib/enrich/{rollup,types,hunter,github,crunchbase,proxycurl,emailTrust}.ts`.
  - Components: `CompanyIntel`, `IntelExpander`, `EnrichmentPanel`, `HubSpotActions`, `SequenceActions`.
- **Agent C: Sales Assist.**
  - `app/api/assist/route.ts`, `components/SalesAssist.tsx`, `components/PipelineQuestions.tsx`, `lib/pocPdf.ts`, `lib/roiPdf.ts` (MEDDPICC scoring, the ROI calculator, the POC plan generator, objection handling, emails, persona tools).
- **Lead (not an agent):** `lib/s2/*`, `lib/store.ts`, `lib/auth.ts`, `lib/session.ts`, `lib/singlestore.ts`, `lib/clientStore.ts`, `app/api/{state,cache,auth,sync-events,company-aliases}`, `app/layout.tsx`, `app/page.tsx`, `app/login`, `app/connect`, `app/global-error.tsx`, `components/Header.tsx`, `middleware.ts`, `sql/`, `scripts/`, docs.

If you need a change in a file you don't own, don't make it. Put it in your final report.

## Done means
- No Bito / Governor / AI Architect / code-review / token-spend / SWE-seat framing left in your files, in user-visible strings, prompts or generated docs.
- Behaviour and UX are unchanged except for the retrofit.
- `npx tsc --noEmit -p .` shows no errors in your files (other agents' files may still be mid-edit; ignore those).
- Don't start the dev server, run DB writes or spend paid API credits. Prompts are verified by reading them.
