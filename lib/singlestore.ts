// Canonical SingleStore product context, shared by every API route's system prompt.
//
// This is the only place we put "SingleStore facts" so the model never invents
// product claims. Everything else (companies, signals, intel) is sourced live.
// Built 2026-10-14 from public sources only (singlestore.com, docs.singlestore.com,
// official case studies, press releases, GigaOm). Full source list and the
// "could not verify" list: research/singlestore-sources.md.
//
// FOCUS SPLIT: SingleStore sells ONE engine (Helios), so the split is by entry
// workload, not by SKU. "realtime" (default) leads with the core HTAP engine for
// real-time analytics / customer-facing apps / consolidation, which is where most
// published proof sits. "ai" leads with vector + full-text + AI functions for
// gen-AI / RAG / agent apps. Both share PROOF, COMPETITIVE, ICP, PRICING.

export type S2Focus = "realtime" | "ai";

const PORTFOLIO = `SingleStore sells one distributed SQL database engine, delivered three ways, plus platform services around it. Positioning (singlestore.com, Oct 2026): "The Real-Time AI Database for Enterprise."
- SINGLESTORE HELIOS: the fully managed cloud service on AWS, Azure and GCP. Editions: Shared (free), Standard, Enterprise (adds online PITR, Smart DR, audit logging, CMEK). Compute is now organised as "clusters" (third-generation, zero-copy architecture announced Jul 2026; earlier docs say "workspaces").
- HELIOS BYOC: Helios run in the customer's own cloud account (control plane run by SingleStore, data plane in the customer's VPC; documented on AWS). Pricing on request.
- SINGLESTORE SELF-MANAGED: the same engine on the customer's infrastructure (Standard / Enterprise licences; Free Edition and Dev Image for development). Current production release is 9.0; 9.1 is a release candidate.
- Platform services on Helios: SingleStore Kai (MongoDB-compatible API), SingleStore Flow (no-code migration + CDC; acquired via BryteFlow, Oct 2024), Pipelines (built-in streaming ingest), Notebooks + Scheduled Jobs, Cloud Functions and Python UDFs (on the Aura container service, preview pricing), AI & ML Functions (preview), SingleStore Analyst (natural-language analytics, Jun 2026), and Observability / Query Tuning agents (Sep 2026).
Do not use retired names (MemSQL, SingleStoreDB Cloud, "Managed Service") except when quoting an older case study.`;

const CORE_ENGINE = `CORE ENGINE — one distributed SQL database for transactions AND analytics (HTAP)
- Distributed, scale-out SQL: data is sharded across nodes; compute scales up or down online without dropping connections (Helios docs).
- HTAP in one engine: in-memory rowstore for high-concurrency transactional/point lookups and an on-disk columnstore for analytics on data larger than RAM; Universal Storage brings transactional features (hash indexes, row-level locking, upserts) to the columnstore so most workloads run on one table type. Rowstore and columnstore tables can be joined in one query.
- MySQL wire compatible: standard MySQL clients, drivers and BI tools connect unchanged; supports a broad subset (not all) of MySQL syntax. Customers cite "no query rewrite" migrations (Fathom, Factors.AI).
- Real-time ingest: Pipelines continuously load from Apache Kafka, Amazon S3, Azure Blob, GCS, HDFS and Apache Iceberg (CSV, JSON, Avro, Parquet); Amazon Kinesis added Aug 2026. SingleStore Flow migrates and CDC-replicates from MySQL, PostgreSQL, Oracle and SQL Server (Snowflake: one-time load only, no CDC).
- Multi-model: JSON (with multi-value JSON indexes), full-text and vector in the same SQL engine; MongoDB clients connect via Kai (MongoDB wire protocol, translated to SQL over JSON).
- Open data: bi-directional Apache Iceberg integration; Jul 2026 "zero-copy compute on Iceberg" with Smart Read Replicas, database branching and Smart DR attaching to the same data without copies.
- Operations: read replicas, branching, PITR, Smart DR (Enterprise), weekly feature rollouts on Helios. Compliance: SOC 2 Type II, ISO/IEC 27001, PCI DSS v4.0.1 for Helios Enterprise + BYOC (Aug 2026, assessed by ControlCase); supports HIPAA/GDPR/CCPA obligations.`;

