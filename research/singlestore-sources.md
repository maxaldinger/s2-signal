# SingleStore context: sources

All accessed 2026-10-14. These sources back `research/singlestore-context.ts`. Customer figures come from SingleStore-published case studies, so they are vendor-published customer claims and not independent audits.

## Product, portfolio, positioning

| URL | Supports |
|---|---|
| https://www.singlestore.com/ | Current tagline: "The Real-Time AI Database for Enterprise." |
| https://www.singlestore.com/pricing/ | Editions (Shared free, Standard from $0.99/h, Enterprise from $1.49/h with PITR, Smart DR, audit logging, CMEK), BYOC "contact us", self-managed on AWS/Azure/GCP, SLAs of 99.9% and 99.99%, $500 free credits |
| https://www.singlestore.com/cloud-pricing | Credit price $3.96, S-00 to S-20 size table, Standard 1x and Enterprise 1.5x, region and Multi-AZ multipliers, storage tiers, container-service (preview) pricing |
| https://docs.singlestore.com/cloud/user-and-workspace-administration/billing-and-usage/flexible-usage-model/ | Storage from $0.023 per avg GB-month; on-demand versus 1-year commit; rollover of unused credits |
| https://docs.singlestore.com/cloud/getting-started-with-singlestore-helios/about-singlestore-helios/singlestore-helios-editions/shared-edition.md | Free Shared limits: 1 GB compressed, 1 DB, 10 tables, us-east-1 only, not for production or benchmarking, no PrivateLink/SSO/CMEK/audit logs/backups/CDC-in |
| https://docs.singlestore.com/cloud/getting-started-with-singlestore-helios.md | "Clusters" terminology, Kai endpoint, Notebooks, Data API, SQrL |
| https://docs.singlestore.com/cloud/release-notes/ | 2026 features: AWS Marketplace billing (Jan), Smart DR, Custom RBAC, Projects (Feb), Smart Read Replicas (Mar), Online AZ migration (Apr), Analyst, Continuous Backup, I/O Optimized Clusters (Jun), Kinesis pipelines, mTLS, UPDATE/DELETE RETURNING (Aug). Flow on Helios and Aura Container Apps RBAC marked Preview (Oct 2025) |
| https://docs.singlestore.com/db/v9.1/release-notes/singlestore-memsql/9-1-release-notes/ | 9.1 is a release candidate and 9.0 is recommended for production. Adds F16 vectors, Kinesis, mTLS, RETURNING |
| https://docs.singlestore.com/db/v9.1/user-and-cluster-administration/maintain-your-cluster/setting-or-replacing-a-license.md | Self-managed Standard and Enterprise licences; Free Edition and Dev Image for development |
| https://www.singlestore.com/blog/singlestore-byoc-on-aws/ (2025-04-16) | BYOC: data plane in the customer's AWS VPC, SingleStore control plane |
| https://www.singlestore.com/blog/cloud-database-pci-dss-compliance/ (2026-08-03) | PCI DSS v4.0.1 for Helios Enterprise and BYOC (ControlCase); SOC 2 Type II; ISO 27001; HIPAA/GDPR/CCPA support |
| https://www.singlestore.com/blog/open-intelligence-open-data-singlestore-delivers-zero-copy-compute-on-apache-iceberg/ (2026-07-02) | Third-generation clusters, zero-copy on Iceberg, Smart Read Replicas, branching, Smart DR. Gives no GA/preview status |
| https://www.singlestore.com/blog/introducing-singlestore-analyst-question-to-insight-while-it-still-matters/ (2026-09-09) | SingleStore Analyst: Domains, context engine, read-only user, dashboards |
| https://www.singlestore.com/blog/introducing-observability-agent-gets-you-from-symptom-to-cause-in-minutes/ (2026-09-28) | Observability Agent: read-only diagnosis that runs under RBAC |
| https://www.singlestore.com/blog/ (listing) | Query Tuning Agent (2026-09-30); Edward Hsu named CPO (2026-08-03); dates of other 2026 posts |
| https://www.singlestore.com/media-hub/releases | Press-release list. The newest is 2025-10-22, and no 2026 press releases are listed |
| https://www.singlestore.com/media-hub/releases/singlestore-drops-three-major-upgrades-to-power-the-next-decade-of-ai-applications/ (2025-10-01) | Aura Analyst, AI/ML Functions, Zero Copy Attach; 6sense "500% faster"; ARR >$123M; boilerplate "10-100x at 1/3 the cost" |
| https://www.singlestore.com/media-hub/releases/singlestore-drops-an-enterprise-ai-glow-up-built-for-real-time-serverless-functions-and-ultimate-dev-flow/ (2025-06-17) | Flow in Helios, Iceberg speed layer, Cloud Functions on Aura Container Service, multi-value JSON index, branching/PITR/SmartDR on GCP |
| https://www.businesswire.com/news/home/20250910713755/en/SingleStore-Announces-Growth-Buyout-Led-by-Vector-Capital (2025-09-10) | Vector Capital growth buyout |
| https://www.singlestore.com/media-hub/releases/singlestore-delivers-record-performance-in-the-second-quarter-of-fiscal-year-2026/ (2025-09-04) | FY26 Q2 ARR >$123M |

