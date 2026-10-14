// Build a self-contained, print-optimized HTML document for a SingleStore
// technical evaluation (POC) plan, then open it in a new tab and trigger the
// browser's print dialog (Save as PDF). Going through print gives vector-quality
// type and pixel-perfect layout with zero PDF dependencies — the resulting PDF
// is exactly what a rep sends a prospect. Designed to fit ~3 pages.

export interface PocPlan {
  company: string;
  headline: string;
  /** ONE workload, what is in and out of the evaluation, and an honest fit read. */
  scope: {
    workload: string;
    inScope: string[];
    outOfScope: string[];
    fit: "strong" | "adequate" | "weak" | string;
    fitNote: string;
  };
  /** Each criterion is tied to a metric; target comes from the source or is a
   *  bracketed "[agree at kickoff]" placeholder — never an invented number. */
  successCriteria: { criterion: string; target: string; measuredBy: string }[];
  /** `primary` marks the metric the go/no-go decision hinges on. */
  metrics: { name: string; how: string; why: string; primary?: boolean }[];
  dataPlan: { sources: string[]; ingest: string; connectivity: string; volume: string };
  environment: { deployment: string; size: string; costNote: string; notes: string };
  timeline: { phase: string; activities: string[]; checkpoint: string }[];
  roles: { customer: string[]; singlestore: string[] };
  risks: { risk: string; mitigation: string }[];
  exitCriteria: { go: string[]; noGo: string[] };
  /** A published prior evaluation, stated as another customer's result. */
  reference: { anchor: string; yourVersion: string; framing?: string };
  checklist: string[];
  nextSteps: string[];
}

// Plain typographic wordmark (no trademark artwork) used on every print export.
// Exported so other print exports (lib/roiPdf.ts, lib/proposalDoc.ts) share one copy.
export const S2_LOGO = `<svg viewBox="0 0 150 34" width="150" height="34" xmlns="http://www.w3.org/2000/svg" class="logo" role="img" aria-label="SingleStore"><rect x="0" y="4" width="26" height="26" rx="7" fill="#8a2be2"/><text x="13" y="23.5" text-anchor="middle" font-family="Inter, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="14" font-weight="800" fill="#ffffff">S2</text><text x="34" y="24" font-family="Inter, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-size="17" font-weight="800" letter-spacing="-0.3" fill="#1a2230">SingleStore</text></svg>`;

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const todayLong = () =>
  new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

const fitBadge = (fit: string) => {
  const f = (fit || "").toLowerCase();
  if (f.includes("strong")) return { label: "Strong fit", cls: "fit-strong" };
  if (f.includes("weak") || f.includes("poor")) return { label: "Weak fit", cls: "fit-under" };
  return { label: "Adequate fit", cls: "fit-ok" };
};

