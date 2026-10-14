// Personalized SingleStore proposal — the prospect-facing page served at the
// public /p/<token> link. Canonical sections (how SingleStore works, rollout,
// proof, why SingleStore) live HERE as fixed copy drawn only from
// lib/singlestore.ts, so the model can never mangle a claim; only the
// executive summary and the closing CTA are model-personalized, and the ROI
// table is computed in code from the account's numbers.

import { S2_LOGO } from "./pocPdf";

/** Published consolidation claims used as the ROI table's two scenario rates
 *  (lib/singlestore.ts PRICING). Both are total-cost comparisons published by
 *  SingleStore, i.e. other companies' results, never a prediction. */
export const ROI_RATE_LOW = 50; // GigaOm 2022, SingleStore-commissioned: ~50% lower 3-yr TCO vs two-database stacks
export const ROI_RATE_HIGH = 60; // Fathom Analytics customer claim: -60% database TCO

export interface ProposalRoiTier {
  /** Share of the in-scope spend this scenario consolidates (%). */
  scopePct: number;
  label: string;
  /** In-scope spend this scenario covers, per year (USD). */
  spendYr: number;
  /** Modeled annual saving at ROI_RATE_LOW / ROI_RATE_HIGH. */
  savedLow: number;
  savedHigh: number;
}

export interface ProposalRoi {
  /** Monthly spend (USD) on the systems SingleStore could consolidate: the
   *  account's own figure when the rep confirmed it, otherwise MODELED as
   *  engineers × perEngMo. */
  spendMo: number;
  basis: "confirmed" | "modeled";
  /** Modeled basis only: the per-engineer CUSTOMER ASSUMPTION and the
   *  engineering headcount it was multiplied by. */
  perEngMo?: number;
  engineers?: number;
  engineersConfirmed?: boolean;
  /** The scenario rates printed in the table header. */
  lowPct: number;
  highPct: number;
  /** Consolidation-scope table (first workload / 25% / 50% / full in-scope
   *  estate for larger estates, a single row for small ones). */
  tiers: ProposalRoiTier[];
}

/** Which narrative the document tells. COST leads with the modeled economics;
 *  OPERATIONAL leads with the account's data architecture and treats
 *  economics as a secondary section. */
export type PositioningMode = "cost" | "operational";

/** The personalized text for ONE narrative. A dual document stores one per
 *  mode under `narratives`; single-mode documents store the same shape
 *  flattened at the top level of ProposalFields. */
export interface ProposalNarrative {
  headline?: string;
  subtitle?: string;
  execSummary: string[];
  environment?: string[];
  cta: string;
}

