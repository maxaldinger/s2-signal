// The GitHub prospecting watchlist: open-source repos that SingleStore buyers
// and champions touch. Engineers who star, fork, commit to or open PRs on these
// repos are telling us what their data stack looks like, or is about to.
//
// This file is the source of truth. The sync route seeds any entry missing from
// gtm_monitored_repos (INSERT IGNORE, so existing poll cursors and the `active`
// flag survive), so editing this list and running a sync is all a change takes.
// Every repo was verified to exist via GET https://api.github.com/repos/OWNER/NAME
// on 2026-10-14 (dbt-core now lives at dbt-labs/dbt; the canonical name is used).
//
// CATEGORIES → INTENT (strongest first; CATEGORY_WEIGHT drives the GitHub
// signal score in lib/githubIntent.ts):
//   singlestore      SingleStore's own SDKs, MCP server, dev image, connectors and
//                    LangChain integration. Direct product interest: someone is
//                    already building against SingleStore.
//   competitor-oltp  Scale-out MySQL/Postgres-compatible databases (Vitess, TiDB,
//                    CockroachDB). A team outgrowing a single-writer OLTP database
//                    and evaluating distributed SQL: SingleStore's core entry.
//   streaming        Kafka, Flink, Redpanda, Debezium. Fresh events fanned out to
//                    several stores: where Pipelines ingest and consolidation apply.
//   vector           pgvector, Milvus, Qdrant. Vectors being added next to (or
//                    beside) the operational database: the "ai" focus entry.
//   competitor-olap  ClickHouse, Pinot, Druid, Trino, DuckDB. A real-time or
//                    interactive analytics layer being built or run; SingleStore's
//                    angle is mutable data, joins and transactions in the same engine.
//   ai-framework     LangChain, LlamaIndex. Someone is building RAG or agents; a
//                    weaker signal on its own (most users never pick the database).
//   pipeline         Airbyte, dbt, Iceberg. Data movement and the lakehouse; shows a
//                    data team at work, the weakest buying intent on this list.
// A repo being touched is NOT evidence of pain. It tells us what someone works
// on, which is what the opener may reference and nothing more.

export type WatchlistCategory =
  | "singlestore"
  | "competitor-oltp"
  | "streaming"
  | "vector"
  | "competitor-olap"
  | "ai-framework"
  | "pipeline";

export interface WatchlistRepo {
  owner: string;
  name: string;
  category: WatchlistCategory;
  /** One line shown on prospect cards and handed to the opener prompt. */
  whyMatters: string;
}

/** Score bump per category for the GitHub intent roll-up (see header). */
export const CATEGORY_WEIGHT: Record<WatchlistCategory, number> = {
  singlestore: 10,
  "competitor-oltp": 8,
  streaming: 6,
  vector: 6,
  "competitor-olap": 5,
  "ai-framework": 2,
  pipeline: 1,
};

