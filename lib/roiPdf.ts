// Print-ready, branded one-pager for the ROI calculator — same mechanism as
// lib/pocPdf.ts (self-contained HTML in a new tab → browser print → Save as
// PDF): letterhead, big headline, header-row tables, footer. One page, built
// to be sent to a prospect as-is. All figures ANNUAL.
//
// The model is a SingleStore consolidation / TCO estimate. Every figure carries
// its basis, kept visibly distinct exactly as lib/singlestore.ts requires:
//   CUSTOMER ASSUMPTION — what the rep entered about the prospect (spend,
//                         headcount, share retired); never the known spend
//   MODELED             — computed here, incl. SingleStore cost from PUBLIC
//                         list prices (PRICING section of lib/singlestore.ts)
//   MEASURED            — other customers' published results (vendor case
//                         studies), shown as reference points, never a forecast

import { S2_LOGO } from "./pocPdf";

// ---------------------------------------------------------------------------
// Public list-price anchors — the ONLY prices the calculator uses. Source:
// lib/singlestore.ts PRICING (singlestore.com/cloud-pricing, accessed
// 2026-10-14; Helios Standard edition, AWS us-east-1). Verify before quoting.
// ---------------------------------------------------------------------------
export const S2_PRICING = {
  creditUsd: 3.96,
  storagePerGbMonth: 0.023, // Tier 1, per average GB-month
  enterpriseMultiplier: 1.5,
  multiAzMultiplier: 1.3,
  hoursPerMonth: 730, // always-on
  source: "singlestore.com/cloud-pricing, accessed 2026-10-14 (Helios Standard, AWS us-east-1, on-demand list)",
} as const;

export const S2_SIZES: { id: string; spec: string; credits: number; hourly: number }[] = [
  { id: "S-00", spec: "2 vCPU / 16 GB", credits: 0.25, hourly: 0.99 },
  { id: "S-1", spec: "8 vCPU / 64 GB", credits: 1, hourly: 3.96 },
  { id: "S-4", spec: "32 vCPU / 256 GB", credits: 4, hourly: 15.84 },
  { id: "S-20", spec: "160 vCPU / 1.28 TB", credits: 20, hourly: 79.2 },
];

/** One point inside a current-spend RANGE. When the rep doesn't know the real
 *  spend on the systems in scope (the usual case on a first call), the estimate
 *  is quoted as a band instead of a single invented number, and the export
 *  becomes a column per point. */
export interface RoiScenario {
  spendYr: number;
  retiredYr: number;
  s2CostYr: number;
  netSavingsYr: number;
  newRunRateYr: number;
}

export interface RoiPdfSimple {
  kind: "simple";
  /** CUSTOMER ASSUMPTION — the single spend, or the MIDPOINT when `scenarios` is set. */
  spendYr: number;
  /** CUSTOMER ASSUMPTION — share of that spend retired after consolidation. */
  retirePct: number;
  retiredYr: number;
  size: string;
  sizeHourly: number;
  storageGb: number;
  s2ComputeYr: number;
  s2StorageYr: number;
  s2CostYr: number;
  netSavingsYr: number;
  /** Remaining spend on systems that stay + SingleStore. */
  newRunRateYr: number;
  scenarios?: RoiScenario[];
}

export interface RoiSystemLine {
  label: string;
  spendYr: number;
  retirePct: number;
  retiredYr: number;
}

export interface RoiYear {
  year: number;
  statusQuo: number;
  withS2: number;
  cumulativeNet: number;
}

export interface RoiPdfAdvanced {
  kind: "advanced";
  systems: RoiSystemLine[];
  currentSystemsYr: number;
  retiredYr: number;
  pipelineFtes: number;
  loadedCost: number;
  freedPct: number;
  engCostYr: number;
  engFreedYr: number;
  size: string;
  sizeHourly: number;
  edition: "Standard" | "Enterprise";
  multiAz: boolean;
  hoursMo: number;
  storageGb: number;
  discountPct: number;
  s2ComputeYr: number;
  s2StorageYr: number;
  s2CostYr: number;
  grossBenefitYr: number;
  netSavingsYr: number;
  migrationWeeks: number;
  migrationCost: number;
  paybackMonths: number | null;
  returnX: number | null;
  threeYear: RoiYear[];
}