export interface ProposalFields {
  company: string;
  /** Recorded for the rep (which contact the doc was generated around) but
   *  deliberately NOT rendered: one proposal link goes to several people at
   *  the account, so a "Hi Rick," greeting is wrong for everyone else. */
  contactName?: string;
  /** The brief's entry-workload focus; picks the proof points that lead. */
  focus?: "realtime" | "ai";
  /** DUAL documents: both narratives generated together and rendered as tabs
   *  on one page — Operational | ROI. When present, the flattened top-level
   *  fields mirror the default tab. */
  narratives?: { operational: ProposalNarrative; cost: ProposalNarrative };
  /** For a dual document: the DEFAULT tab. For a single-narrative document:
   *  its layout. Absent → the original single layout. */
  positioningMode?: PositioningMode;
  /** Model-written in OPERATIONAL mode only. Cost mode computes its headline
   *  from the ROI table and never lets the model write a number. */
  headline?: string;
  subtitle?: string;
  /** Model-personalized executive-summary paragraphs (2-3). */
  execSummary: string[];
  /** COST mode: 1-2 evidence-only paragraphs on the account's data
   *  environment, rendered as its own section after the summary. */
  environment?: string[];
  /** Model-personalized closing CTA paragraph. */
  cta: string;
  /** Engineering headcount (software + data engineers). */
  engineers?: number;
  employees?: number;
  roi?: ProposalRoi;
  generatedAt: string;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const usd = (n: number) =>
  isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";

// Headline-sized money: $944K, $25.9M, $258M.
const usdCompact = (n: number): string => {
  if (!isFinite(n) || n <= 0) return "";
  if (n >= 1e6) {
    const m = n / 1e6;
    return `$${m >= 100 ? Math.round(m).toLocaleString("en-US") : String(Math.round(m * 10) / 10)}M`;
  }
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

const dateLong = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// Neutral SingleStore styling: purple accent, matching the other print
// exports (lib/pocPdf.ts, lib/roiPdf.ts).
const STYLE_BLOCK = `  :root {
    --brand: #6d1fc4; --brand-bright: #8a2be2;
    --ink: #1a2230; --ink-2: #46556a; --ink-3: #7a8699;
    --line: #e6eaf0; --tint: #f4eefd; --green: #15803d;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); background: #f3f4f6; -webkit-font-smoothing: antialiased;
    font-size: 10.8pt; line-height: 1.5;
  }
  .sheet { max-width: 7.6in; margin: 18px auto; background: #fff; padding: 0.62in 0.66in; box-shadow: 0 6px 30px rgba(15,23,42,0.12); border-radius: 4px; }
  .toolbar { max-width: 7.6in; margin: 0 auto 4px; display: flex; justify-content: flex-end; padding: 2px 4px; }
  .toolbar button { font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; background: var(--brand); color: #fff; border: 0; padding: 8px 16px; border-radius: 8px; }
  .toolbar button:hover { background: #5a189f; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; }
  }
  .letterhead { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 12px; }
  .logo { display: block; height: 30px; width: auto; }
  .lh-right { text-align: right; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }
  .rule { height: 3px; border-radius: 3px; margin: 0 0 22px; background: linear-gradient(90deg, var(--brand-bright), #c39cf0 55%, transparent); }
  .eyebrow { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brand); margin: 0 0 6px; }
  h1.title { margin: 0; font-size: 20pt; line-height: 1.14; letter-spacing: -0.015em; font-weight: 800; color: var(--ink); }
  .subline { margin: 10px 0 0; font-size: 9.5pt; color: var(--ink-3); }
  section { margin-top: 21px; break-inside: avoid; }
  .sec-head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 9px; }
  .sec-head .bar { width: 16px; height: 3px; border-radius: 2px; background: var(--brand-bright); transform: translateY(-3px); }
  .sec-head h2 { margin: 0; font-size: 12.5pt; font-weight: 800; letter-spacing: -0.01em; }
  p.body { margin: 0 0 10px; font-size: 10pt; color: var(--ink-2); }
  p.body b, li b { color: var(--ink); }
  ul.plain { margin: 0 0 10px; padding-left: 18px; }
  ul.plain li { font-size: 10pt; color: var(--ink-2); margin-bottom: 5px; }
  .milestone { border: 1px solid var(--line); border-left: 3px solid var(--brand-bright); border-radius: 10px; padding: 11px 14px; margin-bottom: 8px; break-inside: avoid; }
  .milestone h4 { margin: 0 0 3px; font-size: 10.5pt; color: var(--brand); }
  .milestone p { margin: 0; font-size: 9.6pt; color: var(--ink-2); }
  table.cs { width: 100%; border-collapse: collapse; font-size: 9.8pt; }
  table.cs thead th { background: var(--brand-bright); color: #fff; font-weight: 700; text-align: left; padding: 7px 12px; }
  table.cs thead th.num, table.cs td.num { text-align: right; white-space: nowrap; }
  table.cs tbody td { padding: 7px 12px; border-bottom: 1px solid var(--line); color: var(--ink); }
  table.cs tbody tr:nth-child(odd) td { background: #faf7fe; }
  table.cs td .sub { display: block; font-size: 8.3pt; color: var(--ink-3); }
  .num.big { color: var(--green); font-weight: 800; }
  .tag { display: inline-block; font-size: 7.4pt; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: var(--brand); border: 1px solid #d9c4f5; border-radius: 4px; padding: 0 4px; margin-right: 4px; }
  .note { margin-top: 9px; font-size: 8.4pt; color: var(--ink-3); }
  .cta { border: 1px solid var(--line); border-left: 3px solid var(--brand-bright); background: var(--tint); border-radius: 11px; padding: 14px 16px; font-size: 10pt; color: var(--ink); }
  .foot { margin-top: 24px; padding-top: 11px; border-top: 1px solid var(--line); font-size: 8pt; color: var(--ink-3); display: flex; justify-content: space-between; }
  @page { size: Letter; margin: 0.5in; }
`;

/** Operational headlines must never carry a dollar figure or a savings
 *  percentage; that is the whole point of the mode. Model output is checked
 *  here as well as in the generator, so a stored field can't sneak one in. */
const carriesMoneyOrPct = (t: string) => /\$|\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?[MK]\b/i.test(t);

type Layout = "legacy" | PositioningMode;

interface Pane {
  key: Layout;
  label: string;
  title: string;
  subline: string;
  body: string;
}

// Tab bar for dual documents. `.toolbar .tab` outranks the existing
// `.toolbar button` rule so the tabs don't inherit the print button's fill.
const TAB_STYLE = `
  .toolbar.tabbed { justify-content: space-between; align-items: center; }
  .tabs { display: flex; gap: 6px; }
  .toolbar .tab { font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; background: #fff; color: var(--ink-3); border: 1px solid var(--line); padding: 8px 14px; border-radius: 8px; }
  .toolbar .tab:hover { color: var(--ink); background: #fff; }
  .toolbar .tab.active { color: var(--brand); border-color: var(--brand-bright); background: var(--tint); }
  .pane[hidden] { display: none; }
  @media print { .tabs { display: none !important; } .pane[hidden] { display: none !important; } }
`;

// Switches panes; #roi / #operational in the URL opens that tab directly, so
// a link can be sent pointing at either narrative. Printing prints only the
// visible pane.
const TAB_SCRIPT = `<script>(function(){var tabs=document.querySelectorAll('.tab'),panes=document.querySelectorAll('.pane');function show(k){tabs.forEach(function(t){t.classList.toggle('active',t.getAttribute('data-pane')===k)});panes.forEach(function(p){p.hidden=p.getAttribute('data-pane')!==k});try{history.replaceState(null,'',k==='cost'?'#roi':'#operational')}catch(e){}}tabs.forEach(function(t){t.addEventListener('click',function(){show(t.getAttribute('data-pane'))})});if(location.hash==='#roi')show('cost');else if(location.hash==='#operational')show('operational')})();</script>`;

// Pricing anchors (lib/singlestore.ts PRICING, singlestore.com/cloud-pricing,
// accessed 2026-10-14): Standard edition, AWS us-east-1, on-demand list.
// Monthly = hourly × 730 always-on hours.
const ANCHOR_S1_MO = Math.round(3.96 * 730); // S-1, 8 vCPU / 64 GB
const ANCHOR_S4_MO = Math.round(15.84 * 730); // S-4, 32 vCPU / 256 GB

/** Render ONE narrative into a titled document body. `layout` decides the
 *  headline source and the section order; `n` supplies the personalized
 *  text; `f` supplies the computed ROI and the company. */
function renderPane(layout: Layout, n: ProposalNarrative, f: ProposalFields): Omit<Pane, "key" | "label"> {
  const company = esc(f.company);
  const exec = (n.execSummary ?? [])
    .slice(0, 3)
    .map((p) => `<p class="body">${esc(p)}</p>`)
    .join("");

  const roiTable = (r: ProposalRoi): string => {
    const rows = (r.tiers ?? [])
      .map(
        (t) => `
          <tr>
            <td>${t.scopePct}%<span class="sub">${esc(t.label)}</span></td>
            <td class="num">${usd(t.spendYr)}</td>
            <td class="num big">${usd(t.savedLow)}</td>
            <td class="num big">${usd(t.savedHigh)}</td>
          </tr>`,
      )
      .join("");
    const spendLine =
      r.basis === "confirmed"
        ? `<span class="tag">customer figure</span>Uses the ${usd(r.spendMo)} per month your team shared for the systems in
      scope.`
        : `<span class="tag">customer assumption</span>In-scope spend is MODELED as ${usd(r.perEngMo ?? 0)} per engineer per
      month across ${r.engineersConfirmed ? "" : "an estimated ~"}${(r.engineers ?? 0).toLocaleString()} engineers
      (${usd(r.spendMo)}/month). It is an assumption to make the math concrete, not a measurement of your spend; replace
      it with your real bills for the systems in scope.`;
    return `
      <table class="cs">
        <thead><tr><th>Share consolidated</th><th class="num">In-scope spend / yr</th><th class="num">Saved at −${r.lowPct}%</th><th class="num">Saved at −${r.highPct}%</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">${spendLine} &ldquo;In scope&rdquo; means the serving-layer systems SingleStore could consolidate
      (operational database replicas, real-time analytics store, cache, search cluster, vector database, the ETL/CDC jobs
      between them, and engineer time maintaining those pipelines); the warehouse or lakehouse you use for history and
      training is not counted.</p>
      <p class="note"><span class="tag">modeled</span>Savings apply two published total-cost comparisons as scenario rates,
      not as a prediction for ${company}: −${r.lowPct}% from GigaOm&rsquo;s 2022 field test (commissioned by SingleStore;
      ~50&ndash;60% lower 3-year TCO than MySQL + Snowflake and PostgreSQL + Redshift stacks, including people costs) and
      −${r.highPct}% from Fathom Analytics&rsquo; published database TCO reduction (a customer claim). Your number depends on
      which systems retire and on your SingleStore configuration.</p>
      <p class="note"><span class="tag">list price</span>For scale: Helios Standard on AWS us-east-1 lists S-1 (8 vCPU / 64 GB)
      at $3.96/hour (about ${usd(ANCHOR_S1_MO)}/month always-on) and S-4 (32 vCPU / 256 GB) at $15.84/hour (about
      ${usd(ANCHOR_S4_MO)}/month); storage from $0.023 per GB-month; Enterprise is 1.5x credits. Committed-use rates are
      not public (singlestore.com/cloud-pricing, Oct 2026).</p>`;
  };

  // ---- Headline ------------------------------------------------------------
  // Cost / legacy: LEAD with the modeled savings from the most conservative
  // row of the ROI table (the first-workload tier at the lower published
  // rate), so the number that hooks the reader is also the easiest to defend.
  // The "+" carries the upside. No spend basis → no dollar headline.
  //
  // Operational: the model wrote the headline from the account's research. It
  // is never allowed to carry a figure.
  const baseTier = f.roi?.tiers?.[0];
  const headlineSave = baseTier?.savedLow ?? 0;
  const headlineScales = (f.roi?.tiers?.length ?? 0) > 1;
  const costTitle =
    headlineSave > 0
      ? `${usdCompact(headlineSave)}+ in Modeled Annual Savings from Consolidating ${company}&rsquo;s Real-Time Data Stack`
      : `Consolidating ${company}&rsquo;s Real-Time Data Stack onto One Engine`;
  const costSubline =
    headlineSave > 0
      ? `Modeled at the lower of two published consolidation results (−${f.roi?.lowPct ?? ROI_RATE_LOW}%), on ${
          headlineScales ? "a first workload covering about 10% of the in-scope spend" : "the in-scope spend"
        }${headlineScales ? " — the table below scales it with consolidation" : ""}. SingleStore runs transactions and
    real-time analytics, with full-text and vector search, in one distributed SQL engine, so fewer systems need to be
    run and kept in sync.`
      : `SingleStore runs transactions and real-time analytics, with full-text and vector search, in one distributed SQL
    engine, so fewer systems need to be run and kept in sync.`;
  const opHeadlineRaw = (n.headline ?? "").trim();
  const opTitle =
    opHeadlineRaw && !carriesMoneyOrPct(opHeadlineRaw)
      ? esc(opHeadlineRaw)
      : `Real-Time Analytics on Fresh Data Across ${company}&rsquo;s Platform`;
  const opSubtitleRaw = (n.subtitle ?? "").trim();
  const opSubline = opSubtitleRaw
    ? esc(opSubtitleRaw)
    : `One distributed SQL engine for transactions, real-time analytics, full-text and vector search, so
    customer-facing queries run on fresh data without a pipeline between systems.`;
  const title = layout === "operational" ? opTitle : costTitle;
  const subline = layout === "operational" ? opSubline : costSubline;

  // ---- Sections ------------------------------------------------------------
  const sec = (heading: string, inner: string) => `
    <section>
      <div class="sec-head"><span class="bar"></span><h2>${heading}</h2></div>
      ${inner}
    </section>`;

  const execSection = sec("Executive summary", exec);

  const environmentSection =
    n.environment && n.environment.length > 0
      ? sec(
          "Your data environment",
          n.environment
            .slice(0, 2)
            .map((p) => `<p class="body">${esc(p)}</p>`)
            .join(""),
        )
      : "";

  const solutionInner = `
      <p class="body">SingleStore is one distributed SQL database for transactions and analytics. Teams typically use it
      to replace the serving-layer systems they would otherwise run side by side (an operational database, a real-time
      analytics store, a cache, a search index, a vector database) and the pipelines that keep them in sync. Your warehouse
      or lakehouse stays for history and training; SingleStore sits beside it.</p>
      <ul class="plain">
        <li><b>Transactions and analytics in one engine.</b> An in-memory rowstore for high-concurrency point lookups and
        an on-disk columnstore for analytics on data larger than memory, joinable in one query; compute scales up or down
        online without dropping connections.</li>
        <li><b>Fresh data without a pipeline in between.</b> Pipelines load continuously from Kafka, Kinesis, S3, Azure
        Blob, GCS and Apache Iceberg; SingleStore Flow migrates and replicates by CDC from MySQL, PostgreSQL, Oracle and
        SQL Server.</li>
        <li><b>Search and vectors in the same SQL.</b> Full-text search (Lucene-compatible syntax, BM25 scoring) and a
        native vector type with ANN indexes, queried alongside your operational data with SQL filters and joins.</li>
        <li><b>Fewer systems to pay for and operate.</b> Every store retired is one less cluster, licence, sync job and
        on-call rotation; that is where the economics in this proposal come from.</li>
      </ul>
      <p class="body">MySQL wire compatible: existing MySQL drivers, ORMs and BI tools connect unchanged (a broad subset of
      MySQL syntax is supported, not all of it). Delivered as Helios, fully managed on AWS, Azure and GCP; as Helios BYOC in
      your own cloud account; or self-managed. Compliance: SOC 2 Type II and ISO/IEC 27001, with PCI DSS v4.0.1 for
      Helios Enterprise and BYOC.</p>`;
  // The operational reader cares about what changes for the systems behind
  // their product, so the same mechanics are framed as workflow, not bill.
  const solutionInnerOperational = `
      <p class="body">SingleStore is one distributed SQL database for transactions and analytics. What changes is where a
      fresh-data question goes: instead of crossing a pipeline from the operational store to an analytics store, a cache
      or a search index, it runs against the data as it lands.</p>
      <ul class="plain">
        <li><b>HTAP on live data.</b> An in-memory rowstore for high-concurrency transactional lookups and an on-disk
        columnstore for analytics, joinable in one query, so customer-facing dashboards read the same data the
        application just wrote.</li>
        <li><b>Streaming ingest built in.</b> Pipelines load continuously from Kafka, Kinesis, S3, Azure Blob, GCS and
        Apache Iceberg; Flow handles migration and CDC from MySQL, PostgreSQL, Oracle and SQL Server.</li>
        <li><b>Scale-out SQL.</b> Data is sharded across nodes and compute scales online, past the single-writer limit
        of a conventional operational database.</li>
        <li><b>Search and vectors next to the source of truth.</b> Full-text (BM25) and vector search with SQL filters and
        joins in the same engine, so a RAG or search feature does not need its own store kept in sync.</li>
      </ul>
      <p class="body">MySQL wire compatible, so existing drivers, ORMs and BI tools connect unchanged. Your warehouse or
      lakehouse stays for history and training; bi-directional Apache Iceberg integration attaches to the same data
      without copies.</p>`;

  const milestonesInner = `
      <div class="milestone"><h4>Step 1 — connect and load one workload</h4><p>Point an existing MySQL driver, BI tool
      or notebook at a Helios cluster sized for the test (start small and scale online). Load the data with Pipelines
      from Kafka, S3 or Iceberg, or with Flow from your operational database. The free Shared tier is for exploration
      only; performance tests run on a Standard or Enterprise cluster.</p></div>
      <div class="milestone"><h4>Step 2 — prove it against agreed SLAs</h4><p>Agree the bar up front, on your data:
      latency at your concurrency, ingest-to-query freshness, and cost. For reference, Armis defined query SLAs of
      1.5s / 3s / 10s over 3 / 7 / 30+ days of data for its evaluation, and Siemens went from trial deployment to
      selection in five days. Those are their results, not a promise for yours.</p></div>
      <div class="milestone"><h4>Step 3 — expand and consolidate</h4><p>Move adjacent workloads onto the same engine
      and retire the stores they replace one at a time, rather than a big-bang migration. The warehouse or lakehouse
      stays in place for history and training.</p></div>`;

  const proofRealtime = `
        <li><b>Armis</b> (cybersecurity): data-pipeline cost cut <b>70%</b> versus a &gt;$1M/yr pipeline on a 160-node
        Elasticsearch cluster; queries that timed out on Elasticsearch now run in under 10s, some under 1.5s, at 100B
        events/day.</li>
        <li><b>Fathom Analytics</b> (web analytics SaaS): replaced RDS MySQL, ElastiCache Redis and DynamoDB;
        <b>60% lower database TCO</b>, exports to S3 from hours to 30 seconds, $3,000/month saved on DynamoDB alone.</li>
        <li><b>Siemens</b> (Pulse analytics on AWS): replaced SQL Server; dashboards <b>10&ndash;100x faster</b>, under
        100ms queries over billions of rows, 500 to 100,000 concurrent users.</li>
        <li><b>A Fortune 25 financial services firm</b>: 2+ PB managed, 40,000+ concurrent users, 10&ndash;20ms
        responses, and 3x faster average queries than SAP HANA in its own head-to-head for a wealth-management
        portal.</li>`;
  const proofAi = `
        <li><b>DirectlyApply</b> (jobs marketplace): replaced MongoDB and Elasticsearch; <b>$100,000/yr saved</b> and 6ms
        queries over billions of documents.</li>
        <li><b>Thorn</b> (child-safety nonprofit): real-time vector insert and query replaced a custom image-matching
        pipeline; investigation time <b>down 53%</b> in 2022 (the database&rsquo;s share of that gain is not
        isolated).</li>`;
  const proofInner = `
      <ul class="plain">
        ${f.focus === "ai" ? proofAi + proofRealtime : proofRealtime + proofAi}
      </ul>
      <p class="note">Customer results are claims published by SingleStore in vendor case studies, not independent audits;
      several date from 2021&ndash;2022. Each states what that customer measured in its own environment.</p>`;

  const whyS2Inner = `
      <p class="body">Most data stacks sprawl at the serving layer: each new product requirement (a faster dashboard, a
      search box, a RAG feature) adds another store and another pipeline to keep in sync. SingleStore&rsquo;s bet is that
      one engine can serve transactions, real-time analytics, full-text and vector search on the same fresh data, so the
      next requirement is a query rather than a new system. It is designed to sit beside your warehouse or lakehouse,
      not to replace it, and to be adopted one workload at a time. Where a specialist tool is genuinely the better fit,
      such as a pure cache or long-running batch analytics, keep it.</p>`;

  const nextSection = sec("Next steps", `<div class="cta">${esc(n.cta)}</div>`);

  // The economics: primary in cost mode, explicitly secondary in operational.
  const roiSection = (heading: string, intro: string) =>
    f.roi?.tiers?.length ? sec(heading, `${intro}${roiTable(f.roi)}`) : "";
  const roiCost = roiSection(`${company}&rsquo;s numbers`, "");
  const roiOperational = roiSection(
    "Potential economic impact",
    `<p class="body">Secondary to the operational case above: consolidating the serving layer also changes the bill.
      The figures below are modeled, not measured spend.</p>`,
  );

  let body: string;
  if (layout === "legacy") {
    // The original single layout.
    body = [
      execSection,
      sec("Our solution", solutionInner),
      sec("How it works", milestonesInner),
      roiCost,
      sec("Proof points", proofInner),
      sec("Why SingleStore", whyS2Inner),
      nextSection,
    ].join("");
  } else if (layout === "cost") {
    // Financial outcome → why costs rise → their environment → the economic
    // model → how SingleStore works → proof → next step.
    body = [
      execSection,
      environmentSection,
      roiCost,
      sec("How SingleStore works", solutionInner),
      sec("Rollout", milestonesInner),
      sec("Proof points", proofInner),
      sec("Why SingleStore", whyS2Inner),
      nextSection,
    ].join("");
  } else {
    // Environment → friction → why it persists → what SingleStore changes →
    // impact → evidence → economics LAST.
    body = [
      execSection,
      sec("How SingleStore works", solutionInnerOperational),
      sec("Rollout", milestonesInner),
      sec("Proof points", proofInner),
      roiOperational,
      sec("Why SingleStore", whyS2Inner),
      nextSection,
    ].join("");
  }

  return { title, subline, body };
}

function sheet(p: Pane, f: ProposalFields): string {
  const company = esc(f.company);
  return `
  <div class="sheet">
    <header class="letterhead">
      ${S2_LOGO}
      <div class="lh-right">SingleStore<br/>Proposal</div>
    </header>
    <div class="rule"></div>

    <p class="eyebrow">prepared for ${company} · ${dateLong(f.generatedAt)}</p>
    <h1 class="title">${p.title}</h1>
    <p class="subline">${p.subline}</p>
${p.body}

    <div class="foot">
      <span>SingleStore · singlestore.com</span>
      <span>Prepared for ${company} · ${dateLong(f.generatedAt)}</span>
    </div>
  </div>`;
}

function frame(docTitle: string, f: ProposalFields, panes: Pane[], active: Layout): string {
  const tabbed = panes.length > 1;
  const toolbar = tabbed
    ? `<div class="toolbar tabbed"><div class="tabs" role="tablist">${panes
        .map(
          (p) =>
            `<button type="button" role="tab" class="tab${p.key === active ? " active" : ""}" data-pane="${p.key}">${p.label}</button>`,
        )
        .join("")}</div><button type="button" onclick="window.print()">Download PDF</button></div>`
    : `<div class="toolbar"><button onclick="window.print()">Download PDF</button></div>`;
  const content = tabbed
    ? panes
        .map((p) => `<div class="pane" data-pane="${p.key}"${p.key === active ? "" : " hidden"}>${sheet(p, f)}</div>`)
        .join("")
    : sheet(panes[0], f);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${docTitle}</title>
<style>
${STYLE_BLOCK}${tabbed ? TAB_STYLE : ""}</style>
</head>
<body>
  ${toolbar}${content}
${tabbed ? TAB_SCRIPT : ""}</body>
</html>`;
}

export function buildProposalHtml(f: ProposalFields): string {
  const company = esc(f.company);

  // DUAL document: both narratives on one page, Operational | ROI tabs.
  if (f.narratives) {
    const active: Layout = f.positioningMode === "cost" ? "cost" : "operational";
    const panes: Pane[] = [
      { key: "operational", label: "Operational", ...renderPane("operational", f.narratives.operational, f) },
      { key: "cost", label: "ROI", ...renderPane("cost", f.narratives.cost, f) },
    ];
    return frame(`SingleStore proposal — prepared for ${company}`, f, panes, active);
  }

  // Single narrative: a stored mode, or the original layout when there is none.
  const layout: Layout = f.positioningMode ?? "legacy";
  const pane: Pane = { key: layout, label: "", ...renderPane(layout, f, f) };
  const docTitle =
    layout === "operational"
      ? `SingleStore proposal — prepared for ${company}`
      : `Consolidating the real-time data stack — prepared for ${company}`;
  return frame(docTitle, f, [pane], layout);
}