const AI_VECTOR = `AI / VECTOR — the database layer for gen-AI, RAG and agent apps
- Native VECTOR(N) type (F32; F16 added in 9.1 at ~half the storage) with ANN indexes: IVF_FLAT, IVF_PQ, IVF_PQFS, HNSW_FLAT, HNSW_PQ (docs recommend IVF_PQFS and HNSW_FLAT); DOT_PRODUCT and EUCLIDEAN_DISTANCE metrics. Vector indexes live on columnstore tables.
- Full-text search VERSION 2: Lucene-compatible query syntax with BM25 scoring, on columnstore tables and JSON.
- The pitch: vector, full-text, SQL filters/joins and fresh transactional data in ONE query and one system, instead of a separate vector DB + search index + operational DB kept in sync. Docs describe filters applied after the indexed vector search; avoid claiming more than that about hybrid ranking.
- AI & ML Functions (Preview): SQL-callable AI_COMPLETE, AI_SENTIMENT, AI_SUMMARIZE, AI_CLASSIFY, AI_EXTRACT, AI_TRANSLATE, EMBED_TEXT, run as managed Python UDFs on the Aura container service.
- SingleStore Analyst: natural-language questions to SQL over governed "Domains" with a context engine (business rules, semantic layer, approved Q-and-SQL pairs); read-only per Domain.
- Developer surface: Notebooks (SQL + Python), Scheduled Jobs, Cloud Functions (lambda-style; data APIs, agent tools, inference APIs), Data API over HTTP, and an official SingleStore MCP Server that lets AI clients (Claude, Cursor, VS Code, etc.) manage Helios and run SQL.
- Published AI/vector customer outcomes: Thorn, DirectlyApply, Siemens, Fortune 25 bank (see PROOF). Treat "the database for agents" messaging as positioning, not a measured result.`;

const PROOF = `PROOF POINTS (published; cite as real, never inflate, and say what each MEASURES)
All customer figures are CUSTOMER CLAIMS published by SingleStore (vendor case studies), not independent audits. Most stories are undated on the page; several date from 2021-2022 under older product names.
- Armis (cybersecurity): data pipeline cost cut 70% vs a >$1M/yr pipeline built on a 160-node Elasticsearch cluster; queries that timed out on Elasticsearch now run in <10s, some <1.5s; 100B events/day (Armis case study PDF, (c)2022, singlestore.com/made-on/armis).
- Fathom Analytics (web analytics SaaS): replaced RDS MySQL + Redis (ElastiCache) + DynamoDB with Helios; -60% database TCO, 1,000x query performance, exports to S3 from hours to 30s, $3,000/month saved on DynamoDB alone (singlestore.com/customers/fathom).
- Factors.AI (B2B marketing analytics): replaced single-instance PostgreSQL; queries on 50M records from 2-5 min to 20s (~30x), customer campaign set-up ~32x faster (singlestore.com/customers/factors-ai).
- Siemens (Pulse analytics, on AWS): replaced SQL Server; 10-100x faster dashboards, <100ms queries over billions of rows, 500-100,000 concurrent users, 5 days from trial to selection (singlestore.com/made-on/siemens).
- Fortune 25 financial services firm (anonymised): 2+ PB managed, 40,000+ concurrent users, 10-20ms responses; 3x faster average query than SAP HANA in the customer's own head-to-head for a wealth-management portal (singlestore.com/made-on/fortune25bank).
- PYLER (brand safety / video AI): replaced Aurora PostgreSQL + Lambda batch ETL; >10x ingest, >100x lower analytical query latency, 10,000+ queries/min (singlestore.com/made-on/pyler). Its vectors still run on pgvector.
- DirectlyApply (jobs marketplace): replaced MongoDB + Elasticsearch; $100,000/yr saved, 6ms queries over billions of documents, "400x faster" search (headline only) (singlestore.com/made-on/directlyapply).
- Thorn (child-safety nonprofit): real-time vector insert + query replaced a custom image-matching pipeline; investigation time -53% in 2022 (singlestore.com/made-on/thorn). The database's share of that gain is not isolated.
- Kellogg: Hadoop ETL from 24h to 43 min (~30x); BI 20x faster per the case study (other SingleStore pages say 80x; use 20x) (singlestore.com/blog/kellogg-case-study, older story).
- 6sense: "500% faster" / "5x performance" by replacing multiple data engines (SingleStore webinar title and Oct 2025 press release; no baseline published).
SINGLESTORE-COMMISSIONED BENCHMARK (not a customer result): GigaOm Field Test, Jun 2022, commissioned by SingleStore: ~50% lower 3-yr TCO vs MySQL+Snowflake and ~60% vs PostgreSQL+Redshift stacks (incl. people/dev costs); up to 100% faster than Redshift on a TPC-H-like test; 10TB TPC-H-like S-48 slightly faster than Snowflake 3XL (gigaom.com/report/transactional-and-analytical-workloads). SingleStore's own TPC-H/DS/C runs are "derived, uncertified"; there are NO official TPC-audited results.
MARKETING CLAIM: "10-100x performance at 1/3 the cost of legacy architectures" (SingleStore press-release boilerplate, 2025; no published methodology). Never present it as a measured or customer result.
Keep MEASURED (customer claim), COMMISSIONED BENCHMARK, MARKETING CLAIM and MODELED (ROI calculator) numbers visibly distinct.`;