## Core engine, ingest, AI/vector

| URL | Supports |
|---|---|
| https://docs.singlestore.com/cloud/vectors/vector-indexing/ | VECTOR(N, F32); index types IVF_FLAT, IVF_PQ, IVF_PQFS, HNSW_FLAT, HNSW_PQ; DOT_PRODUCT and EUCLIDEAN_DISTANCE; columnstore only; filters applied after the indexed search |
| https://docs.singlestore.com/cloud/developer-resources/functional-extensions/working-with-full-text-search | Full-text VERSION 2: Lucene-compatible, BM25, columnstore only, JSON |
| https://docs.singlestore.com/cloud/load-data/load-data-with-pipelines | Pipeline sources: Kafka, S3, Azure Blob, GCS, HDFS, filesystem; formats CSV/JSON/Avro/Parquet; Iceberg ingest |
| https://docs.singlestore.com/cloud/load-data/load-data-with-singlestore-flow-on-helios/use-flow-on-helios/ and https://www.singlestore.com/blog/using-singlestore-flow/ | Flow sources (MySQL, PostgreSQL, Oracle, SQL Server, Snowflake); Snowflake is one-time load only |
| https://docs.singlestore.com/cloud/reference/singlestore-kai/ | Kai MongoDB-compatible endpoint and supported commands |
| https://docs.singlestore.com/cloud/ai/ai-ml-functions/ | AI & ML Functions (Preview), run as managed Python UDFs on Aura; AI_COMPLETE, AI_SENTIMENT and others |
| https://docs.singlestore.com/cloud/ai/singlestore-mcp-server/ | Official SingleStore MCP Server |
| https://docs.singlestore.com/cloud/getting-started-with-singlestore-helios/about-singlestore-helios/singlestore-helios-faqs/general/ and https://docs.singlestore.com/cloud/connect-to-your-workspace/connect-with-mysql/ | MySQL wire compatibility (broad subset of syntax); rowstore versus columnstore; Universal Storage |
| https://docs.singlestore.com/cloud/getting-started-with-singlestore-helios/about-workspaces/workspace-scaling/ | Online scaling with no dropped connections |
| https://www.singlestore.com/blog/adtech-serving-layer-sprawl/ (2026-07-09) | Consolidation narrative: the warehouse stays, one serving layer replaces KV store, real-time OLAP, cache, search and vector DB; incremental migration |

## Proof