export type RoiPdfData = RoiPdfSimple | RoiPdfAdvanced;

const usd = (n: number) =>
  isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";

const todayLong = () =>
  new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

// Basis tags — the three labels every figure carries.
const A = `<span class="tag tag-a">customer assumption</span>`;
const M = `<span class="tag tag-m">modeled</span>`;
const X = `<span class="tag tag-x">measured</span>`;

// Shared frame: the letterhead + typography, one content slot.
function frame(title: string, eyebrow: string, subline: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root {
    --brand: #6d1fc4; --brand-bright: #8a2be2;
    --ink: #1a2230; --ink-2: #46556a; --ink-3: #7a8699;
    --line: #e6eaf0; --tint: #f4eefd; --green: #15803d; --red: #b91c1c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); background: #f3f4f6; -webkit-font-smoothing: antialiased;
    font-size: 10.5pt; line-height: 1.45;
  }
  .sheet { max-width: 7.6in; margin: 18px auto; background: #fff; padding: 0.62in 0.66in; box-shadow: 0 6px 30px rgba(15,23,42,0.12); border-radius: 4px; }
  .toolbar { max-width: 7.6in; margin: 0 auto 4px; display: flex; gap: 12px; align-items: center; justify-content: space-between; color: #475569; font-size: 12.5px; padding: 2px 4px; }
  .toolbar button { font: inherit; font-weight: 700; cursor: pointer; background: var(--brand); color: #fff; border: 0; padding: 9px 18px; border-radius: 8px; }
  .toolbar button:hover { background: #5a17a3; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; }
  }
  .letterhead { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 12px; }
  .logo { display: block; height: 30px; width: auto; }
  .lh-right { text-align: right; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }
  .rule { height: 3px; border-radius: 3px; margin: 0 0 22px; background: linear-gradient(90deg, var(--brand-bright), #c49bff 55%, transparent); }
  .eyebrow { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brand); margin: 0 0 6px; }
  h1.title { margin: 0; font-size: 21pt; line-height: 1.12; letter-spacing: -0.015em; font-weight: 800; color: var(--ink); }
  .subline { margin: 10px 0 0; font-size: 9.5pt; color: var(--ink-3); }
  section { margin-top: 18px; break-inside: avoid; }
  .sec-head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 9px; }
  .sec-head .bar { width: 16px; height: 3px; border-radius: 2px; background: var(--brand-bright); transform: translateY(-3px); }
  .sec-head h2 { margin: 0; font-size: 12.5pt; font-weight: 800; letter-spacing: -0.01em; }
  /* Header-row table, zebra body */
  table.cs { width: 100%; border-collapse: collapse; font-size: 9.4pt; }
  table.cs thead th { background: var(--brand-bright); color: #fff; font-weight: 700; text-align: left; padding: 6px 11px; }
  table.cs thead th.num, table.cs td.num { text-align: right; white-space: nowrap; }
  table.cs tbody td { padding: 6px 11px; border-bottom: 1px solid var(--line); color: var(--ink); }
  table.cs tbody tr:nth-child(odd) td { background: #faf8fe; }
  table.cs tr.total td { font-weight: 800; border-top: 2px solid var(--brand-bright); border-bottom: 0; }
  table.cs td .sub { display: block; font-size: 8.1pt; color: var(--ink-3); }
  .big { color: var(--green); }
  .neg { color: var(--red); }
  .tag { display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 4px; font-size: 6.6pt; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; vertical-align: 1px; }
  .tag-a { background: #fef3c7; color: #92400e; }
  .tag-m { background: #e0f2fe; color: #075985; }
  .tag-x { background: #dcfce7; color: #166534; }
  p.body { margin: 0 0 8px; font-size: 9.3pt; color: var(--ink-2); }
  p.body b { color: var(--ink); }
  ul.refs { margin: 0; padding-left: 15px; }
  ul.refs li { font-size: 8.9pt; color: var(--ink-2); margin-bottom: 3px; }
  ul.refs li b { color: var(--ink); }
  .note { margin-top: 9px; font-size: 8.2pt; color: var(--ink-3); }
  .foot { margin-top: 22px; padding-top: 11px; border-top: 1px solid var(--line); font-size: 8pt; color: var(--ink-3); display: flex; justify-content: space-between; }
  .foot a { color: var(--ink-3); }
  @page { size: Letter; margin: 0.5in; }
</style>
</head>
<body>
  <div class="toolbar">
    <span>Review, then export — <b style="color:#1a2230">Print → Save as PDF</b> for the cleanest result.</span>
    <button onclick="window.print()">Download PDF</button>
  </div>
  <div class="sheet">
    <header class="letterhead">
      ${S2_LOGO}
      <div class="lh-right">Consolidation<br/>TCO Estimate</div>
    </header>
    <div class="rule"></div>
    <p class="eyebrow">${eyebrow}</p>
    <h1 class="title">${title}</h1>
    <p class="subline">${subline}</p>
    ${body}
    <div class="foot">
      <span>SingleStore · singlestore.com</span>
      <span>${todayLong()}</span>
    </div>
  </div>
</body>
</html>`;
}

// Published reference points — other customers' results, each stated with what
// it measured. Mirrors PROOF / PRICING in lib/singlestore.ts; never a forecast.
const REFERENCES = `
    <section>
      <div class="sec-head"><span class="bar"></span><h2>Reference points, not a forecast</h2></div>
      <p class="body">Published results from other companies&rsquo; stacks. They are vendor-published customer claims
      (not independent audits) and say nothing about this account&rsquo;s numbers, which come only from the inputs above.</p>
      <ul class="refs">
        <li><b>Armis</b> ${X} &mdash; data pipeline cost cut 70% against a &gt;$1M/yr pipeline built on a 160-node Elasticsearch cluster.</li>
        <li><b>Fathom Analytics</b> ${X} &mdash; &minus;60% database TCO after replacing RDS MySQL + Redis + DynamoDB; $3,000/month saved on DynamoDB alone.</li>
        <li><b>DirectlyApply</b> ${X} &mdash; $100,000/yr saved after replacing MongoDB + Elasticsearch.</li>
        <li><b>GigaOm Field Test, Jun 2022</b> <span class="tag tag-m">commissioned by SingleStore</span> &mdash; ~50% lower 3-yr TCO vs MySQL+Snowflake and ~60% vs PostgreSQL+Redshift stacks, incl. people costs. A benchmark, not a customer result.</li>
      </ul>
    </section>`;

const PRICING_NOTE = `SingleStore cost is MODELED from public on-demand list prices (${S2_PRICING.source}): $${S2_PRICING.creditUsd} per credit; S-00 $0.99/h, S-1 $3.96/h, S-4 $15.84/h, S-20 $79.20/h; storage $${S2_PRICING.storagePerGbMonth} per GB-month. Committed-use discounts, BYOC and self-managed pricing are not public and are not included.`;

// Range mode: one COLUMN per spend point, line items as rows. Reads as a band
// the prospect can locate themselves inside of, instead of a single number
// they'll immediately argue with.
function simpleRangeBody(d: RoiPdfSimple, sc: RoiScenario[]): string {
  const cols = sc.map((x) => `<th class="num">${usd(x.spendYr)}/yr</th>`).join("");
  const row = (label: string, sub: string, pick: (x: RoiScenario) => string, cls = "num") => `
          <tr>
            <td>${label}${sub ? `<span class="sub">${sub}</span>` : ""}</td>
            ${sc.map((x) => `<td class="${cls}">${pick(x)}</td>`).join("")}
          </tr>`;
  return `
    <section>
      <div class="sec-head"><span class="bar"></span><h2>The math</h2></div>
      <table class="cs">
        <thead><tr><th>Current spend on systems in scope ${A}</th>${cols}</tr></thead>
        <tbody>
          ${row(
            `Spend retired by consolidation ${A}`,
            `${d.retirePct}% of current spend &mdash; an assumption to validate in the evaluation`,
            (x) => usd(x.retiredYr),
          )}
          ${row(
            `SingleStore Helios ${M}`,
            `${d.size} at $${d.sizeHourly.toFixed(2)}/h always-on + ${d.storageGb.toLocaleString()} GB storage, list price`,
            (x) => `&minus;${usd(x.s2CostYr)}`,
          )}
          ${row(`New annual run-rate ${M}`, "systems that stay + SingleStore", (x) => usd(x.newRunRateYr))}
          <tr class="total">
            <td>Modeled net annual savings ${M}</td>
            ${sc.map((x) => `<td class="num ${x.netSavingsYr >= 0 ? "big" : "neg"}">${usd(x.netSavingsYr)}</td>`).join("")}
          </tr>
        </tbody>
      </table>
      <p class="note">Quoted as a range because the spend on the systems in scope has not been confirmed. Pick the
      column closest to your real bill. Engineering time spent maintaining pipelines is not included here.</p>
    </section>
    ${REFERENCES}
    <p class="note">${PRICING_NOTE}</p>`;
}

function simpleBody(d: RoiPdfSimple): string {
  if (d.scenarios && d.scenarios.length > 0) return simpleRangeBody(d, d.scenarios);
  return `
    <section>
      <div class="sec-head"><span class="bar"></span><h2>The math</h2></div>
      <table class="cs">
        <thead><tr><th></th><th class="num">Annual</th></tr></thead>
        <tbody>
          <tr>
            <td>Current spend on systems in scope ${A}<span class="sub">OLTP, warehouse compute, search, vector, cache, ETL/CDC serving this workload</span></td>
            <td class="num">${usd(d.spendYr)}</td>
          </tr>
          <tr>
            <td>Spend retired by consolidation ${A}<span class="sub">${d.retirePct}% of current spend &mdash; an assumption to validate in the evaluation</span></td>
            <td class="num">${usd(d.retiredYr)}</td>
          </tr>
          <tr>
            <td>SingleStore Helios ${M}<span class="sub">${d.size} at $${d.sizeHourly.toFixed(2)}/h × 730 h × 12 = ${usd(d.s2ComputeYr)} compute + ${d.storageGb.toLocaleString()} GB × $0.023 × 12 = ${usd(d.s2StorageYr)} storage, list price</span></td>
            <td class="num">&minus;${usd(d.s2CostYr)}</td>
          </tr>
          <tr class="total">
            <td>Modeled net annual savings ${M}</td>
            <td class="num ${d.netSavingsYr >= 0 ? "big" : "neg"}">${usd(d.netSavingsYr)}</td>
          </tr>
        </tbody>
      </table>
      <p class="note">New annual run-rate ${usd(d.newRunRateYr)} (systems that stay ${usd(d.spendYr - d.retiredYr)} +
      SingleStore ${usd(d.s2CostYr)}), against ${usd(d.spendYr)} today. Engineering time spent maintaining pipelines is
      not included here.</p>
    </section>
    ${REFERENCES}
    <p class="note">${PRICING_NOTE}</p>`;
}

function advancedBody(d: RoiPdfAdvanced): string {
  const sysRows = d.systems
    .filter((s) => s.spendYr > 0)
    .map(
      (s) => `
          <tr><td>${s.label}</td><td class="num">${usd(s.spendYr)}</td><td class="num">${s.retirePct}%</td><td class="num">${usd(s.retiredYr)}</td></tr>`,
    )
    .join("");
  const mult = [
    d.edition === "Enterprise" ? `Enterprise ×${S2_PRICING.enterpriseMultiplier}` : "Standard",
    d.multiAz ? `Multi-AZ ×${S2_PRICING.multiAzMultiplier}` : "single-AZ",
    `${d.hoursMo} h/mo`,
    d.discountPct > 0 ? `${d.discountPct}% discount (customer assumption)` : "list price",
  ].join(" · ");
  const yearRows = d.threeYear
    .map(
      (y) => `
          <tr><td>Year ${y.year}</td><td class="num">${usd(y.statusQuo)}</td><td class="num">${usd(y.withS2)}</td><td class="num ${y.cumulativeNet >= 0 ? "big" : "neg"}">${usd(y.cumulativeNet)}</td></tr>`,
    )
    .join("");
  return `
    <section>
      <div class="sec-head"><span class="bar"></span><h2>Systems in scope ${A}</h2></div>
      <table class="cs">
        <thead><tr><th>System</th><th class="num">Spend / yr</th><th class="num">Retired</th><th class="num">Retired / yr</th></tr></thead>
        <tbody>
          ${sysRows}
          <tr class="total"><td>Total</td><td class="num">${usd(d.currentSystemsYr)}</td><td></td><td class="num">${usd(d.retiredYr)}</td></tr>
        </tbody>
      </table>
    </section>
    <section>
      <div class="sec-head"><span class="bar"></span><h2>Modeled annual impact</h2></div>
      <table class="cs">
        <thead><tr><th></th><th class="num">Annual</th></tr></thead>
        <tbody>
          <tr>
            <td>Infrastructure spend retired ${M}<span class="sub">from the systems table above</span></td>
            <td class="num">${usd(d.retiredYr)}</td>
          </tr>
          <tr>
            <td>Pipeline engineering time freed ${A}<span class="sub">${d.pipelineFtes} FTEs × ${usd(d.loadedCost)} loaded = ${usd(d.engCostYr)}; ${d.freedPct}% freed</span></td>
            <td class="num">${usd(d.engFreedYr)}</td>
          </tr>
          <tr>
            <td>SingleStore Helios ${M}<span class="sub">${d.size} ($${d.sizeHourly.toFixed(2)}/h list) · ${mult} → ${usd(d.s2ComputeYr)} compute + ${d.storageGb.toLocaleString()} GB storage ${usd(d.s2StorageYr)}</span></td>
            <td class="num">&minus;${usd(d.s2CostYr)}</td>
          </tr>
          <tr class="total">
            <td>Modeled net annual savings ${M}</td>
            <td class="num ${d.netSavingsYr >= 0 ? "big" : "neg"}">${usd(d.netSavingsYr)}</td>
          </tr>
          <tr>
            <td>One-time migration effort ${A}<span class="sub">${d.migrationWeeks} engineer-weeks at the loaded cost above</span></td>
            <td class="num">${usd(d.migrationCost)}</td>
          </tr>
          <tr>
            <td>Payback · return on SingleStore spend ${M}</td>
            <td class="num">${d.paybackMonths !== null ? `${Math.max(1, Math.round(d.paybackMonths))} mo` : "n/a"} · ${d.returnX !== null ? `${d.returnX.toFixed(1)}×` : "n/a"}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <section>
      <div class="sec-head"><span class="bar"></span><h2>3-year view ${M}</h2></div>
      <table class="cs">
        <thead><tr><th></th><th class="num">Status quo</th><th class="num">With SingleStore</th><th class="num">Cumulative net</th></tr></thead>
        <tbody>${yearRows}</tbody>
      </table>
      <p class="note">Flat run-rate each year (no growth or price changes assumed); the one-time migration effort is
      charged to year 1. Status quo = systems in scope + pipeline engineering time.</p>
    </section>
    ${REFERENCES}
    <p class="note">${PRICING_NOTE}</p>`;
}

/** Open the ROI estimate as a print-ready document in a new tab. */
export function openRoiPdf(d: RoiPdfData): boolean {
  const html =
    d.kind === "simple"
      ? frame(
          d.scenarios && d.scenarios.length > 0
            ? `${usd(d.scenarios[0].netSavingsYr)} – ${usd(d.scenarios[d.scenarios.length - 1].netSavingsYr)} modeled net savings / yr`
            : `${usd(d.netSavingsYr)} modeled net savings / yr`,
          "annual consolidation estimate",
          `${
            d.scenarios && d.scenarios.length > 0
              ? `${usd(d.scenarios[0].spendYr)}–${usd(d.scenarios[d.scenarios.length - 1].spendYr)}`
              : usd(d.spendYr)
          } current spend (assumed) · ${d.retirePct}% retired (assumed) · SingleStore ${d.size} at list price · all figures annual`,
          simpleBody(d),
        )
      : frame(
          `${usd(d.netSavingsYr)} modeled net savings / yr`,
          "consolidation & 3-year TCO estimate",
          `${usd(d.currentSystemsYr)} across systems in scope (assumed) · ${d.pipelineFtes} pipeline FTEs · SingleStore ${d.size} · 3-year cumulative ${usd(d.threeYear[d.threeYear.length - 1]?.cumulativeNet ?? 0)}`,
          advancedBody(d),
        );
  const w = window.open("", "_blank");
  if (!w) return false; // popup blocked
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