function buildPocHtml(p: PocPlan): string {
  const company = esc(p.company || "Your team");
  const fit = fitBadge(p.scope?.fit || "");

  const list = (items: string[] | undefined) =>
    (items || []).map((x) => `<li>${esc(x)}</li>`).join("");

  const criteriaRows = (p.successCriteria || [])
    .slice(0, 4)
    .map(
      (s, i) => `
          <tr>
            <td class="n">${i + 1}</td>
            <td><b>${esc(s.criterion)}</b></td>
            <td class="tgt">${esc(s.target)}</td>
            <td>${esc(s.measuredBy)}</td>
          </tr>`,
    )
    .join("");

  const metricCards = (p.metrics || [])
    .map(
      (m) => `
      <div class="metric ${m.primary ? "metric-unlock" : ""}">
        ${m.primary ? `<span class="unlock-tag">Decision metric</span>` : ""}
        <p class="metric-name">${esc(m.name)}</p>
        <p class="metric-line"><span class="lbl">How</span> ${esc(m.how)}</p>
        <p class="metric-line"><span class="lbl">Why</span> ${esc(m.why)}</p>
      </div>`,
    )
    .join("");

  const timelineCols = (p.timeline || [])
    .map(
      (t) => `
      <div class="week">
        <h4>${esc(t.phase)}</h4>
        <ul class="acts">${(t.activities || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
        <div class="checkpoint">
          <span class="cp-label">Checkpoint</span>${esc(t.checkpoint)}
        </div>
      </div>`,
    )
    .join("");

  const riskRows = (p.risks || [])
    .map(
      (r) => `
          <tr><td><b>${esc(r.risk)}</b></td><td>${esc(r.mitigation)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SingleStore — Technical Evaluation Plan — ${company}</title>
<style>
  :root {
    --brand: #6d1fc4;        /* readable SingleStore purple for text/accents */
    --brand-bright: #8a2be2; /* fills */
    --ink: #1a2230;
    --ink-2: #46556a;
    --ink-3: #7a8699;
    --line: #e6eaf0;
    --tint: #f4eefd;
    --amber: #b45309;
    --red: #b91c1c;
    --green: #15803d;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink);
    background: #f3f4f6;
    -webkit-font-smoothing: antialiased;
    font-size: 10.2pt;
    line-height: 1.42;
  }
  .sheet { max-width: 7.6in; margin: 18px auto; background: #fff; padding: 0.62in 0.66in; box-shadow: 0 6px 30px rgba(15,23,42,0.12); border-radius: 4px; }

  /* Screen-only toolbar */
  .toolbar {
    max-width: 7.6in; margin: 0 auto 4px;
    display: flex; gap: 12px; align-items: center; justify-content: space-between;
    color: #475569; font-size: 12.5px; padding: 2px 4px;
  }
  .toolbar button { font: inherit; font-weight: 700; cursor: pointer; background: var(--brand); color: #fff; border: 0; padding: 9px 18px; border-radius: 8px; }
  .toolbar button:hover { background: #5a17a3; }
  @media print {
    body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; }
  }

  /* Letterhead */
  .letterhead { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 12px; }
  .logo { display: block; height: 30px; width: auto; }
  .lh-right { text-align: right; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); }
  .rule { height: 3px; border-radius: 3px; margin: 0 0 22px; background: linear-gradient(90deg, var(--brand-bright), #c49bff 55%, transparent); }

  /* Title block */
  .eyebrow { font-size: 8.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--brand); margin: 0 0 6px; }
  h1.title { margin: 0; font-size: 21pt; line-height: 1.12; letter-spacing: -0.015em; font-weight: 800; color: var(--ink); }
  .subline { margin: 10px 0 0; font-size: 9.5pt; color: var(--ink-3); }
  .subline b { color: var(--ink-2); font-weight: 600; }

  /* Sections */
  section { margin-top: 19px; break-inside: avoid; }
  .sec-head { display: flex; align-items: baseline; gap: 9px; margin-bottom: 9px; }
  .sec-head .bar { width: 16px; height: 3px; border-radius: 2px; background: var(--brand-bright); transform: translateY(-3px); }
  .sec-head h2 { margin: 0; font-size: 12.5pt; font-weight: 800; letter-spacing: -0.01em; }
  .sec-head .note { font-size: 8.5pt; color: var(--ink-3); font-weight: 500; }

  /* Scope & fit */
  .threshold { border: 1px solid var(--line); border-left: 3px solid var(--brand-bright); border-radius: 11px; padding: 15px 18px; break-inside: avoid; }
  .threshold .workload { margin: 0 0 11px; font-size: 10.5pt; font-weight: 700; color: var(--ink); }
  .threshold .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding-bottom: 11px; margin-bottom: 11px; border-bottom: 1px solid var(--line); }
  .threshold h3 { margin: 0 0 4px; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); }
  .fit-row { display: flex; align-items: center; gap: 9px; }
  .fit-badge { font-size: 7.5pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .fit-strong { background: #dcfce7; color: var(--green); }
  .fit-ok { background: #fef3c7; color: var(--amber); }
  .fit-under { background: #fee2e2; color: var(--red); }
  .fit-note { font-size: 9pt; color: var(--ink-2); margin: 0; }

  /* Tables (success criteria, risks) */
  table.t { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.t thead th { background: var(--brand-bright); color: #fff; font-weight: 700; text-align: left; padding: 6px 9px; font-size: 8.3pt; }
  table.t tbody td { padding: 6px 9px; border-bottom: 1px solid var(--line); color: var(--ink-2); vertical-align: top; }
  table.t tbody td b { color: var(--ink); font-weight: 700; }
  table.t tbody tr:nth-child(odd) td { background: #faf8fe; }
  table.t td.n { width: 22px; font-weight: 800; color: var(--brand); }
  table.t td.tgt { font-weight: 700; color: var(--brand); white-space: normal; }

  /* Metrics grid */
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .metric { position: relative; border: 1px solid var(--line); border-radius: 10px; padding: 12px 13px; break-inside: avoid; }
  .metric-unlock { border-color: var(--brand-bright); background: var(--tint); }
  .unlock-tag { position: absolute; top: -8px; right: 12px; background: var(--brand-bright); color: #fff; font-size: 7pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; padding: 2px 8px; border-radius: 999px; }
  .metric-name { margin: 0 0 6px; font-weight: 700; font-size: 10pt; }
  .metric-line { margin: 0 0 3px; font-size: 8.9pt; color: var(--ink-2); }
  .lbl { display: inline-block; font-size: 7pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--brand); margin-right: 4px; }

  /* Data plan + environment */
  .kv { border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; break-inside: avoid; }
  .kv p { margin: 0 0 5px; font-size: 9pt; color: var(--ink-2); }
  .kv p:last-child { margin-bottom: 0; }

  /* Timeline */
  .weeks { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
  .week { border: 1px solid var(--line); border-radius: 10px; padding: 13px; break-inside: avoid; }
  .week h4 { margin: 0 0 8px; font-size: 10.5pt; color: var(--brand); }
  ul.acts { margin: 0 0 9px; padding-left: 16px; }
  ul.acts li { font-size: 8.9pt; color: var(--ink-2); margin-bottom: 3px; }
  .checkpoint { background: var(--tint); border-radius: 8px; padding: 9px 11px; font-size: 8.9pt; color: var(--ink); font-weight: 600; }
  .cp-label { display: block; font-size: 7pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: var(--brand); margin-bottom: 2px; }

  /* Exit criteria */
  .exit { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
  .exit .box { border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; break-inside: avoid; }
  .exit .go { border-left: 3px solid var(--green); }
  .exit .nogo { border-left: 3px solid var(--red); }
  .exit h3 { margin: 0 0 5px; font-size: 8pt; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; }
  .exit .go h3 { color: var(--green); }
  .exit .nogo h3 { color: var(--red); }

  /* Reference */
  .roi { border: 1px solid var(--line); border-left: 3px solid var(--brand-bright); border-radius: 11px; padding: 14px 16px; background: var(--tint); break-inside: avoid; }
  .roi .anchor { font-size: 10pt; font-weight: 600; line-height: 1.42; color: var(--ink); margin: 0 0 7px; }
  .roi .framing { font-size: 9pt; color: var(--ink-2); margin: 0 0 2px; }
  .roi .your { font-size: 9pt; color: var(--ink-2); margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--line); }

  /* Two-up lists */
  .twoup { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .block h3 { margin: 0 0 6px; font-size: 9.5pt; font-weight: 800; letter-spacing: 0.02em; color: var(--ink); }
  ul.plain { margin: 0; padding-left: 15px; }
  ul.plain li { font-size: 9.2pt; color: var(--ink-2); margin-bottom: 3px; }

  /* Sign-off */
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 42px; }
  .sig .who { font-size: 9pt; font-weight: 700; color: var(--ink); }
  .sig .line { margin-top: 34px; border-top: 1px solid #9aa3b2; padding-top: 5px; font-size: 7.5pt; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }

  .foot { margin-top: 22px; padding-top: 11px; border-top: 1px solid var(--line); font-size: 8pt; color: var(--ink-3); display: flex; justify-content: space-between; }

  @page { size: Letter; margin: 0.5in; }
</style>
</head>
<body>
  <div class="toolbar">
    <span>Review the plan, then export — <b style="color:#1a2230">Print → Save as PDF</b> for the cleanest result.</span>
    <button onclick="window.print()">Download PDF</button>
  </div>

  <div class="sheet">
    <header class="letterhead">
      ${S2_LOGO}
      <div class="lh-right">Technical Evaluation<br/>Proof-of-Concept Plan</div>
    </header>
    <div class="rule"></div>

    <p class="eyebrow">one-workload evaluation · prepared for ${company}</p>
    <h1 class="title">${esc(p.headline || "Technical evaluation plan for one workload")}</h1>
    <p class="subline"><b>Prepared for</b> ${company} &nbsp;·&nbsp; <b>Date</b> ${todayLong()} &nbsp;·&nbsp; <b>Window</b> starts when data is loaded and the baseline is recorded</p>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Scope &amp; workload fit</h2><span class="note">one workload, not a migration</span></div>
      <div class="threshold">
        <p class="workload">${esc(p.scope?.workload)}</p>
        <div class="cols">
          <div><h3>In scope</h3><ul class="plain">${list(p.scope?.inScope)}</ul></div>
          <div><h3>Out of scope</h3><ul class="plain">${list(p.scope?.outOfScope)}</ul></div>
        </div>
        <div class="fit-row">
          <span class="fit-badge ${fit.cls}">${fit.label}</span>
          <p class="fit-note">${esc(p.scope?.fitNote)}</p>
        </div>
      </div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Success criteria</h2><span class="note">each tied to a metric below</span></div>
      <table class="t">
        <thead><tr><th></th><th>Criterion</th><th>Target</th><th>Measured by</th></tr></thead>
        <tbody>${criteriaRows}</tbody>
      </table>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>What we'll measure</h2><span class="note">against the recorded baseline</span></div>
      <div class="grid">${metricCards}</div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Data, ingest &amp; environment</h2></div>
      <div class="twoup">
        <div class="kv">
          <p><span class="lbl">Sources</span> ${esc((p.dataPlan?.sources || []).join(" · "))}</p>
          <p><span class="lbl">Ingest</span> ${esc(p.dataPlan?.ingest)}</p>
          <p><span class="lbl">Connect</span> ${esc(p.dataPlan?.connectivity)}</p>
          <p><span class="lbl">Volume</span> ${esc(p.dataPlan?.volume)}</p>
        </div>
        <div class="kv">
          <p><span class="lbl">Deploy</span> ${esc(p.environment?.deployment)}</p>
          <p><span class="lbl">Size</span> ${esc(p.environment?.size)}</p>
          <p><span class="lbl">Cost</span> ${esc(p.environment?.costNote)}</p>
          <p><span class="lbl">Notes</span> ${esc(p.environment?.notes)}</p>
        </div>
      </div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Timeline &amp; checkpoints</h2></div>
      <div class="weeks">${timelineCols}</div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Risks &amp; mitigations</h2></div>
      <table class="t">
        <thead><tr><th>Risk</th><th>Mitigation</th></tr></thead>
        <tbody>${riskRows}</tbody>
      </table>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Exit criteria</h2><span class="note">agreed before the evaluation starts</span></div>
      <div class="exit">
        <div class="box go"><h3>Go</h3><ul class="plain">${list(p.exitCriteria?.go)}</ul></div>
        <div class="box nogo"><h3>No-go</h3><ul class="plain">${list(p.exitCriteria?.noGo)}</ul></div>
      </div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Reference point</h2><span class="note">another customer's published result, not a forecast</span></div>
      <div class="roi">
        <p class="anchor">${esc(p.reference?.anchor)}</p>
        ${p.reference?.framing ? `<p class="framing">${esc(p.reference.framing)}</p>` : ""}
        <p class="your">${esc(p.reference?.yourVersion)}</p>
      </div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Roles, checklist &amp; next steps</h2></div>
      <div class="twoup">
        <div class="block">
          <h3>Roles &amp; ownership</h3>
          <ul class="plain">${list(p.roles?.customer)}${list(p.roles?.singlestore)}</ul>
        </div>
        <div class="block">
          <h3>Pre-evaluation checklist</h3>
          <ul class="plain">${list(p.checklist)}</ul>
        </div>
      </div>
      <div class="block" style="margin-top:14px">
        <h3>Next steps</h3>
        <ul class="plain">${list(p.nextSteps)}</ul>
      </div>
    </section>

    <section>
      <div class="sec-head"><span class="bar"></span><h2>Sign-off</h2><span class="note">to start the evaluation window</span></div>
      <div class="sign">
        <div class="sig"><div class="who">For ${company}</div><div class="line">Name, title &amp; date</div></div>
        <div class="sig"><div class="who">For SingleStore</div><div class="line">Name, title &amp; date</div></div>
      </div>
    </section>

    <div class="foot">
      <span>SingleStore · Technical Evaluation Plan</span>
      <span>${company} · ${todayLong()}</span>
    </div>
  </div>
</body>
</html>`;
}

/** Open the POC plan as a print-ready document in a new tab. */
export function openPocPdf(plan: PocPlan): boolean {
  const html = buildPocHtml(plan);
  const w = window.open("", "_blank");
  if (!w) return false; // popup blocked
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