const COMPETITIVE = `COMPETITIVE (be fair; name where the competitor is genuinely strong)
- The SingleStore narrative is consolidation: one engine for the "serving layer" that teams otherwise assemble from a transactional DB + real-time analytics store + cache + search index + vector DB (SingleStore blog, Jul 2026). The warehouse/lakehouse usually STAYS for history and training; SingleStore sits beside it (Snowflake partnership Sep 2024; Iceberg zero-copy Jul 2026). Recommend incremental migration of the most painful workload, not a big-bang replacement.
- Snowflake / Databricks: strong for large-scale batch analytics, data engineering, ML and governance ecosystems. SingleStore's angle is millisecond, high-concurrency, customer-facing queries on fresh data plus transactions, which warehouses are not built to serve. Position as complement first.
- ClickHouse (and Druid/Pinot): very strong, cost-efficient columnar OLAP for append-heavy analytics. SingleStore's angle is mutable data (updates/upserts), transactions, joins and a MySQL-compatible app database in the same engine.
- Postgres / Aurora / MySQL: the default operational databases with the biggest ecosystems; Aurora/MySQL are the usual starting point. SingleStore's angle: scale-out beyond a single writer node and fast analytics on the same data; MySQL wire compatibility lowers migration effort (Factors.AI, Fathom, PYLER).
- Elasticsearch / OpenSearch: strong, mature full-text and log search. SingleStore's angle: SQL joins/aggregations and mutable data without reindexing (Armis), plus Lucene-style full-text v2 in the same DB.
- Pinecone / dedicated vector DBs: purpose-built vector tooling. SingleStore's angle: vectors next to the operational and analytical data with SQL filters and joins, no sync pipeline.
- Redis: in-memory cache and sub-ms KV access, hard to beat for pure caching. SingleStore's angle: rowstore point lookups good enough to retire a cache layer in some stacks (Fathom).
- MongoDB: flexible document model and developer mindshare. SingleStore's angle: Kai lets MongoDB clients connect while gaining SQL analytics on the same JSON.
- Caveat: SingleStore is smaller than these vendors (FY26 Q2 ARR >$123M, Sep 2025; now owned by Vector Capital after a 2025 growth buyout). Ecosystem breadth and hiring pool favour Postgres/MySQL/Snowflake/Databricks.`;

const ICP = `Who SingleStore sells to (ICP)
- Companies running data-intensive, customer-facing or latency-sensitive applications: SaaS analytics products, adtech/martech, cybersecurity, fintech/trading and wealth, IoT/industrial, media; plus enterprises (Fortune 500 banks, manufacturers) building real-time dashboards for thousands of users.
- Signals: a stack of several databases kept in sync for one product (OLTP + cache + search + OLAP + vector); Postgres/MySQL/Aurora hitting single-node limits; Elasticsearch or a warehouse being used to serve app queries; dashboards that lag ingest by minutes/hours; high concurrency (thousands+ users); gen-AI features that need fresh operational data plus vectors.
- Common entry workloads: customer-facing analytics/dashboards, real-time event and clickstream analytics, fraud/risk and security analytics, adtech bidding and attribution, identity resolution, RAG/vector search and agent backends, operational reporting offloaded from a warehouse.

Common buyers and champions
- Champions: head of data platform / data engineering, principal or staff engineers and architects owning the serving layer, platform/SRE leads tired of operating several stores, and app/product engineering leads whose product is slow.
- Economic buyers: CTO / VP Engineering / CDO / CIO; the business case is product performance, consolidation (fewer systems and licences) and lower infra cost.
- Gen-AI leads and AI platform teams for vector/RAG/agent entry points.

Buying motions to consider per account
- PLG: developer starts on the free Shared tier or with $500 of Standard credits, connects with any MySQL driver or Notebooks, loads data via Pipelines/Flow, then upgrades.
- Workload-led land: prove one painful workload (a slow dashboard, an Elasticsearch or Postgres scaling wall) and expand to adjacent workloads and consolidation.
- Top-down: CTO/CDO pitch on consolidating N systems into one and TCO.
- Partner/cloud: AWS Marketplace billing (Jan 2026); SI partners such as Twingo ran the Armis POC.`;

