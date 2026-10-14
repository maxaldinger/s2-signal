# Account research file format

One JSON file per account: `data/research/<slug>.json`. These files are the
cached, source-grounded research the demo runs on (no live enrichment needed).
`npm run seed` loads them into SingleStore.

Rules:
- Every fact must trace to a `sources[].id`. No source -> it is an inference or unknown.
- `evidence` = "verified" only when a cited source states it directly.
  "inferred" = a reasoned conclusion from cited facts (say which).
- Never invent people, emails, phone numbers, budgets, tech stacks or pain.
  Named people only if a cited public source names them in that role.
- A missing signal goes in `unknowns`, never as a negative fact.
- Dates: ISO `YYYY-MM-DD` (or `YYYY-MM` / `YYYY` when that is all the source gives).

```jsonc
{
  "slug": "acme",                       // lowercase, hyphens
  "name": "Acme Corp",
  "domain": "acme.com",
  "hq": "San Francisco, CA, USA",
  "industry": "fintech",                // fintech | saas | ecommerce | adtech | cybersecurity | ai_native
  "business_model": "one sentence",
  "employee_range": "1001-5000",        // or null if unknown
  "ownership": "public (NYSE: ACME)",   // or "private (Series D)" etc.
  "overview": "2-4 sentences, factual, cited facts only",
  "researched_at": "2026-10-14",

  "sources": [
    { "id": "s1", "url": "https://...", "title": "...", "publisher": "acme.com engineering blog",
      "published_date": "2025-03-02", "excerpt": "short paraphrase of the relevant point (<= 40 words, not a long quote)" }
  ],

  "tech_signals": [
    { "technology": "PostgreSQL", "category": "oltp",   // oltp | warehouse | lakehouse | olap | search | streaming | vector | cache | etl_cdc | other
      "detail": "how it is used, at what scale if stated",
      "evidence": "verified", "source_ids": ["s1"] }
  ],

  "buying_signals": [
    { "kind": "technology",             // technology | organizational | business
      "title": "short headline",
      "detail": "what happened and why it is relevant to SingleStore",
      "signal_date": "2025-03-02",
      "strength": 3,                    // 1 weak .. 5 strong relevance to SingleStore
      "evidence": "verified",           // verified | inferred
      "source_ids": ["s1"] }
  ],

  "initiatives": [                      // engineering / data infra initiatives
    { "title": "...", "detail": "...", "evidence": "verified", "source_ids": ["s2"] }
  ],

  "scoring": {                          // 0-5 per dimension, or null when unknown
    "architectural_fit":   { "score": 4, "rationale": "...", "source_ids": ["s1"] },
    "buying_signals":      { "score": 3, "rationale": "...", "source_ids": [] },
    "workload_relevance":  { "score": 4, "rationale": "...", "source_ids": [] },
    "organizational_fit":  { "score": 3, "rationale": "...", "source_ids": [] },
    "evidence_confidence": { "score": 4, "rationale": "how strong / recent / first-party the sources are" }
  },

  "personas": [                         // role-based; a named person only with a source
    { "title": "VP Data Engineering", "why": "...", "name": null, "source_ids": [] }
  ],

  "use_cases": [ { "title": "...", "detail": "...", "singlestore_capability": "e.g. HTAP / real-time analytics / vector + full-text" } ],
  "verified_facts": [ { "fact": "...", "source_ids": ["s1"] } ],
  "inferences": [ { "inference": "...", "based_on": ["s1"] } ],
  "unknowns": [ "..." ],
  "discovery_questions": [ "..." ],
  "opportunity_hypothesis": "2-4 sentences, explicitly framed as a hypothesis to validate",
  "outreach": {
    "persona": "VP Data Engineering",
    "subject": "...",
    "body": "<= 120 words, grounded only in cited facts, no claim that a problem exists"
  },
  "singlestore_relationship": "none found | existing SingleStore customer (source) | ..."
}
```