| URL | Supports |
|---|---|
| https://www.singlestore.com/assets-public/customers/armis_casestudy_impactreport.pdf (©2022) and https://singlestore.com/made-on/armis | Armis: 70% pipeline cost cut against more than $1M/yr; Elasticsearch timeouts down to under 10s and under 1.5s; 100B events/day; Twingo POC; SLAs |
| https://www.singlestore.com/customers/fathom/ | Fathom: -60% DB TCO, 1,000x query performance, up to 12,000x processing, exports in 30s, $3K/month saved on DynamoDB; replaced MySQL, Redis and DynamoDB |
| https://www.singlestore.com/customers/factors-ai/ | Factors.AI: 2-5 min to 20s on 50M records; ~32x faster campaign setup; replaced PostgreSQL |
| https://www.singlestore.com/made-on/siemens/ | Siemens: 10-100x dashboards, under 100ms, 500-100K users, 5 days from trial to selection; replaced SQL Server |
| https://www.singlestore.com/made-on/fortune25bank/ | Fortune 25 bank: 2+ PB, 40K+ users, 10-20ms, 3x faster than SAP HANA in the customer's own test |
| https://www.singlestore.com/made-on/pyler/ | PYLER: >10x ingest, >100x lower query latency; replaced Aurora PG and Lambda |
| https://www.singlestore.com/made-on/directlyapply/ | DirectlyApply: $100K/yr saved, 6ms, "400x" in the headline only; replaced MongoDB and Elasticsearch |
| https://www.singlestore.com/made-on/thorn/ | Thorn: -53% investigation time (2022), 27,000+ victims identified |
| https://www.singlestore.com/blog/kellogg-case-study/ | Kellogg: 24h ETL to 43 min; 20x BI |
| https://singlestore.com/resources/webinar-how-6sense-drove-500-faster-customer-engagement-with-singlestore | 6sense "500% faster" / "5x" |
| https://gigaom.com/report/transactional-and-analytical-workloads/ (2022-06-14, commissioned by SingleStore) | TCO 50% and 60% lower; TPC-H-like up to 100% faster than Redshift; slightly faster than Snowflake 3XL |
| https://www.singlestore.com/blog/singlestoredb-outshines-database-competitors-tco-study/ (2022-06-15) | SingleStore summary of the GigaOm TCO study |
| https://www.singlestore.com/blog/tpc-benchmarking-results/ | SingleStore's own TPC-derived, uncertified runs |
| https://www.singlestore.com/elasticsearch/ | Vs Elasticsearch page: Adobe 1.8s, Heylink 200x, "up to 50% TCO reduction" (no method given) |
| https://www.singlestore.com/customers/ | Current featured stories: PYLER, Siemens, DirectlyApply, Fortune 25 bank |

## Could not verify (dropped or hedged)

- **Hulu and Uber:** These names appear only in passing in old SingleStore whitepapers and blog posts (2016-2017). No current, citable outcome story exists, so they were dropped.
- **Comcast:** An old story says SingleStore "met a 300,000 events/sec SLA". It had no outcome metric and is not current, so it was dropped.
- **IEX:** No SingleStore case study was found, so it was dropped.
- **Kellogg 80x:** This figure appears on marketing pages, but the case study itself says 20x. The context uses 20x.
- **6sense:** The headline says "500% faster" and the body says "5x". No baseline is given, so the context labels it as having no baseline.
- **Aura branding:** "Aura" now survives only as the container service ("Aura Container Service/Apps"). "Aura Analyst" (Oct 2025) appears as "SingleStore Analyst" in the 2026 docs and blog. I did not find an explicit rename notice, so the context uses "SingleStore Analyst".
- **GA/preview status:** I could not confirm GA versus preview for BYOC (the 2025 docs said Preview; PCI scope in Aug 2026 implies production use), the third-generation clusters and Iceberg zero-copy, Observability/Query Tuning agents, and Analyst. AI & ML Functions and container-service pricing are explicitly Preview. Flow on Helios was Preview as of Oct 2025.
- **Gartner MQ 2025 placement:** SingleStore is listed as covered in the Nov 2025 Cloud DBMS MQ, but its quadrant position is paywalled. It is not used.
- **Official TPC-audited results:** None exist. Only uncertified "derived" runs and the commissioned GigaOm test are available.
- **Free-credit terms:** $500 is published, but expiry and eligibility are not. The number of free Shared workspaces per org is inconsistent across docs (older: 1; newer: "Unlimited").
- **Self-managed pricing, BYOC pricing, committed-use discounts and support pricing:** None are public.
- **"10-100x at 1/3 the cost":** This is press-release boilerplate with no published methodology, so it is flagged as a marketing claim only.
- **Universal Storage:** No dedicated current reference page was retrieved. The description is based on the Helios FAQ and SingleStore's technical overview, and it was kept high-level.
- **Geospatial and time-series:** These were not re-verified in the current docs and were removed from the context.
- **Competitor strengths in COMPETITIVE:** These are general, widely accepted market characterisations written for fairness. They are not sourced claims, and the context does not attach numbers to them.