export const WATCHLIST: WatchlistRepo[] = [
  // --- SingleStore's own -----------------------------------------------------
  {
    owner: "singlestore-labs",
    name: "singlestoredb-python",
    category: "singlestore",
    whyMatters: "SingleStore's Python SDK for the database and the management API; using it means building on SingleStore today.",
  },
  {
    owner: "singlestore-labs",
    name: "mcp-server-singlestore",
    category: "singlestore",
    whyMatters: "The official SingleStore MCP server, which lets AI clients manage Helios and run SQL; an AI-tooling team wiring SingleStore in.",
  },
  {
    owner: "singlestore-labs",
    name: "singlestoredb-dev-image",
    category: "singlestore",
    whyMatters: "SingleStore's dev container for local development and CI; someone running SingleStore hands-on.",
  },
  {
    owner: "singlestore-labs",
    name: "langchain-singlestore",
    category: "singlestore",
    whyMatters: "SingleStore's LangChain integration; a RAG builder considering SingleStore as the data layer.",
  },
  {
    owner: "memsql",
    name: "singlestore-spark-connector",
    category: "singlestore",
    whyMatters: "SingleStore's Spark connector; a data team moving data between Spark and SingleStore.",
  },
  // --- Scale-out OLTP (distributed SQL) ----------------------------------------
  {
    owner: "vitessio",
    name: "vitess",
    category: "competitor-oltp",
    whyMatters: "Sharding layer for MySQL (the engine under PlanetScale); a team that has outgrown a single MySQL writer.",
  },
  {
    owner: "pingcap",
    name: "tidb",
    category: "competitor-oltp",
    whyMatters: "MySQL-compatible distributed SQL with HTAP; a team evaluating scale-out MySQL for transactions plus analytics.",
  },
  {
    owner: "cockroachdb",
    name: "cockroach",
    category: "competitor-oltp",
    whyMatters: "Postgres-compatible distributed SQL; a team scaling OLTP past one Postgres node.",
  },
  // --- Streaming / CDC ---------------------------------------------------------
  {
    owner: "apache",
    name: "kafka",
    category: "streaming",
    whyMatters: "The default event backbone; SingleStore Pipelines ingest from Kafka directly.",
  },
  {
    owner: "apache",
    name: "flink",
    category: "streaming",
    whyMatters: "Stream processing feeding real-time analytics; often one of several systems kept in sync downstream.",
  },
  {
    owner: "redpanda-data",
    name: "redpanda",
    category: "streaming",
    whyMatters: "Kafka-compatible streaming platform; a team investing in low-latency event pipelines.",
  },
  {
    owner: "debezium",
    name: "debezium",
    category: "streaming",
    whyMatters: "Change data capture out of MySQL / Postgres / Oracle; the pipe that keeps a second store in sync with the app database.",
  },
  // --- Vector ------------------------------------------------------------------
  {
    owner: "pgvector",
    name: "pgvector",
    category: "vector",
    whyMatters: "Vector search inside Postgres; a team putting embeddings next to operational data.",
  },
  {
    owner: "milvus-io",
    name: "milvus",
    category: "vector",
    whyMatters: "Standalone vector database; a separate vector store that has to be kept in sync with app data.",
  },
  {
    owner: "qdrant",
    name: "qdrant",
    category: "vector",
    whyMatters: "Standalone vector search engine; RAG or semantic search running beside the operational database.",
  },
  // --- Real-time / interactive analytics ---------------------------------------
  {
    owner: "ClickHouse",
    name: "ClickHouse",
    category: "competitor-olap",
    whyMatters: "Columnar OLAP for real-time analytics; strong on append-heavy data, separate from the transactional database.",
  },
  {
    owner: "apache",
    name: "pinot",
    category: "competitor-olap",
    whyMatters: "Real-time OLAP for user-facing analytics; a team serving low-latency dashboards to customers.",
  },
  {
    owner: "apache",
    name: "druid",
    category: "competitor-olap",
    whyMatters: "Real-time analytics database for event data; another serving layer beside the app database.",
  },
  {
    owner: "trinodb",
    name: "trino",
    category: "competitor-olap",
    whyMatters: "Federated SQL across many stores; a data estate spread over several systems.",
  },
  {
    owner: "duckdb",
    name: "duckdb",
    category: "competitor-olap",
    whyMatters: "Embedded analytical database; a data team doing fast analytics outside the warehouse.",
  },
  // --- AI frameworks -----------------------------------------------------------
  {
    owner: "langchain-ai",
    name: "langchain",
    category: "ai-framework",
    whyMatters: "The most common RAG / agent framework; someone building gen-AI features that will need a vector store.",
  },
  {
    owner: "run-llama",
    name: "llama_index",
    category: "ai-framework",
    whyMatters: "RAG framework over company data; retrieval quality depends on fresh, filterable data next to the vectors.",
  },
  // --- Pipelines / lakehouse ---------------------------------------------------
  {
    owner: "airbytehq",
    name: "airbyte",
    category: "pipeline",
    whyMatters: "ELT connectors moving data between systems; a sign of many sources and stores to keep in sync.",
  },
  {
    owner: "dbt-labs",
    name: "dbt",
    category: "pipeline",
    whyMatters: "Warehouse transformation (dbt Core); an analytics-engineering team on Snowflake / Databricks / BigQuery.",
  },
  {
    owner: "apache",
    name: "iceberg",
    category: "pipeline",
    whyMatters: "Open table format for the lakehouse; SingleStore reads and writes Iceberg and runs zero-copy compute on it.",
  },
];

/** Lowercase "owner/name", the gtm_monitored_repos primary key. */
export function watchlistKey(r: Pick<WatchlistRepo, "owner" | "name">): string {
  return `${r.owner}/${r.name}`.toLowerCase();
}

/** Category for a stored repo key, when it is on the current watchlist. */
export function watchlistCategory(repoKey: string): WatchlistCategory | undefined {
  const k = repoKey.toLowerCase();
  return WATCHLIST.find((r) => watchlistKey(r) === k)?.category;
}
