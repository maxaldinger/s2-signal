# S2 Signal: five-minute demo for SingleStore Solutions Engineering

**The story:** "This is the prospecting system I built and run in my current role, rebuilt in two days to sell SingleStore, running on SingleStore. It finds accounts where the consolidation and real-time argument actually applies, proves it from public evidence, and turns it into a brief, a proposal and a POC plan, without inventing a single number."

## Preflight (15 minutes before)

1. **Resume the cluster.** Go to portal.singlestore.com → Clusters → singlestore-gtm-mvp → **Resume**, and wait for "Starting cluster…" to finish (about 5 minutes). A suspended cluster has no hostname, so the app can't connect. Consider raising auto-suspend to a few hours (⋮ → Settings) so it can't suspend mid-demo.
2. Run `npm run db:check`. It must print `connected SingleStore 10.6.0` and `per-user scoping ok`.
3. Run `npm run dev` and open http://localhost:3000. The Signal Feed should show the cached signals.
4. Open the **Coinbase** card → View Full Brief (it's cached, so it loads instantly). The sections are already expanded. Keep the proposal link ready: open the brief → Personalize proposal (cached, so it returns the existing link).
5. Have the cached proposal open in a second tab.

Everything in the demo path is cached in SingleStore. Live calls (Pull More, a new Get Intel) are optional extras, at about 1 minute and about 40 seconds respectively.

---

### 0:00–0:40 · Why I built it this way
- "Prospecting tools rank by firmographics. SingleStore wins on architecture: a company running OLTP plus a warehouse plus search plus streaming plus a vector store, stitched together with pipelines. So the ICP score is built on that."
- Show the **ICP breakdown** on any card or brief:
  - **data scale**
  - **architecture complexity** (how many stitched systems)
  - **real-time workload**
  - **scaling activity**
  - **AI workload**
  - a **streaming bonus** for Kafka/CDC evidence
- "Two rules run through every prompt: facts come from cited sources, and a technology being present is a hypothesis, not pain."

### 0:40–1:40 · Signal Feed (live buying signals)
- Show the eight buckets in the sidebar: data-platform hiring, cost/consolidation, OSS on databases/streaming/vector, GitHub intent, M&A, funding, gen-AI launches, and the Apollo technographic sweep.
- Point at real cards:
  - **Coinbase:** 14% cut, AI-efficiency focus, real-time trading.
  - **Uber** and **Cloudflare.**
  
  Each has a source, a date, a SingleStore ICP fit and a "~N eng" chip.
- Filter by segment (Fintech & FS) and engineering-size band. Mention: "Competing database vendors are filtered out of the feed automatically."
- *(Optional, about 1 minute)* **Pull More Signals.** Six scans run in parallel, and every result is upserted into `gtm_signals`.

### 1:40–3:10 · Intel brief → proposal (Coinbase)
- **Score 86.** Read the call hook: "Coinbase built its own Kafka-based CDC framework (SOON) because separate replication pipelines for Postgres, Mongo, Dynamo and MySQL became too hard to maintain."
- Open **Likely pain points**. Each is stated as a hypothesis with evidence, e.g. "Snowflake duplicated into Delta Lake just to hit latency SLOs".
- Open **Motion & watch-outs**: "It tells me *not* to fight StarRocks on blockchain analytics. They just picked it after a bake-off. Knowing where not to push is part of the method."
- **Data-estate cost:** a modeled $612K/mo across 6 *evidenced* systems. Every anchor is labelled MODELED, and the warehouse is explicitly out of scope.
- Show the **people**: the VP of Data named from a public source, plus a LinkedIn connect note in my voice under 300 characters, with no pitch and no invented figure.
- Click **Personalize proposal** and switch to the proposal tab:
  - The operational narrative is grounded in their own blog posts.
  - Proof points (Armis, Fathom, Siemens) are each stated with what was measured, plus a "vendor case studies, not audits" note.
  - The economics table separates CUSTOMER ASSUMPTION / MODELED / LIST PRICE.
  - A three-step rollout ends in "prove it against agreed SLAs".

### 3:10–4:10 · Sales Assist
- Click the **"We already have Snowflake"** objection chip. The answer is fair: the warehouse stays, and SingleStore takes the serving layer.
- **ROI calculator:** $500K in scope, 40% retired, S-4 at public list price ($15.84/h), giving $139,310/yr SingleStore cost and $60,690 net. Flip to Advanced to show per-system retirement, pipeline FTEs and payback. Every input is labelled as an assumption.
- **MEDDPICC** and **POC plan:** the POC is a SingleStore technical evaluation with one workload, three success criteria, Pipelines from Kafka, an S-00/S-1 environment against the $500 credits, and go/no-go exit criteria.

### 4:10–5:00 · It runs on SingleStore
- **GitHub Prospecting:** 1,154 activity events from the watchlist (Debezium, Kafka, ClickHouse, pgvector, langchain-singlestore…), rolled up into account intent.
- **Similar accounts (vector search):** at the bottom of the Coinbase brief, click **Find look-alikes** → Ramp, Cloudflare, Instacart. Then search a theme: *"teams replicating several operational databases through Kafka CDC"* → Coinbase ranks first. Toggle **show the SQL**: one statement, an ANN search on the HNSW index (`embedding <*> query_vector`) with segment / ICP filters in the same WHERE clause, about 200–400 ms.
- The architecture, in one breath:
  - **29 tables** in `gtm_dashboard`. High-volume feeds (signals, directory, briefs as JSON, GitHub events) are **sharded columnstore**. Small transactional tables (users, sequences, OAuth) are **rowstore reference tables** that carry several unique keys.
  - I replaced Supabase/Postgres with a **supabase-compatible query layer over the MySQL protocol**, so all 38 API routes moved without a rewrite.
  - **Row-level security is re-implemented** per user.
  - **JSON is queried in SQL** (`intel::$name`), which is how a brief is matched to its account.
- Close: "A short list of accounts, each with a testable hypothesis, the right people, the five discovery questions and a POC plan, on the product I'd be selling."

---

## Likely questions
- **"Is the cost number real?"** No, and the app says so. It's MODELED from evidenced systems and public list prices. The rep replaces it with the customer's bill (the spend chip is editable, and confirmed values flow into the proposal).
- **"What if the AI makes things up?"**
  - Every prospect fact needs a web_search citation.
  - Product claims come only from one sourced file (`lib/singlestore.ts`, with sources in `research/singlestore-sources.md`). Commissioned benchmarks and marketing claims are labelled.
  - Live research drops any source the model didn't actually retrieve.
- **"Why columnstore for a CRM-like app?"** The feed and directory are scans and aggregations over thousands of rows, and briefs are JSON documents queried server-side. The OLTP-shaped tables sit in rowstore reference tables. Same database, both shapes.
- **"What would you build next?"**
  - Chunk-level retrieval (one vector per pain point / signal instead of per account) and hybrid full-text + vector ranking.
  - Pipelines ingesting job-posting feeds continuously instead of pull-based scans.

## Not live without extra keys
`APOLLO_API_KEY`, `HUNTER_API_KEY` and `HUBSPOT_TOKEN` power the technographic sweep, contact population and CRM sync. Without them those panels say "not configured", which is honest but quiet. `GITHUB_TOKEN` lifts the GitHub watchlist from the anonymous 60 requests/hour to full coverage.