const PRICING = `PRICING ANCHORS (public list prices only; verify before quoting)
- Helios on-demand credit: $3.96 per credit (singlestore.com/cloud-pricing, accessed 2026-10-14). Standard edition = 1x credits, Enterprise = 1.5x (same page).
- Compute sizes, AWS us-east-1, Standard: S-00 (2 vCPU/16GB) 0.25 CR/h = $0.99/h; S-1 (8 vCPU/64GB) 1 CR/h = $3.96/h; S-4 (32 vCPU/256GB) $15.84/h; S-20 (160 vCPU/1.28TB) $79.20/h (cloud-pricing). Enterprise starts at $1.49/h (singlestore.com/pricing).
- Multipliers: region tiers 1.0x/1.125x/1.25x/1.375x; Multi-AZ 1.3x (cloud-pricing). SLA 99.9% single-AZ, 99.99% multi-AZ (pricing).
- Storage: from $0.023 per average GB-month (Tier 1; $0.025/$0.026/$0.040 for Tiers 2-4), billed separately from compute (docs Flexible Usage Model; cloud-pricing).
- Container services (Notebooks, Jobs, Cloud Functions, Python UDFs), preview pricing: 0.084 CR/h small, 0.168 medium, 0.731 GPU (cloud-pricing).
- Commercial terms: on-demand at list with no commitment, or a 1-year committed monthly credit volume at discounted (unpublished) rates with monthly rollover of unused credits (docs Flexible Usage Model).
- Free: Shared edition, 1 database, 1 GB compressed data (~4 GB raw at the docs' ~75% compression), 10 tables, AWS us-east-1 only, not for production or benchmarking (docs Shared Edition). $500 of free credits to start on Standard (singlestore.com/pricing; expiry terms not published).
- NOT PUBLIC: BYOC pricing, self-managed licence pricing, committed-use discount rates, Enterprise support pricing.
- Published TCO/consolidation claims (for the ROI calculator, label as claims): GigaOm 2022 commissioned study, ~50-60% lower 3-yr TCO vs two-database stacks; Fathom -60% DB TCO; Armis -70% pipeline cost; DirectlyApply $100K/yr saved; SingleStore Elasticsearch page "up to 50% reduction in TCO" (no method). Model customer savings as assumptions, never as the customer's known spend.`;

const POC = `EVALUATION / POC NORMS (from official sources)
- Start: sign up to the Helios Cloud Portal; the free Shared cluster is for evaluation and development only and SingleStore says it is NOT for benchmarking. Real performance tests run on a Standard/Enterprise cluster using the $500 starter credits or a sales-led trial.
- Size: start small (S-00/S-1) and scale online; docs point to the Helios sizing guidelines (estimated storage) and require enough credits for the target size.
- Load: MySQL-compatible connection (any MySQL driver, BI tool, SQL editor, Notebooks), Pipelines from Kafka/S3/Iceberg, Flow for migration + CDC from MySQL/Postgres/Oracle/SQL Server.
- Shape: prove one painful workload against agreed SLAs (latency at concurrency, ingest-to-query freshness, cost). Published examples: Armis defined query SLAs of 1.5s/3s/10s over 3/7/30+ days of data and ran the POC with partner Twingo; Siemens went from trial deployment to selection in 5 days; the Fortune 25 bank ran a head-to-head against SAP HANA.
- Do not promise specific speedups before the customer's own test; quote published figures as other customers' results.`;

/** Product context with the requested focus leading. "realtime" is the default
 *  for prospecting; "ai" leads with vector/AI for gen-AI-scoped work. */
export function singlestoreContextFor(focus: S2Focus = "realtime"): string {
  const lead = focus === "ai" ? [AI_VECTOR, CORE_ENGINE] : [CORE_ENGINE, AI_VECTOR];
  return [PORTFOLIO, ...lead, PROOF, COMPETITIVE, ICP, PRICING, POC].join("\n\n");
}

export const SINGLESTORE_CONTEXT = singlestoreContextFor("realtime");

export { PORTFOLIO, CORE_ENGINE, AI_VECTOR, PROOF, COMPETITIVE, ICP, PRICING, POC };
