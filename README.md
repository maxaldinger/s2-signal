# S2 Signal

Live sales intelligence for **SingleStore**, with **SingleStore as the system of record**. It's a feature-for-feature retrofit of the Signal dashboard originally built for Bito. Same tabs, same pulls, same briefs and the same Sales Assist tools, re-aimed at companies with data-intensive, real-time and AI workloads, and running on a SingleStore database instead of Supabase.

Every signal and every intel brief is generated **live** by Claude with the `web_search` tool, cited, and cached in SingleStore. Product claims come only from `lib/singlestore.ts`, which is built from public SingleStore sources (`research/singlestore-sources.md`).

## Tabs

| Tab | What it does |
| --- | --- |
| **Signal Feed** | Pulls buying signals in parallel across eight buckets:<br>• data-platform hiring<br>• layoffs / cost consolidation<br>• OSS activity on databases, streaming and vector projects<br>• GitHub intent<br>• M&A creating data-estate consolidation<br>• funding for data/AI build-out<br>• gen-AI / RAG launches<br>• the Apollo ICP sweep on firmographics plus technographics (Kafka, Snowflake, Databricks, Elasticsearch, ClickHouse, Postgres/MySQL, Redis, vector DBs)<br><br>Each signal carries a 0-99 SingleStore ICP fit. Results are paged, filtered by segment, type and engineering-size band, and cached in `gtm_signals`. |
| **Signal 2000** | The ~2,000 largest US companies (public list), remapped to SingleStore segments with a data-intensity fit prior (`lib/directoryFit.ts`). Short brief on view, full intel on demand. |
| **Intel Brief** | Any account or company. Covers:<br>• ICP breakdown: data scale, architecture complexity (stitched systems), real-time workload, scaling activity, AI workload, plus a streaming bonus<br>• stakeholder map for the data-platform buying group<br>• evidence-grounded pain hypotheses with the SingleStore answer<br>• competitive context<br>• motion<br>• data-estate cost and consolidation exposure<br>• migration friction<br>• LinkedIn and email outreach<br>• live contacts<br>• citations |
| **Proposal** | One click turns a brief into a prospect-facing proposal page at `/p/<token>`, stored in `gtm_proposals`. Operational and cost views, with consolidation economics from public list pricing. Every figure is labelled MEASURED, MODELED or CUSTOMER ASSUMPTION. |
| **GitHub Prospecting** | Polls a watchlist of 25 repos SingleStore buyers touch (SingleStore's own, plus streaming, vector, OLTP/OLAP, AI frameworks and pipeline tools). Resolves people to companies, scores them by contribution weight and writes openers. |
| **Title Search** | Finds contacts by persona: data platform, data engineering, database, real-time analytics, ML platform, CDO. Classified qualified / router / unresolved. |
| **Favorites** | Starred accounts, synced per user in `gtm_user_state`. |
| **Sales Assist** | Chat assistant grounded in web search, plus:<br>• cold emails and objection handling<br>• **MEDDPICC** scoring<br>• **POC plan** generator, with a PDF technical-evaluation plan<br>• **ROI calculator**: consolidation/TCO model on public pricing, with a PDF<br>• LOU<br>• multithreading |
| **Pipeline Questions** | Call scripts with deep links into MEDDPICC and the POC plan. |

## How it uses SingleStore

- **The whole data layer.** 29 tables in database `gtm_dashboard` (`sql/schema.sql`):
  - Signals, briefs (JSON documents), the directory, GitHub activity and contacts are **sharded columnstore** tables. The feed and directory are analytical reads over thousands of rows.
  - Users, sequences, prospects, enrollments and OAuth connections are **rowstore reference tables**: replicated, transactional, and carrying several unique keys.
- **MySQL wire protocol** via `mysql2`. No Postgres driver, no PostgREST. `lib/s2/client.ts` implements the supabase-js query-builder subset the original app used and compiles it to parameterised SQL. `lib/store.ts` and `lib/githubProspect/store.ts` are hand-written SQL.
- **JSON in SQL.** Brief fields are extracted server-side, e.g. `intel::$domain` and `intel::%sweEstimate` for GitHub target matching.
- **Row-level security, re-implemented.** Per-user tables are scoped to the session user in the client layer. `npm run db:check` verifies that another user sees nothing.
- **Auth.** Users and scrypt hashes live in `gtm_users`, with HMAC-signed session cookies (`lib/session.ts`, Edge-safe). The gate is off until `AUTH_SECRET` is set.

## Setup

```bash
npm install
cp .env.example .env.local      # SINGLESTORE_* and ANTHROPIC_API_KEY are required
npm run db:schema               # create the 29 tables
npm run db:seed-directory       # load the Signal 2000 directory
npm run db:check                # connection, row counts, write/read + per-user scoping
npm run dev                     # http://localhost:3000, then "Pull Signals"
```

Optional keys unlock more features. Each missing key degrades to an honest "not configured":
- `APOLLO_API_KEY`: ICP sweep, contact population, firmographics
- `HUNTER_API_KEY`
- `GITHUB_TOKEN`: watchlist rate limits
- `CRUNCHBASE_API_KEY`
- `HUBSPOT_TOKEN`

### Things that bite

- **Auto-suspend.** The cluster suspends after 20 idle minutes, and a suspended cluster's hostname does not resolve (`ENOTFOUND`). Resume it in portal.singlestore.com → Clusters. Startup takes about 5 minutes.
- **`$` in env values.** Next.js expands `$NAME`, so write `\$`. The scripts load env with Next's own loader, so they match the app.
- **Org-level Anthropic keys** need `ANTHROPIC_WORKSPACE_ID`.

## Honesty rules (carried over from the original)

- Prospect facts come only from web_search evidence, with citations.
- Product proof comes only from `lib/singlestore.ts`, each item stated with what it measured. Commissioned benchmarks and marketing claims are labelled as such.
- A technology being present is not evidence of pain. Pain is a hypothesis.
- MEASURED, MODELED and CUSTOMER ASSUMPTION figures stay visibly distinct.
- Contact details are never fabricated.
